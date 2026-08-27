import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { ExtractionStatus, RenderingStatus, ServerScanRow } from '../types';

/**
 * Primary operational database (server_scans.db).
 *
 * This is the ONLY database exposed to client apps and dashboards. The training
 * flywheel lives in a physically separate file (see flywheelDb.ts) so that no
 * dashboard query can ever reach it by accident.
 */
export const operationalDb = new Database(path.join(env.dataDir, 'server_scans.db'));

operationalDb.pragma('journal_mode = WAL');
operationalDb.pragma('foreign_keys = ON');
operationalDb.pragma('busy_timeout = 5000');

operationalDb.exec(`
  CREATE TABLE IF NOT EXISTS server_scans (
    apparel_id        TEXT PRIMARY KEY,
    cloned_from       TEXT,
    username          TEXT NOT NULL,
    timestamp         TEXT NOT NULL,
    raw_json_data     TEXT NOT NULL,
    key_photo_path    TEXT,
    image_paths       TEXT,
    catalog_image_url TEXT NOT NULL,
    rendering_status  TEXT NOT NULL DEFAULT 'PENDING',
    render_attempts   INTEGER NOT NULL DEFAULT 0,
    render_error      TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_scans_rendering_status ON server_scans (rendering_status);
  CREATE INDEX IF NOT EXISTS idx_scans_created_at       ON server_scans (created_at);
  CREATE INDEX IF NOT EXISTS idx_scans_username         ON server_scans (username);
  CREATE INDEX IF NOT EXISTS idx_scans_cloned_from      ON server_scans (cloned_from);
`);

/**
 * Minimal forward-only migration: adds a column when an older database predates
 * it. SQLite cannot add a column conditionally, so the table is inspected first.
 */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = operationalDb.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (columns.some((entry) => entry.name === column)) return;
  operationalDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  logger.info(`Migrated ${table}: added column ${column}`);
}

// The extraction lifecycle was added after the first build; databases created by
// the original schema are upgraded in place rather than rebuilt.
ensureColumn('server_scans', 'extraction_status', "TEXT NOT NULL DEFAULT 'COMPLETED'");
ensureColumn('server_scans', 'extraction_attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('server_scans', 'extraction_error', 'TEXT');
ensureColumn('server_scans', 'extraction_fault_code', 'TEXT');
ensureColumn('server_scans', 'next_attempt_at', 'INTEGER');
// Content fingerprint of the uploaded photos, so a device re-submitting the very
// same scan (because it lost the response) can be answered from store instead of
// re-billing the vision API.
ensureColumn('server_scans', 'image_digest', 'TEXT');
ensureColumn('server_scans', 'completed_at', 'INTEGER');

operationalDb.exec(`
  CREATE INDEX IF NOT EXISTS idx_scans_extraction
    ON server_scans (extraction_status, next_attempt_at);
`);

const insertStmt = operationalDb.prepare(`
  INSERT INTO server_scans (
    apparel_id, cloned_from, username, timestamp, raw_json_data,
    key_photo_path, image_paths, catalog_image_url, rendering_status,
    render_attempts, render_error, extraction_status, extraction_attempts,
    extraction_error, extraction_fault_code, next_attempt_at, image_digest,
    created_at, updated_at
  ) VALUES (
    @apparel_id, @cloned_from, @username, @timestamp, @raw_json_data,
    @key_photo_path, @image_paths, @catalog_image_url, @rendering_status,
    @render_attempts, @render_error, @extraction_status, 0,
    NULL, NULL, NULL, @image_digest,
    @created_at, @updated_at
  )
  ON CONFLICT(apparel_id) DO UPDATE SET
    cloned_from       = excluded.cloned_from,
    username          = excluded.username,
    timestamp         = excluded.timestamp,
    raw_json_data     = excluded.raw_json_data,
    key_photo_path    = excluded.key_photo_path,
    image_paths       = excluded.image_paths,
    catalog_image_url = excluded.catalog_image_url,
    rendering_status  = excluded.rendering_status,
    extraction_status = excluded.extraction_status,
    -- A re-scan supersedes the old photos, so it earns a fresh render budget
    -- and a fresh extraction budget.
    render_attempts     = 0,
    render_error        = NULL,
    extraction_attempts = 0,
    extraction_error    = NULL,
    next_attempt_at     = NULL,
    image_digest        = excluded.image_digest,
    updated_at          = excluded.updated_at
`);

const selectByIdStmt = operationalDb.prepare(
  'SELECT * FROM server_scans WHERE apparel_id = ?',
);

/**
 * Render queue. Includes rows that failed on an earlier night but still have
 * attempts left, so a transient outage self-heals on the next run. SKIPPED rows
 * (no key photo on file) are never retried — nothing would change.
 */
const selectPendingStmt = operationalDb.prepare(`
  SELECT * FROM server_scans
  WHERE key_photo_path IS NOT NULL
    AND (
      rendering_status = 'PENDING'
      OR (rendering_status = 'FAILED' AND render_attempts < @max_attempts)
    )
  ORDER BY created_at ASC
  LIMIT @limit
`);

const updateRenderStatusStmt = operationalDb.prepare(`
  UPDATE server_scans
  SET rendering_status = @rendering_status,
      render_error     = @render_error,
      render_attempts  = render_attempts + @attempt_delta,
      updated_at       = @updated_at
  WHERE apparel_id = @apparel_id
`);

const updateExtractionStmt = operationalDb.prepare(`
  UPDATE server_scans
  SET raw_json_data = @raw_json_data,
      updated_at    = @updated_at
  WHERE apparel_id = @apparel_id
`);

export interface UpsertScanInput {
  apparel_id: string;
  cloned_from: string | null;
  username: string;
  timestamp: string;
  raw_json_data: string;
  key_photo_path: string | null;
  image_paths: string | null;
  catalog_image_url: string;
  rendering_status: RenderingStatus;
  extraction_status: ExtractionStatus;
  /** SHA-256 over the uploaded photo bytes; null for clones. */
  image_digest?: string | null;
}

export function upsertScan(input: UpsertScanInput): void {
  const now = Date.now();
  insertStmt.run({
    ...input,
    image_digest: input.image_digest ?? null,
    render_attempts: 0,
    render_error: null,
    created_at: now,
    updated_at: now,
  });
}

export function getScan(apparelId: string): ServerScanRow | undefined {
  return selectByIdStmt.get(apparelId) as ServerScanRow | undefined;
}

export function getPendingRenders(
  limit: number,
  maxAttempts = env.renderMaxAttempts,
): ServerScanRow[] {
  return selectPendingStmt.all({ limit, max_attempts: maxAttempts }) as ServerScanRow[];
}

export function setRenderingStatus(
  apparelId: string,
  status: RenderingStatus,
  error: string | null = null,
  countAttempt = true,
): void {
  updateRenderStatusStmt.run({
    apparel_id: apparelId,
    rendering_status: status,
    render_error: error,
    attempt_delta: countAttempt ? 1 : 0,
    updated_at: Date.now(),
  });
}

/** Rewrites the stored extraction payload, e.g. after a supervisor correction. */
export function updateExtraction(apparelId: string, rawJson: string): void {
  updateExtractionStmt.run({
    apparel_id: apparelId,
    raw_json_data: rawJson,
    updated_at: Date.now(),
  });
}

// ------------------------------------------------------- extraction queue --

/**
 * The durable intake queue. A scan reaches PENDING the moment its photos are on
 * disk — before Gemini is ever called — so an outage costs latency, never data.
 */
const claimExtractionStmt = operationalDb.prepare(`
  SELECT * FROM server_scans
  WHERE extraction_status = 'PENDING'
    AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
    AND image_paths IS NOT NULL
  ORDER BY created_at ASC
  LIMIT @limit
`);

const completeExtractionStmt = operationalDb.prepare(`
  UPDATE server_scans
  SET raw_json_data         = @raw_json_data,
      extraction_status     = 'COMPLETED',
      extraction_error      = NULL,
      extraction_fault_code = NULL,
      next_attempt_at       = NULL,
      completed_at          = @now,
      updated_at            = @now
  WHERE apparel_id = @apparel_id
`);

const failExtractionStmt = operationalDb.prepare(`
  UPDATE server_scans
  SET extraction_status     = @extraction_status,
      extraction_attempts   = extraction_attempts + 1,
      extraction_error      = @extraction_error,
      extraction_fault_code = @extraction_fault_code,
      next_attempt_at       = @next_attempt_at,
      updated_at            = @now
  WHERE apparel_id = @apparel_id
`);

const countByExtractionStmt = operationalDb.prepare(`
  SELECT extraction_status AS status, COUNT(*) AS total
  FROM server_scans GROUP BY extraction_status
`);

const listParkedStmt = operationalDb.prepare(`
  SELECT * FROM server_scans
  WHERE extraction_status = 'PARKED'
  ORDER BY updated_at DESC
  LIMIT ?
`);

/** Rows owed an extraction attempt right now. */
export function claimPendingExtractions(limit: number): ServerScanRow[] {
  return claimExtractionStmt.all({ limit, now: Date.now() }) as ServerScanRow[];
}

export function completeExtraction(apparelId: string, rawJson: string): void {
  completeExtractionStmt.run({
    apparel_id: apparelId,
    raw_json_data: rawJson,
    now: Date.now(),
  });
}

/**
 * Records a failed attempt. The row stays PENDING (and therefore queued) unless
 * the payload itself is unusable, in which case it is PARKED for human review —
 * parked rows are still never deleted.
 */
export function failExtraction(
  apparelId: string,
  status: ExtractionStatus,
  faultCode: string,
  error: string,
  nextAttemptAt: number | null,
): void {
  failExtractionStmt.run({
    apparel_id: apparelId,
    extraction_status: status,
    extraction_fault_code: faultCode,
    extraction_error: error.slice(0, 500),
    next_attempt_at: nextAttemptAt,
    now: Date.now(),
  });
}

/**
 * Drops the retry timer on every queued scan. Called when an operator resolves
 * the fault that caused a pause — the backoff was earned by a condition that no
 * longer applies.
 */
const clearBackoffStmt = operationalDb.prepare(`
  UPDATE server_scans
  SET next_attempt_at = NULL
  WHERE extraction_status = 'PENDING' AND next_attempt_at IS NOT NULL
`);

export function clearExtractionBackoff(): number {
  return clearBackoffStmt.run().changes;
}

export interface ExtractionCounts {
  pending: number;
  completed: number;
  parked: number;
}

export function extractionCounts(): ExtractionCounts {
  const rows = countByExtractionStmt.all() as { status: string; total: number }[];
  const counts: ExtractionCounts = { pending: 0, completed: 0, parked: 0 };
  for (const row of rows) {
    if (row.status === 'PENDING') counts.pending = row.total;
    else if (row.status === 'COMPLETED') counts.completed = row.total;
    else if (row.status === 'PARKED') counts.parked = row.total;
  }
  return counts;
}

export function listParkedScans(limit = 100): ServerScanRow[] {
  return listParkedStmt.all(limit) as ServerScanRow[];
}

export function closeOperationalDb(): void {
  try {
    operationalDb.close();
  } catch (error) {
    logger.warn('Failed to close operational DB cleanly', error);
  }
}

logger.info(`Operational DB ready at ${path.join(env.dataDir, 'server_scans.db')}`);
