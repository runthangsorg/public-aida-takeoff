/**
 * The takeoff engine: reads a drawing PDF, finds the legend, counts tagged
 * instances exactly from vector text, and (when enabled) asks the vision
 * pass to find the untagged symbols. Counting always happens in code.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { extractText } from './pdf/text.ts';
import type { Box, Detection, ItemCount, Legend, LegendItem, PageResult, PageText, TakeoffResult, UsageRecord } from './types.ts';
import { findLegends } from './vector/legend.ts';
import { extractPaths, type PagePaths } from './vector/paths.ts';
import { attachSignatures, matchSymbols } from './vector/symbols.ts';
import { countTags } from './vector/tags.ts';
import { findNotesBox, readTitleBlock } from './vector/titleblock.ts';

export type LegendMode = 'auto' | 'vector' | 'vision' | { file: string } | { legend: Legend };

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

/**
 * When the vision pass runs for an item:
 * - never: vector text and vector symbols only;
 * - auto: items with no tag and no symbol match, when the sheet is raster or the
 *   symbol's anchor shape was seen but the cluster never matched (a block drawn differently);
 * - always: every item without a tag or symbol count.
 */
export type VisionFallback = 'never' | 'auto' | 'always';

export interface CountOptions {
  legend?: LegendMode;
  /** Vision pass to use for untagged symbols; omit for a vector-only run. */
  vision?: VisionPass | undefined;
  visionFallback?: VisionFallback | undefined;
  /** Skip vector symbol matching (tags and vision only). */
  symbols?: boolean | undefined;
  /** Always run vision for tagged items too and report disagreements. */
  crossCheck?: boolean;
  log?: ((message: string) => void) | undefined;
}

/** Fewer painted paths than this on a sheet means it is a scan or an image, not CAD vectors. */
export const RASTER_PATH_THRESHOLD = 50;

/** Title block and notes regions: legend headings inside them are sheet metadata, not legends. */
export function structuralBoxes(p: PageText): Box[] {
  const boxes: Box[] = [];
  const tb = readTitleBlock(p).box;
  if (tb) boxes.push(tb);
  const notes = findNotesBox(p);
  if (notes) boxes.push(notes);
  return boxes;
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
    for (const p of pages) pageLegends.push(...findLegends(p, structuralBoxes(p)));
  }
  // Item list: from a file, from the sheets, or from vision.
  let legends: Legend[];
  if (typeof legendMode === 'object') {
    legends = ['file' in legendMode ? await loadLegendFile(legendMode.file) : legendMode.legend];
  } else {
    legends = [...pageLegends];
  }
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

  // Vector geometry: every painted path, for glyph signatures and symbol matching.
  const useSymbols = opts.symbols !== false && items.length > 0;
  let pagePaths: PagePaths[] = [];
  if (useSymbols) {
    pagePaths = await extractPaths(pdfPath);
    for (const l of pageLegends) {
      const pp = pagePaths.find((x) => x.page === l.page);
      if (pp) attachSignatures(l.items, pp.paths);
    }
    // Merged items share objects with pageLegends, so their signatures are set; a shared legend from
    // another file carries the signatures it was built with.
    log(`paths: ${pagePaths.reduce((a, p) => a + p.paths.length, 0)} on ${pagePaths.length} page(s); ${items.filter((i) => i.signature).length} legend glyph(s) with a signature`);
  }

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

  // Tag hits are authoritative; symbol matching covers the rest.
  const vectorHits = new Map<string, number>();
  for (const pr of pageResults) for (const d of pr.detections) vectorHits.set(d.itemId, (vectorHits.get(d.itemId) ?? 0) + d.multiplier);
  let symbolStats: TakeoffResult['symbols'];
  const symbolHits = new Map<string, number>();
  const anchorSeen = new Map<string, number>();
  if (useSymbols) {
    const symbolItems = items.filter((i) => i.signature && (opts.crossCheck === true || !vectorHits.has(i.id)));
    if (symbolItems.length > 0) {
      const { detections, stats } = matchSymbols({ items: symbolItems, planPages: pagePaths, pageTexts: pages, exclude: exclusions });
      symbolStats = stats;
      for (const s of stats) anchorSeen.set(s.itemId, s.anchorCandidates);
      for (const d of detections) {
        const pr = pageResults.find((x) => x.page === d.page);
        if (!pr) continue;
        if (vectorHits.has(d.itemId) && !opts.crossCheck) continue;
        pr.detections.push(d);
        symbolHits.set(d.itemId, (symbolHits.get(d.itemId) ?? 0) + 1);
      }
      log(`symbols: ${detections.length} match(es) for ${stats.filter((s) => s.matches > 0).length} of ${symbolItems.length} item(s)`);
    }
  }
  const rasterSheet = useSymbols && pagePaths.some((p) => p.paths.length < RASTER_PATH_THRESHOLD);
  const fallback: VisionFallback = opts.visionFallback ?? 'auto';
  const visionItems = items.filter((i) => {
    if (opts.crossCheck === true) return true;
    if (vectorHits.has(i.id) || symbolHits.has(i.id)) return false;
    if (fallback === 'never') return false;
    if (fallback === 'always' || !useSymbols || rasterSheet) return true;
    // auto: the glyph was never matched; try the model only when there is a hint the block is drawn differently.
    return i.signature === undefined || (anchorSeen.get(i.id) ?? 0) > 0;
  });
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
      // Vector counts are authoritative; vision only fills the rest unless cross-checking.
      if (item && (vectorHits.has(item.id) || symbolHits.has(item.id))) {
        if (!opts.crossCheck) continue;
      }
      pr.detections.push(d);
    }
  } else if (visionItems.length > 0) {
    warnings.push(`vision disabled: ${visionItems.length} item(s) have no tagged instances and no vector symbol match (${visionItems.map((i) => i.id).join(', ')})`);
  }
  const zeroItems = items.filter((i) => !vectorHits.has(i.id) && !symbolHits.has(i.id) && !visionItems.includes(i));
  if (zeroItems.length > 0 && useSymbols) log(`no instances on this drawing: ${zeroItems.map((i) => i.id).join(', ')}`);

  // Cross-check: report disagreements between vector and vision counts.
  if (opts.crossCheck) {
    for (const item of items) {
      if (!item.tag) continue;
      let vec = 0;
      let vis = 0;
      for (const pr of pageResults) {
        for (const d of pr.detections) {
          if (d.itemId !== item.id) continue;
          if (d.source === 'vision') vis += d.multiplier;
          else vec += d.multiplier;
        }
      }
      if (vec > 0 && vis > 0 && Math.abs(vec - vis) > Math.max(1, 0.05 * vec)) {
        warnings.push(`${item.id}: vector count ${vec} and vision count ${vis} disagree`);
      }
    }
  }

  const counts = aggregate(items, pageResults, opts.crossCheck === true);
  const usage = opts.vision ? opts.vision.usage() : emptyUsage();
  // Signatures are working data, not output.
  const outItems = items.map((i) => {
    const copy: LegendItem = { ...i };
    delete copy.signature;
    return copy;
  });
  const result: TakeoffResult = {
    schemaVersion: 1,
    file: basename(pdfPath),
    generatedAt: new Date().toISOString(),
    legend: legends[0] ? { ...legends[0], items: outItems } : null,
    pages: pageResults,
    items: counts,
    usage,
    wallTimeMs: Date.now() - started,
    warnings,
  };
  if (symbolStats) result.symbols = symbolStats;
  return result;
}

/** Sums detections per item and page. With cross-checking, vector wins where it exists. */
export function aggregate(items: readonly LegendItem[], pages: readonly PageResult[], crossCheck: boolean): ItemCount[] {
  return items.map((item) => {
    const perPage: Record<string, number> = {};
    let count = 0;
    let needsReview = 0;
    const sources = new Set<Detection['source']>();
    const hasVector = pages.some((p) => p.detections.some((d) => d.itemId === item.id && d.source !== 'vision'));
    for (const p of pages) {
      for (const d of p.detections) {
        if (d.itemId !== item.id) continue;
        if (crossCheck && hasVector && d.source === 'vision') continue;
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
