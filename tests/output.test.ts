import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countDrawing } from '../src/engine.ts';
import { sectionFor, writeBill } from '../src/output/excel.ts';
import { viewportToPdfBoxes, writeOverlay } from '../src/output/overlay.ts';
import { extractText } from '../src/pdf/text.ts';
import type { TakeoffResult } from '../src/types.ts';

const bench = new URL('./fixtures/bench/', import.meta.url).pathname;
const set01 = `${bench}set-01/drawings/E-301-lighting-fire-layout.pdf`;

let tmp = '';
let result: TakeoffResult;
beforeAll(async () => {
  tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'aida-output-'));
  result = await countDrawing(set01);
});
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('bill sections', () => {
  it('routes descriptions to trade sections', () => {
    expect(sectionFor('LED downlight, 150 mm, recessed').code).toBe('A');
    expect(sectionFor('13 A twin switched socket outlet').code).toBe('B');
    expect(sectionFor('Optical smoke detector').code).toBe('C');
    expect(sectionFor('Sprinkler head, pendent').code).toBe('D');
    expect(sectionFor('600 x 600 supply diffuser').code).toBe('E');
    expect(sectionFor('Wall hung WC pan').code).toBe('F');
    expect(sectionFor('Roof mounted condensing unit').code).toBe('G');
  });
});

describe('Excel bill', () => {
  it('writes sections, one row per item with quantity and amount formulas, and audit sheets', async () => {
    const path = join(tmp, 'bill.xlsx');
    await writeBill([result], path, { projectName: 'Synthetic office', packageName: 'Electrical services', currency: 'AED' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const bill = wb.getWorksheet('Bill of Quantities');
    expect(bill).toBeDefined();
    const rows: unknown[][] = [];
    bill?.eachRow((row) => {
      rows.push(row.values as unknown[]);
    });
    const cell = (v: unknown): string => {
      if (typeof v === 'object' && v !== null && 'formula' in v) return `=${String(v.formula)}`;
      if (typeof v === 'string' || typeof v === 'number') return String(v);
      return '';
    };
    const text = rows.map((r) => r.map(cell).join('|'));
    expect(text[0]).toContain('Synthetic office');
    expect(text.some((l) => l.includes('A|Lighting'))).toBe(true);
    expect(text.some((l) => l.includes('C|Fire detection'))).toBe(true);
    expect(text.some((l) => l.includes('D|Fire suppression'))).toBe(true);
    const a1 = text.find((l) => l.includes('(type A1)'));
    expect(a1).toBeDefined();
    expect(a1).toContain('|nr|223|');
    expect(a1).toMatch(/=IF\(ISNUMBER\(E\d+\),D\d+\*E\d+,""\)/);
    expect(text.some((l) => l.includes('Total carried to summary'))).toBe(true);
    const counts = wb.getWorksheet('Counts by drawing');
    expect(counts?.getRow(1).getCell(3).value).toBe('E-301-lighting-fire-layout.pdf#1');
    const det = wb.getWorksheet('Detections');
    expect(det?.rowCount).toBe(1 + result.pages.reduce((a, p) => a + p.detections.length, 0));
  });
});

describe('overlay PDF', () => {
  it('maps viewport boxes to PDF space on an unrotated page', async () => {
    const [p1] = await extractText(set01);
    const legend = p1?.spans.find((s) => s.str === 'LEGEND');
    const out = await viewportToPdfBoxes(set01, new Map([[1, [legend!.box]]]));
    const b = out.get(1)?.[0];
    expect(b?.x).toBeCloseTo(legend!.box.x, 3);
    expect(b?.y).toBeCloseTo(1684 - legend!.box.y - legend!.box.h, 3);
  });

  it('writes a copy of the drawing with the same page count and extra content', async () => {
    const path = join(tmp, 'marked.pdf');
    await writeOverlay(result, set01, path);
    const doc = await PDFDocument.load(await import('node:fs/promises').then((m) => m.readFile(path)));
    expect(doc.getPageCount()).toBe(2);
    const original = await PDFDocument.load(await import('node:fs/promises').then((m) => m.readFile(set01)));
    const sizeOf = async (d: PDFDocument) => (await d.save()).byteLength;
    expect(await sizeOf(doc)).toBeGreaterThan(await sizeOf(original));
  });
});
