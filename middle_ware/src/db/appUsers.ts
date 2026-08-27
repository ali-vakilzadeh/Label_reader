import crypto from 'node:crypto';
import { controlDb } from './controlDb';
import { logger } from '../utils/logger';

/**
 * Per-operator accounts for the Android clients.
 *
 * The Web UI creates, disables and deletes operators; the middleware owns the
 * credentials. Passwords are never stored in the clear: the UI hands over a
 * plaintext candidate in `app_user_requests`, the middleware hashes it into
 * `app_users`, and the plaintext column is erased the moment the request is
 * resolved. Same handoff shape as the vision credentials, for the same reason —
 * the UI must not need write access to anything that holds a live secret.
 *
 * Hashing is scrypt with a per-user random salt (no new dependency, and the
 * parameters are stored alongside the hash so they can be raised later without
 * invalidating existing rows).
 */

controlDb.exec(`
  CREATE TABLE IF NOT EXISTS app_users (
    username        TEXT PRIMARY KEY,
    display_name    TEXT,
    password_hash   TEXT NOT NULL,
    password_salt   TEXT NOT NULL,
    -- Stored so the cost parameters can be raised later without a flag day.
    password_params TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE | DISABLED | DELETED
    /*
     * Tokens issued before this instant are refused. Bumping it is how a
     * password change or a disable takes effect immediately, instead of waiting
     * out the 30-day JWT lifetime.
     */
    tokens_valid_from INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    created_by      TEXT,
    updated_at      INTEGER NOT NULL,
    updated_by      TEXT,
    last_login_at   INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_app_users_status ON app_users (status);

  /*
   * UI -> middleware handoff. \`password\` holds plaintext only between
   * submission and processing, and is nulled when the request resolves.
   */
  CREATE TABLE IF NOT EXISTS app_user_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    action        TEXT NOT NULL,     -- CREATE | SET_PASSWORD | DISABLE | ENABLE | DELETE | RENAME
    username      TEXT NOT NULL,
    password      TEXT,
    display_name  TEXT,
    submitted_at  INTEGER NOT NULL,
    submitted_by  TEXT,
    status        TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | APPLIED | REJECTED
    result_detail TEXT,
    resolved_at   INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_app_user_requests ON app_user_requests (status, id);

  /*
   * Safe projection for the UI: everything it needs to render an operator list,
   * and nothing that could leak a credential. The UI should read this, never
   * app_users directly.
   */
  CREATE VIEW IF NOT EXISTS app_users_public AS
    SELECT username, display_name, status, created_at, created_by,
           updated_at, updated_by, last_login_at
    FROM app_users
    WHERE status <> 'DELETED';
`);

// --- password hashing -------------------------------------------------------

const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64 } as const;

function hashPassword(password: string): {
  hash: string;
  salt: string;
  params: string;
} {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return {
    hash: derived.toString('base64'),
    salt: salt.toString('base64'),
    params: JSON.stringify(SCRYPT),
  };
}

/** Constant-time verification against the parameters stored with the row. */
function verifyPassword(password: string, row: AppUserRow): boolean {
  try {
    const params = JSON.parse(row.password_params) as typeof SCRYPT;
    const derived = crypto.scryptSync(password, Buffer.from(row.password_salt, 'base64'), params.keylen, {
      N: params.N,
      r: params.r,
      p: params.p,
    });
    const expected = Buffer.from(row.password_hash, 'base64');
    if (expected.length !== derived.length) return false;
    return crypto.timingSafeEqual(expected, derived);
  } catch (error) {
    logger.error(`Password verification failed for "${row.username}"`, error);
    return false;
  }
}

// --- types ------------------------------------------------------------------

export type AppUserStatus = 'ACTIVE' | 'DISABLED' | 'DELETED';
export type AppUserAction =
  | 'CREATE'
  | 'SET_PASSWORD'
  | 'DISABLE'
  | 'ENABLE'
  | 'DELETE'
  | 'RENAME';

export interface AppUserRow {
  username: string;
  display_name: string | null;
  password_hash: string;
  password_salt: string;
  password_params: string;
  status: AppUserStatus;
  tokens_valid_from: number;
  created_at: number;
  created_by: string | null;
  updated_at: number;
  updated_by: string | null;
  last_login_at: number | null;
}

export interface AppUserRequestRow {
  id: number;
  action: AppUserAction;
  username: string;
  password: string | null;
  display_name: string | null;
  submitted_at: number;
  submitted_by: string | null;
  status: 'PENDING' | 'APPLIED' | 'REJECTED';
  result_detail: string | null;
  resolved_at: number | null;
}

// --- statements -------------------------------------------------------------

const getUserStmt = controlDb.prepare('SELECT * FROM app_users WHERE username = ?');
const listUsersStmt = controlDb.prepare(
  "SELECT * FROM app_users WHERE status <> 'DELETED' ORDER BY username",
);
const insertUserStmt = controlDb.prepare(`
  INSERT INTO app_users (
    username, display_name, password_hash, password_salt, password_params,
    status, tokens_valid_from, created_at, created_by, updated_at, updated_by
  ) VALUES (
    @username, @display_name, @hash, @salt, @params,
    'ACTIVE', @now, @now, @actor, @now, @actor
  )
`);
const setPasswordStmt = controlDb.prepare(`
  UPDATE app_users
  SET password_hash = @hash, password_salt = @salt, password_params = @params,
      -- A password change revokes sessions opened with the old one.
      tokens_valid_from = @now, updated_at = @now, updated_by = @actor
  WHERE username = @username
`);
const setStatusStmt = controlDb.prepare(`
  UPDATE app_users
  SET status = @status,
      -- Disabling or deleting must take effect now, not in 30 days.
      tokens_valid_from = CASE WHEN @status = 'ACTIVE' THEN tokens_valid_from ELSE @now END,
      updated_at = @now, updated_by = @actor
  WHERE username = @username
`);
const renameStmt = controlDb.prepare(`
  UPDATE app_users SET display_name = @display_name, updated_at = @now, updated_by = @actor
  WHERE username = @username
`);
const touchLoginStmt = controlDb.prepare(
  'UPDATE app_users SET last_login_at = ? WHERE username = ?',
);
const countActiveStmt = controlDb.prepare(
  "SELECT COUNT(*) AS n FROM app_users WHERE status = 'ACTIVE'",
);

const takeRequestsStmt = controlDb.prepare(
  "SELECT * FROM app_user_requests WHERE status = 'PENDING' ORDER BY id ASC LIMIT ?",
);
const resolveRequestStmt = controlDb.prepare(`
  UPDATE app_user_requests
  SET status = @status, result_detail = @detail, resolved_at = @now,
      -- Plaintext never outlives the request that carried it.
      password = NULL
  WHERE id = @id
`);
const submitRequestStmt = controlDb.prepare(`
  INSERT INTO app_user_requests (action, username, password, display_name, submitted_at, submitted_by, status)
  VALUES (@action, @username, @password, @display_name, @now, @submitted_by, 'PENDING')
`);

// --- API --------------------------------------------------------------------

export function getUser(username: string): AppUserRow | undefined {
  return getUserStmt.get(username) as AppUserRow | undefined;
}

export function listUsers(): AppUserRow[] {
  return listUsersStmt.all() as AppUserRow[];
}

export function countActiveUsers(): number {
  return (countActiveStmt.get() as { n: number }).n;
}

export function createUser(
  username: string,
  password: string,
  displayName: string | null,
  actor: string | null,
): void {
  const { hash, salt, params } = hashPassword(password);
  insertUserStmt.run({
    username,
    display_name: displayName,
    hash,
    salt,
    params,
    actor,
    now: Date.now(),
  });
}

export function setUserPassword(username: string, password: string, actor: string | null): void {
  const { hash, salt, params } = hashPassword(password);
  setPasswordStmt.run({ username, hash, salt, params, actor, now: Date.now() });
}

export function setUserStatus(
  username: string,
  status: AppUserStatus,
  actor: string | null,
): void {
  setStatusStmt.run({ username, status, actor, now: Date.now() });
}

export function setDisplayName(
  username: string,
  displayName: string | null,
  actor: string | null,
): void {
  renameStmt.run({ username, display_name: displayName, actor, now: Date.now() });
}

export function recordLogin(username: string): void {
  touchLoginStmt.run(Date.now(), username);
}

export type AuthOutcome =
  | { result: 'OK'; user: AppUserRow }
  | { result: 'NO_SUCH_USER' }
  | { result: 'BAD_PASSWORD' }
  | { result: 'DISABLED' };

/**
 * Verifies a password against a stored operator account.
 * Returns NO_SUCH_USER when the account does not exist, so the caller can decide
 * whether to fall back to the legacy shared password.
 */
export function authenticate(username: string, password: string): AuthOutcome {
  const user = getUser(username);
  if (!user || user.status === 'DELETED') return { result: 'NO_SUCH_USER' };
  if (user.status === 'DISABLED') return { result: 'DISABLED' };
  if (!verifyPassword(password, user)) return { result: 'BAD_PASSWORD' };
  return { result: 'OK', user };
}

/**
 * Whether a token issued at `issuedAtSeconds` is still acceptable for this user.
 * A disabled account, a deleted account, or a credential change since the token
 * was minted all invalidate it immediately.
 */
interface CachedStanding {
  status: AppUserStatus;
  tokensValidFrom: number;
}

/**
 * Last known account standing, kept so a control.db outage cannot lock out the
 * fleet. Revocations that already happened stay enforced from cache; only a
 * revocation issued *during* the outage is missed.
 */
const standingCache = new Map<string, CachedStanding>();

export function tokenStillValid(
  username: string,
  issuedAtSeconds: number | undefined,
): { valid: boolean; reason?: 'DISABLED' | 'REVOKED' } {
  let standing: CachedStanding | undefined;

  try {
    const user = getUser(username);
    if (!user) {
      // No account record: a legacy master-password session. Nothing to revoke.
      standingCache.delete(username);
      return { valid: true };
    }
    standing = { status: user.status, tokensValidFrom: user.tokens_valid_from };
    standingCache.set(username, standing);
  } catch (error) {
    // The account store is unreachable. Refusing every request would take the
    // whole scanning fleet down over an auxiliary database — a worse outcome
    // than briefly missing a revocation, given the token itself is still a
    // validly signed one this server issued.
    standing = standingCache.get(username);
    logger.error(
      `Account store unreachable while checking "${username}"; ` +
        (standing ? 'using last known standing.' : 'allowing the signed token.'),
      error,
    );
    if (!standing) return { valid: true };
  }

  if (standing.status !== 'ACTIVE') return { valid: false, reason: 'DISABLED' };

  if (issuedAtSeconds === undefined) return { valid: true };
  // jwt `iat` is seconds; tokens_valid_from is ms. Compare on the coarser unit
  // and allow the boundary second, so a token minted in the same second as the
  // change is not spuriously rejected.
  const validFromSeconds = Math.floor(standing.tokensValidFrom / 1000);
  if (issuedAtSeconds < validFromSeconds) return { valid: false, reason: 'REVOKED' };

  return { valid: true };
}

/** Test hook: drops cached standings so a fresh read is forced. */
export function clearStandingCache(): void {
  standingCache.clear();
}

export function takePendingUserRequests(limit = 20): AppUserRequestRow[] {
  return takeRequestsStmt.all(limit) as AppUserRequestRow[];
}

export function resolveUserRequest(
  id: number,
  status: 'APPLIED' | 'REJECTED',
  detail: string,
): void {
  resolveRequestStmt.run({ id, status, detail, now: Date.now() });
}

/** Used by tests and any server-side provisioning path. */
export function submitUserRequest(input: {
  action: AppUserAction;
  username: string;
  password?: string | null;
  displayName?: string | null;
  submittedBy: string;
}): number {
  const result = submitRequestStmt.run({
    action: input.action,
    username: input.username,
    password: input.password ?? null,
    display_name: input.displayName ?? null,
    submitted_by: input.submittedBy,
    now: Date.now(),
  });
  return Number(result.lastInsertRowid);
}
