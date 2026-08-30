/** One row of `items`. Mirrors src/db/schema.ts exactly. */
export interface ItemRow {
  apparel_id: string;
  cloned_from: string | null;
  article_no: string | null;
  package_code: string | null;
  operator: string;
  scanned_at: string;
  export_batch: string | null;
  import_id: number | null;
  source: string;

  brand: string | null;
  brand_id: number | null;
  category: string | null;
  category_id: number | null;
  sub_category: string | null;
  sub_category_id: number | null;
  gender: string | null;
  gender_id: number | null;
  season: string | null;
  season_id: number | null;
  color: string | null;
  color_id: number | null;
  material: string | null;
  material_id: number | null;
  country: string | null;
  country_id: number | null;
  size: string | null;

  original_price: string | null;
  original_price_value: number | null;
  original_price_currency: string | null;
  netto: string | null;
  brutto: string | null;
  netto_g: number | null;
  brutto_g: number | null;
  pieces: number;
  care_info: string | null;

  field_src_json: string;
  confidence_json: string | null;
  min_confidence: number | null;

  user_decided_price: number | null;
  user_decided_price_currency: string | null;
  suggested_price: number | null;
  suggested_price_basis: string | null;
  suggested_price_n: number | null;
  suggested_netto_g: number | null;
  suggested_brutto_g: number | null;
  weight_suggestion_basis: string | null;
  hs_code: string | null;
  hs_code_src: string | null;
  hs_code_basis: string | null;
  suggestion_versions_json: string | null;

  catalog_image_url: string | null;
  key_photo_path: string | null;
  image_paths_json: string | null;
  rendering_status: string | null;

  review_state: 'NEW' | 'NEEDS_REVIEW' | 'REVIEWED' | 'PARKED';
  locked: number;
  dup_group_id: string | null;
  dup_reason: string | null;
  dup_dismissed: number;
  notes: string | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  updated_by: string;
}

/** The twelve extraction fields, in api_contract.md §4.2 order. */
export const EXTRACTED_FIELDS = [
  'brand',
  'country',
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
