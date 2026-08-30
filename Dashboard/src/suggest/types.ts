import type { Db } from '../db';
import type { ItemRow } from '../types/item';

/**
 * The suggestion-engine contract (plan §8.0).
 *
 * Client instruction, 2026-08-30: keep the AI functions completely modular — updating one
 * must not mean touching the rest of the code. That is enforced structurally here:
 *
 *   - Nothing outside src/suggest/ knows how any engine works.
 *   - An engine may only READ. The registry writes the columns, inside the caller's
 *     transaction, so an engine can never half-update a row.
 *   - Returning null is normal and means "no opinion", never an error.
 *   - Every non-null result must carry `basis` and `n`; the registry drops one that does
 *     not, because a number without a defensible basis has no business on an invoice.
 *   - Engines are pure functions of (item, history). No network, no AI SDK, no filesystem.
 *
 * Adding an engine is one file plus one line in registry.ts. Removing one is deleting the
 * file. If a genuine model-backed engine is ever wanted, it drops in behind this same
 * interface and "no AI in the dashboard" becomes a one-file decision.
 */

export interface SuggestionContext {
  /** Read-only by discipline. An engine that writes here is a bug. */
  db: Db;
  settings: Readonly<Record<string, string>>;
  now: Date;
  log: (msg: string) => void;
}

export interface Suggestion {
  /** The suggested value. Numeric for price/weight, a CN code string for HS. */
  value: number | string;
  /** Second value, for engines that fill a pair (netto/brutto). */
  value2?: number | string | null;
  /** Human-readable and complete: "median of 34 items matching …, −6 % for age". */
  basis: string;
  /** Sample size behind the suggestion. A median over 3 must not look like one over 300. */
  n: number;
}

export interface SuggestionEngine {
  /** Stable key. Used in settings and in the stored suggestion version stamp. */
  id: 'price' | 'weight' | 'hs_code';
  /** Bumped when the algorithm changes; stored on every suggestion it writes. */
  version: string;
  /** Which item columns this engine fills. Documentation and collision checking. */
  targets: readonly (keyof ItemRow)[];
  /** Cheap guard. Skip the query entirely when the engine has nothing to say. */
  appliesTo: (item: ItemRow) => boolean;
  /** The work. Returning null means "no opinion". */
  suggest: (item: ItemRow, ctx: SuggestionContext) => Suggestion | null;
}
