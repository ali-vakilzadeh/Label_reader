import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { RenderingStatus, ServerScanRow } from '../types';

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

const insertStmt = operationalDb.prepare(`
  INSERT INTO server_scans (
    apparel_id, cloned_from, username, timestamp, raw_json_data,
    key_photo_path, image_paths, catalog_image_url, rendering_status,
    render_attempts, render_error, created_at, updated_at
  ) VALUES (
    @apparel_id, @cloned_from, @username, @timestamp, @raw_json_data,
    @key_photo_path, @image_paths, @catalog_image_url, @rendering_status,
    @render_attempts, @render_error, @created_at, @updated_at
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
    -- A re-scan supersedes the old photos, so it earns a fresh render budget.
    render_attempts   = 0,
    render_error      = NULL,
    updated_at        = excluded.updated_at
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
}

export function upsertScan(input: UpsertScanInput): void {
  const now = Date.now();
  insertStmt.run({
    ...input,
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

export function closeOperationalDb(): void {
  try {
    operationalDb.close();
  } catch (error) {
    logger.warn('Failed to close operational DB cleanly', error);
  }
}

logger.info(`Operational DB ready at ${path.join(env.dataDir, 'server_scans.db')}`);
