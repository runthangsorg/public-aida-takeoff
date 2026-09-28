/** Vision pass entry point. Implemented in the next change; the CLI degrades to vector-only until then. */
import type { VisionPass } from '../engine.ts';

export interface VisionOptions {
  log?: ((message: string) => void) | undefined;
}

export function createVisionPass(opts: VisionOptions): Promise<VisionPass> {
  opts.log?.('vision pass not available in this build');
  return Promise.reject(new Error('vision pass not available in this build; run with --no-vision'));
}
