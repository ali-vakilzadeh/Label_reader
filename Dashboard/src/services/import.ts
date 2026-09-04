import crypto from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { openDashboardDb } from '../db';
import { audit } from './audit';
import { allSettings } from './settings';
import { resolveTaxonomy, type FieldSrc } from '../data/resolve';
import type { TaxonomyKey } from '../data/referenceTables';
import { parsePrice, parseTimestamp, parseWeightToGrams, trimOrNull } from '../utils/normalise';
import { enrichFromScans } from './enrich';
import { detectDuplicates } from './duplicates';
import { recomputeSuggestions, refreshReviewState } from './items';

/**
 * CSV ledger ingestion (plan §5.1).
 *
 * The whole run is one transaction. Any failure rolls back and the file is NOT recorded as
 * imported — so a half-applied ledger cannot exist, and re-uploading after a failure is
 * always the right move.
 */

/** Mobile_app/csv_export_format.txt, v1. */
const V1_HEADERS = [
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
] as const;

/**
 * Columns a future CSV v2 may add (plan §14.1/§14.2). Detected by header, so a v1 file
 * still imports unchanged and no schema migration is needed when the app starts sending
 * them.
 */
const V2_OPTIONAL = ['ClonedFrom', 'Pieces', 'SetSize', 'PackageCode', 'CareInfo', 'MinConfidence', 'CatalogImageUrl'] as const;

export type CollisionPolicy = 'SKIP' | 'UPDATE_EMPTY_ONLY' | 'OVERWRITE';

/**
 * Dashboard-owned columns an import must never destroy, whatever the policy. These hold
 * human work: a price someone decided, a customs code someone chose, a grouping someone
 * made. A ledger re-import is not a reason to lose them.
 */
const PROTECTED_ON_OVERWRITE = [
  'user_decided_price',
  'user_decided_price_currency',
  'hs_code',
  'hs_code_src',
  'hs_code_basis',
  'article_no',
  'package_code',
  'notes',
  'locked',
];

const TAXONOMY_MAP: Array<[string, TaxonomyKey]> = [
  ['Brand', 'brand'],
  ['Category', 'category'],
  ['SubCategory', 'sub_category'],
  ['Gender', 'gender'],
  ['Season', 'season'],
  ['Color', 'color'],
  ['Material', 'material'],
  ['Country', 'country'],
];

export interface RowOutcome {
  line: number;
  apparel_id: string | null;
  outcome: 'INSERTED' | 'UPDATED' | 'SKIPPED' | 'FAILED';
  detail: string | null;
}

export interface ImportReport {
  importId: number | null;
  filename: string;
  sha256: string;
  policy: CollisionPolicy;
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  flagged: number;
  duplicatesFlagged: number;
  enrichment: { available: boolean; enriched: number };
  rows: RowOutcome[];
  error?: string;
}

export class DuplicateFileError extends Error {
  constructor(
    message: string,
    readonly previous: { uploaded_at: number; uploaded_by: string; filename: string },
  ) {
    super(message);
  }
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Byte-level, so a renamed file is still caught. Order letter §3. */
export function findPreviousImport(digest: string) {
  return openDashboardDb().prepare('SELECT * FROM imports WHERE sha256 = ?').get(digest) as
    | { id: number; filename: string; uploaded_at: number; uploaded_by: string }
    | undefined;
}

function parseCsv(buffer: Buffer): Record<string, string>[] {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  return parse(text, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
}

export function validateHeaders(rows: Record<string, string>[]): string | null {
  if (!rows.length) return 'The file contains no data rows.';
  const headers = Object.keys(rows[0]);
  const missing = V1_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length) {
    return `Missing expected column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. The file must match Mobile_app/csv_export_format.txt.`;
  }
  return null;
}

interface PreparedRow {
  values: Record<string, unknown>;
  src: FieldSrc;
  flagged: boolean;
}

function prepareRow(raw: Record<string, string>, now: number): PreparedRow {
  const src: FieldSrc = {};
  const values: Record<string, unknown> = {};

  values.apparel_id = trimOrNull(raw.Barcode);
  values.operator = trimOrNull(raw.Operator) ?? 'unknown';
  values.scanned_at = parseTimestamp(trimOrNull(raw.Timestamp)) ?? new Date(now).toISOString().slice(0, 19);
  values.export_batch = trimOrNull(raw.ExportBatch);
  values.size = trimOrNull(raw.Size); // never snapped: no table, and a snapped size is a guess
  src.size = values.size ? 'OPERATOR' : 'EMPTY';

  for (const [csvCol, key] of TAXONOMY_MAP) {
    const input = trimOrNull(raw[csvCol]);
    const resolved = resolveTaxonomy(key, input);
    values[key] = resolved?.value ?? null;
    values[`${key}_id`] = resolved?.id ?? null;
    src[key] = resolved ? resolved.src : 'EMPTY';
  }

  const price = trimOrNull(raw.OriginalPrice);
  const parsedPrice = parsePrice(price);
  values.original_price = price;
  values.original_price_value = parsedPrice.value;
  values.original_price_currency = parsedPrice.currency;
  src.original_price = price ? 'OPERATOR' : 'EMPTY';

  const netto = trimOrNull(raw.Netto);
  const brutto = trimOrNull(raw.Brutto);
  values.netto = netto;
  values.brutto = brutto;
  values.netto_g = parseWeightToGrams(netto);
  values.brutto_g = parseWeightToGrams(brutto);
  src.netto = netto ? 'OPERATOR' : 'EMPTY';
  src.brutto = brutto ? 'OPERATOR' : 'EMPTY';

  // CSV v2 columns, if the file happens to carry them.
  values.cloned_from = trimOrNull(raw.ClonedFrom);
  const pieces = Number(trimOrNull(raw.Pieces) ?? '1');
  values.pieces = Number.isFinite(pieces) && pieces > 0 ? Math.round(pieces) : 1;
  // SetSize counts garments inside one packaged article; Pieces counts articles. Nothing
  // here multiplies them — see csv_export_format.txt section 3. Anything unusable means 1,
  // because a set is the exception and a bad cell must not fail an otherwise good row.
  const setSize = Number(trimOrNull(raw.SetSize) ?? '1');
  values.set_size = Number.isFinite(setSize) && setSize > 0 ? Math.round(setSize) : 1;
  values.package_code = trimOrNull(raw.PackageCode);
  values.care_info = trimOrNull(raw.CareInfo);
  values.catalog_image_url = trimOrNull(raw.CatalogImageUrl);
  const conf = Number(trimOrNull(raw.MinConfidence) ?? '');
  values.min_confidence = Number.isFinite(conf) ? conf : null;

  values.field_src_json = JSON.stringify(src);
  values.source = 'CSV';

  // A FUZZY snap is recorded in field_src_json and surfaced on the row, but it does not
  // by itself hold the item for review — the value did resolve. Only an unresolved or
  // missing value does.
  const flagged = Object.values(src).some((v) => v === 'UNMATCHED' || v === 'EMPTY');
  return { values, src, flagged };
}

const INSERT_COLUMNS = [
  'apparel_id', 'cloned_from', 'package_code', 'operator', 'scanned_at', 'export_batch', 'import_id', 'source',
  'brand', 'brand_id', 'category', 'category_id', 'sub_category', 'sub_category_id',
  'gender', 'gender_id', 'season', 'season_id', 'color', 'color_id',
  'material', 'material_id', 'country', 'country_id', 'size',
  'original_price', 'original_price_value', 'original_price_currency',
  'netto', 'brutto', 'netto_g', 'brutto_g', 'pieces', 'set_size', 'care_info',
  'field_src_json', 'min_confidence', 'catalog_image_url',
  'review_state', 'created_at', 'updated_at', 'updated_by',
];

/** Columns a re-import may refresh. PROTECTED_ON_OVERWRITE is excluded by construction. */
const REFRESHABLE = INSERT_COLUMNS.filter(
  (c) => !['apparel_id', 'created_at', 'import_id', 'review_state'].includes(c) && !PROTECTED_ON_OVERWRITE.includes(c),
);

export function runImport(
  actor: string,
  filename: string,
  buffer: Buffer,
  policy: CollisionPolicy,
  dryRun = false,
): ImportReport {
  const db = openDashboardDb();
  const digest = sha256(buffer);
  const now = Date.now();

  const report: ImportReport = {
    importId: null,
    filename,
    sha256: digest,
    policy,
    total: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    flagged: 0,
    duplicatesFlagged: 0,
    enrichment: { available: false, enriched: 0 },
    rows: [],
  };

  const previous = findPreviousImport(digest);
  if (previous && !dryRun) {
    throw new DuplicateFileError(
      `This exact file was already imported on ${new Date(previous.uploaded_at).toISOString().slice(0, 16).replace('T', ' ')} by ${previous.uploaded_by} (as "${previous.filename}").`,
      previous,
    );
  }

  let raw: Record<string, string>[];
  try {
    raw = parseCsv(buffer);
  } catch (err) {
    report.error = `Could not parse the file: ${(err as Error).message}`;
    return report;
  }

  const headerError = validateHeaders(raw);
  if (headerError) {
    report.error = headerError;
    return report;
  }
  report.total = raw.length;

  const touched: string[] = [];

  const work = db.transaction(() => {
    let importId: number | null = null;
    if (!dryRun) {
      importId = Number(
        db
          .prepare(
            `INSERT INTO imports (filename, sha256, uploaded_at, uploaded_by, policy, status)
             VALUES (?, ?, ?, ?, ?, 'RUNNING')`,
          )
          .run(filename, digest, now, actor, policy).lastInsertRowid,
      );
      report.importId = importId;
    }

    raw.forEach((line, index) => {
      const lineNo = index + 2; // +1 for zero-index, +1 for the header row
      const prepared = prepareRow(line, now);
      const apparelId = prepared.values.apparel_id as string | null;

      if (!apparelId) {
        report.failed += 1;
        report.rows.push({ line: lineNo, apparel_id: null, outcome: 'FAILED', detail: 'Barcode is empty.' });
        return;
      }

      const existing = db.prepare('SELECT apparel_id, locked FROM items WHERE apparel_id = ?').get(apparelId) as
        | { apparel_id: string; locked: number }
        | undefined;

      if (existing) {
        if (policy === 'SKIP') {
          report.skipped += 1;
          report.rows.push({ line: lineNo, apparel_id: apparelId, outcome: 'SKIPPED', detail: 'Already present.' });
          return;
        }
        if (existing.locked) {
          report.skipped += 1;
          report.rows.push({
            line: lineNo,
            apparel_id: apparelId,
            outcome: 'SKIPPED',
            detail: 'Locked — left untouched.',
          });
          return;
        }

        const columns =
          policy === 'OVERWRITE'
            ? REFRESHABLE
            : REFRESHABLE.filter((c) => prepared.values[c] !== null && prepared.values[c] !== undefined);

        if (!dryRun && columns.length) {
          const setSql = columns
            .map((c) =>
              policy === 'UPDATE_EMPTY_ONLY' ? `${c} = COALESCE(${c}, ?)` : `${c} = ?`,
            )
            .join(', ');
          db.prepare(`UPDATE items SET ${setSql}, updated_at = ?, updated_by = ? WHERE apparel_id = ?`).run(
            ...columns.map((c) => (prepared.values[c] ?? null) as never),
            now,
            actor,
            apparelId,
          );
        }
        report.updated += 1;
        touched.push(apparelId);
        report.rows.push({ line: lineNo, apparel_id: apparelId, outcome: 'UPDATED', detail: policy });
      } else {
        if (!dryRun) {
          prepared.values.import_id = importId;
          prepared.values.created_at = now;
          prepared.values.updated_at = now;
          prepared.values.updated_by = actor;
          prepared.values.review_state = prepared.flagged ? 'NEEDS_REVIEW' : 'NEW';
          db.prepare(
            `INSERT INTO items (${INSERT_COLUMNS.join(', ')})
             VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`,
          ).run(...INSERT_COLUMNS.map((c) => (prepared.values[c] ?? null) as never));
        }
        report.inserted += 1;
        touched.push(apparelId);
        report.rows.push({ line: lineNo, apparel_id: apparelId, outcome: 'INSERTED', detail: null });
      }

      if (prepared.flagged) report.flagged += 1;
    });

    if (!dryRun && importId !== null) {
      const insertRow = db.prepare(
        'INSERT INTO import_rows (import_id, line_no, apparel_id, outcome, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const r of report.rows.slice(0, 1000)) {
        insertRow.run(importId, r.line, r.apparel_id, r.outcome, r.detail, now);
      }
      db.prepare(
        `UPDATE imports SET rows_total = ?, rows_inserted = ?, rows_updated = ?, rows_skipped = ?,
                            rows_flagged = ?, rows_failed = ?, status = 'DONE', report_json = ?
          WHERE id = ?`,
      ).run(
        report.total,
        report.inserted,
        report.updated,
        report.skipped,
        report.flagged,
        report.failed,
        JSON.stringify({ policy, flagged: report.flagged }),
        importId,
      );
    }
  });

  work();

  if (dryRun) return report;

  // Steps 6-9 run after the ledger is committed: they read the rows that were just
  // written, and none of them can invalidate the import if they fail.
  report.enrichment = enrichFromScans(touched);
  report.duplicatesFlagged = detectDuplicates(touched);
  recomputeSuggestions(touched);
  for (const id of touched) refreshReviewState(id);

  audit(actor, 'IMPORT', 'import', String(report.importId), null, {
    filename,
    inserted: report.inserted,
    updated: report.updated,
    skipped: report.skipped,
  });

  return report;
}

export function recentImports(limit = 50) {
  return openDashboardDb().prepare('SELECT * FROM imports ORDER BY id DESC LIMIT ?').all(limit);
}

/** The import log keeps 10 days or 1 000 rows, whichever is larger (plan §11.2). */
export function importRows(importId: number, limit = 1000) {
  return openDashboardDb()
    .prepare('SELECT * FROM import_rows WHERE import_id = ? ORDER BY line_no LIMIT ?')
    .all(importId, limit);
}

export function pruneImportRows(): void {
  const cutoff = Date.now() - 10 * 24 * 3600_000;
  openDashboardDb()
    .prepare(
      `DELETE FROM import_rows
        WHERE created_at < ?
          AND id NOT IN (SELECT id FROM import_rows ORDER BY id DESC LIMIT 1000)`,
    )
    .run(cutoff);
}

export { V1_HEADERS, V2_OPTIONAL, PROTECTED_ON_OVERWRITE };
