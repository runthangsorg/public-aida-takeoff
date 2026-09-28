/**
 * Benchmark runner: `<dir>/set-NN/drawings/*.pdf` plus `<dir>/set-NN/ground_truth.json`.
 * Runs the engine on every drawing of every set and scores the totals.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { countDrawing, mergeLegends, structuralBoxes, type CountOptions, type VisionPass } from '../engine.ts';
import { extractText } from '../pdf/text.ts';
import type { Legend, TakeoffResult } from '../types.ts';
import { findLegends } from '../vector/legend.ts';
import { extractPaths } from '../vector/paths.ts';
import { attachSignatures } from '../vector/symbols.ts';
import { isGroundTruth, scoreSet, summarise, type BenchReport, type SetScore } from './scoring.ts';

export interface BenchOptions {
  /** Creates a fresh vision pass per set so usage is attributed per set; omit for vector-only. */
  makeVision?: (() => Promise<VisionPass>) | undefined;
  /** Only run these set names. */
  only?: string[] | undefined;
  /** Write each drawing's result.json here, under <set>/. */
  outDir?: string | undefined;
  log?: ((message: string) => void) | undefined;
  countOptions?: Omit<CountOptions, 'vision' | 'log'> | undefined;
}

export interface BenchSet {
  name: string;
  dir: string;
  drawings: string[];
  groundTruth: string;
}

export async function discoverSets(benchDir: string): Promise<BenchSet[]> {
  const entries = await readdir(benchDir, { withFileTypes: true });
  const sets: BenchSet[] = [];
  for (const e of entries.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(benchDir, e.name);
    const groundTruth = join(dir, 'ground_truth.json');
    try {
      await stat(groundTruth);
    } catch {
      continue;
    }
    const drawings = await readdir(join(dir, 'drawings'))
      .then((files) => files.filter((f) => f.toLowerCase().endsWith('.pdf')).sort().map((f) => join(dir, 'drawings', f)))
      .catch(() => [] as string[]);
    sets.push({ name: e.name, dir, drawings, groundTruth });
  }
  return sets;
}

export async function runBench(benchDir: string, opts: BenchOptions = {}): Promise<BenchReport> {
  const log = opts.log ?? (() => undefined);
  let sets = await discoverSets(benchDir);
  if (opts.only && opts.only.length > 0) sets = sets.filter((s) => opts.only?.includes(s.name));
  if (sets.length === 0) throw new Error(`no benchmark sets found under ${benchDir} (expected set-NN/drawings/*.pdf and set-NN/ground_truth.json)`);
  const scores: SetScore[] = [];
  for (const set of sets) {
    const started = Date.now();
    log(`${set.name}: ${set.drawings.length} drawing(s)`);
    let truthRaw: unknown;
    try {
      truthRaw = JSON.parse(await readFile(set.groundTruth, 'utf8'));
    } catch (err) {
      scores.push(errorScore(set, `ground truth unreadable: ${err instanceof Error ? err.message : String(err)}`, started));
      continue;
    }
    if (!isGroundTruth(truthRaw)) {
      scores.push(errorScore(set, 'ground truth must be { items: { "<tag>": <count> } }', started));
      continue;
    }
    // A sibling mapping.json (bill line -> legend tags/descriptions) may sit next to the ground truth,
    // so the bill's counts stay untouched while the symbol identification is added separately.
    try {
      const extra = JSON.parse(await readFile(join(set.dir, 'mapping.json'), 'utf8')) as unknown;
      if (typeof extra === 'object' && extra !== null && !Array.isArray(extra)) {
        truthRaw.mapping = { ...(truthRaw.mapping ?? {}), ...(extra as Record<string, string[]>) };
        log(`${set.name}: mapping.json adds ${Object.keys(extra).length} line(s)`);
      }
    } catch {
      // no mapping file
    }
    if (set.drawings.length === 0) {
      scores.push(errorScore(set, 'no drawings', started));
      continue;
    }
    const vision = opts.makeVision ? await opts.makeVision() : undefined;
    const results: TakeoffResult[] = [];
    try {
      // A set's legend is often a separate sheet or file: read every drawing's
      // vector legend first and share the merged list with drawings lacking one.
      const shared = await sharedLegend(set.drawings);
      if (shared) log(`${set.name}: shared legend with ${shared.legend.items.length} item(s) from ${shared.files.join(', ')}`);
      for (const pdf of set.drawings) {
        const own = shared?.perFile.get(pdf) ?? false;
        const legendOpt: CountOptions['legend'] = own || !shared ? (opts.countOptions?.legend ?? 'auto') : { legend: shared.legend };
        const result = await countDrawing(pdf, {
          ...(opts.countOptions ?? {}),
          legend: legendOpt,
          vision,
          log: (m) => {
            log(`${set.name}/${result_name(pdf)}: ${m}`);
          },
        });
        results.push(result);
        if (opts.outDir) {
          const dir = join(opts.outDir, set.name);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, `${result_name(pdf)}.result.json`), JSON.stringify(result, null, 2) + '\n');
        }
      }
    } catch (err) {
      scores.push(errorScore(set, err instanceof Error ? err.message : String(err), started));
      continue;
    }
    // Usage is cumulative on the pass; attribute it once per set rather than once per drawing.
    if (vision) {
      const total = vision.usage();
      for (const r of results) r.usage = { ...total, calls: 0, cachedCalls: 0, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsd: 0 };
      const last = results[results.length - 1];
      if (last) last.usage = total;
    }
    const score = scoreSet(set.name, set.drawings.map((d) => result_name(d)), truthRaw, results, Date.now() - started);
    log(`${set.name}: ${score.strictPass ? 'PASS' : 'FAIL'} (weighted error ${(score.weightedError * 100).toFixed(1)}%), $${score.usage.costUsd.toFixed(3)}`);
    scores.push(score);
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    benchDir,
    tolerance: 0.05,
    vision: opts.makeVision !== undefined,
    sets: scores,
    summary: summarise(scores),
  };
}

interface SharedLegend {
  legend: Legend;
  files: string[];
  perFile: Map<string, boolean>;
}

async function sharedLegend(drawings: readonly string[]): Promise<SharedLegend | null> {
  const legends: Legend[] = [];
  const files: string[] = [];
  const perFile = new Map<string, boolean>();
  for (const pdf of drawings) {
    let found = false;
    const fileLegends: Legend[] = [];
    for (const page of await extractText(pdf)) {
      const ls = findLegends(page, structuralBoxes(page));
      if (ls.length > 0) {
        fileLegends.push(...ls);
        found = true;
      }
    }
    if (fileLegends.length > 0) {
      // Glyph signatures travel with the shared legend so other files can match symbols against them.
      const paths = await extractPaths(pdf, [...new Set(fileLegends.map((l) => l.page))]);
      for (const l of fileLegends) {
        const pp = paths.find((x) => x.page === l.page);
        if (pp) attachSignatures(l.items, pp.paths);
      }
      legends.push(...fileLegends);
    }
    perFile.set(pdf, found);
    if (found) files.push(result_name(pdf));
  }
  if (legends.length === 0) return null;
  const items = mergeLegends(legends);
  return { legend: { page: 0, box: { x: 0, y: 0, w: 0, h: 0 }, items, source: 'vector' }, files, perFile };
}

function result_name(pdf: string): string {
  return pdf.split('/').pop() ?? pdf;
}

function errorScore(set: BenchSet, error: string, started: number): SetScore {
  return {
    set: set.name,
    files: set.drawings.map((d) => result_name(d)),
    items: [],
    strictPass: false,
    weightedPass: false,
    weightedError: 1,
    extraItems: [],
    usage: { model: 'none', calls: 0, cachedCalls: 0, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsd: 0 },
    wallTimeMs: Date.now() - started,
    warnings: [],
    error,
  };
}
