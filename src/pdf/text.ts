/**
 * Vector text extraction with pdf.js. Every span is returned in viewport
 * points (top-left origin, rotation applied) so it lines up with rendered
 * page images and with vision detections.
 */
import { readFile } from 'node:fs/promises';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import { boxFromCorners } from '../geometry.ts';
import type { PageText, TextSpan } from '../types.ts';

export interface PdfPageInfo {
  page: number;
  width: number;
  height: number;
}

export type PdfDocument = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;

export interface OpenedPdf {
  doc: PdfDocument;
  close: () => Promise<void>;
}

export async function openPdf(pdfPath: string): Promise<OpenedPdf> {
  const data = new Uint8Array(await readFile(pdfPath));
  const task = pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 });
  const doc = await task.promise;
  return { doc, close: () => task.destroy() };
}

function isTextItem(item: unknown): item is TextItem {
  return typeof item === 'object' && item !== null && 'str' in item && 'transform' in item;
}

/** Reads the text of every page. */
export async function extractText(pdfPath: string): Promise<PageText[]> {
  const { doc, close } = await openPdf(pdfPath);
  try {
    const pages: PageText[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const spans: TextSpan[] = [];
      for (const item of content.items) {
        if (!isTextItem(item)) continue;
        const str = item.str;
        if (str.trim().length === 0) continue;
        const t = item.transform as number[];
        const [a = 1, b = 0, , , e = 0, f = 0] = t;
        const fontSize = Math.hypot(a, b) || item.height;
        // pdf.js gives the glyph box in user space: origin (e, f), extent
        // (width, height) along the text direction. Map both corners to the
        // viewport and normalise.
        const angle = Math.atan2(b, a);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const x2 = e + item.width * cos - item.height * sin;
        const y2 = f + item.width * sin + item.height * cos;
        const [vx1, vy1] = viewport.convertToViewportPoint(e, f) as [number, number];
        const [vx2, vy2] = viewport.convertToViewportPoint(x2, y2) as [number, number];
        spans.push({ str, box: boxFromCorners(vx1, vy1, vx2, vy2), fontSize });
      }
      pages.push({ page: n, width: viewport.width, height: viewport.height, spans });
      page.cleanup();
    }
    return pages;
  } finally {
    await close();
  }
}

/** Normalises a string for tag comparison: trimmed, upper-cased, single spaces. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toUpperCase();
}
