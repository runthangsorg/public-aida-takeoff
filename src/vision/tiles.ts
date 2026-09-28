/**
 * Splits a rendered page into overlapping tiles, crops regions, and merges
 * detections that the overlap made the model see twice.
 */
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas';
import { readFile } from 'node:fs/promises';
import { center, iou } from '../geometry.ts';
import type { Box, Detection } from '../types.ts';

export interface Tile {
  /** Pixel offset of the tile in the page image. */
  x: number;
  y: number;
  w: number;
  h: number;
  png: Buffer;
}

export interface TilingOptions {
  tile: number;
  overlap: number;
}

export interface PageImage {
  image: Image;
  width: number;
  height: number;
}

export async function loadPageImage(path: string): Promise<PageImage> {
  const image = await loadImage(await readFile(path));
  return { image, width: image.width, height: image.height };
}

/** Tile origins along one axis: `size`-wide windows stepping by `size - overlap`, the last one flush with the end. */
export function tileOrigins(length: number, size: number, overlap: number): number[] {
  if (length <= size) return [0];
  const step = size - overlap;
  const origins: number[] = [];
  for (let o = 0; o + size < length; o += step) origins.push(o);
  origins.push(length - size);
  return origins;
}

export function cropPng(img: PageImage, box: Box, scaleTo = 1): Buffer {
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const w = Math.min(img.width - x, Math.ceil(box.w));
  const h = Math.min(img.height - y, Math.ceil(box.h));
  const canvas = createCanvas(Math.max(1, Math.round(w * scaleTo)), Math.max(1, Math.round(h * scaleTo)));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img.image, x, y, w, h, 0, 0, canvas.width, canvas.height);
  return canvas.toBuffer('image/png');
}

/** Fraction of pixels darker than mid-grey; blank tiles need no model call. */
export function inkFraction(img: PageImage, box: Box, sampleStep = 4): number {
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const w = Math.min(img.width - x, Math.ceil(box.w));
  const h = Math.min(img.height - y, Math.ceil(box.h));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img.image, x, y, w, h, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let dark = 0;
  let total = 0;
  for (let py = 0; py < h; py += sampleStep) {
    for (let px = 0; px < w; px += sampleStep) {
      const i = (py * w + px) * 4;
      const lum = ((data[i] ?? 255) + (data[i + 1] ?? 255) + (data[i + 2] ?? 255)) / 3;
      if (lum < 128) dark += 1;
      total += 1;
    }
  }
  return total === 0 ? 0 : dark / total;
}

export function makeTiles(img: PageImage, opts: TilingOptions): Tile[] {
  const tiles: Tile[] = [];
  const xs = tileOrigins(img.width, opts.tile, opts.overlap);
  const ys = tileOrigins(img.height, opts.tile, opts.overlap);
  for (const y of ys) {
    for (const x of xs) {
      const w = Math.min(opts.tile, img.width - x);
      const h = Math.min(opts.tile, img.height - y);
      tiles.push({ x, y, w, h, png: cropPng(img, { x, y, w, h }) });
    }
  }
  return tiles;
}

/** A detection with the tile it came from and how far its centre sits from that tile's edge (in points). */
export interface TileDetection extends Detection {
  tile: number;
  edgeMargin: number;
}

export interface DedupOptions {
  /** Detections from different tiles overlapping at least this much are one symbol. */
  iou: number;
  /** Detections from different tiles whose centres are closer than this fraction of the mean box size are one symbol. */
  centerFraction: number;
  /** Detections from the same tile only merge when their boxes nearly coincide. */
  sameTileIou: number;
}

/**
 * Cross-tile centre tolerance is generous (1.5 x symbol size) because the
 * model boxes asymmetric glyphs differently from each tile; the nearest kept
 * sighting is chosen, so two real neighbours each still claim their own.
 */
export const defaultDedup: DedupOptions = { iou: 0.3, centerFraction: 1.5, sameTileIou: 0.6 };

/**
 * Removes duplicate detections. The overlap between tiles makes the model
 * see symbols near a tile edge twice, so detections from different tiles
 * at the same place merge; within one tile, neighbouring symbols are real
 * and only near-identical boxes merge. The detection farthest from its
 * tile edge wins (it saw the whole symbol); confidence breaks ties.
 * Different items at one place are kept as one detection flagged for review.
 */
export function dedupe(detections: readonly TileDetection[], opts: DedupOptions = defaultDedup): Detection[] {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence || b.edgeMargin - a.edgeMargin);
  const kept: TileDetection[] = [];
  for (const d of sorted) {
    const c = center(d.box);
    const size = (d.box.w + d.box.h) / 2;
    let duplicateOf: TileDetection | null = null;
    let best = Infinity;
    for (const k of kept) {
      if (k.page !== d.page) continue;
      const overlap = iou(k.box, d.box);
      const kc = center(k.box);
      const dist = Math.hypot(kc.x - c.x, kc.y - c.y);
      if (k.tile === d.tile) {
        if (overlap >= opts.sameTileIou && dist < best) {
          duplicateOf = k;
          best = dist;
        }
        continue;
      }
      const ksize = (k.box.w + k.box.h) / 2;
      if ((overlap >= opts.iou || dist < opts.centerFraction * ((size + ksize) / 2)) && dist < best) {
        duplicateOf = k;
        best = dist;
      }
    }
    if (!duplicateOf) {
      kept.push({ ...d });
      continue;
    }
    // Prefer the sighting that saw more of the symbol when confidences are close.
    if (duplicateOf.itemId === d.itemId && d.edgeMargin > duplicateOf.edgeMargin && d.confidence >= duplicateOf.confidence - 0.05) {
      duplicateOf.box = d.box;
      duplicateOf.edgeMargin = d.edgeMargin;
    }
    if (duplicateOf.itemId !== d.itemId && !duplicateOf.needsReview) {
      duplicateOf.needsReview = true;
      duplicateOf.reviewReason = `also seen as ${d.itemId} (${d.confidence.toFixed(2)})`;
    }
  }
  return kept.map((k) => {
    const d: Detection = { page: k.page, itemId: k.itemId, box: k.box, confidence: k.confidence, source: k.source, multiplier: k.multiplier, needsReview: k.needsReview };
    if (k.reviewReason !== undefined) d.reviewReason = k.reviewReason;
    return d;
  });
}
