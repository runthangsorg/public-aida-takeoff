/**
 * Counts tagged instances from vector text: every span that is exactly a
 * legend tag (or a multiplier form such as `4 NO. A1` or `A1 x2`) and lies
 * outside the legend and the title block is one instance.
 */
import { centerInside, roundBox } from '../geometry.ts';
import { normalizeText } from '../pdf/text.ts';
import type { Box, Detection, PageText } from '../types.ts';

// Inputs are whitespace-normalised, so a single optional space is enough and keeps the patterns linear.
// "4 NO. A1", "4NR A1", "4 X A1", "4 OFF A1" carry a multiplier word; a bare "13A" is an amperage, not 13 x A.
const MULT_WORD = /^(\d{1,3}) ?(?:NO\.?|NR\.?|N°|X|×|OFF) ?([A-Z]{1,4}-?\d{0,3}[A-Z]?)$/;
const MULT_BARE = /^(\d{1,3})([A-Z]{2,4}-?\d{0,3}[A-Z]?)$/;
const MULT_AFTER = /^([A-Z]{1,4}-?\d{0,3}[A-Z]?) ?[X×] ?(\d{1,3})$/;
/** Tags that are also units of measure: never accepted in the bare `<digits><tag>` form. */
const UNITS = new Set(['A', 'V', 'W', 'M', 'MM', 'CM', 'KW', 'KVA', 'KV', 'HZ', 'LM', 'LX', 'K', 'AH', 'VA', 'MA', 'DB', 'NO', 'NR', 'OFF', 'DP', 'SP', 'TP', 'TPN', 'SPN', 'AMP', 'AMPS', 'DEG', 'PA', 'KPA', 'BAR']);

export interface TagMatch {
  tag: string;
  multiplier: number;
}

/** Parses a span into a tag plus multiplier, or null when it is not a tag. */
export function parseTagSpan(str: string, tags: ReadonlySet<string>): TagMatch | null {
  const n = normalizeText(str);
  if (tags.has(n)) return { tag: n, multiplier: 1 };
  let m = MULT_WORD.exec(n);
  if (m?.[1] !== undefined && m[2] !== undefined && tags.has(m[2])) return { tag: m[2], multiplier: Number(m[1]) };
  m = MULT_BARE.exec(n);
  if (m?.[1] !== undefined && m[2] !== undefined && tags.has(m[2]) && !UNITS.has(m[2])) return { tag: m[2], multiplier: Number(m[1]) };
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
    // Letters drawn inside one symbol (a chandelier's "F F F") sit within a glyph of each other:
    // that is one instance, not three. Real neighbouring fixtures are at least a symbol apart.
    const cx = span.box.x + span.box.w / 2;
    const cy = span.box.y + span.box.h / 2;
    const radius = Math.min(8, span.fontSize * 2.5);
    const twin = out.find((d) => d.itemId === match.tag && Math.hypot(d.box.x + d.box.w / 2 - cx, d.box.y + d.box.h / 2 - cy) < radius);
    if (twin) continue;
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
