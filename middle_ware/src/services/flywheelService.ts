import { env } from '../config/env';
import {
  confirmFlywheelRecord,
  countFlywheelRecords,
  getFlywheelRecord,
  insertFlywheelRecord,
  setFlywheelRenderPath,
} from '../db/flywheelDb';
import { logger } from '../utils/logger';
import type { ExtractedData, FlywheelRow } from '../types';

/**
 * Hidden training flywheel.
 *
 * Every extraction is screened here. If ANY field scores below the configured
 * threshold, the whole scan is cloned into flywheel.db: the raw images, the
 * unconfirmed Gemini prediction, and (once an operator reviews it) the confirmed
 * ground truth. Nothing in this path is visible to dashboards or clients, and no
 * failure here may ever break the operator's scan.
 */

export interface ConfidenceScreen {
  lowest: number;
  lowestField: string | null;
  belowThreshold: boolean;
}

/**
 * Finds the weakest field in an extraction payload.
 *
 * **`care_info` is skipped when it is empty (v1.4).** Most garments carry no care
 * QR code at all, so an absent one is the normal state of a label rather than a
 * weak reading of it. Letting its 0.0 drag the screen down would capture every
 * single scan and evict genuinely uncertain samples from a capped buffer,
 * turning the flywheel into a firehose. A `care_info` that *is* present is
 * always screened, and always routes: its confidence is capped below the
 * threshold by `careInfoConfidence()`, because a misread URL is the one error
 * an operator cannot spot by eye.
 */
export function screenConfidence(
  data: ExtractedData,
  threshold = env.flywheelConfidenceThreshold,
): ConfidenceScreen {
  let lowest = 1;
  let lowestField: string | null = null;

  for (const [field, entry] of Object.entries(data)) {
    if (field === 'care_info' && !entry?.value) continue;
    const confidence = entry?.confidence ?? 0;
    if (confidence < lowest) {
      lowest = confidence;
      lowestField = field;
    }
  }

  return { lowest, lowestField, belowThreshold: lowest < threshold };
}

export interface InterceptInput {
  apparelId: string;
  keyPhotoPath: string | null;
  imagePaths: string[];
  /** The normalised prediction exactly as returned to the device. */
  extraction: ExtractedData;
  /** Gemini's pre-normalisation payload, kept for training comparison. */
  rawGemini?: unknown;
}

/**
 * Routes a low-confidence scan into the training DB.
 * Returns true when the sample was captured. Never throws.
 */
export function interceptLowConfidence(input: InterceptInput): boolean {
  try {
    const screen = screenConfidence(input.extraction);
    if (!screen.belowThreshold) return false;

    insertFlywheelRecord({
      apparel_id: input.apparelId,
      key_photo_path: input.keyPhotoPath,
      raw_images_paths: input.imagePaths,
      unconfirmed_gemini_json: {
        normalized: input.extraction,
        gemini_raw: input.rawGemini ?? null,
        lowest_field: screen.lowestField,
        threshold: env.flywheelConfidenceThreshold,
      },
      lowest_confidence_score: screen.lowest,
    });

    logger.info(
      `Flywheel captured ${input.apparelId} (lowest ${screen.lowest.toFixed(2)} on ` +
        `${screen.lowestField}); buffer at ${countFlywheelRecords()}/${env.flywheelMaxRecords}`,
    );
    return true;
  } catch (error) {
    // Training collection is strictly best-effort — an operator scan must never
    // fail because the hidden flywheel had a problem.
    logger.error(`Flywheel capture failed for ${input.apparelId}`, error);
    return false;
  }
}

/** Binds operator-verified ground truth onto a stored sample. */
export function confirmGroundTruth(apparelId: string, confirmed: unknown): boolean {
  try {
    return confirmFlywheelRecord(apparelId, confirmed);
  } catch (error) {
    logger.error(`Flywheel confirmation failed for ${apparelId}`, error);
    return false;
  }
}

/** Called by the nightly render job once a studio shot exists. */
export function attachRenderPath(apparelId: string, renderPath: string): boolean {
  try {
    return setFlywheelRenderPath(apparelId, renderPath);
  } catch (error) {
    logger.error(`Flywheel render-path sync failed for ${apparelId}`, error);
    return false;
  }
}

export function findSample(apparelId: string): FlywheelRow | undefined {
  return getFlywheelRecord(apparelId);
}

export function flywheelStats(): { records: number; capacity: number; threshold: number } {
  return {
    records: countFlywheelRecords(),
    capacity: env.flywheelMaxRecords,
    threshold: env.flywheelConfidenceThreshold,
  };
}
