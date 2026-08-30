import { hsRuleList } from '../data/referenceTables';
import { norm } from '../data/referenceTables';
import type { ItemRow } from '../types/item';
import type { SuggestionEngine, SuggestionContext, Suggestion } from './types';

/**
 * HS / CN code suggestion (plan §8.3).
 *
 * Two tiers only — a rule table, then history. The engine deliberately does NOT text-search
 * the 951-heading nomenclature: a free-text match across the whole CN list will confidently
 * return the wrong chapter, and an HS code on a customs form is a legal declaration. Text
 * search exists, but it backs the human-operated picker in the UI, which stamps MANUAL.
 *
 * `hs_map.csv` ships empty. The client is narrowing the heading list and will author the
 * mapping; until then this engine falls through to history, and the picker covers the rest.
 * Nothing here changes when that file is filled.
 */

const HISTORY_COLUMNS: (keyof ItemRow)[] = ['brand', 'gender', 'size', 'season', 'material'];
const HISTORY_MIN_N = 3;

/** Coarse fibre grouping, so one rule row can cover a family of materials. */
function materialClass(material: string | null): string | null {
  if (!material) return null;
  const m = norm(material);
  if (/cotton|linen|denim|bamboo/.test(m)) return 'natural-plant';
  if (/wool|cashmere|silk|mohair|alpaca/.test(m)) return 'natural-animal';
  if (/leather|suede|nubuck/.test(m)) return 'leather';
  if (/polyester|acrylic|nylon|polyamide|elastane|viscose|modal|lyocell|polyurethane|faux/.test(m)) {
    return 'synthetic';
  }
  return 'other';
}

const engine: SuggestionEngine = {
  id: 'hs_code',
  version: '1.0.0',
  targets: ['hs_code', 'hs_code_src', 'hs_code_basis'],

  appliesTo: (item) => !item.hs_code,

  suggest(item: ItemRow, ctx: SuggestionContext): Suggestion | null {
    // Tier 1 — the rule matrix. Most specific matching row wins.
    if (item.sub_category) {
      const cls = materialClass(item.material);
      const candidates = hsRuleList()
        .filter((r) => norm(r.subCategory) === norm(item.sub_category!))
        .filter((r) => !r.gender || norm(r.gender) === norm(item.gender ?? ''))
        .filter((r) => !r.materialClass || r.materialClass === cls)
        .filter((r) => r.nettoGMax === null || (item.netto_g !== null && item.netto_g <= r.nettoGMax));

      if (candidates.length) {
        // Specificity = how many optional predicates the row actually constrains.
        const best = candidates.sort(
          (a, b) =>
            (Number(!!b.gender) + Number(!!b.materialClass) + Number(b.nettoGMax !== null)) -
            (Number(!!a.gender) + Number(!!a.materialClass) + Number(a.nettoGMax !== null)),
        )[0];
        return {
          value: best.cnCode,
          basis: `rule in hs_map.csv for "${best.subCategory}"${best.note ? ` — ${best.note}` : ''}`,
          n: 1,
        };
      }
    }

    // Tier 2 — the most common code among comparable items already coded by a human.
    const usable = HISTORY_COLUMNS.every((c) => item[c] !== null && item[c] !== '');
    if (usable) {
      const where = HISTORY_COLUMNS.map((c) => `${String(c)} = ?`).join(' AND ');
      const params = HISTORY_COLUMNS.map((c) => item[c] as string);
      const rows = ctx.db
        .prepare(
          `SELECT hs_code, COUNT(*) AS n
             FROM items
            WHERE hs_code IS NOT NULL AND hs_code <> ''
              AND deleted_at IS NULL
              AND apparel_id <> ?
              AND ${where}
            GROUP BY hs_code
            ORDER BY n DESC`,
        )
        .all(item.apparel_id, ...params) as Array<{ hs_code: string; n: number }>;

      const top = rows[0];
      if (top && top.n >= HISTORY_MIN_N) {
        return {
          value: top.hs_code,
          basis: `most common code among ${top.n} items matching brand + gender + size + season + material`,
          n: top.n,
        };
      }
    }

    return null;
  },
};

export default engine;
export { materialClass };
