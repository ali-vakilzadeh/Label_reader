import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Package root, resolved by walking up from this module until package.json is
 * found. Works identically for `tsx src/...` and compiled `dist/src/...`.
 */
function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const ROOT_DIR = findPackageRoot(__dirname);

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

function numeric(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be numeric, received "${raw}".`);
  }
  return parsed;
}

function resolveDir(relativeOrAbsolute: string): string {
  const resolved = path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.join(ROOT_DIR, relativeOrAbsolute);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: numeric('PORT', 3000),

  /** Public hostname used to pre-generate deterministic catalog URLs. */
  serverHost: optional('SERVER_HOST', 'localhost:3000'),
  publicProtocol: optional('PUBLIC_PROTOCOL', 'https'),

  // --- Auth -------------------------------------------------------------
  jwtSecret: required('JWT_SECRET'),
  masterPassword: required('APP_MASTER_PASSWORD'),
  jwtExpiresIn: optional('JWT_EXPIRES_IN', '30d'),

  // --- Gemini -----------------------------------------------------------
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiVisionModel: optional('GEMINI_VISION_MODEL', 'gemini-2.5-flash'),
  geminiImageModel: optional('GEMINI_IMAGE_MODEL', 'gemini-2.5-flash-image'),

  // --- Storage ----------------------------------------------------------
  dataDir: resolveDir(optional('DATA_DIR', 'data')),
  uploadsDir: resolveDir(optional('UPLOADS_DIR', 'uploads')),
  catalogDir: resolveDir(optional('CATALOG_DIR', 'public/catalog')),

  // --- Flywheel ---------------------------------------------------------
  /** Any field scoring below this routes the scan into the hidden training DB. */
  flywheelConfidenceThreshold: numeric('FLYWHEEL_CONFIDENCE_THRESHOLD', 0.85),
  /** Hard FIFO ring-buffer ceiling for flywheel.db. */
  flywheelMaxRecords: numeric('FLYWHEEL_MAX_RECORDS', 10_000),
  /** Shared secret guarding the hidden flywheel confirm endpoint. */
  flywheelAdminKey: optional('FLYWHEEL_ADMIN_KEY', ''),

  // --- Uploads / limits -------------------------------------------------
  maxImages: numeric('MAX_IMAGES', 8),
  maxImageBytes: numeric('MAX_IMAGE_BYTES', 12 * 1024 * 1024),
  rateLimitWindowMs: numeric('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMax: numeric('RATE_LIMIT_MAX', 60),
  corsOrigin: optional('CORS_ORIGIN', '*'),

  // --- Cron -------------------------------------------------------------
  /** Default: 20:00 daily. */
  renderCronSchedule: optional('RENDER_CRON_SCHEDULE', '0 20 * * *'),
  renderCronTimezone: optional('RENDER_CRON_TIMEZONE', 'Asia/Yerevan'),
  renderCronEnabled: optional('RENDER_CRON_ENABLED', 'true') === 'true',
  renderBatchSize: numeric('RENDER_BATCH_SIZE', 200),
} as const;

export const isProduction = env.nodeEnv === 'production';
