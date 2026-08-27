import { env } from '../config/env';
import {
  completeExtraction,
  failExtraction,
  getScan,
  upsertScan,
} from '../db/operationalDb';
import { extractApparelData, isGeminiReady } from './geminiService';
import { classifyGeminiError, type FaultDisposition } from './geminiErrors';
import { isVisionPaused, reportVisionFault, reportVisionSuccess } from './controlService';
import { interceptLowConfidence } from './flywheelService';
import {
  buildCatalogUrl,
  digestImages,
  persistImages,
  readImageAsInline,
} from './storageService';
import { FIELD_INDEXES } from '../utils/fuzzyMatcher';
import { clampConfidence, resolveWeights } from '../utils/weights';
import { logger } from '../utils/logger';
import { ApiError } from '../middleware/errorHandler';
import {
  EXTRACTED_FIELDS,
  type ConfidenceField,
  type ExtractedData,
  type ExtractedFieldName,
  type ExtractionStatus,
  type GeminiRawExtraction,
  type VisionExtractResponse,
} from '../types';

export interface ExtractRequest {
  apparelId: string;
  username: string;
  keyPhotoIndex: number;
  clonedFrom: string | null;
  files: Express.Multer.File[];
}

const EMPTY_FIELD: ConfidenceField = { value: '', confidence: 0 };

/**
 * Normalises one Gemini payload into the locked API shape:
 *   1. weights array -> netto/brutto per the min/max rule
 *   2. free text     -> canonical enum keys via local Fuse.js indexes
 *   3. confidences   -> clamped into [0,1]
 *
 * Fuzzy snapping never invents data: when nothing clears the similarity
 * threshold the original text is preserved and confidence is left untouched.
 */
export function normalizeExtraction(raw: GeminiRawExtraction): ExtractedData {
  const { netto, brutto } = resolveWeights(raw.weights);

  const data = {} as ExtractedData;

  for (const field of EXTRACTED_FIELDS) {
    if (field === 'netto') {
      data.netto = netto;
      continue;
    }
    if (field === 'brutto') {
      data.brutto = brutto;
      continue;
    }

    const source = (raw as unknown as Record<string, ConfidenceField | undefined>)[field];
    const value = typeof source?.value === 'string' ? source.value.trim() : '';
    const confidence = clampConfidence(source?.confidence);

    if (value === '') {
      data[field] = { ...EMPTY_FIELD };
      continue;
    }

    const index = FIELD_INDEXES[field];
    if (!index) {
      data[field] = { value, confidence };
      continue;
    }

    const snapped = index.matchOrKeep(value);
    if (!snapped.matched) {
      logger.debug(`No taxonomy match for ${field}="${value}"; keeping raw value.`);
    }
    data[field] = { value: snapped.value, confidence };
  }

  return data;
}

/** Fresh, all-empty payload used when a field set cannot be produced. */
export function emptyExtraction(): ExtractedData {
  const data = {} as ExtractedData;
  for (const field of EXTRACTED_FIELDS) data[field] = { ...EMPTY_FIELD };
  return data;
}

/**
 * Cloning path: skips Gemini entirely, reads the parent record from the local
 * operational DB, and rebinds it under the new apparel_id.
 */
export function cloneFromParent(request: ExtractRequest): VisionExtractResponse {
  const parentId = request.clonedFrom!;
  const parent = getScan(parentId);

  if (!parent) {
    throw new ApiError(
      404,
      'PARENT_NOT_FOUND',
      `No stored record found for parent apparel_id "${parentId}".`,
    );
  }

  let data: ExtractedData;
  try {
    data = JSON.parse(parent.raw_json_data) as ExtractedData;
  } catch {
    throw new ApiError(
      500,
      'PARENT_RECORD_CORRUPT',
      `Stored record for parent "${parentId}" could not be parsed.`,
    );
  }

  const timestamp = new Date().toISOString();
  const catalogUrl = buildCatalogUrl(request.apparelId);

  // The child inherits the parent's photos rather than duplicating bytes on disk.
  upsertScan({
    apparel_id: request.apparelId,
    cloned_from: parentId,
    username: request.username,
    timestamp,
    raw_json_data: JSON.stringify(data),
    key_photo_path: parent.key_photo_path,
    image_paths: parent.image_paths,
    catalog_image_url: catalogUrl,
    rendering_status: 'PENDING',
    // A clone inherits a finished extraction; nothing is owed to the queue.
    extraction_status: 'COMPLETED',
  });

  logger.info(`Cloned ${parentId} -> ${request.apparelId} (Gemini bypassed)`);

  return {
    status: 'success',
    apparel_id: request.apparelId,
    cloned_from: parentId,
    timestamp,
    catalog_image_url: catalogUrl,
    data,
  };
}

export type ExtractionOutcome =
  | { ok: true; data: ExtractedData; raw: GeminiRawExtraction }
  | { ok: false; disposition: FaultDisposition; fault: string };

/** Exponential backoff for a queued retry, capped so the queue keeps moving. */
export function backoffFor(attempts: number): number {
  const base = 30_000; // 30s
  return Math.min(base * 2 ** Math.min(attempts, 6), 30 * 60_000); // ≤ 30 min
}

/**
 * Performs one extraction attempt against an already-queued scan and records the
 * result durably. Shared by the live request path and the background drain, so
 * both apply identical classification, backoff and fault-reporting rules.
 *
 * Never throws: every failure is classified, persisted, and reported.
 */
export async function runExtraction(
  apparelId: string,
  imagePaths: string[],
  files?: Express.Multer.File[],
): Promise<ExtractionOutcome> {
  // Prefer the in-memory upload; fall back to the copies on disk when draining.
  const images = files?.length
    ? files.map((file) => ({
        mimeType: file.mimetype,
        data: file.buffer.toString('base64'),
      }))
    : imagePaths
        .map((imagePath) => readImageAsInline(imagePath))
        .filter((image): image is { mimeType: string; data: string } => image !== null);

  if (images.length === 0) {
    // Photos are gone from disk — this scan can never be extracted automatically.
    failExtraction(
      apparelId,
      'PARKED',
      'VISION_REQUEST_REJECTED',
      'No readable images remain on disk for this scan.',
      null,
    );
    reportVisionFault({
      fault: 'VISION_REQUEST_REJECTED',
      disposition: 'REJECT',
      httpStatus: null,
      apiStatus: null,
      retryAfterMs: null,
      quotaIds: [],
      detail: `Images missing on disk for ${apparelId}.`,
    });
    return { ok: false, disposition: 'REJECT', fault: 'VISION_REQUEST_REJECTED' };
  }

  try {
    const raw = await extractApparelData(images);
    const data = normalizeExtraction(raw);
    completeExtraction(apparelId, JSON.stringify(data));
    reportVisionSuccess();
    return { ok: true, data, raw };
  } catch (error) {
    const classification = classifyGeminiError(error);
    const current = getScan(apparelId);
    const attempts = (current?.extraction_attempts ?? 0) + 1;

    // REJECT parks this one scan; everything else stays queued for retry.
    const status: ExtractionStatus =
      classification.disposition === 'REJECT' ? 'PARKED' : 'PENDING';

    const nextAttemptAt =
      status === 'PARKED'
        ? null
        : Date.now() + (classification.retryAfterMs ?? backoffFor(attempts));

    failExtraction(
      apparelId,
      status,
      classification.fault,
      classification.detail,
      nextAttemptAt,
    );

    logger.warn(
      `Extraction attempt ${attempts} failed for ${apparelId}: ` +
        `${classification.fault} (${classification.disposition}) — ${classification.detail}`,
    );

    reportVisionFault(classification);
    return { ok: false, disposition: classification.disposition, fault: classification.fault };
  }
}

/** Full extraction path: Gemini vision + normalisation + flywheel screening. */
export async function extractFromImages(
  request: ExtractRequest,
): Promise<VisionExtractResponse> {
  if (request.files.length === 0) {
    throw new ApiError(
      400,
      'INVALID_IMAGE_PAYLOAD',
      'Failed to extract values from labels. At least one readable image is required.',
    );
  }

  // The catalog URL is deterministic and returned immediately; the actual studio
  // render is produced by the 20:00 cron job.
  const catalogUrl = buildCatalogUrl(request.apparelId);

  // ---- IDEMPOTENT REPLAY --------------------------------------------------
  // A device that never received our response retries the identical scan. That
  // must return the stored result, not re-bill the vision API and certainly not
  // overwrite a finished extraction with an empty one.
  const digest = digestImages(request.files);
  const existing = getScan(request.apparelId);

  if (
    existing &&
    existing.extraction_status === 'COMPLETED' &&
    existing.image_digest === digest
  ) {
    logger.info(`Replaying stored result for ${request.apparelId} (duplicate submission).`);
    return {
      status: 'success',
      apparel_id: existing.apparel_id,
      cloned_from: existing.cloned_from,
      timestamp: existing.timestamp,
      catalog_image_url: existing.catalog_image_url,
      data: JSON.parse(existing.raw_json_data) as ExtractedData,
    };
  }
  // -------------------------------------------------------------------------

  const timestamp = new Date().toISOString();

  const stored = persistImages(request.apparelId, request.files);
  const imagePaths = stored.map((image) => image.path);
  const keyIndex =
    request.keyPhotoIndex >= 0 && request.keyPhotoIndex < stored.length
      ? request.keyPhotoIndex
      : 0;
  const keyPhotoPath = stored[keyIndex]?.path ?? null;

  // ---- DURABILITY BOUNDARY ------------------------------------------------
  // The scan is recorded as owed BEFORE Gemini is contacted. Everything after
  // this point can fail, restart, or be paused for a week without the scan being
  // forgotten: the row and its photos are on disk and the queue owns them.
  upsertScan({
    apparel_id: request.apparelId,
    cloned_from: null,
    username: request.username,
    timestamp,
    raw_json_data: JSON.stringify(emptyExtraction()),
    key_photo_path: keyPhotoPath,
    image_paths: JSON.stringify(imagePaths),
    catalog_image_url: catalogUrl,
    rendering_status: 'PENDING',
    extraction_status: 'PENDING',
    image_digest: digest,
  });
  // -------------------------------------------------------------------------

  if (!isGeminiReady()) {
    // Queued, not lost. The drain worker will pick it up once a key is set.
    throw new ApiError(
      503,
      'VISION_QUEUED',
      'Vision extraction is not configured. The scan has been stored and will be ' +
        'processed automatically once the server is configured.',
    );
  }

  if (isVisionPaused()) {
    throw new ApiError(
      503,
      'VISION_QUEUED',
      'Vision processing is paused pending an operator action. The scan has been ' +
        'stored and will be processed automatically when processing resumes.',
    );
  }

  const outcome = await runExtraction(request.apparelId, imagePaths, request.files);

  if (!outcome.ok) {
    throw new ApiError(
      outcome.disposition === 'REJECT' ? 422 : 502,
      outcome.disposition === 'REJECT' ? 'VISION_REQUEST_REJECTED' : 'VISION_QUEUED',
      outcome.disposition === 'REJECT'
        ? 'The vision service could not read these images. The scan has been stored ' +
          'and parked for review.'
        : 'Vision extraction did not complete. The scan has been stored and will be ' +
          'retried automatically.',
    );
  }

  const data = outcome.data;

  // Hidden interception — best-effort, never blocks the operator response.
  interceptLowConfidence({
    apparelId: request.apparelId,
    keyPhotoPath,
    imagePaths,
    extraction: data,
    rawGemini: outcome.raw,
  });

  return {
    status: 'success',
    apparel_id: request.apparelId,
    cloned_from: null,
    timestamp,
    catalog_image_url: catalogUrl,
    data,
  };
}

export function processExtraction(
  request: ExtractRequest,
): Promise<VisionExtractResponse> {
  if (request.clonedFrom) {
    // Synchronous by nature, wrapped so callers have one uniform signature.
    return Promise.resolve(cloneFromParent(request));
  }
  return extractFromImages(request);
}

/** Re-exported for tests and the export service. */
export const extractedFieldNames: readonly ExtractedFieldName[] = EXTRACTED_FIELDS;
export const flywheelThreshold = env.flywheelConfidenceThreshold;
