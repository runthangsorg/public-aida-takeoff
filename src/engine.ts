/**
 * The takeoff engine: reads a drawing PDF, finds the legend, counts tagged
 * instances exactly from vector text, and (when enabled) asks the vision
 * pass to find the untagged symbols. Counting always happens in code.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { extractText } from './pdf/text.ts';
import type { Box, Detection, ItemCount, Legend, LegendItem, PageResult, TakeoffResult, UsageRecord } from './types.ts';
import { findLegend } from './vector/legend.ts';
import { countTags } from './vector/tags.ts';
import { findNotesBox, readTitleBlock } from './vector/titleblock.ts';

export type LegendMode = 'auto' | 'vector' | 'vision' | { file: string };

export interface VisionPass {
  /** Finds instances of `items` on the given pages. Legend boxes let it crop a reference image. */
  detect: (args: {
    pdfPath: string;
    pages: { page: number; width: number; height: number; exclude: Box[] }[];
    items: LegendItem[];
    legendCrops: { page: number; box: Box }[];
  }) => Promise<Detection[]>;
  /** Finds a legend by looking at the page when the text has none. */
  findLegend?: (args: { pdfPath: string; page: number; width: number; height: number }) => Promise<Legend | null>;
  usage: () => UsageRecord;
}

export interface CountOptions {
  legend?: LegendMode;
  /** Vision pass to use for untagged symbols; omit for a vector-only run. */
  vision?: VisionPass | undefined;
  /** Always run vision for tagged items too and report disagreements. */
  crossCheck?: boolean;
  log?: ((message: string) => void) | undefined;
}

export function emptyUsage(model = 'none'): UsageRecord {
  return { model, calls: 0, cachedCalls: 0, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsd: 0 };
}

/** Merges per-page legends into one item list keyed by tag (or description when untagged). */
export function mergeLegends(legends: readonly Legend[]): LegendItem[] {
  const byKey = new Map<string, LegendItem>();
  for (const legend of legends) {
    for (const item of legend.items) {
      const key = item.tag ?? `desc:${item.description}`;
      if (!byKey.has(key)) byKey.set(key, item);
    }
  }
  // Untagged items get sequential ids so they stay unique across pages.
  let n = 0;
  return [...byKey.values()].map((item) => (item.tag ? item : { ...item, id: `L${++n}` }));
}

async function loadLegendFile(file: string): Promise<Legend> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null || !('items' in raw) || !Array.isArray(raw.items)) {
    throw new Error(`legend file ${file} must be { items: [{ tag, description }] }`);
  }
  const items = ((raw as { items: unknown[] }).items as { tag?: string | null; description?: string }[]).map((it, i) => {
    const tag = it.tag ? it.tag.toUpperCase().trim() : null;
    return { id: tag ?? `L${i + 1}`, tag, description: it.description ?? '', box: { x: 0, y: 0, w: 0, h: 0 }, page: 0 };
  });
  return { page: 0, box: { x: 0, y: 0, w: 0, h: 0 }, items, source: 'file' };
}

export async function countDrawing(pdfPath: string, opts: CountOptions = {}): Promise<TakeoffResult> {
  const started = Date.now();
  const log = opts.log ?? (() => undefined);
  const warnings: string[] = [];
  const legendMode = opts.legend ?? 'auto';

  const pages = await extractText(pdfPath);
  log(`read ${pages.length} page(s), ${pages.reduce((a, p) => a + p.spans.length, 0)} text spans`);

  // Legends printed on the sheets are always located: even when the item list
  // comes from a file, their text must not be counted as instances.
  const pageLegends: Legend[] = [];
  if (legendMode !== 'vision') {
    for (const p of pages) {
      const l = findLegend(p);
      if (l) pageLegends.push(l);
    }
  }
  // Item list: from a file, from the sheets, or from vision.
  const legends: Legend[] = typeof legendMode === 'object' ? [await loadLegendFile(legendMode.file)] : [...pageLegends];
  if (legends.length === 0 && legendMode !== 'vector' && opts.vision?.findLegend) {
    for (const p of pages) {
      const l = await opts.vision.findLegend({ pdfPath, page: p.page, width: p.width, height: p.height });
      if (l) {
        legends.push(l);
        pageLegends.push(l);
        break;
      }
    }
  }
  const items = mergeLegends(legends);
  if (items.length === 0) warnings.push('no legend found; nothing to count');
  log(`legend: ${items.length} item(s) from ${legends.length} page(s)`);

  // Page structure and vector counts.
  const tags = new Set(items.flatMap((i) => (i.tag ? [i.tag] : [])));
  const pageResults: PageResult[] = [];
  const exclusions = new Map<number, Box[]>();
  for (const p of pages) {
    const titleBlock = readTitleBlock(p);
    const notes = findNotesBox(p);
    const exclude: Box[] = [];
    for (const l of pageLegends) if (l.page === p.page) exclude.push(l.box);
    if (titleBlock.box) exclude.push(titleBlock.box);
    if (notes) exclude.push(notes);
    exclusions.set(p.page, exclude);
    const detections = countTags(p, tags, exclude);
    pageResults.push({ page: p.page, width: p.width, height: p.height, titleBlock, detections });
  }

  // Which items still need vision: untagged rows, and tagged rows with no instance anywhere.
  const vectorHits = new Map<string, number>();
  for (const pr of pageResults) for (const d of pr.detections) vectorHits.set(d.itemId, (vectorHits.get(d.itemId) ?? 0) + d.multiplier);
  const visionItems = items.filter((i) => opts.crossCheck === true || i.tag === null || !vectorHits.has(i.tag));
  if (visionItems.length > 0 && opts.vision) {
    log(`vision: ${visionItems.length} item(s) to find: ${visionItems.map((i) => i.id).join(', ')}`);
    const detections = await opts.vision.detect({
      pdfPath,
      pages: pageResults.map((pr) => ({ page: pr.page, width: pr.width, height: pr.height, exclude: exclusions.get(pr.page) ?? [] })),
      items: visionItems,
      legendCrops: pageLegends.map((l) => ({ page: l.page, box: l.box })),
    });
    for (const d of detections) {
      const pr = pageResults.find((x) => x.page === d.page);
      if (!pr) continue;
      const item = items.find((i) => i.id === d.itemId);
      // Vector counts are authoritative for tagged items; vision only fills the rest unless cross-checking.
      if (item?.tag && vectorHits.has(item.tag)) {
        if (!opts.crossCheck) continue;
      }
      pr.detections.push(d);
    }
  } else if (visionItems.length > 0) {
    warnings.push(`vision disabled: ${visionItems.length} item(s) have no tagged instances (${visionItems.map((i) => i.id).join(', ')})`);
  }

  // Cross-check: report disagreements between vector and vision counts.
  if (opts.crossCheck) {
    for (const item of items) {
      if (!item.tag) continue;
      let vec = 0;
      let vis = 0;
      for (const pr of pageResults) {
        for (const d of pr.detections) {
          if (d.itemId !== item.id) continue;
          if (d.source === 'vector') vec += d.multiplier;
          else vis += d.multiplier;
        }
      }
      if (vec > 0 && vis > 0 && Math.abs(vec - vis) > Math.max(1, 0.05 * vec)) {
        warnings.push(`${item.id}: vector count ${vec} and vision count ${vis} disagree`);
      }
    }
  }

  const counts = aggregate(items, pageResults, opts.crossCheck === true);
  const usage = opts.vision ? opts.vision.usage() : emptyUsage();
  return {
    schemaVersion: 1,
    file: basename(pdfPath),
    generatedAt: new Date().toISOString(),
    legend: legends[0] ? { ...legends[0], items } : null,
    pages: pageResults,
    items: counts,
    usage,
    wallTimeMs: Date.now() - started,
    warnings,
  };
}

/** Sums detections per item and page. With cross-checking, vector wins where it exists. */
export function aggregate(items: readonly LegendItem[], pages: readonly PageResult[], crossCheck: boolean): ItemCount[] {
  return items.map((item) => {
    const perPage: Record<string, number> = {};
    let count = 0;
    let needsReview = 0;
    const sources = new Set<Detection['source']>();
    const hasVector = pages.some((p) => p.detections.some((d) => d.itemId === item.id && d.source === 'vector'));
    for (const p of pages) {
      for (const d of p.detections) {
        if (d.itemId !== item.id) continue;
        if (crossCheck && hasVector && d.source !== 'vector') continue;
        sources.add(d.source);
        count += d.multiplier;
        perPage[String(p.page)] = (perPage[String(p.page)] ?? 0) + d.multiplier;
        if (d.needsReview) needsReview += 1;
      }
    }
    const source: ItemCount['source'] = sources.size === 0 ? 'none' : sources.size > 1 ? 'mixed' : ([...sources][0] ?? 'none');
    return { itemId: item.id, tag: item.tag, description: item.description, count, needsReview, source, perPage };
  });
}
