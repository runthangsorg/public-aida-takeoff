/**
 * Vision-pass logic that runs without a model: tiling, coordinate mapping,
 * de-duplication, the Vertex client's caching, accounting and spend cap
 * (with a fake fetch), and the pass wired end to end with a scripted model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countDrawing } from '../src/engine.ts';
import { renderPage } from '../src/pdf/render.ts';
import { extractText } from '../src/pdf/text.ts';
import { findLegend } from '../src/vector/legend.ts';
import { detectionSchema, tileBoxToPage } from '../src/vision/detect.ts';
import type { Detection } from '../src/types.ts';
import { createVisionPass, mapLimit } from '../src/vision/index.ts';
import { dedupe, inkFraction, loadPageImage, makeTiles, tileOrigins, type Tile, type TileDetection } from '../src/vision/tiles.ts';
import { selectDoubtful } from '../src/vision/verify.ts';
import { PRICE_PER_MILLION, SpendCapError, VertexClient, type JsonSchema } from '../src/vision/vertex.ts';

const bench = new URL('./fixtures/bench/', import.meta.url).pathname;
const set02 = `${bench}set-02/drawings/M-201-small-power-sprinkler-layout.pdf`;

let tmp = '';
beforeAll(() => {
  tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'aida-vision-'));
});
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('tiling', () => {
  it('covers the page with overlapping tiles and ends flush with the edge', () => {
    expect(tileOrigins(1000, 1024, 160)).toEqual([0]);
    const xs = tileOrigins(3309, 1024, 160);
    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBe(3309 - 1024);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeLessThanOrEqual(1024 - 160);
  });

  it('maps a model box on a tile back to page points', () => {
    const tile: Tile = { x: 1000, y: 500, w: 1024, h: 1024, png: Buffer.alloc(0) };
    const box = tileBoxToPage([100, 200, 150, 260], tile, 2);
    expect(box?.x).toBeCloseTo((1000 + 204.8) / 2, 6);
    expect(box?.y).toBeCloseTo((500 + 102.4) / 2, 6);
    expect(box?.w).toBeCloseTo(61.44 / 2, 6);
    expect(box?.h).toBeCloseTo(51.2 / 2, 6);
    expect(tileBoxToPage([100, 200, 100, 200], tile, 2)).toBeNull();
    expect(tileBoxToPage([1, 2, 3], tile, 2)).toBeNull();
  });

  it('builds a schema restricted to the legend ids', () => {
    const schema = detectionSchema(['A1', 'SD']);
    expect(schema.properties?.d?.items?.properties?.t?.enum).toEqual(['A1', 'SD']);
  });
});

describe('de-duplication', () => {
  const d = (itemId: string, x: number, y: number, confidence = 1, tile = 0, edgeMargin = 100, page = 1): TileDetection => ({
    page,
    itemId,
    box: { x, y, w: 10, h: 10 },
    confidence,
    source: 'vision',
    multiplier: 1,
    needsReview: false,
    tile,
    edgeMargin,
  });

  it('merges the same symbol seen from two tiles and keeps the fuller sighting', () => {
    const out = dedupe([d('SD', 100, 100, 1, 0, 3), d('SD', 108, 101, 1, 1, 40), d('SD', 200, 200)]);
    expect(out).toHaveLength(2);
    const merged = out.find((o) => o.box.x < 150);
    expect(merged?.box.x).toBe(108);
    expect(merged).not.toHaveProperty('tile');
  });

  it('keeps neighbouring symbols from the same tile apart unless the boxes coincide', () => {
    expect(dedupe([d('SSO', 100, 100), d('SSO', 108, 100)])).toHaveLength(2);
    expect(dedupe([d('SSO', 100, 100), d('SSO', 101, 100)])).toHaveLength(1);
  });

  it('matches each cross-tile sighting to its nearest neighbour, so two adjacent symbols stay two', () => {
    // Tile 0 sees S1 and S2 fully; tile 1 sees both again, slightly shifted.
    const out = dedupe([d('SSO', 100, 100, 1, 0, 50), d('SSO', 114, 100, 1, 0, 50), d('SSO', 102, 101, 1, 1, 50), d('SSO', 116, 101, 1, 1, 50)]);
    expect(out).toHaveLength(2);
  });

  it('keeps detections on different pages apart', () => {
    expect(dedupe([d('SD', 100, 100, 1, 0, 100, 1), d('SD', 100, 100, 1, 1, 100, 2)])).toHaveLength(2);
  });

  it('flags one place seen as two different items by two tiles', () => {
    const out = dedupe([d('SD', 100, 100, 0.9, 0), d('HD', 101, 100, 0.7, 1)]);
    expect(out).toHaveLength(1);
    expect(out[0]?.itemId).toBe('SD');
    expect(out[0]?.needsReview).toBe(true);
    expect(out[0]?.reviewReason).toMatch(/HD/);
  });
});

describe('second-look candidates', () => {
  const d = (itemId: string, x: number, y: number, confidence = 1, source: 'vision' | 'vector' = 'vision'): Detection => ({
    page: 1,
    itemId,
    box: { x, y, w: 10, h: 10 },
    confidence,
    source,
    multiplier: 1,
    needsReview: false,
  });
  it('picks low-confidence, flagged and isolated vision detections only', () => {
    const cluster = [d('SD', 100, 100), d('SP', 130, 100), d('SSO', 100, 130, 0.5)];
    const lonely = d('SW', 900, 900);
    const nearTag = d('HD', 500, 500);
    const tag = d('A1', 520, 500, 1, 'vector');
    const flagged = { ...d('SD', 300, 300), needsReview: true };
    const out = selectDoubtful([...cluster, lonely, nearTag, tag, flagged], { threshold: 0.75, isolationFactor: 6 });
    expect(out.map((o) => o.itemId).sort()).toEqual(['SD', 'SSO', 'SW']);
    expect(out.find((o) => o.itemId === 'SD')?.needsReview).toBe(true);
    expect(selectDoubtful([lonely], { threshold: 0.75, isolationFactor: 0 })).toEqual([]);
  });
});

describe('rendering', () => {
  it('renders the A3 sheet at the requested dpi with pdftoppm and pdf.js', async () => {
    const a = await renderPage(set02, 1, { dpi: 72, outDir: join(tmp, 'poppler'), renderer: 'pdftoppm' });
    const b = await renderPage(set02, 1, { dpi: 72, outDir: join(tmp, 'pdfjs'), renderer: 'pdfjs' });
    for (const r of [a, b]) {
      expect(r.width).toBe(1191);
      expect(r.height).toBe(842);
      expect(r.scale).toBe(1);
    }
    const img = await loadPageImage(a.path);
    const tiles = makeTiles(img, { tile: 512, overlap: 64 });
    expect(tiles.length).toBe(tileOrigins(1191, 512, 64).length * tileOrigins(842, 512, 64).length);
    // The legend corner has ink; a blank strip below the title block does not.
    expect(inkFraction(img, { x: 900, y: 30, w: 250, h: 80 })).toBeGreaterThan(0.001);
    expect(inkFraction(img, { x: 300, y: 700, w: 100, h: 20 })).toBe(0);
  });
});

interface FakeCall {
  body: { contents: { parts: { text?: string; inlineData?: unknown }[] }[] };
}

function fakeFetch(handler: (call: FakeCall, n: number) => unknown, status = 200): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const f = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const call = { body: JSON.parse(raw) as FakeCall['body'] };
    calls.push(call);
    const json = handler(call, calls.length);
    return Promise.resolve(new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } }));
  };
  return { fetch: f, calls };
}

function modelReply(payload: unknown, promptTokens = 1000, outputTokens = 100): unknown {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: outputTokens },
  };
}

describe('Vertex client', () => {
  const schema: JsonSchema = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] };

  it('parses structured output, accounts tokens and caches identical requests', async () => {
    const { fetch, calls } = fakeFetch(() => modelReply({ ok: true }, 2000, 500));
    const client = new VertexClient({ fetchImpl: fetch, project: 'test', tokenProvider: () => Promise.resolve('t'), cacheDir: join(tmp, 'cache') });
    const a = await client.generate<{ ok: boolean }>({ parts: [{ text: 'hi' }], schema });
    expect(a.json.ok).toBe(true);
    expect(a.cached).toBe(false);
    const b = await client.generate<{ ok: boolean }>({ parts: [{ text: 'hi' }], schema });
    expect(b.cached).toBe(true);
    expect(calls).toHaveLength(1);
    const u = client.usage();
    expect(u.calls).toBe(2);
    expect(u.promptTokens).toBe(4000);
    expect(u.costUsd).toBeCloseTo((4000 * PRICE_PER_MILLION.input + 1000 * PRICE_PER_MILLION.output) / 1e6, 8);
  });

  it('sends the thinking level, schema and temperature 0', async () => {
    const { fetch, calls } = fakeFetch(() => modelReply({ ok: true }));
    const client = new VertexClient({ fetchImpl: fetch, project: 'test', tokenProvider: () => Promise.resolve('t'), cacheDir: null });
    await client.generate({ parts: [{ text: 'x' }], schema });
    const cfg = (calls[0]?.body as unknown as { generationConfig: Record<string, unknown> }).generationConfig;
    expect(cfg.temperature).toBe(0);
    expect(cfg.responseMimeType).toBe('application/json');
    expect(cfg.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
  });

  it('stops at the spend cap', async () => {
    const { fetch } = fakeFetch(() => modelReply({ ok: true }, 1_000_000, 0));
    const client = new VertexClient({ fetchImpl: fetch, project: 'test', tokenProvider: () => Promise.resolve('t'), cacheDir: null, maxSpendUsd: 1 });
    await client.generate({ parts: [{ text: 'a' }], schema });
    await expect(client.generate({ parts: [{ text: 'b' }], schema })).rejects.toBeInstanceOf(SpendCapError);
  });

  it('never leaks the project id in errors', async () => {
    const { fetch } = fakeFetch(() => ({ error: { message: 'bad request for projects/hidden-tenant-xyz/locations/global' } }), 400);
    const client = new VertexClient({ fetchImpl: fetch, project: 'hidden-tenant-xyz', tokenProvider: () => Promise.resolve('t'), cacheDir: null });
    await expect(client.generate({ parts: [{ text: 'a' }], schema })).rejects.toThrow(/projects\/<redacted>/);
    await expect(client.generate({ parts: [{ text: 'a' }], schema })).rejects.not.toThrow(/hidden-tenant/);
  });
});

describe('mapLimit', () => {
  it('runs with bounded concurrency and keeps order', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([30, 10, 20, 5], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return i * 2;
    });
    expect(out).toEqual([0, 2, 4, 6]);
    expect(peak).toBe(2);
  });
});

describe('vision pass end to end with a scripted model', () => {
  it('turns tile detections into de-duplicated page detections and counts them in code', async () => {
    // The scripted model reports one SD in the middle of every tile and one SP at the
    // right edge of every tile (which the neighbouring tile also sees, so it must merge).
    const { fetch, calls } = fakeFetch((call) => {
      const text = call.body.contents[0]?.parts.map((p) => p.text ?? '').join(' ') ?? '';
      if (text.includes('Each numbered crop')) return modelReply({ answers: [] });
      return modelReply({
        d: [
          { t: 'SD', b: [480, 480, 520, 520], c: 1 },
          { t: 'SP', b: [100, 960, 140, 1000], c: 0.6 },
        ],
      });
    });
    const client = new VertexClient({ fetchImpl: fetch, project: 'test', tokenProvider: () => Promise.resolve('t'), cacheDir: null });
    const vision = await createVisionPass({ client, dpi: 72, tile: 400, overlap: 100, workDir: join(tmp, 'work'), verify: true, renderer: 'pdftoppm' });
    const [page] = await extractText(set02);
    const legend = findLegend(page!)!;
    const detections = await vision.detect({
      pdfPath: set02,
      pages: [{ page: 1, width: 1191, height: 842, exclude: [legend.box] }],
      items: legend.items,
      legendCrops: [{ page: 1, box: legend.box }],
    });
    const xs = tileOrigins(1191, 400, 100).length;
    const ys = tileOrigins(842, 400, 100).length;
    const tileCalls = calls.filter((c) => !(c.body.contents[0]?.parts[0]?.text ?? '').includes('Each numbered crop'));
    expect(tileCalls.length).toBeLessThanOrEqual(xs * ys);
    const sd = detections.filter((d) => d.itemId === 'SD');
    // One SD per tile, none overlapping (tile centres are 300 px apart), minus any in the legend box.
    expect(sd.length).toBeGreaterThan(0);
    expect(sd.length).toBeLessThanOrEqual(tileCalls.length);
    const sp = detections.filter((d) => d.itemId === 'SP');
    // The SP at every tile's right edge lands inside the next tile too and must merge.
    expect(sp.length).toBeLessThan(tileCalls.length);
    // Low-confidence SP and isolated detections went through verification in batched calls.
    const verifyCalls = calls.length - tileCalls.length;
    expect(verifyCalls).toBeGreaterThanOrEqual(1);
    expect(verifyCalls).toBeLessThanOrEqual(Math.ceil((sd.length + sp.length) / 12));
    for (const d of detections) {
      expect(d.source).toBe('vision');
      expect(d.box.x).toBeGreaterThanOrEqual(0);
      expect(d.box.x + d.box.w).toBeLessThanOrEqual(1191 + 1);
    }
  });

  it('feeds the engine and reports vision counts with usage', async () => {
    const { fetch } = fakeFetch((call) => {
      const parts = call.body.contents[0]?.parts ?? [];
      const text = parts.map((p) => p.text ?? '').join(' ');
      if (text.includes('Each numbered crop')) {
        const crops = parts.filter((p) => p.text?.startsWith('Crop ')).length;
        return modelReply({ answers: Array.from({ length: crops }, (_, i) => ({ index: i + 1, item: 'none', confidence: 0.9 })) });
      }
      return modelReply({ d: [{ t: 'SW', b: [480, 480, 520, 520], c: 0.5 }] });
    });
    const client = new VertexClient({ fetchImpl: fetch, project: 'test', tokenProvider: () => Promise.resolve('t'), cacheDir: null });
    const vision = await createVisionPass({ client, dpi: 72, tile: 600, overlap: 100, workDir: join(tmp, 'work2'), renderer: 'pdftoppm' });
    const result = await countDrawing(set02, { vision });
    // Every low-confidence SW was rejected on the second look, so nothing remains.
    expect(result.items.find((i) => i.itemId === 'SW')?.count).toBe(0);
    expect(result.usage.calls).toBeGreaterThan(1);
    expect(result.usage.costUsd).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });
});
