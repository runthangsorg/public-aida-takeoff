/**
 * Vector path extraction with pdf.js `getOperatorList`. Every path painted
 * on a page comes back as a `PathObject` in viewport points (top-left
 * origin, rotation applied), with its subpaths flattened to polylines and
 * whether it was filled, stroked or both. Text, images and clipping paths
 * are ignored; Form XObjects are followed with their matrix applied.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { boxFromCorners } from '../geometry.ts';
import { openPdf } from '../pdf/text.ts';
import type { Box } from '../types.ts';

export type Matrix = [number, number, number, number, number, number];

export interface Subpath {
  /** Flattened points in viewport points. */
  points: { x: number; y: number }[];
  closed: boolean;
  /** Number of curve segments in the source (0 for pure polylines). */
  curves: number;
}

export interface PathObject {
  page: number;
  subpaths: Subpath[];
  box: Box;
  fill: boolean;
  stroke: boolean;
  lineWidth: number;
  /** Order of appearance on the page; nearby indices were drawn together. */
  index: number;
}

export interface PagePaths {
  page: number;
  width: number;
  height: number;
  paths: PathObject[];
}

const DrawOPS = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 } as const;
const OPS = pdfjs.OPS;

function mul(a: Matrix, b: Matrix): Matrix {
  // b applied after a (pdf.js convention: transform(a) then transform(b) => b * a)
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function matrixScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

const FILL_OPS = new Set<number>([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const STROKE_OPS = new Set<number>([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);

/** Flattens one DrawOPS array into subpaths, mapping every point through `m`. */
export function decodeDrawOps(data: ArrayLike<number>, m: Matrix): Subpath[] {
  const out: Subpath[] = [];
  let cur: Subpath | null = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const push = (x: number, y: number) => {
    cur?.points.push(apply(m, x, y));
  };
  for (let i = 0; i < data.length; ) {
    const op = data[i++];
    switch (op) {
      case DrawOPS.moveTo: {
        cx = sx = data[i++] ?? 0;
        cy = sy = data[i++] ?? 0;
        cur = { points: [], closed: false, curves: 0 };
        out.push(cur);
        push(cx, cy);
        break;
      }
      case DrawOPS.lineTo: {
        cx = data[i++] ?? 0;
        cy = data[i++] ?? 0;
        if (!cur) {
          cur = { points: [], closed: false, curves: 0 };
          out.push(cur);
        }
        push(cx, cy);
        break;
      }
      case DrawOPS.curveTo: {
        const x1 = data[i++] ?? 0;
        const y1 = data[i++] ?? 0;
        const x2 = data[i++] ?? 0;
        const y2 = data[i++] ?? 0;
        const x3 = data[i++] ?? 0;
        const y3 = data[i++] ?? 0;
        if (!cur) {
          cur = { points: [], closed: false, curves: 0 };
          out.push(cur);
        }
        cur.curves += 1;
        for (let k = 1; k <= 6; k++) {
          const t = k / 6;
          const u = 1 - t;
          const x = u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
          const y = u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
          push(x, y);
        }
        cx = x3;
        cy = y3;
        break;
      }
      case DrawOPS.quadraticCurveTo: {
        const x1 = data[i++] ?? 0;
        const y1 = data[i++] ?? 0;
        const x2 = data[i++] ?? 0;
        const y2 = data[i++] ?? 0;
        if (!cur) {
          cur = { points: [], closed: false, curves: 0 };
          out.push(cur);
        }
        cur.curves += 1;
        for (let k = 1; k <= 4; k++) {
          const t = k / 4;
          const u = 1 - t;
          push(u * u * cx + 2 * u * t * x1 + t * t * x2, u * u * cy + 2 * u * t * y1 + t * t * y2);
        }
        cx = x2;
        cy = y2;
        break;
      }
      case DrawOPS.closePath: {
        if (cur) cur.closed = true;
        cx = sx;
        cy = sy;
        break;
      }
      default:
        return out;
    }
  }
  return out;
}

function boxOf(subpaths: readonly Subpath[]): Box {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const s of subpaths) {
    for (const p of s.points) {
      if (p.x < x1) x1 = p.x;
      if (p.y < y1) y1 = p.y;
      if (p.x > x2) x2 = p.x;
      if (p.y > y2) y2 = p.y;
    }
  }
  return Number.isFinite(x1) ? boxFromCorners(x1, y1, x2, y2) : { x: 0, y: 0, w: 0, h: 0 };
}

/** Reads every painted path of every page (or the given pages). */
export async function extractPaths(pdfPath: string, pages?: readonly number[]): Promise<PagePaths[]> {
  const { doc, close } = await openPdf(pdfPath);
  try {
    const out: PagePaths[] = [];
    const wanted = pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
    for (const n of wanted) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const base = viewport.transform as Matrix;
      const ol = await page.getOperatorList();
      const paths: PathObject[] = [];
      const stack: { ctm: Matrix; lineWidth: number }[] = [];
      let ctm: Matrix = base;
      let lineWidth = 1;
      let index = 0;
      for (let i = 0; i < ol.fnArray.length; i++) {
        const fn = ol.fnArray[i];
        const args = ol.argsArray[i] as unknown[];
        switch (fn) {
          case OPS.save:
            stack.push({ ctm, lineWidth });
            break;
          case OPS.restore: {
            const s = stack.pop();
            if (s) {
              ctm = s.ctm;
              lineWidth = s.lineWidth;
            }
            break;
          }
          case OPS.transform:
            ctm = mul(args as unknown as Matrix, ctm);
            break;
          case OPS.setLineWidth:
            lineWidth = Number(args[0] ?? 1);
            break;
          case OPS.paintFormXObjectBegin: {
            stack.push({ ctm, lineWidth });
            const m = args[0] as Matrix | null | undefined;
            if (m) ctm = mul(m, ctm);
            break;
          }
          case OPS.paintFormXObjectEnd: {
            const s = stack.pop();
            if (s) {
              ctm = s.ctm;
              lineWidth = s.lineWidth;
            }
            break;
          }
          case OPS.constructPath: {
            const paintOp = Number(args[0]);
            const fill = FILL_OPS.has(paintOp);
            const stroke = STROKE_OPS.has(paintOp);
            if (!fill && !stroke) break; // clipping or no-op path
            const raw = args[1];
            if (!raw) break;
            // pdf.js hands one Float32Array per path, or a list of them.
            const arrays: ArrayLike<number>[] = Array.isArray(raw) && typeof raw[0] === 'object' ? (raw as ArrayLike<number>[]) : [raw as ArrayLike<number>];
            const subpaths = arrays.flatMap((d) => decodeDrawOps(d, ctm)).filter((s) => s.points.length > 0);
            if (subpaths.length === 0) break;
            paths.push({ page: n, subpaths, box: boxOf(subpaths), fill, stroke, lineWidth: lineWidth * matrixScale(ctm), index: index++ });
            break;
          }
          default:
            break;
        }
      }
      out.push({ page: n, width: viewport.width, height: viewport.height, paths });
      page.cleanup();
    }
    return out;
  } finally {
    await close();
  }
}
