import { controlDb } from './controlDb';

/**
 * The reference-data half of the control channel.
 *
 * The dashboard proposes taxonomy changes by inserting into
 * `reference_data_requests`; this middleware is the **only** process that writes
 * the CSV files, so there is exactly one writer and no file-level contention.
 * The same handoff shape as credentials and operator accounts: submit, poll,
 * read `result_detail`.
 *
 * Schema lives in controlDb.ts with the rest, so the UI never races a table into
 * existence. See UI_messaging_protocol.md v1.4 §9.
 */

export interface ReferenceRequestRow {
  id: number;
  action: string;
  table_name: string;
  english: string;
  armenian: string | null;
  entry_id: number | null;
  submitted_at: number;
  submitted_by: string | null;
  status: string;
  result_detail: string | null;
  resolved_at: number | null;
}

const takePendingStmt = controlDb.prepare(`
  SELECT * FROM reference_data_requests WHERE status = 'PENDING' ORDER BY id ASC
`);

const resolveStmt = controlDb.prepare(`
  UPDATE reference_data_requests
  SET status = @status, result_detail = @detail, resolved_at = @now
  WHERE id = @id
`);

export function takePendingReferenceRequests(): ReferenceRequestRow[] {
  return takePendingStmt.all() as ReferenceRequestRow[];
}

export function resolveReferenceRequest(
  id: number,
  status: 'APPLIED' | 'REJECTED',
  detail: string,
): void {
  resolveStmt.run({ id, status, detail, now: Date.now() });
}

const upsertStatusStmt = controlDb.prepare(`
  INSERT INTO reference_data_status (id, version, counts_json, untranslated, loaded_at, updated_at)
  VALUES (1, @version, @counts_json, @untranslated, @loaded_at, @now)
  ON CONFLICT(id) DO UPDATE SET
    version      = excluded.version,
    counts_json  = excluded.counts_json,
    untranslated = excluded.untranslated,
    loaded_at    = excluded.loaded_at,
    updated_at   = excluded.updated_at
`);

/** Publishes what the fleet is currently being served. */
export function publishReferenceStatus(status: {
  version: string;
  loadedAt: number;
  counts: unknown;
  untranslated: number;
}): void {
  upsertStatusStmt.run({
    version: status.version,
    counts_json: JSON.stringify(status.counts),
    untranslated: status.untranslated,
    loaded_at: status.loadedAt,
    now: Date.now(),
  });
}
