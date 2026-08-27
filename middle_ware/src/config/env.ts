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
  geminiVisionModel: optional('GEMINI_VISION_MODEL', 'gemini-3.7-flash'),
  geminiImageModel: optional('GEMINI_IMAGE_MODEL', 'gemini-3.1-flash-image'),
  /** Total attempts against the primary model before falling back. */
  geminiMaxAttempts: numeric('GEMINI_MAX_ATTEMPTS', 3),
  /** Optional second model tried once after the primary exhausts its retries. */
  geminiFallbackModel: optional('GEMINI_FALLBACK_MODEL', ''),

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
  // --- Client polling hints ---------------------------------------------
  /** Per-scan cost used to estimate queue wait for the operator. */
  visionSecondsPerItem: numeric('VISION_SECONDS_PER_ITEM', 5),
  /** Floor and ceiling for the retry_after_seconds hint sent to devices. */
  pollRetryMinSeconds: numeric('POLL_RETRY_MIN_SECONDS', 5),
  pollRetryMaxSeconds: numeric('POLL_RETRY_MAX_SECONDS', 120),
  /** Maximum ids accepted by GET /vision/results. */
  resultsBatchLimit: numeric('RESULTS_BATCH_LIMIT', 100),

  /** A failed render is retried on later nights until this many attempts. */
  renderMaxAttempts: numeric('RENDER_MAX_ATTEMPTS', 3),

  // --- Control channel (shared with the Web UI via control.db) ----------
  /** How often the middleware stamps its heartbeat and recomputes counters. */
  controlHeartbeatMs: numeric('CONTROL_HEARTBEAT_MS', 30_000),
  /** How often UI commands are polled. */
  controlPollMs: numeric('CONTROL_POLL_MS', 15_000),
  /** How often the extraction backlog is swept. */
  queueDrainMs: numeric('QUEUE_DRAIN_MS', 60_000),
  /** Scans processed per drain sweep. */
  queueDrainBatch: numeric('QUEUE_DRAIN_BATCH', 25),
  /** Pending scans above this raise QUEUE_BACKLOG for the UI. */
  queueBacklogWarning: numeric('QUEUE_BACKLOG_WARNING', 25),
} as const;

export const isProduction = env.nodeEnv === 'production';
