/** Aida Takeoff library entry point. */
export const VERSION = '0.1.0';
export { countDrawing, aggregate, mergeLegends } from './engine.ts';
export type { CountOptions, LegendMode, VisionPass } from './engine.ts';
export { extractText, normalizeText } from './pdf/text.ts';
export { findLegend, isTagLike } from './vector/legend.ts';
export { countTags, parseTagSpan } from './vector/tags.ts';
export { readTitleBlock, findNotesBox } from './vector/titleblock.ts';
export { renderPage } from './pdf/render.ts';
export { createVisionPass, defaultSettings as defaultVisionSettings } from './vision/index.ts';
export { VertexClient, SpendCapError, PRICE_PER_MILLION } from './vision/vertex.ts';
export { dedupe, makeTiles, tileOrigins } from './vision/tiles.ts';
export type * from './types.ts';
