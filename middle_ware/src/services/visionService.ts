import { env } from '../config/env';
import { getScan, upsertScan } from '../db/operationalDb';
import { extractApparelData, isGeminiReady } from './geminiService';
import { interceptLowConfidence } from './flywheelService';
import { buildCatalogUrl, persistImages } from './storageService';
import { FIELD_INDEXES } from '../utils/fuzzyMatcher';
import { clampConfidence, resolveWeights } from '../utils/weights';
import { logger } from '../utils/logger';
import { ApiError } from '../middleware/errorHandler';
import {
  EXTRACTED_FIELDS,
  type ConfidenceField,
  type ExtractedData,
  type ExtractedFieldName,
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

  if (!isGeminiReady()) {
    throw new ApiError(
      503,
      'VISION_UNAVAILABLE',
      'Vision extraction is not configured on this server.',
    );
  }

  // The catalog URL is deterministic and returned immediately; the actual studio
  // render is produced by the 20:00 cron job.
  const catalogUrl = buildCatalogUrl(request.apparelId);
  const timestamp = new Date().toISOString();

  const stored = persistImages(request.apparelId, request.files);
  const imagePaths = stored.map((image) => image.path);
  const keyIndex =
    request.keyPhotoIndex >= 0 && request.keyPhotoIndex < stored.length
      ? request.keyPhotoIndex
      : 0;
  const keyPhotoPath = stored[keyIndex]?.path ?? null;

  let raw: GeminiRawExtraction;
  try {
    raw = await extractApparelData(
      request.files.map((file) => ({
        mimeType: file.mimetype,
        data: file.buffer.toString('base64'),
      })),
    );
  } catch (error) {
    logger.error(`Gemini extraction failed for ${request.apparelId}`, error);
    throw new ApiError(
      502,
      'VISION_EXTRACTION_FAILED',
      'Failed to extract values from labels. The vision service returned an error.',
    );
  }

  const data = normalizeExtraction(raw);

  upsertScan({
    apparel_id: request.apparelId,
    cloned_from: null,
    username: request.username,
    timestamp,
    raw_json_data: JSON.stringify(data),
    key_photo_path: keyPhotoPath,
    image_paths: JSON.stringify(imagePaths),
    catalog_image_url: catalogUrl,
    rendering_status: 'PENDING',
  });

  // Hidden interception — best-effort, never blocks the operator response.
  interceptLowConfidence({
    apparelId: request.apparelId,
    keyPhotoPath,
    imagePaths,
    extraction: data,
    rawGemini: raw,
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
