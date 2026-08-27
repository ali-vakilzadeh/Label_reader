import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { FlywheelRow } from '../types';

/**
 * HIDDEN training database (flywheel.db).
 *
 * Physically isolated from server_scans.db so no dashboard/client query path can
 * reach it. It accumulates low-confidence scans — raw images, the unconfirmed
 * Gemini prediction, the operator-confirmed ground truth, and the studio render —
 * as a future fine-tuning corpus.
 *
 * Capacity is a strict FIFO ring buffer of FLYWHEEL_MAX_RECORDS (default 10,000):
 * every insertion trims the oldest rows back down to the ceiling.
 */
const flywheelDbPath = path.join(env.dataDir, 'flywheel.db');
export const flywheelDb = new Database(flywheelDbPath);

flywheelDb.pragma('journal_mode = WAL');
flywheelDb.pragma('busy_timeout = 5000');

flywheelDb.exec(`
  CREATE TABLE IF NOT EXISTS flywheel_training (
    apparel_id              TEXT PRIMARY KEY,
    key_photo_path          TEXT,
    raw_images_paths        TEXT,
    unconfirmed_gemini_json TEXT NOT NULL,
    confirmed_json          TEXT,
    catalog_render_path     TEXT,
    lowest_confidence_score REAL NOT NULL,
    created_at              INTEGER NOT NULL,
    confirmed_at            INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_flywheel_created_at ON flywheel_training (created_at);
  CREATE INDEX IF NOT EXISTS idx_flywheel_confirmed  ON flywheel_training (confirmed_at);
`);

const insertStmt = flywheelDb.prepare(`
  INSERT INTO flywheel_training (
    apparel_id, key_photo_path, raw_images_paths, unconfirmed_gemini_json,
    confirmed_json, catalog_render_path, lowest_confidence_score,
    created_at, confirmed_at
  ) VALUES (
    @apparel_id, @key_photo_path, @raw_images_paths, @unconfirmed_gemini_json,
    NULL, NULL, @lowest_confidence_score, @created_at, NULL
  )
  ON CONFLICT(apparel_id) DO UPDATE SET
    key_photo_path          = excluded.key_photo_path,
    raw_images_paths        = excluded.raw_images_paths,
    unconfirmed_gemini_json = excluded.unconfirmed_gemini_json,
    lowest_confidence_score = excluded.lowest_confidence_score,
    created_at              = excluded.created_at
`);

const countStmt = flywheelDb.prepare('SELECT COUNT(*) AS total FROM flywheel_training');

/**
 * FIFO eviction. Mirrors the specified purge query, generalised to remove the
 * `overflow` oldest rows in one statement so a burst insert cannot exceed the cap.
 */
const purgeOldestStmt = flywheelDb.prepare(`
  DELETE FROM flywheel_training
  WHERE apparel_id IN (
    SELECT apparel_id FROM flywheel_training ORDER BY created_at ASC LIMIT ?
  )
`);

const selectByIdStmt = flywheelDb.prepare(
  'SELECT * FROM flywheel_training WHERE apparel_id = ?',
);

const confirmStmt = flywheelDb.prepare(`
  UPDATE flywheel_training
  SET confirmed_json = @confirmed_json,
      confirmed_at   = @confirmed_at
  WHERE apparel_id = @apparel_id
`);

const setRenderPathStmt = flywheelDb.prepare(`
  UPDATE flywheel_training
  SET catalog_render_path = @catalog_render_path
  WHERE apparel_id = @apparel_id
`);

export interface FlywheelInsertInput {
  apparel_id: string;
  key_photo_path: string | null;
  raw_images_paths: string[];
  unconfirmed_gemini_json: unknown;
  lowest_confidence_score: number;
}

export function countFlywheelRecords(): number {
  return (countStmt.get() as { total: number }).total;
}

/** Trims the buffer back to the configured ceiling. Returns rows evicted. */
export function enforceRingBuffer(max = env.flywheelMaxRecords): number {
  const total = countFlywheelRecords();
  const overflow = total - max;
  if (overflow <= 0) return 0;
  purgeOldestStmt.run(overflow);
  logger.info(`Flywheel ring buffer full — evicted ${overflow} oldest record(s).`);
  return overflow;
}

/**
 * Inserts (or refreshes) a low-confidence sample and enforces the ring buffer in
 * the same transaction, so the cap holds even under concurrent writes.
 */
export const insertFlywheelRecord = flywheelDb.transaction(
  (input: FlywheelInsertInput): void => {
    insertStmt.run({
      apparel_id: input.apparel_id,
      key_photo_path: input.key_photo_path,
      raw_images_paths: JSON.stringify(input.raw_images_paths),
      unconfirmed_gemini_json: JSON.stringify(input.unconfirmed_gemini_json),
      lowest_confidence_score: input.lowest_confidence_score,
      created_at: Date.now(),
    });
    enforceRingBuffer();
  },
);

export function getFlywheelRecord(apparelId: string): FlywheelRow | undefined {
  return selectByIdStmt.get(apparelId) as FlywheelRow | undefined;
}

/** Binds operator-verified ground truth to a stored low-confidence sample. */
export function confirmFlywheelRecord(apparelId: string, confirmed: unknown): boolean {
  const result = confirmStmt.run({
    apparel_id: apparelId,
    confirmed_json: JSON.stringify(confirmed),
    confirmed_at: Date.now(),
  });
  return result.changes > 0;
}

/** Called by the nightly render job once a studio shot exists for this item. */
export function setFlywheelRenderPath(apparelId: string, renderPath: string): boolean {
  const result = setRenderPathStmt.run({
    apparel_id: apparelId,
    catalog_render_path: renderPath,
  });
  return result.changes > 0;
}

/**
 * Watermark purge. Deletes only samples at or below the rowid the UI reports as
 * exported, so samples captured while the export was running are preserved.
 * There is deliberately no "purge everything" path.
 */
const purgeThroughStmt = flywheelDb.prepare(
  'DELETE FROM flywheel_training WHERE rowid <= ?',
);

export function purgeFlywheelThrough(exportedThroughRowId: number): number {
  if (!Number.isFinite(exportedThroughRowId) || exportedThroughRowId < 0) return 0;
  const result = purgeThroughStmt.run(exportedThroughRowId);
  logger.info(
    `Flywheel purge: removed ${result.changes} sample(s) at or below rowid ${exportedThroughRowId}.`,
  );
  return result.changes;
}

/** Highest rowid currently stored — the watermark the UI should export through. */
const maxRowIdStmt = flywheelDb.prepare(
  'SELECT COALESCE(MAX(rowid), 0) AS max_id FROM flywheel_training',
);

export function flywheelMaxRowId(): number {
  return (maxRowIdStmt.get() as { max_id: number }).max_id;
}

export function closeFlywheelDb(): void {
  try {
    flywheelDb.close();
  } catch (error) {
    logger.warn('Failed to close flywheel DB cleanly', error);
  }
}

logger.info(
  `Flywheel DB ready at ${flywheelDbPath} (cap ${env.flywheelMaxRecords}, threshold ${env.flywheelConfidenceThreshold})`,
);
