/**
 * Finds a legend in the vector text of a page: a heading such as LEGEND or
 * SYMBOLS, followed by rows of [symbol] [tag] [description]. The symbol
 * itself is graphics, so the row box is widened to the left to include it.
 */
import { boxFromCorners, clampToPage, unionAll } from '../geometry.ts';
import { normalizeText } from '../pdf/text.ts';
import type { Box, Legend, LegendItem, PageText, TextSpan } from '../types.ts';

const HEADING = /^(?:[A-Z&/ ]{0,24}\b)?(?:LEGEND|LEGENDS|SYMBOLS?|KEY TO SYMBOLS|SYMBOL KEY)\b[:.]?$/;
const STOP_HEADING = /^(?:NOTES?|GENERAL NOTES|ABBREVIATIONS|DRAWING TITLE|DRAWING NO|PROJECT|SCALE|REV(?:ISION)?|STATUS|KEY PLAN|SCHEDULE)\b/;

/** A type tag: one to four letters, up to three digits, optional trailing letter or suffix. */
export const TAG = /^[A-Z]{1,4}-?[0-9]{0,3}[A-Z]?$/;

export function isTagLike(s: string): boolean {
  const n = normalizeText(s);
  return TAG.test(n) && n.length <= 6;
}

interface Line {
  y: number;
  spans: TextSpan[];
}

/** Groups spans into lines by vertical position. */
export function groupLines(spans: readonly TextSpan[], tolerance = 0.6): Line[] {
  const sorted = [...spans].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const lines: Line[] = [];
  for (const s of sorted) {
    const cy = s.box.y + s.box.h / 2;
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - cy) <= tolerance * s.box.h) {
      last.spans.push(s);
    } else {
      lines.push({ y: cy, spans: [s] });
    }
  }
  for (const l of lines) l.spans.sort((a, b) => a.box.x - b.box.x);
  return lines;
}

export function findLegend(pageText: PageText): Legend | null {
  const headings = pageText.spans.filter((s) => HEADING.test(normalizeText(s.str)));
  if (headings.length === 0) return null;
  // Prefer the largest heading; ties go to the top-most.
  headings.sort((a, b) => b.fontSize - a.fontSize || a.box.y - b.box.y);
  for (const heading of headings) {
    const legend = readLegendBelow(pageText, heading);
    if (legend && legend.items.length > 0) return legend;
  }
  return null;
}

function readLegendBelow(pageText: PageText, heading: TextSpan): Legend | null {
  const hb = heading.box;
  // Candidate rows: below the heading, roughly aligned with it (a legend is a
  // column; rows begin within half a page-width to the right of the heading
  // and no more than a few characters to its left).
  const left = hb.x - hb.h * 6;
  const right = Math.min(pageText.width, hb.x + Math.max(pageText.width * 0.35, 320));
  const below = pageText.spans.filter((s) => s !== heading && s.box.y > hb.y + hb.h * 0.5 && s.box.x >= left && s.box.x < right);
  const lines = groupLines(below);
  const items: LegendItem[] = [];
  let lastBottom = hb.y + hb.h;
  let rowGap: number | null = null;
  let n = 0;
  for (const line of lines) {
    const first = line.spans[0];
    if (!first) continue;
    const top = Math.min(...line.spans.map((s) => s.box.y));
    const bottom = Math.max(...line.spans.map((s) => s.box.y + s.box.h));
    const gap = top - lastBottom;
    // Stop at a large vertical gap (another block) or a different heading.
    const limit = rowGap === null ? hb.h * 4 : Math.max(rowGap * 2.5, hb.h * 2.5);
    if (gap > limit) break;
    const text = normalizeText(line.spans.map((s) => s.str).join(' '));
    if (STOP_HEADING.test(text)) break;
    const tagLike = isTagLike(first.str);
    const description = normalizeText((tagLike ? line.spans.slice(1) : line.spans).map((s) => s.str).join(' '));
    if (!tagLike && description.length < 3) continue;
    n++;
    const tag = tagLike ? normalizeText(first.str) : null;
    const rowBox = unionAll(line.spans.map((s) => s.box)) ?? first.box;
    items.push({ id: tag ?? `L${n}`, tag, description, box: rowBox, page: pageText.page });
    if (items.length > 1) rowGap = rowGap === null ? gap : Math.max(rowGap, gap);
    lastBottom = bottom;
  }
  if (items.length === 0) return null;
  const rows = unionAll(items.map((i) => i.box)) ?? hb;
  const symbolMargin = Math.max(hb.h * 5, rows.h / items.length * 3);
  const box: Box = clampToPage(
    boxFromCorners(Math.min(hb.x, rows.x) - symbolMargin, hb.y - hb.h * 0.5, Math.max(hb.x + hb.w, rows.x + rows.w) + hb.h, rows.y + rows.h + hb.h),
    pageText.width,
    pageText.height,
  );
  return { page: pageText.page, box, items, source: 'vector' };
}
