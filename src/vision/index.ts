/**
 * The vision pass: renders pages, tiles them, asks Gemini on Vertex AI for
 * symbol detections against the legend, de-duplicates and verifies in code.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { VisionPass } from '../engine.ts';
import { centerInside, roundBox, scaleBox } from '../geometry.ts';
import { renderPage, type Renderer } from '../pdf/render.ts';
import type { Box, Detection } from '../types.ts';
import { detectTile } from './detect.ts';
import { findLegendByVision } from './legend.ts';
import { cropPng, dedupe, inkFraction, loadPageImage, makeTiles, type PageImage } from './tiles.ts';
import { verifyLowConfidence } from './verify.ts';
import { VertexClient, type VertexClientOptions } from './vertex.ts';

export type MediaResolution = 'MEDIA_RESOLUTION_LOW' | 'MEDIA_RESOLUTION_MEDIUM' | 'MEDIA_RESOLUTION_HIGH';

export interface VisionOptions {
  log?: ((message: string) => void) | undefined;
  model?: string | undefined;
  dpi?: number | undefined;
  tile?: number | undefined;
  overlap?: number | undefined;
  concurrency?: number | undefined;
  maxSpendUsd?: number | undefined;
  workDir?: string | undefined;
  renderer?: Renderer | undefined;
  /** Skip the second-look verification pass. */
  verify?: boolean | undefined;
  verifyThreshold?: number | undefined;
  mediaResolution?: MediaResolution | undefined;
  /** Injected client, for tests. */
  client?: VertexClient | undefined;
  clientOptions?: VertexClientOptions | undefined;
}

export interface VisionSettings {
  dpi: number;
  tile: number;
  overlap: number;
  concurrency: number;
  verify: boolean;
  verifyThreshold: number;
  mediaResolution: MediaResolution | undefined;
}

export const defaultSettings: VisionSettings = {
  dpi: 200,
  tile: 1024,
  overlap: 160,
  concurrency: 4,
  verify: true,
  verifyThreshold: 0.75,
  mediaResolution: 'MEDIA_RESOLUTION_HIGH',
};

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      results[i] = await fn(item, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function createVisionPass(opts: VisionOptions = {}): Promise<VisionPass> {
  const log = opts.log ?? (() => undefined);
  const settings: VisionSettings = {
    dpi: opts.dpi ?? defaultSettings.dpi,
    tile: opts.tile ?? defaultSettings.tile,
    overlap: opts.overlap ?? defaultSettings.overlap,
    concurrency: opts.concurrency ?? defaultSettings.concurrency,
    verify: opts.verify ?? defaultSettings.verify,
    verifyThreshold: opts.verifyThreshold ?? defaultSettings.verifyThreshold,
    mediaResolution: opts.mediaResolution ?? defaultSettings.mediaResolution,
  };
  const client =
    opts.client ??
    new VertexClient({
      ...(opts.clientOptions ?? {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.maxSpendUsd !== undefined ? { maxSpendUsd: opts.maxSpendUsd } : {}),
      log,
    });
  const workDir = opts.workDir ?? join(process.cwd(), '.tmp', 'render');

  const renderCache = new Map<string, Promise<{ image: PageImage; scale: number }>>();
  const render = (pdfPath: string, page: number): Promise<{ image: PageImage; scale: number }> => {
    const key = `${pdfPath}#${page}`;
    let p = renderCache.get(key);
    if (!p) {
      p = (async () => {
        const outDir = join(workDir, safeName(pdfPath));
        await mkdir(outDir, { recursive: true });
        const r = await renderPage(pdfPath, page, { dpi: settings.dpi, outDir, renderer: opts.renderer });
        const image = await loadPageImage(r.path);
        return { image, scale: r.scale };
      })();
      renderCache.set(key, p);
    }
    return p;
  };

  const pass: VisionPass = {
    usage: () => client.usage(),

    findLegend: async ({ pdfPath, page }) => {
      const { image, scale } = await render(pdfPath, page);
      const legend = await findLegendByVision(client, image, page, scale);
      if (legend) log(`page ${page}: vision found a legend with ${legend.items.length} row(s)`);
      return legend;
    },

    detect: async ({ pdfPath, pages, items, legendCrops }) => {
      const all: Detection[] = [];
      // Legend reference image: the first legend crop, rendered at working resolution.
      let legendPng: Buffer | null = null;
      const crop = legendCrops[0];
      if (crop) {
        const { image, scale } = await render(pdfPath, crop.page);
        legendPng = cropPng(image, scaleBox(crop.box, scale));
      }
      for (const p of pages) {
        const { image, scale } = await render(pdfPath, p.page);
        const tiles = makeTiles(image, { tile: settings.tile, overlap: settings.overlap });
        const busy = tiles.filter((t) => inkFraction(image, t) > 0.0005);
        log(`page ${p.page}: ${image.width}x${image.height}px, ${tiles.length} tile(s), ${busy.length} with ink`);
        const perTile = await mapLimit(busy, settings.concurrency, (tile, tileIndex) =>
          detectTile({ client, items, legendPng, tile, tileIndex, page: p.page, scale, mediaResolution: settings.mediaResolution }),
        );
        const raw = perTile.flat();
        const inside = raw.filter((d) => !p.exclude.some((b: Box) => centerInside(b, d.box)));
        let detections = dedupe(inside);
        log(`page ${p.page}: ${raw.length} raw detection(s), ${raw.length - inside.length} in excluded regions, ${detections.length} after de-duplication`);
        if (settings.verify) {
          detections = await verifyLowConfidence({
            client,
            items,
            legendPng,
            page: p.page,
            image,
            scale,
            detections,
            opts: { threshold: settings.verifyThreshold, batchSize: 12, contextPt: 60 },
            log,
          });
        }
        for (const d of detections) {
          d.box = roundBox(d.box);
          d.confidence = Math.round(d.confidence * 100) / 100;
        }
        all.push(...detections);
        const u = client.usage();
        log(`usage so far: ${u.calls} call(s), ${u.promptTokens} in / ${u.outputTokens + u.thoughtTokens} out tokens, $${u.costUsd.toFixed(4)}`);
      }
      return all;
    },
  };
  return Promise.resolve(pass);
}

function safeName(path: string): string {
  return path.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
}
