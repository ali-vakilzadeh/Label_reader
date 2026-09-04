/**
 * Interface chrome in English and Armenian.
 *
 * Data values are NOT translated here — they are looked up in the client's reference
 * tables (src/data/resolve.ts). This file is labels and buttons only, and it follows the
 * same fallback rule: a missing key renders the English string, never a blank.
 */

export type Locale = 'en' | 'hy';

const EN = {
  app_title: 'Label Reader — Dashboard',
  nav_items: 'Items',
  nav_import: 'Import',
  nav_analytics: 'Analytics',
  nav_exports: 'Exports',
  nav_server: 'Server',
  nav_training: 'Training data',
  nav_users: 'Users',
  nav_logout: 'Sign out',
  login: 'Sign in',
  username: 'Username',
  password: 'Password',
  search: 'Search',
  filters: 'Filters',
  apply: 'Apply',
  reset: 'Reset',
  save: 'Save',
  cancel: 'Cancel',
  barcode: 'Barcode',
  brand: 'Brand',
  category: 'Category',
  sub_category: 'Sub-category',
  gender: 'Gender',
  season: 'Season',
  size: 'Size',
  color: 'Colour',
  material: 'Material',
  country: 'Country',
  original_price: 'Original price',
  netto: 'Netto',
  brutto: 'Brutto',
  pieces: 'Pieces',
  set_size: 'Set of',
  package_code: 'Package',
  article_no: 'Article',
  operator: 'Operator',
  scanned_at: 'Scanned',
  price: 'Price',
  suggested: 'Suggested',
  hs_code: 'HS code',
  review: 'Review',
  notes: 'Notes',
  actions: 'Actions',
  lock: 'Lock',
  unlock: 'Unlock',
  delete: 'Delete',
  set_price: 'Set price',
  photos: 'Original photos',
  catalog: 'Catalog image',
  group: 'Group',
  duplicate: 'Possible duplicate',
  needs_review: 'Needs review',
  reviewed: 'Reviewed',
  parked: 'Parked',
  no_rows: 'No items match these filters.',
  language: 'Language',
};

/**
 * Armenian chrome. Anything not translated here falls through to English by the lookup
 * below — the same never-blank rule the data layer follows.
 */
const HY: Partial<Record<keyof typeof EN, string>> = {
  app_title: 'Պիտակ ընթերցող — Վահանակ',
  nav_items: 'Ապրանքներ',
  nav_import: 'Ներմուծում',
  nav_analytics: 'Վերլուծություն',
  nav_exports: 'Արտահանում',
  nav_server: 'Սերվեր',
  nav_training: 'Ուսուցման տվյալներ',
  nav_users: 'Օգտատերեր',
  nav_logout: 'Դուրս գալ',
  login: 'Մուտք',
  username: 'Օգտանուն',
  password: 'Գաղտնաբառ',
  search: 'Որոնում',
  filters: 'Զտիչներ',
  apply: 'Կիրառել',
  reset: 'Զրոյացնել',
  save: 'Պահպանել',
  cancel: 'Չեղարկել',
  barcode: 'Շտրիխ կոդ',
  brand: 'Բրենդ',
  category: 'Կատեգորիա',
  sub_category: 'Ենթակատեգորիա',
  gender: 'Սեռ',
  season: 'Եղանակ',
  size: 'Չափս',
  color: 'Գույն',
  material: 'Մատերիալ',
  country: 'Ծագման երկիր',
  original_price: 'Սկզբնական գին',
  netto: 'Նետտո',
  brutto: 'Բրուտտո',
  pieces: 'Քանակ',
  set_size: 'Կոմպլեկտ',
  package_code: 'Փաթեթ',
  article_no: 'Հոդված',
  operator: 'Օպերատոր',
  scanned_at: 'Սկանավորված',
  price: 'Գին',
  suggested: 'Առաջարկվող',
  hs_code: 'ՀՏ ծածկագիր',
  review: 'Ստուգում',
  notes: 'Նշումներ',
  actions: 'Գործողություններ',
  lock: 'Կողպել',
  unlock: 'Բացել',
  delete: 'Ջնջել',
  set_price: 'Սահմանել գինը',
  photos: 'Բնօրինակ լուսանկարներ',
  catalog: 'Կատալոգի նկար',
  group: 'Խումբ',
  duplicate: 'Հնարավոր կրկնօրինակ',
  needs_review: 'Պահանջում է ստուգում',
  reviewed: 'Ստուգված',
  parked: 'Կասեցված',
  no_rows: 'Այս զտիչներին համապատասխան ապրանք չկա։',
  language: 'Լեզու',
};

export type MessageKey = keyof typeof EN;

export function t(key: MessageKey, locale: Locale): string {
  if (locale === 'hy') return HY[key] || EN[key];
  return EN[key];
}

/** Bound translator handed to every template. */
export function translator(locale: Locale) {
  return (key: MessageKey) => t(key, locale);
}
