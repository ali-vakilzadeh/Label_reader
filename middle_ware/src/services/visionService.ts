import { env } from '../config/env';
import {
  completeExtraction,
  extractionCounts,
  failExtraction,
  getScan,
  upsertScan,
} from '../db/operationalDb';
import { extractApparelData } from './geminiService';
import { classifyGeminiError, type FaultDisposition } from './geminiErrors';
import {
  activeFault,
  isVisionPaused,
  reportVisionFault,
  reportVisionSuccess,
} from './controlService';
import { interceptLowConfidence } from './flywheelService';
import { requestDrain } from './drainSignal';
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
  type ProcessingStatus,
  type ServerScanRow,
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

  // A clone needs no AI, so it is ready the moment it is stored.
  return buildScanResponse({
    apparelId: request.apparelId,
    clonedFrom: parentId,
    timestamp,
    catalogUrl,
    processingStatus: 'READY_TO_CONFIRM',
    data,
  });
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
// ---------------------------------------------------------------- v1.1 ----

/**
 * Client-facing queue snapshot. Drives the polling hints in every scan response
 * (api_contract.md v1.1 §4.2).
 */
export interface QueueSnapshot {
  depth: number;
  estimatedWaitSeconds: number | null;
  retryAfterSeconds: number;
  blockingFault: string | null;
}

export function queueSnapshot(): QueueSnapshot {
  try {
    return readQueueSnapshot();
  } catch (error) {
    // These are advisory display hints, read AFTER the scan is already committed.
    // Letting them throw would turn a stored scan into a 5xx, and the contract
    // says 5xx means "not stored, resend" — so a hint failure must never
    // propagate. Degrade to a conservative poll interval instead.
    logger.error('Queue snapshot unavailable; returning conservative hints.', error);
    return {
      depth: 0,
      estimatedWaitSeconds: null,
      retryAfterSeconds: env.pollRetryMaxSeconds,
      blockingFault: null,
    };
  }
}

function readQueueSnapshot(): QueueSnapshot {
  const depth = extractionCounts().pending;
  const paused = isVisionPaused();
  const blockingFault = paused ? activeFault() : null;

  // While paused the wait is operator-dependent, so no honest estimate exists.
  // Reporting a number there would be a guess the operator would rely on.
  const estimatedWaitSeconds = paused ? null : depth * env.visionSecondsPerItem;

  // Poll at the ceiling while paused; otherwise track the estimate, clamped so
  // devices neither hammer the server nor sleep through a fast queue.
  const retryAfterSeconds = paused
    ? env.pollRetryMaxSeconds
    : Math.min(
        env.pollRetryMaxSeconds,
        Math.max(env.pollRetryMinSeconds, estimatedWaitSeconds ?? env.pollRetryMinSeconds),
      );

  return { depth, estimatedWaitSeconds, retryAfterSeconds, blockingFault };
}

/** Maps stored extraction state onto the published vocabulary. */
export function processingStatusOf(status: ExtractionStatus): ProcessingStatus {
  switch (status) {
    case 'COMPLETED':
      return 'READY_TO_CONFIRM';
    case 'PARKED':
      return 'NEEDS_ATTENTION';
    default:
      return 'PENDING_AI';
  }
}

interface ResponseParts {
  apparelId: string;
  clonedFrom: string | null;
  timestamp: string;
  catalogUrl: string;
  processingStatus: ProcessingStatus;
  data: ExtractedData | null;
  attentionReason?: string | null;
}

/** Single place the v1.1 response shape is assembled. */
export function buildScanResponse(parts: ResponseParts): VisionExtractResponse {
  const snapshot = queueSnapshot();
  const terminal = parts.processingStatus !== 'PENDING_AI';

  return {
    status: 'success',
    apparel_id: parts.apparelId,
    cloned_from: parts.clonedFrom,
    timestamp: parts.timestamp,
    catalog_image_url: parts.catalogUrl,
    processing_status: parts.processingStatus,
    // A finished scan owes no wait, whatever the rest of the queue is doing.
    queue_depth: terminal ? 0 : snapshot.depth,
    estimated_wait_seconds: terminal ? 0 : snapshot.estimatedWaitSeconds,
    retry_after_seconds: terminal ? env.pollRetryMinSeconds : snapshot.retryAfterSeconds,
    blocking_fault: terminal ? null : snapshot.blockingFault,
    attention_reason: parts.attentionReason ?? null,
    data: parts.data,
  };
}

/** Builds a response from a stored row — used by both result endpoints. */
export function responseForScan(scan: ServerScanRow): VisionExtractResponse {
  const processingStatus = processingStatusOf(scan.extraction_status);
  let data: ExtractedData | null = null;

  if (processingStatus === 'READY_TO_CONFIRM') {
    try {
      data = JSON.parse(scan.raw_json_data) as ExtractedData;
    } catch {
      // A corrupt payload must not read as "ready" — send it for review instead
      // of handing the operator garbage.
      logger.error(`Stored extraction for ${scan.apparel_id} is unparseable.`);
      return buildScanResponse({
        apparelId: scan.apparel_id,
        clonedFrom: scan.cloned_from,
        timestamp: scan.timestamp,
        catalogUrl: scan.catalog_image_url,
        processingStatus: 'NEEDS_ATTENTION',
        data: null,
        attentionReason: 'Stored extraction could not be read.',
      });
    }
  }

  return buildScanResponse({
    apparelId: scan.apparel_id,
    clonedFrom: scan.cloned_from,
    timestamp: scan.timestamp,
    catalogUrl: scan.catalog_image_url,
    processingStatus,
    data,
    attentionReason:
      processingStatus === 'NEEDS_ATTENTION'
        ? (scan.extraction_error ?? 'This scan could not be extracted automatically.')
        : null,
  });
}

/**
 * Accepts a scan for asynchronous extraction (api_contract.md v1.1 §4.2).
 *
 * Pure async: the vision API is NOT called here. The scan is stored durably and
 * handed to the drain worker, so the request returns in milliseconds and the
 * operator never waits on the AI. Every successful outcome is HTTP 202.
 */
export function acceptScan(request: ExtractRequest): VisionExtractResponse {
  if (request.files.length === 0) {
    throw new ApiError(
      400,
      'INVALID_IMAGE_PAYLOAD',
      'Failed to extract values from labels. At least one readable image is required.',
    );
  }

  const catalogUrl = buildCatalogUrl(request.apparelId);
  const digest = digestImages(request.files);
  const existing = getScan(request.apparelId);

  // ---- IDEMPOTENT REPLAY --------------------------------------------------
  // A device that never received our response retries the identical scan. That
  // must return the stored state, not re-queue work or overwrite a finished
  // extraction with an empty one.
  if (existing && existing.image_digest === digest) {
    logger.info(
      `Duplicate submission for ${request.apparelId} ` +
        `(${existing.extraction_status}); replaying stored state.`,
    );
    return responseForScan(existing);
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
  // Photos and row are committed before anything else can fail. Past this line
  // the queue owns the scan: an outage, a pause, or a restart costs latency,
  // never data.
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

  // Nudge the drain worker so an idle queue starts immediately rather than
  // waiting out the sweep interval.
  requestDrain();

  return buildScanResponse({
    apparelId: request.apparelId,
    clonedFrom: null,
    timestamp,
    catalogUrl,
    processingStatus: 'PENDING_AI',
    data: null,
  });
}

/**
 * Single entry point for POST /vision/extract.
 *
 * Both branches are synchronous now: cloning reads the parent from the local DB,
 * and a normal scan is stored and queued. Neither waits on the vision API.
 */
export function processExtraction(request: ExtractRequest): VisionExtractResponse {
  if (request.clonedFrom) {
    return cloneFromParent(request);
  }
  return acceptScan(request);
}

/** Re-exported for tests and the export service. */
export const extractedFieldNames: readonly ExtractedFieldName[] = EXTRACTED_FIELDS;
export const flywheelThreshold = env.flywheelConfidenceThreshold;
