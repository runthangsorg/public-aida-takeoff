/**
 * Vector symbol matching: signatures from legend glyphs, invariance to
 * translation, uniform scale, quarter turns and mirroring, conflict
 * resolution between nested glyphs, and exact counts on the fixtures.
 */
import { describe, expect, it } from 'vitest';
import { countDrawing, structuralBoxes } from '../src/engine.ts';
import { extractText } from '../src/pdf/text.ts';
import { findLegends } from '../src/vector/legend.ts';
import { decodeDrawOps, extractPaths, type PathObject } from '../src/vector/paths.ts';
import { attachSignatures, buildSignature, candidateMatches, elementOf, glyphPaths, matchSignature, matchSymbols, mergeHatchBands, SpatialIndex } from '../src/vector/symbols.ts';

const bench = new URL('./fixtures/bench/', import.meta.url).pathname;
const set02 = `${bench}set-02/drawings/M-201-small-power-sprinkler-layout.pdf`;
const set03 = `${bench}set-03/drawings/E-401-combined-services-layout.pdf`;

// ---------------------------------------------------------------------------
// Synthetic path objects

let nextIndex = 0;
function poly(points: [number, number][], opts: { closed?: boolean; fill?: boolean; curves?: number } = {}): PathObject {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    page: 1,
    subpaths: [{ points: points.map(([x, y]) => ({ x, y })), closed: opts.closed ?? false, curves: opts.curves ?? 0 }],
    box: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) },
    fill: opts.fill ?? false,
    stroke: !(opts.fill ?? false),
    lineWidth: 0.5,
    index: nextIndex++,
  };
}

function circle(cx: number, cy: number, r: number, fill = false): PathObject {
  const pts: [number, number][] = [];
  for (let i = 0; i < 24; i++) pts.push([cx + r * Math.cos((i / 24) * 2 * Math.PI), cy + r * Math.sin((i / 24) * 2 * Math.PI)]);
  return poly(pts, { closed: true, fill, curves: 4 });
}

/** A detector-like glyph: circle, inner dot, a tail to the right and a shorter tail upwards (so mirroring changes it), at (cx, cy) with size s. */
function detector(cx: number, cy: number, s: number, transform: (x: number, y: number) => [number, number] = (x, y) => [x, y]): PathObject[] {
  const t = (p: PathObject): PathObject => {
    const subpaths = p.subpaths.map((sp) => ({ ...sp, points: sp.points.map((q) => { const [x, y] = transform(q.x, q.y); return { x, y }; }) }));
    const xs = subpaths.flatMap((sp) => sp.points.map((q) => q.x));
    const ys = subpaths.flatMap((sp) => sp.points.map((q) => q.y));
    return { ...p, subpaths, box: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } };
  };
  return [circle(cx, cy, s / 2), circle(cx, cy, s / 6, true), poly([[cx + s / 2, cy], [cx + s, cy]]), poly([[cx, cy - s / 2], [cx, cy - s * 0.62]])].map(t);
}

describe('signatures', () => {
  it('builds a translation- and scale-invariant signature with the largest element as anchor', () => {
    const a = buildSignature(detector(100, 100, 10));
    const b = buildSignature(detector(500, 300, 25));
    expect(a).not.toBeNull();
    expect(a?.anchor).toBe(0);
    expect(a?.elements).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(a?.elements[i]?.dx).toBeCloseTo(b?.elements[i]?.dx ?? 9, 3);
      expect(a?.elements[i]?.dy).toBeCloseTo(b?.elements[i]?.dy ?? 9, 3);
      expect(a?.elements[i]?.size).toBeCloseTo(b?.elements[i]?.size ?? 9, 3);
    }
    // The tail reaches one radius beyond the circle, so the cluster is 1.5 symbol sizes wide.
    expect(a?.extent).toBeCloseTo(15, 6);
    expect(b?.extent).toBeCloseTo(37.5, 6);
  });

  it('keeps table rules out of a glyph cell', () => {
    const cell = { x: 0, y: 0, w: 60, h: 20 };
    const rule = poly([[0, 20], [60, 20]]);
    const border = poly([[0, 0], [0, 20]]);
    const glyph = circle(30, 10, 4);
    expect(glyphPaths([rule, border, glyph, circle(200, 200, 4)], cell)).toEqual([glyph]);
  });

  it('merges a run of hatch bands into one filled element', () => {
    const bands = [1, 2, 3, 4, 5].map((k) => poly([[10, 10 + k * 0.8], [10 + k * 2, 10 + k * 0.8], [10 + k * 2, 10.6 + k * 0.8], [10, 10.6 + k * 0.8]], { closed: true, fill: true }));
    const other = circle(50, 50, 4);
    // Consecutive indices make them a run.
    bands.forEach((b, i) => (b.index = 100 + i));
    const merged = mergeHatchBands([other, ...bands, other]);
    expect(merged).toHaveLength(3);
    const blob = merged[1]!;
    expect(blob.fill).toBe(true);
    expect(blob.box.w).toBeCloseTo(10, 6);
    expect(elementOf(blob).kind).toBe('closed');
  });

  it('decodes DrawOPS with the matrix applied', () => {
    const sub = decodeDrawOps([0, 1, 1, 1, 3, 1, 4], [2, 0, 0, 2, 10, 10]);
    expect(sub).toHaveLength(1);
    expect(sub[0]?.closed).toBe(true);
    expect(sub[0]?.points).toEqual([{ x: 12, y: 12 }, { x: 16, y: 12 }]);
  });
});

describe('matching', () => {
  const sig = buildSignature(detector(0, 0, 10))!;

  function planWith(instances: PathObject[][]): SpatialIndex {
    const elements = instances.flat().map(elementOf);
    return new SpatialIndex(elements);
  }

  it('finds instances under translation, scale, quarter turns and mirroring', () => {
    const rot = (q: number) => (x: number, y: number): [number, number] => {
      let [px, py] = [x, y];
      for (let k = 0; k < q; k++) [px, py] = [-py, px];
      return [px, py];
    };
    const mirror = (x: number, y: number): [number, number] => [x, -y];
    const index = planWith([
      detector(100, 100, 10),
      detector(300, 100, 18),
      detector(500, 100, 10, rot(1)),
      detector(700, 100, 10, rot(2)),
      detector(900, 100, 10, rot(3)),
      detector(1100, 100, 10, mirror),
    ]);
    const { matches } = matchSignature(sig, index, new Set());
    expect(matches).toHaveLength(6);
    expect(matches.every((m) => m.score >= 0.95)).toBe(true);
    expect(new Set(matches.map((m) => m.rotation)).size).toBeGreaterThanOrEqual(3);
    expect(matches.some((m) => m.mirrored)).toBe(true);
  });

  it('rejects a bare circle and a circle with a different inner mark', () => {
    const index = planWith([[circle(100, 100, 5)], [circle(300, 100, 5), poly([[298, 98], [302, 98], [302, 102], [298, 102]], { closed: true, fill: true })]]);
    const { matches, anchorCandidates } = matchSignature(sig, index, new Set());
    expect(anchorCandidates).toBe(2);
    expect(matches).toHaveLength(0);
  });

  it('gives a composite glyph precedence over its parts', () => {
    // Legend: item ONE = a circle; item TWO = two circles side by side. Plan: three TWO instances.
    const one = [circle(0, 0, 4)];
    const two = [circle(0, 0, 4), circle(12, 0, 4)];
    const plan = [0, 1, 2].flatMap((k) => [circle(100 + k * 60, 100, 4), circle(112 + k * 60, 100, 4)]);
    const items = [
      { id: 'ONE', tag: 'ONE', description: 'one', box: { x: 0, y: 0, w: 0, h: 0 }, page: 1, signature: buildSignature(one)! },
      { id: 'TWO', tag: 'TWO', description: 'two', box: { x: 0, y: 0, w: 0, h: 0 }, page: 1, signature: buildSignature(two)! },
    ];
    const { detections } = matchSymbols({ items, planPages: [{ page: 1, width: 400, height: 200, paths: plan }], pageTexts: [{ page: 1, width: 400, height: 200, spans: [] }], exclude: new Map() });
    expect(detections.filter((d) => d.itemId === 'TWO')).toHaveLength(3);
    expect(detections.filter((d) => d.itemId === 'ONE')).toHaveLength(0);
  });

  it('rejects a match whose inside text names another legend item', () => {
    const items = [{ id: 'PC', tag: 'PC', description: 'photocell', box: { x: 0, y: 0, w: 0, h: 0 }, page: 1, signature: buildSignature([circle(0, 0, 5)])! }, { id: 'A', tag: 'A', description: 'downlight', box: { x: 0, y: 0, w: 0, h: 0 }, page: 1 }];
    const plan = [circle(100, 100, 5), circle(200, 100, 5)];
    const spans = [{ str: 'A', box: { x: 198, y: 97, w: 4, h: 6 }, fontSize: 6 }];
    const { detections } = matchSymbols({ items, planPages: [{ page: 1, width: 400, height: 200, paths: plan }], pageTexts: [{ page: 1, width: 400, height: 200, spans }], exclude: new Map() });
    expect(detections.map((d) => Math.round(d.box.x + d.box.w / 2))).toEqual([100]);
  });

  it('reports candidates without consuming anything', () => {
    const index = planWith([detector(100, 100, 10)]);
    const { candidates } = candidateMatches(sig, index);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.pathIndices).toHaveLength(4);
  });
});

describe('fixtures without a model', () => {
  it('attaches a signature to every legend row of set-02 and counts all four items exactly', async () => {
    const [pt] = await extractText(set02);
    const [pp] = await extractPaths(set02);
    const legend = findLegends(pt!, structuralBoxes(pt!))[0]!;
    expect(attachSignatures(legend.items, pp!.paths)).toBe(4);
    expect(legend.items.map((i) => i.signature?.elements.length)).toEqual([2, 5, 2, 3]);
    const result = await countDrawing(set02);
    expect(Object.fromEntries(result.items.map((i) => [i.itemId, i.count]))).toEqual({ SD: 63, SP: 59, SSO: 67, SW: 24 });
    expect(result.items.every((i) => i.source === 'symbol' && i.needsReview === 0)).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.symbols?.every((s) => s.meanScore === 1)).toBe(true);
    expect(result.legend?.items.every((i) => i.signature === undefined)).toBe(true);
  });

  it('counts the untagged fire and power items of set-03 by symbol and the luminaires by tag', async () => {
    const result = await countDrawing(set03);
    const counts = Object.fromEntries(result.items.map((i) => [i.itemId, [i.count, i.source]]));
    expect(counts).toEqual({
      A1: [152, 'vector'],
      A2: [123, 'vector'],
      B1: [74, 'vector'],
      EM: [58, 'vector'],
      EX: [29, 'vector'],
      SD: [92, 'symbol'],
      HD: [31, 'symbol'],
      SP: [105, 'symbol'],
      SSO: [78, 'symbol'],
      SW: [47, 'symbol'],
    });
    expect(result.warnings).toEqual([]);
  });

  it('can be switched off, leaving the vision fallback to report the untagged items', async () => {
    const result = await countDrawing(set02, { symbols: false });
    expect(result.items.map((i) => i.count)).toEqual([0, 0, 0, 0]);
    expect(result.warnings[0]).toMatch(/vision disabled: 4 item/);
  });
});
