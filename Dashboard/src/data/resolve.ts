import { config } from '../config/env';
import { norm, refTable, type TaxonomyKey } from './referenceTables';

/**
 * Taxonomy resolution and the bilingual layer (plan §6.2, §6.3).
 *
 * Two rules govern everything in this file:
 *
 *  1. The only algorithm allowed to change a value is the one below, and below its
 *     threshold it changes nothing — it keeps the operator's text and flags the row.
 *     A wrong table entry is worse than an unmatched one.
 *
 *  2. The application never translates. It looks up, or it returns the English word.
 *     Never blank, never machine-translated, never transliterated.
 */

export type MatchSource = 'LOOKUP' | `FUZZY:${string}` | 'UNMATCHED';

export interface Resolution {
  /** The value to store. Either the canonical English entry, or the input unchanged. */
  value: string;
  id: number | null;
  src: MatchSource;
  /** Present only for a fuzzy hit: what the input actually said. */
  original?: string;
}

export function resolveTaxonomy(key: TaxonomyKey, input: string | null): Resolution | null {
  if (!input) return null;
  const table = refTable(key);
  const raw = input.trim();
  if (!raw) return null;

  // 1. Exact match against the English column.
  const exact = table.byEnglish.get(norm(raw));
  if (exact) return { value: exact.english, id: exact.id, src: 'LOOKUP' };

  // 2. Armenian input — the client's own spreadsheets are Armenian, so accept them and
  //    reverse-map to English canonical. Same rule in the other direction (plan §6.3).
  const viaArmenian = table.byArmenian.get(norm(raw));
  if (viaArmenian) return { value: viaArmenian.english, id: viaArmenian.id, src: 'LOOKUP' };

  // 3. Fuzzy, over the English column only.
  //    Fuse scores are distances: 0 is perfect. similarity = 1 - score.
  const hit = table.fuse.search(raw, { limit: 1 })[0];
  if (hit && typeof hit.score === 'number') {
    const similarity = 1 - hit.score;
    if (similarity >= config.fuzzyMinSimilarity) {
      return {
        value: hit.item.english,
        id: hit.item.id,
        src: `FUZZY:${similarity.toFixed(2)}` as MatchSource,
        original: raw,
      };
    }
  }

  // 4. Nothing close enough. Keep what the operator wrote; the row goes to review.
  return { value: raw, id: null, src: 'UNMATCHED' };
}

export type Locale = 'en' | 'hy';

/**
 * The English value as it should be displayed in `locale`.
 *
 * Falls back to the English word whenever an Armenian one does not exist — for a missing
 * translation, for an unmatched value, and for `brand` and `country`, which the client
 * confirmed are always written in English including on paperwork (plan §6.3).
 */
export function localised(key: TaxonomyKey, englishValue: string | null, locale: Locale): string {
  if (!englishValue) return '';
  if (locale === 'en') return englishValue;
  const entry = refTable(key).byEnglish.get(norm(englishValue));
  return entry?.armenian || englishValue;
}

/** Fields that always render English regardless of locale, by client instruction. */
export const ALWAYS_ENGLISH: ReadonlySet<TaxonomyKey> = new Set<TaxonomyKey>(['brand', 'country']);

export function isTranslatable(key: TaxonomyKey): boolean {
  return !ALWAYS_ENGLISH.has(key) && refTable(key).hasArmenian;
}

/** Distinct English values of a dimension, for filter dropdowns. */
export function optionsFor(key: TaxonomyKey, locale: Locale): Array<{ value: string; label: string }> {
  return refTable(key)
    .rows.map((r) => ({
      value: r.english,
      label: locale === 'hy' && !ALWAYS_ENGLISH.has(key) ? r.armenian || r.english : r.english,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/* -------------------------------------------------------------- *
 * field_src_json helpers — provenance for every stored value.
 * -------------------------------------------------------------- */

export type FieldSrc = Record<string, string>;

export function parseFieldSrc(json: string | null): FieldSrc {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as FieldSrc) : {};
  } catch {
    return {};
  }
}

export function unmatchedFields(src: FieldSrc): string[] {
  return Object.entries(src)
    .filter(([, v]) => v === 'UNMATCHED')
    .map(([k]) => k);
}

export function fuzzyFields(src: FieldSrc): string[] {
  return Object.entries(src)
    .filter(([, v]) => typeof v === 'string' && v.startsWith('FUZZY:'))
    .map(([k]) => k);
}
