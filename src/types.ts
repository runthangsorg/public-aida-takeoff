/**
 * Shared types for the takeoff engine.
 *
 * All coordinates are "viewport points": the page as it is displayed or
 * printed (rotation applied), origin at the top-left corner, y growing
 * downwards, 72 points per inch. Rendered image pixels are `pt * dpi / 72`.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One run of text as pdf.js reports it. */
export interface TextSpan {
  str: string;
  box: Box;
  fontSize: number;
}

export interface PageText {
  /** 1-based page number. */
  page: number;
  width: number;
  height: number;
  spans: TextSpan[];
}

/** One line of a legend: a symbol, optionally its type tag, and its description. */
export interface LegendItem {
  /** Stable identifier: the tag when present, otherwise `L<n>`. */
  id: string;
  /** Type tag printed on the drawing next to each instance (for example `A1`, `SD`). */
  tag: string | null;
  description: string;
  /** Where the legend row sits on the page it was read from. */
  box: Box;
  page: number;
}

export interface Legend {
  page: number;
  /** Region covering the heading and all rows, with a margin for the symbol column. */
  box: Box;
  items: LegendItem[];
  /** How the legend was found. */
  source: 'vector' | 'vision' | 'file';
}

export type DetectionSource = 'vector' | 'vision';

export interface Detection {
  page: number;
  itemId: string;
  box: Box;
  confidence: number;
  source: DetectionSource;
  /** Instances one detection stands for (tags such as `4 NO. A1`). */
  multiplier: number;
  needsReview: boolean;
  reviewReason?: string;
}

export interface TitleBlock {
  drawingNumber: string | null;
  title: string | null;
  /** Denominator of the scale note, for example 100 for `1:100`. */
  scale: number | null;
  /** Bounding box of the title block region if one was located. */
  box: Box | null;
}

export interface ItemCount {
  itemId: string;
  tag: string | null;
  description: string;
  count: number;
  /** Count of detections that need a human look. */
  needsReview: number;
  source: DetectionSource | 'mixed' | 'none';
  perPage: Record<string, number>;
}

export interface UsageRecord {
  model: string;
  calls: number;
  /** Calls answered from the local response cache (no network, no new spend; wall time is not representative). */
  cachedCalls: number;
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  costUsd: number;
}

export interface PageResult {
  page: number;
  width: number;
  height: number;
  titleBlock: TitleBlock;
  detections: Detection[];
}

export interface TakeoffResult {
  schemaVersion: 1;
  file: string;
  generatedAt: string;
  legend: Legend | null;
  pages: PageResult[];
  items: ItemCount[];
  usage: UsageRecord;
  wallTimeMs: number;
  warnings: string[];
}
