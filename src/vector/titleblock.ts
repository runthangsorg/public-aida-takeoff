/**
 * Reads the title block from vector text: drawing number, title and scale.
 * The title block is located from its labels; when none are found the
 * bottom strip of the page is assumed, which is where it sits on nearly
 * every sheet.
 */
import { expand, unionAll } from '../geometry.ts';
import { normalizeText } from '../pdf/text.ts';
import type { Box, PageText, TextSpan, TitleBlock } from '../types.ts';

const SCALE = /\b1\s*[:/]\s*(\d{1,4})\b/;
// Inputs are whitespace-normalised, so single optional spaces keep these linear.
const DRAWING_NO = /^(?:DRAWING|DRG|DWG|SHEET)\.? ?(?:NO|NUMBER|N°|#)\.? ?[:.-]? ?(.*)$/;
const TITLE = /^(?:DRAWING )?TITLE ?[:.-]? ?(.*)$/;
const LABELS = /^(?:PROJECT|CLIENT|DRAWING TITLE|TITLE|DRAWING NO|DWG NO|DRG NO|SCALE|REV|REVISION|STATUS|DATE|DRAWN|CHECKED|APPROVED|SHEET)\b/;

/** The nearest span to the right of `label` on the same line, or directly below it. */
function valueNear(label: TextSpan, spans: readonly TextSpan[]): string | null {
  const lb = label.box;
  const sameLine = spans
    .filter((s) => s !== label && Math.abs(s.box.y + s.box.h / 2 - (lb.y + lb.h / 2)) < lb.h && s.box.x > lb.x + lb.w - 1 && s.box.x - (lb.x + lb.w) < lb.h * 30)
    .sort((a, b) => a.box.x - b.box.x)[0];
  if (sameLine && !LABELS.test(normalizeText(sameLine.str))) return sameLine.str.trim();
  const below = spans
    .filter((s) => s !== label && s.box.y > lb.y + lb.h * 0.5 && s.box.y - (lb.y + lb.h) < lb.h * 2 && Math.abs(s.box.x - lb.x) < lb.h * 4)
    .sort((a, b) => a.box.y - b.box.y)[0];
  if (below && !LABELS.test(normalizeText(below.str))) return below.str.trim();
  return null;
}

export function readTitleBlock(pageText: PageText): TitleBlock {
  const spans = pageText.spans;
  let drawingNumber: string | null = null;
  let title: string | null = null;
  let scale: number | null = null;
  const labelBoxes: Box[] = [];

  for (const s of spans) {
    const n = normalizeText(s.str);
    let m = DRAWING_NO.exec(n);
    if (m && drawingNumber === null) {
      labelBoxes.push(s.box);
      drawingNumber = m[1] && m[1].length > 0 ? m[1] : valueNear(s, spans);
      continue;
    }
    m = TITLE.exec(n);
    if (m && title === null) {
      labelBoxes.push(s.box);
      title = m[1] && m[1].length > 0 ? m[1] : valueNear(s, spans);
      continue;
    }
    if (/^SCALE\b/.test(n) && scale === null) {
      labelBoxes.push(s.box);
      const text = SCALE.test(n) ? n : (valueNear(s, spans) ?? '');
      const sm = SCALE.exec(normalizeText(text));
      if (sm?.[1] !== undefined) scale = Number(sm[1]);
      continue;
    }
    if (LABELS.test(n)) labelBoxes.push(s.box);
  }
  if (scale === null) {
    // A bare scale note anywhere (`SCALE 1:100`, `1:50 @ A1`).
    for (const s of spans) {
      const sm = SCALE.exec(normalizeText(s.str));
      if (sm?.[1] !== undefined) {
        scale = Number(sm[1]);
        break;
      }
    }
  }

  let box: Box | null = null;
  const labels = unionAll(labelBoxes);
  if (labels) {
    // Grow to the right edge of the page and pad a little; title blocks are boxes of labels and values.
    const padded = expand(labels, Math.min(24, labels.h * 0.3 + 12));
    box = { x: padded.x, y: padded.y, w: pageText.width - padded.x, h: padded.h };
  }
  return { drawingNumber, title, scale, box };
}

/** The region of the notes block, if a NOTES heading exists: from the heading to the bottom of its column. */
export function findNotesBox(pageText: PageText): Box | null {
  const heading = pageText.spans.find((s) => /^(?:GENERAL\s+)?NOTES?\b[:.]?$/.test(normalizeText(s.str)));
  if (!heading) return null;
  const hb = heading.box;
  const column = pageText.spans.filter((s) => s.box.y >= hb.y && s.box.x >= hb.x - hb.h && s.box.x < hb.x + hb.h * 2 && s.str.trim().length > 12);
  const all = unionAll([hb, ...column.map((s) => s.box)]) ?? hb;
  // Notes are sentences; widen to the longest line.
  const widest = Math.max(hb.w, ...column.map((s) => s.box.w));
  return expand({ x: all.x, y: all.y, w: widest, h: all.h }, hb.h);
}
