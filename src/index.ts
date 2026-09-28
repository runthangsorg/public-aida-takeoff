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
export { runBench, discoverSets } from './bench/bench.ts';
export { scoreSet, summarise, formatReport, TOLERANCE } from './bench/scoring.ts';
export type { BenchReport, SetScore, ItemScore, GroundTruthFile } from './bench/scoring.ts';
export { writeBill, sectionFor, SECTIONS } from './output/excel.ts';
export { writeOverlay } from './output/overlay.ts';
export type * from './types.ts';
