import { median, monthsBetween } from '../utils/normalise';
import type { ItemRow } from '../types/item';
import type { SuggestionEngine, SuggestionContext, Suggestion } from './types';

/**
 * Price suggestion (plan §8.1).
 *
 * The order letter asks for offers based on similar products "in Outfit Data and the
 * market". The client confirmed on 2026-08-30 that no market feed exists and that the
 * accumulated `user_decided_price` history *is* the market reference — which is exactly
 * the candidate pool below, so this engine satisfies the clause on its own.
 *
 * Median rather than mean: one mistyped price should not move the number.
 */

interface Tier {
  label: string;
  columns: (keyof ItemRow)[];
  minN: number;
}

const TIERS: Tier[] = [
  {
    label: 'sub-category + brand + gender + size + season + material + country',
    columns: ['sub_category', 'brand', 'gender', 'size', 'season', 'material', 'country'],
    minN: 5,
  },
  {
    label: 'sub-category + brand + gender + season + material',
    columns: ['sub_category', 'brand', 'gender', 'season', 'material'],
    minN: 5,
  },
  { label: 'sub-category + brand + gender', columns: ['sub_category', 'brand', 'gender'], minN: 5 },
  { label: 'sub-category + gender', columns: ['sub_category', 'gender'], minN: 5 },
];

const DEFAULT_DECAY_PER_MONTH = 0.01;
const DEFAULT_DECAY_FLOOR = 0.6;

const engine: SuggestionEngine = {
  id: 'price',
  version: '1.0.0',
  targets: ['suggested_price', 'suggested_price_basis', 'suggested_price_n'],

  appliesTo: (item) => item.user_decided_price === null,

  suggest(item: ItemRow, ctx: SuggestionContext): Suggestion | null {
    const decay = Number(ctx.settings.price_decay_per_month ?? DEFAULT_DECAY_PER_MONTH);
    const floor = Number(ctx.settings.price_decay_floor ?? DEFAULT_DECAY_FLOOR);

    for (const tier of TIERS) {
      // A tier is only usable when the item itself has every column it matches on.
      const usable = tier.columns.every((c) => item[c] !== null && item[c] !== '');
      if (!usable) continue;

      const where = tier.columns.map((c) => `${String(c)} = ?`).join(' AND ');
      const params = tier.columns.map((c) => item[c] as string);

      const rows = ctx.db
        .prepare(
          `SELECT user_decided_price AS price, scanned_at
             FROM items
            WHERE user_decided_price IS NOT NULL
              AND deleted_at IS NULL
              AND apparel_id <> ?
              AND ${where}`,
        )
        .all(item.apparel_id, ...params) as Array<{ price: number; scanned_at: string }>;

      if (rows.length < tier.minN) continue;

      const base = median(rows.map((r) => r.price));
      if (base === null) continue;

      const months = monthsBetween(item.scanned_at, ctx.now);
      const ageFactor = Math.max(floor, 1 - decay * months);
      const value = Math.round(base * ageFactor * 100) / 100;

      const discount = Math.round((1 - ageFactor) * 100);
      const basis =
        `median of ${rows.length} items matching ${tier.label}` +
        (discount > 0 ? `, −${discount} % for age` : '');

      return { value, basis, n: rows.length };
    }

    return null;
  },
};

export default engine;

/**
 * Context shown beside the suggestion, never blended into it: the item's own retail tag
 * and the observed range for the tightest tier. Used by the UI, not by the engine.
 */
export function priceContext(
  item: ItemRow,
  ctx: SuggestionContext,
): { tag: number | null; min: number | null; max: number | null; n: number } {
  const tier = TIERS[0];
  const usable = tier.columns.every((c) => item[c] !== null && item[c] !== '');
  if (!usable) return { tag: item.original_price_value, min: null, max: null, n: 0 };

  const where = tier.columns.map((c) => `${String(c)} = ?`).join(' AND ');
  const params = tier.columns.map((c) => item[c] as string);
  const row = ctx.db
    .prepare(
      `SELECT MIN(user_decided_price) AS lo, MAX(user_decided_price) AS hi, COUNT(*) AS n
         FROM items
        WHERE user_decided_price IS NOT NULL AND deleted_at IS NULL AND apparel_id <> ? AND ${where}`,
    )
    .get(item.apparel_id, ...params) as { lo: number | null; hi: number | null; n: number };

  return { tag: item.original_price_value, min: row.lo, max: row.hi, n: row.n };
}
