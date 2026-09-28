/**
 * Repository policy gate. This repository is public: nothing personal, nothing
 * secret and no third-party drawings may be tracked. The patterns below are
 * assembled from fragments so this file does not trip its own checks.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repoRoot = new URL('..', import.meta.url).pathname;

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\0').filter((f) => f.length > 0);
}

function isBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8000);
  return probe.includes(0);
}

const emailPattern = new RegExp(String.raw`[A-Za-z0-9._%+-]+` + '@' + String.raw`[A-Za-z0-9-]+\.[A-Za-z]{2,}`);
const ownerSurname = new RegExp(['chowd', 'hree'].join(''), 'i');
const employer = new RegExp(['jib', 'ble'].join(''), 'i');
const gcpProjectId = new RegExp(['proj', 'ect-[0-9a-f]'].join(''));
const keyShaped = new RegExp(
  [
    // Google API key
    ['AI', 'za', '[0-9A-Za-z_-]{35}'].join(''),
    // Google OAuth access token
    ['ya', '29', String.raw`\.[0-9A-Za-z_-]{20,}`].join(''),
    // GitHub tokens
    ['gh', '[pousr]_', '[0-9A-Za-z]{36,}'].join(''),
    ['github', '_pat_', '[0-9A-Za-z_]{22,}'].join(''),
    // AWS access key id
    ['AK', 'IA', '[0-9A-Z]{16}'].join(''),
    // OpenAI / Anthropic style
    ['sk-', String.raw`(?:ant-|proj-)?[0-9A-Za-z_-]{32,}`].join(''),
    // Slack
    ['xox', '[abp]-', String.raw`[0-9A-Za-z-]{10,}`].join(''),
    // PEM private key block
    ['-----BEGIN ', String.raw`(?:[A-Z]+ )?PRIVATE KEY-----`].join(''),
    // Service-account JSON
    ['"private', '_key_id"'].join(''),
  ].join('|'),
);

interface Rule {
  name: string;
  pattern: RegExp;
}

const textRules: Rule[] = [
  { name: 'email address', pattern: emailPattern },
  { name: 'owner surname', pattern: ownerSurname },
  { name: 'employer name', pattern: employer },
  { name: 'GCP project id', pattern: gcpProjectId },
  { name: 'key-shaped string', pattern: keyShaped },
];

describe('policy rules detect what they claim to', () => {
  const samples: [string, string][] = [
    ['email address', ['someone', '@', 'example', '.', 'org'].join('')],
    ['owner surname', ['Chowd', 'hree'].join('')],
    ['employer name', ['Jib', 'ble'].join('')],
    ['GCP project id', ['proj', 'ect-', 'deadbeef'].join('')],
    ['key-shaped string', ['AI', 'za', 'A'.repeat(35)].join('')],
    ['key-shaped string', ['gh', 'p_', 'x'.repeat(36)].join('')],
    ['key-shaped string', ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('')],
  ];
  for (const [name, sample] of samples) {
    it(`${name} rule matches a sample`, () => {
      const rule = textRules.find((r) => r.name === name);
      expect(rule).toBeDefined();
      expect(rule?.pattern.test(sample)).toBe(true);
    });
  }
  it('rules ignore ordinary text', () => {
    const clean = 'Aida Takeoff counts luminaires on drawing E-101 at scale 1:100';
    for (const rule of textRules) expect(rule.pattern.test(clean)).toBe(false);
  });
});

describe('public repository policy', () => {
  const files = trackedFiles();

  it('tracks at least the README', () => {
    expect(files).toContain('README.md');
  });

  it('keeps PDFs out of the tree except synthetic fixtures under tests/fixtures/', () => {
    const offenders = files.filter((f) => /\.pdf$/i.test(f) && !f.startsWith('tests/fixtures/'));
    expect(offenders).toEqual([]);
  });

  it('tracks no other binary drawing or media formats', () => {
    const offenders = files.filter((f) => /\.(dwg|dxf|rvt|ifc|zip|7z|rar|mp4|mov|jpe?g|tiff?|bmp)$/i.test(f));
    expect(offenders).toEqual([]);
  });

  for (const rule of textRules) {
    it(`contains no ${rule.name}`, () => {
      const hits: string[] = [];
      for (const file of files) {
        const buf = readFileSync(`${repoRoot}${file}`);
        if (isBinary(buf)) continue;
        const text = buf.toString('utf8');
        const lines = text.split('\n');
        lines.forEach((line, i) => {
          if (rule.pattern.test(line)) hits.push(`${file}:${i + 1}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }
});
