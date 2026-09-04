import ExcelJS from 'exceljs';
import { openDashboardDb } from '../db';
import { collapseToLines, type InvoiceLine } from './groups';
import { queryItems, type ItemFilters } from './items';
import { localised, type Locale } from '../data/resolve';
import { customsCodeName } from '../data/referenceTables';
import { toClientDate } from '../utils/normalise';
import type { ItemRow } from '../types/item';
import { audit } from './audit';

/**
 * Exports (plan §9).
 *
 * Presets 1 and 3 reproduce the client's OWN files column for column — the layouts were
 * taken from docs/client_data/*.xlsx rather than invented, which is why the seller invoice
 * carries English headers over Armenian data: that is how Outfit's file is built.
 *
 * CSV is written with a UTF-8 BOM, because Excel needs it to read Armenian. XLSX carries
 * its own encoding and must NOT get a BOM — one written into the stream corrupts the file.
 */

export type PresetId = 'seller_invoice' | 'customs' | 'inspection' | 'full';
export type Format = 'csv' | 'xlsx';

export interface Column {
  header: string;
  /** Armenian header, when the client's own file has one. Falls back to `header`. */
  headerHy?: string;
  value: (line: InvoiceLine, index: number, locale: Locale) => string | number | null;
}

const tx = (key: Parameters<typeof localised>[0], item: ItemRow, locale: Locale): string =>
  localised(key, item[key] as string | null, locale);

/** Preset 1 — reproduces "2nd package-invoice#166 (final).xlsx". */
const SELLER_INVOICE: Column[] = [
  { header: 'No', value: (_l, i) => i + 1 },
  { header: 'ID code', value: (l) => l.representative.apparel_id },
  { header: 'Sub-category', value: (l, _i, loc) => tx('sub_category', l.representative, loc) },
  { header: 'Gender', value: (l, _i, loc) => tx('gender', l.representative, loc) },
  { header: 'Season', value: (l, _i, loc) => tx('season', l.representative, loc) },
  { header: 'Netto', value: (l) => l.representative.netto ?? '' },
  { header: 'Brutto', value: (l) => l.representative.brutto ?? '' },
  { header: 'Pieces', value: (l) => l.pieces },
  // Brand and country are always English, including on paperwork (client, 2026-08-30).
  { header: 'Brand', value: (l) => l.representative.brand ?? '' },
  { header: 'Country', value: (l) => l.representative.country ?? '' },
  { header: 'Size', value: (l) => l.representative.size ?? '' },
  { header: 'Original price', value: (l) => l.representative.original_price ?? '' },
  { header: 'Color', value: (l, _i, loc) => tx('color', l.representative, loc) },
  { header: 'Material', value: (l, _i, loc) => tx('material', l.representative, loc) },
  { header: 'package', value: (l) => l.representative.package_code ?? '' },
  { header: 'group', value: (l) => l.representative.article_no ?? '' },
  { header: 'date', value: (l) => toClientDate(l.representative.scanned_at) },
];

/** Preset 2 — customs clearance. */
const CUSTOMS: Column[] = [
  { header: 'row', value: (_l, i) => i + 1 },
  { header: 'HSCode', value: (l) => l.representative.hs_code ?? '' },
  { header: 'HSDescription', value: (l) => customsCodeName(l.representative.hs_code) ?? '' },
  { header: 'category', value: (l, _i, loc) => tx('category', l.representative, loc) },
  { header: 'sub-category', value: (l, _i, loc) => tx('sub_category', l.representative, loc) },
  { header: 'gender', value: (l, _i, loc) => tx('gender', l.representative, loc) },
  { header: 'season', value: (l, _i, loc) => tx('season', l.representative, loc) },
  { header: 'netto', value: (l) => l.representative.netto ?? '' },
  { header: 'brutto', value: (l) => l.representative.brutto ?? '' },
  { header: 'pieces', value: (l) => l.pieces },
  { header: 'brand', value: (l) => l.representative.brand ?? '' },
  { header: 'country', value: (l) => l.representative.country ?? '' },
  { header: 'size', value: (l) => l.representative.size ?? '' },
  { header: 'tag price', value: (l) => l.representative.user_decided_price ?? '' },
  { header: 'color', value: (l, _i, loc) => tx('color', l.representative, loc) },
  { header: 'material', value: (l, _i, loc) => tx('material', l.representative, loc) },
  { header: 'scanned_date', value: (l) => toClientDate(l.representative.scanned_at) },
];

/** Preset 3 — reproduces "Inspection-2026-156 (v05)", Armenian headers as in the original. */
const INSPECTION: Column[] = [
  { header: 'Code', value: (l) => l.representative.apparel_id },
  { header: 'Sub-category', value: (l, _i, loc) => tx('sub_category', l.representative, loc) },
  { header: 'Gender', headerHy: 'Սեռ(կանացի,տղամարդ,աղջիկ,տղա)', value: (l, _i, loc) => tx('gender', l.representative, loc) },
  { header: 'Brutto weight', headerHy: 'Բրուտտո քաշ', value: (l) => l.representative.brutto ?? '' },
  { header: 'Netto weight', headerHy: 'Նետտո քաշ', value: (l) => l.representative.netto ?? '' },
  { header: 'Quantity', headerHy: 'Քանակ հատ', value: (l) => l.pieces },
  { header: 'Brand', headerHy: 'Բրենդ', value: (l) => l.representative.brand ?? '' },
  { header: 'Country of origin', headerHy: 'Ծագման երկիր', value: (l) => l.representative.country ?? '' },
  { header: 'Material', headerHy: 'Ապրանքի մատերիալ', value: (l, _i, loc) => tx('material', l.representative, loc) },
];

/** Preset 4 — everything, including provenance. The handover and backup format. */
const FULL: Column[] = [
  { header: 'apparel_id', value: (l) => l.representative.apparel_id },
  { header: 'cloned_from', value: (l) => l.representative.cloned_from ?? '' },
  { header: 'article_no', value: (l) => l.representative.article_no ?? '' },
  { header: 'package_code', value: (l) => l.representative.package_code ?? '' },
  { header: 'operator', value: (l) => l.representative.operator },
  { header: 'scanned_at', value: (l) => l.representative.scanned_at },
  { header: 'export_batch', value: (l) => l.representative.export_batch ?? '' },
  { header: 'brand', value: (l) => l.representative.brand ?? '' },
  { header: 'brand_id', value: (l) => l.representative.brand_id ?? '' },
  { header: 'category', value: (l, _i, loc) => tx('category', l.representative, loc) },
  { header: 'category_id', value: (l) => l.representative.category_id ?? '' },
  { header: 'sub_category', value: (l, _i, loc) => tx('sub_category', l.representative, loc) },
  { header: 'sub_category_id', value: (l) => l.representative.sub_category_id ?? '' },
  { header: 'gender', value: (l, _i, loc) => tx('gender', l.representative, loc) },
  { header: 'gender_id', value: (l) => l.representative.gender_id ?? '' },
  { header: 'season', value: (l, _i, loc) => tx('season', l.representative, loc) },
  { header: 'season_id', value: (l) => l.representative.season_id ?? '' },
  { header: 'color', value: (l, _i, loc) => tx('color', l.representative, loc) },
  { header: 'color_id', value: (l) => l.representative.color_id ?? '' },
  { header: 'material', value: (l, _i, loc) => tx('material', l.representative, loc) },
  { header: 'material_id', value: (l) => l.representative.material_id ?? '' },
  { header: 'country', value: (l) => l.representative.country ?? '' },
  { header: 'country_id', value: (l) => l.representative.country_id ?? '' },
  { header: 'size', value: (l) => l.representative.size ?? '' },
  { header: 'original_price', value: (l) => l.representative.original_price ?? '' },
  { header: 'original_price_value', value: (l) => l.representative.original_price_value ?? '' },
  { header: 'original_price_currency', value: (l) => l.representative.original_price_currency ?? '' },
  { header: 'netto', value: (l) => l.representative.netto ?? '' },
  { header: 'brutto', value: (l) => l.representative.brutto ?? '' },
  { header: 'netto_g', value: (l) => l.representative.netto_g ?? '' },
  { header: 'brutto_g', value: (l) => l.representative.brutto_g ?? '' },
  { header: 'pieces', value: (l) => l.pieces },
  // Preset 4 does not collapse, so representative IS the row — set_size is per article.
  { header: 'set_size', value: (l) => l.representative.set_size ?? 1 },
  { header: 'care_info', value: (l) => l.representative.care_info ?? '' },
  { header: 'user_decided_price', value: (l) => l.representative.user_decided_price ?? '' },
  { header: 'suggested_price', value: (l) => l.representative.suggested_price ?? '' },
  { header: 'suggested_price_basis', value: (l) => l.representative.suggested_price_basis ?? '' },
  { header: 'suggested_price_n', value: (l) => l.representative.suggested_price_n ?? '' },
  { header: 'hs_code', value: (l) => l.representative.hs_code ?? '' },
  { header: 'hs_code_src', value: (l) => l.representative.hs_code_src ?? '' },
  { header: 'hs_code_basis', value: (l) => l.representative.hs_code_basis ?? '' },
  { header: 'min_confidence', value: (l) => l.representative.min_confidence ?? '' },
  { header: 'field_src_json', value: (l) => l.representative.field_src_json },
  { header: 'review_state', value: (l) => l.representative.review_state },
  { header: 'locked', value: (l) => l.representative.locked },
  { header: 'dup_group_id', value: (l) => l.representative.dup_group_id ?? '' },
  { header: 'dup_reason', value: (l) => l.representative.dup_reason ?? '' },
  { header: 'catalog_image_url', value: (l) => l.representative.catalog_image_url ?? '' },
  { header: 'rendering_status', value: (l) => l.representative.rendering_status ?? '' },
  { header: 'notes', value: (l) => l.representative.notes ?? '' },
  { header: 'members', value: (l) => l.members.map((m) => m.apparel_id).join(' ') },
];

export interface Preset {
  id: PresetId;
  label: string;
  description: string;
  columns: Column[];
  /** Presets 1-3 emit one line per article/clone family; preset 4 emits every row. */
  collapse: boolean;
  defaultLocale?: Locale;
}

export const PRESETS: Record<PresetId, Preset> = {
  seller_invoice: {
    id: 'seller_invoice',
    label: 'Seller Invoice',
    description: "Outfit's own invoice layout. Clone and group members are collapsed into Pieces.",
    columns: SELLER_INVOICE,
    collapse: true,
    defaultLocale: 'hy',
  },
  customs: {
    id: 'customs',
    label: 'Customs Clearance',
    description: 'HS code, weights and declared price. Warns about rows with no code or no price.',
    columns: CUSTOMS,
    collapse: true,
  },
  inspection: {
    id: 'inspection',
    label: 'Inspection Sheet',
    description: "Outfit's inspection layout, Armenian headers.",
    columns: INSPECTION,
    collapse: true,
    defaultLocale: 'hy',
  },
  full: {
    id: 'full',
    label: 'Full Data Export',
    description: 'Every column including provenance and suggestions. The handover format.',
    columns: FULL,
    collapse: false,
  },
};

export interface ExportWarning {
  kind: 'NO_HS_CODE' | 'NO_PRICE' | 'UNMATCHED';
  ids: string[];
  message: string;
}

export function buildLines(filters: ItemFilters, preset: Preset): InvoiceLine[] {
  const items = queryItems(filters, { limit: 100_000, sort: 'scanned_at', dir: 'asc' });
  if (!preset.collapse) {
    return items.map((i) => ({ representative: i, members: [i], pieces: i.pieces || 1 }));
  }
  return collapseToLines(items);
}

/** Checked before the file is written, so nobody discovers a gap at the customs desk. */
export function warningsFor(preset: Preset, lines: InvoiceLine[]): ExportWarning[] {
  const warnings: ExportWarning[] = [];
  if (preset.id === 'customs') {
    const noHs = lines.filter((l) => !l.representative.hs_code).map((l) => l.representative.apparel_id);
    if (noHs.length) {
      warnings.push({
        kind: 'NO_HS_CODE',
        ids: noHs,
        message: `${noHs.length} row${noHs.length === 1 ? ' has' : 's have'} no HS code.`,
      });
    }
    const noPrice = lines
      .filter((l) => l.representative.user_decided_price === null)
      .map((l) => l.representative.apparel_id);
    if (noPrice.length) {
      warnings.push({
        kind: 'NO_PRICE',
        ids: noPrice,
        message: `${noPrice.length} row${noPrice.length === 1 ? ' has' : 's have'} no decided price.`,
      });
    }
  }
  const unmatched = lines
    .filter((l) => l.representative.field_src_json.includes('UNMATCHED'))
    .map((l) => l.representative.apparel_id);
  if (unmatched.length) {
    warnings.push({
      kind: 'UNMATCHED',
      ids: unmatched,
      message: `${unmatched.length} row${unmatched.length === 1 ? ' carries' : 's carry'} a value that matched no reference table entry.`,
    });
  }
  return warnings;
}

function headerFor(col: Column, locale: Locale): string {
  return locale === 'hy' && col.headerHy ? col.headerHy : col.header;
}

function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv(preset: Preset, lines: InvoiceLine[], locale: Locale): Buffer {
  const rows: string[] = [preset.columns.map((c) => csvCell(headerFor(c, locale))).join(',')];
  lines.forEach((line, i) => {
    rows.push(preset.columns.map((c) => csvCell(c.value(line, i, locale))).join(','));
  });
  // UTF-8 BOM: without it Excel renders Armenian as mojibake.
  return Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(rows.join('\r\n'), 'utf8')]);
}

export async function renderXlsx(preset: Preset, lines: InvoiceLine[], locale: Locale): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Label Reader dashboard';
  wb.created = new Date();
  const ws = wb.addWorksheet(preset.label.slice(0, 31));

  ws.addRow(preset.columns.map((c) => headerFor(c, locale)));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };

  lines.forEach((line, i) => {
    ws.addRow(preset.columns.map((c) => c.value(line, i, locale)));
  });

  preset.columns.forEach((c, idx) => {
    const header = headerFor(c, locale);
    ws.getColumn(idx + 1).width = Math.min(40, Math.max(10, header.length + 4));
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // No BOM here — xlsx is a zip container and carries its own encoding.
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export function exportFilename(preset: PresetId, format: Format, locale: Locale): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '_');
  return `${preset}_${locale}_${stamp}.${format}`;
}

export function logExport(
  actor: string,
  preset: PresetId,
  locale: Locale,
  format: Format,
  filters: ItemFilters,
  rowCount: number,
  filename: string,
): void {
  openDashboardDb()
    .prepare(
      `INSERT INTO export_log (at, actor, preset, locale, format, filters_json, row_count, filename)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(Date.now(), actor, preset, locale, format, JSON.stringify(filters), rowCount, filename);
  audit(actor, 'EXPORT', 'export', preset, null, { locale, format, rowCount, filename });
}

export function recentExports(limit = 25) {
  return openDashboardDb().prepare('SELECT * FROM export_log ORDER BY at DESC LIMIT ?').all(limit);
}
