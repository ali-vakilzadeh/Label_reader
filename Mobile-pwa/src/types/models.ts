export interface VisionField {
  value: string;
  confidence: number;
}

export interface VisionExtraction {
  category: VisionField;
  subCategory: VisionField;
  gender: VisionField;
  season: VisionField;
  brandName: VisionField;
  countryOfOrigin: VisionField;
  size: VisionField;
  color: VisionField;
  material: VisionField;
  originalPrice: VisionField;
  netto: VisionField;
  brutto: VisionField;
}

export interface RawVisionExtractionResponse {
  category?: { value?: string; confidence?: number };
  sub_category?: { value?: string; confidence?: number };
  gender?: { value?: string; confidence?: number };
  season?: { value?: string; confidence?: number };
  brand_name?: { value?: string; confidence?: number };
  country_of_origin?: { value?: string; confidence?: number };
  size?: { value?: string; confidence?: number };
  color?: { value?: string; confidence?: number };
  material?: { value?: string; confidence?: number };
  original_price?: { value?: string; confidence?: number };
  netto?: { value?: string; confidence?: number };
  brutto?: { value?: string; confidence?: number };
}

export interface AsyncVisionResponse {
  status: string; // "success" | "error"
  apparel_id?: string;
  cloned_from?: string;
  timestamp?: string;
  catalog_image_url?: string;
  processing_status?: 'PENDING_AI' | 'READY_TO_CONFIRM' | 'NEEDS_ATTENTION' | string;
  queue_depth?: number;
  estimated_wait_seconds?: number;
  retry_after_seconds?: number;
  blocking_fault?: string;
  attention_reason?: string;
  data?: RawVisionExtractionResponse;
  extraction?: RawVisionExtractionResponse; // from direct extract response
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
  success?: boolean;
  token?: string;
  expires_in?: string;
  expiresIn?: string;
  message?: string;
  error_code?: string;
}

export interface HealthResponse {
  status: string;
  service?: string;
  uptime_seconds?: number;
  uptimeSeconds?: number;
  version?: string;
  gemini_ready?: boolean;
  geminiConfigured?: boolean;
  timestamp?: string;
}

export interface ConnectionValidationResult {
  isSuccessful: boolean;
  isHealthOk: boolean;
  isAuthOk: boolean;
  serverVersion?: string;
  uptimeSeconds?: number;
  geminiReady: boolean;
  username: string;
  tokenPreview?: string;
  errorMessage?: string;
}

// 0=PENDING_VISION, 1=EXTRACTED_UNVERIFIED, 2=VERIFIED_SAVED, 3=FAILED
export type ScanStatus = 0 | 1 | 2 | 3;

export const SCAN_STATUS = {
  PENDING_VISION: 0 as const,
  EXTRACTED_UNVERIFIED: 1 as const,
  VERIFIED_SAVED: 2 as const,
  FAILED: 3 as const,
};

export const PROCESSING_STATUS = {
  PENDING_AI: 'PENDING_AI' as const,
  READY_TO_CONFIRM: 'READY_TO_CONFIRM' as const,
  NEEDS_ATTENTION: 'NEEDS_ATTENTION' as const,
};

export interface ScanEntity {
  apparelId: string;
  userId: string;
  timestamp: number;
  photos: string[]; // Base64 data URLs or Object URLs (up to 8)
  keyPhotoIndex: number;
  status: ScanStatus;
  serverStored: boolean;
  processingStatus: string; // PENDING_AI | READY_TO_CONFIRM | NEEDS_ATTENTION
  queueDepth: number;
  estimatedWaitSeconds?: number;
  retryAfterSeconds: number;
  blockingFault?: string;
  attentionReason?: string;
  
  extractedCategory: string;
  extractedSubCategory: string;
  extractedGender: string;
  extractedSeason: string;
  extractedBrandName: string;
  extractedCountryOfOrigin: string;
  extractedSize: string;
  extractedColor: string;
  extractedMaterial: string;
  extractedOriginalPrice: string;
  extractedNetto: string;
  extractedBrutto: string;
  
  confidences: Record<string, number>; // Map of field_name -> Float confidence 0.0-1.0
  errorMessage?: string;
  lastAttemptTime: number;
  retryCount: number;
}

export interface DailyLedgerEntity {
  apparelId: string;
  userId: string;
  timestamp: number;
  createdDate: string; // e.g. "2026-08-27"
  
  // 12 Verified Fields
  category: string;
  subCategory: string;
  gender: string;
  season: string;
  brandName: string;
  countryOfOrigin: string;
  size: string;
  color: string;
  material: string;
  originalPrice: string;
  netto: string;
  brutto: string;
  
  // Photos & Metadata
  photos: string[];
  keyPhotoIndex: number;
  isVerified: boolean;
  editedByUser: boolean;
  syncStatus: 'LOCAL_ONLY' | 'SYNCED_BACKEND';
  
  // CSV Session Tracking & Cut-Off Metadata
  exportedAt?: number; // Epoch ms when CSV was generated & downloaded
  exportBatchId?: string; // e.g. "EXPORT_20260827_120400"
  submittedToCsv: boolean; // True once operator explicitly confirms receipt
  submittedAt?: number;
}

export interface AppSettingsData {
  userId: string;
  devicePassword: string;
  serverUrl: string;
  sessionToken?: string;
  defaultStartDestination: 'review' | 'capture' | 'ledger';
  autoSyncAiVision: boolean;
  demoModeEnabled: boolean;
  lastScannedBarcode?: string;
  demoCounter: number;
}
