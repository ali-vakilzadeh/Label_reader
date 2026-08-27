import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { uploadImages } from '../middleware/upload';
import { ApiError } from '../middleware/errorHandler';
import {
  processExtraction,
  queueSnapshot,
  responseForScan,
  type ExtractRequest,
} from '../services/visionService';
import type { VisionResultsBatchResponse } from '../types';
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

    // api_contract.md v1.1 §4.2: every accepted scan answers 202, whether it is
    // queued, cloned, or a replay. Clients branch on processing_status, never on
    // the status code.
    res.status(202).json(processExtraction(request));
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

    res.json(responseForScan(scan));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/vision/results?ids=a,b,c
 *
 * Batch form of the single-result endpoint (api_contract.md v1.1 §4.4). A device
 * draining a backlog after an outage may be waiting on dozens of scans; polling
 * them one at a time would be one request each.
 *
 * Unknown ids are reported in `not_found` rather than failing the batch, so one
 * stale id cannot block the rest.
 */
visionRouter.get('/results', requireAuth, (req, res, next) => {
  try {
    const raw = readString(req.query.ids);
    if (!raw) {
      throw new ApiError(
        400,
        'MISSING_IDS',
        'Provide one or more apparel ids, e.g. ?ids=890123456789,890123456790',
      );
    }

    const ids = [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) {
      throw new ApiError(400, 'MISSING_IDS', 'No usable apparel ids were supplied.');
    }
    if (ids.length > env.resultsBatchLimit) {
      throw new ApiError(
        400,
        'TOO_MANY_IDS',
        `At most ${env.resultsBatchLimit} ids may be requested at once.`,
      );
    }

    const results = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const scan = getScan(id);
      if (scan) results.push(responseForScan(scan));
      else notFound.push(id);
    }

    const snapshot = queueSnapshot();
    res.json({
      status: 'success',
      results,
      not_found: notFound,
      queue_depth: snapshot.depth,
      retry_after_seconds: snapshot.retryAfterSeconds,
    } satisfies VisionResultsBatchResponse);
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
