import enumsData from '../data/taxonomy/enums.json';
import {
  referenceEntries,
  referenceVersion,
  type ReferenceTableName,
} from '../data/referenceTables';
import { joinComposition, splitComposition } from '../utils/composition';
import { logger } from '../utils/logger';
import {
  EXTRACTED_FIELDS,
  type ArmenianData,
  type ExtractedData,
  type ExtractedFieldName,
} from '../types';

/**
 * `data_hy` — the Armenian rendering of one extraction (api_contract.md v1.4
 * §4.2, §8.3).
 *
 * Still not a translator. Every value here is a **lookup** against the client's
 * own reference tables; a term with no row comes back `null` and the app shows
 * the English word, which is the rule the whole system already follows
 * (dev_report.md §26).
 *
 * ## Why the reference catalogue and not the legal map
 *
 * There are two Armenian sources in this repo, and they are not interchangeable:
 *
 * | Source | What it is |
 * |---|---|
 * | `reference_data/*.csv` (this module) | The seven client tables, versioned, supervisor-editable, already served to the app by `GET /api/v1/reference-tables` |
 * | `data/legalArmenianMap.json` (`exportService`) | Customs declaration wording, built offline from `translations.csv` |
 *
 * `data_hy` uses the reference catalogue, for three reasons:
 *
 *  1. **App and server cannot disagree.** `data_hy` exists to save the device a
 *     lookup it would otherwise do itself, against exactly these tables. Sourcing
 *     it anywhere else would mean the AI result and the picker beside it could
 *     show the same value two different ways.
 *  2. **A supervisor edit propagates without a redeploy.** The reference CSVs are
 *     written live through `referenceService`; the legal map is a build artefact
 *     of `npm run convert:translations`.
 *  3. **Coverage.** The legal map holds 140 terms and has no row for `Trousers`,
 *     `Women` or `All Seasons`. The catalogue covers all 295 sub-categories, 85
 *     materials, 26 colours, 7 genders and 5 seasons.
 *
 * The legal map is not wrong — it is the *paperwork* wording, and it may
 * legitimately differ from what an operator reads on a screen. It keeps its job
 * in `exportService`; the two are never mixed.
 *
 * `category` is the single exception, and it is a data gap rather than a
 * decision: the client's workbook has no category sheet, so the three keys live
 * in `enums.json` (dev_report.md §24.5) and their Armenian lives there with them.
 */

/** Which reference table supplies the Armenian for each translatable field. */
const FIELD_TABLE: Partial<Record<ExtractedFieldName, ReferenceTableName>> = {
  color: 'color',
  sub_category: 'sub_category',
  gender: 'gender',
  season: 'season',
  material: 'material',
};

/**
 * The seven keys that are `null` by contract, not by lookup failure:
 * `brand_name` and `country_of_origin` are English everywhere including on the
 * paperwork (client decision, 2026-08-30), and the rest are free text — a size,
 * a price, two scale readings and a URL. Listing them makes the rule checkable
 * instead of implied by the absence of a table.
 */
export const NEVER_TRANSLATED: readonly ExtractedFieldName[] = [
  'brand_name',
  'country_of_origin',
  'size',
  'original_price',
  'netto',
  'brutto',
  'care_info',
];

interface CachedLookups {
  version: string;
  tables: Map<ReferenceTableName, Map<string, string>>;
}

let cache: CachedLookups | null = null;

/**
 * English key -> Armenian label for one table.
 *
 * Keyed on the reference version, so a supervisor's `SET_ARMENIAN` reaches the
 * next response without a restart — the same reason `FuzzyIndex.rebuild()`
 * exists. Lookup is case-insensitive because an unmatched value reaches us as
 * the model transcribed it.
 */
function lookupTable(name: ReferenceTableName): Map<string, string> {
  const version = referenceVersion();
  if (!cache || cache.version !== version) {
    cache = { version, tables: new Map() };
  }

  const existing = cache.tables.get(name);
  if (existing) return existing;

  const built = new Map<string, string>();
  for (const entry of referenceEntries(name)) {
    if (entry.hy) built.set(entry.en.trim().toLowerCase(), entry.hy);
  }
  cache.tables.set(name, built);
  return built;
}

/** Armenian for one canonical English term, or null when the table has no row. */
export function armenianFor(field: ExtractedFieldName, value: string): string | null {
  const term = value.trim();
  if (!term) return null;

  if (field === 'category') return categoryArmenian(term);

  const table = FIELD_TABLE[field];
  if (!table) return null;

  return lookupTable(table).get(term.toLowerCase()) ?? null;
}

interface CategoryEnumEntry {
  key: string;
  hy?: string;
}

function categoryArmenian(term: string): string | null {
  const entries = (enumsData as { category?: (string | CategoryEnumEntry)[] }).category ?? [];
  const needle = term.toLowerCase();
  for (const entry of entries) {
    if (typeof entry === 'string') continue;
    if (entry.key.toLowerCase() === needle) return entry.hy ?? null;
  }
  return null;
}

/**
 * `material` is a composition, not a table key, so it is rendered per fibre —
 * the same segmentation the English normalisation uses.
 *
 * Unlike the English value, the Armenian is rejoined with commas rather than the
 * label's own punctuation: the source spacing is an artefact of how the label
 * was printed, and the operator is reading this rendering, not checking it
 * against the tag. A fibre with no Armenian row keeps its English name inside
 * the string, which is the display rule applied one level down.
 *
 * Returns null when the composition yields nothing translatable at all, so the
 * app falls back to the whole English string rather than showing a half-empty
 * one.
 */
export function armenianComposition(composition: string): string | null {
  const segments = splitComposition(composition);
  if (segments.length === 0) return null;

  const table = lookupTable('material');
  const { text, missing } = joinComposition(segments, (fibre) =>
    table.get(fibre.trim().toLowerCase()) ?? null,
  );

  const fibres = segments.filter((segment) => segment.fibre).length;
  if (fibres === 0 || missing.length === fibres) return null;

  if (missing.length > 0) {
    logger.debug(
      `No Armenian label for fibre(s) ${missing.map((f) => `"${f}"`).join(', ')}; ` +
        'left in English inside the composition.',
    );
  }

  return text;
}

/**
 * Builds `data_hy` for one extraction.
 *
 * Always all 13 keys — the same discipline `data` follows. A key is `null` when
 * the field is never translated, when the value is empty, or when the tables
 * have no row for it; the app displays the English value in every one of those
 * cases (api_contract.md §8.3 rule 1). Nothing here is ever stored, exported or
 * accepted back from a client.
 */
export function buildArmenianData(data: ExtractedData): ArmenianData {
  const armenian = {} as ArmenianData;

  for (const field of EXTRACTED_FIELDS) {
    if (NEVER_TRANSLATED.includes(field)) {
      armenian[field] = null;
      continue;
    }

    const value = data[field]?.value?.trim() ?? '';
    if (!value) {
      armenian[field] = null;
      continue;
    }

    armenian[field] =
      field === 'material' ? armenianComposition(value) : armenianFor(field, value);
  }

  return armenian;
}
