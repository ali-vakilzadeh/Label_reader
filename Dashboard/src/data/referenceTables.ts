import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import Fuse from 'fuse.js';
import { config } from '../config/env';

/**
 * The client's taxonomy tables (plan §6.1).
 *
 * Loaded from the middleware's reference_data/ — one shared copy, so the English text the
 * middleware snapped to and the numeric id the dashboard exports can never drift apart.
 *
 * The seven files have inconsistent headers (`Color_armenian` vs `Gender_Armenian`,
 * `Country_English,id`, trailing empty columns, differing column order) and all carry a
 * UTF-8 BOM. Rather than seven parsers, headers are matched by substring.
 */

export interface RefEntry {
  english: string;
  armenian: string | null;
  id: number | null;
}

export interface RefTable {
  key: TaxonomyKey;
  file: string;
  rows: RefEntry[];
  byEnglish: Map<string, RefEntry>;
  byArmenian: Map<string, RefEntry>;
  hasArmenian: boolean;
  fuse: Fuse<RefEntry>;
  loadedAt: number;
  fileMtime: number;
}

export const TAXONOMY_KEYS = [
  'brand',
  'category',
  'sub_category',
  'gender',
  'season',
  'color',
  'material',
  'country',
] as const;
export type TaxonomyKey = (typeof TAXONOMY_KEYS)[number];

/** Which file each dimension lives in, and which directory owns it. */
const SOURCES: Record<TaxonomyKey, { file: string; local?: boolean }> = {
  brand: { file: 'brand.csv' },
  sub_category: { file: 'sub-category.csv' },
  country: { file: 'country.csv' },
  material: { file: 'material.csv' },
  color: { file: 'color.csv' },
  gender: { file: 'gender.csv' },
  season: { file: 'season.csv' },
  // No client table exists for category; this project supplies one. See plan §6.1.
  category: { file: 'category.csv', local: true },
};

export const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  return parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true });
}

/** Find a column whose header contains `needle`, ignoring case and the empty trailing ones. */
function pickColumn(headers: string[], needle: string): string | null {
  const hit = headers.find((h) => h && h.toLowerCase().includes(needle));
  return hit ?? null;
}

interface Unreadable {
  /** `absent` = something on the path is not there. `denied` = it is there and we cannot get at it. */
  kind: 'absent' | 'denied' | 'error';
  /** A sentence completing "<file> …", naming the component that actually blocks. */
  detail: string;
}

/**
 * Why a file cannot be read — or null when it can.
 *
 * `fs.existsSync` answers `false` for a file that is present but unreachable: EACCES on the
 * file itself, or a missing search bit on any directory above it. Every one of those cases
 * used to be reported as a missing table, which sends whoever reads the message looking for
 * the wrong thing — a redeploy instead of a `chmod`, or a `chmod` instead of a typo in
 * `.env`. Walking the path root-first names the component that blocks, so the three are
 * told apart at the point of failure. See setup.md §15.
 */
function whyUnreadable(file: string): Unreadable | null {
  const target = path.resolve(file);

  const chain: string[] = [];
  for (let p = target; ; p = path.dirname(p)) {
    chain.unshift(p);
    if (path.dirname(p) === p) break;
  }

  for (const p of chain) {
    const leaf = p === target;
    try {
      // A directory needs only its search bit to be traversed; the leaf needs read.
      fs.accessSync(p, leaf ? fs.constants.R_OK : fs.constants.X_OK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'EACCES';
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return {
          kind: 'absent',
          detail: leaf
            ? 'is not there'
            : `is not there — the directory ${p} does not exist, so check the configured path for a typo`,
        };
      }
      if (code === 'EACCES' || code === 'EPERM') {
        const who =
          process.getuid && process.getgid
            ? `this process (uid ${process.getuid()}, gid ${process.getgid()})`
            : 'this process';
        return {
          kind: 'denied',
          detail: leaf
            ? `exists but ${who} may not read it — a permissions problem, not a missing file (setup.md §6.2)`
            : `exists but ${who} may not traverse ${p} — a permissions problem, not a missing file (setup.md §6.2)`,
        };
      }
      return { kind: 'error', detail: `could not be opened: ${code} at ${p}` };
    }
  }
  return null;
}

function loadTable(key: TaxonomyKey): RefTable {
  const src = SOURCES[key];
  const dir = src.local ? config.localReferenceDir : config.referenceDataDir;
  const envVar = src.local ? 'LOCAL_REFERENCE_DIR' : 'REFERENCE_DATA_DIR';
  const file = path.join(dir, src.file);
  const problem = whyUnreadable(file);
  if (problem) {
    throw new Error(
      `Reference table ${key}: ${file} ${problem.detail}. That path comes from ${envVar} ` +
        `in .env. The dashboard cannot start without the client's taxonomy tables.`,
    );
  }

  const raw = readCsv(file);
  const headers = raw.length ? Object.keys(raw[0]) : [];
  const enCol = pickColumn(headers, 'english') ?? pickColumn(headers, key.replace('_', '')) ?? headers[0];
  const amCol = pickColumn(headers, 'armenian');
  const idCol = pickColumn(headers, '_id') ?? pickColumn(headers, 'id');

  const rows: RefEntry[] = [];
  const byEnglish = new Map<string, RefEntry>();
  const byArmenian = new Map<string, RefEntry>();

  for (const r of raw) {
    const english = (enCol ? r[enCol] : '')?.trim();
    if (!english) continue;
    const armenianRaw = amCol ? r[amCol]?.trim() : '';
    const idRaw = idCol ? r[idCol]?.trim() : '';
    const idNum = idRaw ? Number(idRaw) : NaN;
    const entry: RefEntry = {
      english,
      armenian: armenianRaw ? armenianRaw : null,
      id: Number.isFinite(idNum) ? idNum : null,
    };
    rows.push(entry);
    if (!byEnglish.has(norm(english))) byEnglish.set(norm(english), entry);
    if (entry.armenian && !byArmenian.has(norm(entry.armenian))) byArmenian.set(norm(entry.armenian), entry);
  }

  // Armenian is only "available" if some row carries text that differs from the English.
  // gender.csv and season.csv legitimately hold English in the Armenian column for
  // `Unisex` and `All Seasons` — that is the fallback rule working, not a missing table.
  const hasArmenian = rows.some((r) => r.armenian && norm(r.armenian) !== norm(r.english));

  return {
    key,
    file,
    rows,
    byEnglish,
    byArmenian,
    hasArmenian,
    fuse: new Fuse(rows, {
      keys: ['english'],
      includeScore: true,
      threshold: 0.35,
      ignoreLocation: true,
      minMatchCharLength: 2,
    }),
    loadedAt: Date.now(),
    fileMtime: fs.statSync(file).mtimeMs,
  };
}

let tables: Record<TaxonomyKey, RefTable> | null = null;

export function loadReferenceTables(): Record<TaxonomyKey, RefTable> {
  const loaded = {} as Record<TaxonomyKey, RefTable>;
  for (const key of TAXONOMY_KEYS) loaded[key] = loadTable(key);
  tables = loaded;
  return loaded;
}

export function refTables(): Record<TaxonomyKey, RefTable> {
  if (!tables) return loadReferenceTables();
  return tables;
}

export function refTable(key: TaxonomyKey): RefTable {
  return refTables()[key];
}

/* ------------------------------------------------------------------ *
 * custom_codes.csv — the CN nomenclature, dashboard-owned.
 * All 951 headings for now; the client is narrowing it to the required
 * rows. Nothing here depends on how many rows there are.
 * ------------------------------------------------------------------ */

export interface CustomsCode {
  id: string;
  cnKey: string;
  code: string;
  name: string;
}

let customsCodes: CustomsCode[] | null = null;
let customsByCode: Map<string, CustomsCode> | null = null;
let customsFuse: Fuse<CustomsCode> | null = null;

export function loadCustomsCodes(): CustomsCode[] {
  const file = path.join(config.localReferenceDir, 'custom_codes.csv');
  const problem = whyUnreadable(file);
  if (problem) {
    console.warn(`[reference] custom_codes.csv ${problem.detail} (${file}) — the HS code picker will be empty.`);
    customsCodes = [];
  } else {
    customsCodes = readCsv(file)
      .map((r) => ({
        id: String(r.ID ?? '').trim(),
        cnKey: String(r.CN_Key ?? '').trim(),
        code: String(r.CN_Code ?? '').trim(),
        name: String(r.Name ?? '').trim(),
      }))
      .filter((c) => c.code);
  }
  customsByCode = new Map(customsCodes.map((c) => [c.code, c]));
  customsFuse = new Fuse(customsCodes, {
    keys: ['name', 'code'],
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });
  return customsCodes;
}

export function customsCodeList(): CustomsCode[] {
  if (!customsCodes) loadCustomsCodes();
  return customsCodes!;
}

/** The heading name for a code, so a value can always be sanity-checked in words. */
export function customsCodeName(code: string | null): string | null {
  if (!code) return null;
  if (!customsByCode) loadCustomsCodes();
  return customsByCode!.get(code)?.name ?? null;
}

/**
 * Free-text search over the nomenclature. This backs the *picker* — a human choosing from
 * a legal list. It is deliberately not wired into the HS suggestion engine: an automatic
 * text match across 951 headings would confidently return the wrong chapter, and an HS
 * code is a legal declaration. See plan §8.3.
 */
export function searchCustomsCodes(query: string, limit = 25): CustomsCode[] {
  if (!customsFuse) loadCustomsCodes();
  const q = query.trim();
  if (!q) return customsCodeList().slice(0, limit);
  if (/^\d{2,}$/.test(q)) {
    return customsCodeList()
      .filter((c) => c.code.startsWith(q))
      .slice(0, limit);
  }
  return customsFuse!.search(q, { limit }).map((r) => r.item);
}

/* ------------------------------------------------------------------ *
 * hs_map.csv — the rule matrix, hand-authored by the client.
 * Ships empty; the rule tier stays dormant until it is filled.
 * ------------------------------------------------------------------ */

export interface HsRule {
  subCategory: string;
  gender: string | null;
  materialClass: string | null;
  nettoGMax: number | null;
  cnCode: string;
  note: string | null;
}

let hsRules: HsRule[] | null = null;

export function loadHsRules(): HsRule[] {
  const file = path.join(config.localReferenceDir, 'hs_map.csv');
  const problem = whyUnreadable(file);
  if (problem) {
    // Absent is by design — the table ships empty and the rule tier stays dormant. Present
    // but unreadable is not, and would otherwise look identical from the UI.
    if (problem.kind !== 'absent') {
      console.warn(`[reference] hs_map.csv ${problem.detail} (${file}) — the rule tier stays dormant.`);
    }
    hsRules = [];
    return hsRules;
  }
  hsRules = readCsv(file)
    .map((r) => ({
      subCategory: String(r.sub_category_en ?? '').trim(),
      gender: String(r.gender ?? '').trim() || null,
      materialClass: String(r.material_class ?? '').trim() || null,
      nettoGMax: r.netto_g_max && String(r.netto_g_max).trim() ? Number(r.netto_g_max) : null,
      cnCode: String(r.cn_code ?? '').trim(),
      note: String(r.note ?? '').trim() || null,
    }))
    .filter((r) => r.subCategory && r.cnCode);
  return hsRules;
}

export function hsRuleList(): HsRule[] {
  if (!hsRules) loadHsRules();
  return hsRules!;
}

export function reloadAllReferenceData(): void {
  loadReferenceTables();
  loadCustomsCodes();
  loadHsRules();
}

export function referenceSummary(): Array<{ key: string; file: string; rows: number; armenian: boolean; mtime: number }> {
  const t = refTables();
  const out: Array<{ key: string; file: string; rows: number; armenian: boolean; mtime: number }> =
    TAXONOMY_KEYS.map((k) => ({
    key: k as string,
    file: t[k].file,
    rows: t[k].rows.length,
    armenian: t[k].hasArmenian,
    mtime: t[k].fileMtime,
  }));
  out.push({
    key: 'customs_codes',
    file: path.join(config.localReferenceDir, 'custom_codes.csv'),
    rows: customsCodeList().length,
    armenian: false,
    mtime: 0,
  });
  out.push({
    key: 'hs_map',
    file: path.join(config.localReferenceDir, 'hs_map.csv'),
    rows: hsRuleList().length,
    armenian: false,
    mtime: 0,
  });
  return out;
}
