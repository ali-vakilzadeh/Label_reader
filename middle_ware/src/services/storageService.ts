import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Deterministic catalog URL, generated synchronously during /vision/extract.
 * The nightly render job later writes the actual file at this exact path, so
 * mobile clients and CSV exports can hold a permanent URL immediately.
 */
export function buildCatalogUrl(apparelId: string): string {
  return `${env.publicProtocol}://${env.serverHost}/catalog/${catalogFileName(apparelId)}`;
}

export function catalogFileName(apparelId: string): string {
  return `IMG_${sanitizeId(apparelId)}.jpg`;
}

export function catalogFilePath(apparelId: string): string {
  return path.join(env.catalogDir, catalogFileName(apparelId));
}

/** Barcodes are client-supplied: keep them safe for use inside a file path. */
export function sanitizeId(apparelId: string): string {
  return apparelId.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Content fingerprint of an upload set. Order-independent per file position but
 * stable for the same bytes, so a device re-sending the identical scan is
 * recognised as a replay rather than a new job.
 */
export function digestImages(files: { buffer: Buffer }[]): string {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(crypto.createHash('sha256').update(file.buffer).digest());
  }
  return hash.digest('hex');
}

export interface StoredImage {
  path: string;
  mimeType: string;
  originalName: string;
}

/**
 * Persists uploaded images under uploads/<apparel_id>/. Called for every scan so
 * the nightly render job has the key photo, and so a scan later intercepted by
 * the flywheel still has its full image set on disk.
 */
export function persistImages(
  apparelId: string,
  files: Express.Multer.File[],
): StoredImage[] {
  const safeId = sanitizeId(apparelId);
  const targetDir = path.join(env.uploadsDir, safeId);
  fs.mkdirSync(targetDir, { recursive: true });

  return files.map((file, index) => {
    const extension = extensionFor(file.mimetype);
    const filePath = path.join(targetDir, `IMG_${safeId}_${index}${extension}`);
    fs.writeFileSync(filePath, file.buffer);
    return { path: filePath, mimeType: file.mimetype, originalName: file.originalname };
  });
}

function extensionFor(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    default:
      return '.jpg';
  }
}

export function readImageAsInline(
  filePath: string,
): { mimeType: string; data: string } | null {
  try {
    const buffer = fs.readFileSync(filePath);
    return { mimeType: mimeTypeFor(filePath), data: buffer.toString('base64') };
  } catch (error) {
    logger.warn(`Unable to read image at ${filePath}`, error);
    return null;
  }
}

export function mimeTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return 'image/jpeg';
}

export function writeCatalogImage(apparelId: string, buffer: Buffer): string {
  const destination = catalogFilePath(apparelId);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer);
  return destination;
}
