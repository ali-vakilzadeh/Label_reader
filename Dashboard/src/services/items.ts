import { openDashboardDb } from '../db';
import type { ItemRow } from '../types/item';
import { audit } from './audit';
import { allSettings } from './settings';
import { computeSuggestions } from '../suggest';
import { parseFieldSrc, resolveTaxonomy } from '../data/resolve';
import type { TaxonomyKey } from '../data/referenceTables';
import { parsePrice, parseWeightToGrams } from '../utils/normalise';

/** Filters accepted by the grid and by every export. One definition, used by both. */
export interface ItemFilters {
  from?: string;
  to?: string;
  operator?: string;
  brand?: string;
  sub_category?: string;
  gender?: string;
  season?: string;
  country?: string;
  category?: string;
  review_state?: string;
  article_no?: string;
  export_batch?: string;
  has_price?: '1' | '0';
  has_hs?: '1' | '0';
  duplicates?: '1';
  unmatched?: '1';
  locked?: '1' | '0';
  q?: string;
  lastN?: number;
}

const EQ_FILTERS: Array<[keyof ItemFilters, string]> = [
  ['operator', 'operator'],
  ['brand', 'brand'],
  ['sub_category', 'sub_category'],
  ['gender', 'gender'],
  ['season', 'season'],
  ['country', 'country'],
  ['category', 'category'],
  ['review_state', 'review_state'],
  ['article_no', 'article_no'],
  ['export_batch', 'export_batch'],
];

export function buildWhere(f: ItemFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];

  for (const [key, column] of EQ_FILTERS) {
    const v = f[key];
    if (v) {
      clauses.push(`${column} = ?`);
      params.push(v);
    }
  }
  if (f.from) {
    clauses.push('scanned_at >= ?');
    params.push(f.from);
  }
  if (f.to) {
    // Inclusive of the whole day when a bare date is given.
    clauses.push('scanned_at <= ?');
    params.push(f.to.length === 10 ? `${f.to}T23:59:59` : f.to);
  }
  if (f.has_price === '1') clauses.push('user_decided_price IS NOT NULL');
  if (f.has_price === '0') clauses.push('user_decided_price IS NULL');
  if (f.has_hs === '1') clauses.push("hs_code IS NOT NULL AND hs_code <> ''");
  if (f.has_hs === '0') clauses.push("(hs_code IS NULL OR hs_code = '')");
  if (f.duplicates === '1') clauses.push('dup_group_id IS NOT NULL AND dup_dismissed = 0');
  if (f.unmatched === '1') clauses.push("field_src_json LIKE '%UNMATCHED%'");
  if (f.locked === '1') clauses.push('locked = 1');
  if (f.locked === '0') clauses.push('locked = 0');
  if (f.q) {
    clauses.push('(apparel_id LIKE ? OR brand LIKE ? OR notes LIKE ? OR article_no LIKE ? OR package_code LIKE ?)');
    const like = `%${f.q}%`;
    params.push(like, like, like, like, like);
  }

  return { sql: clauses.join(' AND '), params };
}

export function countItems(f: ItemFilters): number {
  const { sql, params } = buildWhere(f);
  return (
    openDashboardDb().prepare(`SELECT COUNT(*) AS n FROM items WHERE ${sql}`).get(...params) as { n: number }
  ).n;
}

export function queryItems(
  f: ItemFilters,
  opts: { limit?: number; offset?: number; sort?: string; dir?: 'asc' | 'desc' } = {},
): ItemRow[] {
  const { sql, params } = buildWhere(f);
  const sortable = new Set([
    'scanned_at',
    'apparel_id',
    'brand',
    'sub_category',
    'operator',
    'user_decided_price',
    'suggested_price',
    'review_state',
    'article_no',
  ]);
  const sort = opts.sort && sortable.has(opts.sort) ? opts.sort : 'scanned_at';
  const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';

  // lastN is expressed as "the N most recent scans", so it overrides paging.
  const limit = f.lastN && f.lastN > 0 ? f.lastN : (opts.limit ?? 50);
  const offset = f.lastN && f.lastN > 0 ? 0 : (opts.offset ?? 0);

  return openDashboardDb()
    .prepare(`SELECT * FROM items WHERE ${sql} ORDER BY ${sort} ${dir}, apparel_id LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as ItemRow[];
}

export function getItem(apparelId: string): ItemRow | undefined {
  return openDashboardDb().prepare('SELECT * FROM items WHERE apparel_id = ?').get(apparelId) as
    | ItemRow
    | undefined;
}

/** Distinct values actually present in the data, for filter dropdowns that stay honest. */
export function distinctValues(column: string): string[] {
  const allowed = new Set(['operator', 'brand', 'sub_category', 'gender', 'season', 'country', 'category', 'article_no', 'export_batch']);
  if (!allowed.has(column)) return [];
  return (
    openDashboardDb()
      .prepare(`SELECT DISTINCT ${column} AS v FROM items WHERE ${column} IS NOT NULL AND deleted_at IS NULL ORDER BY v`)
      .all() as Array<{ v: string }>
  ).map((r) => r.v);
}

/* ------------------------------- editing ------------------------------- */

/** Columns a user may edit directly from the grid. Derived columns are not here. */
const EDITABLE = new Set([
  'brand',
  'category',
  'sub_category',
  'gender',
  'season',
  'color',
  'material',
  'country',
  'size',
  'original_price',
  'netto',
  'brutto',
  'pieces',
  'set_size',
  'care_info',
  'package_code',
  'article_no',
  'notes',
  'hs_code',
  'user_decided_price',
]);

const TAXONOMY_COLUMNS: Record<string, TaxonomyKey> = {
  brand: 'brand',
  category: 'category',
  sub_category: 'sub_category',
  gender: 'gender',
  season: 'season',
  color: 'color',
  material: 'material',
  country: 'country',
};

export class EditRefused extends Error {}

/**
 * Update one item. A locked row rejects every edit path, including import overwrite —
 * that is the whole point of the lock, and it is not a UI hint.
 */
export function updateItem(actor: string, apparelId: string, patch: Record<string, string | null>): ItemRow {
  const db = openDashboardDb();
  const before = getItem(apparelId);
  if (!before) throw new EditRefused(`No item ${apparelId}.`);
  if (before.locked) throw new EditRefused('This item is locked. Unlock it before editing.');

  const sets: string[] = [];
  const params: unknown[] = [];
  const src = parseFieldSrc(before.field_src_json);

  for (const [key, rawValue] of Object.entries(patch)) {
    if (!EDITABLE.has(key)) continue;
    const value = rawValue === '' ? null : rawValue;

    if (key in TAXONOMY_COLUMNS) {
      // A hand-typed value still gets resolved, so the numeric id and the Armenian join
      // stay correct — but a human edit is stamped MANUAL, never FUZZY.
      const resolved = value ? resolveTaxonomy(TAXONOMY_COLUMNS[key], value) : null;
      sets.push(`${key} = ?`, `${key}_id = ?`);
      params.push(resolved?.value ?? null, resolved?.id ?? null);
      src[key] = value ? 'MANUAL' : 'EMPTY';
      continue;
    }

    switch (key) {
      case 'original_price': {
        const parsed = parsePrice(value);
        sets.push('original_price = ?', 'original_price_value = ?', 'original_price_currency = ?');
        params.push(value, parsed.value, parsed.currency);
        break;
      }
      case 'netto':
      case 'brutto': {
        sets.push(`${key} = ?`, `${key}_g = ?`);
        params.push(value, parseWeightToGrams(value));
        break;
      }
      case 'pieces':
      case 'set_size': {
        const n = Number(value);
        sets.push(`${key} = ?`);
        params.push(Number.isFinite(n) && n > 0 ? Math.round(n) : 1);
        break;
      }
      case 'user_decided_price': {
        const n = Number(value);
        const price = Number.isFinite(n) ? n : null;
        sets.push('user_decided_price = ?', 'user_decided_price_currency = ?');
        params.push(price, price === null ? null : (before.user_decided_price_currency ?? allSettings().default_currency));
        if (price !== null) {
          db.prepare(
            'INSERT INTO price_history (apparel_id, price, currency, set_at, set_by, basis) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(apparelId, price, before.user_decided_price_currency ?? allSettings().default_currency, Date.now(), actor, 'manual');
        }
        break;
      }
      case 'hs_code': {
        sets.push('hs_code = ?', 'hs_code_src = ?', 'hs_code_basis = ?');
        params.push(value, value ? 'MANUAL' : null, value ? `set by ${actor}` : null);
        break;
      }
      default:
        sets.push(`${key} = ?`);
        params.push(value);
    }
    src[key] = 'MANUAL';
  }

  if (!sets.length) return before;

  sets.push('field_src_json = ?', 'updated_at = ?', 'updated_by = ?');
  params.push(JSON.stringify(src), Date.now(), actor);

  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE apparel_id = ?`).run(...params, apparelId);
  const after = getItem(apparelId)!;
  audit(actor, 'ITEM_UPDATE', 'item', apparelId, before, after);
  refreshReviewState(apparelId);
  return getItem(apparelId)!;
}

export function setLocked(actor: string, apparelId: string, locked: boolean): void {
  openDashboardDb()
    .prepare('UPDATE items SET locked = ?, updated_at = ?, updated_by = ? WHERE apparel_id = ?')
    .run(locked ? 1 : 0, Date.now(), actor, apparelId);
  audit(actor, locked ? 'ITEM_LOCK' : 'ITEM_UNLOCK', 'item', apparelId);
}

/** Soft delete only. Nothing in this system is ever hard-deleted. */
export function softDelete(actor: string, apparelId: string): void {
  const item = getItem(apparelId);
  if (!item) return;
  if (item.locked) throw new EditRefused('This item is locked. Unlock it before deleting.');
  openDashboardDb()
    .prepare('UPDATE items SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE apparel_id = ?')
    .run(Date.now(), Date.now(), actor, apparelId);
  audit(actor, 'ITEM_DELETE', 'item', apparelId, item);
}

export function restore(actor: string, apparelId: string): void {
  openDashboardDb()
    .prepare('UPDATE items SET deleted_at = NULL, updated_at = ?, updated_by = ? WHERE apparel_id = ?')
    .run(Date.now(), actor, apparelId);
  audit(actor, 'ITEM_RESTORE', 'item', apparelId);
}

export function setReviewState(actor: string, apparelId: string, state: ItemRow['review_state']): void {
  openDashboardDb()
    .prepare('UPDATE items SET review_state = ?, updated_at = ?, updated_by = ? WHERE apparel_id = ?')
    .run(state, Date.now(), actor, apparelId);
  audit(actor, 'ITEM_REVIEW_STATE', 'item', apparelId, null, { state });
}

/* -------------------------- review + suggestions ----------------------- */

export interface ReviewReason {
  kind: 'EMPTY' | 'UNMATCHED' | 'FUZZY' | 'LOW_CONFIDENCE' | 'PARKED';
  field?: string;
  detail: string;
  /**
   * Whether this reason should hold the row in NEEDS_REVIEW. A fuzzy snap is surfaced but
   * not blocking: the value was resolved, and every one of them queueing for sign-off
   * would bury the reasons that genuinely need a person.
   */
  blocking: boolean;
}

/**
 * Why a row is flagged, in words. Never a bare "needs review" with no cause — the
 * operator has to know what to fix (plan §5.3).
 */
export function reviewReasons(item: ItemRow): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  if (item.review_state === 'PARKED') {
    reasons.push({
      kind: 'PARKED',
      detail: 'Parked on the server — the item needs re-photographing.',
      blocking: true,
    });
  }

  const src = parseFieldSrc(item.field_src_json);
  for (const [field, mark] of Object.entries(src)) {
    const value = String((item as unknown as Record<string, unknown>)[field] ?? '');
    if (mark === 'UNMATCHED') {
      reasons.push({ kind: 'UNMATCHED', field, detail: `unmatched ${field}: "${value}"`, blocking: true });
    } else if (typeof mark === 'string' && mark.startsWith('FUZZY:')) {
      // The machine changed what the operator wrote. Say so, with the score, so the
      // change is visible and reversible rather than silent.
      reasons.push({
        kind: 'FUZZY',
        field,
        detail: `${field} snapped to "${value}" at similarity ${mark.slice(6)}`,
        blocking: false,
      });
    }
  }

  const required = ['brand', 'sub_category', 'gender', 'season', 'size', 'color', 'material', 'country'] as const;
  for (const field of required) {
    if (!item[field]) reasons.push({ kind: 'EMPTY', field, detail: `empty ${field}`, blocking: true });
  }

  const threshold = Number(allSettings().low_confidence_threshold);
  if (item.min_confidence !== null && item.min_confidence < threshold) {
    const conf = parseConfidences(item.confidence_json);
    const worst = Object.entries(conf).sort((a, b) => a[1] - b[1])[0];
    reasons.push({
      kind: 'LOW_CONFIDENCE',
      field: worst?.[0],
      detail: worst
        ? `low confidence ${worst[1].toFixed(2)} on ${worst[0]}`
        : `low confidence ${item.min_confidence.toFixed(2)}`,
      blocking: true,
    });
  }
  return reasons;
}

export function parseConfidences(json: string | null): Record<string, number> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, number>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Recompute review_state from the current row. Never downgrades a human REVIEWED. */
export function refreshReviewState(apparelId: string): void {
  const item = getItem(apparelId);
  if (!item || item.review_state === 'PARKED') return;
  const blocking = reviewReasons(item).filter((r) => r.blocking);
  const next = blocking.length ? 'NEEDS_REVIEW' : item.review_state === 'NEEDS_REVIEW' ? 'REVIEWED' : item.review_state;
  if (next !== item.review_state) {
    openDashboardDb().prepare('UPDATE items SET review_state = ? WHERE apparel_id = ?').run(next, apparelId);
  }
}

/**
 * Run the engines and store the result. Only ever touches suggested_* columns, plus
 * hs_code when no human has set it — so this is always safe to re-run in bulk.
 */
export function recomputeSuggestions(apparelIds: string[], log: (m: string) => void = () => {}): number {
  const db = openDashboardDb();
  const settings = allSettings();
  let changed = 0;

  const apply = db.transaction((ids: string[]) => {
    for (const id of ids) {
      const item = getItem(id);
      if (!item || item.deleted_at) continue;
      const patch = computeSuggestions(item, db, settings, log);
      const keys = Object.keys(patch);
      if (!keys.length) continue;
      db.prepare(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE apparel_id = ?`).run(
        ...keys.map((k) => patch[k] as never),
        id,
      );
      changed += 1;
    }
  });
  apply(apparelIds);
  return changed;
}

export function allItemIds(f: ItemFilters = {}): string[] {
  const { sql, params } = buildWhere(f);
  return (
    openDashboardDb().prepare(`SELECT apparel_id FROM items WHERE ${sql}`).all(...params) as Array<{
      apparel_id: string;
    }>
  ).map((r) => r.apparel_id);
}
