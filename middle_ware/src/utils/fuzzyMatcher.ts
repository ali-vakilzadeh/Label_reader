import Fuse from 'fuse.js';
import type { IFuseOptions } from 'fuse.js';
import subCategoriesData from '../data/taxonomy/subCategories.json';
import enumsData from '../data/taxonomy/enums.json';
import countriesData from '../data/taxonomy/countries.json';
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
  readonly label: string;
  readonly size: number;

  constructor(entries: TaxonomyEntry[], label: string) {
    this.label = label;
    const records: SearchRecord[] = [];
    for (const entry of entries) {
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

  /** Match, or fall back to the original text when no key is close enough. */
  matchOrKeep(raw: string): { value: string; matched: boolean } {
    const hit = this.match(raw);
    return hit ? { value: hit, matched: true } : { value: raw, matched: false };
  }
}

const enums = enumsData as Record<string, TaxonomyEntry[]>;

function requireEnum(name: string): TaxonomyEntry[] {
  const entries = enums[name];
  if (!entries) throw new Error(`Taxonomy enum "${name}" missing from enums.json`);
  return entries;
}

/** Countries are stored as {code,name}; the ISO code doubles as an alias. */
const countryEntries: TaxonomyEntry[] = (countriesData as { code: string; name: string }[]).map(
  (country) => ({ key: country.name, aliases: [country.code] }),
);

export const subCategoryIndex = new FuzzyIndex(
  subCategoriesData as TaxonomyEntry[],
  'sub_category',
);
export const countryIndex = new FuzzyIndex(countryEntries, 'country_of_origin');
export const categoryIndex = new FuzzyIndex(requireEnum('category'), 'category');
export const colorIndex = new FuzzyIndex(requireEnum('color'), 'color');
export const genderIndex = new FuzzyIndex(requireEnum('gender'), 'gender');
export const seasonIndex = new FuzzyIndex(requireEnum('season'), 'season');

/** Fields that get snapped to a canonical key, and the index that does it. */
export const FIELD_INDEXES: Record<string, FuzzyIndex> = {
  sub_category: subCategoryIndex,
  country_of_origin: countryIndex,
  category: categoryIndex,
  color: colorIndex,
  gender: genderIndex,
  season: seasonIndex,
};

logger.info(
  `Fuzzy indexes built — sub_category:${subCategoryIndex.size} country:${countryIndex.size} ` +
    `category:${categoryIndex.size} color:${colorIndex.size} gender:${genderIndex.size} season:${seasonIndex.size}`,
);
