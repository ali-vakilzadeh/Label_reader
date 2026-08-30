import crypto from 'node:crypto';
import { openDashboardDb } from '../db';
import { config } from '../config/env';
import { audit } from './audit';

/**
 * Dashboard logins (plan §12).
 *
 * These are NOT the Android operator accounts. Those live in the middleware and are only
 * ever *requested* through `app_user_requests`. Keeping the two stores separate is what
 * stops a dashboard bug from signing the warehouse fleet out.
 *
 * scrypt with a per-user salt, matching the middleware's scheme.
 */

export type Role = 'admin' | 'viewer';

export interface DashUser {
  id: number;
  username: string;
  display_name: string | null;
  role: Role;
  status: 'ACTIVE' | 'DISABLED';
  locale: 'en' | 'hy';
  columns_json: string | null;
  must_change_password: number;
  created_at: number;
  last_login_at: number | null;
}

const SCRYPT_KEYLEN = 64;

function hash(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (password !== password.trim()) return 'Password must not start or end with a space.';
  return null;
}

export function validateUsername(username: string): string | null {
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    return 'Username must be 3-64 characters, letters/digits/dot/underscore/hyphen only.';
  }
  return null;
}

/**
 * Zero-point account. `admin`/`admin` exists so the first person can get in; the forced
 * password change is the half that makes it acceptable.
 */
export function ensureSeedAdmin(): void {
  const db = openDashboardDb();
  const count = (db.prepare('SELECT COUNT(*) AS n FROM dash_users').get() as { n: number }).n;
  if (count > 0) return;
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare(
    `INSERT INTO dash_users (username, display_name, password_hash, salt, role, status, locale,
                             must_change_password, created_at)
     VALUES ('admin', 'Administrator', ?, ?, 'admin', 'ACTIVE', ?, 1, ?)`,
  ).run(hash('admin', salt), salt, config.defaultLocale, Date.now());
  console.warn('[auth] seeded admin/admin — the password must be changed at first login.');
}

export function findUser(username: string): (DashUser & { password_hash: string; salt: string }) | undefined {
  return openDashboardDb()
    .prepare('SELECT * FROM dash_users WHERE username = ?')
    .get(username) as never;
}

export function getUser(id: number): DashUser | undefined {
  return openDashboardDb().prepare('SELECT * FROM dash_users WHERE id = ?').get(id) as never;
}

export function listUsers(): DashUser[] {
  return openDashboardDb().prepare('SELECT * FROM dash_users ORDER BY username').all() as never;
}

export function activeUserCount(): number {
  return (
    openDashboardDb().prepare("SELECT COUNT(*) AS n FROM dash_users WHERE status = 'ACTIVE'").get() as {
      n: number;
    }
  ).n;
}

export function verifyLogin(username: string, password: string): DashUser | null {
  const user = findUser(username);
  if (!user || user.status !== 'ACTIVE') return null;
  if (!safeEqual(hash(password, user.salt), user.password_hash)) return null;
  openDashboardDb().prepare('UPDATE dash_users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
  return user;
}

export function createUser(
  actor: string,
  username: string,
  password: string,
  displayName: string | null,
  role: Role,
): string | null {
  const uErr = validateUsername(username);
  if (uErr) return uErr;
  const pErr = validatePassword(password);
  if (pErr) return pErr;
  if (activeUserCount() >= config.maxDashUsers) {
    return `The dashboard is limited to ${config.maxDashUsers} active users. Disable one first.`;
  }
  if (findUser(username)) return `A user named "${username}" already exists.`;

  const salt = crypto.randomBytes(16).toString('hex');
  openDashboardDb()
    .prepare(
      `INSERT INTO dash_users (username, display_name, password_hash, salt, role, status, locale,
                               must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, 0, ?)`,
    )
    .run(username, displayName, hash(password, salt), salt, role, config.defaultLocale, Date.now());
  audit(actor, 'USER_CREATE', 'dash_user', username, null, { role });
  return null;
}

export function setPassword(actor: string, userId: number, password: string): string | null {
  const err = validatePassword(password);
  if (err) return err;
  const salt = crypto.randomBytes(16).toString('hex');
  openDashboardDb()
    .prepare('UPDATE dash_users SET password_hash = ?, salt = ?, must_change_password = 0 WHERE id = ?')
    .run(hash(password, salt), salt, userId);
  // Any other session for this user is invalidated; a password change means sign out.
  openDashboardDb().prepare('DELETE FROM dash_sessions WHERE user_id = ?').run(userId);
  audit(actor, 'USER_SET_PASSWORD', 'dash_user', String(userId));
  return null;
}

export function setStatus(actor: string, userId: number, status: 'ACTIVE' | 'DISABLED'): string | null {
  const db = openDashboardDb();
  const user = getUser(userId);
  if (!user) return 'No such user.';
  if (status === 'DISABLED' && user.role === 'admin') {
    const admins = (
      db.prepare("SELECT COUNT(*) AS n FROM dash_users WHERE role = 'admin' AND status = 'ACTIVE'").get() as {
        n: number;
      }
    ).n;
    if (admins <= 1) return 'Refusing to disable the last active administrator.';
  }
  db.prepare('UPDATE dash_users SET status = ? WHERE id = ?').run(status, userId);
  if (status === 'DISABLED') db.prepare('DELETE FROM dash_sessions WHERE user_id = ?').run(userId);
  audit(actor, `USER_${status}`, 'dash_user', String(userId));
  return null;
}

export function setLocale(userId: number, locale: 'en' | 'hy'): void {
  openDashboardDb().prepare('UPDATE dash_users SET locale = ? WHERE id = ?').run(locale, userId);
}

/* ------------------------------ sessions ------------------------------ */

export interface Session {
  token: string;
  user_id: number;
  csrf: string;
  expires_at: number;
}

export function createSession(userId: number): Session {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const session: Session = { token, user_id: userId, csrf, expires_at: now + config.sessionTtlMs };
  openDashboardDb()
    .prepare('INSERT INTO dash_sessions (token, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, userId, csrf, now, session.expires_at);
  return session;
}

export function readSession(token: string | undefined): Session | null {
  if (!token) return null;
  const row = openDashboardDb().prepare('SELECT * FROM dash_sessions WHERE token = ?').get(token) as
    | Session
    | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(token);
    return null;
  }
  return row;
}

export function destroySession(token: string): void {
  openDashboardDb().prepare('DELETE FROM dash_sessions WHERE token = ?').run(token);
}

export function purgeExpiredSessions(): void {
  openDashboardDb().prepare('DELETE FROM dash_sessions WHERE expires_at < ?').run(Date.now());
}
