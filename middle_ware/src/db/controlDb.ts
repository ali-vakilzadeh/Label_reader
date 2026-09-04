import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { MESSAGE_CATALOGUE } from './messageCatalogue';

/**
 * Shared control database (control.db) — the message bus between this
 * middleware and the separate Web UI running on the same host.
 *
 * There is no software coupling: the two processes never call each other. They
 * exchange state through this file, which SQLite makes safe in ways a plain JSON
 * file cannot:
 *
 *   - commits are atomic, so a reader never sees a half-written message
 *   - WAL mode lets the UI read while the middleware writes, without blocking
 *   - both directions are append-only tables with acknowledgement columns, so a
 *     message cannot be lost by being overwritten before the other side polls
 *
 * The UI MUST open this file with:
 *     PRAGMA journal_mode = WAL;      -- already set, but harmless to repeat
 *     PRAGMA busy_timeout = 5000;     -- wait rather than fail on contention
 *
 * File permissions must let both service accounts read AND write the database
 * plus its -wal and -shm siblings (a shared group with 0660 is the usual answer).
 * SQLite needs write access for readers too, because WAL readers touch the shm.
 */

const controlDbPath = path.join(env.dataDir, 'control.db');
export const controlDb = new Database(controlDbPath);

controlDb.pragma('journal_mode = WAL');
controlDb.pragma('busy_timeout = 5000');
controlDb.pragma('synchronous = NORMAL');

controlDb.exec(`
  -- ---------------------------------------------------------------- dictionary
  CREATE TABLE IF NOT EXISTS message_dictionary (
    code            TEXT PRIMARY KEY,
    severity        TEXT NOT NULL,          -- INFO | WARNING | CRITICAL
    category        TEXT NOT NULL,          -- VISION | FLYWHEEL | RENDER | SYSTEM
    requires_action INTEGER NOT NULL,       -- 1 = a human must do something
    default_text    TEXT NOT NULL,          -- English, shown when no translation
    operator_hint   TEXT,                   -- what to actually do about it
    updated_at      INTEGER NOT NULL
  );

  -- Localised text. The UI resolves: translation for locale -> default_text.
  CREATE TABLE IF NOT EXISTS message_translations (
    code       TEXT NOT NULL,
    locale     TEXT NOT NULL,               -- BCP-47, e.g. 'hy', 'ru'
    text       TEXT NOT NULL,
    hint       TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (code, locale)
  );

  -- ------------------------------------------------------------------- status
  -- Single row. Current state plus a heartbeat, so the UI can tell a healthy
  -- server from one that died while reporting OK.
  CREATE TABLE IF NOT EXISTS server_status (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    state             TEXT NOT NULL,        -- OK | RETRYING | DEGRADED | BLOCKED
    vision_state      TEXT NOT NULL,        -- OK | PAUSED
    active_fault      TEXT,                 -- message_dictionary.code or NULL
    active_fault_since INTEGER,
    detail            TEXT,
    heartbeat_at      INTEGER NOT NULL,
    started_at        INTEGER NOT NULL,
    queue_pending     INTEGER NOT NULL DEFAULT 0,
    queue_parked      INTEGER NOT NULL DEFAULT 0,
    flywheel_records  INTEGER NOT NULL DEFAULT 0,
    flywheel_capacity INTEGER NOT NULL DEFAULT 0,
    updated_at        INTEGER NOT NULL
  );

  -- ------------------------------------------------- middleware -> UI events
  -- Append-only. An unresolved event of the same code is coalesced by bumping
  -- its occurrences counter rather than inserting a duplicate, so a retry storm
  -- cannot flood the table while still preserving one durable row per condition.
  CREATE TABLE IF NOT EXISTS server_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT NOT NULL,
    severity        TEXT NOT NULL,
    detail          TEXT,
    context_json    TEXT,
    occurrences     INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL,
    last_seen_at    INTEGER NOT NULL,
    acknowledged_at INTEGER,                -- set by the UI
    acknowledged_by TEXT,
    resolved_at     INTEGER                 -- set by the middleware when it clears
  );

  CREATE INDEX IF NOT EXISTS idx_events_open ON server_events (resolved_at, code);
  CREATE INDEX IF NOT EXISTS idx_events_created ON server_events (created_at);

  -- ------------------------------------------------- UI -> middleware commands
  -- Append-only with an explicit lifecycle, so the UI can always distinguish
  -- "not polled yet" from "in progress" from "done".
  CREATE TABLE IF NOT EXISTS ui_commands (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    command       TEXT NOT NULL,
    payload_json  TEXT,
    issued_at     INTEGER NOT NULL,
    issued_by     TEXT,
    status        TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING|IN_PROGRESS|DONE|FAILED|REJECTED
    claimed_at    INTEGER,
    completed_at  INTEGER,
    result_detail TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_commands_status ON ui_commands (status, id);
`);
/*
 * Tables owned by other modules, created HERE on purpose.
 *
 * control.db is opened by a second process (the Web UI). If each module created
 * its own tables on first import, the visible schema would depend on the
 * middleware's import order, and a UI connecting mid-boot could hit "no such
 * table". Declaring the whole schema at open time removes that race; the logic
 * for these tables still lives in visionSettings.ts and appUsers.ts.
 */
controlDb.exec(`
  CREATE TABLE IF NOT EXISTS vision_settings (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    api_key_ciphertext  TEXT,
    api_key_iv          TEXT,
    api_key_tag         TEXT,
    api_key_fingerprint TEXT,
    vision_model        TEXT,
    image_model         TEXT,
    validation_status   TEXT NOT NULL DEFAULT 'UNSET',
    validation_detail   TEXT,
    validated_at        INTEGER,
    updated_at          INTEGER,
    updated_by          TEXT
  );
  INSERT OR IGNORE INTO vision_settings (id, validation_status) VALUES (1, 'UNSET');

  CREATE TABLE IF NOT EXISTS vision_settings_pending (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key       TEXT,
    vision_model  TEXT,
    image_model   TEXT,
    submitted_at  INTEGER NOT NULL,
    submitted_by  TEXT,
    status        TEXT NOT NULL DEFAULT 'PENDING',
    result_detail TEXT,
    resolved_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_vision_pending ON vision_settings_pending (status, id);

  CREATE TABLE IF NOT EXISTS app_users (
    username        TEXT PRIMARY KEY,
    display_name    TEXT,
    password_hash   TEXT NOT NULL,
    password_salt   TEXT NOT NULL,
    password_params TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'ACTIVE',
    tokens_valid_from INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    created_by      TEXT,
    updated_at      INTEGER NOT NULL,
    updated_by      TEXT,
    last_login_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_app_users_status ON app_users (status);

  CREATE TABLE IF NOT EXISTS app_user_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    action        TEXT NOT NULL,
    username      TEXT NOT NULL,
    password      TEXT,
    display_name  TEXT,
    submitted_at  INTEGER NOT NULL,
    submitted_by  TEXT,
    status        TEXT NOT NULL DEFAULT 'PENDING',
    result_detail TEXT,
    resolved_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_app_user_requests ON app_user_requests (status, id);

  -- ------------------------------------------- reference data (UI <-> middleware)
  -- Supervisor decisions about the client's taxonomy tables. The UI proposes;
  -- the middleware validates and is the only process that writes the CSVs.
  -- Additive only: SET_ARMENIAN fills in a label, ADD_ENTRY appends a row.
  -- There is no rename and no delete, because the English key is the join every
  -- stored scan and every delivered export already depends on.
  CREATE TABLE IF NOT EXISTS reference_data_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    action        TEXT NOT NULL,          -- SET_ARMENIAN | ADD_ENTRY
    table_name    TEXT NOT NULL,          -- sub_category|brand|country|material|color|gender|season
    english       TEXT NOT NULL,
    armenian      TEXT,
    entry_id      INTEGER,                -- NULL on ADD_ENTRY = assign the next free id
    submitted_at  INTEGER NOT NULL,
    submitted_by  TEXT,
    status        TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING|APPLIED|REJECTED
    result_detail TEXT,
    resolved_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_reference_requests ON reference_data_requests (status, id);

  -- Single row. What the fleet is currently being served, so the UI can show the
  -- live version and count what still needs an Armenian label.
  CREATE TABLE IF NOT EXISTS reference_data_status (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    version      TEXT NOT NULL,
    counts_json  TEXT NOT NULL,
    untranslated INTEGER NOT NULL DEFAULT 0,
    loaded_at    INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  CREATE VIEW IF NOT EXISTS app_users_public AS
    SELECT username, display_name, status, created_at, created_by,
           updated_at, updated_by, last_login_at
    FROM app_users
    WHERE status <> 'DELETED';
`);


// --------------------------------------------------------------- dictionary --

const upsertMessageStmt = controlDb.prepare(`
  INSERT INTO message_dictionary (code, severity, category, requires_action, default_text, operator_hint, updated_at)
  VALUES (@code, @severity, @category, @requires_action, @default_text, @operator_hint, @updated_at)
  ON CONFLICT(code) DO UPDATE SET
    severity        = excluded.severity,
    category        = excluded.category,
    requires_action = excluded.requires_action,
    default_text    = excluded.default_text,
    operator_hint   = excluded.operator_hint,
    updated_at      = excluded.updated_at
`);

/**
 * Reseeds the dictionary at every boot so a middleware upgrade cannot leave the
 * UI resolving a code that no longer exists. Translations are keyed separately
 * and are never touched here — operator-supplied Armenian text survives upgrades.
 */
const seedDictionary = controlDb.transaction((): void => {
  const now = Date.now();
  for (const entry of MESSAGE_CATALOGUE) {
    upsertMessageStmt.run({
      code: entry.code,
      severity: entry.severity,
      category: entry.category,
      requires_action: entry.requiresAction ? 1 : 0,
      default_text: entry.defaultText,
      operator_hint: entry.operatorHint ?? null,
      updated_at: now,
    });
  }
});

seedDictionary();

// ------------------------------------------------------------------ status --

const initStatusStmt = controlDb.prepare(`
  INSERT INTO server_status (
    id, state, vision_state, active_fault, active_fault_since, detail,
    heartbeat_at, started_at, queue_pending, queue_parked,
    flywheel_records, flywheel_capacity, updated_at
  ) VALUES (1, 'OK', 'OK', NULL, NULL, NULL, @now, @now, 0, 0, 0, @capacity, @now)
  ON CONFLICT(id) DO UPDATE SET
    started_at   = @now,
    heartbeat_at = @now,
    updated_at   = @now
`);

const readStatusStmt = controlDb.prepare('SELECT * FROM server_status WHERE id = 1');

const heartbeatStmt = controlDb.prepare(`
  UPDATE server_status
  SET heartbeat_at      = @now,
      queue_pending     = @queue_pending,
      queue_parked      = @queue_parked,
      flywheel_records  = @flywheel_records,
      flywheel_capacity = @flywheel_capacity,
      updated_at        = @now
  WHERE id = 1
`);

const setStateStmt = controlDb.prepare(`
  UPDATE server_status
  SET state              = @state,
      vision_state       = @vision_state,
      active_fault       = @active_fault,
      active_fault_since = @active_fault_since,
      detail             = @detail,
      updated_at         = @now
  WHERE id = 1
`);

export type ServerState = 'OK' | 'RETRYING' | 'DEGRADED' | 'BLOCKED';
export type VisionState = 'OK' | 'PAUSED';

export interface ServerStatusRow {
  id: number;
  state: ServerState;
  vision_state: VisionState;
  active_fault: string | null;
  active_fault_since: number | null;
  detail: string | null;
  heartbeat_at: number;
  started_at: number;
  queue_pending: number;
  queue_parked: number;
  flywheel_records: number;
  flywheel_capacity: number;
  updated_at: number;
}

/** Called once at boot. Preserves any pause that was in force before a restart. */
export function initialiseStatus(): ServerStatusRow {
  initStatusStmt.run({ now: Date.now(), capacity: env.flywheelMaxRecords });
  return readStatus();
}

// The singleton status row is a schema invariant, not something a caller has to
// remember to create. Seeding it here means a request that arrives before
// startControlService() reads a valid row instead of crashing on undefined.
initStatusStmt.run({ now: Date.now(), capacity: env.flywheelMaxRecords });

/**
 * Self-healing read. The singleton row is seeded with the schema, but it is read
 * on the scan-submission path, so a missing row must never be able to crash a
 * request. If it has somehow gone (manual surgery, a half-restored backup), it
 * is recreated rather than returning undefined to a caller that will dereference
 * it.
 */
export function readStatus(): ServerStatusRow {
  const row = readStatusStmt.get() as ServerStatusRow | undefined;
  if (row) return row;

  logger.warn('server_status row was missing; recreating it.');
  initStatusStmt.run({ now: Date.now(), capacity: env.flywheelMaxRecords });
  return readStatusStmt.get() as ServerStatusRow;
}

export interface HeartbeatCounters {
  queuePending: number;
  queueParked: number;
  flywheelRecords: number;
  flywheelCapacity: number;
}

export function writeHeartbeat(counters: HeartbeatCounters): void {
  heartbeatStmt.run({
    now: Date.now(),
    queue_pending: counters.queuePending,
    queue_parked: counters.queueParked,
    flywheel_records: counters.flywheelRecords,
    flywheel_capacity: counters.flywheelCapacity,
  });
}

export function setServerState(
  state: ServerState,
  visionState: VisionState,
  activeFault: string | null,
  detail: string | null,
): void {
  const current = readStatus();
  const now = Date.now();
  setStateStmt.run({
    state,
    vision_state: visionState,
    active_fault: activeFault,
    // Keep the original onset time while the same fault persists.
    active_fault_since:
      activeFault === null
        ? null
        : current.active_fault === activeFault
          ? (current.active_fault_since ?? now)
          : now,
    detail,
    now,
  });
}

// ------------------------------------------------------------------ events --

const findOpenEventStmt = controlDb.prepare(`
  SELECT * FROM server_events WHERE code = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1
`);

const insertEventStmt = controlDb.prepare(`
  INSERT INTO server_events (code, severity, detail, context_json, occurrences, created_at, last_seen_at)
  VALUES (@code, @severity, @detail, @context_json, 1, @now, @now)
`);

const bumpEventStmt = controlDb.prepare(`
  UPDATE server_events
  SET occurrences  = occurrences + 1,
      last_seen_at = @now,
      detail       = @detail,
      context_json = @context_json
  WHERE id = @id
`);

const resolveEventStmt = controlDb.prepare(`
  UPDATE server_events SET resolved_at = @now WHERE code = @code AND resolved_at IS NULL
`);

const listOpenEventsStmt = controlDb.prepare(`
  SELECT * FROM server_events WHERE resolved_at IS NULL ORDER BY id ASC
`);

export interface ServerEventRow {
  id: number;
  code: string;
  severity: string;
  detail: string | null;
  context_json: string | null;
  occurrences: number;
  created_at: number;
  last_seen_at: number;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  resolved_at: number | null;
}

/**
 * Raises an event, coalescing onto an existing unresolved row for the same code.
 * Returns the row id so callers can correlate.
 */
export const raiseEvent = controlDb.transaction(
  (code: string, detail: string | null, context?: unknown): number => {
    const catalogued = MESSAGE_CATALOGUE.find((entry) => entry.code === code);
    if (!catalogued) {
      // An uncatalogued code would render as a blank string in the UI.
      logger.warn(`raiseEvent called with uncatalogued code "${code}"`);
    }
    const now = Date.now();
    const contextJson = context === undefined ? null : JSON.stringify(context);
    const open = findOpenEventStmt.get(code) as ServerEventRow | undefined;

    if (open) {
      bumpEventStmt.run({ id: open.id, now, detail, context_json: contextJson });
      return open.id;
    }

    const result = insertEventStmt.run({
      code,
      severity: catalogued?.severity ?? 'WARNING',
      detail,
      context_json: contextJson,
      now,
    });
    logger.info(`Control event raised: ${code}${detail ? ` — ${detail}` : ''}`);
    return Number(result.lastInsertRowid);
  },
);

/** Marks every open event with this code resolved. Safe to call when none are open. */
export function resolveEvent(code: string): number {
  const result = resolveEventStmt.run({ code, now: Date.now() });
  if (result.changes > 0) logger.info(`Control event resolved: ${code}`);
  return result.changes;
}

export function listOpenEvents(): ServerEventRow[] {
  return listOpenEventsStmt.all() as ServerEventRow[];
}

// ---------------------------------------------------------------- commands --

const claimCommandsStmt = controlDb.prepare(`
  SELECT * FROM ui_commands WHERE status = 'PENDING' ORDER BY id ASC LIMIT ?
`);

const markCommandStmt = controlDb.prepare(`
  UPDATE ui_commands
  SET status        = @status,
      claimed_at    = COALESCE(claimed_at, @now),
      completed_at  = CASE WHEN @status IN ('DONE','FAILED','REJECTED') THEN @now ELSE completed_at END,
      result_detail = @result_detail
  WHERE id = @id
`);

const insertCommandStmt = controlDb.prepare(`
  INSERT INTO ui_commands (command, payload_json, issued_at, issued_by, status)
  VALUES (@command, @payload_json, @now, @issued_by, 'PENDING')
`);

export interface UiCommandRow {
  id: number;
  command: string;
  payload_json: string | null;
  issued_at: number;
  issued_by: string | null;
  status: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'FAILED' | 'REJECTED';
  claimed_at: number | null;
  completed_at: number | null;
  result_detail: string | null;
}

export function takePendingCommands(limit = 25): UiCommandRow[] {
  return claimCommandsStmt.all(limit) as UiCommandRow[];
}

export function markCommand(
  id: number,
  status: UiCommandRow['status'],
  resultDetail: string | null = null,
): void {
  markCommandStmt.run({ id, status, result_detail: resultDetail, now: Date.now() });
}

/** Used by tests and by the middleware's own maintenance paths. */
export function issueCommand(
  command: string,
  payload?: unknown,
  issuedBy = 'middleware',
): number {
  const result = insertCommandStmt.run({
    command,
    payload_json: payload === undefined ? null : JSON.stringify(payload),
    issued_by: issuedBy,
    now: Date.now(),
  });
  return Number(result.lastInsertRowid);
}

export function closeControlDb(): void {
  try {
    controlDb.close();
  } catch (error) {
    logger.warn('Failed to close control DB cleanly', error);
  }
}

logger.info(
  `Control DB ready at ${controlDbPath} (${MESSAGE_CATALOGUE.length} catalogued messages)`,
);
