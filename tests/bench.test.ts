import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverSets, runBench } from '../src/bench/bench.ts';
import { formatReport, scoreSet, summarise, type BenchReport, type GroundTruthFile } from '../src/bench/scoring.ts';
import { emptyUsage } from '../src/engine.ts';
import type { TakeoffResult } from '../src/types.ts';

const bench = new URL('./fixtures/bench/', import.meta.url).pathname;

function result(file: string, counts: Record<string, number>, descriptions: Record<string, string> = {}): TakeoffResult {
  return {
    schemaVersion: 1,
    file,
    generatedAt: '2026-01-01T00:00:00.000Z',
    legend: null,
    pages: [],
    items: Object.entries(counts).map(([tag, count]) => ({ itemId: tag, tag, description: descriptions[tag] ?? tag, count, needsReview: 0, source: 'vector', perPage: { '1': count } })),
    usage: emptyUsage(),
    wallTimeMs: 1,
    warnings: [],
  };
}

describe('scoring', () => {
  const truth: GroundTruthFile = { items: { A1: 100, SD: 10, EX: 0 }, descriptions: { A1: 'LED downlight' } };

  it('passes strict when every item is within 5 % and exact below 20', () => {
    const s = scoreSet('set-x', ['a.pdf'], truth, [result('a.pdf', { A1: 105, SD: 10, EX: 0 })], 5);
    expect(s.strictPass).toBe(true);
    expect(s.weightedPass).toBe(true);
    expect(s.items.map((i) => i.within)).toEqual([true, true, true]);
    expect(s.weightedError).toBeCloseTo(5 / 110, 6);
  });

  it('fails strict on a small item off by one but can pass weighted', () => {
    const s = scoreSet('set-x', ['a.pdf'], truth, [result('a.pdf', { A1: 100, SD: 11, EX: 0 })], 5);
    expect(s.strictPass).toBe(false);
    expect(s.weightedPass).toBe(true);
    expect(s.items[1]?.relError).toBeCloseTo(0.1, 6);
  });

  it('treats a true count of zero as pass only when nothing is predicted', () => {
    const s = scoreSet('set-x', ['a.pdf'], truth, [result('a.pdf', { A1: 100, SD: 10, EX: 2 })], 5);
    expect(s.items[2]?.within).toBe(false);
    expect(s.items[2]?.relError).toBeNull();
  });

  it('sums counts across drawings, matches by description when tags differ, and lists extras', () => {
    const results = [result('a.pdf', { A1: 60, SD: 4 }), result('b.pdf', { 'TYPE-A': 40, SD: 6, XX: 3 }, { 'TYPE-A': 'led downlight' })];
    const s = scoreSet('set-x', ['a.pdf', 'b.pdf'], truth, results, 5);
    // A1 keys 60 directly; TYPE-A matches by description only if the A1 key was unmatched, so it stays an extra.
    expect(s.items[0]?.predicted).toBe(60);
    expect(s.items[1]?.predicted).toBe(10);
    expect(s.extraItems.map((e) => e.key).sort()).toEqual(['TYPE-A', 'XX']);
  });

  it('marks unmatched ground-truth items as not found with 100 % error', () => {
    const s = scoreSet('set-x', ['a.pdf'], truth, [result('a.pdf', { SD: 10 })], 5);
    expect(s.items[0]?.matched).toBe(false);
    expect(s.items[0]?.predicted).toBe(0);
    expect(s.strictPass).toBe(false);
  });

  it('summarises the headline and cost per set', () => {
    const a = scoreSet('set-a', [], truth, [result('a.pdf', { A1: 100, SD: 10, EX: 0 })], 10);
    const b = scoreSet('set-b', [], truth, [result('b.pdf', { A1: 50, SD: 10, EX: 0 })], 30);
    b.usage.costUsd = 0.5;
    const m = summarise([a, b]);
    expect(m.strictPassed).toBe(1);
    expect(m.weightedPassed).toBe(1);
    expect(m.headline).toBe('1 of 2 sets within ±5% on every item (1 of 2 on quantity-weighted error)');
    expect(m.meanCostUsd).toBeCloseTo(0.25, 9);
    expect(m.meanWallTimeMs).toBe(20);
    const report: BenchReport = { schemaVersion: 1, generatedAt: '', benchDir: '', tolerance: 0.05, vision: false, sets: [a, b], summary: m };
    const text = formatReport(report);
    expect(text).toMatch(/set-a\s+PASS strict\s+PASS weighted/);
    expect(text).toMatch(/set-b\s+FAIL strict\s+FAIL weighted/);
    expect(text).toContain('A1          50 /   100');
  });
});

describe('bench runner on the synthetic fixtures (vector only)', () => {
  let tmp = '';
  beforeAll(() => {
    tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'aida-bench-'));
  });
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('discovers every set with ground truth and drawings', async () => {
    const sets = await discoverSets(bench);
    expect(sets.map((s) => s.name)).toEqual(['set-01', 'set-02', 'set-03']);
    expect(sets.every((s) => s.drawings.length === 1)).toBe(true);
  });

  it('passes the fully tagged set and fails the untagged ones without vision', async () => {
    const report = await runBench(bench, { outDir: tmp });
    expect(report.vision).toBe(false);
    const byName = Object.fromEntries(report.sets.map((s) => [s.set, s]));
    expect(byName['set-01']?.strictPass).toBe(true);
    expect(byName['set-01']?.weightedError).toBe(0);
    expect(byName['set-02']?.strictPass).toBe(false);
    expect(byName['set-03']?.strictPass).toBe(false);
    expect(report.summary.headline).toMatch(/^1 of 3 sets within ±5%/);
    expect(report.summary.totalCostUsd).toBe(0);
    // Per-drawing results were written for review.
    const written = JSON.parse(readFileSync(join(tmp, 'set-01', 'E-301-lighting-fire-layout.pdf.result.json'), 'utf8')) as TakeoffResult;
    expect(written.items.length).toBe(8);
  });

  it('runs a subset and reports a set without drawings as an error', async () => {
    const report = await runBench(bench, { only: ['set-02'] });
    expect(report.sets).toHaveLength(1);
    await expect(runBench(bench, { only: ['set-99'] })).rejects.toThrow(/no benchmark sets/);
  });
});
