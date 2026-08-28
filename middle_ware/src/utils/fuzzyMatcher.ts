import Fuse from 'fuse.js';
import type { IFuseOptions } from 'fuse.js';
import { referenceTables } from '../data/referenceTables';
import enumsData from '../data/taxonomy/enums.json';
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
export type TaxonomySource = string | { key: string; aliases?: string[] };

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
  private readonly exact = new Map<string, string>();
  /** Whitespace/punctuation-stripped term -> canonical key ("viet nam" -> "vietnam"). */
  private readonly compact = new Map<string, string>();
  /** Memoised results; label vocabularies repeat heavily in a scanning shift. */
  private readonly cache = new Map<string, string | null>();
  private readonly fuse: Fuse<SearchRecord>;
  /** Canonical keys, for exact membership tests. */
  private readonly keys = new Set<string>();
  readonly label: string;
  readonly size: number;

  constructor(entries: TaxonomyEntry[], label: string) {
    this.label = label;
    const records: SearchRecord[] = [];
    for (const entry of entries) {
      this.keys.add(entry.key);
      for (const term of [entry.key, ...entry.aliases]) {
        const normalised = normalise(term);
        if (!normalised) continue;
        if (!this.exact.has(normalised)) this.exact.set(normalised, entry.key);
        const compacted = compact(normalised);
        if (compacted && !this.compact.has(compacted)) this.compact.set(compacted, entry.key);
        records.push({ key: entry.key, term: normalised });
      }
    }
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
 * Fields whose free-text Gemini output is replaced by a local table selection.
 * These lists are NEVER sent to the model.
 */
export const MATCHED_FIELDS = {
  sub_category: subCategoryIndex,
  brand_name: brandIndex,
  country_of_origin: countryIndex,
  material: materialIndex,
} as const;

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
  category: requireEnum('category').map((e) => e.key).join(', '),
  color: referenceTables.colors.join(', '),
  gender: referenceTables.genders.join(', '),
  season: referenceTables.seasons.join(', '),
} as const;

/** Back-compat alias used by the extraction pipeline. */
export const FIELD_INDEXES: Record<string, FuzzyIndex> = { ...MATCHED_FIELDS };

logger.info(
  'Taxonomy indexes built — matched: ' +
    `sub_category:${subCategoryIndex.size} brand:${brandIndex.size} ` +
    `country:${countryIndex.size} material:${materialIndex.size}; ` +
    `constrained: category:${categoryIndex.size} color:${colorIndex.size} ` +
    `gender:${genderIndex.size} season:${seasonIndex.size}`,
);
