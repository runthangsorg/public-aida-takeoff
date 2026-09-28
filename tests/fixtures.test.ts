/**
 * The committed synthetic fixtures must be exactly what the generator
 * produces, so nobody can slip a third-party drawing in under the name of a
 * fixture and the ground truth can never drift from the PDFs.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFixtures } from '../scripts/make-fixtures.ts';

const committed = new URL('./fixtures/bench/', import.meta.url).pathname;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('synthetic fixtures', () => {
  let tmp = '';
  beforeAll(async () => {
    tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'aida-fixtures-'));
    await writeFixtures(tmp);
  });
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const sets = readdirSync(committed).filter((d) => d.startsWith('set-'));

  it('has at least three sets committed', () => {
    expect(sets.length).toBeGreaterThanOrEqual(3);
  });

  for (const set of sets) {
    it(`${set}: ground truth matches a fresh generation`, () => {
      const a = JSON.parse(readFileSync(join(committed, set, 'ground_truth.json'), 'utf8')) as unknown;
      const b = JSON.parse(readFileSync(join(tmp, set, 'ground_truth.json'), 'utf8')) as unknown;
      expect(a).toEqual(b);
    });

    it(`${set}: drawings are byte-identical to a fresh generation`, () => {
      const files = readdirSync(join(committed, set, 'drawings'));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        expect(sha256(join(committed, set, 'drawings', f))).toBe(sha256(join(tmp, set, 'drawings', f)));
      }
    });
  }
});
