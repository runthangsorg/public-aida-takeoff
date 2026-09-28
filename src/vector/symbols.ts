/**
 * Deterministic symbol matching on vector geometry.
 *
 * A legend glyph is a small cluster of painted paths. Its signature records
 * every element's shape (a coarse, rotation-tolerant descriptor), size and
 * position relative to the cluster, all normalised by the cluster's extent,
 * so the signature is invariant to translation and uniform scale. Matching
 * on a plan sheet starts from the signature's anchor (its largest element):
 * every plan path with a similar shape and a plausible size is tried as the
 * anchor under the four 90-degree rotations and their mirrors, and the rest
 * of the cluster must be found at the transformed positions. The fraction
 * of the cluster found (weighted by element size) is the match confidence.
 *
 * Bigger signatures claim their paths first, so a two-gang switch drawn as
 * two one-gang glyphs is not also counted as two one-gang switches. Text
 * inside a match that spells another legend tag rejects the match: the
 * letter says what the symbol is.
 */
import { boxFromCorners, unionAll } from '../geometry.ts';
import { normalizeText } from '../pdf/text.ts';
import type { Box, Detection, LegendItem, PageText, SymbolSignature } from '../types.ts';
import { isTagLike } from './legend.ts';
import type { PagePaths, PathObject } from './paths.ts';

export type ElementKind = 'dot' | 'line' | 'open' | 'closed' | 'curve';

export interface Element {
  kind: ElementKind;
  /** Centre in page points. */
  cx: number;
  cy: number;
  /** max(w, h) in page points. */
  extent: number;
  /** w / h ratio, clamped, made symmetric under 90-degree rotation by min/max. */
  aspect: number;
  fill: boolean;
  stroke: boolean;
  /** 8-bin histogram of point angles around the centre (rotation shifts it by 2 bins). */
  angular: number[];
  /** 6-bin histogram of point distances from the centre (rotation invariant). */
  radial: number[];
  /** Fraction of points at the median distance from the centre: 1 for a circle, about half for a square. */
  round: number;
  /** Index of the source path on its page. */
  index: number;
  box: Box;
}

export interface SignatureElement {
  kind: ElementKind;
  /** Offset of the element centre from the cluster centre, over the cluster extent. */
  dx: number;
  dy: number;
  /** Element extent over the cluster extent. */
  size: number;
  aspect: number;
  fill: boolean;
  stroke: boolean;
  angular: number[];
  radial: number[];
  round: number;
  /** Weight in the score: bigger elements matter more, dots still count. */
  weight: number;
}

export type Signature = SymbolSignature;

export interface SymbolMatch {
  box: Box;
  score: number;
  /** 0-3 quarter turns, plus mirror flag. */
  rotation: number;
  mirrored: boolean;
  scale: number;
  pathIndices: number[];
}

export interface MatchOptions {
  minScore: number;
  /** At least this fraction of the cluster's elements must be found (two-element glyphs need both). */
  minElementFraction: number;
  /** Plan symbol size over legend symbol size. */
  scaleRange: [number, number];
  allowMirror: boolean;
  /** Elements this far apart (as a fraction of the symbol extent) are the same element. */
  positionTolerance: number;
}

/** Legends are often drawn larger than the plan symbols, so the plan may be a fifth of the legend size. */
export const defaultMatchOptions: MatchOptions = { minScore: 0.7, minElementFraction: 0.6, scaleRange: [0.2, 2.5], allowMirror: true, positionTolerance: 0.14 };

// ---------------------------------------------------------------------------
// Elements

function histograms(points: readonly { x: number; y: number }[], cx: number, cy: number, extent: number): { angular: number[]; radial: number[]; round: number } {
  const angular = new Array<number>(8).fill(0);
  const radial = new Array<number>(6).fill(0);
  if (points.length === 0 || extent === 0) return { angular, radial, round: 1 };
  const rs: number[] = [];
  // Soft binning: each point splits between its two nearest bins, so a diagonal
  // sitting exactly on a bin edge does not flip bins on floating-point noise.
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const r = Math.hypot(dx, dy) / (extent / 2);
    rs.push(r);
    const a = ((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 8 - 0.5;
    const a0 = Math.floor(a);
    const af = a - a0;
    angular[((a0 % 8) + 8) % 8] = (angular[((a0 % 8) + 8) % 8] ?? 0) + (1 - af);
    angular[((a0 + 1) % 8 + 8) % 8] = (angular[((a0 + 1) % 8 + 8) % 8] ?? 0) + af;
    const rb = Math.min(r, 0.999) * 6 - 0.5;
    const r0 = Math.max(0, Math.floor(rb));
    const rf = Math.max(0, rb - r0);
    radial[Math.min(5, r0)] = (radial[Math.min(5, r0)] ?? 0) + (1 - rf);
    radial[Math.min(5, r0 + 1)] = (radial[Math.min(5, r0 + 1)] ?? 0) + rf;
  }
  const n = points.length;
  const sorted = [...rs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const round = rs.filter((r) => Math.abs(r - median) < 0.1).length / n;
  return { angular: angular.map((v) => v / n), radial: radial.map((v) => v / n), round };
}

/** Samples a polyline at roughly even arc-length spacing so long segments do not dominate. */
function resample(path: PathObject, target = 24): { x: number; y: number }[] {
  const segs: { a: { x: number; y: number }; b: { x: number; y: number }; len: number }[] = [];
  let total = 0;
  for (const s of path.subpaths) {
    const pts = s.closed && s.points.length > 1 ? [...s.points, s.points[0] as { x: number; y: number }] : s.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as { x: number; y: number };
      const b = pts[i] as { x: number; y: number };
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      segs.push({ a, b, len });
      total += len;
    }
  }
  if (segs.length === 0 || total === 0) return path.subpaths.flatMap((s) => s.points);
  const out: { x: number; y: number }[] = [];
  const step = total / target;
  let next = 0;
  let walked = 0;
  for (const seg of segs) {
    while (next <= walked + seg.len && out.length < target) {
      const t = seg.len === 0 ? 0 : (next - walked) / seg.len;
      out.push({ x: seg.a.x + (seg.b.x - seg.a.x) * t, y: seg.a.y + (seg.b.y - seg.a.y) * t });
      next += step;
    }
    walked += seg.len;
  }
  return out;
}

export function elementOf(path: PathObject): Element {
  const extent = Math.max(path.box.w, path.box.h);
  const cx = path.box.x + path.box.w / 2;
  const cy = path.box.y + path.box.h / 2;
  const pointCount = path.subpaths.reduce((a, s) => a + s.points.length, 0);
  const curves = path.subpaths.reduce((a, s) => a + s.curves, 0);
  let kind: ElementKind;
  if (extent < 0.75) kind = 'dot';
  else if (curves > 0) kind = 'curve';
  else if (path.subpaths.length === 1 && pointCount === 2) kind = 'line';
  else if (path.subpaths.some((s) => s.closed) || (path.fill && !path.stroke)) kind = 'closed';
  else kind = 'open';
  const minSide = Math.max(Math.min(path.box.w, path.box.h), 1e-6);
  const aspect = Math.min(extent / minSide, 20);
  const { angular, radial, round } = histograms(resample(path), cx, cy, extent);
  return { kind, cx, cy, extent, aspect, fill: path.fill, stroke: path.stroke, angular, radial, round, index: path.index, box: path.box };
}

function rotateAngular(h: readonly number[], quarterTurns: number, mirror: boolean): number[] {
  let a = [...h];
  if (mirror) {
    // Mirror across the x axis: angle -> -angle. Bin k is centred at (k + 0.5) * 45deg - 180deg, so k -> 7 - k.
    a = a.map((_v, i) => h[7 - i] ?? 0);
  }
  const shift = (quarterTurns * 2) % 8;
  return a.map((_v, i) => a[(i - shift + 8) % 8] ?? 0);
}

/** Shape distance between a signature element and a plan element under a given rotation. 0 is identical. */
export function shapeDistance(ref: SignatureElement, el: Element, quarterTurns: number, mirror: boolean): number {
  let penalty = 0;
  if (ref.kind !== el.kind) {
    // Curves flattened differently or a closed polygon drawn open are close cousins, at a price.
    const cousins = (ref.kind === 'closed' && el.kind === 'curve') || (ref.kind === 'curve' && el.kind === 'closed') || (ref.kind === 'open' && el.kind === 'closed') || (ref.kind === 'closed' && el.kind === 'open');
    if (!cousins) return 1;
    penalty = 0.2;
  }
  if (ref.kind === 'dot' || el.kind === 'dot') return ref.kind === el.kind ? 0 : 1;
  const ang = rotateAngular(el.angular, quarterTurns, mirror);
  let d = 0;
  for (let i = 0; i < 8; i++) d += Math.abs((ref.angular[i] ?? 0) - (ang[i] ?? 0));
  let r = 0;
  for (let i = 0; i < 6; i++) r += Math.abs((ref.radial[i] ?? 0) - (el.radial[i] ?? 0));
  const aspect = Math.min(1, Math.abs(Math.log(ref.aspect / el.aspect)));
  const round = Math.abs(ref.round - el.round);
  return penalty + 0.5 * d + 0.35 * r + 0.3 * aspect + 0.5 * round;
}

// ---------------------------------------------------------------------------
// Signatures

/**
 * CAD exports often draw a solid fill as a run of thin filled strips (hatch
 * bands): consecutive, touching, filled paths with few points. They are one
 * shape to the eye and become one closed filled element here, on the legend
 * and on the plan alike, so both sides describe the glyph the same way.
 */
export function mergeHatchBands(paths: readonly PathObject[]): PathObject[] {
  const out: PathObject[] = [];
  let group: PathObject[] = [];
  const flush = () => {
    const box = unionAll(group.map((g) => g.box));
    const first = group[0];
    if (group.length >= 3 && box && first) {
      out.push({
        page: first.page,
        subpaths: [{ points: [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }], closed: true, curves: 0 }],
        box,
        fill: true,
        stroke: false,
        lineWidth: first.lineWidth,
        index: first.index,
      });
    } else {
      out.push(...group);
    }
    group = [];
  };
  const isBand = (p: PathObject) => p.fill && p.subpaths.length <= 2 && p.subpaths.reduce((a, s) => a + s.points.length, 0) <= 8 && Math.min(p.box.w, p.box.h) < 1.5;
  const touches = (a: Box, b: Box) => a.x <= b.x + b.w + 0.6 && b.x <= a.x + a.w + 0.6 && a.y <= b.y + b.h + 0.6 && b.y <= a.y + a.h + 0.6;
  for (const p of paths) {
    const last = group[group.length - 1];
    if (isBand(p) && (!last || (p.index === last.index + 1 && touches(last.box, p.box)))) {
      group.push(p);
      continue;
    }
    flush();
    if (isBand(p)) group.push(p);
    else out.push(p);
  }
  flush();
  return out;
}

/** Paths that draw a legend glyph: centred in the symbol cell and no larger than it (table rules are). */
export function glyphPaths(paths: readonly PathObject[], cell: Box): PathObject[] {
  const cap = Math.max(cell.w, cell.h) * 1.05;
  return mergeHatchBands(paths).filter((p) => {
    const cx = p.box.x + p.box.w / 2;
    const cy = p.box.y + p.box.h / 2;
    if (cx < cell.x || cx > cell.x + cell.w || cy < cell.y || cy > cell.y + cell.h) return false;
    const extent = Math.max(p.box.w, p.box.h);
    if (extent > cap) return false;
    // A rule across the cell: straight, thin, and spanning most of the cell's width or height.
    const straight = p.subpaths.length === 1 && p.subpaths[0]?.points.length === 2;
    if (straight && ((p.box.w >= cell.w * 0.9 && p.box.h < 0.5) || (p.box.h >= cell.h * 0.9 && p.box.w < 0.5))) return false;
    return true;
  });
}

export function buildSignature(paths: readonly PathObject[]): Signature | null {
  if (paths.length === 0) return null;
  const elements = paths.map(elementOf);
  const box = unionAll(paths.map((p) => p.box));
  if (!box) return null;
  const extent = Math.max(box.w, box.h);
  if (extent < 0.5) return null;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let anchor = 0;
  elements.forEach((e, i) => {
    const best = elements[anchor];
    if (best && (e.extent > best.extent || (e.extent === best.extent && e.kind === 'curve' && best.kind !== 'curve'))) anchor = i;
  });
  const sig: SignatureElement[] = elements.map((e) => ({
    kind: e.kind,
    dx: (e.cx - cx) / extent,
    dy: (e.cy - cy) / extent,
    size: e.extent / extent,
    aspect: e.aspect,
    fill: e.fill,
    stroke: e.stroke,
    angular: e.angular,
    radial: e.radial,
    round: e.round,
    weight: 0.15 + e.extent / extent,
  }));
  return { elements: sig, anchor, extent, anchorSize: sig[anchor]?.size ?? 1 };
}

// ---------------------------------------------------------------------------
// Spatial index over plan elements

export class SpatialIndex {
  readonly elements: readonly Element[];
  private readonly cell: number;
  private readonly grid = new Map<string, number[]>();
  constructor(elements: readonly Element[], cell = 12) {
    this.elements = elements;
    this.cell = cell;
    elements.forEach((e, i) => {
      const key = `${Math.floor(e.cx / cell)}:${Math.floor(e.cy / cell)}`;
      const bucket = this.grid.get(key);
      if (bucket) bucket.push(i);
      else this.grid.set(key, [i]);
    });
  }

  /** Indices of elements whose centre lies within `radius` of (x, y). */
  near(x: number, y: number, radius: number): number[] {
    const out: number[] = [];
    const c = this.cell;
    for (let gx = Math.floor((x - radius) / c); gx <= Math.floor((x + radius) / c); gx++) {
      for (let gy = Math.floor((y - radius) / c); gy <= Math.floor((y + radius) / c); gy++) {
        const bucket = this.grid.get(`${gx}:${gy}`);
        if (!bucket) continue;
        for (const i of bucket) {
          const e = this.elements[i];
          if (e && Math.hypot(e.cx - x, e.cy - y) <= radius) out.push(i);
        }
      }
    }
    return out;
  }
}

function rotateOffset(dx: number, dy: number, quarterTurns: number, mirror: boolean): { dx: number; dy: number } {
  let x = dx;
  let y = mirror ? -dy : dy;
  for (let k = 0; k < quarterTurns; k++) {
    const nx = -y;
    y = x;
    x = nx;
  }
  return { dx: x, dy: y };
}

/** Every place `sig` could sit among `index.elements`, before conflicts between items are resolved. */
export function candidateMatches(sig: Signature, index: SpatialIndex, opts: MatchOptions = defaultMatchOptions): { candidates: SymbolMatch[]; anchorCandidates: number } {
  const anchor = sig.elements[sig.anchor];
  if (!anchor) return { candidates: [], anchorCandidates: 0 };
  const anchorExtentRef = anchor.size * sig.extent;
  const [minScale, maxScale] = opts.scaleRange;
  const variants: { q: number; m: boolean }[] = [];
  for (let q = 0; q < 4; q++) {
    variants.push({ q, m: false });
    if (opts.allowMirror) variants.push({ q, m: true });
  }
  const candidates: { match: SymbolMatch; used: number[] }[] = [];
  let anchorCandidates = 0;
  index.elements.forEach((el, i) => {
    const scale = el.extent / anchorExtentRef;
    if (scale < minScale || scale > maxScale) return;
    if (anchor.kind !== 'dot' && (el.fill !== anchor.fill) && sig.elements.length === 1) return;
    let bestAnchorDist = 1;
    for (const v of variants) bestAnchorDist = Math.min(bestAnchorDist, shapeDistance(anchor, el, v.q, v.m));
    if (bestAnchorDist > 0.45) return;
    const quality = (d: number, limit: number) => 1 - (0.5 * d) / limit;
    anchorCandidates += 1;
    const symbolExtent = sig.extent * scale;
    const tol = Math.max(0.8, opts.positionTolerance * symbolExtent);
    let best: { score: number; v: { q: number; m: boolean }; used: number[] } | null = null;
    for (const v of variants) {
      const anchorDist = shapeDistance(anchor, el, v.q, v.m);
      if (anchorDist > 0.45) continue;
      // Cluster centre implied by this anchor under this variant.
      const off = rotateOffset(anchor.dx, anchor.dy, v.q, v.m);
      const ccx = el.cx - off.dx * symbolExtent;
      const ccy = el.cy - off.dy * symbolExtent;
      let total = 0;
      let matched = 0;
      const used: number[] = [];
      const taken = new Set<number>([i]);
      for (let k = 0; k < sig.elements.length; k++) {
        const ref = sig.elements[k];
        if (!ref) continue;
        total += ref.weight;
        if (k === sig.anchor) {
          matched += ref.weight * quality(anchorDist, 0.45);
          used.push(i);
          continue;
        }
        const o = rotateOffset(ref.dx, ref.dy, v.q, v.m);
        const ex = ccx + o.dx * symbolExtent;
        const ey = ccy + o.dy * symbolExtent;
        const wanted = ref.size * symbolExtent;
        let found = -1;
        let foundDist = Infinity;
        for (const j of index.near(ex, ey, tol)) {
          if (taken.has(j)) continue;
          const cand = index.elements[j];
          if (!cand) continue;
          const sizeRatio = wanted < 1 ? 1 : cand.extent / wanted;
          if (wanted >= 1 && (sizeRatio < 0.55 || sizeRatio > 1.8)) continue;
          const d = shapeDistance(ref, cand, v.q, v.m) + Math.hypot(cand.cx - ex, cand.cy - ey) / tol / 4;
          if (d < 0.6 && d < foundDist) {
            found = j;
            foundDist = d;
          }
        }
        if (found >= 0) {
          matched += ref.weight * quality(foundDist, 0.6);
          used.push(found);
          taken.add(found);
        }
      }
      // Most of the cluster must be there: a bare circle is not a detector with a missing dot.
      const enough = used.length >= Math.max(1, Math.ceil(sig.elements.length * opts.minElementFraction));
      const score = total === 0 || !enough ? 0 : matched / total;
      if (!best || score > best.score) best = { score, v, used };
    }
    if (best && best.score >= opts.minScore) {
      const boxes = best.used.map((j) => index.elements[j]?.box).filter((b): b is Box => b !== undefined);
      const box = unionAll(boxes) ?? el.box;
      candidates.push({ match: { box, score: Math.round(best.score * 100) / 100, rotation: best.v.q, mirrored: best.v.m, scale: Math.round(scale * 100) / 100, pathIndices: best.used }, used: best.used });
    }
  });
  return { candidates: candidates.map((c) => c.match), anchorCandidates };
}

/**
 * Finds every instance of `sig` among `index.elements`, skipping elements in
 * `consumed`; successful matches add their elements to `consumed`. Best
 * scores first: a plan element belongs to one instance only.
 */
export function matchSignature(sig: Signature, index: SpatialIndex, consumed: Set<number>, opts: MatchOptions = defaultMatchOptions): { matches: SymbolMatch[]; anchorCandidates: number } {
  const { candidates, anchorCandidates } = candidateMatches(sig, index, opts);
  const matches: SymbolMatch[] = [];
  for (const c of [...candidates].sort((a, b) => b.score - a.score || b.pathIndices.length - a.pathIndices.length)) {
    if (c.pathIndices.some((j) => consumed.has(j))) continue;
    for (const j of c.pathIndices) consumed.add(j);
    matches.push(c);
  }
  return { matches, anchorCandidates };
}

// ---------------------------------------------------------------------------
// Legend glyphs to signatures, plan pages to detections

/** Attaches a signature to every legend item whose symbol cell holds paths on the legend's page. */
export function attachSignatures(items: LegendItem[], legendPaths: readonly PathObject[]): number {
  let n = 0;
  for (const item of items) {
    if (!item.symbolBox) continue;
    const sig = buildSignature(glyphPaths(legendPaths, item.symbolBox));
    if (sig) {
      item.signature = sig;
      n++;
    }
  }
  return n;
}

export interface ItemMatchStats {
  itemId: string;
  referenceElements: number;
  anchorCandidates: number;
  matches: number;
  meanScore: number;
}

export interface MatchSymbolsArgs {
  items: readonly LegendItem[];
  planPages: readonly PagePaths[];
  pageTexts: readonly PageText[];
  /** Regions per page whose matches are dropped (legend, title block, notes). */
  exclude: ReadonlyMap<number, readonly Box[]>;
  options?: Partial<MatchOptions> | undefined;
  /** Largest plan element considered (points); walls and borders are bigger. */
  maxElementExtent?: number | undefined;
}

export function matchSymbols(args: MatchSymbolsArgs): { detections: Detection[]; stats: ItemMatchStats[] } {
  const opts = { ...defaultMatchOptions, ...(args.options ?? {}) };
  const withSig = args.items.filter((i): i is LegendItem & { signature: Signature } => i.signature !== undefined);
  const tags = new Set(args.items.flatMap((i) => (i.tag ? [i.tag] : [])));
  const maxExtent = args.maxElementExtent ?? Math.max(40, ...withSig.map((i) => i.signature.extent * opts.scaleRange[1] * 1.2));
  const statsMap = new Map<string, ItemMatchStats>();
  for (const i of withSig) statsMap.set(i.id, { itemId: i.id, referenceElements: i.signature.elements.length, anchorCandidates: 0, matches: 0, meanScore: 0 });
  const detections: Detection[] = [];
  for (const pp of args.planPages) {
    const elements = mergeHatchBands(pp.paths)
      .filter((p) => Math.max(p.box.w, p.box.h) <= maxExtent)
      .map(elementOf);
    const index = new SpatialIndex(elements);
    const excluded = args.exclude.get(pp.page) ?? [];
    const text = args.pageTexts.find((t) => t.page === pp.page);
    // Every item proposes its instances; conflicts over a plan element go to the better-scoring,
    // then the larger, proposal, so a composite glyph beats its parts and a close cousin loses to the exact item.
    const proposals: { item: LegendItem & { signature: Signature }; m: SymbolMatch }[] = [];
    for (const item of withSig) {
      const { candidates, anchorCandidates } = candidateMatches(item.signature, index, opts);
      const st = statsMap.get(item.id);
      if (st) st.anchorCandidates += anchorCandidates;
      for (const m of candidates) proposals.push({ item, m });
    }
    proposals.sort((a, b) => b.m.score - a.m.score || b.m.pathIndices.length - a.m.pathIndices.length || b.item.signature.extent - a.item.signature.extent);
    const consumed = new Set<number>();
    for (const { item, m } of proposals) {
      if (m.pathIndices.some((j) => consumed.has(j))) continue;
      for (const j of m.pathIndices) consumed.add(j);
      const st = statsMap.get(item.id);
      {
        const cx = m.box.x + m.box.w / 2;
        const cy = m.box.y + m.box.h / 2;
        if (excluded.some((b) => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h)) continue;
        // A letter inside the symbol names it: another legend tag means another item (or a grid bubble).
        const inside = text?.spans.filter((s) => {
          const sx = s.box.x + s.box.w / 2;
          const sy = s.box.y + s.box.h / 2;
          return sx >= m.box.x && sx <= m.box.x + m.box.w && sy >= m.box.y && sy <= m.box.y + m.box.h && isTagLike(s.str);
        });
        const foreign = inside?.find((s) => normalizeText(s.str) !== item.tag && (tags.has(normalizeText(s.str)) || item.tag === null));
        if (foreign) continue;
        const d: Detection = { page: pp.page, itemId: item.id, box: boxFromCorners(m.box.x, m.box.y, m.box.x + m.box.w, m.box.y + m.box.h), confidence: m.score, source: 'symbol', multiplier: 1, needsReview: m.score < 0.85 };
        if (d.needsReview) d.reviewReason = `symbol match ${m.score.toFixed(2)} (${m.rotation * 90}°${m.mirrored ? ' mirrored' : ''}, scale ${m.scale})`;
        detections.push(d);
        if (st) {
          st.matches += 1;
          st.meanScore += m.score;
        }
      }
    }
  }
  const stats = [...statsMap.values()].map((s) => ({ ...s, meanScore: s.matches === 0 ? 0 : Math.round((s.meanScore / s.matches) * 100) / 100 }));
  return { detections, stats };
}
