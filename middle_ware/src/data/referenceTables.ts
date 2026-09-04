import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Client reference tables.
 *
 * These CSVs are the single source of truth, shared with the dashboard and
 * edited by hand. Each carries an English column, most carry an Armenian column
 * and a numeric id.
 *
 * **The middleware's own vocabulary is still English only.** Extraction, the
 * matcher, the stored scan and every value on the wire in `data` use the English
 * column and nothing else. The Armenian column is loaded for one purpose: to be
 * *published verbatim* to the Android app through `GET /api/v1/reference-tables`
 * (api_contract.md v1.3 §4.6), so an operator can read and choose in Armenian
 * while the value that gets stored stays the canonical English key.
 *
 * That is a lookup, never a translation. Nothing in this server translates text,
 * and nothing asks the model to. See dev_report.md §26.
 *
 * The files are read from disk at boot rather than compiled in, so a table can
 * be corrected by editing the file and reloading. That is the whole point of
 * committing them as data instead of code.
 */

export const REFERENCE_DIR = path.join(ROOT_DIR, 'reference_data');

export type ReferenceTableName =
  | 'sub_category'
  | 'brand'
  | 'country'
  | 'material'
  | 'color'
  | 'gender'
  | 'season';

/** One row of a reference table, as published to the device. */
export interface ReferenceEntry {
  /** Canonical English key. The only value ever stored or sent in scan data. */
  en: string;
  /** Client-supplied Armenian label, or null when the table has no Armenian. */
  hy: string | null;
  /** The client's own numeric id, or null when the row has none. */
  id: number | null;
}

interface TableSpec {
  file: string;
  /**
   * False for `brand` and `country`: the client writes both in English
   * everywhere, including on the paperwork (decision of 2026-08-30). Their CSVs
   * have no Armenian column and no Armenian column will be added.
   */
  bilingual: boolean;
}

export const REFERENCE_FILES: Record<ReferenceTableName, TableSpec> = {
  sub_category: { file: 'sub-category.csv', bilingual: true },
  brand: { file: 'brand.csv', bilingual: false },
  country: { file: 'country.csv', bilingual: false },
  material: { file: 'material.csv', bilingual: true },
  color: { file: 'color.csv', bilingual: true },
  gender: { file: 'gender.csv', bilingual: true },
  season: { file: 'season.csv', bilingual: true },
};

export const REFERENCE_TABLE_NAMES = Object.keys(REFERENCE_FILES) as ReferenceTableName[];

/**
 * Minimal RFC-4180 reader. The client's files really do contain quoted commas
 * ("Hello, By Loggi"), so splitting on commas would silently corrupt entries.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  // Strip a UTF-8 BOM so the first header name is not "﻿Brand".
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Inverse of parseCsv. Quotes only the cells that need it. */
export function serialiseCsv(rows: string[][], lineEnding: string, bom: boolean): string {
  const body = rows
    .map((row) => row.map(csvCell).join(','))
    .join(lineEnding);
  return (bom ? '﻿' : '') + body + lineEnding;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Column layout of one file.
 *
 * The client's seven files have seven different header conventions
 * (`SubGroup_Armenian`, `Color_armenian`, a bare `id`, a trailing `Description`,
 * three trailing empty columns). Rather than hand-code seven parsers, headers
 * are matched on substrings, with the English column falling back to the first
 * column that is neither the Armenian one nor the id — which is how `brand.csv`
 * (`Brand,Brand_id`) resolves without an "english" header at all.
 */
interface Layout {
  english: number;
  armenian: number | null;
  id: number | null;
  /** Header cells exactly as they appear, so a rewrite preserves them. */
  header: string[];
}

function resolveLayout(header: string[], fileName: string): Layout {
  let armenian: number | null = null;
  let id: number | null = null;
  let english: number | null = null;

  header.forEach((raw, index) => {
    const name = raw.trim().toLowerCase();
    if (!name) return;
    if (armenian === null && name.includes('armenian')) armenian = index;
    else if (id === null && (name === 'id' || name.endsWith('_id'))) id = index;
    else if (english === null && name.includes('english')) english = index;
  });

  if (english === null) {
    // brand.csv: "Brand,Brand_id" — the English column names no language.
    const fallback = header.findIndex(
      (raw, index) => raw.trim() !== '' && index !== armenian && index !== id,
    );
    if (fallback !== -1) english = fallback;
  }

  if (english === null) {
    throw new Error(
      `Reference table ${fileName} has no usable English column. Header: ${header.join(', ')}`,
    );
  }

  return { english, armenian, id, header };
}

interface LoadedTable {
  name: ReferenceTableName;
  file: string;
  entries: ReferenceEntry[];
  layout: Layout;
  /** Every row as parsed, header included, so a write can round-trip the file. */
  rows: string[][];
  lineEnding: string;
  bom: boolean;
}

function loadTable(name: ReferenceTableName): LoadedTable {
  const spec = REFERENCE_FILES[name];
  const filePath = path.join(REFERENCE_DIR, spec.file);

  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    // A missing reference table is a configuration fault, not a runtime blip:
    // without it every scan would come back as unmatched free text and quietly
    // fill the ledger with junk. Fail loudly at boot instead.
    throw new Error(
      `Reference table ${spec.file} could not be read from ${REFERENCE_DIR}. ` +
        `Deployments must ship the reference_data/ directory. (${String(error)})`,
    );
  }

  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error(`Reference table ${spec.file} is empty.`);

  const header = rows[0] ?? [];
  const layout = resolveLayout(header, spec.file);

  const entries: ReferenceEntry[] = [];
  const seen = new Set<string>();

  for (const row of rows.slice(1)) {
    const en = (row[layout.english] ?? '').trim();
    if (!en) continue;
    const key = en.toLowerCase();
    // The client's tables carry a few English duplicates (one id, several
    // spellings). First occurrence wins, exactly as it did before Armenian was
    // loaded, so the canonical key a device receives cannot change.
    if (seen.has(key)) continue;
    seen.add(key);

    const hy =
      layout.armenian === null ? null : ((row[layout.armenian] ?? '').trim() || null);
    const rawId = layout.id === null ? '' : (row[layout.id] ?? '').trim();
    const id = rawId !== '' && Number.isFinite(Number(rawId)) ? Number(rawId) : null;

    entries.push({ en, hy, id });
  }

  if (entries.length === 0) {
    throw new Error(`Reference table ${spec.file} produced no values.`);
  }

  return {
    name,
    file: spec.file,
    entries,
    layout,
    rows,
    lineEnding: text.includes('\r\n') ? '\r\n' : '\n',
    bom: text.charCodeAt(0) === 0xfeff,
  };
}

function loadAll(): Record<ReferenceTableName, LoadedTable> {
  const loaded = {} as Record<ReferenceTableName, LoadedTable>;
  for (const name of REFERENCE_TABLE_NAMES) loaded[name] = loadTable(name);
  return loaded;
}

/** Field separator that cannot occur in a table value. */
const SEP = String.fromCharCode(31);

let tables: Record<ReferenceTableName, LoadedTable> = loadAll();
let version = computeVersion(tables);
let loadedAt = Date.now();

/**
 * Content fingerprint of every table, published to the device as an ETag.
 *
 * Hashed over the parsed entries rather than the file bytes, so re-saving a CSV
 * with different line endings or a reordered comment does not invalidate every
 * device's cached copy — only a real change to a value does.
 */
function computeVersion(source: Record<ReferenceTableName, LoadedTable>): string {
  const hash = crypto.createHash('sha256');
  for (const name of REFERENCE_TABLE_NAMES) {
    hash.update(name);
    for (const entry of source[name].entries) {
      hash.update(SEP);
      hash.update(entry.en);
      hash.update(SEP);
      hash.update(entry.hy ?? '');
      hash.update(SEP);
      hash.update(entry.id === null ? '' : String(entry.id));
    }
  }
  return hash.digest('hex').slice(0, 16);
}

export function referenceVersion(): string {
  return version;
}

export function referenceLoadedAt(): number {
  return loadedAt;
}

export function referenceEntries(name: ReferenceTableName): readonly ReferenceEntry[] {
  return tables[name].entries;
}

export function isBilingual(name: ReferenceTableName): boolean {
  return REFERENCE_FILES[name].bilingual;
}

export interface TableCounts {
  rows: number;
  /** Rows carrying Armenian text. Equals `rows` when a table is fully translated. */
  armenian: number;
  bilingual: boolean;
}

export function referenceCounts(): Record<ReferenceTableName, TableCounts> {
  const counts = {} as Record<ReferenceTableName, TableCounts>;
  for (const name of REFERENCE_TABLE_NAMES) {
    const entries = tables[name].entries;
    counts[name] = {
      rows: entries.length,
      armenian: entries.filter((entry) => entry.hy !== null).length,
      bilingual: REFERENCE_FILES[name].bilingual,
    };
  }
  return counts;
}

/**
 * Re-reads every CSV from disk.
 *
 * On a parse failure the tables already in memory **stay in force** and the
 * error is returned to the caller. Same rule as the API credentials: a bad
 * candidate must never take a working server down, and half-loaded taxonomies
 * would silently start returning unmatched free text.
 */
export function reloadReferenceTables(): { ok: true; version: string } | { ok: false; error: string } {
  try {
    const reloaded = loadAll();
    tables = reloaded;
    version = computeVersion(reloaded);
    loadedAt = Date.now();
    logger.info(
      `Reference tables reloaded from ${REFERENCE_DIR} — version ${version}, ` +
        REFERENCE_TABLE_NAMES.map((name) => `${name}:${tables[name].entries.length}`).join(' '),
    );
    return { ok: true, version };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`Reference table reload failed; previous tables stay in force. ${detail}`);
    return { ok: false, error: detail };
  }
}

// ------------------------------------------------------------------- writes --

export interface RowWrite {
  /** English key of the row to touch. Matched case-insensitively. */
  english: string;
  armenian?: string;
  id?: number;
}

/**
 * Fills in the Armenian cell of an existing row, in place.
 *
 * Deliberately cannot change the English key: everything downstream — stored
 * scans, the dashboard's `*_id` joins, exports already sent to the client —
 * treats that key as stable. Renaming it here would orphan every record that
 * already carries it.
 */
export function writeArmenian(name: ReferenceTableName, write: RowWrite): void {
  const table = tables[name];
  const { layout } = table;
  if (layout.armenian === null) {
    throw new Error(`Reference table ${table.file} has no Armenian column.`);
  }

  const needle = write.english.trim().toLowerCase();
  let touched = 0;
  for (let i = 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    if (!row) continue;
    if ((row[layout.english] ?? '').trim().toLowerCase() !== needle) continue;
    padRow(row, layout.header.length);
    row[layout.armenian] = write.armenian ?? '';
    touched += 1;
  }

  if (touched === 0) {
    throw new Error(`No row in ${table.file} has English value "${write.english}".`);
  }
  persist(table);
}

/** Appends a new row. The English key must not already exist. */
export function appendRow(name: ReferenceTableName, write: RowWrite): void {
  const table = tables[name];
  const { layout } = table;

  const row: string[] = new Array(layout.header.length).fill('');
  row[layout.english] = write.english.trim();
  if (layout.armenian !== null) row[layout.armenian] = write.armenian?.trim() ?? '';
  if (layout.id !== null && write.id !== undefined) row[layout.id] = String(write.id);

  table.rows.push(row);
  persist(table);
}

function padRow(row: string[], width: number): void {
  while (row.length < width) row.push('');
}

/**
 * Rewrites the file atomically, keeping a timestamped copy of what it replaced.
 *
 * These are the client's hand-maintained tables, and on the VPS there is no git
 * to fall back on, so an automated writer keeps its own backups. Writing to a
 * temporary file and renaming means a crash mid-write cannot leave a truncated
 * table that would fail the next boot.
 */
function persist(table: LoadedTable): void {
  const filePath = path.join(REFERENCE_DIR, table.file);
  const text = serialiseCsv(table.rows, table.lineEnding, table.bom);

  backup(table.file, filePath);

  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, filePath);
}

const BACKUP_DIR = path.join(REFERENCE_DIR, '.backups');
const BACKUPS_KEPT = 20;

function backup(fileName: string, filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(filePath, path.join(BACKUP_DIR, `${fileName}.${stamp}.bak`));

    const mine = fs
      .readdirSync(BACKUP_DIR)
      .filter((entry) => entry.startsWith(`${fileName}.`))
      .sort();
    for (const stale of mine.slice(0, Math.max(0, mine.length - BACKUPS_KEPT))) {
      fs.rmSync(path.join(BACKUP_DIR, stale), { force: true });
    }
  } catch (error) {
    // A failed backup must not block the write the supervisor asked for; it is
    // belt-and-braces over git and the nightly VPS backup.
    logger.warn(`Could not back up ${fileName} before rewriting it: ${String(error)}`);
  }
}

// ------------------------------------------------------- English-only view --

/**
 * The English columns, which is all the matcher and the extraction pipeline ever
 * see. A live getter rather than a snapshot, so a reload reaches every consumer
 * without re-importing the module.
 */
export const referenceTables = {
  get subCategories(): string[] {
    return tables.sub_category.entries.map((entry) => entry.en);
  },
  get brands(): string[] {
    return tables.brand.entries.map((entry) => entry.en);
  },
  get countries(): string[] {
    return tables.country.entries.map((entry) => entry.en);
  },
  get materials(): string[] {
    return tables.material.entries.map((entry) => entry.en);
  },
  get colors(): string[] {
    return tables.color.entries.map((entry) => entry.en);
  },
  get genders(): string[] {
    return tables.gender.entries.map((entry) => entry.en);
  },
  get seasons(): string[] {
    return tables.season.entries.map((entry) => entry.en);
  },
};

logger.info(
  `Reference tables loaded from ${REFERENCE_DIR} — version ${version}, ` +
    REFERENCE_TABLE_NAMES.map((name) => `${name}:${tables[name].entries.length}`).join(' '),
);
