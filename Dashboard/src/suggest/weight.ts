import { median } from '../utils/normalise';
import type { ItemRow } from '../types/item';
import type { SuggestionEngine, SuggestionContext, Suggestion } from './types';

/**
 * Weight suggestion (plan §8.2).
 *
 * Fires only when BOTH weights are missing. Never guessed, never zero-filled: a zero
 * weight on a customs form is worse than an empty one, because a blank is visibly
 * missing and a zero is silently wrong.
 *
 * The seed plan had a local vision-AI fallback here. It was removed deliberately — the
 * middleware owns the entire vision pipeline, and a second caller would mean a second
 * key, a second bill and a second set of values that disagree (plan §1 override 5).
 */

interface Tier {
  label: string;
  columns: (keyof ItemRow)[];
  minN: number;
}

const TIERS: Tier[] = [
  { label: 'brand + gender + size + season + material', columns: ['brand', 'gender', 'size', 'season', 'material'], minN: 3 },
  { label: 'sub-category + gender + size', columns: ['sub_category', 'gender', 'size'], minN: 5 },
];

const engine: SuggestionEngine = {
  id: 'weight',
  version: '1.0.0',
  targets: ['suggested_netto_g', 'suggested_brutto_g', 'weight_suggestion_basis'],

  appliesTo: (item) => item.netto_g === null && item.brutto_g === null,

  suggest(item: ItemRow, ctx: SuggestionContext): Suggestion | null {
    for (const tier of TIERS) {
      const usable = tier.columns.every((c) => item[c] !== null && item[c] !== '');
      if (!usable) continue;

      const where = tier.columns.map((c) => `${String(c)} = ?`).join(' AND ');
      const params = tier.columns.map((c) => item[c] as string);

      const rows = ctx.db
        .prepare(
          `SELECT netto_g, brutto_g
             FROM items
            WHERE netto_g IS NOT NULL
              AND brutto_g IS NOT NULL
              AND deleted_at IS NULL
              AND apparel_id <> ?
              AND ${where}`,
        )
        .all(item.apparel_id, ...params) as Array<{ netto_g: number; brutto_g: number }>;

      if (rows.length < tier.minN) continue;

      const netto = median(rows.map((r) => r.netto_g));
      const brutto = median(rows.map((r) => r.brutto_g));
      if (netto === null || brutto === null) continue;

      return {
        value: Math.round(netto),
        value2: Math.round(brutto),
        basis: `median of ${rows.length} items matching ${tier.label}`,
        n: rows.length,
      };
    }

    // Nothing comparable. Leave both blank and let the review queue surface it.
    return null;
  },
};

export default engine;
