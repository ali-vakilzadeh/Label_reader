/**
 * Local data model, aligned to api_contract.md v1.4.
 *
 * Two rules from the contract shape everything here:
 *  - `data` is 13 fields since v1.4 (`care_info` added), each `{ value, confidence }`,
 *    never omitted and never null.
 *  - `PackageCode` and `SetSize` are deliberately absent from the API. They are
 *    operator input, live only on the device and in the CSV, and are never sent.
 */

export interface VisionField {
  value: string;
  confidence: number;
}

/** The 13 keys of `data`, in the order the contract lists them. */
export const AI_FIELDS = [
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
  'care_info'
] as const;

export type AiFieldKey = (typeof AI_FIELDS)[number];

/** `data` as it arrives on the wire. Every key optional so a v1.2 server still parses. */
export type RawVisionExtractionResponse = Partial<
  Record<AiFieldKey, { value?: string; confidence?: number }>
>;

/**
 * `data_hy` - the Armenian rendering of `data`, same 13 keys, plain strings or null.
 * `null` means "no Armenian exists for this field - display the English value from
 * `data`". It never means "show nothing" (contract section 4.2).
 */
export type ArmenianLabels = Partial<Record<AiFieldKey, string | null>>;

export interface AsyncVisionResponse {
  status: string; // "success" | "error"
  apparel_id?: string;
  cloned_from?: string | null;
  timestamp?: string;
  catalog_image_url?: string;
  processing_status?: 'PENDING_AI' | 'READY_TO_CONFIRM' | 'NEEDS_ATTENTION' | string;
  queue_depth?: number;
  estimated_wait_seconds?: number | null;
  retry_after_seconds?: number;
  blocking_fault?: string | null;
  attention_reason?: string | null;
  /** v1.4. Zero-based index of the photo the model judged to be the main shot. */
  suggested_key_photo_index?: number | null;
  data?: RawVisionExtractionResponse | null;
  /** v1.4. Absent on a pre-v1.4 server; the app falls back to table lookup. */
  data_hy?: ArmenianLabels | null;
  error_code?: string;
  message?: string;
}

export interface BatchVisionResultsResponse {
  status: string;
  results?: AsyncVisionResponse[];
  not_found?: string[];
  queue_depth?: number;
  retry_after_seconds?: number;
  error_code?: string;
  message?: string;
}

export interface LoginResponse {
  status?: string;
  token?: string;
  expires_in?: string;
  message?: string;
  error_code?: string;
}

export interface HealthResponse {
  status: string;
  uptime_seconds?: number;
  version?: string;
  /** Contract revision the server implements, e.g. "1.4". Absent on v1.1 and earlier. */
  api_contract?: string;
  gemini_ready?: boolean;
  /** Fingerprint of the served vocabulary; v1.3+. Cheapest way to spot a table change. */
  reference_version?: string;
}

export interface ConnectionValidationResult {
  isSuccessful: boolean;
  isHealthOk: boolean;
  isAuthOk: boolean;
  serverVersion?: string;
  apiContract?: string;
  uptimeSeconds?: number;
  geminiReady: boolean;
  username: string;
  tokenPreview?: string;
  errorMessage?: string;
  /** Set when the server is reachable but older than the contract this app targets. */
  contractWarning?: string;
}

// 0=PENDING_VISION, 1=EXTRACTED_UNVERIFIED, 2=VERIFIED_SAVED, 3=FAILED
export type ScanStatus = 0 | 1 | 2 | 3;

export const SCAN_STATUS = {
  PENDING_VISION: 0 as const,
  EXTRACTED_UNVERIFIED: 1 as const,
  VERIFIED_SAVED: 2 as const,
  FAILED: 3 as const
};

export const PROCESSING_STATUS = {
  PENDING_AI: 'PENDING_AI' as const,
  READY_TO_CONFIRM: 'READY_TO_CONFIRM' as const,
  NEEDS_ATTENTION: 'NEEDS_ATTENTION' as const
};

/**
 * The 13 AI fields plus the operator's own, as the app holds them between
 * extraction and the ledger. English keys only - Armenian is display, never storage.
 */
export interface GarmentFields {
  brandName: string;
  countryOfOrigin: string;
  size: string;
  color: string;
  material: string;
  originalPrice: string;
  netto: string;
  brutto: string;
  category: string;
  subCategory: string;
  gender: string;
  season: string;
  careInfo: string;
}

export function emptyGarmentFields(): GarmentFields {
  return {
    brandName: '',
    countryOfOrigin: '',
    size: '',
    color: '',
    material: '',
    originalPrice: '',
    netto: '',
    brutto: '',
    category: '',
    subCategory: '',
    gender: '',
    season: '',
    careInfo: ''
  };
}

/** Maps a local field name onto its contract key, for confidence and data_hy lookups. */
export const FIELD_TO_API: Record<keyof GarmentFields, AiFieldKey> = {
  brandName: 'brand_name',
  countryOfOrigin: 'country_of_origin',
  size: 'size',
  color: 'color',
  material: 'material',
  originalPrice: 'original_price',
  netto: 'netto',
  brutto: 'brutto',
  category: 'category',
  subCategory: 'sub_category',
  gender: 'gender',
  season: 'season',
  careInfo: 'care_info'
};

export interface ScanEntity {
  apparelId: string;
  userId: string;
  timestamp: number;
  photos: string[]; // Base64 data URLs, up to 8
  keyPhotoIndex: number;
  status: ScanStatus;
  serverStored: boolean;
  processingStatus: string; // PENDING_AI | READY_TO_CONFIRM | NEEDS_ATTENTION
  queueDepth: number;
  estimatedWaitSeconds?: number;
  retryAfterSeconds: number;
  blockingFault?: string;
  attentionReason?: string;

  /** v1.4 envelope field. Pre-selected in review; the operator still decides. */
  suggestedKeyPhotoIndex?: number | null;

  /** The 13 extracted values, English keys. */
  extracted: GarmentFields;
  /** Armenian labels from `data_hy`, by contract key. Empty on a pre-v1.4 server. */
  armenian: ArmenianLabels;
  /** field_name -> confidence 0.0-1.0, keyed by contract name. */
  confidences: Partial<Record<AiFieldKey, number>>;

  /**
   * Operator input, never sent to the server (contract section 8.5). Carried on the
   * scan so a part-finished record keeps them across sessions.
   */
  packageCode: string;
  setSize: number;

  /** Operator edits held while the record is reviewed over several sittings. */
  draft?: GarmentFields;
  draftSavedAt?: number;

  errorMessage?: string;
  lastAttemptTime: number;
  retryCount: number;
}

export interface DailyLedgerEntity {
  apparelId: string;
  userId: string;
  timestamp: number;
  createdDate: string; // "2026-08-27"

  /** The 13 confirmed fields. */
  fields: GarmentFields;

  /** CSV-only operator input. */
  packageCode: string;
  setSize: number;

  photos: string[];
  keyPhotoIndex: number;
  isVerified: boolean;
  editedByUser: boolean;
  syncStatus: 'LOCAL_ONLY' | 'SYNCED_BACKEND';

  /**
   * Stamped when the CSV file is generated. This is the lock point: once a row has
   * been written into a file on disk, it is read-only (client decision 2026-09-07).
   */
  exportedAt?: number;
  exportBatchId?: string;
  /** Set when the operator confirms the batch was received, which ends the session. */
  submittedToCsv: boolean;
  submittedAt?: number;
}

/** A ledger row is locked as soon as it has been written into an exported file. */
export function isLedgerItemLocked(item: DailyLedgerEntity): boolean {
  return Boolean(item.exportBatchId) || item.submittedToCsv;
}

/**
 * The fields the "Require all fields complete to Export" gate checks, in the order
 * the operator sees them. OriginalPrice and CareInfo are excluded: the contract marks
 * both nullable, and a garment with no printed price or no QR code is not incomplete.
 */
export const REQUIRED_FOR_EXPORT: Array<{ key: keyof GarmentFields; label: string }> = [
  { key: 'brandName', label: 'Brand' },
  { key: 'category', label: 'Category' },
  { key: 'subCategory', label: 'SubCategory' },
  { key: 'gender', label: 'Gender' },
  { key: 'season', label: 'Season' },
  { key: 'size', label: 'Size' },
  { key: 'color', label: 'Color' },
  { key: 'material', label: 'Material' },
  { key: 'countryOfOrigin', label: 'Country' },
  { key: 'netto', label: 'Netto' },
  { key: 'brutto', label: 'Brutto' }
];

/** Names the columns still blank on a row. Barcode is the key, so it is checked apart. */
export function missingRequiredFields(item: DailyLedgerEntity): string[] {
  const missing: string[] = [];
  if (!item.apparelId.trim()) missing.push('Barcode');
  for (const { key, label } of REQUIRED_FOR_EXPORT) {
    if (!item.fields[key] || !item.fields[key].trim()) missing.push(label);
  }
  return missing;
}

export type TorchMode = 'auto' | 'on' | 'off';
export type UiLanguage = 'en' | 'hy';
export type StartDestination = 'capture' | 'review' | 'ledger' | 'settings';

export interface AppSettingsData {
  userId: string;
  devicePassword: string;
  serverUrl: string;
  sessionToken?: string;
  defaultStartDestination: StartDestination;
  autoSyncAiVision: boolean;
  /** On blocks export while any required column is blank; Off warns and proceeds. */
  requireCompleteForExport: boolean;
  /** Sticky across scans until the operator types a different one (decision 6). */
  packageCode: string;
  torchMode: TorchMode;
  language: UiLanguage;
}
