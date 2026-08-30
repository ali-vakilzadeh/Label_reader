import fs from 'node:fs';
import path from 'node:path';

/**
 * Configuration, read once at boot. No dotenv dependency: a five-line parser is
 * easier to hand over than another package, and .env here holds one secret.
 */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue; // real env always wins
    process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
}

/**
 * The package root — the directory holding package.json. Views and static assets are
 * resolved from here rather than from __dirname, because __dirname points into src/ under
 * `tsx` and into dist/src/ after `npm run build`, and the templates live in neither of
 * those two places at once.
 */
function findAppRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const appRoot = findAppRoot(__dirname);

loadDotEnv(path.resolve(appRoot, '.env'));

const str = (k: string, d: string): string => process.env[k]?.trim() || d;
const num = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};
const bool = (k: string, d: boolean): boolean => {
  const v = process.env[k]?.trim().toLowerCase();
  if (v === undefined || v === '') return d;
  return v === '1' || v === 'true' || v === 'yes';
};

export const config = {
  appRoot,
  viewsDir: path.join(appRoot, 'src', 'views'),
  publicDir: path.join(appRoot, 'src', 'public'),

  port: num('DASHBOARD_PORT', 3100),
  trustProxy: num('TRUST_PROXY', 1),

  middlewareDataDir: path.resolve(str('MIDDLEWARE_DATA_DIR', '../middle_ware/data')),
  referenceDataDir: path.resolve(str('REFERENCE_DATA_DIR', '../middle_ware/reference_data')),
  localReferenceDir: path.resolve(str('LOCAL_REFERENCE_DIR', './reference_data')),
  dashboardDataDir: path.resolve(str('DASHBOARD_DATA_DIR', './data')),

  sessionSecret: str('SESSION_SECRET', 'change-me-before-deploying'),
  sessionTtlMs: num('SESSION_TTL_HOURS', 12) * 3600_000,
  allowInsecureCookies: bool('ALLOW_INSECURE_COOKIES', true),

  defaultLocale: (str('DEFAULT_LOCALE', 'en') === 'hy' ? 'hy' : 'en') as 'en' | 'hy',
  pageSize: num('PAGE_SIZE', 50),
  fuzzyMinSimilarity: num('FUZZY_MIN_SIMILARITY', 0.85),
  dupWindowHours: num('DUP_WINDOW_HOURS', 24),
  lowConfidenceThreshold: num('LOW_CONFIDENCE_THRESHOLD', 0.7),
  maxDashUsers: num('MAX_DASH_USERS', 10),
  defaultCurrency: str('DEFAULT_CURRENCY', 'EUR'),

  /** UI_messaging_protocol.md §3: > 3 heartbeat intervals means the middleware is dead. */
  heartbeatDeadMs: 90_000,
} as const;

export type Config = typeof config;
