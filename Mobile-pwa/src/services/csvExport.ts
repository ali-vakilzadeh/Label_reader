/**
 * Daily Ledger CSV export, to Mobile_app/csv_export_format.txt.
 *
 * Nineteen columns, RFC 4180, UTF-8 **with a BOM**. The BOM is mandatory, not a
 * preference: without it Excel on a Windows locale reads the file as CP1252 and
 * corrupts every accented character in Brand, Country, Material and SubCategory.
 *
 * The quoting convention matches the exports the dashboard importer already accepts
 * (Dashboard/app_test_files/apparel_ledger_20260904_002804.csv): a bare header row,
 * and every data value quoted whether or not it needs to be.
 */
import { LedgerDao } from '../data/db';
import { loadSettings } from '../data/settingsStorage';
import { missingRequiredFields, type DailyLedgerEntity } from '../types/models';

/** The 19 columns, in the exact order of the specification. */
export const CSV_COLUMNS = [
  'Barcode',
  'Brand',
  'Category',
  'SubCategory',
  'Gender',
  'Season',
  'Size',
  'Color',
  'Material',
  'Country',
  'OriginalPrice',
  'Netto',
  'Brutto',
  'Timestamp',
  'Operator',
  'ExportBatch',
  'PackageCode',
  'SetSize',
  'CareInfo'
] as const;

const UTF8_BOM = '﻿';

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD HH:mm:ss" in device local time - the operator's confirmation moment. */
export function formatCsvTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function makeBatchId(now = new Date()): { batchId: string; filename: string; stamp: string } {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return { batchId: `EXPORT_${stamp}`, filename: `apparel_ledger_${stamp}.csv`, stamp };
}

const quote = (val: string | number | undefined | null) =>
  `"${String(val ?? '').replace(/"/g, '""')}"`;

/**
 * SetSize is an integer column. Blank, absent, 0, 1 or any non-numeric all mean 1,
 * and importers must not fail a row on it, so anything odd is normalised to 1 here
 * rather than written through.
 */
function normalizeSetSize(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export function buildCsvRow(item: DailyLedgerEntity, batchId: string): string {
  const f = item.fields;
  return [
    quote(item.apparelId),
    quote(f.brandName),
    quote(f.category),
    quote(f.subCategory),
    quote(f.gender),
    quote(f.season),
    quote(f.size),
    quote(f.color),
    quote(f.material),
    quote(f.countryOfOrigin),
    quote(f.originalPrice),
    quote(f.netto),
    quote(f.brutto),
    quote(formatCsvTimestamp(item.timestamp)),
    quote(item.userId),
    quote(batchId),
    quote(item.packageCode),
    quote(normalizeSetSize(item.setSize)),
    quote(f.careInfo)
  ].join(',');
}

/** The complete file, BOM included. CRLF line endings, per RFC 4180. */
export function buildCsv(items: DailyLedgerEntity[], batchId: string): string {
  const lines = [CSV_COLUMNS.join(','), ...items.map((item) => buildCsvRow(item, batchId))];
  return UTF8_BOM + lines.join('\r\n') + '\r\n';
}

export interface IncompleteRow {
  apparelId: string;
  missing: string[];
}

export interface ExportReadiness {
  /** True when the completeness setting is On and at least one row is short. */
  blocked: boolean;
  incomplete: IncompleteRow[];
}

export function evaluateReadiness(items: DailyLedgerEntity[], requireComplete: boolean): ExportReadiness {
  const incomplete = items
    .map((item) => ({ apparelId: item.apparelId, missing: missingRequiredFields(item) }))
    .filter((row) => row.missing.length > 0);

  return { blocked: requireComplete && incomplete.length > 0, incomplete };
}

export interface ExportOutcome {
  batchId: string;
  filename: string;
  count: number;
  /** Rows written despite missing columns, when the completeness gate is Off. */
  incomplete: IncompleteRow[];
}

export class ExportBlockedError extends Error {
  constructor(public readonly incomplete: IncompleteRow[]) {
    const shown = incomplete
      .slice(0, 3)
      .map((r) => `${r.apparelId} (${r.missing.join(', ')})`)
      .join('; ');
    const more = incomplete.length > 3 ? ` and ${incomplete.length - 3} more` : '';
    super(`${incomplete.length} record(s) are incomplete: ${shown}${more}.`);
    this.name = 'ExportBlockedError';
  }
}

export class NothingToExportError extends Error {
  constructor(public readonly awaitingConfirmation: number) {
    super(
      awaitingConfirmation > 0
        ? `No new records. ${awaitingConfirmation} already-exported record(s) are waiting for the cut-off to be confirmed.`
        : 'No records in the current session to export.'
    );
    this.name = 'NothingToExportError';
  }
}

function triggerDownload(csv: string, filename: string) {
  // The BOM is part of the string, so the Blob must not be given a charset that
  // makes a browser re-encode it. text/csv with an explicit utf-8 keeps the bytes.
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Writes the file and locks its rows.
 *
 * Only rows that have never been exported are taken. Once a row carries an
 * exportBatchId it is inside a file on someone's disk and is read-only, so a second
 * export before the cut-off is confirmed produces a file of only the newer rows
 * rather than re-stamping and re-writing the earlier ones.
 */
export async function exportLedgerCsv(): Promise<ExportOutcome> {
  const settings = loadSettings();
  const items = await LedgerDao.getUnexportedLedger();

  if (items.length === 0) {
    const active = await LedgerDao.getActiveLedger();
    throw new NothingToExportError(active.length);
  }

  const readiness = evaluateReadiness(items, settings.requireCompleteForExport);
  if (readiness.blocked) throw new ExportBlockedError(readiness.incomplete);

  const { batchId, filename } = makeBatchId();
  triggerDownload(buildCsv(items, batchId), filename);

  await LedgerDao.stampExportBatch(
    items.map((i) => i.apparelId),
    Date.now(),
    batchId
  );

  return { batchId, filename, count: items.length, incomplete: readiness.incomplete };
}
