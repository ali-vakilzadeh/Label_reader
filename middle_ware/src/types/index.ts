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

export interface VisionExtractResponse {
  status: 'success';
  apparel_id: string;
  cloned_from: string | null;
  timestamp: string;
  catalog_image_url: string;
  data: ExtractedData;
}

export interface ApiErrorBody {
  status: 'error';
  error_code: string;
  message: string;
}

export type RenderingStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

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
