# Label Reader — Analytical Dashboard
## Final Consolidated Plan

**Version 1.2 · 2026-09-04 · Status: specification agreed; implementation started**

*v1.2 adds the reference-data authoring workflow (§6.4): the dashboard is now where a supervisor
decides an Armenian label or a missing taxonomy term, and those decisions propagate to the
middleware and the handsets. Prompted by the client's requirement that operators read AI results
and record decisions in Armenian.*

*v1.1 folded in six client answers that closed five of the seven open gaps. See §14.*

Format note: Markdown, with machine-readable blocks (`json`) embedded where a builder needs
literal values. A pure-JSON plan cannot carry the *why*, and the why is what keeps the next
developer from undoing a decision. The JSON blocks are the parts to copy verbatim.

**Authoritative inputs consolidated here** (read these before changing anything below):

| Source | Role here |
|---|---|
| `docs/client_data/Outfit_Label_Reader_Order_Letter_FINAL.docx` | Contractual acceptance criteria. Governs on conflict (§7 of the letter). |
| `middle_ware/UI_messaging_protocol.md` v1.4 | **Locked.** The only channel between dashboard and middleware. §9.2 carries taxonomy decisions. |
| `middle_ware/server_setting_page.md` | Screen-level spec for the settings area. Absorbed into §11 here. |
| `middle_ware/api_contract.md` v1.3 | **Locked** app↔middleware contract. Defines the 12 extracted fields, and §4.6 serves the bilingual tables to the app. |
| `middle_ware/server_specification.json` v2.0 | Division of labour, taxonomy strategy. |
| `Mobile_app/csv_export_format.txt` | The daily ledger the dashboard ingests. |
| `docs/client_data/*.xlsx` | The client's **real** invoice / inspection layouts — the export targets. |
| `middle_ware/reference_data/*.csv` | The client's taxonomy tables (Armenian · id · English). |
| `Dashboard/dashboard-plan.md` | The seed draft. Superseded by this file; kept for history. |

---

## 0. The one-paragraph summary

A single-process Node/Express web app, running on the same VPS as the middleware, serving a
server-rendered bilingual (EN/AM) UI. It owns one SQLite file (`dashboard.db`). It ingests the
Android app's daily CSV ledger, enriches it from the middleware's `server_scans.db`, snaps free
text onto the client's reference tables, adds the commercial columns the client needs
(price, HS code, pieces, package, article group), and exports the client's existing invoice,
customs and inspection layouts in English or Armenian. It talks to the middleware **only** by
reading and writing rows in the shared `control.db` — no HTTP between the two processes, so
either can be down without the other noticing.

---

## 1. Decisions that override the seed plan

These are deliberate corrections to `Dashboard/dashboard-plan.md`. Each one has a reason; do not
revert them without addressing the reason.

| # | Seed plan said | Final decision | Why |
|---|---|---|---|
| 1 | PostgreSQL for auth, roles, UI logs, price history | **No PostgreSQL.** One SQLite file, `dashboard.db`, via `better-sqlite3` | The brief requires "very lightweight, same server as middleware". A second database engine is a second service to install, back up, secure and hand over. 10 users and tens of thousands of rows is far inside SQLite's range. Removing it also makes the handover a single-directory copy. |
| 2 | Armenian comes from `legalArmenianMap.json` | **Armenian comes from `reference_data/*.csv` only** | Those CSVs are the client's own tables (`Armenian · id · English`) and are the same files the middleware selects against, so text and numeric id always agree. `legalArmenianMap.json` and `data/translations.csv` are the middleware's older lowercase maps, predating the taxonomy decisions, and cover fewer terms. Using both would produce two Armenian spellings for one item. |
| 3 | Fuzzy-snap every imported value | **Snap only what does not already match exactly, and never silently.** Exact → accept. Fuse.js similarity ≥ 0.85 → accept and stamp `FUZZY`. Below → keep the operator's text verbatim, stamp `UNMATCHED`, put the row in the review queue | The middleware already snapped these fields against the same tables. Re-snapping a settled value can only disagree with it. What genuinely needs snapping is text an operator *corrected by hand* on the device. And a wrong table entry is worse than an unmatched one — `server_specification.json` says so explicitly; this rule keeps that promise on the dashboard side too. |
| 4 | Photo-similarity price model (>85 % visual match) in phase 1 | **Deferred to phase 2.** Phase 1 pricing is deterministic and spec-based | Visual similarity needs an embedding model or a native image library on the VPS, which contradicts "lightweight" and makes the price unexplainable to the person signing the invoice. A spec-based median with a shown sample size can be defended in a customs office. |
| 5 | Local vision AI fallback for weight | **Removed.** No AI call ever leaves the dashboard | The middleware owns the entire vision pipeline (`server_specification.json`, taxonomy division of labour). A second Gemini caller means a second key, second bill, second failure mode, and a second set of values that disagree. Missing weight falls back to the sub-category median, then stays blank and flagged. |
| 6 | Near-duplicate detection implied via image similarity | **Attribute-based duplicate detection** on `(brand, sub_category, size, color, material, country)` + weights + time window | The order letter requires duplicate warnings. The real warehouse failure is the same item scanned twice minutes apart, which attributes catch exactly, with zero dependencies and an explainable reason string. Perceptual hashing is a phase-2 refinement, not the mechanism. |
| 7 | Icon-only row controls, "no text" | **Icon + tooltip + `aria-label`, and a text label at ≥1200 px** | A bilingual UI used by warehouse staff cannot rely on a bare 🏷️ being unambiguous, and the client must be able to hand the system to another developer. |
| 8 | "Export to `.xlsx` with UTF-8 BOM" | **BOM applies to CSV only.** `.xlsx` carries its own encoding | A BOM written into an xlsx stream corrupts the file. Armenian in *CSV* opened by Excel does need the BOM — that part is right and is kept. |
| 9 | Presets "filter out items where `cloned_from` is not empty" | **Clone rows are collapsed into their parent line, and their count is added to `Pieces`** | Simply dropping clones would under-report the shipment. A clone is a real physical item; it belongs in the quantity, not on its own invoice line. |
| 10 | One user store, "admin/admin, max 10 users" | **Two separate identity stores, never mixed.** Dashboard logins live in `dashboard.db`; Android operator accounts live in the middleware and are only *requested* through `app_user_requests` | They have different lifetimes, different password rules and different blast radius. The seed plan blurred them, which would let a dashboard bug sign the warehouse fleet out. `admin`/`admin` is kept as the zero-point login but **must** force a password change on first use. |
| 11 | (unstated) | **`server_scans.db` is read-only by discipline, but must be opened read-write at the OS level** | SQLite cannot read a WAL database without writing its `-shm` sibling. A genuinely read-only mount makes the file unreadable. This is the failure that appears hours after a working deploy — see `UI_messaging_protocol.md` §1. |
| 12 | (unstated) | **The three suggestion engines are pluggable modules behind one interface** (§8.0) | Client instruction, 2026-08-30: updating one engine must not touch the rest of the codebase. They are also the parts most likely to be replaced once real pricing history exists. |

---

## 2. Scope — mapped to the Order Letter acceptance checklist

Only the dashboard-side items.

| Order Letter clause | Where |
|---|---|
| Dashboard imports, searches, filters and exports all scanned data | §5, §11.3, §9 |
| Original product photos remain accessible | §5.2, §11.3 |
| High-quality catalog images can be generated and reviewed | §11.3 (review + re-render request) |
| Price offers generated from similar products in Outfit data and the market | §8.1 — Outfit's own `user_decided_price` history **is** the market reference (client, 2026-08-30) |
| Similar/repeated items grouped under one Article Number, item identity preserved | §7 |
| Information copied efficiently to repeated/similar items | §7.3 |
| Duplicate / near-duplicate warnings | §7.4 |
| Each physical item individually identified and matched | §4 (`apparel_id` = barcode, primary key everywhere) |
| Missing or uncertain information identified and corrected | §5.3, §11.3 review queue |
| Duplicate/shared files not imported more than once | §5.1 (file digest ledger) |
| Extract … Pieces, package code, care information | §4 — columns exist and accept manual entry; automatic extraction deferred to a future release (client, 2026-08-30) |
| No critical data loss during import/export | §5.1 (transactional import; nothing overwritten without confirmation) |
| Database structure and architecture documentation delivered | This file + §13.4 |
| Outfit can maintain and further develop independently | §3.3 (no build step, no framework, dependency-light single process) |

---

## 3. Architecture

### 3.1 Processes on the VPS

```
                    nginx :443
                      │
        ┌─────────────┴──────────────┐
        │                            │
  /api/v1  /catalog            /dashboard
        │                            │
 apparel-middleware :3000     apparel-dashboard :3100
   (locked, unchanged)          (this project)
        │                            │
        │   writes                   │  reads + writes ui_commands,
        ├──────────► control.db ◄────┤  vision_settings_pending,
        │                            │  app_user_requests,
        │                            │  message_translations,
        │                            │  server_events.acknowledged_*
        │   writes             read  │
        ├──────► server_scans.db ────┤
        │                            │
        │   writes             read  │  (watermark + export only)
        └──────► flywheel.db ────────┤
                                     │  owns
                                     └──► dashboard.db
```

**The dashboard never calls the middleware over HTTP, and the middleware never calls the
dashboard.** Every exchange is a row in `control.db`. This is what "offline messaging" means
here: restart either process, or stop the middleware entirely, and the dashboard still browses,
edits and exports; queued commands are picked up whenever the middleware returns.

### 3.2 Databases

| File | Owner | Dashboard access | Notes |
|---|---|---|---|
| `dashboard.db` | dashboard | read/write | Items, users, prices, imports, audit. The only file the dashboard owns. |
| `control.db` | shared | read + **narrow** write | Writes limited to the five targets in `UI_messaging_protocol.md` §2. Nothing else, ever. |
| `server_scans.db` | middleware | read only *(opened rw — §1.11)* | Confidence scores, photo paths, `cloned_from`, `extraction_status`, `rendering_status`. |
| `flywheel.db` | middleware | read only | `SELECT MAX(rowid)` watermark + export rows. Never written. |

Every connection, without exception:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

### 3.3 Stack

```json
{
  "runtime": "Node.js 20 LTS (already on the VPS)",
  "language": "TypeScript, compiled with tsc — same toolchain as the middleware",
  "server": "Express 4",
  "views": "EJS server-side templates. No SPA, no bundler, no build step for the browser.",
  "browser_js": "Vanilla ES modules, served as-is. Progressive enhancement over working HTML forms.",
  "charts": "Hand-rolled inline SVG (~60 lines). No charting library.",
  "dependencies": {
    "better-sqlite3": "all four databases",
    "express": "http",
    "ejs": "templates",
    "fuse.js": "taxonomy snapping — already a middleware dependency",
    "csv-parse": "ledger import",
    "exceljs": "xlsx export only (write path); CSV needs nothing"
  },
  "explicitly_not_used": ["React", "PostgreSQL", "any AI SDK", "any native image library", "any CDN asset"],
  "rationale": "The client must be able to hand this to another developer. A server-rendered app with no build step is readable by anyone who knows HTML and SQL. Filtering and paging happen in SQL, which is where 10 users and 50k rows belong anyway."
}
```

No asset may be loaded from a CDN — the VPS and the warehouse may both be offline.

---

## 4. Canonical data model

`dashboard.db` → table `items`. `apparel_id` (the barcode) is the primary key and the join key to
everything the middleware holds.

**Three naming rules, applied without exception:**

1. Canonical storage is **English**. Armenian is never stored on the item row — it is joined at
   render time from the reference tables (§6).
2. Numeric `*_id` columns **are** stored, because they are what the client's own spreadsheets and
   customs paperwork carry. They are populated by lookup, never invented.
3. `field_src_json` records *where each value came from* (`AI`, `OPERATOR`, `LOOKUP`, `FUZZY:<s>`,
   `UNMATCHED`, `MANUAL`, `SUGGESTED`). Nothing in this system should present a value without
   being able to say where it came from.

```json
{
  "table": "items",
  "identity": {
    "apparel_id":      "TEXT PRIMARY KEY — barcode. CSV column 'Barcode'.",
    "cloned_from":     "TEXT NULL — parent barcode. From server_scans.db (CSV lacks it, §14.2).",
    "article_no":      "TEXT NULL — dashboard-assigned group key. Client invoice column 'group'.",
    "package_code":    "TEXT NULL — client invoice column 'package'.",
    "operator":        "TEXT NOT NULL — CSV 'Operator'.",
    "scanned_at":      "TEXT NOT NULL — ISO 8601, from CSV 'Timestamp'.",
    "export_batch":    "TEXT NULL — CSV 'ExportBatch'.",
    "import_id":       "INTEGER NULL — FK imports.id.",
    "source":          "TEXT NOT NULL — CSV | SCANS_DB | MANUAL."
  },
  "label_fields_english_canonical": {
    "brand":            "TEXT",  "brand_id":        "INTEGER NULL",
    "category":         "TEXT",  "category_id":     "INTEGER NULL",
    "sub_category":     "TEXT",  "sub_category_id": "INTEGER NULL",
    "gender":           "TEXT",  "gender_id":       "INTEGER NULL",
    "season":           "TEXT",  "season_id":       "INTEGER NULL",
    "color":            "TEXT",  "color_id":        "INTEGER NULL",
    "material":         "TEXT",  "material_id":     "INTEGER NULL",
    "country":          "TEXT",  "country_id":      "INTEGER NULL",
    "size":             "TEXT — no reference table exists (§14.4)",
    "original_price":   "TEXT — verbatim, e.g. '€79.90'",
    "original_price_value":    "REAL NULL — parsed",
    "original_price_currency": "TEXT NULL — parsed symbol or ISO code",
    "netto":            "TEXT — verbatim, e.g. '240g'",
    "brutto":           "TEXT",
    "netto_g":          "REAL NULL — normalised to grams",
    "brutto_g":         "REAL NULL",
    "pieces":           "INTEGER NOT NULL DEFAULT 1 — articles on the line (parent + clones)",
    "set_size":         "INTEGER NOT NULL DEFAULT 1 — garments inside one packaged article. CSV 'SetSize'.",
    "care_info":        "TEXT NULL — §14.1"
  },
  "provenance": {
    "field_src_json":   "TEXT — {\"brand\":\"AI\",\"color\":\"FUZZY:0.91\",\"size\":\"OPERATOR\"}",
    "confidence_json":  "TEXT NULL — the middleware's 12 confidences, from server_scans.raw_json_data",
    "min_confidence":   "REAL NULL — lowest of the twelve; drives the review queue"
  },
  "commercial_dashboard_only": {
    "user_decided_price":          "REAL NULL — the number that goes on the invoice",
    "user_decided_price_currency": "TEXT NULL",
    "suggested_price":             "REAL NULL",
    "suggested_price_basis":       "TEXT NULL — human-readable, e.g. 'median of 34 similar items'",
    "suggested_price_n":           "INTEGER NULL — sample size behind the suggestion",
    "suggested_netto_g":           "REAL NULL",
    "suggested_brutto_g":          "REAL NULL",
    "weight_suggestion_basis":     "TEXT NULL",
    "hs_code":                     "TEXT NULL — CN heading, 4 digits",
    "hs_code_src":                 "TEXT NULL — RULE | HISTORY | MANUAL",
    "hs_code_basis":               "TEXT NULL"
  },
  "media": {
    "catalog_image_url": "TEXT NULL",
    "key_photo_path":    "TEXT NULL",
    "image_paths_json":  "TEXT NULL",
    "rendering_status":  "TEXT NULL — mirrored from server_scans"
  },
  "workflow": {
    "review_state": "TEXT NOT NULL DEFAULT 'NEW' — NEW | NEEDS_REVIEW | REVIEWED | PARKED",
    "locked":       "INTEGER NOT NULL DEFAULT 0 — 1 blocks all edits and deletion",
    "dup_group_id": "TEXT NULL",
    "dup_reason":   "TEXT NULL",
    "notes":        "TEXT NULL",
    "deleted_at":   "INTEGER NULL — soft delete; nothing is ever hard-deleted",
    "created_at":   "INTEGER NOT NULL",
    "updated_at":   "INTEGER NOT NULL",
    "updated_by":   "TEXT NOT NULL"
  },
  "indexes": ["scanned_at", "operator", "article_no", "cloned_from", "review_state",
              "brand", "sub_category", "dup_group_id", "export_batch",
              "(sub_category, brand, gender, size, season, material, country)"]
}
```

### 4.1 Supporting tables

| Table | Purpose |
|---|---|
| `imports` | One row per uploaded file: `id, filename, sha256, uploaded_at, uploaded_by, rows_total, rows_inserted, rows_updated, rows_skipped, rows_flagged, status, report_json`. `sha256` is **UNIQUE** — this is what makes "the same file is never imported twice" true rather than aspirational. |
| `import_rows` | Per-row outcome for the last 10 days / 1 000 rows, so the import log is inspectable, not just a count. |
| `price_history` | `apparel_id, price, currency, set_at, set_by, basis`. Append-only. A price is never overwritten in place — an issued invoice must stay reconstructible. |
| `dash_users` | `id, username, display_name, password_hash, salt, role, status, locale, created_at, last_login_at, must_change_password`. Dashboard logins only. |
| `audit_log` | `id, at, actor, action, entity, entity_id, before_json, after_json`. Every write to `items`, every export, every command issued. |
| `settings` | Key/value: default locale, page size, currency, duplicate window, fuzzy threshold, price decay. |
| `article_groups` | `article_no, title, created_at, created_by, notes`. |

---

## 5. Ingestion

Two paths, reconciled on `apparel_id`. The CSV is the authority for values; `server_scans.db` is
the authority for everything the CSV cannot carry.

### 5.1 Path A — the daily CSV ledger (primary)

Input is exactly `Mobile_app/csv_export_format.txt`: RFC 4180, 18 columns.

```
Barcode, Brand, Category, SubCategory, Gender, Season, Size, Color,
Material, Country, OriginalPrice, Netto, Brutto, Timestamp, Operator, ExportBatch,
PackageCode, SetSize
```

`PackageCode` and `SetSize` are the CSV v2 additions agreed on 2026-09-04 (§14.1). Both are in
`V2_OPTIONAL`, so a v1 file with 16 columns still imports unchanged — `validateHeaders()`
requires only the v1 set and ignores extras.

Pipeline — the whole run is **one SQLite transaction**; any failure rolls back and the file is
not recorded as imported.

1. **Digest.** SHA-256 the uploaded bytes. If `imports.sha256` already exists → refuse with
   "this exact file was imported on *date* by *user*". Byte-level, so a renamed file is still
   caught. This is the order letter's "duplicate/shared files are not imported more than once".
2. **Parse and validate.** Header must match the 16 expected names. `Barcode` non-empty.
   Malformed rows are collected into the report, never silently dropped.
3. **Collision policy**, chosen *before* the run, not per row: `SKIP` (default),
   `UPDATE_EMPTY_ONLY`, `OVERWRITE`. `OVERWRITE` never touches `locked` rows, and never touches
   `user_decided_price`, `hs_code`, `article_no`, `package_code` or `notes` — those are
   dashboard-owned and an import must not destroy human work.
4. **Normalise.** Weights → grams (`240g`, `0.24kg`, `240` → `240`). Price → value + currency.
   `Timestamp` → ISO 8601. Empty strings stay empty; they never become `0`.
5. **Taxonomy resolution** (§6.2) → fills `*_id`, writes `field_src_json`.
6. **Enrich from `server_scans.db`** (§5.2).
7. **Duplicate scan** (§7.4).
8. **Suggestions** (§8) computed and stored, never auto-applied.
9. **Review state.** `NEEDS_REVIEW` if any of: a field is empty, any taxonomy field is
   `UNMATCHED`, `min_confidence < 0.70`, or `server_scans.extraction_status = 'PARKED'`.

**Armenian input is accepted.** The client's existing spreadsheets are Armenian, so the importer
reverse-maps Armenian values to English canonical before step 5 (§6.3). This lets the client load
historical `2nd package-invoice#166`-style data as pricing history on day one — which is what
makes §8.1 useful before the fleet has scanned anything.

### 5.2 Path B — enrichment from `server_scans.db`

Read-only join on `apparel_id`, supplying what the CSV cannot:

| From `server_scans` | Fills | Why it matters |
|---|---|---|
| `raw_json_data` → 12 × `confidence` | `confidence_json`, `min_confidence` | The CSV has no confidence column. Without this, "identify uncertain information" (order letter §3) has nothing to work from. |
| `cloned_from` | `cloned_from` | Required by every export preset and by §7. Absent from the CSV. |
| `key_photo_path`, `image_paths` | media columns | "Original product photos remain accessible." |
| `catalog_image_url`, `rendering_status` | media columns | Catalog review. |
| `extraction_status = 'PARKED'` | `review_state = 'PARKED'` | Closes the "parked scans have no review UI" gap recorded in `dev_report.md` §16.9. |

Runs on import, and again on a 5-minute timer for rows whose media or confidence is still null
(a scan may be extracted after the ledger was exported).

The dashboard and the middleware **always run on the same server** (client, 2026-08-30), and the
two are expected to be merged into one process later, so this path is the sanctioned mechanism
rather than a fallback. It is still written defensively: if `server_scans.db` is unreachable,
import succeeds anyway — every enriched column is nullable by design. The dashboard degrades; it
does not fail.

**Because a merge is planned, all four database handles are opened in one place**
(`src/db/`), and no service reaches for a file path of its own. Merging the two processes should
mean deleting `src/db/control.ts` and calling the middleware's own accessors — not a search across
the codebase.

### 5.3 What "uncertain" means in the UI

One amber chip on the row, whose tooltip names the actual reason: *empty field*, *unmatched
`SubCategory`: "trowsers"*, *low confidence 0.42 on `material`*, or *parked — needs
re-photographing*. Never a bare "needs review" with no cause.

---

## 6. Taxonomy and the bilingual layer

### 6.1 The lookup files

Loaded once at boot from `middle_ware/reference_data/` — single source of truth, shared with the
middleware, so text and ids cannot diverge. A missing file is a boot error, not a warning.

| File | Rows | English | Armenian | id | Header quirk to handle |
|---|---|---|---|---|---|
| `brand.csv` | 839 | ✅ | ❌ | ✅ | `Brand,Brand_id` |
| `sub-category.csv` | 295 | ✅ | ✅ | ✅ | `SubGroup_Armenian,Subcategory_id,SubGroup_English` |
| `country.csv` | 222 | ✅ | ❌ | ✅ | `Country_English,id` |
| `material.csv` | 85 | ✅ | ✅ | ✅ | trailing empty columns |
| `color.csv` | 26 | ✅ | ✅ | ✅ | `Color_armenian` (lowercase 'a') |
| `gender.csv` | 7 | ✅ | ✅ | ✅ | 4th column `Description` |
| `season.csv` | 5 | ✅ | ✅ | ✅ | column order differs from the others |
| *category* | 3 | ✅ | ✅ | ✅ | **new** `Dashboard/reference_data/category.csv` — see below |

All files are UTF-8 **with BOM** and have inconsistent header names. The loader must strip the
BOM, match headers case-insensitively on the substrings `armenian` / `english` / `id`, and ignore
trailing empty columns. Do not hand-code seven parsers.

**The dashboard reads these files but never writes them.** Since `UI_messaging_protocol.md` v1.4
the middleware is the sole writer, because it also serves them to the Android fleet and must
re-read them and reprogram its matcher in the same step. The dashboard *proposes* a change and
polls for the outcome — see [§6.4](#64-authoring-armenian-and-new-terms). One writer is what
makes "the same file, three consumers" safe.

`Dashboard/reference_data/category.csv`, `custom_codes.csv` and `hs_map.csv` are dashboard-owned
and stay hand-edited here; they are not part of that channel.

New in this project, both hand-editable CSV in `Dashboard/reference_data/`:

- **`custom_codes.csv`** — one-time extraction of `docs/client_data/custom_codes.xls`
  (951 rows: `ID, CN_Key, CN_Code, Name`). That file is SpreadsheetML XML, not a real `.xls`;
  extract it once with a throwaway script and commit the CSV. No spreadsheet parsing ships in the
  product.
- **`hs_map.csv`** — **hand-authored** rule matrix for §8.3:
  `sub_category_en, gender, material_class, netto_g_max, cn_code, note`. Empty at first release.
  Until it is filled, HS codes come from the history tier and from a searchable picker over the
  full `custom_codes.csv` — see §8.3. The client is narrowing the 951 headings to the required
  rows during the week of 2026-08-31; nothing in the code changes when they do.
- **`category.csv`** — `Category_Armenian, Category_id, Category_English` for the three values
  `clothing` / `shoe` / `accessories`. Armenian seeded from the middleware's
  `data/translations.csv` (`հագուստ` / `կոշիկ` / `պարագաներ`), ids 1–3 assigned by this project
  because no client table exists. **Flagged for client confirmation** — it is the one piece of
  Armenian in the system that Outfit did not supply.

### 6.2 Resolution — the only algorithm allowed to change a value

```
value ──► exact match (case-insensitive, trimmed) against the English column?
             ├─ yes ──► accept · id from table  · src = LOOKUP
             └─ no  ──► Fuse.js over the English column
                          ├─ similarity ≥ 0.85 ──► accept · id from table · src = FUZZY:<s>
                          └─ similarity < 0.85 ──► KEEP THE ORIGINAL TEXT
                                                   id = NULL · src = UNMATCHED
                                                   → row enters the review queue
```

Fuse config `{ includeScore: true, threshold: 0.35, ignoreLocation: true, minMatchCharLength: 2 }`.
Fuse scores are *distances* — 0 is perfect — so "similarity ≥ 0.85" means `1 - score >= 0.85`.
The threshold lives in `settings`, tunable without a release.

`size` and `original_price` are never snapped — there is no table, and a snapped price is a lie.

### 6.3 English ⇄ Armenian

**Rule, applied everywhere without exception: the application never translates. It looks up, or
it returns the English word.**

- Storage is English. Armenian is joined at render/export time on the numeric id — never on text.
- Missing Armenian → render the English word. Never blank, never machine-translated, never
  transliterated. `Unisex` and `All Seasons` already ship with English in the Armenian column;
  that is correct behaviour, not a bug to fix.
- **Brand and country are always written in English, including on paperwork** (client,
  2026-08-30). They render English under the AM toggle and export English in the Armenian presets,
  by design rather than by omission. No Armenian column will be added to `brand.csv` or
  `country.csv`.
- Reverse mapping (Armenian input → English canonical) uses the same tables in the other
  direction and follows the same rule: no match → keep the Armenian text verbatim, flag
  `UNMATCHED`.
- Free text — `size`, `notes`, `care_info`, brand names — is never translated in either direction.
- A term with no Armenian is not a bug to work around at render time; it is a **task for a
  supervisor** ([§6.4](#64-authoring-armenian-and-new-terms)). Render the English word today, and
  give someone a way to decide the Armenian once, for everyone.

**UI language toggle:** one `EN | AM` control in the header, a per-user preference stored in
`dash_users`, applied to *both* interface chrome and data values. It does **not** change what is
stored, and it does **not** decide export language — export language is chosen explicitly in the
export dialog, because an operator working in Armenian may still need an English customs file.

**Middleware message text** follows the protocol's own rule instead: `message_translations` for
locale `hy`, falling back to `message_dictionary.default_text` (§10.4). Same principle, different
table, because that one is owned by the messaging contract.

### 6.4 Authoring Armenian and new terms

New in v1.2, and the reason it exists: **the operators now work in Armenian on the handset.** The
Android app displays the Armenian label for every AI result and offers Armenian pickers for the
fields the operator chooses (`api_contract.md` v1.3 §4.6, §9). It gets those labels from the same
seven CSVs this dashboard reads, served by the middleware.

That makes the tables operational rather than static, and it puts two jobs here:

1. **A term the label vocabulary is missing.** An operator scans a garment outside the 295
   sub-categories. The middleware keeps the transcription verbatim, the row lands `UNMATCHED` in
   the review queue (§6.2), and a supervisor decides its canonical English and Armenian.
2. **A row with no Armenian.** Every bilingual table is fully translated today, but new rows
   arrive without one.

Both are the same submission.

#### The channel

Insert into `reference_data_requests` in `control.db`, poll until terminal, show `result_detail`
verbatim. Full column reference in `UI_messaging_protocol.md` §9.2.

```sql
INSERT INTO reference_data_requests
  (action, table_name, english, armenian, entry_id, submitted_at, submitted_by, status)
VALUES (:action, :table_name, :english, :armenian, NULL,
        unixepoch() * 1000, :actor, 'PENDING');
```

| Action | Use for |
|---|---|
| `SET_ARMENIAN` | An existing English key that needs its Armenian label filled in or corrected |
| `ADD_ENTRY` | A term that is genuinely not in the table yet. `entry_id` stays `NULL` — the middleware assigns the next id above the client's highest |

```
PENDING ──► APPLIED | REJECTED
```

On `APPLIED` the middleware rewrites the CSV, re-reads every table, rebuilds its matcher and
regenerates its AI prompt, and `reference_data_status.version` changes. Handsets pick the new
vocabulary up on their next `/health`. **Reload the dashboard's own table cache on `APPLIED`** —
otherwise this screen is the last place in the system still showing the old vocabulary.

#### Rules the UI must respect

- **Additive only. Never offer rename or delete.** The English key is the join: it is in every
  stored scan, every `*_id` lookup here, and every export already delivered. The middleware
  refuses anything else, but the UI should not offer what will be refused. Correcting an English
  spelling is a documented hand edit on the server plus `REFERENCE_DATA_RELOAD`.
- **`brand` and `country` have no Armenian column** and submissions for them are refused. Do not
  render an Armenian field for those two.
- **Latin text in an Armenian field is refused**, unless it repeats the English term exactly on a
  row that has no Armenian yet — which is how "this one stays English" is recorded, as `Unisex`
  and `All Seasons` already do. Say that in the field's helper text rather than letting the
  supervisor discover it through a rejection.
- **Show `result_detail` verbatim on rejection.** It names the reason.
- **A rejection changed nothing.** Say so, so nobody re-submits hoping it half-applied.

#### Where it appears

Two entry points, one flow:

- **Review queue / items grid (§11.3)** — an `UNMATCHED` taxonomy value gets an *Add to
  reference table* action, prefilled with the operator's text as the English key. This is the one
  that matters: it closes the loop from "an operator met a new garment" to "every handset knows
  the word", without an app release.
- **Server Settings 2 (§11.7)** — the reference-data card, for deliberate translation work.

#### Language of record, restated

Nothing about this changes what is stored. The CSV ledger, `items`, and every API value stay
**English** (`Mobile_app/csv_export_format.txt` §4). Armenian is joined for display and export,
here and on the handset. That is what keeps one garment type one string instead of five spellings
of it, and it is the whole reason the operator-facing Armenian is a lookup rather than a
translation.

---

## 7. Items, clones, groups and duplicates

Four distinct concepts. The seed plan conflated the last three; keeping them separate is what
makes both the invoice quantities and the audit trail correct.

### 7.1 Physical item
One `apparel_id` = one barcode = one physical garment. Always its own row. Never merged, never
hard-deleted. This is the order letter's "each physical item can be individually identified".

### 7.2 Clone (`cloned_from`) — device-level
Set by the Android app when an operator scans a second identical garment and copies the parent's
data; the middleware never calls the AI for it. Each clone is still a real, separate physical item
with its own barcode. **A clone is never dropped from a count.**

### 7.3 Article group (`article_no`) — dashboard-level
Operator-assigned in the dashboard, grouping similar items onto one invoice line. This is the
order letter's "grouped under one Article Number while preserving item-level identity".

- Assign from the grid: multi-select → *Group as article* → new or existing `article_no`.
- **Apply to group** — edit the group's representative row, then push chosen fields to every
  member: a field-by-field checklist, a preview of exactly what will change, and it skips
  `locked` rows. This is "information can be copied efficiently to repeated/similar items".
- Ungrouping restores the individual rows untouched — grouping is a label, not a merge.

**Invoice quantity, stated once and used by every export:**

```
Pieces for a line = SUM(items.pieces) over
      the article group           (if article_no is set)
      OR the parent + all clones  (if cloned_from chains exist)
      OR the single item
```

One line per group; clone and member rows are collapsed into it, never emitted separately and
never lost from the count.

`set_size` is **not** part of this sum and is never folded into `Pieces`. It counts garments
inside one packaged article; `Pieces` counts articles. A 2-pack scanned once and cloned twice is
`Pieces = 3`, `set_size = 2` — six garments, which this application deliberately never computes
for you (§14.1).

### 7.4 Duplicate warning — detection, not merging
On import and on demand:

- **Exact**: same `apparel_id` → the collision policy in §5.1.3.
- **Near**: identical `(brand, sub_category, size, color, material, country)` **and** weights
  within 5 % **and** scanned within the configured window (default 24 h) by any operator, where
  neither is a declared clone of the other.

Matches get a shared `dup_group_id` and a plain-language `dup_reason` (*"same brand, sub-category,
size, colour and material as 890123456789, scanned 4 minutes earlier"*). The dashboard **warns and
never merges** — deciding two garments are one is a human call with commercial consequences. A
"Duplicates" filter chip in the grid, plus *Mark as distinct* to dismiss a pair permanently.

Perceptual image hashing is a phase-2 addition that can only *add* candidates to this list.

---

## 8. Suggestion engines

Common rules, non-negotiable:

- **No AI call, ever.** All three are SQL over the dashboard's own history. AI belongs to the
  middleware.
- **English fields only** as inputs. Armenian is presentation, never a key.
- **A suggestion is never applied automatically.** It populates `suggested_*`, shown next to the
  editable field with a one-click *Accept*. The invoice number is `user_decided_price` and a human
  put it there.
- **Every suggestion carries its basis and its sample size.** A median over 3 items and a median
  over 300 must not look alike.

### 8.0 Modularity — how the engines are wired

Client instruction, 2026-08-30: *keep the AI functions completely modular — if we need to update
them, we don't have to change the whole code.* Enforced structurally, not by convention.

Each engine is one file under `src/suggest/`, exporting a default object that satisfies a single
interface. Nothing outside that folder knows how any engine works, and the folder's `index.ts` is
the only import path the rest of the app uses.

```json
{
  "interface": {
    "id": "price | weight | hs_code — stable key, used in settings and in suggested_* columns",
    "version": "string, bumped when the algorithm changes — stored on every suggestion it writes",
    "targets": "which item columns this engine fills, e.g. ['suggested_price']",
    "appliesTo": "(item) => boolean — cheap guard, e.g. weight only when both weights are null",
    "suggest": "(item, ctx) => { value, basis, n, confidence } | null"
  },
  "ctx_gives_the_engine": ["a read-only dashboard.db handle",
                           "the reference tables",
                           "the settings key/value store",
                           "a logger"],
  "rules": [
    "An engine may only read. It never writes an item row — the registry does that.",
    "An engine returning null is normal and means 'no opinion', never an error.",
    "Every non-null result carries basis + n; the registry refuses to store one without them.",
    "Engines are pure functions of (item, history). No network, no AI SDK, no filesystem.",
    "Adding an engine = adding one file and one line in the registry array.",
    "Removing one = deleting the file. Nothing else references it."
  ],
  "registry_responsibilities": ["ordering", "guarding with appliesTo", "timing/logging",
                                "writing suggested_* columns inside the caller's transaction",
                                "never overwriting a value a human has set"]
}
```

Engines run on import, on demand from the grid, and on a bulk *recompute suggestions* action.
Recompute is always safe: it touches only `suggested_*` columns and never `user_decided_price`,
`netto_g`, `brutto_g` or `hs_code` once those carry a human value.

If a genuine model-backed engine is ever wanted, it drops into the same folder behind the same
interface, and the "no AI in the dashboard" rule (override #5) becomes a one-file decision instead
of an architectural one.

### 8.1 Price

Candidate pool: rows with a non-empty `user_decided_price`, not soft-deleted.

Similarity tiers; the first tier reaching **n ≥ 5** wins:

| Tier | Match on |
|---|---|
| 1 | `sub_category, brand, gender, size, season, material, country` |
| 2 | `sub_category, brand, gender, season, material` |
| 3 | `sub_category, brand, gender` |
| 4 | `sub_category, gender` |

Then `suggested_price = median(user_decided_price) × age_factor`, where
`age_factor = max(0.60, 1 − 0.01 × months_since(scanned_at))` — 1 %/month decay, 40 % floor.
Median, not mean, so one mistyped price cannot move the number.

Shown beside it, never blended into it: the item's own `original_price_value` (the retail tag) and
the tier-1 min/max range. The user sees *"tag €79.90 · similar items sold €22–€38 · suggested €29"*.

Constants live in `settings`. The basis string is written out in full: *"median of 34 items
matching sub-category + brand + gender + season + material, −6 % for age"*.

**On "market data":** the order letter asks for offers based on Outfit's data *and the market*.
The client confirmed on 2026-08-30 that no market feed exists and that the accumulated
`user_decided_price` history **is** the market reference. That is exactly the pool above, so this
clause is satisfied by §8.1 as written — there is nothing further to integrate. The retail tag
price is shown beside the suggestion as context, never blended into it.

### 8.2 Weight

Fires only when `netto_g IS NULL AND brutto_g IS NULL`.

1. Median `netto_g` / `brutto_g` of items matching `brand, gender, size, season, material`, n ≥ 3.
2. Fall back to `sub_category, gender, size`, n ≥ 5.
3. Otherwise leave blank and flag `NEEDS_REVIEW`.

Never guessed, never zero-filled. A zero weight on a customs form is worse than an empty one.

### 8.3 HS code

1. **Rule** — `hs_map.csv` lookup on `sub_category` (+ `gender`, `material_class`, weight bound
   where the row specifies them). Most specific matching row wins → `hs_code_src = RULE`.
2. **History** — most common `hs_code` among items matching §8.2 tier 1, n ≥ 3 →
   `hs_code_src = HISTORY`.
3. Otherwise blank + flagged, and the user picks (see below).

**The nomenclature, and why the picker is not the same thing as a suggestion.**
`custom_codes.csv` carries **all 951 CN headings** converted from `docs/client_data/custom_codes.xls`
(client, 2026-08-30 — the list will be cut down to the required rows during the week of
2026-08-31; that is a data edit, and no code changes when it lands). The full list drives a
**searchable picker** in the grid: type "trousers", see matching headings with their codes, choose
one. That is a human selecting from a legal list, and it stamps `hs_code_src = MANUAL`.

The *engine* still never text-searches the nomenclature to produce a value automatically — a
free-text match across 951 headings will confidently return the wrong chapter, and an HS code on a
customs form is a legal declaration. Rule and history only. `custom_codes.csv` also supplies the
heading name displayed next to whatever code is set, from any source, so the value can always be
sanity-checked in words.

---

## 9. Exports

Common behaviour: date range **or** last *N* items; live row-count preview before writing;
language selected explicitly (EN/AM); every export writes an `audit_log` row recording filter,
language, row count and file name. Filenames `<preset>_<YYYYMMDD_HHmmss>.<ext>`.

CSV is UTF-8 **with BOM** (Excel needs it for Armenian). XLSX carries its own encoding — no BOM.
Clone and group collapsing per §7.3 applies to presets 1–3.

### Preset 1 — Seller Invoice
Reproduces the client's own `2nd package-invoice#166 (final).xlsx`, column for column:

```
No · ID code · Sub-category · Gender · Season · Netto · Brutto · Pieces · Brand ·
Country · Size · Original price · Color · Material · package · group · date
```

`ID code` = `apparel_id`; `package` = `package_code`; `group` = `article_no`; `date` =
`scanned_at` as `DD.MM.YYYY` (the format in the client's file). Armenian by default, because the
client's file is Armenian. `.xlsx` and `.csv`.

### Preset 2 — Customs Clearance
```
row · HSCode · category · sub-category · gender · season · netto · brutto · pieces ·
brand · country · size · tag price · color · material · scanned_date
```
`tag price` = `user_decided_price`, falling back to `original_price` only if explicitly ticked —
and the dialog says so. Refuses to run silently when any included row has an empty `hs_code` or
`user_decided_price`: it lists the offending barcodes and offers *export anyway*. `.csv`.

### Preset 3 — Inspection Sheet
Matches `Inspection-2026-156 (v05)`, Armenian headers:
```
Code · Sub-category · Սեռ · Բրուտտո քաշ · Նետտո քաշ · Քանակ հատ · Բրենդ · Ծագման երկիր · Ապրանքի մատերիալ
```

### Preset 4 — Full Data Export
Every column in §4, including `*_id`, provenance, confidences, suggestions and review state.
EN or AM. This is the handover/backup format and the one that proves "the dashboard exports all
scanned data". `.xlsx` and `.csv`.

### Preset 5 — Flywheel Training Export
Not an item export. See §10.5 — it has its own ordering rules and must never be run casually.

---

## 10. The middleware channel — `control.db`

Implements `UI_messaging_protocol.md` v1.3 exactly. That document is locked; where anything here
disagrees with it, it wins.

### 10.1 Non-negotiables
1. `journal_mode=WAL` + `busy_timeout=5000` on **every** connection.
2. Switch on `code`, never on displayed text.
3. Check the heartbeat **before** trusting `state`. `now − heartbeat_at > 90000` → unreachable,
   whatever `state` says. A dead middleware leaves `OK` behind.
4. Never write `resolved_at`. Only the middleware resolves.
5. Never read `app_users`; read `app_users_public`.
6. Never store, log or re-display an API key or password. Write once, forget.
7. `FLYWHEEL_DUMPED` always carries `exported_through_id`, captured **before** the export.
8. Stop polling at a terminal status.
9. `queue_pending > 0` is healthy throughput. Render it blue, never red.
10. Nothing is instant — commands take up to 15 s, status up to 30 s. Show timestamps, never "live".

The UI may write exactly five things: `ui_commands`, `vision_settings_pending`,
`app_user_requests`, `message_translations`, and `server_events.acknowledged_at/_by`.

### 10.2 Status banner
Evaluated in order, first match wins:

| # | Condition | Banner |
|---|---|---|
| 1 | `now − heartbeat_at > 90000` | 🔴 Server unreachable — last seen *hh:mm:ss* |
| 2 | `vision_state = 'PAUSED'` | 🔴 Processing paused — *fault text* + action button |
| 3 | `state = 'RETRYING'` | 🟡 Recovering automatically |
| 4 | `queue_parked > 0` | 🟡 *n* scans need review → links to the PARKED filter |
| 5 | `queue_pending > 0` | 🔵 *n* scans processing — draining |
| 6 | otherwise | 🟢 All systems normal |

Every pause banner carries, verbatim:

> Scanning continues normally. *n* scans are safely stored and will be processed automatically
> once this is resolved. Nothing is lost.

Queue trend (↑ ↓ →) from the last few client-side samples. Warn only on sustained growth.

### 10.3 Polling
`server_status` + `server_events` on page load and every 60 s. A command you issued: every 2 s
until terminal, then stop. Reads never block the middleware.

### 10.4 Alerts
The join from `UI_messaging_protocol.md` §4, with `locale = 'hy'` when the UI is in Armenian.
Coalesced — one open row per code; show `occurrences` when > 1. Acknowledging records that a human
saw it; it does not clear the fault. Acknowledged-but-open renders dimmed, not hidden. Action
buttons come from the code table in `server_setting_page.md` §3; **read `message_dictionary` at
runtime** so an upgrade that adds codes renders without a UI release.

### 10.5 Flywheel export — order matters
```
1. SELECT MAX(rowid) AS watermark FROM flywheel_training;   -- flywheel.db, FIRST
2. Export rows WHERE rowid <= :watermark                     -- then export
3. INSERT INTO ui_commands ('FLYWHEEL_DUMPED',
     json_object('exported_through_id', :watermark), …)      -- then purge that range
```
The UI must make step 3 impossible to reach without step 1. Samples captured during the export
survive to the next cycle. The screen states plainly: *the buffer holds copies of low-confidence
scans; operational records and photos are never affected*.

### 10.6 Commands
`VISION_ACCOUNT_REFRESH` · `VISION_SETTINGS_UPDATED` · `FLYWHEEL_DUMPED` · `DRAIN_QUEUE_NOW` ·
`REFERENCE_DATA_RELOAD` · `PING`. Lifecycle `PENDING → IN_PROGRESS → DONE | FAILED | REJECTED`.
`PENDING` means *not yet polled*, never *ignored*. Show `result_detail` verbatim.

### 10.7 Reference data
Two tables, both added in `UI_messaging_protocol.md` v1.4 and both covered by §6.4:

- **`reference_data_requests`** — dashboard → middleware. `SET_ARMENIAN` and `ADD_ENTRY` only.
  Poll to `APPLIED` / `REJECTED`, show `result_detail` verbatim, and reload this app's table cache
  on `APPLIED`.
- **`reference_data_status`** — middleware → dashboard, single row. `version` is the vocabulary
  fingerprint the fleet is being served; `counts_json` has per-table row and Armenian counts;
  `untranslated` is the supervisor's to-do count.

`REFERENCE_DATA_RELOAD` is for a CSV edited by hand on the server. It is not needed after an
`APPLIED` request — that already reloads.

---

## 11. Screens

Seven cards, one page each, one persistent header. Not a wall of widgets — a small number of
screens that each do one job.

### Header (every page)
Status banner (§10.2) · `EN | AM` toggle · current user · logout. The banner is the first thing
rendered and the first thing loaded.

### 11.1 Login
`admin` / `admin` on a fresh install, **forced password change on first login**. Session cookie
`httpOnly`, `sameSite=strict`, `secure`. Rate-limited. Soft cap of 10 active dashboard users,
enforced with a clear message rather than a silent failure.

### 11.2 Import
Drop a CSV → digest check → collision policy (`SKIP` / `UPDATE_EMPTY_ONLY` / `OVERWRITE`) →
**preview** of inserts / updates / skips / flags → confirm → transactional apply → report.
Below it, the import log: 10 days or 1 000 rows, scrolling, each row expandable to per-row outcomes.

### 11.3 Items grid — the main screen
Server-side paging, sorting and filtering; SQL does the work.

- **Filters**: date range, operator, brand, sub-category, gender, season, country, review state,
  has-price, has-HS-code, duplicates, article group, free text over barcode / brand / notes.
- **Columns**: user-selectable, persisted per user. Armenian values follow the header toggle.
- **Inline edit** of any non-derived field, with the suggestion shown alongside and a one-click
  *Accept*. Every edit writes `audit_log` and sets that field's `field_src_json` entry to `MANUAL`.
- **Row actions** (icon + tooltip + `aria-label`): 🔒 lock/unlock · 🗑️ soft delete · 🏷️ set price
  (writes `price_history`) · 🖼️ original photos · ✨ catalog image (view; request re-render when
  `rendering_status = FAILED`) · 👥 group / apply-to-group · ⚠️ duplicate detail.
- **Bulk**: set price, set package code, group as article, mark reviewed, export selection.
- **`UNMATCHED` taxonomy value** → *Add to reference table* (§6.4), prefilled with the operator's
  text as the English key and an empty Armenian field. This is the loop that turns one operator
  meeting a new garment into a word every handset knows. It does **not** change the row's stored
  value; accepting the row's text is a separate, explicit edit.
- **Locked rows** reject every edit path including import overwrite. That is the whole point of the
  lock — it is not a UI hint.

### 11.4 Analytics
Inline SVG, no library: scans per day (stacked by operator) · scans per operator · review-state
breakdown · price coverage (% priced) · HS-code coverage · top brands and sub-categories · import
volume. Every chart respects the active filters and links back into the grid. Built so a new chart
is one SQL query plus one template include.

### 11.5 Exports
Preset picker → range / last-N → language → live row-count preview → warnings (missing HS codes,
missing prices, unmatched taxonomy) → generate. Recent exports listed with their filters, so a file
can always be reproduced.

### 11.6 Server Settings 1 — Operations & Fleet
Tabs, from `server_setting_page.md` screens B, C, D:

- **Alerts & log** — open alerts + history, severity chips, acknowledge, per-code action buttons.
- **Vision credentials** — fingerprint `****3f9a`, models, validation status; the change form
  submits to `vision_settings_pending` and polls. `PENDING` after `VALIDATING` renders as
  *"Could not verify yet — retrying"*, **not** as an error. On `REJECTED`, say explicitly that the
  previous credentials are still active.
- **Operators** — `app_users_public` list; create / reset password / disable / enable / delete /
  rename via `app_user_requests`. Client-side validation mirrors the server
  (`^[A-Za-z0-9._-]{3,64}$`, password ≥ 8, no edge whitespace). Warning chip on the seeded test
  accounts `minelli` / `karen` / `ali`. Disable/Delete greyed out when one `ACTIVE` account
  remains, with the reason shown. Delete is worded *"blocks access immediately; scan history is
  kept"*.

### 11.7 Server Settings 2 — Training Data & Localisation
- **Flywheel** — occupancy bar, the watermark sequence as a guided three-step flow (§10.5), and the
  "operational records are never affected" reassurance.
- **Message translations** — grid of *code · category · severity · English · Armenian text ·
  Armenian hint*, untranslated codes first. Upserts `message_translations`. Resolution is always
  translation → `default_text`.
- **Reference data** — the loaded lookup tables with row counts, Armenian counts and file
  timestamps, plus the live `version` and `untranslated` count from `reference_data_status`, and a
  *reload* button issuing `REFERENCE_DATA_RELOAD`.

  Two **authoring** actions per §6.4, and no others:
  - *Add term* → `ADD_ENTRY`. English key required, Armenian optional.
  - *Set Armenian* → `SET_ARMENIAN`, on a row that has none or needs correcting.

  Default the list to **untranslated rows first** — that list is the supervisor's actual job, and
  its length is what stands between the operators and a fully Armenian screen. Brand and country
  are shown without an Armenian field at all.

  There is deliberately **no rename and no delete**. The English key is the join every stored scan
  and every delivered export depends on. Bulk correction stays a hand edit to the CSV on the
  server followed by a reload: slower, visible, and reviewable, which is the point.

  The files themselves remain hand-editable and diffable — that has not changed. What changed is
  that a supervisor no longer needs shell access to add one word.

---

## 12. Users, roles and security

| | Dashboard users (`dashboard.db`) | Operator accounts (middleware) |
|---|---|---|
| Who | Office staff using this web UI | Android devices in the warehouse |
| Store | `dash_users` | `app_users`, read via `app_users_public` |
| Managed by | Dashboard directly | `app_user_requests` — request and poll |
| Passwords | scrypt + per-user salt, ≥ 8 chars | Middleware hashes; the UI never sees them |

Roles: `admin` (everything, including settings and operator management) and `viewer` (read +
export, no edits, no settings). Two roles, because a third one nobody uses is a liability.

- No secret is ever rendered back to the browser — not an API key, not a hash, not a fingerprint
  beyond the last four characters the middleware itself publishes.
- All writes are parameterised statements. No string-built SQL anywhere.
- `helmet`, strict CSP with no external origins, CSRF token on every mutating form.
- Login rate-limited per IP and per username.
- The dashboard is reachable only behind the same TLS terminator as the middleware.
- File permissions are the real security boundary between the two processes
  (`UI_messaging_protocol.md` §11) — the setgid bit on the data directory is not optional.

---

## 13. Deployment and handover

### 13.1 Layout
```
/opt/apparel-dashboard/
  dist/            compiled JS
  views/           EJS
  public/          css, js, fonts — all vendored, nothing from a CDN
  reference_data/  custom_codes.csv, hs_map.csv, category.csv
  data/dashboard.db
  .env
```
Taxonomy tables are read from `/opt/apparel-middleware/reference_data/` — one copy, shared, so
they cannot drift.

### 13.2 Permissions — the part that usually breaks
Both processes need read **and** write on `control.db`, `server_scans.db`, `flywheel.db` **and
their `-wal` / `-shm` siblings**. SQLite writes shared memory even when only reading, so a
read-only account cannot read a WAL database at all.

```bash
sudo usermod -aG apparel-shared apparel-dashboard
sudo chmod 2770 /opt/apparel-middleware/data          # the leading 2 (setgid) is required
sudo chmod 660  /opt/apparel-middleware/data/*.db*
```

Without setgid, SQLite recreates `-wal`/`-shm` under the wrong group at the next checkpoint and
locks the other process out — **hours after a deploy that looked fine**.

### 13.3 Service
`systemd` unit `apparel-dashboard`, `Restart=always`, port 3100, nginx `location /dashboard`.
Environment: `DASHBOARD_PORT`, `MIDDLEWARE_DATA_DIR`, `REFERENCE_DATA_DIR`, `SESSION_SECRET`,
`DEFAULT_LOCALE`, `PAGE_SIZE`, `FUZZY_THRESHOLD`, `DUP_WINDOW_HOURS`.

### 13.4 Backup
`dashboard.db` nightly via `VACUUM INTO` (safe on a live WAL database), 30-day retention. That
file plus the reference CSVs is the entire dashboard state — the handover artefact the order
letter §4 asks for.

---

## 14. Open gaps — resolved and remaining

Five of the seven gaps in v1.0 were closed by the client on **2026-08-30**. They are kept here
with their answers, because knowing a question was asked and settled is worth more than a shorter
document.

### Closed

**14.1 `Pieces`, `package code`, `care information` — `package code` and sets now supplied by the app.** ✅
The order letter requires all three; `api_contract.md` v1.2 carries none of them, and that stays
true — see below. **Client: these lie for future expansion.** The dashboard keeps the three
columns, accepts manual entry and bulk edit, and exports them wherever the client's own layouts
have them (`Pieces` and `package` are both in the seller invoice).

**Update 2026-09-04 — `package code` is the "later" case, now live.** The Android app captures a
package code and writes it to the ledger as the 17th CSV column `PackageCode`
(`Mobile_app/csv_export_format.txt`). It is deliberately **CSV-only**: it is not sent to Gemini
(the model receives images and a fixed system instruction only) and `api_contract.md` is
**unchanged at v1.2** — the value never touches the middleware or `server_scans.db`. The importer
needs no change: `PackageCode` was already in `V2_OPTIONAL` and maps to `ledger_scans.package_code`.
`care information` remains deferred and manual-entry only.

**Update 2026-09-04 — sets arrive as `SetSize`, and `Pieces` stays what it was.** The client
needs articles sold as a set reported (a 2-pack of stockings, a 2-pack of undies). The operator
sets the count in the review dialog, **not** the AI: the packaging hides the second garment, so
a vision answer would be a confident guess. It travels as the 18th CSV column `SetSize` and is
CSV-only, exactly like `PackageCode` — `api_contract.md` stays at v1.2.

The two counts are deliberately separate and are never multiplied by this application:

| | Counts | Set by | Emitted by the app |
|---|---|---|---|
| `pieces` | Scanned **articles** on one invoice line — a parent plus its clones, or an article group | Dashboard, manual or by collapsing (§7.3) | No |
| `set_size` | Garments inside **one** packaged article | Operator, in the app's review dialog | Yes, `SetSize` |

A 2-pack is one article: `pieces = 1`, `set_size = 2`. **`Netto`/`Brutto` stay as read from the
label — the weight of the whole packet, undivided** (client, 2026-09-04). That keeps the app
honest: it reports what it saw and invents no arithmetic. It also means a reader wanting garment
counts or per-garment weights must do that division themselves, knowingly.

Wired this pass: `items.set_size` (with an `ensureColumns` upgrade for existing databases),
`SetSize` in `V2_OPTIONAL`, the importer mapping, grid/detail editing, and the `set_size` column
in preset 4. **Open, and deliberately not guessed:** presets 1–3 collapse clone families into one
line, so if the client wants set size on the invoice, the customs sheet or the inspection form,
someone must first say what it means for a collapsed line — the representative's value, or a sum.
Ask before adding the column.

> One consequence to watch: `package_code` is in `PROTECTED_ON_OVERWRITE`, so a value a person
> typed in the dashboard survives a re-import and the CSV will *not* overwrite it. That was the
> right rule while the column was manual-entry only. Now that the app is the source, decide
> whether to drop `package_code` from that list — it is protecting human work against what is
> now the authoritative value.

**14.2 CSV cannot carry `cloned_from` or confidence — no longer a risk.** ✅
**Client: the dashboard and middleware will always run on one server, and will be merged later.**
So Path B (§5.2) is the sanctioned source for both, not a host-dependent fallback. The importer
still accepts an extended CSV by header detection if one ever appears. The planned merge is why
all database handles live in `src/db/` and nowhere else.

**14.3 Armenian for brand, country and category.** ✅
**Client: brand and country are always written in English, even on the paperwork.** No Armenian
column will be added to either, and rendering them in English under the AM toggle is now
specified behaviour rather than a shortfall. Category is covered by a new
`Dashboard/reference_data/category.csv` seeded from the middleware's `translations.csv` (§6.1) —
the only Armenian in the system not supplied by Outfit, and flagged for their confirmation.

**14.5 `hs_map.csv`.** ✅ (partially, by design)
**Client: use all headings from `custom_codes.xls` for now; the list will be cut down to the
required rows this week. Convert it to CSV for the dashboard.** Done — the conversion is committed
as `Dashboard/reference_data/custom_codes.csv` (951 rows), the file drives the searchable picker,
and `hs_map.csv` ships empty for the client to fill. Narrowing the list is a data edit; no code
depends on its size. The rule tier of §8.3 stays dormant until the mapping exists; the history
tier and the picker work from day one.

**14.6 "Market data" pricing.** ✅
**Client: market data is non-existent; `user_decided_price` serves that purpose.** That is already
the candidate pool in §8.1, so the order-letter clause is satisfied as written and nothing further
needs integrating. Removed from the risk list.

**14.8 Operators must work in Armenian.** ✅ *(new, 2026-09-04)*
**Client: the operator has to read every AI result in Armenian and record their decision in
Armenian.** Resolved without translating anything. The middleware now serves the seven tables to
the Android app (`api_contract.md` v1.3 §4.6); the app displays the Armenian label and stores the
English key, exactly as this dashboard does. The AI is still never asked for Armenian, and the
CSV ledger is still English — which is what keeps one garment type one searchable string instead
of several spellings of it.

An audit of the five bilingual tables found **no missing Armenian cell**, so the "the table may
need more data" worry was really about *taxonomy* coverage: a label naming a garment outside the
295. That is handled by the existing `UNMATCHED` review path, now with a supervisor action that
writes the decision back (§6.4).

### Remaining

**14.4 No size reference table.**
`size` stays free text (`XL`, `32/34`, `40R`, `TU`, `LH`). Never snapped, never translated.
Grouping and price tier 1 treat it as an opaque string, so `XL` and `xl` do not match. A small
`size.csv` with aliases would tighten grouping. Low priority; not blocking.

**14.7 Catalog images render nightly at 20:00.**
A same-day scan has a valid `catalog_image_url` that 404s until the render runs
(`server_specification.json`). The grid renders this as *"scheduled for tonight"*, never as a
broken image — otherwise every operator reports a bug every afternoon. Handled in the UI; listed
here so nobody later "fixes" it.

---

## 15. Build order

| Phase | Delivers | Gate |
|---|---|---|
| **1 · Foundation** | Schema, reference-table loader, EN/AM resolver, login, header + status banner reading `control.db` | Banner shows correct state with the middleware stopped **and** running |
| **2 · Ingestion** | CSV import with digest guard, normalisation, taxonomy snapping, `server_scans` enrichment, import log | A real ledger imports twice: second time refused, no duplicates |
| **3 · Grid** | Items grid, filters, inline edit, lock, soft delete, photos, catalog review, audit log | Every §4 column visible and editable in both languages |
| **4 · Commercial** | Pieces, package, article groups, apply-to-group, duplicate detection, price history | Order-letter grouping and duplicate clauses demonstrable |
| **5 · Exports** | Presets 1–4, EN/AM, BOM handling, warnings | Output matches the client's own xlsx files column for column |
| **6 · Suggestions** | Price, weight, HS engines with basis strings | Every suggestion shows its sample size; none auto-applies |
| **7 · Server settings** | Cards 6 and 7 in full, including the flywheel watermark flow and the §6.4 authoring actions | Every rule in §10.1 verified against a live middleware; a term added here reaches a handset without an app release |
| **8 · Analytics & polish** | Charts, saved column sets, keyboard navigation | — |

Phase 2 depends on the middleware being deployed (Path B). Phase 6's HS **rule** tier stays
dormant until the client fills `hs_map.csv`; its history tier and the code picker work without it.
Nothing else has an external dependency.

---

## 16. Acceptance test — the ten things that must be true

1. Stop the middleware. The dashboard still loads, browses, edits and exports; the banner says
   *server unreachable*, not *OK*.
2. Import the same ledger file twice. The second is refused by digest, and no row is duplicated.
3. A row whose `SubCategory` reads `trowsers` keeps that text, shows `UNMATCHED`, and appears in
   the review queue. It is not silently changed to `Trousers`.
4. Toggle to AM. Colour, gender, season, material and sub-category render Armenian; brand, country
   and size render English. Nothing renders blank.
4b. Submit a new sub-category with its Armenian from the reference-data card. It comes back
   `APPLIED`, `reference_data_status.version` changes, the term appears in this app's pickers
   after the cache reload, and `GET /api/v1/reference-tables` on the middleware serves it — with
   no restart of either process. Then submit the same term again and get a readable `REJECTED`
   with the CSV unchanged.
5. Export preset 1 in Armenian. Columns match `2nd package-invoice#166 (final).xlsx` exactly, and
   Excel opens it with correct Armenian.
6. A parent with two clones exports as **one** line with `Pieces = 3`.
7. Two near-identical scans 4 minutes apart both survive, share a `dup_group_id`, and carry a
   readable reason. Neither is merged or deleted.
8. Lock a row, then run an import with `OVERWRITE`. The row is untouched and the report says so.
9. Submit a deliberately wrong API key. The UI shows `REJECTED` with `result_detail`, states that
   the previous credentials are still active, and the key never appears in any log.
10. Run the flywheel export. The watermark is captured before the export, `FLYWHEEL_DUMPED` carries
    `exported_through_id`, and samples created during the export survive.

---

*Supersedes `Dashboard/dashboard-plan.md`. Governed by
`docs/client_data/Outfit_Label_Reader_Order_Letter_FINAL.docx`, and constrained by the locked
contracts `middle_ware/api_contract.md` v1.3 and `middle_ware/UI_messaging_protocol.md` v1.4.*
