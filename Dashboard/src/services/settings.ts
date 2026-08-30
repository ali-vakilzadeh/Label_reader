import { openDashboardDb } from '../db';
import { config } from '../config/env';

/** Tunables that must be changeable without a release (plan §6.2, §8.1). */
const DEFAULTS: Record<string, string> = {
  fuzzy_min_similarity: String(config.fuzzyMinSimilarity),
  dup_window_hours: String(config.dupWindowHours),
  low_confidence_threshold: String(config.lowConfidenceThreshold),
  price_decay_per_month: '0.01',
  price_decay_floor: '0.6',
  default_currency: config.defaultCurrency,
  page_size: String(config.pageSize),
};

export function allSettings(): Record<string, string> {
  const db = openDashboardDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function getSetting(key: string): string {
  return allSettings()[key] ?? '';
}

export function setSetting(key: string, value: string): void {
  openDashboardDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, Date.now());
}
