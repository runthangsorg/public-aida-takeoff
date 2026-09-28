/**
 * Minimal Gemini-on-Vertex client: structured JSON output, retries, a disk
 * cache keyed by request content, token accounting and a spend cap.
 *
 * Credentials come from the environment or gcloud at run time and are never
 * written anywhere. Error messages never include the project id or URL.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { UsageRecord } from '../types.ts';

const execFileAsync = promisify(execFile);

/** USD per million tokens (Gemini 3.8 Flash, list price at the time of writing). */
export const PRICE_PER_MILLION = { input: 1.5, output: 7.5 } as const;

export interface JsonSchema {
  type: 'OBJECT' | 'ARRAY' | 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  description?: string;
  minItems?: number;
  maxItems?: number;
  nullable?: boolean;
}

export type Part = { text: string } | { inlineData: { mimeType: 'image/png' | 'image/jpeg'; data: string } };

export interface GenerateOptions {
  parts: Part[];
  schema: JsonSchema;
  maxOutputTokens?: number;
  /** Media resolution hint for image parts. */
  mediaResolution?: 'MEDIA_RESOLUTION_LOW' | 'MEDIA_RESOLUTION_MEDIUM' | 'MEDIA_RESOLUTION_HIGH';
  thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface GenerateResult<T> {
  json: T;
  usage: { promptTokens: number; outputTokens: number; thoughtTokens: number };
  cached: boolean;
}

interface VertexResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { message?: string; status?: string };
}

export interface VertexClientOptions {
  model?: string;
  project?: string;
  location?: string;
  /** Abort once accumulated cost passes this (USD). */
  maxSpendUsd?: number;
  cacheDir?: string | null;
  log?: ((message: string) => void) | undefined;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  tokenProvider?: () => Promise<string>;
  projectProvider?: () => Promise<string>;
}

export class SpendCapError extends Error {}

async function gcloud(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gcloud', args, { maxBuffer: 1 << 20 });
  return stdout.trim();
}

export async function defaultProject(): Promise<string> {
  const env = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  if (env) return env;
  const p = await gcloud(['config', 'get-value', 'project']);
  if (!p || p === '(unset)') throw new Error('no Google Cloud project: set GOOGLE_CLOUD_PROJECT or run gcloud config set project');
  return p;
}

export async function defaultToken(): Promise<string> {
  const env = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (env) return env;
  const t = await gcloud(['auth', 'application-default', 'print-access-token']);
  if (!t) throw new Error('no access token: run gcloud auth application-default login');
  return t;
}

export class VertexClient {
  readonly model: string;
  private readonly location: string;
  private readonly maxSpendUsd: number;
  private readonly cacheDir: string | null;
  private readonly log: (message: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenProvider: () => Promise<string>;
  private readonly projectProvider: () => Promise<string>;
  private token: { value: string; at: number } | null = null;
  private project: string | null = null;
  private readonly usageRecord: UsageRecord;

  constructor(opts: VertexClientOptions = {}) {
    this.model = opts.model ?? process.env.AIDA_MODEL ?? 'gemini-3.8-flash';
    this.location = opts.location ?? 'global';
    this.maxSpendUsd = opts.maxSpendUsd ?? Number(process.env.AIDA_MAX_SPEND_USD ?? '2');
    this.cacheDir = opts.cacheDir === undefined ? (process.env.AIDA_CACHE_DIR ?? join(process.cwd(), '.tmp', 'vertex-cache')) : opts.cacheDir;
    this.log = opts.log ?? (() => undefined);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.tokenProvider = opts.tokenProvider ?? defaultToken;
    this.projectProvider = opts.project ? () => Promise.resolve(opts.project ?? '') : (opts.projectProvider ?? defaultProject);
    this.usageRecord = { model: this.model, calls: 0, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsd: 0 };
  }

  usage(): UsageRecord {
    return { ...this.usageRecord };
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() - this.token.at < 45 * 60_000) return this.token.value;
    this.token = { value: await this.tokenProvider(), at: Date.now() };
    return this.token.value;
  }

  private async endpoint(): Promise<string> {
    this.project ??= await this.projectProvider();
    return `https://aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/${this.model}:generateContent`;
  }

  private record(promptTokens: number, outputTokens: number, thoughtTokens: number): void {
    const u = this.usageRecord;
    u.calls += 1;
    u.promptTokens += promptTokens;
    u.outputTokens += outputTokens;
    u.thoughtTokens += thoughtTokens;
    u.costUsd = (u.promptTokens * PRICE_PER_MILLION.input + (u.outputTokens + u.thoughtTokens) * PRICE_PER_MILLION.output) / 1e6;
  }

  async generate<T>(opts: GenerateOptions): Promise<GenerateResult<T>> {
    const body = {
      contents: [{ role: 'user', parts: opts.parts }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: opts.schema,
        maxOutputTokens: opts.maxOutputTokens ?? 8192,
        ...(opts.mediaResolution ? { mediaResolution: opts.mediaResolution } : {}),
        thinkingConfig: { thinkingLevel: opts.thinkingLevel ?? 'LOW' },
      },
    };
    const payload = JSON.stringify(body);
    const key = createHash('sha256').update(this.model).update(payload).digest('hex');
    const cached = await this.readCache(key);
    if (cached) {
      const parsed = this.parse<T>(cached);
      // Cached calls cost nothing now, but are still counted as tokens so cost per set is honest.
      this.record(parsed.usage.promptTokens, parsed.usage.outputTokens, parsed.usage.thoughtTokens);
      return { ...parsed, cached: true };
    }
    if (this.usageRecord.costUsd >= this.maxSpendUsd) {
      throw new SpendCapError(`spend cap reached: $${this.usageRecord.costUsd.toFixed(2)} of $${this.maxSpendUsd.toFixed(2)}`);
    }
    const url = await this.endpoint();
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const token = await this.accessToken();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: payload,
        });
      } catch (err) {
        if (attempt >= 5) throw new Error(`model request failed after ${attempt} attempts: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      if (res.status === 401 && attempt < 3) {
        this.token = null;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        this.log(`model returned ${res.status}; retrying (${attempt})`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        throw new Error(`model returned HTTP ${res.status}: ${summariseError(text)}`);
      }
      const parsed = this.parse<T>(text);
      this.record(parsed.usage.promptTokens, parsed.usage.outputTokens, parsed.usage.thoughtTokens);
      await this.writeCache(key, text);
      return { ...parsed, cached: false };
    }
  }

  private parse<T>(text: string): { json: T; usage: GenerateResult<T>['usage'] } {
    const data = JSON.parse(text) as VertexResponse;
    const usage = {
      promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      thoughtTokens: data.usageMetadata?.thoughtsTokenCount ?? 0,
    };
    const candidate = data.candidates?.[0];
    const answer = candidate?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('') ?? '';
    if (answer.length === 0) {
      throw new Error(`model returned no content (finishReason ${candidate?.finishReason ?? 'unknown'})`);
    }
    return { json: JSON.parse(answer) as T, usage };
  }

  private async readCache(key: string): Promise<string | null> {
    if (!this.cacheDir) return null;
    try {
      return await readFile(join(this.cacheDir, `${key}.json`), 'utf8');
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, text: string): Promise<void> {
    if (!this.cacheDir) return;
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(join(this.cacheDir, `${key}.json`), text);
  }
}

function summariseError(text: string): string {
  try {
    const data = JSON.parse(text) as VertexResponse;
    return (data.error?.message ?? text).replace(/projects\/[^/]+/g, 'projects/<redacted>').slice(0, 300);
  } catch {
    return text.replace(/projects\/[^/]+/g, 'projects/<redacted>').slice(0, 300);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
