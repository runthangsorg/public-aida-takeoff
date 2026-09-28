/**
 * Benchmark runner: `<dir>/set-NN/drawings/*.pdf` plus `<dir>/set-NN/ground_truth.json`.
 * Runs the engine on every drawing of every set and scores the totals.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { countDrawing, type CountOptions, type VisionPass } from '../engine.ts';
import type { TakeoffResult } from '../types.ts';
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
    if (set.drawings.length === 0) {
      scores.push(errorScore(set, 'no drawings', started));
      continue;
    }
    const vision = opts.makeVision ? await opts.makeVision() : undefined;
    const results: TakeoffResult[] = [];
    try {
      for (const pdf of set.drawings) {
        const result = await countDrawing(pdf, {
          ...(opts.countOptions ?? {}),
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
