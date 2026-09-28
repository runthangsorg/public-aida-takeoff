/**
 * Symbol detection on one tile: the model is shown the legend crop and the
 * tile and returns boxes with item ids. Everything numeric (coordinates,
 * counting, de-duplication) is done here in code.
 */
import type { Box, Detection, LegendItem } from '../types.ts';
import type { Tile } from './tiles.ts';
import type { JsonSchema, Part, VertexClient } from './vertex.ts';

/** Compact keys: output tokens are the main cost, and a page can hold hundreds of detections. */
export interface RawDetection {
  /** item id */
  t: string;
  /** [ymin, xmin, ymax, xmax] on a 0-1000 scale of the tile */
  b: number[];
  /** confidence 0-1 */
  c: number;
}

export interface DetectResponse {
  d: RawDetection[];
}

export function detectionSchema(itemIds: string[]): JsonSchema {
  return {
    type: 'OBJECT',
    properties: {
      d: {
        type: 'ARRAY',
        description: 'detections',
        items: {
          type: 'OBJECT',
          properties: {
            t: { type: 'STRING', enum: itemIds, description: 'legend item id' },
            b: { type: 'ARRAY', items: { type: 'INTEGER' }, minItems: 4, maxItems: 4, description: 'box_2d [ymin, xmin, ymax, xmax] on a 0-1000 scale of the tile' },
            c: { type: 'NUMBER', description: 'confidence 0 to 1' },
          },
          required: ['t', 'b', 'c'],
        },
      },
    },
    required: ['d'],
  };
}

export function describeItems(items: readonly LegendItem[]): string {
  return items.map((i) => `- id "${i.id}"${i.tag ? ` (tag ${i.tag})` : ''}: ${i.description || 'see legend symbol'}`).join('\n');
}

export function detectPrompt(items: readonly LegendItem[], hasLegendImage: boolean): string {
  return [
    'You are performing a quantity takeoff on a construction services drawing (MEP: lighting, power, fire alarm, sprinklers, HVAC, plumbing).',
    hasLegendImage
      ? 'The first image is the legend: each row shows a symbol, its id or tag, and its description. The second image is one tile of the drawing.'
      : 'The image is one tile of the drawing.',
    'Find every instance of these legend symbols in the tile:',
    describeItems(items),
    '',
    'Rules:',
    '- Report one detection per symbol instance: t = item id, b = tight bounding box as [ymin, xmin, ymax, xmax] on a 0-1000 scale of the tile, c = confidence.',
    '- Match by the shape of the symbol, not by nearby text. Ignore text labels, tags, room names, dimensions, grid bubbles, notes and title block text.',
    '- Do not report symbols that are cut off by the edge of the tile; they are counted in the neighbouring tile.',
    '- Do not report rows of the legend itself if part of the legend is inside the tile.',
    '- Do not report symbols that are not in the list above.',
    '- c: 1.0 when the shape matches the legend exactly, lower when it could be a different symbol or is unclear.',
    'Return an empty list when the tile has none.',
  ].join('\n');
}

export interface DetectTileArgs {
  client: VertexClient;
  items: LegendItem[];
  legendPng: Buffer | null;
  tile: Tile;
  page: number;
  /** Pixels per point of the page image. */
  scale: number;
  mediaResolution?: 'MEDIA_RESOLUTION_LOW' | 'MEDIA_RESOLUTION_MEDIUM' | 'MEDIA_RESOLUTION_HIGH' | undefined;
}

/** Converts a model box (0-1000 tile scale) to page points. */
export function tileBoxToPage(box: number[], tile: Tile, scale: number): Box | null {
  const [ymin, xmin, ymax, xmax] = box;
  if (ymin === undefined || xmin === undefined || ymax === undefined || xmax === undefined) return null;
  const x1 = tile.x + (Math.min(xmin, xmax) / 1000) * tile.w;
  const x2 = tile.x + (Math.max(xmin, xmax) / 1000) * tile.w;
  const y1 = tile.y + (Math.min(ymin, ymax) / 1000) * tile.h;
  const y2 = tile.y + (Math.max(ymin, ymax) / 1000) * tile.h;
  if (x2 - x1 < 1 || y2 - y1 < 1) return null;
  return { x: x1 / scale, y: y1 / scale, w: (x2 - x1) / scale, h: (y2 - y1) / scale };
}

export async function detectTile(args: DetectTileArgs): Promise<Detection[]> {
  const ids = args.items.map((i) => i.id);
  const parts: Part[] = [{ text: detectPrompt(args.items, args.legendPng !== null) }];
  if (args.legendPng) {
    parts.push({ text: 'Legend:' }, { inlineData: { mimeType: 'image/png', data: args.legendPng.toString('base64') } });
  }
  parts.push({ text: 'Tile:' }, { inlineData: { mimeType: 'image/png', data: args.tile.png.toString('base64') } });
  const res = await args.client.generate<DetectResponse>({
    parts,
    schema: detectionSchema(ids),
    ...(args.mediaResolution ? { mediaResolution: args.mediaResolution } : {}),
  });
  const out: Detection[] = [];
  for (const raw of res.json.d) {
    if (!ids.includes(raw.t)) continue;
    const box = tileBoxToPage(raw.b, args.tile, args.scale);
    if (!box) continue;
    const confidence = Math.max(0, Math.min(1, Number.isFinite(raw.c) ? raw.c : 0));
    out.push({ page: args.page, itemId: raw.t, box, confidence, source: 'vision', multiplier: 1, needsReview: false });
  }
  return out;
}
