/**
 * Generates synthetic vector drawings and their ground truth into
 * tests/fixtures/bench/. These are the only PDFs allowed in the repository:
 * every line, glyph and count here is produced by this script, so the
 * fixtures can be regenerated and there is nothing third-party in them.
 *
 *   node scripts/make-fixtures.ts [outDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

// ---------------------------------------------------------------------------
// Deterministic pseudo-random numbers (mulberry32) so fixtures are reproducible.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Symbol library. Glyphs are drawn from pure geometry so a vision model must
// recognise shape, not read letters.

interface Symbol {
  tag: string;
  description: string;
  /** Relative frequency when populating a drawing. */
  weight: number;
  draw: (page: PDFPage, cx: number, cy: number, s: number) => void;
}

const black = rgb(0, 0, 0);
const line = { borderColor: black, borderWidth: 0.8 };

const SYMBOLS: Symbol[] = [
  {
    tag: 'A1',
    description: 'LED downlight, 150 mm, recessed',
    weight: 5,
    draw: (p, cx, cy, s) => {
      p.drawCircle({ x: cx, y: cy, size: s / 2, ...line });
      p.drawLine({ start: { x: cx - s / 2, y: cy }, end: { x: cx - s / 4, y: cy }, thickness: 0.8 });
      p.drawLine({ start: { x: cx + s / 4, y: cy }, end: { x: cx + s / 2, y: cy }, thickness: 0.8 });
    },
  },
  {
    tag: 'A2',
    description: 'LED panel, 600 x 600 mm, recessed',
    weight: 4,
    draw: (p, cx, cy, s) => {
      p.drawRectangle({ x: cx - s / 2, y: cy - s / 2, width: s, height: s, ...line });
      p.drawLine({ start: { x: cx - s / 2, y: cy - s / 2 }, end: { x: cx + s / 2, y: cy + s / 2 }, thickness: 0.8 });
    },
  },
  {
    tag: 'B1',
    description: 'LED linear luminaire, 1200 mm, surface mounted',
    weight: 2,
    draw: (p, cx, cy, s) => {
      p.drawRectangle({ x: cx - s, y: cy - s / 5, width: 2 * s, height: (2 * s) / 5, ...line });
    },
  },
  {
    tag: 'EM',
    description: 'Self-contained emergency luminaire, 3 hour',
    weight: 1.5,
    draw: (p, cx, cy, s) => {
      p.drawRectangle({ x: cx - s / 2, y: cy - s / 2, width: s, height: s, ...line });
      p.drawCircle({ x: cx, y: cy, size: s / 6, color: black });
    },
  },
  {
    tag: 'EX',
    description: 'Illuminated exit sign, maintained',
    weight: 0.6,
    draw: (p, cx, cy, s) => {
      p.drawRectangle({ x: cx - s * 0.7, y: cy - s / 3, width: s * 1.4, height: (2 * s) / 3, ...line });
      p.drawSvgPath(`M ${-s / 3} ${-s / 5} L ${s / 3} 0 L ${-s / 3} ${s / 5} Z`, { x: cx, y: cy, color: black });
    },
  },
  {
    tag: 'SD',
    description: 'Optical smoke detector, ceiling mounted, addressable',
    weight: 2.5,
    draw: (p, cx, cy, s) => {
      p.drawCircle({ x: cx, y: cy, size: s / 2, ...line });
      p.drawCircle({ x: cx, y: cy, size: s / 6, color: black });
    },
  },
  {
    tag: 'HD',
    description: 'Rate-of-rise heat detector, ceiling mounted, addressable',
    weight: 1,
    draw: (p, cx, cy, s) => {
      p.drawCircle({ x: cx, y: cy, size: s / 2, ...line });
      p.drawRectangle({ x: cx - s / 5, y: cy - s / 5, width: (2 * s) / 5, height: (2 * s) / 5, color: black });
    },
  },
  {
    tag: 'SP',
    description: 'Sprinkler head, pendent, quick response',
    weight: 3,
    draw: (p, cx, cy, s) => {
      p.drawCircle({ x: cx, y: cy, size: s / 4, color: black });
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        p.drawLine({
          start: { x: cx + (dx * s) / 4, y: cy + (dy * s) / 4 },
          end: { x: cx + (dx * s) / 2, y: cy + (dy * s) / 2 },
          thickness: 0.8,
        });
      }
    },
  },
  {
    tag: 'SSO',
    description: '13 A twin switched socket outlet, flush',
    weight: 3,
    draw: (p, cx, cy, s) => {
      // Half circle opening upwards, on a short stem.
      p.drawSvgPath(`M ${-s / 2} 0 A ${s / 2} ${s / 2} 0 0 0 ${s / 2} 0 Z`, { x: cx, y: cy, borderColor: black, borderWidth: 0.8 });
      p.drawLine({ start: { x: cx, y: cy }, end: { x: cx, y: cy - s / 2 }, thickness: 0.8 });
    },
  },
  {
    tag: 'SW',
    description: 'Light switch, 1 gang 2 way, 10 A',
    weight: 1.5,
    draw: (p, cx, cy, s) => {
      p.drawCircle({ x: cx, y: cy, size: s / 5, color: black });
      p.drawLine({ start: { x: cx, y: cy }, end: { x: cx + s / 2, y: cy + s / 2 }, thickness: 0.8 });
      p.drawLine({ start: { x: cx + s / 2, y: cy + s / 2 }, end: { x: cx + s * 0.35, y: cy + s / 2 }, thickness: 0.8 });
    },
  },
];

// ---------------------------------------------------------------------------

interface SheetSpec {
  name: string;
  level: string;
  drawingNumber: string;
  width: number;
  height: number;
  /** Glyph size in points. */
  glyph: number;
  tagged: boolean;
  /** Tags whose instances carry a printed tag; others are glyph-only. */
  taggedSubset?: string[];
  legend: boolean;
  /** Which symbols appear on this sheet. */
  symbols: string[];
  density: number;
}

interface SetSpec {
  set: string;
  description: string;
  seed: number;
  file: string;
  sheets: SheetSpec[];
}

const A1 = { width: 2384, height: 1684 };
const A3 = { width: 1191, height: 842 };

const LIGHTING = ['A1', 'A2', 'B1', 'EM', 'EX'];
const FIRE = ['SD', 'HD', 'SP'];
const POWER = ['SSO', 'SW'];

const SETS: SetSpec[] = [
  {
    set: 'set-01',
    description: 'Tagged lighting and fire layout, A1, two levels, legend on every sheet',
    seed: 1,
    file: 'E-301-lighting-fire-layout.pdf',
    sheets: [
      { name: 'LEVEL 3 LIGHTING AND FIRE ALARM LAYOUT', level: '3', drawingNumber: 'E-301', ...A1, glyph: 14, tagged: true, legend: true, symbols: [...LIGHTING, ...FIRE], density: 0.55 },
      { name: 'LEVEL 4 LIGHTING AND FIRE ALARM LAYOUT', level: '4', drawingNumber: 'E-302', ...A1, glyph: 14, tagged: true, legend: true, symbols: [...LIGHTING, ...FIRE], density: 0.45 },
    ],
  },
  {
    set: 'set-02',
    description: 'Untagged small power and sprinkler layout, A3, one sheet; symbols identified by shape only',
    seed: 2,
    file: 'M-201-small-power-sprinkler-layout.pdf',
    sheets: [
      { name: 'LEVEL 2 SMALL POWER AND SPRINKLER LAYOUT', level: '2', drawingNumber: 'M-201', ...A3, glyph: 9, tagged: false, legend: true, symbols: [...POWER, 'SP', 'SD'], density: 0.5 },
    ],
  },
  {
    set: 'set-03',
    description: 'Mixed: luminaires tagged, fire devices untagged; legend only on the first sheet',
    seed: 3,
    file: 'E-401-combined-services-layout.pdf',
    sheets: [
      { name: 'LEVEL 1 COMBINED SERVICES LAYOUT', level: '1', drawingNumber: 'E-401', ...A1, glyph: 14, tagged: true, taggedSubset: LIGHTING, legend: true, symbols: [...LIGHTING, ...FIRE, ...POWER], density: 0.5 },
      { name: 'LEVEL 2 COMBINED SERVICES LAYOUT', level: '2', drawingNumber: 'E-402', ...A1, glyph: 14, tagged: true, taggedSubset: LIGHTING, legend: false, symbols: [...LIGHTING, ...FIRE, ...POWER], density: 0.4 },
    ],
  },
];

// ---------------------------------------------------------------------------

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

function drawFrame(page: PDFPage, spec: SheetSpec, fonts: Fonts): { drawArea: { x: number; y: number; w: number; h: number } } {
  const { width: W, height: H } = spec;
  const m = W > 1500 ? 30 : 15;
  page.drawRectangle({ x: m, y: m, width: W - 2 * m, height: H - 2 * m, borderColor: black, borderWidth: 1.5 });

  // Title block: bottom right.
  const tbW = W > 1500 ? 520 : 300;
  const tbH = W > 1500 ? 150 : 90;
  const tbX = W - m - tbW;
  const tbY = m;
  const fs = W > 1500 ? 9 : 6;
  page.drawRectangle({ x: tbX, y: tbY, width: tbW, height: tbH, borderColor: black, borderWidth: 1.2 });
  const rows = [
    ['PROJECT', 'SYNTHETIC OFFICE FIT-OUT, BUILDING 7'],
    ['DRAWING TITLE', spec.name],
    ['DRAWING NO', spec.drawingNumber],
    ['SCALE', W > 1500 ? '1:100 @ A1' : '1:200 @ A3'],
    ['REV', 'P2'],
    ['STATUS', 'TENDER'],
  ];
  rows.forEach(([k, v], i) => {
    const y = tbY + tbH - (i + 1) * (tbH / (rows.length + 0.5));
    page.drawText(k ?? '', { x: tbX + 8, y, size: fs, font: fonts.bold });
    page.drawText(v ?? '', { x: tbX + tbW * 0.3, y, size: fs, font: fonts.regular });
  });

  // Notes block: bottom left. Sentences mention tags so exact matching matters.
  const notes = [
    'NOTES',
    `1. ALL TYPE A1 AND A2 LUMINAIRES TO BE DALI DIMMABLE.`,
    '2. SD AND HD DEVICES ARE ADDRESSABLE. REFER TO FIRE ALARM SCHEDULE.',
    '3. SP HEADS AT 3.0 M CENTRES MAXIMUM, COORDINATE WITH CEILING GRID.',
    '4. SSO MOUNTING HEIGHT 450 MM AFFL UNLESS NOTED OTHERWISE.',
  ];
  notes.forEach((t, i) => {
    page.drawText(t, { x: m + 12, y: m + tbH - 14 - i * (fs + 4), size: i === 0 ? fs + 1 : fs, font: i === 0 ? fonts.bold : fonts.regular });
  });

  // Drawing area: everything above the title block strip, left of the legend column.
  const legendW = W > 1500 ? 420 : 300;
  return {
    drawArea: { x: m + 40, y: m + tbH + 30, w: W - 2 * m - legendW - 80, h: H - 2 * m - tbH - 80 },
  };
}

function drawLegend(page: PDFPage, spec: SheetSpec, fonts: Fonts, symbols: Symbol[]): void {
  const { width: W, height: H } = spec;
  const m = W > 1500 ? 30 : 15;
  const legendW = W > 1500 ? 400 : 290;
  const rowH = W > 1500 ? 26 : 15;
  const fs = W > 1500 ? 9 : 5.5;
  const x = W - m - legendW - 10;
  const top = H - m - 20;
  const boxH = rowH * (symbols.length + 1.6);
  page.drawRectangle({ x, y: top - boxH, width: legendW, height: boxH, borderColor: black, borderWidth: 1 });
  page.drawText('LEGEND', { x: x + 10, y: top - rowH * 0.9, size: fs + 3, font: fonts.bold });
  page.drawLine({ start: { x, y: top - rowH * 1.2 }, end: { x: x + legendW, y: top - rowH * 1.2 }, thickness: 0.8 });
  symbols.forEach((sym, i) => {
    const cy = top - rowH * (i + 2.1);
    sym.draw(page, x + 24, cy, spec.glyph);
    page.drawText(sym.tag, { x: x + 52, y: cy - fs / 3, size: fs, font: fonts.bold });
    page.drawText(sym.description.toUpperCase(), { x: x + 92, y: cy - fs / 3, size: fs, font: fonts.regular });
  });
}

function drawGridAndRooms(page: PDFPage, area: { x: number; y: number; w: number; h: number }, fonts: Fonts, level: string, rnd: () => number, big: boolean): { rooms: { x: number; y: number; w: number; h: number }[] } {
  const cols = big ? 8 : 5;
  const rows = big ? 5 : 3;
  const fs = big ? 9 : 6;
  const cw = area.w / cols;
  const rh = area.h / rows;
  // Grid bubbles and thin grid lines.
  for (let c = 0; c <= cols; c++) {
    const gx = area.x + c * cw;
    page.drawLine({ start: { x: gx, y: area.y }, end: { x: gx, y: area.y + area.h + 18 }, thickness: 0.3, color: rgb(0.5, 0.5, 0.5) });
    page.drawCircle({ x: gx, y: area.y + area.h + 26, size: 7, borderColor: black, borderWidth: 0.6 });
    page.drawText(String.fromCharCode(65 + c), { x: gx - 3, y: area.y + area.h + 22.5, size: fs, font: fonts.regular });
  }
  for (let r = 0; r <= rows; r++) {
    const gy = area.y + r * rh;
    page.drawLine({ start: { x: area.x - 18, y: gy }, end: { x: area.x + area.w, y: gy }, thickness: 0.3, color: rgb(0.5, 0.5, 0.5) });
    page.drawCircle({ x: area.x - 26, y: gy, size: 7, borderColor: black, borderWidth: 0.6 });
    page.drawText(String(r + 1), { x: area.x - 28.5, y: gy - 3, size: fs, font: fonts.regular });
  }
  // Rooms: merge some grid cells into larger rooms; walls as thick lines.
  const rooms: { x: number; y: number; w: number; h: number }[] = [];
  let n = 1;
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      const span = Math.min(cols - c, 1 + Math.floor(rnd() * 3));
      const room = { x: area.x + c * cw, y: area.y + r * rh, w: span * cw, h: rh };
      page.drawRectangle({ x: room.x, y: room.y, width: room.w, height: room.h, borderColor: black, borderWidth: big ? 3 : 1.6 });
      const kinds = ['OFFICE', 'MEETING ROOM', 'OPEN PLAN', 'STORE', 'CORRIDOR', 'PLANT', 'WC'];
      const kind = kinds[Math.floor(rnd() * kinds.length)] ?? 'OFFICE';
      page.drawText(`${kind} ${level}.${String(n).padStart(2, '0')}`, { x: room.x + 8, y: room.y + room.h - fs - 6, size: fs, font: fonts.regular });
      page.drawText(`${Math.round(room.w * 10)} x ${Math.round(room.h * 10)}`, { x: room.x + 8, y: room.y + 6, size: fs - 1, font: fonts.regular });
      rooms.push(room);
      n++;
      c += span;
    }
  }
  return { rooms };
}

function placeSymbols(page: PDFPage, spec: SheetSpec, fonts: Fonts, rooms: { x: number; y: number; w: number; h: number }[], rnd: () => number): Record<string, number> {
  const counts: Record<string, number> = {};
  const symbols = SYMBOLS.filter((s) => spec.symbols.includes(s.tag));
  const totalWeight = symbols.reduce((a, s) => a + s.weight, 0);
  const pitch = spec.glyph * 3.2;
  const fs = spec.width > 1500 ? 7 : 4.5;
  for (const room of rooms) {
    const nx = Math.floor((room.w - 24) / pitch);
    const ny = Math.floor((room.h - 30) / pitch);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (rnd() > spec.density) continue;
        let pick = rnd() * totalWeight;
        let sym = symbols[0];
        for (const s of symbols) {
          pick -= s.weight;
          if (pick <= 0) {
            sym = s;
            break;
          }
        }
        if (!sym) continue;
        const cx = room.x + 14 + spec.glyph + i * pitch + (rnd() - 0.5) * spec.glyph;
        const cy = room.y + 18 + spec.glyph + j * pitch + (rnd() - 0.5) * spec.glyph;
        sym.draw(page, cx, cy, spec.glyph);
        const tagged = spec.tagged && (spec.taggedSubset === undefined || spec.taggedSubset.includes(sym.tag));
        if (tagged) {
          page.drawText(sym.tag, { x: cx + spec.glyph * 0.65, y: cy - spec.glyph * 0.9, size: fs, font: fonts.regular });
        }
        counts[sym.tag] = (counts[sym.tag] ?? 0) + 1;
      }
    }
  }
  return counts;
}

export interface GroundTruth {
  set: string;
  description: string;
  source: string;
  units: 'nr';
  items: Record<string, number>;
  descriptions: Record<string, string>;
  perSheet: Record<string, Record<string, number>>;
}

export async function buildSet(spec: SetSpec): Promise<{ pdf: Uint8Array; truth: GroundTruth }> {
  const rnd = mulberry32(spec.seed);
  const doc = await PDFDocument.create();
  doc.setTitle(spec.description);
  doc.setProducer('aida-takeoff synthetic fixture generator');
  doc.setCreator('aida-takeoff');
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const items: Record<string, number> = {};
  const descriptions: Record<string, string> = {};
  const perSheet: Record<string, Record<string, number>> = {};
  for (const sheet of spec.sheets) {
    const page = doc.addPage([sheet.width, sheet.height]);
    const { drawArea } = drawFrame(page, sheet, fonts);
    const symbols = SYMBOLS.filter((s) => sheet.symbols.includes(s.tag));
    if (sheet.legend) drawLegend(page, sheet, fonts, symbols);
    const { rooms } = drawGridAndRooms(page, drawArea, fonts, sheet.level, rnd, sheet.width > 1500);
    const counts = placeSymbols(page, sheet, fonts, rooms, rnd);
    perSheet[sheet.drawingNumber] = counts;
    for (const s of symbols) {
      items[s.tag] = (items[s.tag] ?? 0) + (counts[s.tag] ?? 0);
      descriptions[s.tag] = s.description;
    }
  }
  const pdf = await doc.save({ useObjectStreams: false });
  return {
    pdf,
    truth: {
      set: spec.set,
      description: spec.description,
      source: `scripts/make-fixtures.ts, seed ${spec.seed} (synthetic; counts are exact by construction)`,
      units: 'nr',
      items,
      descriptions,
      perSheet,
    },
  };
}

export async function writeFixtures(outDir: string): Promise<GroundTruth[]> {
  const truths: GroundTruth[] = [];
  for (const spec of SETS) {
    const dir = join(outDir, spec.set);
    mkdirSync(join(dir, 'drawings'), { recursive: true });
    const { pdf, truth } = await buildSet(spec);
    writeFileSync(join(dir, 'drawings', spec.file), pdf);
    writeFileSync(join(dir, 'ground_truth.json'), JSON.stringify(truth, null, 2) + '\n');
    truths.push(truth);
  }
  return truths;
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const outDir = process.argv[2] ?? new URL('../tests/fixtures/bench', import.meta.url).pathname;
  const truths = await writeFixtures(outDir);
  for (const t of truths) {
    console.log(t.set, JSON.stringify(t.items));
  }
}
