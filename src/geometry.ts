import type { Box } from './types.ts';

export function boxFromCorners(x1: number, y1: number, x2: number, y2: number): Box {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return { x, y, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export function center(b: Box): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export function containsPoint(b: Box, px: number, py: number): boolean {
  return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
}

/** True when the centre of `inner` lies inside `outer`. */
export function centerInside(outer: Box, inner: Box): boolean {
  const c = center(inner);
  return containsPoint(outer, c.x, c.y);
}

export function union(a: Box, b: Box): Box {
  return boxFromCorners(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x + a.w, b.x + b.w), Math.max(a.y + a.h, b.y + b.h));
}

export function unionAll(boxes: readonly Box[]): Box | null {
  let acc: Box | null = null;
  for (const b of boxes) acc = acc ? union(acc, b) : b;
  return acc;
}

export function expand(b: Box, dx: number, dy: number = dx): Box {
  return { x: b.x - dx, y: b.y - dy, w: b.w + 2 * dx, h: b.h + 2 * dy };
}

export function clampToPage(b: Box, width: number, height: number): Box {
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  const x2 = Math.min(width, b.x + b.w);
  const y2 = Math.min(height, b.y + b.h);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

export function intersectionArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function iou(a: Box, b: Box): number {
  const inter = intersectionArea(a, b);
  if (inter === 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

export function scaleBox(b: Box, f: number): Box {
  return { x: b.x * f, y: b.y * f, w: b.w * f, h: b.h * f };
}

export function round(n: number, places = 1): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function roundBox(b: Box, places = 1): Box {
  return { x: round(b.x, places), y: round(b.y, places), w: round(b.w, places), h: round(b.h, places) };
}
