/**
 * Shared type contract. The field list and JSON shape here are bound by
 * middle_ware/api_contract.md and must not drift without a contract revision.
 */

export const EXTRACTED_FIELDS = [
  'brand_name',
  'country_of_origin',
  'size',
  'color',
  'material',
  'original_price',
  'netto',
  'brutto',
  'category',
  'sub_category',
  'gender',
  'season',
] as const;

export type ExtractedFieldName = (typeof EXTRACTED_FIELDS)[number];

export interface ConfidenceField {
  value: string;
  confidence: number;
}

export type ExtractedData = Record<ExtractedFieldName, ConfidenceField>;

/** Raw Gemini payload: weights arrive as an array and are folded into netto/brutto. */
export interface GeminiRawExtraction {
  brand_name: ConfidenceField;
  country_of_origin: ConfidenceField;
  size: ConfidenceField;
  color: ConfidenceField;
  material: ConfidenceField;
  original_price: ConfidenceField;
  category: ConfidenceField;
  sub_category: ConfidenceField;
  gender: ConfidenceField;
  season: ConfidenceField;
  weights: ConfidenceField[];
}

/**
 * Pipeline position of one scan, as published to the Android client.
 * Bound by api_contract.md v1.1 §3 — do not rename without a contract revision.
 */
export type ProcessingStatus = 'PENDING_AI' | 'READY_TO_CONFIRM' | 'NEEDS_ATTENTION';

/**
 * The v1.1 scan response. Returned by POST /vision/extract (always 202) and by
 * the result endpoints (200).
 *
 * `data` is non-null only when processing_status is READY_TO_CONFIRM.
 */
export interface VisionExtractResponse {
  status: 'success';
  apparel_id: string;
  cloned_from: string | null;
  timestamp: string;
  catalog_image_url: string;
  processing_status: ProcessingStatus;
  /** Scans queued ahead of this one. */
  queue_depth: number;
  /** Estimated seconds until ready; null when paused and no estimate is meaningful. */
  estimated_wait_seconds: number | null;
  /** When the client should poll next. Always present, clamped to 5..120. */
  retry_after_seconds: number;
  /** Fault code when processing is paused, else null. Advisory. */
  blocking_fault: string | null;
  /** Short cause, set only for NEEDS_ATTENTION. */
  attention_reason?: string | null;
  data: ExtractedData | null;
}

export interface VisionResultsBatchResponse {
  status: 'success';
  results: VisionExtractResponse[];
  not_found: string[];
  queue_depth: number;
  retry_after_seconds: number;
}

export interface ApiErrorBody {
  status: 'error';
  error_code: string;
  message: string;
}

export type RenderingStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

/**
 * Extraction lifecycle. A scan is durably recorded BEFORE Gemini is called, so
 * a vision outage can never make a scan disappear.
 *
 *   PENDING   accepted and stored; extraction still owed
 *   COMPLETED extracted successfully
 *   PARKED    this specific scan cannot be extracted (rejected payload);
 *             kept forever for human review — never deleted
 */
export type ExtractionStatus = 'PENDING' | 'COMPLETED' | 'PARKED';

export interface ServerScanRow {
  apparel_id: string;
  cloned_from: string | null;
  username: string;
  timestamp: string;
  raw_json_data: string;
  key_photo_path: string | null;
  image_paths: string | null;
  catalog_image_url: string;
  rendering_status: RenderingStatus;
  render_attempts: number;
  render_error: string | null;
  extraction_status: ExtractionStatus;
  extraction_attempts: number;
  extraction_error: string | null;
  extraction_fault_code: string | null;
  next_attempt_at: number | null;
  image_digest: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface FlywheelRow {
  apparel_id: string;
  key_photo_path: string | null;
  raw_images_paths: string | null;
  unconfirmed_gemini_json: string;
  confirmed_json: string | null;
  catalog_render_path: string | null;
  lowest_confidence_score: number;
  created_at: number;
  confirmed_at: number | null;
}

export interface AuthTokenPayload {
  username: string;
  iat?: number;
  exp?: number;
}
