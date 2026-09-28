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

export interface DedupOptions {
  /** Same-item detections overlapping at least this much are one symbol. */
  iou: number;
  /** Same-item detections whose centres are closer than this fraction of the mean box size are one symbol. */
  centerFraction: number;
}

/**
 * Removes duplicate detections. Highest confidence wins. Different items at
 * the same place are kept as one detection flagged for review.
 */
export function dedupe(detections: readonly Detection[], opts: DedupOptions = { iou: 0.3, centerFraction: 0.6 }): Detection[] {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept: Detection[] = [];
  for (const d of sorted) {
    const c = center(d.box);
    const size = (d.box.w + d.box.h) / 2;
    let duplicateOf: Detection | null = null;
    for (const k of kept) {
      if (k.page !== d.page) continue;
      const kc = center(k.box);
      const ksize = (k.box.w + k.box.h) / 2;
      const dist = Math.hypot(kc.x - c.x, kc.y - c.y);
      if (iou(k.box, d.box) >= opts.iou || dist < opts.centerFraction * ((size + ksize) / 2)) {
        duplicateOf = k;
        break;
      }
    }
    if (!duplicateOf) {
      kept.push({ ...d });
      continue;
    }
    if (duplicateOf.itemId !== d.itemId && !duplicateOf.needsReview) {
      duplicateOf.needsReview = true;
      duplicateOf.reviewReason = `also seen as ${d.itemId} (${d.confidence.toFixed(2)})`;
    }
  }
  return kept;
}
