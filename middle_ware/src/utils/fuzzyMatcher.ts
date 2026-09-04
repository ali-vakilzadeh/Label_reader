import Fuse from 'fuse.js';
import type { IFuseOptions } from 'fuse.js';
import { referenceTables } from '../data/referenceTables';
import enumsData from '../data/taxonomy/enums.json';
import { mapComposition, splitComposition } from './composition';
import { logger } from './logger';

/**
 * Local fuzzy normalisation.
 *
 * Gemini returns free text ("Trousers", "Made in Viet Nam", "Navy Blue"); the
 * downstream ledger and the Armenian legal export both require exact enum keys.
 * Every index is built once at module load, so a lookup is a pure in-memory
 * search that lands well inside the 2 ms budget.
 *
 * The taxonomies are data-driven: extending sub_category from 14 to 253 options
 * is a change to src/data/taxonomy/subCategories.json only, never to this code.
 */

const CACHE_LIMIT = 5_000;
const ORIGIN_PREFIX = /^(made in|product of|manufactured in|origin|assembled in|fabrique en|made by)\s+/;

/** Collapses a normalised term to letters and digits only. */
function compact(input: string): string {
  return input.replace(/[^a-z0-9]/g, '');
}

export interface TaxonomyEntry {
  key: string;
  aliases: string[];
}

/**
 * Taxonomy files may list a plain string or an object with aliases. Most of the
 * client's 1,400+ entries need no aliases, and plain strings keep the JSON
 * readable and hand-editable — which is the point of committing them as data.
 *
 *   "Pants"
 *   { "key": "Pants", "aliases": ["Trousers", "Jeans"] }
 */
export type TaxonomySource =
  | string
  /**
   * `hy` is carried for `category` only — the one taxonomy with no client CSV,
   * so `enums.json` is where its Armenian label has to live too. The matcher
   * ignores it; `armenianService` reads it. See dev_report.md §24.5.
   */
  | { key: string; aliases?: string[]; hy?: string };

export function toEntries(source: TaxonomySource[]): TaxonomyEntry[] {
  return source.map((entry) =>
    typeof entry === 'string'
      ? { key: entry, aliases: [] }
      : { key: entry.key, aliases: entry.aliases ?? [] },
  );
}

/** Flattened search record: one row per (key, searchable term) pair. */
interface SearchRecord {
  key: string;
  term: string;
}

const FUSE_OPTIONS: IFuseOptions<SearchRecord> = {
  keys: ['term'],
  includeScore: true,
  threshold: 0.4, // 0 = exact, 1 = match anything
  ignoreLocation: true,
  minMatchCharLength: 2,
};

function normalise(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .replace(/[_/\u005c]+/g, ' ')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class FuzzyIndex {
  /** Exact normalised term -> canonical key. */
  private exact = new Map<string, string>();
  /** Whitespace/punctuation-stripped term -> canonical key ("viet nam" -> "vietnam"). */
  private compact = new Map<string, string>();
  /** Memoised results; label vocabularies repeat heavily in a scanning shift. */
  private cache = new Map<string, string | null>();
  private fuse: Fuse<SearchRecord>;
  /** Canonical keys, for exact membership tests. */
  private keys = new Set<string>();
  readonly label: string;
  size: number;

  constructor(entries: TaxonomyEntry[], label: string) {
    this.label = label;
    this.fuse = new Fuse<SearchRecord>([], FUSE_OPTIONS);
    this.size = 0;
    this.rebuild(entries);
  }

  /**
   * Replaces the whole index in place.
   *
   * In place matters: the seven indexes are module-level singletons imported by
   * the extraction pipeline, so swapping the object would leave every importer
   * pointing at the old tables. Reloading a CSV has to reach code that captured
   * the reference at import time.
   *
   * The memo cache is dropped with the index. Keeping it would let a term the
   * supervisor just corrected keep resolving to the answer it gave before.
   */
  rebuild(entries: TaxonomyEntry[]): void {
    const exact = new Map<string, string>();
    const compacted = new Map<string, string>();
    const keys = new Set<string>();
    const records: SearchRecord[] = [];

    for (const entry of entries) {
      keys.add(entry.key);
      for (const term of [entry.key, ...entry.aliases]) {
        const normalised = normalise(term);
        if (!normalised) continue;
        if (!exact.has(normalised)) exact.set(normalised, entry.key);
        const flattened = compact(normalised);
        if (flattened && !compacted.has(flattened)) compacted.set(flattened, entry.key);
        records.push({ key: entry.key, term: normalised });
      }
    }

    this.exact = exact;
    this.compact = compacted;
    this.keys = keys;
    this.cache = new Map();
    this.fuse = new Fuse(records, FUSE_OPTIONS);
    this.size = entries.length;
  }

  /**
   * Snaps free text onto a canonical key.
   * Returns null when nothing clears the similarity threshold — callers keep the
   * raw value rather than inventing a wrong enum.
   */
  match(raw: string): string | null {
    const cleaned = normalise(raw);
    if (!cleaned) return null;

    const cached = this.cache.get(cleaned);
    if (cached !== undefined) return cached;

    const result = this.resolve(cleaned);

    // Bounded memo: drop the oldest entry once the cap is reached.
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(cleaned, result);
    return result;
  }

  private resolve(cleaned: string): string | null {
    const exactHit = this.exact.get(cleaned);
    if (exactHit) return exactHit;

    // "Made in Vietnam" / "Fabrique en France" style prefixes.
    const stripped = cleaned.replace(ORIGIN_PREFIX, '');
    if (stripped !== cleaned) {
      const strippedHit = this.exact.get(stripped);
      if (strippedHit) return strippedHit;
    }

    const needle = stripped || cleaned;
    const compactHit = this.compact.get(compact(needle));
    if (compactHit) return compactHit;

    const [best] = this.fuse.search(needle, { limit: 1 });
    return best ? best.item.key : null;
  }

  /** True when the text is already an exact canonical key (case-insensitive). */
  isKnownKey(raw: string): boolean {
    return this.exact.get(normalise(raw)) === raw.trim() || this.keys.has(raw.trim());
  }

  /** Match, or fall back to the original text when no key is close enough. */
  matchOrKeep(raw: string): { value: string; matched: boolean } {
    const hit = this.match(raw);
    return hit ? { value: hit, matched: true } : { value: raw, matched: false };
  }
}

const enums = enumsData as Record<string, TaxonomySource[]>;

function requireEnum(name: string): TaxonomyEntry[] {
  const entries = enums[name];
  if (!entries) throw new Error(`Taxonomy enum "${name}" missing from enums.json`);
  return toEntries(entries);
}

/**
 * Two kinds of taxonomy, per the client's decision:
 *
 *  - CONSTRAINED enums are short enough to list in the Gemini prompt, so the
 *    model chooses from them directly and the value is used as received.
 *  - MATCHED taxonomies are far too long to prompt with (295 sub-categories,
 *    839 brands). Gemini reports what it literally sees on the label, and this
 *    local matcher replaces that free text with the closest table entry.
 */
export const subCategoryIndex = new FuzzyIndex(
  toEntries(referenceTables.subCategories),
  'sub_category',
);
export const brandIndex = new FuzzyIndex(toEntries(referenceTables.brands), 'brand_name');
export const countryIndex = new FuzzyIndex(
  toEntries(referenceTables.countries),
  'country_of_origin',
);
export const materialIndex = new FuzzyIndex(toEntries(referenceTables.materials), 'material');

export const colorIndex = new FuzzyIndex(toEntries(referenceTables.colors), 'color');
export const genderIndex = new FuzzyIndex(toEntries(referenceTables.genders), 'gender');
export const seasonIndex = new FuzzyIndex(toEntries(referenceTables.seasons), 'season');

/**
 * `category` is the one taxonomy with no client table — the workbook has no
 * sheet for it — so its three values stay in enums.json. Confirmed correct with
 * the client.
 */
export const categoryIndex = new FuzzyIndex(requireEnum('category'), 'category');

/**
 * Fields whose whole free-text Gemini output is replaced by a local table
 * selection. These lists are NEVER sent to the model.
 *
 * **`material` is deliberately not here (v1.4).** It is the one reported field
 * whose value is a sentence rather than a term: snapping `100% Cotton` as a
 * whole string returned the canonical key `Cotton` and threw the percentage
 * away, while `80% Cotton 20% Polyester` matched nothing and survived only by
 * accident. It is matched per fibre segment instead — see
 * `normalizeComposition()` below.
 */
export const MATCHED_FIELDS = {
  sub_category: subCategoryIndex,
  brand_name: brandIndex,
  country_of_origin: countryIndex,
} as const;

/**
 * Snaps every fibre name in a composition onto the material table, keeping the
 * percentages and the label's own punctuation (api_contract.md v1.4 §8.1).
 *
 *   "100% Cotton"                       -> "100% Cotton"
 *   "80% COTONE 20% POLIESTER"          -> "80% Cotton 20% Polyester"
 *   "40% Cotton 40% Nylon 20% Elastane" -> unchanged
 *   "Leather"          (shoe, inferred) -> "Leather"
 *
 * What this does NOT do is translate. Collapsing a six-language composition to
 * one English wording is the model's job, stated in the prompt, because the
 * matcher only knows the 85 English fibre names the client supplied — it turns
 * `POLIESTER` into `Polyester` by orthographic similarity, not by knowing
 * Spanish. A fibre it cannot place is passed through exactly as transcribed:
 * forcing `Algodon` onto a near miss would put a wrong fibre on the paperwork,
 * and a wrong key is worse than an unmatched one.
 *
 * `matched` reports whether ANY fibre was placed, which is what the caller logs.
 */
export function normalizeComposition(raw: string): { value: string; matched: boolean } {
  const segments = splitComposition(raw);
  if (segments.length === 0) return { value: raw, matched: false };

  let matched = false;
  const unplaced: string[] = [];

  const value = mapComposition(segments, (fibre) => {
    const hit = materialIndex.match(fibre);
    if (hit) {
      matched = true;
      return hit;
    }
    unplaced.push(fibre);
    return null;
  });

  if (unplaced.length > 0) {
    logger.debug(
      `No material table entry for fibre(s) ${unplaced.map((f) => `"${f}"`).join(', ')} ` +
        `in "${raw}"; keeping what was read.`,
    );
  }

  return { value, matched };
}

/**
 * Fields the model is constrained to choose from. Their values are used exactly
 * as returned — the matcher is not applied.
 */
export const CONSTRAINED_FIELDS = {
  category: categoryIndex,
  color: colorIndex,
  gender: genderIndex,
  season: seasonIndex,
} as const;

/**
 * Comma-separated keys for the Gemini system instruction and response schema.
 * Only the constrained enums appear here; adding a long taxonomy would blow up
 * the prompt and is exactly what the matched-field design avoids.
 */
export const TAXONOMY_KEYS = {
  get category(): string {
    return requireEnum('category').map((e) => e.key).join(', ');
  },
  get color(): string {
    return referenceTables.colors.join(', ');
  },
  get gender(): string {
    return referenceTables.genders.join(', ');
  },
  get season(): string {
    return referenceTables.seasons.join(', ');
  },
};

/**
 * Rebuilds every index from the reference tables currently in memory.
 *
 * Call this after `reloadReferenceTables()` succeeds. The prompt lists for the
 * four constrained enums are derived from `TAXONOMY_KEYS` at call time, so a
 * colour or season added by a supervisor reaches both the matcher and the model
 * without a restart.
 */
export function reloadTaxonomyIndexes(): void {
  subCategoryIndex.rebuild(toEntries(referenceTables.subCategories));
  brandIndex.rebuild(toEntries(referenceTables.brands));
  countryIndex.rebuild(toEntries(referenceTables.countries));
  materialIndex.rebuild(toEntries(referenceTables.materials));
  colorIndex.rebuild(toEntries(referenceTables.colors));
  genderIndex.rebuild(toEntries(referenceTables.genders));
  seasonIndex.rebuild(toEntries(referenceTables.seasons));
  categoryIndex.rebuild(requireEnum('category'));

  logger.info(
    'Taxonomy indexes rebuilt — ' +
      `sub_category:${subCategoryIndex.size} brand:${brandIndex.size} ` +
      `country:${countryIndex.size} material:${materialIndex.size} ` +
      `color:${colorIndex.size} gender:${genderIndex.size} season:${seasonIndex.size}`,
  );
}

/** Back-compat alias used by the extraction pipeline. */
export const FIELD_INDEXES: Record<string, FuzzyIndex> = {
  ...MATCHED_FIELDS,
  material: materialIndex,
};

logger.info(
  'Taxonomy indexes built — matched: ' +
    `sub_category:${subCategoryIndex.size} brand:${brandIndex.size} ` +
    `country:${countryIndex.size} material:${materialIndex.size}; ` +
    `constrained: category:${categoryIndex.size} color:${colorIndex.size} ` +
    `gender:${genderIndex.size} season:${seasonIndex.size}`,
);
