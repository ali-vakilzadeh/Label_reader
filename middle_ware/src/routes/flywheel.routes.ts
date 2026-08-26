import { Router } from 'express';
import { requireAuth, requireFlywheelAccess } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import { updateExtraction } from '../db/operationalDb';
import {
  confirmGroundTruth,
  findSample,
  flywheelStats,
} from '../services/flywheelService';
import { EXTRACTED_FIELDS, type ExtractedData } from '../types';
import { logger } from '../utils/logger';

/**
 * Hidden internal routes.
 *
 * Not part of the public API contract and not surfaced to dashboards. Guarded by
 * a device JWT plus the optional FLYWHEEL_ADMIN_KEY header; when that key is set
 * and missing, these routes answer 404 rather than 401 so their existence is not
 * advertised.
 */
export const flywheelRouter: Router = Router();

flywheelRouter.use(requireAuth, requireFlywheelAccess);

/**
 * PUT /api/v1/flywheel/confirm/:apparel_id
 * Binds operator-verified ground truth to a stored low-confidence sample, and
 * mirrors the correction into the operational record so both stay in step.
 */
flywheelRouter.put('/confirm/:apparel_id', (req, res, next) => {
  try {
    const apparelId = req.params.apparel_id;
    if (!apparelId) {
      throw new ApiError(400, 'MISSING_APPAREL_ID', 'apparel_id is required.');
    }

    const payload = (req.body ?? {}) as { data?: unknown };
    const confirmed = normalizeConfirmed(payload.data ?? payload);

    const sample = findSample(apparelId);
    if (!sample) {
      throw new ApiError(
        404,
        'SAMPLE_NOT_FOUND',
        `No training sample stored for apparel_id "${apparelId}".`,
      );
    }

    const bound = confirmGroundTruth(apparelId, confirmed);
    if (!bound) {
      throw new ApiError(500, 'CONFIRM_FAILED', 'Failed to persist confirmed data.');
    }

    // Keep the operational ledger aligned with the human correction.
    updateExtraction(apparelId, JSON.stringify(confirmed));

    logger.info(`Ground truth bound for ${apparelId} by ${req.auth?.username ?? 'unknown'}`);
    res.json({ status: 'success', apparel_id: apparelId, confirmed_fields: Object.keys(confirmed).length });
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/flywheel/stats — buffer occupancy for internal monitoring. */
flywheelRouter.get('/stats', (_req, res) => {
  res.json({ status: 'success', ...flywheelStats() });
});

/** GET /api/v1/flywheel/sample/:apparel_id — inspect one stored sample. */
flywheelRouter.get('/sample/:apparel_id', (req, res, next) => {
  try {
    const apparelId = req.params.apparel_id;
    if (!apparelId) {
      throw new ApiError(400, 'MISSING_APPAREL_ID', 'apparel_id is required.');
    }
    const sample = findSample(apparelId);
    if (!sample) {
      throw new ApiError(404, 'SAMPLE_NOT_FOUND', 'No training sample stored.');
    }
    res.json({
      status: 'success',
      sample: {
        ...sample,
        raw_images_paths: safeParse(sample.raw_images_paths),
        unconfirmed_gemini_json: safeParse(sample.unconfirmed_gemini_json),
        confirmed_json: safeParse(sample.confirmed_json),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Accepts either the full {field: {value, confidence}} shape or a flat
 * {field: "value"} correction map, and returns the canonical shape. Confirmed
 * values are ground truth, so a bare string is recorded at confidence 1.0.
 */
function normalizeConfirmed(input: unknown): ExtractedData {
  if (!input || typeof input !== 'object') {
    throw new ApiError(400, 'INVALID_PAYLOAD', 'A confirmed data object is required.');
  }

  const source = input as Record<string, unknown>;
  const result = {} as ExtractedData;
  let provided = 0;

  for (const field of EXTRACTED_FIELDS) {
    const entry = source[field];
    if (entry === undefined || entry === null) {
      result[field] = { value: '', confidence: 0 };
      continue;
    }
    provided += 1;
    if (typeof entry === 'string') {
      result[field] = { value: entry.trim(), confidence: 1 };
      continue;
    }
    const shaped = entry as { value?: unknown; confidence?: unknown };
    result[field] = {
      value: typeof shaped.value === 'string' ? shaped.value.trim() : '',
      confidence: typeof shaped.confidence === 'number' ? shaped.confidence : 1,
    };
  }

  if (provided === 0) {
    throw new ApiError(
      400,
      'INVALID_PAYLOAD',
      'Payload contained none of the expected extraction fields.',
    );
  }

  return result;
}

function safeParse(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
