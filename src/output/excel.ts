/**
 * Excel bill of quantities. The layout follows the shape of a POMI-style
 * measured bill for services: trade sections, numbered items, a unit, the
 * quantity, and a rate column left for the estimator with amount and total
 * formulas. Headings and wording are our own.
 */
import ExcelJS from 'exceljs';
import type { ItemCount, TakeoffResult } from '../types.ts';

export interface Section {
  code: string;
  title: string;
  test: RegExp;
}

const OTHER: Section = { code: 'G', title: 'Equipment and other counted items', test: /./ };

/** Trade sections in bill order; an item lands in the first section whose test matches its description. */
export const SECTIONS: Section[] = [
  { code: 'A', title: 'Lighting: luminaires, emergency lighting and exit signage', test: /LUMINAIRE|DOWNLIGHT|LIGHT FITTING|PANEL|SPOTLIGHT|FLOODLIGHT|BATTEN|EXIT SIGN|EMERGENCY|LED|LAMP|PENDANT|STRIP LIGHT|LINEAR/ },
  { code: 'B', title: 'Small power: socket outlets, switches and connection units', test: /SOCKET|SWITCH|OUTLET|ISOLATOR|SPUR|CONNECTION UNIT|FLOOR BOX|DATA OUTLET|USB/ },
  { code: 'C', title: 'Fire detection and alarm', test: /SMOKE|HEAT DETECTOR|DETECTOR|SOUNDER|BEACON|CALL POINT|BREAK GLASS|FIRE ALARM|INTERFACE|BEAM/ },
  { code: 'D', title: 'Fire suppression: sprinklers', test: /SPRINKLER|SPRINKLER HEAD|HOSE REEL|EXTINGUISHER|DELUGE/ },
  { code: 'E', title: 'Air distribution: diffusers, grilles and terminal units', test: /DIFFUSER|GRILLE|LOUVRE|VAV|FCU|FAN COIL|TERMINAL|REGISTER|EXTRACT FAN|DAMPER/ },
  { code: 'F', title: 'Sanitary appliances', test: /\bWC\b|BASIN|SINK|SHOWER|URINAL|CISTERN|TAP|BATH|FLOOR GULLY|DRINKING/ },
];
SECTIONS.push(OTHER);

export function sectionFor(description: string): Section {
  const d = description.toUpperCase();
  return SECTIONS.find((s) => s.test.test(d)) ?? OTHER;
}

export interface BillOptions {
  projectName?: string | undefined;
  packageName?: string | undefined;
  currency?: string | undefined;
}

function groupItems(items: readonly ItemCount[]): Map<Section, ItemCount[]> {
  const groups = new Map<Section, ItemCount[]>();
  for (const s of SECTIONS) groups.set(s, []);
  for (const it of items) groups.get(sectionFor(it.description))?.push(it);
  return groups;
}

export async function writeBill(results: readonly TakeoffResult[], path: string, opts: BillOptions = {}): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'aida-takeoff';
  wb.created = new Date();
  const currency = opts.currency ?? 'AED';

  // Merge items across drawings by tag/id.
  const merged = new Map<string, ItemCount>();
  for (const r of results) {
    for (const it of r.items) {
      const key = it.tag ?? it.itemId;
      const cur = merged.get(key);
      if (cur) {
        cur.count += it.count;
        cur.needsReview += it.needsReview;
        for (const [p, n] of Object.entries(it.perPage)) cur.perPage[`${r.file}#${p}`] = n;
        if (cur.source !== it.source) cur.source = 'mixed';
      } else {
        merged.set(key, { ...it, perPage: Object.fromEntries(Object.entries(it.perPage).map(([p, n]) => [`${r.file}#${p}`, n])) });
      }
    }
  }
  const items = [...merged.values()];

  // --- Bill sheet ---
  const bill = wb.addWorksheet('Bill of Quantities', { views: [{ state: 'frozen', ySplit: 7 }] });
  bill.columns = [
    { key: 'ref', width: 8 },
    { key: 'desc', width: 64 },
    { key: 'unit', width: 6 },
    { key: 'qty', width: 10 },
    { key: 'rate', width: 12 },
    { key: 'amount', width: 14 },
    { key: 'note', width: 40 },
  ];
  const drawings = results.map((r) => r.pages.map((p) => p.titleBlock.drawingNumber).filter((n): n is string => n !== null)).flat();
  const uniqueDrawings = [...new Set(drawings)];
  bill.addRow([opts.projectName ?? results[0]?.pages[0]?.titleBlock.title ?? 'Services package']).font = { bold: true, size: 14 };
  bill.addRow([`Bill of quantities: ${opts.packageName ?? 'counted services items'}`]).font = { bold: true };
  bill.addRow([`Measured from drawings ${uniqueDrawings.length > 0 ? uniqueDrawings.join(', ') : results.map((r) => r.file).join(', ')} by counting each item shown; quantities are numbers of items supplied and fixed complete, including fixings and final connections, unless the description says otherwise.`]);
  bill.addRow([`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by aida-takeoff. Items marked "check" had detections the engine was not sure about; confirm them against the drawing before pricing.`]);
  bill.addRow([]);
  bill.addRow(['Ref', 'Description', 'Unit', 'Qty', `Rate (${currency})`, `Amount (${currency})`, 'Basis']).font = { bold: true };
  bill.getRow(6).border = { bottom: { style: 'thin' } };
  bill.addRow([]);

  const subtotalCells: string[] = [];
  const groups = groupItems(items);
  for (const [section, sectionItems] of groups) {
    if (sectionItems.length === 0) continue;
    const head = bill.addRow([section.code, section.title]);
    head.font = { bold: true };
    const firstRow = bill.rowCount + 1;
    sectionItems.forEach((it, i) => {
      const desc = it.tag ? `${it.description} (type ${it.tag})` : it.description;
      const basis = `${it.source === 'vector' ? 'tagged on drawing' : it.source === 'vision' ? 'symbol recognised' : it.source}${it.needsReview > 0 ? `; check ${it.needsReview}` : ''}`;
      const row = bill.addRow([`${section.code}/${i + 1}`, desc, 'nr', it.count, null, null, basis]);
      const n = row.number;
      row.getCell('amount').value = { formula: `IF(ISNUMBER(E${n}),D${n}*E${n},"")` };
      row.getCell('rate').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8DC' } };
      if (it.needsReview > 0) row.getCell('qty').font = { color: { argb: 'FFB00000' }, bold: true };
    });
    const lastRow = bill.rowCount;
    const sub = bill.addRow(['', `Section ${section.code} to collection`, '', '', '', { formula: `SUM(F${firstRow}:F${lastRow})` }]);
    sub.font = { italic: true };
    subtotalCells.push(`F${sub.number}`);
    bill.addRow([]);
  }
  const total = bill.addRow(['', 'Total carried to summary', '', '', '', { formula: subtotalCells.length > 0 ? subtotalCells.join('+') : '0' }]);
  total.font = { bold: true };
  total.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
  for (const col of ['qty', 'rate', 'amount']) bill.getColumn(col).numFmt = col === 'qty' ? '0' : '#,##0.00';

  // --- Summary by drawing ---
  const summary = wb.addWorksheet('Counts by drawing');
  const pageKeys = [...new Set(items.flatMap((it) => Object.keys(it.perPage)))].sort();
  summary.addRow(['Tag', 'Description', ...pageKeys, 'Total', 'Check']).font = { bold: true };
  for (const it of items) {
    summary.addRow([it.tag ?? it.itemId, it.description, ...pageKeys.map((k) => it.perPage[k] ?? 0), it.count, it.needsReview]);
  }
  summary.getColumn(2).width = 56;

  // --- Detections for audit ---
  const det = wb.addWorksheet('Detections');
  det.addRow(['Drawing', 'Page', 'Item', 'x (pt)', 'y (pt)', 'w (pt)', 'h (pt)', 'Confidence', 'Source', 'Multiplier', 'Check', 'Reason']).font = { bold: true };
  for (const r of results) {
    for (const p of r.pages) {
      for (const d of p.detections) {
        det.addRow([r.file, p.page, d.itemId, d.box.x, d.box.y, d.box.w, d.box.h, d.confidence, d.source, d.multiplier, d.needsReview ? 'yes' : '', d.reviewReason ?? '']);
      }
    }
  }
  det.getColumn(1).width = 36;

  await wb.xlsx.writeFile(path);
}
