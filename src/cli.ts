#!/usr/bin/env node
/**
 * aida-takeoff command line.
 *
 *   aida-takeoff count <drawing.pdf> [--legend auto] [--out result.json] [--xlsx bill.xlsx] [--overlay marked.pdf] [--no-vision]
 *   aida-takeoff bench <dir> [--no-vision] [--json report.json] [--only set-01,set-02]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { runBench } from './bench/bench.ts';
import { formatReport } from './bench/scoring.ts';
import { countDrawing, type LegendMode } from './engine.ts';
import { VERSION } from './index.ts';
import { writeBill } from './output/excel.ts';
import { writeOverlay } from './output/overlay.ts';

function parseLegend(value: string): LegendMode {
  if (value === 'auto' || value === 'vector' || value === 'vision') return value;
  return { file: resolve(value) };
}

const program = new Command();
program.name('aida-takeoff').description('Tender PDF drawings in; MEP quantities and a bill of quantities out.').version(VERSION);

program
  .command('count')
  .description('count legend items on one drawing PDF')
  .argument('<pdf>', 'drawing PDF')
  .option('--legend <mode>', 'auto | vector | vision | <legend.json>', 'auto')
  .option('--out <file>', 'result JSON path', 'result.json')
  .option('--xlsx <file>', 'also write an Excel bill of quantities')
  .option('--overlay <file>', 'also write the drawing with every detection marked up')
  .option('--no-vision', 'skip the vision pass (vector text only)')
  .option('--cross-check', 'run vision for tagged items too and report disagreements')
  .option('--no-verify', 'skip the second-look verification of low-confidence detections')
  .option('--dpi <n>', 'render resolution for the vision pass', '200')
  .option('--tile <px>', 'tile size in pixels', '1024')
  .option('--model <name>', 'Vertex AI model id (default gemini-3.8-flash or $AIDA_MODEL)')
  .option('--max-spend <usd>', 'abort once model spend passes this (default $AIDA_MAX_SPEND_USD or 2)')
  .option('--quiet', 'no progress on stderr')
  .action(async (pdf: string, o: CountFlags) => {
    const log = o.quiet
      ? undefined
      : (m: string) => {
          console.error(`[aida] ${m}`);
        };
    const vision = o.vision ? await loadVision(o, log) : undefined;
    const result = await countDrawing(resolve(pdf), { legend: parseLegend(o.legend), vision, crossCheck: o.crossCheck === true, log });
    await mkdir(dirname(resolve(o.out)), { recursive: true });
    await writeFile(resolve(o.out), JSON.stringify(result, null, 2) + '\n');
    if (o.xlsx) {
      await mkdir(dirname(resolve(o.xlsx)), { recursive: true });
      await writeBill([result], resolve(o.xlsx));
      log?.(`wrote ${o.xlsx}`);
    }
    if (o.overlay) {
      await mkdir(dirname(resolve(o.overlay)), { recursive: true });
      await writeOverlay(result, resolve(pdf), resolve(o.overlay));
      log?.(`wrote ${o.overlay}`);
    }
    for (const it of result.items) {
      console.log(`${(it.tag ?? it.itemId).padEnd(6)} ${String(it.count).padStart(5)}  ${it.source.padEnd(6)} ${it.needsReview > 0 ? `review:${it.needsReview} ` : ''}${it.description}`);
    }
    for (const w of result.warnings) console.error(`[aida] warning: ${w}`);
    console.error(`[aida] wrote ${o.out}; ${result.usage.calls} model call(s), $${result.usage.costUsd.toFixed(4)}, ${result.wallTimeMs} ms`);
  });

interface CountFlags {
  legend: string;
  out: string;
  xlsx?: string;
  overlay?: string;
  vision: boolean;
  verify: boolean;
  crossCheck?: boolean;
  dpi: string;
  tile: string;
  model?: string;
  maxSpend?: string;
  quiet?: boolean;
}

async function loadVision(o: { verify: boolean; dpi: string; tile: string; model?: string; maxSpend?: string }, log?: (m: string) => void) {
  const mod = await import('./vision/index.ts');
  return mod.createVisionPass({
    log,
    verify: o.verify,
    dpi: Number(o.dpi),
    tile: Number(o.tile),
    model: o.model,
    maxSpendUsd: o.maxSpend === undefined ? undefined : Number(o.maxSpend),
  });
}

program
  .command('bench')
  .description('run the engine over <dir>/set-NN/drawings/*.pdf and score against set-NN/ground_truth.json')
  .argument('<dir>', 'benchmark folder')
  .option('--json <file>', 'write the full report as JSON')
  .option('--out-dir <dir>', 'write each drawing\'s result.json under <dir>/<set>/')
  .option('--only <sets>', 'comma-separated set names to run')
  .option('--no-vision', 'vector text only')
  .option('--no-verify', 'skip the second-look verification')
  .option('--dpi <n>', 'render resolution for the vision pass', '200')
  .option('--tile <px>', 'tile size in pixels', '1024')
  .option('--model <name>', 'Vertex AI model id')
  .option('--max-spend <usd>', 'abort a set once model spend passes this')
  .option('--quiet', 'no progress on stderr')
  .action(async (dir: string, o: BenchFlags) => {
    const log = o.quiet
      ? undefined
      : (m: string) => {
          console.error(`[bench] ${m}`);
        };
    const report = await runBench(resolve(dir), {
      makeVision: o.vision ? () => loadVision(o, log) : undefined,
      only: o.only ? o.only.split(',').map((s) => s.trim()) : undefined,
      outDir: o.outDir ? resolve(o.outDir) : undefined,
      log,
    });
    if (o.json) {
      await mkdir(dirname(resolve(o.json)), { recursive: true });
      await writeFile(resolve(o.json), JSON.stringify(report, null, 2) + '\n');
    }
    console.log(formatReport(report));
    if (report.summary.failedToRun > 0) process.exitCode = 2;
  });

interface BenchFlags {
  json?: string;
  outDir?: string;
  only?: string;
  vision: boolean;
  verify: boolean;
  dpi: string;
  tile: string;
  model?: string;
  maxSpend?: string;
  quiet?: boolean;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`[aida] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
