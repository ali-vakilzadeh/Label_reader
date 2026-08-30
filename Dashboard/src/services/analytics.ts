import { openDashboardDb } from '../db';
import { buildWhere, type ItemFilters } from './items';

/**
 * Analytics (plan §11.4). One SQL query per chart, rendered as inline SVG by the view —
 * no charting library, and a new chart is one query plus one template include.
 *
 * Every query honours the grid's active filters, so a chart and the table below it can
 * never disagree about what is being counted.
 */

export interface Point {
  label: string;
  value: number;
}

function scoped(f: ItemFilters, select: string, groupBy: string, order = 'label'): Point[] {
  const { sql, params } = buildWhere(f);
  return openDashboardDb()
    .prepare(`SELECT ${select} FROM items WHERE ${sql} GROUP BY ${groupBy} ORDER BY ${order}`)
    .all(...params) as Point[];
}

export function scansPerDay(f: ItemFilters, days = 30): Point[] {
  const { sql, params } = buildWhere(f);
  return openDashboardDb()
    .prepare(
      `SELECT substr(scanned_at, 1, 10) AS label, COUNT(*) AS value
         FROM items WHERE ${sql}
        GROUP BY label ORDER BY label DESC LIMIT ?`,
    )
    .all(...params, days)
    .reverse() as Point[];
}

export function scansPerOperator(f: ItemFilters): Point[] {
  return scoped(f, 'operator AS label, COUNT(*) AS value', 'operator', 'value DESC');
}

export function reviewBreakdown(f: ItemFilters): Point[] {
  return scoped(f, 'review_state AS label, COUNT(*) AS value', 'review_state', 'value DESC');
}

export function topBrands(f: ItemFilters, limit = 12): Point[] {
  const { sql, params } = buildWhere(f);
  return openDashboardDb()
    .prepare(
      `SELECT COALESCE(brand, '(none)') AS label, COUNT(*) AS value
         FROM items WHERE ${sql} GROUP BY label ORDER BY value DESC LIMIT ?`,
    )
    .all(...params, limit) as Point[];
}

export function topSubCategories(f: ItemFilters, limit = 12): Point[] {
  const { sql, params } = buildWhere(f);
  return openDashboardDb()
    .prepare(
      `SELECT COALESCE(sub_category, '(none)') AS label, COUNT(*) AS value
         FROM items WHERE ${sql} GROUP BY label ORDER BY value DESC LIMIT ?`,
    )
    .all(...params, limit) as Point[];
}

export interface Coverage {
  total: number;
  priced: number;
  coded: number;
  weighed: number;
  reviewed: number;
}

export function coverage(f: ItemFilters): Coverage {
  const { sql, params } = buildWhere(f);
  return openDashboardDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN user_decided_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
              SUM(CASE WHEN hs_code IS NOT NULL AND hs_code <> '' THEN 1 ELSE 0 END) AS coded,
              SUM(CASE WHEN netto_g IS NOT NULL THEN 1 ELSE 0 END) AS weighed,
              SUM(CASE WHEN review_state = 'REVIEWED' THEN 1 ELSE 0 END) AS reviewed
         FROM items WHERE ${sql}`,
    )
    .get(...params) as Coverage;
}

export function importVolume(limit = 20): Point[] {
  return openDashboardDb()
    .prepare(
      `SELECT date(uploaded_at / 1000, 'unixepoch') AS label, SUM(rows_inserted) AS value
         FROM imports GROUP BY label ORDER BY label DESC LIMIT ?`,
    )
    .all(limit)
    .reverse() as Point[];
}
