import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { uploadImages } from '../middleware/upload';
import { ApiError } from '../middleware/errorHandler';
import { processExtraction, type ExtractRequest } from '../services/visionService';
import { getScan } from '../db/operationalDb';
import { env } from '../config/env';

export const visionRouter: Router = Router();

/**
 * POST /api/v1/vision/extract
 *
 * multipart/form-data. Two paths:
 *   - cloned_from present -> parent record is rebound, Gemini is never called
 *   - otherwise           -> up to 8 images go to Gemini for extraction
 * Either way the deterministic catalog_image_url is returned immediately.
 */
visionRouter.post('/extract', requireAuth, uploadImages, async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;

    const apparelId = readString(body.apparel_id);
    if (!apparelId) {
      throw new ApiError(400, 'MISSING_APPAREL_ID', 'apparel_id is required.');
    }

    const username = readString(body.username) ?? req.auth?.username ?? null;
    if (!username) {
      throw new ApiError(400, 'MISSING_USERNAME', 'username is required.');
    }

    const clonedFrom = readString(body.cloned_from);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];

    if (!clonedFrom && files.length === 0) {
      throw new ApiError(
        400,
        'INVALID_IMAGE_PAYLOAD',
        'Failed to extract values from labels. At least one readable image is required.',
      );
    }

    const keyPhotoIndex = parseKeyPhotoIndex(body.key_photo_index, files.length);

    const request: ExtractRequest = {
      apparelId,
      username,
      keyPhotoIndex,
      clonedFrom,
      files,
    };

    res.json(await processExtraction(request));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/vision/result/:apparel_id
 *
 * Recovery path for a device that lost the extract response. Results are never
 * purged on delivery, so this can be called at any later time — and it needs no
 * photo upload, so recovering costs nothing.
 *
 * `extraction_status` tells the client what to do:
 *   COMPLETED -> `data` is final
 *   PENDING   -> still queued; poll again later
 *   PARKED    -> needs human review; do not keep polling
 */
visionRouter.get('/result/:apparel_id', requireAuth, (req, res, next) => {
  try {
    const apparelId = readString(req.params.apparel_id);
    if (!apparelId) {
      throw new ApiError(400, 'MISSING_APPAREL_ID', 'apparel_id is required.');
    }

    const scan = getScan(apparelId);
    if (!scan) {
      throw new ApiError(
        404,
        'SCAN_NOT_FOUND',
        `No scan stored for apparel_id "${apparelId}".`,
      );
    }

    res.json({
      status: 'success',
      apparel_id: scan.apparel_id,
      cloned_from: scan.cloned_from,
      timestamp: scan.timestamp,
      catalog_image_url: scan.catalog_image_url,
      extraction_status: scan.extraction_status,
      extraction_fault_code: scan.extraction_fault_code,
      data: JSON.parse(scan.raw_json_data) as unknown,
    });
  } catch (error) {
    next(error);
  }
});

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return null;
  return trimmed;
}

/**
 * key_photo_index is required by contract but must not fail a scan when a device
 * sends something odd — an out-of-range index falls back to the first photo.
 */
function parseKeyPhotoIndex(value: unknown, fileCount: number): number {
  const parsed = Number(readString(value) ?? Number.NaN);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= env.maxImages) return 0;
  if (fileCount > 0 && parsed >= fileCount) return 0;
  return parsed;
}
