/**
 * The client's taxonomy tables: canonical English key, Armenian label, numeric id.
 *
 * api_contract.md section 4.6 forbids shipping a hardcoded copy, because a supervisor
 * can add a row mid-shift and the app must pick it up without a release. It also
 * requires the app to keep working from cache when the server is unreachable. Those
 * two rules together give three tiers, most authoritative first:
 *
 *   1. the server's `GET /api/v1/reference-tables`, cached with its `version` so
 *      `If-None-Match` makes the call free on every login;
 *   2. that cache, when the server cannot be reached;
 *   3. the CSVs compiled in from src/data/reference_data, so a device that has never
 *      reached the server still has all 1,479 entries.
 *
 * The bundle is a seed and a floor, never a ceiling: a served table always replaces it
 * wholesale. dev.outfit.am is still on contract v1.2 and answers 404 here, so tier 3 is
 * the live path today rather than a theoretical fallback.
 */
import brandCsv from './reference_data/brand.csv?raw';
import categoryCsv from './reference_data/category.csv?raw';
import colorCsv from './reference_data/color.csv?raw';
import countryCsv from './reference_data/country.csv?raw';
import genderCsv from './reference_data/gender.csv?raw';
import materialCsv from './reference_data/material.csv?raw';
import seasonCsv from './reference_data/season.csv?raw';
import subCategoryCsv from './reference_data/sub-category.csv?raw';

export type TableName =
  | 'category'
  | 'sub_category'
  | 'brand'
  | 'country'
  | 'material'
  | 'color'
  | 'gender'
  | 'season';

export interface RefEntry {
  /** The canonical key - the only value ever stored, exported or transmitted. */
  en: string;
  /** The Armenian label to display. `null` means show the English word. */
  hy: string | null;
  /** The client's own id, stable across versions. */
  id: number | null;
}

export interface RefTable {
  bilingual: boolean;
  entries: RefEntry[];
}

export type ReferenceTables = Record<TableName, RefTable>;

export interface ReferenceSnapshot {
  version: string;
  generatedAt: string;
  /** Where this copy came from, for display in Settings. */
  origin: 'server' | 'bundle';
  tables: ReferenceTables;
}

/**
 * Column layout of each bundled CSV. The files are the client's own exports and do
 * not share a header convention, so each one is named explicitly rather than guessed
 * at - a heuristic that silently picked the wrong column would corrupt every export.
 */
const CSV_LAYOUT: Record<TableName, { csv: string; en: string; hy?: string; id?: string }> = {
  category: { csv: categoryCsv, en: 'Category_English', hy: 'Category_Armenian', id: 'Category_id' },
  sub_category: { csv: subCategoryCsv, en: 'SubGroup_English', hy: 'SubGroup_Armenian', id: 'Subcategory_id' },
  brand: { csv: brandCsv, en: 'Brand', id: 'Brand_id' },
  country: { csv: countryCsv, en: 'Country_English', id: 'id' },
  material: { csv: materialCsv, en: 'Material_English', hy: 'Material_Armenian', id: 'Material_id' },
  color: { csv: colorCsv, en: 'Color_English', hy: 'Color_armenian', id: 'Color_id' },
  gender: { csv: genderCsv, en: 'Gender_English', hy: 'Gender_Armenian', id: 'Gender_id' },
  season: { csv: seasonCsv, en: 'Season_English', hy: 'Season_Armenian', id: 'Season_id' }
};

/** brand and country are English everywhere including the paperwork (client decision 2026-08-30). */
const BILINGUAL: Record<TableName, boolean> = {
  category: true,
  sub_category: true,
  brand: false,
  country: false,
  material: true,
  color: true,
  gender: true,
  season: true
};

export const TABLE_NAMES = Object.keys(CSV_LAYOUT) as TableName[];

/** Minimal RFC 4180 row splitter - enough for these files, which do quote some names. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function parseCsvTable(name: TableName): RefTable {
  const layout = CSV_LAYOUT[name];
  // Every one of these files is UTF-8 with a BOM; left in place it becomes part of
  // the first header name and the English column stops resolving.
  const text = layout.csv.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { bilingual: BILINGUAL[name], entries: [] };

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const enIdx = header.indexOf(layout.en);
  const hyIdx = layout.hy ? header.indexOf(layout.hy) : -1;
  const idIdx = layout.id ? header.indexOf(layout.id) : -1;

  if (enIdx === -1) {
    console.error(`Reference table "${name}": no "${layout.en}" column in [${header.join(', ')}]`);
    return { bilingual: BILINGUAL[name], entries: [] };
  }

  const entries: RefEntry[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const en = (cells[enIdx] ?? '').trim();
    if (!en || seen.has(en.toLowerCase())) continue;
    seen.add(en.toLowerCase());

    const hy = hyIdx >= 0 ? (cells[hyIdx] ?? '').trim() : '';
    const rawId = idIdx >= 0 ? (cells[idIdx] ?? '').trim() : '';
    const id = rawId && /^\d+$/.test(rawId) ? Number(rawId) : null;

    entries.push({ en, hy: hy || null, id });
  }

  return { bilingual: BILINGUAL[name], entries };
}

let bundled: ReferenceSnapshot | null = null;

/** The compiled-in copy. Parsed once, on first use. */
export function getBundledTables(): ReferenceSnapshot {
  if (!bundled) {
    const tables = {} as ReferenceTables;
    for (const name of TABLE_NAMES) {
      tables[name] = parseCsvTable(name);
    }
    bundled = {
      version: 'bundled',
      generatedAt: new Date(0).toISOString(),
      origin: 'bundle',
      tables
    };
  }
  return bundled;
}

/** Shape of `GET /api/v1/reference-tables`. `category` is not among the served seven. */
export interface ReferenceTablesResponse {
  status?: string;
  version?: string;
  generated_at?: string;
  tables?: Partial<
    Record<
      TableName,
      { bilingual?: boolean; entries?: Array<{ en?: string; hy?: string | null; id?: number | null }> }
    >
  >;
}

/**
 * Folds a server payload onto the bundle. A table the server sends replaces its
 * bundled counterpart entirely (rows are only ever added or given a missing Armenian
 * label, so the server is always the fuller list); a table it omits - `category`, or
 * anything a partial deployment leaves out - keeps the bundled rows rather than
 * emptying a picker.
 */
export function mergeServerTables(payload: ReferenceTablesResponse): ReferenceSnapshot {
  const base = getBundledTables();
  const tables = {} as ReferenceTables;

  for (const name of TABLE_NAMES) {
    const served = payload.tables?.[name];
    const entries = (served?.entries ?? [])
      .map((e) => ({ en: (e.en ?? '').trim(), hy: e.hy?.trim() || null, id: e.id ?? null }))
      .filter((e) => e.en.length > 0);

    tables[name] =
      entries.length > 0
        ? { bilingual: served?.bilingual ?? BILINGUAL[name], entries }
        : base.tables[name];
  }

  return {
    version: payload.version || 'unknown',
    generatedAt: payload.generated_at || new Date().toISOString(),
    origin: 'server',
    tables
  };
}

// ---------------------------------------------------------------------------
// Lookup helpers. Everything is keyed on `en`; `hy` is only ever displayed.
// ---------------------------------------------------------------------------

export function englishKeys(table: RefTable | undefined): string[] {
  return (table?.entries ?? []).map((e) => e.en);
}

/**
 * The Armenian label for an English key, or the English key itself when the table
 * has no Armenian for it. Never returns a blank - contract section 8.3 rule 1.
 */
export function toArmenian(table: RefTable | undefined, en: string): string {
  if (!en) return '';
  if (!table) return en;
  const hit = table.entries.find((e) => e.en.toLowerCase() === en.toLowerCase());
  return hit?.hy || en;
}

/** True when the value is outside the table and should be flagged unmatched, not corrected. */
export function isUnmatched(table: RefTable | undefined, en: string): boolean {
  if (!en || !table || table.entries.length === 0) return false;
  return !table.entries.some((e) => e.en.toLowerCase() === en.toLowerCase());
}

export interface VocabHit {
  en: string;
  hy: string | null;
  /** What to show the operator: Armenian where it exists, English otherwise. */
  label: string;
}

/**
 * Type-ahead over one table. Searches the Armenian label AND the English key at once,
 * so an operator working in Armenian can still type a brand or a Latin fragment.
 * Prefix matches rank above substring matches.
 */
export function searchTable(table: RefTable | undefined, query: string, limit = 8): VocabHit[] {
  const entries = table?.entries ?? [];
  const toHit = (e: RefEntry): VocabHit => ({ en: e.en, hy: e.hy, label: e.hy || e.en });

  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(0, limit).map(toHit);

  const prefix: VocabHit[] = [];
  const contains: VocabHit[] = [];

  for (const e of entries) {
    const en = e.en.toLowerCase();
    const hy = (e.hy || '').toLowerCase();
    if (en.startsWith(q) || (hy && hy.startsWith(q))) {
      prefix.push(toHit(e));
      if (prefix.length >= limit) break;
    } else if (en.includes(q) || (hy && hy.includes(q))) {
      if (contains.length < limit) contains.push(toHit(e));
    }
  }

  return [...prefix, ...contains].slice(0, limit);
}
