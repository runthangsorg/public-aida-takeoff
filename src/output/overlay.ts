/**
 * Marked-up PDF: every detection drawn on the original drawing as a box
 * with its item id, coloured by how it was found (blue: tag read from the
 * vector text; green: symbol recognised; red: needs a human look).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { openPdf } from '../pdf/text.ts';
import type { Box, Detection, TakeoffResult } from '../types.ts';

const COLOURS = {
  vector: rgb(0.1, 0.35, 0.9),
  vision: rgb(0.05, 0.6, 0.25),
  review: rgb(0.85, 0.1, 0.1),
};

/** Maps a viewport box (top-left origin, rotation applied) to PDF user-space corners for the page. */
export async function viewportToPdfBoxes(pdfPath: string, boxesByPage: Map<number, Box[]>): Promise<Map<number, { x: number; y: number; w: number; h: number }[]>> {
  const { doc, close } = await openPdf(pdfPath);
  const out = new Map<number, { x: number; y: number; w: number; h: number }[]>();
  try {
    for (const [pageNo, boxes] of boxesByPage) {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const converted = boxes.map((b) => {
        const [x1, y1] = viewport.convertToPdfPoint(b.x, b.y) as [number, number];
        const [x2, y2] = viewport.convertToPdfPoint(b.x + b.w, b.y + b.h) as [number, number];
        return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      });
      out.set(pageNo, converted);
      page.cleanup();
    }
  } finally {
    await close();
  }
  return out;
}

export async function writeOverlay(result: TakeoffResult, pdfPath: string, outPath: string): Promise<void> {
  const boxesByPage = new Map<number, Box[]>();
  const detsByPage = new Map<number, Detection[]>();
  for (const p of result.pages) {
    boxesByPage.set(p.page, p.detections.map((d) => d.box));
    detsByPage.set(p.page, p.detections);
  }
  const pdfBoxes = await viewportToPdfBoxes(pdfPath, boxesByPage);
  const doc = await PDFDocument.load(await readFile(pdfPath));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  for (const [pageNo, boxes] of pdfBoxes) {
    const page = pages[pageNo - 1];
    const dets = detsByPage.get(pageNo);
    if (!page || !dets) continue;
    const { width: pw } = page.getSize();
    const stroke = Math.max(0.6, pw / 2400);
    const fontSize = Math.max(4, pw / 400);
    boxes.forEach((b, i) => {
      const d = dets[i];
      if (!d) return;
      const colour = d.needsReview ? COLOURS.review : d.source === 'vector' ? COLOURS.vector : COLOURS.vision;
      const pad = stroke * 2;
      page.drawRectangle({ x: b.x - pad, y: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad, borderColor: colour, borderWidth: stroke, opacity: 0, borderOpacity: 0.9 });
      const label = d.multiplier > 1 ? `${d.itemId} x${d.multiplier}` : d.itemId;
      page.drawText(label, { x: b.x - pad, y: b.y + b.h + pad + 1, size: fontSize, font, color: colour, opacity: 0.9 });
    });
    // Legend of colours in the corner.
    const legend = [
      ['tag read from drawing text', COLOURS.vector],
      ['symbol recognised', COLOURS.vision],
      ['needs a check', COLOURS.review],
    ] as const;
    legend.forEach(([text, colour], i) => {
      const y = 8 + i * (fontSize + 3);
      page.drawRectangle({ x: 8, y, width: fontSize, height: fontSize, borderColor: colour, borderWidth: stroke, opacity: 0 });
      page.drawText(text, { x: 8 + fontSize + 3, y: y + 1, size: fontSize, font, color: colour });
    });
    const counts = result.items
      .filter((it) => (it.perPage[String(pageNo)] ?? 0) > 0)
      .map((it) => `${it.tag ?? it.itemId}: ${it.perPage[String(pageNo)]}`)
      .join('   ');
    page.drawText(`aida-takeoff  ${counts}`, { x: 8, y: 8 + legend.length * (fontSize + 3) + 2, size: fontSize, font, color: rgb(0.2, 0.2, 0.2) });
  }
  await writeFile(outPath, await doc.save());
}
