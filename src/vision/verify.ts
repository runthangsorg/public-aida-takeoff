/**
 * Verification pass: low-confidence detections are cropped out with some
 * context and shown to the model again, in batches, next to the legend.
 * Agreement raises confidence; disagreement or "none" flags the detection
 * for review (and drops it when the second look is confident).
 */
import { clampToPage, expand } from '../geometry.ts';
import type { Detection, LegendItem } from '../types.ts';
import { cropPng, type PageImage } from './tiles.ts';
import type { JsonSchema, Part, VertexClient } from './vertex.ts';

export interface VerifyOptions {
  /** Detections at or above this confidence are trusted without a second look. */
  threshold: number;
  batchSize: number;
  /** Crop side in points around the detection centre. */
  contextPt: number;
  /**
   * A detection with no other detection within this many symbol sizes is
   * "isolated" and gets a second look whatever its confidence: a model
   * hallucination in an empty area of a sheet looks exactly like that.
   */
  isolationFactor: number;
}

/** Detections that deserve a second look: low confidence, already flagged, or isolated. */
export function selectDoubtful(detections: readonly Detection[], opts: Pick<VerifyOptions, 'threshold' | 'isolationFactor'>): Detection[] {
  const vision = detections.filter((d) => d.source === 'vision');
  return vision.filter((d) => {
    if (d.confidence < opts.threshold || d.needsReview) return true;
    if (opts.isolationFactor <= 0) return false;
    const size = (d.box.w + d.box.h) / 2;
    const cx = d.box.x + d.box.w / 2;
    const cy = d.box.y + d.box.h / 2;
    const radius = opts.isolationFactor * size;
    return !detections.some((o) => o !== d && o.page === d.page && Math.hypot(o.box.x + o.box.w / 2 - cx, o.box.y + o.box.h / 2 - cy) < radius);
  });
}

interface VerifyAnswer {
  answers: { index: number; item: string; confidence: number }[];
}

function verifySchema(ids: string[]): JsonSchema {
  return {
    type: 'OBJECT',
    properties: {
      answers: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            index: { type: 'INTEGER', description: 'crop number as labelled' },
            item: { type: 'STRING', enum: [...ids, 'none'], description: 'legend item id, or "none" when the crop centre holds no listed symbol' },
            confidence: { type: 'NUMBER' },
          },
          required: ['index', 'item', 'confidence'],
        },
      },
    },
    required: ['answers'],
  };
}

export interface VerifyArgs {
  client: VertexClient;
  items: LegendItem[];
  legendPng: Buffer | null;
  page: number;
  image: PageImage;
  scale: number;
  detections: Detection[];
  opts: VerifyOptions;
  log?: ((message: string) => void) | undefined;
}

/** Returns the detections to keep, with confidences and review flags updated. */
export async function verifyLowConfidence(args: VerifyArgs): Promise<Detection[]> {
  const ids = args.items.map((i) => i.id);
  const doubtful = selectDoubtful(args.detections, args.opts);
  if (doubtful.length === 0) return args.detections;
  args.log?.(`page ${args.page}: verifying ${doubtful.length} low-confidence or isolated detection(s)`);
  const dropped = new Set<Detection>();
  for (let start = 0; start < doubtful.length; start += args.opts.batchSize) {
    const batch = doubtful.slice(start, start + args.opts.batchSize);
    const parts: Part[] = [
      {
        text: [
          'Each numbered crop below is centred on one symbol from a construction services drawing.',
          args.legendPng ? 'The legend image shows every symbol next to its id and description.' : '',
          'Legend items:',
          args.items.map((i) => `- id "${i.id}": ${i.description}`).join('\n'),
          '',
          'For each crop, say which legend item the symbol at the centre of the crop is. Answer "none" when the centre holds text, a wall, a grid line, or a symbol that is not in the list. Give a confidence from 0 to 1.',
        ]
          .filter((s) => s.length > 0)
          .join('\n'),
      },
    ];
    if (args.legendPng) parts.push({ text: 'Legend:' }, { inlineData: { mimeType: 'image/png', data: args.legendPng.toString('base64') } });
    batch.forEach((d, i) => {
      const half = args.opts.contextPt / 2;
      const boxPt = clampToPage(expand({ x: d.box.x + d.box.w / 2 - half, y: d.box.y + d.box.h / 2 - half, w: args.opts.contextPt, h: args.opts.contextPt }, 0), args.image.width / args.scale, args.image.height / args.scale);
      const boxPx = { x: boxPt.x * args.scale, y: boxPt.y * args.scale, w: boxPt.w * args.scale, h: boxPt.h * args.scale };
      const png = cropPng(args.image, boxPx, boxPx.w < 256 ? 256 / boxPx.w : 1);
      parts.push({ text: `Crop ${i + 1} (first guess: ${d.itemId}):` }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } });
    });
    const res = await args.client.generate<VerifyAnswer>({ parts, schema: verifySchema(ids) });
    for (const a of res.json.answers) {
      const d = batch[a.index - 1];
      if (!d) continue;
      const conf = Math.max(0, Math.min(1, Number.isFinite(a.confidence) ? a.confidence : 0));
      if (a.item === d.itemId) {
        d.confidence = Math.max(d.confidence, conf);
        if (d.needsReview && conf >= 0.9) {
          d.needsReview = false;
          delete d.reviewReason;
        }
        continue;
      }
      if (a.item === 'none') {
        if (conf >= 0.8) {
          dropped.add(d);
          args.log?.(`page ${args.page}: dropped ${d.itemId} at (${Math.round(d.box.x)}, ${Math.round(d.box.y)}) on second look`);
        } else {
          d.needsReview = true;
          d.reviewReason = `second look saw no symbol (${conf.toFixed(2)})`;
        }
        continue;
      }
      if (ids.includes(a.item) && conf >= 0.8) {
        d.reviewReason = `reclassified from ${d.itemId} on second look (${conf.toFixed(2)})`;
        d.itemId = a.item;
        d.confidence = conf;
        d.needsReview = true;
      } else {
        d.needsReview = true;
        d.reviewReason = `second look said ${a.item} (${conf.toFixed(2)})`;
      }
    }
  }
  if (dropped.size > 0) args.log?.(`page ${args.page}: dropped ${dropped.size} detection(s) the second look rejected`);
  return args.detections.filter((d) => !dropped.has(d));
}
