/**
 * Renders PDF pages to PNG. Uses poppler's pdftoppm when it is installed
 * (fast, faithful) and falls back to pdf.js drawing onto a @napi-rs/canvas.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openPdf } from './text.ts';

const execFileAsync = promisify(execFile);

export interface RenderedPage {
  page: number;
  path: string;
  /** Pixel size of the image. */
  width: number;
  height: number;
  /** Pixels per point. */
  scale: number;
  dpi: number;
}

export type Renderer = 'pdftoppm' | 'pdfjs';

let pdftoppmAvailable: boolean | null = null;

export async function hasPdftoppm(): Promise<boolean> {
  if (pdftoppmAvailable !== null) return pdftoppmAvailable;
  try {
    await execFileAsync('pdftoppm', ['-v']);
    pdftoppmAvailable = true;
  } catch {
    pdftoppmAvailable = false;
  }
  return pdftoppmAvailable;
}

export async function chooseRenderer(preferred?: Renderer): Promise<Renderer> {
  if (preferred === 'pdfjs') return 'pdfjs';
  if (preferred === 'pdftoppm' || (await hasPdftoppm())) return 'pdftoppm';
  return 'pdfjs';
}

function pngSize(buf: Buffer): { width: number; height: number } {
  // PNG IHDR: width and height are the first two big-endian u32 after the 16-byte header.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function renderWithPdftoppm(pdfPath: string, page: number, dpi: number, outDir: string): Promise<RenderedPage> {
  const prefix = join(outDir, `page-${page}-${dpi}`);
  const path = `${prefix}.png`;
  try {
    await stat(path);
  } catch {
    await execFileAsync('pdftoppm', ['-r', String(dpi), '-f', String(page), '-l', String(page), '-png', '-singlefile', pdfPath, prefix], { maxBuffer: 1 << 20 });
  }
  const head = Buffer.alloc(24);
  const fh = await import('node:fs/promises').then((m) => m.open(path, 'r'));
  try {
    await fh.read(head, 0, 24, 0);
  } finally {
    await fh.close();
  }
  const { width, height } = pngSize(head);
  return { page, path, width, height, scale: dpi / 72, dpi };
}

async function renderWithPdfjs(pdfPath: string, page: number, dpi: number, outDir: string): Promise<RenderedPage> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const path = join(outDir, `page-${page}-${dpi}.png`);
  try {
    await stat(path);
    const buf = await readFile(path);
    const { width, height } = pngSize(buf);
    return { page, path, width, height, scale: dpi / 72, dpi };
  } catch {
    // render below
  }
  const { doc, close } = await openPdf(pdfPath);
  try {
    const p = await doc.getPage(page);
    const viewport = p.getViewport({ scale: dpi / 72 });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    // pdf.js expects a browser HTMLCanvasElement; @napi-rs/canvas is API compatible.
    await p.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
    const png = canvas.toBuffer('image/png');
    await import('node:fs/promises').then((m) => m.writeFile(path, png));
    p.cleanup();
    return { page, path, width, height, scale: dpi / 72, dpi };
  } finally {
    await close();
  }
}

export interface RenderOptions {
  dpi: number;
  outDir: string;
  renderer?: Renderer | undefined;
}

/** Renders one page; the PNG is cached in `outDir` by page and dpi. */
export async function renderPage(pdfPath: string, page: number, opts: RenderOptions): Promise<RenderedPage> {
  await mkdir(opts.outDir, { recursive: true });
  const renderer = await chooseRenderer(opts.renderer);
  return renderer === 'pdftoppm' ? renderWithPdftoppm(pdfPath, page, opts.dpi, opts.outDir) : renderWithPdfjs(pdfPath, page, opts.dpi, opts.outDir);
}
