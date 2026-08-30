import { getControlDb, getFlywheelDb } from '../db';
import { config } from '../config/env';
import { humanDuration } from '../utils/normalise';

/**
 * The middleware channel (plan §10), implementing UI_messaging_protocol.md v1.3.
 *
 * That document is locked. Where anything here disagrees with it, it wins.
 *
 * The UI may write exactly five things and nothing else:
 *   ui_commands · vision_settings_pending · app_user_requests · message_translations ·
 *   server_events.acknowledged_at/_by
 */

export type Locale = 'en' | 'hy';

export interface ServerStatus {
  id: number;
  state: 'OK' | 'RETRYING' | 'DEGRADED' | 'BLOCKED';
  vision_state: 'OK' | 'PAUSED';
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

export type BannerLevel = 'red' | 'amber' | 'blue' | 'green' | 'grey';

export interface Banner {
  level: BannerLevel;
  code: string;
  text: string;
  /** Shown under a pause. Factually true and prevents "the system is broken". */
  reassurance: string | null;
  action: { label: string; href: string } | null;
}

export function readStatus(): ServerStatus | null {
  const db = getControlDb();
  if (!db) return null;
  try {
    return (db.prepare('SELECT * FROM server_status WHERE id = 1').get() as ServerStatus) ?? null;
  } catch {
    return null;
  }
}

/**
 * Banner evaluation, in the protocol's order. Rule 1 is not optional: `state` reads OK
 * even when the process is dead, because it is simply the last value written. Only the
 * heartbeat proves the middleware is alive.
 */
export function banner(status: ServerStatus | null, locale: Locale = 'en'): Banner {
  if (!status) {
    return {
      level: 'grey',
      code: 'NO_CONTROL_DB',
      text: 'Middleware not reachable — control.db could not be opened.',
      reassurance:
        'The dashboard works without it. Imports, edits and exports are unaffected; only live server status and commands are unavailable.',
      action: null,
    };
  }

  const age = Date.now() - status.heartbeat_at;
  if (age > config.heartbeatDeadMs) {
    return {
      level: 'red',
      code: 'SERVER_UNREACHABLE',
      text: `Server unreachable — last seen ${new Date(status.heartbeat_at).toISOString().slice(11, 19)} (${humanDuration(age)} ago)`,
      reassurance: 'Scans already stored on the server are safe. Nothing is lost.',
      action: null,
    };
  }

  if (status.vision_state === 'PAUSED') {
    const fault = status.active_fault ? messageText(status.active_fault, locale) : null;
    return {
      level: 'red',
      code: status.active_fault ?? 'VISION_PAUSED',
      text: `Processing paused${fault ? ` — ${fault.text}` : ''}`,
      reassurance: pauseReassurance(status.queue_pending),
      action: actionFor(status.active_fault),
    };
  }

  if (status.state === 'RETRYING') {
    return { level: 'amber', code: 'RETRYING', text: 'Recovering automatically', reassurance: null, action: null };
  }

  if (status.queue_parked > 0) {
    return {
      level: 'amber',
      code: 'QUEUE_PARKED_ITEMS',
      text: `${status.queue_parked} scan${status.queue_parked === 1 ? '' : 's'} need review`,
      reassurance: 'Parked scans are stored and never deleted, but they need a person.',
      action: { label: 'Review parked scans', href: '/items?review_state=PARKED' },
    };
  }

  if (status.queue_pending > 0) {
    // Non-zero is healthy throughput under async processing. Never render it as a fault.
    return {
      level: 'blue',
      code: 'QUEUE_PENDING',
      text: `${status.queue_pending} scan${status.queue_pending === 1 ? '' : 's'} processing — draining`,
      reassurance: null,
      action: null,
    };
  }

  return { level: 'green', code: 'OK', text: 'All systems normal', reassurance: null, action: null };
}

function pauseReassurance(pending: number): string {
  return `Scanning continues normally. ${pending} scan${pending === 1 ? ' is' : 's are'} safely stored and will be processed automatically once this is resolved. Nothing is lost.`;
}

/** Per-code action buttons, from server_setting_page.md §3. Switch on code, never text. */
function actionFor(code: string | null): { label: string; href: string } | null {
  switch (code) {
    case 'VISION_NOT_CONFIGURED':
      return { label: 'Add API key', href: '/settings/server#vision' };
    case 'VISION_BAD_CREDENTIALS':
      return { label: 'Update API key', href: '/settings/server#vision' };
    case 'VISION_MODEL_UNAVAILABLE':
      return { label: 'Change model', href: '/settings/server#vision' };
    case 'VISION_SETTINGS_REJECTED':
      return { label: 'Try again', href: '/settings/server#vision' };
    case 'VISION_BILLING_REQUIRED':
      return { label: "I've fixed billing", href: '/settings/server/command/VISION_ACCOUNT_REFRESH' };
    case 'VISION_RATE_LIMIT_DAY':
      return { label: 'Retry now', href: '/settings/server/command/VISION_ACCOUNT_REFRESH' };
    case 'FLYWHEEL_FULL':
    case 'FLYWHEEL_NEARLY_FULL':
      return { label: 'Export & purge', href: '/settings/training' };
    case 'QUEUE_PARKED_ITEMS':
      return { label: 'Review parked scans', href: '/items?review_state=PARKED' };
    case 'USER_REQUEST_REJECTED':
      return { label: 'Review request', href: '/settings/server#operators' };
    default:
      return null;
  }
}

export { actionFor };

/* ------------------------------- events ------------------------------- */

export interface EventRow {
  id: number;
  code: string;
  occurrences: number;
  created_at: number;
  last_seen_at: number;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  detail: string | null;
  context_json: string | null;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  category: string;
  requires_action: number;
  text: string;
  hint: string | null;
}

const EVENT_SELECT = `
  SELECT e.id, e.code, e.occurrences, e.created_at, e.last_seen_at,
         e.acknowledged_at, e.acknowledged_by, e.detail, e.context_json,
         d.severity, d.category, d.requires_action,
         COALESCE(t.text, d.default_text) AS text,
         COALESCE(t.hint, d.operator_hint) AS hint
    FROM server_events e
    JOIN message_dictionary d ON d.code = e.code
    LEFT JOIN message_translations t ON t.code = e.code AND t.locale = ?`;

export function openEvents(locale: Locale): EventRow[] {
  const db = getControlDb();
  if (!db) return [];
  try {
    return db
      .prepare(
        `${EVENT_SELECT}
         WHERE e.resolved_at IS NULL
         ORDER BY CASE d.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, e.id DESC`,
      )
      .all(localeCode(locale)) as EventRow[];
  } catch {
    return [];
  }
}

export function eventHistory(locale: Locale, limit = 100): EventRow[] {
  const db = getControlDb();
  if (!db) return [];
  try {
    return db.prepare(`${EVENT_SELECT} ORDER BY e.id DESC LIMIT ?`).all(localeCode(locale), limit) as EventRow[];
  } catch {
    return [];
  }
}

/** The UI may set these two columns, and only these two. Never `resolved_at`. */
export function acknowledgeEvent(id: number, actor: string): void {
  const db = getControlDb();
  if (!db) return;
  db.prepare(
    'UPDATE server_events SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ? AND acknowledged_at IS NULL',
  ).run(Date.now(), actor, id);
}

export function messageText(code: string, locale: Locale): { text: string; hint: string | null } | null {
  const db = getControlDb();
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(t.text, d.default_text) AS text, COALESCE(t.hint, d.operator_hint) AS hint
           FROM message_dictionary d
           LEFT JOIN message_translations t ON t.code = d.code AND t.locale = ?
          WHERE d.code = ?`,
      )
      .get(localeCode(locale), code) as { text: string; hint: string | null } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** The protocol uses the `hy` locale code for Armenian. */
export function localeCode(locale: Locale): string {
  return locale === 'hy' ? 'hy' : 'en';
}

/* ------------------------------ commands ------------------------------ */

export type CommandName =
  | 'VISION_ACCOUNT_REFRESH'
  | 'VISION_SETTINGS_UPDATED'
  | 'FLYWHEEL_DUMPED'
  | 'DRAIN_QUEUE_NOW'
  | 'PING';

export function issueCommand(command: CommandName, actor: string, payload?: unknown): number | null {
  const db = getControlDb();
  if (!db) return null;
  const info = db
    .prepare(
      `INSERT INTO ui_commands (command, payload_json, issued_at, issued_by, status)
       VALUES (?, ?, ?, ?, 'PENDING')`,
    )
    .run(command, payload === undefined ? null : JSON.stringify(payload), Date.now(), actor);
  return Number(info.lastInsertRowid);
}

export function readCommand(id: number) {
  const db = getControlDb();
  if (!db) return null;
  return db.prepare('SELECT * FROM ui_commands WHERE id = ?').get(id) ?? null;
}

export function recentCommands(limit = 20) {
  const db = getControlDb();
  if (!db) return [];
  return db.prepare('SELECT * FROM ui_commands ORDER BY id DESC LIMIT ?').all(limit);
}

/* -------------------------- vision credentials ------------------------- */

export function visionSettings() {
  const db = getControlDb();
  if (!db) return null;
  try {
    return (
      db
        .prepare(
          `SELECT api_key_fingerprint, vision_model, image_model, validation_status,
                  validation_detail, validated_at, updated_at, updated_by
             FROM vision_settings WHERE id = 1`,
        )
        .get() ?? null
    );
  } catch {
    return null;
  }
}

export function submitVisionSettings(
  actor: string,
  apiKey: string,
  visionModel: string | null,
  imageModel: string | null,
): number | null {
  const db = getControlDb();
  if (!db) return null;
  const info = db
    .prepare(
      `INSERT INTO vision_settings_pending (api_key, vision_model, image_model, submitted_at, submitted_by, status)
       VALUES (?, ?, ?, ?, ?, 'PENDING')`,
    )
    .run(apiKey, visionModel || null, imageModel || null, Date.now(), actor);
  // The key is never stored, logged or echoed by the dashboard. It leaves this function
  // and exists only in vision_settings_pending until the middleware decides its fate.
  return Number(info.lastInsertRowid);
}

export function pendingVisionSettings(limit = 5) {
  const db = getControlDb();
  if (!db) return [];
  try {
    return db
      .prepare(
        `SELECT id, vision_model, image_model, submitted_at, submitted_by, status, result_detail, resolved_at
           FROM vision_settings_pending ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
  } catch {
    return [];
  }
}

/* --------------------------- operator accounts ------------------------- */

export interface OperatorRow {
  username: string;
  display_name: string | null;
  status: 'ACTIVE' | 'DISABLED';
  created_at: number;
  created_by: string | null;
  updated_at: number | null;
  updated_by: string | null;
  last_login_at: number | null;
}

/** Read the view, never `app_users`. The view cannot expose a password hash. */
export function listOperators(): OperatorRow[] {
  const db = getControlDb();
  if (!db) return [];
  try {
    return db
      .prepare(
        `SELECT username, display_name, status, created_at, created_by, updated_at, updated_by, last_login_at
           FROM app_users_public ORDER BY username`,
      )
      .all() as OperatorRow[];
  } catch {
    return [];
  }
}

export type OperatorAction = 'CREATE' | 'SET_PASSWORD' | 'DISABLE' | 'ENABLE' | 'DELETE' | 'RENAME';

export function submitOperatorRequest(
  actor: string,
  action: OperatorAction,
  username: string,
  password?: string | null,
  displayName?: string | null,
): number | null {
  const db = getControlDb();
  if (!db) return null;
  const info = db
    .prepare(
      `INSERT INTO app_user_requests (action, username, password, display_name, submitted_at, submitted_by, status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
    )
    .run(action, username, password || null, displayName || null, Date.now(), actor);
  return Number(info.lastInsertRowid);
}

export function recentOperatorRequests(limit = 20) {
  const db = getControlDb();
  if (!db) return [];
  try {
    return db
      .prepare(
        `SELECT id, action, username, display_name, submitted_at, submitted_by, status, result_detail, resolved_at
           FROM app_user_requests ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
  } catch {
    return [];
  }
}

/** The three seeded test accounts use password = username and must not survive to production. */
export const SEEDED_TEST_ACCOUNTS = new Set(['minelli', 'karen', 'ali']);

/* ---------------------------- translations ----------------------------- */

export function messageDictionary(locale: Locale) {
  const db = getControlDb();
  if (!db) return [];
  try {
    return db
      .prepare(
        `SELECT d.code, d.category, d.severity, d.requires_action, d.default_text, d.operator_hint,
                t.text AS translated_text, t.hint AS translated_hint, t.updated_at AS translated_at
           FROM message_dictionary d
           LEFT JOIN message_translations t ON t.code = d.code AND t.locale = ?
          ORDER BY (t.code IS NOT NULL), d.category, d.code`,
      )
      .all(localeCode(locale));
  } catch {
    return [];
  }
}

export function saveTranslation(code: string, locale: string, text: string, hint: string | null): void {
  const db = getControlDb();
  if (!db) return;
  db.prepare(
    `INSERT INTO message_translations (code, locale, text, hint, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(code, locale) DO UPDATE
       SET text = excluded.text, hint = excluded.hint, updated_at = excluded.updated_at`,
  ).run(code, locale, text, hint, Date.now());
}

/* ------------------------------ flywheel ------------------------------- */

/**
 * Step 1 of the export sequence, and it must happen BEFORE the export.
 *
 * Between the UI starting an export and issuing the purge, the middleware keeps capturing
 * samples. Purging "everything" would destroy samples that were never exported. The
 * command is rejected outright without this watermark — deliberately.
 */
export function flywheelWatermark(): number | null {
  const db = getFlywheelDb();
  if (!db) return null;
  try {
    const row = db.prepare('SELECT MAX(rowid) AS watermark FROM flywheel_training').get() as {
      watermark: number | null;
    };
    return row?.watermark ?? null;
  } catch {
    return null;
  }
}

export function flywheelRows(watermark: number) {
  const db = getFlywheelDb();
  if (!db) return [];
  return db
    .prepare(
      `SELECT rowid AS rowid, apparel_id, unconfirmed_gemini_json, confirmed_json,
              lowest_confidence_score, created_at, confirmed_at
         FROM flywheel_training WHERE rowid <= ? ORDER BY rowid`,
    )
    .all(watermark);
}
