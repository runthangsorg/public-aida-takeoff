/**
 * Counts tagged instances from vector text: every span that is exactly a
 * legend tag (or a multiplier form such as `4 NO. A1` or `A1 x2`) and lies
 * outside the legend and the title block is one instance.
 */
import { centerInside, roundBox } from '../geometry.ts';
import { normalizeText } from '../pdf/text.ts';
import type { Box, Detection, PageText } from '../types.ts';

const MULT_BEFORE = /^(\d{1,3})\s*(?:NO\.?|NR\.?|N°|X|×|OFF)?\s*([A-Z]{1,4}-?\d{0,3}[A-Z]?)$/;
const MULT_AFTER = /^([A-Z]{1,4}-?\d{0,3}[A-Z]?)\s*[X×]\s*(\d{1,3})$/;

export interface TagMatch {
  tag: string;
  multiplier: number;
}

/** Parses a span into a tag plus multiplier, or null when it is not a tag. */
export function parseTagSpan(str: string, tags: ReadonlySet<string>): TagMatch | null {
  const n = normalizeText(str);
  if (tags.has(n)) return { tag: n, multiplier: 1 };
  let m = MULT_BEFORE.exec(n);
  if (m?.[1] !== undefined && m[2] !== undefined && tags.has(m[2])) return { tag: m[2], multiplier: Number(m[1]) };
  m = MULT_AFTER.exec(n);
  if (m?.[1] !== undefined && m[2] !== undefined && tags.has(m[1])) return { tag: m[1], multiplier: Number(m[2]) };
  return null;
}

/**
 * @param tags     legend tags to look for (normalised)
 * @param exclude  regions on this page to ignore (legend, title block, notes)
 */
export function countTags(pageText: PageText, tags: ReadonlySet<string>, exclude: readonly Box[]): Detection[] {
  if (tags.size === 0) return [];
  const out: Detection[] = [];
  for (const span of pageText.spans) {
    const match = parseTagSpan(span.str, tags);
    if (!match) continue;
    if (exclude.some((b) => centerInside(b, span.box))) continue;
    out.push({
      page: pageText.page,
      itemId: match.tag,
      box: roundBox(span.box),
      confidence: 1,
      source: 'vector',
      multiplier: match.multiplier,
      needsReview: false,
    });
  }
  return out;
}
