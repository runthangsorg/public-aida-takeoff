/**
 * Scores engine output against a set's ground truth.
 *
 * Two pass rules are reported for every set:
 *
 * - strict: every ground-truth item is within ±5 % of its true count
 *   (|predicted − truth| ≤ 0.05 × truth, so items with fewer than 20
 *   instances must be exact; a true count of 0 must be predicted as 0).
 *   The headline "N of M sets" uses this rule.
 * - weighted: the sum of absolute errors across the set's items divided by
 *   the sum of true counts is ≤ 5 %. This is what a priced bill feels: a
 *   miss on a 3-off item matters less than a miss on a 300-off item.
 *
 * Items the engine reports that are not in the ground truth are listed as
 * extras and do not affect either rule.
 */
import { normalizeText } from '../pdf/text.ts';
import type { TakeoffResult, UsageRecord } from '../types.ts';

export const TOLERANCE = 0.05;

export interface GroundTruthFile {
  set?: string;
  description?: string;
  source?: string;
  units?: string;
  /** item key (tag or name) → true count */
  items: Record<string, number>;
  descriptions?: Record<string, string>;
  /**
   * Which engine items (legend tags or legend descriptions) make up each
   * ground-truth line, when the bill's wording differs from the legend's.
   * Several engine items may sum into one line. Identifying the symbol for a
   * bill line is allowed; the counts themselves must still come from the bill.
   */
  mapping?: Record<string, string[]>;
}

export interface ItemScore {
  key: string;
  description: string | null;
  truth: number;
  predicted: number;
  absError: number;
  /** null when truth is 0 */
  relError: number | null;
  within: boolean;
  /** false when no engine item could be matched to this key */
  matched: boolean;
  needsReview: number;
  source: string;
}

export interface SetScore {
  set: string;
  files: string[];
  items: ItemScore[];
  strictPass: boolean;
  weightedPass: boolean;
  weightedError: number;
  extraItems: { key: string; count: number }[];
  usage: UsageRecord;
  wallTimeMs: number;
  warnings: string[];
  error?: string;
}

export interface BenchSummary {
  sets: number;
  strictPassed: number;
  weightedPassed: number;
  failedToRun: number;
  headline: string;
  totalCostUsd: number;
  meanCostUsd: number;
  meanWallTimeMs: number;
  totalPromptTokens: number;
  totalOutputTokens: number;
  /** Model calls answered from the local cache; when > 0 the wall times are not representative. */
  cachedCalls: number;
}

export interface BenchReport {
  schemaVersion: 1;
  generatedAt: string;
  benchDir: string;
  tolerance: number;
  vision: boolean;
  sets: SetScore[];
  summary: BenchSummary;
}

export function isGroundTruth(x: unknown): x is GroundTruthFile {
  if (typeof x !== 'object' || x === null || !('items' in x)) return false;
  const items = x.items;
  return typeof items === 'object' && items !== null && !Array.isArray(items) && Object.values(items).every((v) => typeof v === 'number');
}

function sumUsage(results: readonly TakeoffResult[]): UsageRecord {
  const u: UsageRecord = { model: results[0]?.usage.model ?? 'none', calls: 0, cachedCalls: 0, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsd: 0 };
  for (const r of results) {
    u.calls += r.usage.calls;
    u.cachedCalls += r.usage.cachedCalls;
    u.promptTokens += r.usage.promptTokens;
    u.outputTokens += r.usage.outputTokens;
    u.thoughtTokens += r.usage.thoughtTokens;
    u.costUsd += r.usage.costUsd;
    if (r.usage.model !== 'none') u.model = r.usage.model;
  }
  return u;
}

/** Sums the engine's item counts across the drawings of a set, keyed by tag, id and description. */
function engineTotals(results: readonly TakeoffResult[]): Map<string, { count: number; needsReview: number; sources: Set<string>; description: string }> {
  const totals = new Map<string, { count: number; needsReview: number; sources: Set<string>; description: string }>();
  for (const r of results) {
    for (const it of r.items) {
      const key = normalizeText(it.tag ?? it.itemId);
      const cur = totals.get(key) ?? { count: 0, needsReview: 0, sources: new Set<string>(), description: it.description };
      cur.count += it.count;
      cur.needsReview += it.needsReview;
      cur.sources.add(it.source);
      totals.set(key, cur);
    }
  }
  return totals;
}

export function scoreSet(set: string, files: string[], truth: GroundTruthFile, results: readonly TakeoffResult[], wallTimeMs: number): SetScore {
  const totals = engineTotals(results);
  const byDescription = new Map<string, string>();
  for (const [key, v] of totals) byDescription.set(normalizeText(v.description), key);
  const used = new Set<string>();
  const items: ItemScore[] = [];
  for (const [rawKey, truthCount] of Object.entries(truth.items)) {
    const key = normalizeText(rawKey);
    const mapped = truth.mapping?.[rawKey];
    let matchKeys: string[] = [];
    if (mapped) {
      matchKeys = mapped.map((m) => normalizeText(m)).map((m) => (totals.has(m) ? m : byDescription.get(m))).filter((m): m is string => m !== undefined);
    } else {
      let matchKey: string | undefined = totals.has(key) ? key : undefined;
      if (matchKey === undefined) {
        const desc = truth.descriptions?.[rawKey];
        if (desc !== undefined) matchKey = byDescription.get(normalizeText(desc));
      }
      matchKey ??= byDescription.get(key);
      if (matchKey !== undefined) matchKeys = [matchKey];
    }
    const engines = matchKeys.map((k) => totals.get(k)).filter((e): e is NonNullable<typeof e> => e !== undefined);
    for (const k of matchKeys) used.add(k);
    const engine =
      engines.length === 0
        ? undefined
        : {
            count: engines.reduce((a, e) => a + e.count, 0),
            needsReview: engines.reduce((a, e) => a + e.needsReview, 0),
            sources: new Set(engines.flatMap((e) => [...e.sources])),
            description: engines.map((e) => e.description).join(' + '),
          };
    const predicted = engine?.count ?? 0;
    const absError = Math.abs(predicted - truthCount);
    const relError = truthCount === 0 ? null : absError / truthCount;
    const within = truthCount === 0 ? predicted === 0 : absError <= TOLERANCE * truthCount + 1e-9;
    items.push({
      key: rawKey,
      description: truth.descriptions?.[rawKey] ?? engine?.description ?? null,
      truth: truthCount,
      predicted,
      absError,
      relError,
      within,
      matched: engine !== undefined,
      needsReview: engine?.needsReview ?? 0,
      source: engine ? [...engine.sources].join('+') : 'none',
    });
  }
  const extraItems = [...totals.entries()].filter(([k, v]) => !used.has(k) && v.count > 0).map(([k, v]) => ({ key: k, count: v.count }));
  const truthTotal = items.reduce((a, i) => a + i.truth, 0);
  const errorTotal = items.reduce((a, i) => a + i.absError, 0);
  const weightedError = truthTotal === 0 ? (errorTotal === 0 ? 0 : 1) : errorTotal / truthTotal;
  return {
    set,
    files,
    items,
    strictPass: items.length > 0 && items.every((i) => i.within),
    weightedPass: items.length > 0 && weightedError <= TOLERANCE + 1e-9,
    weightedError,
    extraItems,
    usage: sumUsage(results),
    wallTimeMs,
    warnings: results.flatMap((r) => r.warnings.map((w) => `${r.file}: ${w}`)),
  };
}

export function summarise(sets: readonly SetScore[]): BenchSummary {
  const ran = sets.filter((s) => s.error === undefined);
  const strictPassed = ran.filter((s) => s.strictPass).length;
  const weightedPassed = ran.filter((s) => s.weightedPass).length;
  const totalCostUsd = sets.reduce((a, s) => a + s.usage.costUsd, 0);
  return {
    sets: sets.length,
    strictPassed,
    weightedPassed,
    failedToRun: sets.length - ran.length,
    headline: `${strictPassed} of ${sets.length} sets within ±${TOLERANCE * 100}% on every item (${weightedPassed} of ${sets.length} on quantity-weighted error)`,
    totalCostUsd,
    meanCostUsd: sets.length === 0 ? 0 : totalCostUsd / sets.length,
    meanWallTimeMs: sets.length === 0 ? 0 : sets.reduce((a, s) => a + s.wallTimeMs, 0) / sets.length,
    totalPromptTokens: sets.reduce((a, s) => a + s.usage.promptTokens, 0),
    totalOutputTokens: sets.reduce((a, s) => a + s.usage.outputTokens + s.usage.thoughtTokens, 0),
    cachedCalls: sets.reduce((a, s) => a + s.usage.cachedCalls, 0),
  };
}

/** A fixed-width text table of the report for the terminal. */
export function formatReport(report: BenchReport): string {
  const lines: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (n: number, w: number) => String(n).padStart(w);
  for (const s of report.sets) {
    if (s.error !== undefined) {
      lines.push(`${pad(s.set, 10)} ERROR ${s.error}`);
      continue;
    }
    const worst = [...s.items].sort((a, b) => (b.relError ?? (b.absError > 0 ? 9 : 0)) - (a.relError ?? (a.absError > 0 ? 9 : 0)))[0];
    const worstText = worst ? `${worst.key} ${worst.predicted}/${worst.truth}${worst.relError === null ? '' : ` (${(worst.relError * 100).toFixed(1)}%)`}` : '-';
    lines.push(
      `${pad(s.set, 10)} ${s.strictPass ? 'PASS' : 'FAIL'} strict  ${s.weightedPass ? 'PASS' : 'FAIL'} weighted ${(s.weightedError * 100).toFixed(1).padStart(5)}%  items ${num(s.items.filter((i) => i.within).length, 3)}/${num(s.items.length, 3)}  worst ${pad(worstText, 24)} $${s.usage.costUsd.toFixed(3)}  ${(s.wallTimeMs / 1000).toFixed(1)}s`,
    );
    for (const i of s.items) {
      if (!i.within) lines.push(`             ${pad(i.key, 8)} ${num(i.predicted, 5)} / ${num(i.truth, 5)}  ${i.matched ? i.source : 'not found'}`);
    }
    if (s.extraItems.length > 0) lines.push(`             extra: ${s.extraItems.map((e) => `${e.key}=${e.count}`).join(', ')}`);
  }
  const m = report.summary;
  lines.push('');
  lines.push(m.headline);
  lines.push(`cost: $${m.totalCostUsd.toFixed(3)} total, $${m.meanCostUsd.toFixed(3)} per set; ${m.totalPromptTokens} in / ${m.totalOutputTokens} out tokens; ${(m.meanWallTimeMs / 1000).toFixed(1)} s per set`);
  if (m.cachedCalls > 0) lines.push(`note: ${m.cachedCalls} model call(s) were answered from the local cache, so wall times understate a fresh run`);
  return lines.join('\n');
}
