import crypto from 'node:crypto';
import { controlDb } from './controlDb';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Operator-managed vision credentials.
 *
 * The Web UI must be able to change the API key without shell access and
 * without write access to .env — .env also holds JWT_SECRET and the master
 * device password, so handing the UI a pen over that file would widen the blast
 * radius of a UI compromise to the entire auth system.
 *
 * Instead the UI submits a candidate into `vision_settings_pending`. The
 * middleware then:
 *
 *   1. probes the candidate against the live API BEFORE adopting it,
 *   2. on success, encrypts it into `vision_settings` and erases the plaintext,
 *   3. on failure, keeps the previous key and reports why.
 *
 * Validating before adopting is the important part: without it, a typo takes
 * extraction down and the operator gets no feedback until the next scan fails.
 *
 * At rest the key is AES-256-GCM encrypted under a key derived from JWT_SECRET,
 * which the UI does not have. A reader of control.db therefore cannot lift the
 * credential; the plaintext exists only between submission and validation.
 */

controlDb.exec(`
  CREATE TABLE IF NOT EXISTS vision_settings (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    api_key_ciphertext  TEXT,
    api_key_iv          TEXT,
    api_key_tag         TEXT,
    -- Last four characters only, so the UI can show which key is loaded.
    api_key_fingerprint TEXT,
    vision_model        TEXT,
    image_model         TEXT,
    validation_status   TEXT NOT NULL DEFAULT 'UNSET',  -- UNSET|VALID|INVALID
    validation_detail   TEXT,
    validated_at        INTEGER,
    updated_at          INTEGER,
    updated_by          TEXT
  );

  INSERT OR IGNORE INTO vision_settings (id, validation_status) VALUES (1, 'UNSET');

  -- UI -> middleware handoff. Plaintext lives here only until validation.
  CREATE TABLE IF NOT EXISTS vision_settings_pending (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key       TEXT,
    vision_model  TEXT,
    image_model   TEXT,
    submitted_at  INTEGER NOT NULL,
    submitted_by  TEXT,
    status        TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|VALIDATING|APPLIED|REJECTED
    result_detail TEXT,
    resolved_at   INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_vision_pending ON vision_settings_pending (status, id);
`);

const ALGORITHM = 'aes-256-gcm';

/** Derived from JWT_SECRET so no additional secret has to be provisioned. */
function encryptionKey(): Buffer {
  return crypto.scryptSync(env.jwtSecret, 'vision-settings-v1', 32);
}

function encrypt(plaintext: string): { ciphertext: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt(ciphertext: string, iv: string, tag: string): string | null {
  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    // Usually means JWT_SECRET changed — the stored key is unrecoverable.
    logger.error('Stored vision key could not be decrypted (JWT_SECRET changed?).', error);
    return null;
  }
}

export interface VisionSettingsRow {
  id: number;
  api_key_ciphertext: string | null;
  api_key_iv: string | null;
  api_key_tag: string | null;
  api_key_fingerprint: string | null;
  vision_model: string | null;
  image_model: string | null;
  validation_status: 'UNSET' | 'VALID' | 'INVALID';
  validation_detail: string | null;
  validated_at: number | null;
  updated_at: number | null;
  updated_by: string | null;
}

export interface PendingSettingsRow {
  id: number;
  api_key: string | null;
  vision_model: string | null;
  image_model: string | null;
  submitted_at: number;
  submitted_by: string | null;
  status: 'PENDING' | 'VALIDATING' | 'APPLIED' | 'REJECTED';
  result_detail: string | null;
  resolved_at: number | null;
}

const readSettingsStmt = controlDb.prepare('SELECT * FROM vision_settings WHERE id = 1');
const takePendingStmt = controlDb.prepare(
  "SELECT * FROM vision_settings_pending WHERE status = 'PENDING' ORDER BY id ASC LIMIT ?",
);
const markPendingStmt = controlDb.prepare(`
  UPDATE vision_settings_pending
  SET status = @status, result_detail = @result_detail,
      resolved_at = CASE WHEN @status IN ('APPLIED','REJECTED') THEN @now ELSE resolved_at END,
      -- Plaintext is erased the moment it is no longer needed.
      api_key = CASE WHEN @status IN ('APPLIED','REJECTED') THEN NULL ELSE api_key END
  WHERE id = @id
`);
const applyStmt = controlDb.prepare(`
  UPDATE vision_settings
  SET api_key_ciphertext  = @ciphertext,
      api_key_iv          = @iv,
      api_key_tag         = @tag,
      api_key_fingerprint = @fingerprint,
      vision_model        = @vision_model,
      image_model         = @image_model,
      validation_status   = 'VALID',
      validation_detail   = NULL,
      validated_at        = @now,
      updated_at          = @now,
      updated_by          = @updated_by
  WHERE id = 1
`);
const markInvalidStmt = controlDb.prepare(`
  UPDATE vision_settings
  SET validation_status = 'INVALID', validation_detail = @detail, validated_at = @now
  WHERE id = 1
`);
const insertPendingStmt = controlDb.prepare(`
  INSERT INTO vision_settings_pending (api_key, vision_model, image_model, submitted_at, submitted_by, status)
  VALUES (@api_key, @vision_model, @image_model, @now, @submitted_by, 'PENDING')
`);

export function readVisionSettings(): VisionSettingsRow {
  return readSettingsStmt.get() as VisionSettingsRow;
}

/** The stored key in plaintext, or null when none has been validated. */
export function storedApiKey(): string | null {
  const row = readVisionSettings();
  if (
    row.validation_status !== 'VALID' ||
    !row.api_key_ciphertext ||
    !row.api_key_iv ||
    !row.api_key_tag
  ) {
    return null;
  }
  return decrypt(row.api_key_ciphertext, row.api_key_iv, row.api_key_tag);
}

export function storedVisionModel(): string | null {
  return readVisionSettings().vision_model;
}

export function storedImageModel(): string | null {
  return readVisionSettings().image_model;
}

export function takePendingSettings(limit = 5): PendingSettingsRow[] {
  return takePendingStmt.all(limit) as PendingSettingsRow[];
}

export function markPending(
  id: number,
  status: PendingSettingsRow['status'],
  resultDetail: string | null,
): void {
  markPendingStmt.run({ id, status, result_detail: resultDetail, now: Date.now() });
}

export function fingerprintOf(apiKey: string): string {
  return apiKey.length <= 4 ? '****' : `****${apiKey.slice(-4)}`;
}

/** Commits a candidate that has already passed a live probe. */
export function applyVisionSettings(
  apiKey: string,
  visionModel: string | null,
  imageModel: string | null,
  updatedBy: string | null,
): void {
  const { ciphertext, iv, tag } = encrypt(apiKey);
  applyStmt.run({
    ciphertext,
    iv,
    tag,
    fingerprint: fingerprintOf(apiKey),
    vision_model: visionModel,
    image_model: imageModel,
    updated_by: updatedBy,
    now: Date.now(),
  });
  logger.info(
    `Vision credentials updated by ${updatedBy ?? 'unknown'} (key ${fingerprintOf(apiKey)}).`,
  );
}

export function markSettingsInvalid(detail: string): void {
  markInvalidStmt.run({ detail, now: Date.now() });
}

/** Used by tests and by any server-side provisioning path. */
export function submitPendingSettings(
  apiKey: string | null,
  visionModel: string | null,
  imageModel: string | null,
  submittedBy: string,
): number {
  const result = insertPendingStmt.run({
    api_key: apiKey,
    vision_model: visionModel,
    image_model: imageModel,
    submitted_by: submittedBy,
    now: Date.now(),
  });
  return Number(result.lastInsertRowid);
}
