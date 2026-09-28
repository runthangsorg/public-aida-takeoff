/**
 * Renders PDF pages to PNG. Uses poppler's pdftoppm when it is installed
 * (fast, faithful) and falls back to pdf.js drawing onto a @napi-rs/canvas.
 */
import { execFile } from 'node:child_process';
import { mkdir, open, writeFile } from 'node:fs/promises';
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

/** Reads the PNG header of an existing file: width and height are the two big-endian u32 after the 16-byte signature+chunk header. */
async function readPngSize(path: string): Promise<{ width: number; height: number } | null> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(24);
    const { bytesRead } = await fh.read(head, 0, 24, 0);
    if (bytesRead < 24 || head.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    await fh.close();
  }
}

async function renderWithPdftoppm(pdfPath: string, page: number, dpi: number, outDir: string): Promise<RenderedPage> {
  const prefix = join(outDir, `page-${page}-${dpi}`);
  const path = `${prefix}.png`;
  let size = await readPngSize(path);
  if (!size) {
    await execFileAsync('pdftoppm', ['-r', String(dpi), '-f', String(page), '-l', String(page), '-png', '-singlefile', pdfPath, prefix], { maxBuffer: 1 << 20 });
    size = await readPngSize(path);
    if (!size) throw new Error(`pdftoppm produced no image for page ${page}`);
  }
  return { page, path, ...size, scale: dpi / 72, dpi };
}

async function renderWithPdfjs(pdfPath: string, page: number, dpi: number, outDir: string): Promise<RenderedPage> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const path = join(outDir, `page-${page}-${dpi}.png`);
  const existing = await readPngSize(path);
  if (existing) return { page, path, ...existing, scale: dpi / 72, dpi };
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
    await writeFile(path, canvas.toBuffer('image/png'));
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
