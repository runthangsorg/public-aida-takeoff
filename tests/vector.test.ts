import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { countDrawing } from '../src/engine.ts';
import { extractText } from '../src/pdf/text.ts';
import { findLegend, findLegends, groupLines, isTagLike } from '../src/vector/legend.ts';
import { countTags, parseTagSpan } from '../src/vector/tags.ts';
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
  it('never reads an amperage or other unit as a multiplied single-letter tag', () => {
    const letters = new Set(['A', 'W', 'B', 'SD']);
    expect(parseTagSpan('13A', letters)).toBeNull();
    expect(parseTagSpan('20W', letters)).toBeNull();
    expect(parseTagSpan('2B', letters)).toBeNull();
    expect(parseTagSpan('2 NO. B', letters)).toEqual({ tag: 'B', multiplier: 2 });
    expect(parseTagSpan('2SD', letters)).toEqual({ tag: 'SD', multiplier: 2 });
    expect(parseTagSpan('B x3', letters)).toEqual({ tag: 'B', multiplier: 3 });
  });
  it('recognises tag-like strings', () => {
    for (const s of ['A1', 'SD', 'SSO', 'L12', 'FCU-3', 'AHU01', 'X']) expect(isTagLike(s), s).toBe(true);
    for (const s of ['OFFICE 3.01', '1:100', 'LEGEND', 'ADDRESSABLE', '2200 x 2788']) expect(isTagLike(s), s).toBe(false);
  });
});

describe('tag counting', () => {
  it('counts letters drawn inside one symbol once and neighbouring symbols separately', () => {
    const mk = (str: string, x: number, y: number, size: number) => ({ str, box: { x, y, w: size * 0.6, h: size }, fontSize: size });
    const page = { page: 1, width: 500, height: 500, spans: [mk('F', 100, 100, 1.6), mk('F', 101, 102, 1.6), mk('F', 98, 103, 1.6), mk('F', 120, 100, 1.6), mk('B', 200, 200, 7), mk('B', 212, 200, 7)] };
    const dets = countTags(page, new Set(['F', 'B']), []);
    expect(dets.filter((d) => d.itemId === 'F')).toHaveLength(2);
    expect(dets.filter((d) => d.itemId === 'B')).toHaveLength(2);
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

describe('table legend', () => {
  const span = (str: string, x: number, y: number, size = 9): { str: string; box: { x: number; y: number; w: number; h: number }; fontSize: number } => ({
    str,
    box: { x, y: y - size / 2, w: str.length * size * 0.55, h: size },
    fontSize: size,
  });
  // Modelled on a tender legend sheet: SYMBOL | DESCRIPTION | MANUFACTURER'S CAT No. | MOUNTING HEIGHT.
  const page = {
    page: 1,
    width: 1684,
    height: 1191,
    spans: [
      span('LEGEND', 629, 132, 24),
      span('MANUFACTURERS CAT', 908, 132, 10),
      span('No.', 908, 142, 10),
      span('MOUNTING', 1057, 132),
      span('HEIGHT', 1057, 142),
      span('600mm, 4x18w FLUORESCENT FITTING WITH CAT2 MIRROR LOUVERS', 471, 169),
      span('THORN FTB418', 915, 169),
      span('CEILING', 1062, 169),
      span('A', 423, 192),
      span('HORIZONTAL LOW ENERGY DOWNLIGHT', 471, 192),
      span('FITZGERALD UFO', 916, 192),
      span('CEILING', 1059, 192),
      span('D', 422, 271, 11),
      span('SURFACE MOUNTED WALL BRACKET WITH ENERGY SAVING LAMP', 466, 271),
      span('THORN WSTR118W', 911, 271),
      span('2100mm', 1061, 271),
      span('MELLOW LIGHT CEILING LUMINAIRE FOR 18W TC-TEL COMPACT FLUORESCENT WITH SOFT', 465, 291),
      span('E', 423, 297),
      span('TABULAR SHAPE AND BRUSHED STAINLESS STEEL FIXINGS', 465, 304),
      span('THORN GARBO', 916, 291),
      span('CEILING', 1059, 291),
      span('F', 425, 319, 5),
      span('F', 420, 325, 5),
      span('F', 430, 325, 5),
      span('ELEGANT CHANDELIER LUMINAIRE FOR 36W LAMPS WITH 3 SHADES', 463, 325),
      span('THORN J121685', 914, 319),
      span('5A 1 GANG 1 WAY MOULDED PLATE SWITCH FOR FLUSH MOUNTING', 471, 349),
      span('CRABTREE 4070', 918, 349),
      span('1400mm', 1055, 349),
      span('LEGEND', 434, 1064, 70),
      span('NOTES', 1240, 160, 8),
      span('1. Do not scale from this drawing.', 1240, 175, 7),
    ],
  };

  it('reads rows with wrapped descriptions, symbol-column tags and catalogue references', () => {
    const legends = findLegends(page);
    expect(legends).toHaveLength(1);
    const items = legends[0]!.items;
    expect(items.map((i) => i.tag)).toEqual([null, 'A', 'D', 'E', 'F', null]);
    expect(items[3]?.description).toBe('MELLOW LIGHT CEILING LUMINAIRE FOR 18W TC-TEL COMPACT FLUORESCENT WITH SOFT TABULAR SHAPE AND BRUSHED STAINLESS STEEL FIXINGS');
    expect(items[2]?.reference).toBe('THORN WSTR118W');
    expect(items[5]?.description).toMatch(/^5A 1 GANG 1 WAY/);
    expect(items[5]?.reference).toBe('CRABTREE 4070');
    // The box covers the symbol column and stops before the notes.
    const box = legends[0]!.box;
    expect(box.x).toBeLessThan(420);
    expect(box.x + box.w).toBeLessThan(1240);
    expect(box.y + box.h).toBeGreaterThan(349);
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

  it('counts the tagged luminaires of set-03 exactly and, with symbols off, defers fire devices to vision', async () => {
    const result = await countDrawing(set03, { symbols: false });
    const t = truth('set-03');
    for (const tag of ['A1', 'A2', 'B1', 'EM', 'EX']) {
      expect(result.items.find((i) => i.itemId === tag)?.count, tag).toBe(t.items[tag]);
    }
    for (const tag of ['SD', 'HD', 'SP', 'SSO', 'SW']) {
      expect(result.items.find((i) => i.itemId === tag)?.source, tag).toBe('none');
    }
    expect(result.warnings[0]).toMatch(/vision disabled: 5 item/);
  });

  it('with symbols off, reports every item of the untagged set-02 as needing vision', async () => {
    const result = await countDrawing(set02, { symbols: false });
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
