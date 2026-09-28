#!/usr/bin/env node
/**
 * aida-takeoff command line.
 *
 *   aida-takeoff count <drawing.pdf> [--legend auto] [--out result.json] [--no-vision]
 *   aida-takeoff bench <dir> [--no-vision] [--json report.json]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { countDrawing, type LegendMode } from './engine.ts';
import { VERSION } from './index.ts';

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
    for (const it of result.items) {
      console.log(`${(it.tag ?? it.itemId).padEnd(6)} ${String(it.count).padStart(5)}  ${it.source.padEnd(6)} ${it.needsReview > 0 ? `review:${it.needsReview} ` : ''}${it.description}`);
    }
    for (const w of result.warnings) console.error(`[aida] warning: ${w}`);
    console.error(`[aida] wrote ${o.out}; ${result.usage.calls} model call(s), $${result.usage.costUsd.toFixed(4)}, ${result.wallTimeMs} ms`);
  });

interface CountFlags {
  legend: string;
  out: string;
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`[aida] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
