import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config/env';
import { DASHBOARD_SCHEMA, ensureColumns } from './schema';

/**
 * Every database handle in the application is opened here and nowhere else.
 *
 * The client intends to merge the dashboard into the middleware process later
 * (Dashboard_plan_final.md §14.2). When that happens, this file is the seam: swap the
 * three middleware handles for the middleware's own accessors and nothing else moves.
 */

export type Db = Database.Database;

/** UI_messaging_protocol.md §1 — mandatory on every connection, without exception. */
function applyPragmas(db: Db): void {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
}

/**
 * Middleware databases are read-only *by discipline*, but must be opened read-write at
 * the OS level: SQLite writes the -shm sibling even when only reading, so a genuinely
 * read-only handle cannot read a WAL database at all. See plan §1 override 11.
 */
function openMiddlewareDb(file: string): Db | null {
  const full = path.join(config.middlewareDataDir, file);
  if (!fs.existsSync(full)) return null;
  try {
    const db = new Database(full);
    applyPragmas(db);
    return db;
  } catch (err) {
    console.warn(`[db] could not open ${full}: ${(err as Error).message}`);
    return null;
  }
}

let dashboardDb: Db | null = null;
let controlDb: Db | null = null;
let scansDb: Db | null = null;
let flywheelDb: Db | null = null;

export function openDashboardDb(): Db {
  if (dashboardDb) return dashboardDb;
  fs.mkdirSync(config.dashboardDataDir, { recursive: true });
  const db = new Database(path.join(config.dashboardDataDir, 'dashboard.db'));
  applyPragmas(db);
  db.pragma('foreign_keys = ON');
  db.exec(DASHBOARD_SCHEMA);
  ensureColumns(db);
  dashboardDb = db;
  return db;
}

/**
 * The three middleware handles are lazy and re-tried, because the middleware may not be
 * running when the dashboard boots — and the dashboard must work anyway (plan §3.1).
 * A null return is a normal, expected state, never an error to throw on.
 */
export function getControlDb(): Db | null {
  if (!controlDb) controlDb = openMiddlewareDb('control.db');
  return controlDb;
}

export function getScansDb(): Db | null {
  if (!scansDb) scansDb = openMiddlewareDb('server_scans.db');
  return scansDb;
}

export function getFlywheelDb(): Db | null {
  if (!flywheelDb) flywheelDb = openMiddlewareDb('flywheel.db');
  return flywheelDb;
}

/** Drop cached handles so the next call re-opens. Used after a middleware restart. */
export function resetMiddlewareHandles(): void {
  for (const db of [controlDb, scansDb, flywheelDb]) {
    try {
      db?.close();
    } catch {
      /* already gone */
    }
  }
  controlDb = scansDb = flywheelDb = null;
}

export function closeAll(): void {
  resetMiddlewareHandles();
  try {
    dashboardDb?.close();
  } catch {
    /* ignore */
  }
  dashboardDb = null;
}
