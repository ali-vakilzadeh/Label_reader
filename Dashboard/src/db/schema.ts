import type { Database } from 'better-sqlite3';

/**
 * dashboard.db — the only database this application owns.
 *
 * Column set is Dashboard_plan_final.md §4. Storage is English throughout; Armenian is
 * joined at render time from the reference tables and is never written to an item row.
 */
export const DASHBOARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  apparel_id                TEXT PRIMARY KEY,
  cloned_from               TEXT,
  article_no                TEXT,
  package_code              TEXT,
  operator                  TEXT NOT NULL,
  scanned_at                TEXT NOT NULL,
  export_batch              TEXT,
  import_id                 INTEGER,
  source                    TEXT NOT NULL DEFAULT 'CSV',

  brand                     TEXT, brand_id           INTEGER,
  category                  TEXT, category_id        INTEGER,
  sub_category              TEXT, sub_category_id    INTEGER,
  gender                    TEXT, gender_id          INTEGER,
  season                    TEXT, season_id          INTEGER,
  color                     TEXT, color_id           INTEGER,
  material                  TEXT, material_id        INTEGER,
  country                   TEXT, country_id         INTEGER,
  size                      TEXT,

  original_price            TEXT,
  original_price_value      REAL,
  original_price_currency   TEXT,
  netto                     TEXT,
  brutto                    TEXT,
  netto_g                   REAL,
  brutto_g                  REAL,
  pieces                    INTEGER NOT NULL DEFAULT 1,
  care_info                 TEXT,

  field_src_json            TEXT NOT NULL DEFAULT '{}',
  confidence_json           TEXT,
  min_confidence            REAL,

  user_decided_price          REAL,
  user_decided_price_currency TEXT,
  suggested_price             REAL,
  suggested_price_basis       TEXT,
  suggested_price_n           INTEGER,
  suggested_netto_g           REAL,
  suggested_brutto_g          REAL,
  weight_suggestion_basis     TEXT,
  hs_code                     TEXT,
  hs_code_src                 TEXT,
  hs_code_basis               TEXT,
  suggestion_versions_json     TEXT,

  catalog_image_url         TEXT,
  key_photo_path            TEXT,
  image_paths_json          TEXT,
  rendering_status          TEXT,

  review_state              TEXT NOT NULL DEFAULT 'NEW',
  locked                    INTEGER NOT NULL DEFAULT 0,
  dup_group_id              TEXT,
  dup_reason                TEXT,
  dup_dismissed             INTEGER NOT NULL DEFAULT 0,
  notes                     TEXT,
  deleted_at                INTEGER,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  updated_by                TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_items_scanned    ON items(scanned_at);
CREATE INDEX IF NOT EXISTS idx_items_operator   ON items(operator);
CREATE INDEX IF NOT EXISTS idx_items_article    ON items(article_no);
CREATE INDEX IF NOT EXISTS idx_items_clone      ON items(cloned_from);
CREATE INDEX IF NOT EXISTS idx_items_review     ON items(review_state);
CREATE INDEX IF NOT EXISTS idx_items_brand      ON items(brand);
CREATE INDEX IF NOT EXISTS idx_items_subcat     ON items(sub_category);
CREATE INDEX IF NOT EXISTS idx_items_dup        ON items(dup_group_id);
CREATE INDEX IF NOT EXISTS idx_items_batch      ON items(export_batch);
CREATE INDEX IF NOT EXISTS idx_items_deleted    ON items(deleted_at);
CREATE INDEX IF NOT EXISTS idx_items_similarity ON items(sub_category, brand, gender, size, season, material, country);

CREATE TABLE IF NOT EXISTS imports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT NOT NULL,
  sha256        TEXT NOT NULL UNIQUE,
  uploaded_at   INTEGER NOT NULL,
  uploaded_by   TEXT NOT NULL,
  policy        TEXT NOT NULL,
  rows_total    INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  rows_updated  INTEGER NOT NULL DEFAULT 0,
  rows_skipped  INTEGER NOT NULL DEFAULT 0,
  rows_flagged  INTEGER NOT NULL DEFAULT 0,
  rows_failed   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  report_json   TEXT
);

CREATE TABLE IF NOT EXISTS import_rows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id  INTEGER NOT NULL,
  line_no    INTEGER NOT NULL,
  apparel_id TEXT,
  outcome    TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_rows ON import_rows(import_id);

CREATE TABLE IF NOT EXISTS price_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  apparel_id TEXT NOT NULL,
  price      REAL NOT NULL,
  currency   TEXT NOT NULL,
  set_at     INTEGER NOT NULL,
  set_by     TEXT NOT NULL,
  basis      TEXT
);
CREATE INDEX IF NOT EXISTS idx_price_hist ON price_history(apparel_id, set_at DESC);

CREATE TABLE IF NOT EXISTS dash_users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT NOT NULL UNIQUE,
  display_name         TEXT,
  password_hash        TEXT NOT NULL,
  salt                 TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'viewer',
  status               TEXT NOT NULL DEFAULT 'ACTIVE',
  locale               TEXT NOT NULL DEFAULT 'en',
  columns_json         TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  last_login_at        INTEGER
);

CREATE TABLE IF NOT EXISTS dash_sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON dash_sessions(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  before_json TEXT,
  after_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

CREATE TABLE IF NOT EXISTS article_groups (
  article_no TEXT PRIMARY KEY,
  title      TEXT,
  notes      TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS export_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  preset      TEXT NOT NULL,
  locale      TEXT NOT NULL,
  format      TEXT NOT NULL,
  filters_json TEXT,
  row_count   INTEGER NOT NULL,
  filename    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_export_at ON export_log(at DESC);
`;

/**
 * Forward-only column adds, mirroring the middleware's ensureColumn() approach so an
 * existing database is upgraded in place rather than rebuilt.
 */
export function ensureColumns(db: Database): void {
  const wanted: Array<[string, string, string]> = [
    ['items', 'suggestion_versions_json', 'TEXT'],
    ['items', 'dup_dismissed', 'INTEGER NOT NULL DEFAULT 0'],
    ['items', 'care_info', 'TEXT'],
    ['dash_users', 'columns_json', 'TEXT'],
  ];
  for (const [table, column, decl] of wanted) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.length) continue;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }
}
