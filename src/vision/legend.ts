/**
 * Legend discovery by vision, for sheets whose legend is not text (scanned
 * or outlined drawings). The whole page is shown at low resolution; the
 * model returns the legend's box and its rows. Only the rows and the box are
 * taken from the model; counting still happens elsewhere.
 */
import { clampToPage, expand } from '../geometry.ts';
import type { Legend, LegendItem } from '../types.ts';
import { cropPng, type PageImage } from './tiles.ts';
import type { JsonSchema, VertexClient } from './vertex.ts';

interface LegendAnswer {
  found: boolean;
  box_2d: number[];
  rows: { tag: string; description: string }[];
}

const schema: JsonSchema = {
  type: 'OBJECT',
  properties: {
    found: { type: 'BOOLEAN' },
    box_2d: { type: 'ARRAY', items: { type: 'INTEGER' }, minItems: 4, maxItems: 4, description: '[ymin, xmin, ymax, xmax] of the legend block on a 0-1000 scale' },
    rows: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          tag: { type: 'STRING', description: 'type tag printed next to the symbol, or empty' },
          description: { type: 'STRING' },
        },
        required: ['tag', 'description'],
      },
    },
  },
  required: ['found', 'box_2d', 'rows'],
};

export async function findLegendByVision(client: VertexClient, image: PageImage, page: number, scale: number): Promise<Legend | null> {
  const maxSide = 1600;
  const factor = Math.min(1, maxSide / Math.max(image.width, image.height));
  const png = cropPng(image, { x: 0, y: 0, w: image.width, h: image.height }, factor);
  const res = await client.generate<LegendAnswer>({
    parts: [
      {
        text: [
          'This is a construction services drawing sheet. Find the legend (also called key or symbols): a block listing each symbol with its tag and description.',
          'Return its bounding box on a 0-1000 scale of the image, and one row per symbol with the printed tag (empty if there is none) and the description.',
          'Ignore the title block, notes and schedules. If there is no legend, return found=false.',
        ].join('\n'),
      },
      { inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
    ],
    schema,
    mediaResolution: 'MEDIA_RESOLUTION_HIGH',
  });
  if (!res.json.found || res.json.rows.length === 0) return null;
  const [ymin = 0, xmin = 0, ymax = 1000, xmax = 1000] = res.json.box_2d;
  const wPt = image.width / scale;
  const hPt = image.height / scale;
  const box = clampToPage(expand({ x: (xmin / 1000) * wPt, y: (ymin / 1000) * hPt, w: ((xmax - xmin) / 1000) * wPt, h: ((ymax - ymin) / 1000) * hPt }, 6), wPt, hPt);
  let n = 0;
  const items: LegendItem[] = res.json.rows.map((r) => {
    const tag = r.tag.trim().toUpperCase().replace(/\s+/g, ' ');
    const useTag = tag.length > 0 && tag.length <= 6;
    return { id: useTag ? tag : `L${++n}`, tag: useTag ? tag : null, description: r.description.trim(), box, page };
  });
  return { page, box, items, source: 'vision' };
}
