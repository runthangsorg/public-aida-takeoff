/**
 * Finds legends in the vector text of a page.
 *
 * Two shapes are recognised:
 *
 * - Row legends: a heading (LEGEND, SYMBOLS, KEY) followed by rows of
 *   `[symbol] [tag] [description]`.
 * - Table legends: the heading sits in a header row with column titles such
 *   as MANUFACTURER'S CAT No. or MOUNTING HEIGHT. Descriptions fill the
 *   column to the left of those, wrapping over lines; the type tag is a
 *   short text inside the symbol column further left; the catalogue column
 *   is kept as a reference.
 *
 * The symbol itself is graphics, so every legend box is widened to the
 * left to cover the symbol column.
 */
import { boxFromCorners, clampToPage, unionAll } from '../geometry.ts';
import { normalizeText } from '../pdf/text.ts';
import type { Box, Legend, LegendItem, PageText, TextSpan } from '../types.ts';

const HEADING = /^(?:[A-Z&/ ]{0,24}\b)?(?:LEGEND|LEGENDS|SYMBOLS?|KEY TO SYMBOLS|SYMBOL KEY)\b[:.]?$/;
const STOP_HEADING = /^(?:NOTES?|GENERAL NOTES|ABBREVIATIONS|DRAWING TITLE|DRAWING NO|PROJECT|SCALE|REV(?:ISION)?|STATUS|KEY PLAN|SCHEDULE)\b/;
const COLUMN = /^(?:MANUFACTURERS?'?S?\b|MANUFACTURER'S|CAT(?:ALOGUE)?\.?\s*NO|MOUNTING|HEIGHT|DESCRIPTION|SYMBOL|REMARKS?|QTY|QUANTITY|REF(?:ERENCE)?\.?$|TYPE$|MAKE|MODEL)/;

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

function inside(b: Box, s: TextSpan): boolean {
  const cx = s.box.x + s.box.w / 2;
  const cy = s.box.y + s.box.h / 2;
  return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)] ?? 0;
}

/**
 * Every legend on the page, top to bottom. `exclude` holds regions whose
 * headings must be ignored: a title block often carries "LEGEND" as the
 * sheet's subject, and the text under it is not a legend.
 */
export function findLegends(pageText: PageText, exclude: readonly Box[] = []): Legend[] {
  const headings = pageText.spans.filter((s) => HEADING.test(normalizeText(s.str)) && !exclude.some((b) => inside(b, s)));
  headings.sort((a, b) => b.fontSize - a.fontSize || a.box.y - b.box.y);
  const found: Legend[] = [];
  for (const heading of headings) {
    if (found.some((l) => inside(l.box, heading))) continue;
    const legend = readTable(pageText, heading) ?? readRows(pageText, heading);
    if (legend && legend.items.length > 0) found.push(legend);
  }
  return found.sort((a, b) => a.box.y - b.box.y);
}

/** The first legend on the page (kept for callers that expect one). */
export function findLegend(pageText: PageText): Legend | null {
  return findLegends(pageText)[0] ?? null;
}

function readTable(pageText: PageText, heading: TextSpan): Legend | null {
  const hb = heading.box;
  // Column titles: to the right of the heading, within a few heading heights vertically.
  const headerSpans = pageText.spans.filter(
    (s) => s !== heading && s.box.x > hb.x + hb.w * 0.5 && Math.abs(s.box.y + s.box.h / 2 - (hb.y + hb.h / 2)) < Math.max(hb.h, s.box.h) * 2.5 && COLUMN.test(normalizeText(s.str)),
  );
  if (headerSpans.length === 0) return null;
  const columns = [...new Set(headerSpans.map((s) => Math.round(s.box.x)))].sort((a, b) => a - b);
  const firstCol = columns[0] ?? Infinity;
  const headerBottom = Math.max(hb.y + hb.h, ...headerSpans.map((s) => s.box.y + s.box.h));
  const right = Math.max(...headerSpans.map((s) => s.box.x + s.box.w)) + hb.h * 2;

  // Description column: text below the header, left of the first title column.
  const below = pageText.spans.filter((s) => s.box.y > headerBottom - hb.h * 0.2 && s.box.x < firstCol - 4 && s.box.x + s.box.w <= right);
  const prose = below.filter((s) => s.str.trim().length >= 4 && !isTagLike(s.str));
  if (prose.length === 0) return null;
  const xs = prose.map((s) => s.box.x).sort((a, b) => a - b);
  const descLeft = xs[Math.floor(xs.length * 0.1)] ?? xs[0] ?? 0;
  const bodyFont = median(prose.map((s) => s.fontSize));
  const descSpans = below.filter((s) => s.box.x >= descLeft - 2 && s.fontSize <= bodyFont * 1.6);
  const symbolSpans = below.filter((s) => s.box.x < descLeft - 2 && s.box.x > descLeft - hb.h * 10 && isTagLike(s.str));
  const refSpans = pageText.spans.filter((s) => s.box.y > headerBottom - hb.h * 0.2 && s.box.x >= firstCol - 4 && s.box.x < (columns[1] ?? right) - 4 && s.box.x + s.box.w <= right + hb.h * 4);

  // Rows: description lines closer than most of a line height belong together (wrapped text).
  const lines = groupLines(descSpans);
  const rows: Line[][] = [];
  let lastBottom = -Infinity;
  for (const line of lines) {
    const top = Math.min(...line.spans.map((s) => s.box.y));
    const bottom = Math.max(...line.spans.map((s) => s.box.y + s.box.h));
    const gap = top - lastBottom;
    if (rows.length > 0 && gap > bodyFont * 10) break; // table ended (several empty rows)
    const text = normalizeText(line.spans.map((s) => s.str).join(' '));
    if (STOP_HEADING.test(text)) break;
    // Wrapped lines of one description nearly touch; the next row starts after a table rule.
    const current = rows[rows.length - 1];
    if (current && gap <= bodyFont * 0.6) current.push(line);
    else rows.push([line]);
    lastBottom = bottom;
  }
  const pitch = rows.length > 1 ? median(rows.slice(1).map((r, i) => (r[0]?.y ?? 0) - (rows[i]?.[0]?.y ?? 0))) : bodyFont * 2.5;

  const items: LegendItem[] = [];
  let n = 0;
  for (const row of rows) {
    const spans = row.flatMap((l) => l.spans);
    const description = normalizeText(spans.map((s) => s.str).join(' '));
    if (description.length < 3) continue;
    const top = Math.min(...spans.map((s) => s.box.y));
    const bottom = Math.max(...spans.map((s) => s.box.y + s.box.h));
    const yMid = (top + bottom) / 2;
    const within = (s: TextSpan) => s.box.y + s.box.h / 2 >= top - pitch * 0.45 && s.box.y + s.box.h / 2 <= bottom + pitch * 0.45;
    const tagSpan = symbolSpans.filter(within).sort((a, b) => Math.abs(a.box.y + a.box.h / 2 - yMid) - Math.abs(b.box.y + b.box.h / 2 - yMid))[0];
    const tag = tagSpan ? normalizeText(tagSpan.str) : null;
    const reference = normalizeText(refSpans.filter(within).map((s) => s.str).join(' '));
    n++;
    const rowBox = unionAll([...spans, ...(tagSpan ? [tagSpan] : [])].map((s) => s.box)) ?? spans[0]?.box ?? hb;
    // The symbol cell: left of the description column, centred on the row, inside the row pitch.
    const cellLeft = Math.max(0, descLeft - hb.h * 6);
    const symbolBox = clampToPage({ x: cellLeft, y: yMid - pitch * 0.42, w: descLeft - 2 - cellLeft, h: pitch * 0.84 }, pageText.width, pageText.height);
    const item: LegendItem = { id: tag ?? `L${n}`, tag, description, box: rowBox, page: pageText.page, symbolBox };
    if (reference.length > 0) item.reference = reference;
    items.push(item);
  }
  if (items.length === 0) return null;
  const rowsBox = unionAll(items.map((i) => i.box)) ?? hb;
  const box = clampToPage(
    boxFromCorners(Math.min(descLeft - hb.h * 6, rowsBox.x), Math.min(hb.y, rowsBox.y) - hb.h * 0.5, right, rowsBox.y + rowsBox.h + pitch * 0.5),
    pageText.width,
    pageText.height,
  );
  return { page: pageText.page, box, items, source: 'vector' };
}

function readRows(pageText: PageText, heading: TextSpan): Legend | null {
  const hb = heading.box;
  // Candidate rows: below the heading, roughly aligned with it (a legend is a
  // column; rows begin within a third of the page width to the right of the
  // heading and no more than a few characters to its left).
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
  // A row legend with no tags and fewer than three rows is more likely a stray heading.
  if (items.length === 0 || (items.length < 3 && items.every((i) => i.tag === null))) return null;
  // Symbol cells: left of each row's first text, centred on the row, within the row pitch.
  const first = items[0];
  const last = items[items.length - 1];
  const pitch = items.length > 1 && first && last ? (last.box.y - first.box.y) / (items.length - 1) : hb.h * 2.5;
  for (const it of items) {
    const yMid = it.box.y + it.box.h / 2;
    const cellLeft = Math.max(0, Math.min(hb.x, it.box.x) - hb.h * 6);
    it.symbolBox = clampToPage({ x: cellLeft, y: yMid - pitch * 0.42, w: it.box.x - 2 - cellLeft, h: pitch * 0.84 }, pageText.width, pageText.height);
  }
  const rows = unionAll(items.map((i) => i.box)) ?? hb;
  const symbolMargin = Math.max(hb.h * 5, (rows.h / items.length) * 3);
  const box: Box = clampToPage(
    boxFromCorners(Math.min(hb.x, rows.x) - symbolMargin, hb.y - hb.h * 0.5, Math.max(hb.x + hb.w, rows.x + rows.w) + hb.h, rows.y + rows.h + hb.h),
    pageText.width,
    pageText.height,
  );
  return { page: pageText.page, box, items, source: 'vector' };
}
