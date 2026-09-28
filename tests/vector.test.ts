import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { countDrawing } from '../src/engine.ts';
import { extractText } from '../src/pdf/text.ts';
import { findLegend, groupLines, isTagLike } from '../src/vector/legend.ts';
import { parseTagSpan } from '../src/vector/tags.ts';
import { findNotesBox, readTitleBlock } from '../src/vector/titleblock.ts';
import type { GroundTruth } from '../scripts/make-fixtures.ts';

const bench = new URL('./fixtures/bench/', import.meta.url).pathname;
const set01 = `${bench}set-01/drawings/E-301-lighting-fire-layout.pdf`;
const set02 = `${bench}set-02/drawings/M-201-small-power-sprinkler-layout.pdf`;
const set03 = `${bench}set-03/drawings/E-401-combined-services-layout.pdf`;

function truth(set: string): GroundTruth {
  return JSON.parse(readFileSync(`${bench}${set}/ground_truth.json`, 'utf8')) as GroundTruth;
}

describe('tag parsing', () => {
  const tags = new Set(['A1', 'SD', 'SSO']);
  it('accepts exact tags and multiplier forms', () => {
    expect(parseTagSpan('A1', tags)).toEqual({ tag: 'A1', multiplier: 1 });
    expect(parseTagSpan(' sd ', tags)).toEqual({ tag: 'SD', multiplier: 1 });
    expect(parseTagSpan('4 NO. A1', tags)).toEqual({ tag: 'A1', multiplier: 4 });
    expect(parseTagSpan('3 x SSO', tags)).toEqual({ tag: 'SSO', multiplier: 3 });
    expect(parseTagSpan('A1 x2', tags)).toEqual({ tag: 'A1', multiplier: 2 });
  });
  it('rejects sentences and unknown tags', () => {
    expect(parseTagSpan('ALL TYPE A1 LUMINAIRES', tags)).toBeNull();
    expect(parseTagSpan('A2', tags)).toBeNull();
    expect(parseTagSpan('SEE A1', tags)).toBeNull();
  });
  it('recognises tag-like strings', () => {
    for (const s of ['A1', 'SD', 'SSO', 'L12', 'FCU-3', 'AHU01', 'X']) expect(isTagLike(s), s).toBe(true);
    for (const s of ['OFFICE 3.01', '1:100', 'LEGEND', 'ADDRESSABLE', '2200 x 2788']) expect(isTagLike(s), s).toBe(false);
  });
});

describe('vector text extraction', () => {
  it('reads both A1 pages of set-01 in viewport points', async () => {
    const pages = await extractText(set01);
    expect(pages).toHaveLength(2);
    const p1 = pages[0];
    expect(p1?.width).toBe(2384);
    expect(p1?.height).toBe(1684);
    const legend = p1?.spans.find((s) => s.str === 'LEGEND');
    expect(legend).toBeDefined();
    // Legend is at the top-right: y is measured from the top edge.
    expect(legend?.box.y).toBeLessThan(200);
    expect(legend?.box.x).toBeGreaterThan(1800);
  });

  it('groups spans into lines by vertical position', () => {
    const mk = (str: string, x: number, y: number) => ({ str, box: { x, y, w: 10, h: 8 }, fontSize: 8 });
    const lines = groupLines([mk('b', 20, 100), mk('a', 10, 101), mk('c', 10, 130)]);
    expect(lines.map((l) => l.spans.map((s) => s.str))).toEqual([['a', 'b'], ['c']]);
  });
});

describe('legend', () => {
  it('reads every row with tag and description from set-01', async () => {
    const [p1] = await extractText(set01);
    const legend = findLegend(p1!);
    expect(legend).not.toBeNull();
    const t = truth('set-01');
    expect(legend?.items.map((i) => i.tag)).toEqual(Object.keys(t.items));
    for (const item of legend?.items ?? []) {
      expect(item.description).toBe(t.descriptions[item.tag ?? '']?.toUpperCase());
    }
    // The legend box must cover its heading and rows and reach left to the symbol column.
    const heading = p1!.spans.find((s) => s.str === 'LEGEND')!;
    expect(legend!.box.x).toBeLessThan(heading.box.x - 30);
    expect(legend!.box.y).toBeLessThanOrEqual(heading.box.y);
  });

  it('reads the untagged A3 legend of set-02 without clipping descriptions', async () => {
    const [p1] = await extractText(set02);
    const legend = findLegend(p1!);
    expect(legend?.items.map((i) => i.tag)).toEqual(['SD', 'SP', 'SSO', 'SW']);
    expect(legend?.items[0]?.description).toBe('OPTICAL SMOKE DETECTOR, CEILING MOUNTED, ADDRESSABLE');
  });

  it('finds no legend on the second sheet of set-03', async () => {
    const pages = await extractText(set03);
    expect(findLegend(pages[1]!)).toBeNull();
  });
});

describe('title block and notes', () => {
  it('reads drawing number, title and scale', async () => {
    const pages = await extractText(set01);
    const tb = readTitleBlock(pages[0]!);
    expect(tb.drawingNumber).toBe('E-301');
    expect(tb.title).toBe('LEVEL 3 LIGHTING AND FIRE ALARM LAYOUT');
    expect(tb.scale).toBe(100);
    expect(tb.box).not.toBeNull();
    expect(tb.box!.y).toBeGreaterThan(1400);
    expect(readTitleBlock(pages[1]!).drawingNumber).toBe('E-302');
    const notes = findNotesBox(pages[0]!);
    expect(notes).not.toBeNull();
    expect(notes!.x).toBeLessThan(100);
  });
  it('reads 1:200 from the A3 sheet', async () => {
    const [p1] = await extractText(set02);
    expect(readTitleBlock(p1!).scale).toBe(200);
  });
});

describe('vector-only count', () => {
  it('counts every tagged item of set-01 exactly', async () => {
    const result = await countDrawing(set01);
    const t = truth('set-01');
    const counts = Object.fromEntries(result.items.map((i) => [i.itemId, i.count]));
    expect(counts).toEqual(t.items);
    expect(result.items.every((i) => i.source === 'vector')).toBe(true);
    expect(result.warnings).toEqual([]);
    // Per-page counts agree with the generator's per-sheet counts.
    const a1 = result.items.find((i) => i.itemId === 'A1');
    expect(a1?.perPage).toEqual({ '1': t.perSheet['E-301']?.A1, '2': t.perSheet['E-302']?.A1 });
    // Every detection has coordinates inside its page.
    for (const p of result.pages) for (const d of p.detections) expect(d.box.x).toBeLessThan(p.width);
  });

  it('counts the tagged luminaires of set-03 exactly and defers fire devices to vision', async () => {
    const result = await countDrawing(set03);
    const t = truth('set-03');
    for (const tag of ['A1', 'A2', 'B1', 'EM', 'EX']) {
      expect(result.items.find((i) => i.itemId === tag)?.count, tag).toBe(t.items[tag]);
    }
    for (const tag of ['SD', 'HD', 'SP', 'SSO', 'SW']) {
      expect(result.items.find((i) => i.itemId === tag)?.source, tag).toBe('none');
    }
    expect(result.warnings[0]).toMatch(/vision disabled: 5 item/);
  });

  it('reports every item of the untagged set-02 as needing vision', async () => {
    const result = await countDrawing(set02);
    expect(result.items.map((i) => i.count)).toEqual([0, 0, 0, 0]);
    expect(result.warnings).toHaveLength(1);
  });

  it('accepts a legend file', async () => {
    const legendFile = `${process.env.TMPDIR ?? '/tmp'}/aida-legend-${process.pid}.json`;
    const { writeFileSync, rmSync } = await import('node:fs');
    writeFileSync(legendFile, JSON.stringify({ items: [{ tag: 'a1', description: 'downlight' }] }));
    try {
      const result = await countDrawing(set01, { legend: { file: legendFile } });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.count).toBe(truth('set-01').items.A1);
    } finally {
      rmSync(legendFile, { force: true });
    }
  });
});
