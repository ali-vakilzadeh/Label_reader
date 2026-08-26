# Apparel Vision Processing Middleware — Development Report

**Component:** Middleware bridge between the Android scanner fleet and the Gemini Vision API
**Location:** `/middle_ware`
**Stack:** Node.js 20 LTS · TypeScript 5.8 · Express 4.21 · better-sqlite3 11 · @google/genai 1.x
**Status:** Feature-complete against `api_contract.md` and `server_specification.json`. Build and typecheck clean; 57/57 automated checks pass; the vision path is verified against the live API with real sample photos.

---

## Table of contents

1. [What this service does](#1-what-this-service-does)
2. [Architecture](#2-architecture)
3. [Request lifecycle](#3-request-lifecycle)
4. [Business rules](#4-business-rules)
5. [The hidden training flywheel](#5-the-hidden-training-flywheel)
6. [Overnight rendering](#6-overnight-rendering)
7. [Bilingual Armenian export](#7-bilingual-armenian-export)
8. [API reference](#8-api-reference)
9. [Data model](#9-data-model)
10. [Security model](#10-security-model)
11. [Configuration reference](#11-configuration-reference)
12. [Installation and deployment](#12-installation-and-deployment)
13. [Operations runbook](#13-operations-runbook)
14. [Testing](#14-testing)
15. [Verification results](#15-verification-results)
16. [Known gaps and decisions needed](#16-known-gaps-and-decisions-needed)

---

## 1. What this service does

Ten Android scanner devices photograph apparel labels, scale displays and garments in a
warehouse. They never talk to Google directly. This middleware is the only component holding
the Gemini API key, and the only egress point to an external service.

For each scanned garment it:

1. authenticates the device and accepts up to 8 photos,
2. either **clones** an existing record (no AI call) or sends the photos to Gemini for
   structured extraction,
3. folds the returned scale readings into `netto` / `brutto`,
4. snaps free-text output onto the controlled vocabulary the ledger and customs export need,
5. returns a permanent catalog image URL **before** the image behind it exists,
6. silently copies low-confidence scans into a hidden training corpus,
7. and, at 20:00 each night, re-renders the key photo into a studio catalog shot at the URL
   already handed out.

All operator data stays on the VPS. Nothing leaves the machine except the Gemini vision and
image-render calls.

---

## 2. Architecture

### 2.1 Module layout

```
middle_ware/
├── src/
│   ├── index.ts                    process bootstrap, graceful shutdown
│   ├── app.ts                      Express assembly, middleware order, routing
│   ├── config/env.ts               environment parsing and validation
│   ├── types/index.ts              the locked field contract, shared interfaces
│   │
│   ├── db/
│   │   ├── operationalDb.ts        server_scans.db  — visible to clients
│   │   └── flywheelDb.ts           flywheel.db      — hidden training corpus
│   │
│   ├── middleware/
│   │   ├── auth.ts                 JWT issue/verify, constant-time compare
│   │   ├── upload.ts               Multer memory storage, MIME + size limits
│   │   ├── rateLimit.ts            per-IP budgets (global + tighter login)
│   │   └── errorHandler.ts         ApiError class, contract error envelope
│   │
│   ├── routes/
│   │   ├── health.routes.ts        GET /health
│   │   ├── auth.routes.ts          POST /api/v1/auth/login
│   │   ├── vision.routes.ts        POST /api/v1/vision/extract
│   │   └── flywheel.routes.ts      hidden /api/v1/flywheel/*
│   │
│   ├── services/
│   │   ├── geminiService.ts        sole egress to Google; schema, retry, fallback
│   │   ├── visionService.ts        orchestration: clone / extract / normalise / persist
│   │   ├── flywheelService.ts      confidence screening and capture
│   │   ├── renderService.ts        studio render batch
│   │   ├── cronService.ts          20:00 scheduler with overlap guard
│   │   ├── exportService.ts        Armenian legal output, bilingual CSV
│   │   └── storageService.ts       image persistence, deterministic catalog URLs
│   │
│   ├── utils/
│   │   ├── fuzzyMatcher.ts         three-tier taxonomy snapping (Fuse.js)
│   │   ├── weights.ts             scale-reading rules, unit normalisation
│   │   └── logger.ts               levelled structured logging
│   │
│   └── data/taxonomy/
│       ├── subCategories.json      garment types + aliases
│       ├── enums.json              category / color / gender / season + aliases
│       └── countries.json          280 ISO regions
│
├── scripts/
│   ├── convertTranslations.ts      offline: translations.csv -> legalArmenianMap.json
│   └── runRenderJob.ts             manual render batch trigger
│
├── tests/
│   ├── smoke.ts                    57 offline checks, no API key needed
│   ├── liveExtract.ts              real Gemini call against real photos
│   └── cronCheck.ts                cron wiring + render failure handling
│
├── data/                           SQLite files, translations.csv (gitignored DBs)
├── public/catalog/                 rendered studio shots, served statically
└── uploads/<apparel_id>/           operator photos as received
```

**Total:** 3,253 lines of TypeScript across 32 files.

### 2.2 Layering rule

Routes never touch a database or the Gemini SDK directly. The dependency direction is strictly
one-way:

```
routes  ->  services  ->  db / utils / SDK
```

`visionService` is the only module that composes the others into a workflow. This is why the
cloning path, the extraction path, and the flywheel screening can each be tested in isolation —
and why `tests/smoke.ts` can exercise the full normalisation pipeline without any network.

### 2.3 Middleware order in `app.ts`

Order is deliberate; changing it changes behaviour.

| # | Middleware | Why it sits here |
| --- | --- | --- |
| 1 | `trust proxy = 1` | Behind Caddy/nginx, so rate limiting sees real client IPs, not the proxy's |
| 2 | `helmet` | Security headers on every response, including errors |
| 3 | `cors` | Allowlist from `CORS_ORIGIN`; permits the `x-flywheel-key` header |
| 4 | `express.json` / `urlencoded` | 1 MB cap — JSON bodies here are small; photos come through Multer |
| 5 | `/health` router | **Before** the rate limiter: devices poll it on startup and must never be throttled |
| 6 | `/catalog` static | Serves rendered shots straight off disk |
| 7 | `apiRateLimiter` on `/api/v1` | 60 req/min per IP |
| 8 | route handlers | auth → vision → flywheel |
| 9 | `notFoundHandler` | Contract-shaped 404 |
| 10 | `errorHandler` | Converts every thrown error into the contract envelope |

---

## 3. Request lifecycle

### 3.1 Authentication

```
POST /api/v1/auth/login  { username, password }
   │
   ├─ loginRateLimiter          10 attempts/min per IP (RATE_LIMIT_MAX / 6, floor 5)
   ├─ validate both fields present and non-empty
   ├─ timingSafeEqual(password, APP_MASTER_PASSWORD)
   │     └─ constant-time; wrong-length input still burns a full comparison
   └─ jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' })

   200  { status: "success", token, expires_in: "30d" }
   401  { status: "error", error_code: "INVALID_CREDENTIALS", message }
```

The JWT carries only `username`. There is no refresh token: the 30-day expiry matches the
device-provisioning cycle, and `TOKEN_EXPIRED` is returned as a distinct error code so the app
can prompt for re-login rather than showing a generic failure.

### 3.2 Extraction — the main pipeline

```
POST /api/v1/vision/extract   (multipart/form-data, Bearer token)
   │
   ├─ requireAuth ─────────────► 401 UNAUTHORIZED / INVALID_TOKEN / TOKEN_EXPIRED
   ├─ uploadImages (Multer) ───► 400 INVALID_IMAGE_PAYLOAD  (bad MIME, >8 files, >12 MB)
   ├─ validate apparel_id, username, key_photo_index
   │
   ├── cloned_from present? ───────────────────────────────────┐
   │                                                            │
   │   CLONE PATH (Gemini never called)                         │
   │     getScan(parent)                                        │
   │       ├─ missing  ──► 404 PARENT_NOT_FOUND                 │
   │       └─ corrupt  ──► 500 PARENT_RECORD_CORRUPT            │
   │     JSON.parse(parent.raw_json_data)                       │
   │     upsertScan(child, inheriting parent's image paths)     │
   │     return immediately                                     │
   │                                                            │
   └── otherwise ── EXTRACTION PATH ───────────────────────────┤
         persistImages()      uploads/<apparel_id>/IMG_<id>_<n>.jpg
         buildCatalogUrl()    computed synchronously, returned now
         extractApparelData() Gemini call, retry ×3 + optional fallback
              ├─ non-retryable ──► 502 VISION_EXTRACTION_FAILED
              └─ no API key    ──► 503 VISION_UNAVAILABLE
         normalizeExtraction()
              ├─ resolveWeights()   weights[] -> netto / brutto
              ├─ fuzzy snapping     free text -> canonical enum keys
              └─ clampConfidence()  every score forced into [0,1]
         upsertScan()          rendering_status = PENDING
         interceptLowConfidence()   best-effort, never throws
                                                                │
   200  { status, apparel_id, cloned_from, timestamp,           │
          catalog_image_url, data: { 12 fields } }  ◄───────────┘
```

Two properties worth calling out:

- **The catalog URL is returned before the image exists.** `buildCatalogUrl()` is pure string
  construction from `SERVER_HOST` and `apparel_id`. The client and any CSV export receive a
  permanent URL in the same response as the extracted fields; the nightly job later writes the
  file at exactly that path. Nothing ever waits on image generation.
- **Flywheel capture cannot fail a scan.** `interceptLowConfidence()` wraps its entire body in
  try/catch and returns a boolean. A disk-full or locked-DB condition in the hidden training
  path is logged and swallowed — the operator's response is already assembled.

---

## 4. Business rules

### 4.1 Weight resolution (`src/utils/weights.ts`)

Gemini returns every scale reading it can see in a `weights` array. The contract rule is
min/max, but readings arrive in mixed units, so comparison happens on normalised grams while the
operator-facing string is preserved verbatim — the ledger and CSV expect `"240g"`, not `240`.

| Readings | `netto` | `brutto` |
| --- | --- | --- |
| 0 | `""` @ `0.0` | `""` @ `0.0` |
| 1 | the value | the same value |
| 2+ | lightest | heaviest |

`toGrams()` understands `g, gr, gm, gram(s), kg, kilo(gram(s)), mg, lb(s), pound(s), oz,
ounce(s)`, accepts comma decimals (`1,24 kg`), and treats a bare number as grams by warehouse
convention. An unparseable reading sorts last rather than corrupting the ordering.

Three or more readings (a mis-fired extra capture) collapse into the same min/max rule rather
than erroring.

### 4.2 Fuzzy normalisation (`src/utils/fuzzyMatcher.ts`)

Gemini emits `"Trousers"`, `"Made in Viet Nam"`, `"Charcoal Grey"`. The daily ledger and the
Armenian legal export both need exact enum keys. Six fields are snapped: `sub_category`,
`country_of_origin`, `category`, `color`, `gender`, `season`.

Each `FuzzyIndex` is built once at module load and resolves through three tiers:

```
input ──► normalise()  lowercase, NFKD, strip diacritics, collapse punctuation
   │
   ├─ 1. exact map        "pants" -> pants                        O(1)
   │      └─ retry after stripping "made in|product of|
   │         manufactured in|origin|assembled in|fabrique en|made by"
   ├─ 2. compact map      "viet nam" -> "vietnam" -> Vietnam       O(1)
   └─ 3. Fuse.js search   "sunglases" -> sunglasses               threshold 0.4
              │
              └─ no hit ──► return null, caller keeps the raw text
```

A bounded memo cache (5,000 entries, oldest-out) fronts all three tiers. Warehouse vocabulary
repeats heavily within a shift, so in practice almost every lookup is a cache hit.

**Measured latency** (Node 20, this hardware):

| Path | Per lookup |
| --- | --- |
| Cached repeat | 0.0009 ms |
| Cold miss, 14-entry sub-category index | 0.23 ms |
| Cold miss, 280-entry country index | 1.37 ms |

Worst case is unmatchable garbage against the largest index, and still lands inside the 2 ms
budget.

**Design rule: nothing is invented.** When no tier clears the threshold, `matchOrKeep()` returns
the original text with `matched: false` and the confidence score untouched. A wrong enum key is
worse than an un-normalised one, because downstream code trusts keys.

**The taxonomies are data, not code.** `subCategories.json` holds `{ key, aliases[] }` entries.
Growing the list from 14 to 253 entries is a change to that file alone.

### 4.3 Cloning

When the operator duplicates a garment, `cloned_from` carries the parent barcode. The server
reads the parent's stored extraction from `server_scans.db`, rebinds it under the new
`apparel_id`, and returns — no Gemini call, no image upload required.

The child **inherits the parent's `key_photo_path` and `image_paths`** rather than copying
bytes. One physical photo set backs both records, which is correct for cloned stock and keeps
disk growth linear in scans rather than in records.

### 4.4 Prompt and matcher coupling

The allowed-value lists in the Gemini system instruction and response schema are **generated
from the same taxonomy files the matcher indexes**, via `TAXONOMY_KEYS` exported from
`fuzzyMatcher.ts`:

```
src/data/taxonomy/*.json
        │
        ├──► FuzzyIndex          normalisation (what the server accepts)
        └──► TAXONOMY_KEYS ──► SYSTEM_INSTRUCTION + EXTRACTION_SCHEMA
                                 (what the model is told to produce)
```

Without this, the two halves drift: the prompt would keep offering 14 sub-categories while the
matcher snapped against 253, and the model could never produce most of the vocabulary. Two smoke
checks assert that every taxonomy key appears in both the instruction and the schema, so the
drift cannot silently reappear.

---

## 5. The hidden training flywheel

### 5.1 Purpose and isolation

`flywheel.db` is a **physically separate SQLite file**. This is the isolation mechanism: no
dashboard query, ORM relation, or accidental `JOIN` can reach training data from the operational
database, because they are not the same database. `flywheelDb.ts` is imported only by
`flywheelService.ts`, `renderService.ts` and the hidden routes.

### 5.2 Capture rule

After normalisation, `screenConfidence()` walks all 12 fields and finds the weakest:

```ts
if (lowest < FLYWHEEL_CONFIDENCE_THRESHOLD)   // default 0.85
    -> capture the whole scan
```

The trigger is **any** field below threshold, not an average. One bad field means the sample is
instructive, and the training set wants the full picture — every image, the complete prediction,
and eventually the corrected answer.

What gets stored:

```jsonc
{
  "normalized":    { /* the payload exactly as the device received it */ },
  "gemini_raw":    { /* pre-normalisation output, incl. the raw weights array */ },
  "lowest_field":  "gender",
  "threshold":     0.85
}
```

Keeping both the raw and normalised forms lets a future training run distinguish *model* errors
from *normalisation* errors — a distinction that is impossible to recover later if only one form
is stored.

### 5.3 FIFO ring buffer

Capacity is capped at `FLYWHEEL_MAX_RECORDS` (default 10,000). Enforcement happens **inside the
insert transaction**:

```ts
export const insertFlywheelRecord = flywheelDb.transaction((input) => {
  insertStmt.run({ ... });
  enforceRingBuffer();          // same transaction
});
```

`enforceRingBuffer()` computes `total - max` and deletes that many oldest rows in a single
statement, ordered by `created_at ASC`. Deleting the computed overflow rather than exactly one
row means a burst of concurrent inserts cannot leave the buffer above its ceiling, and the
transaction boundary means a reader never observes an over-capacity state.

### 5.4 Record lifecycle

A training row fills in over three stages:

| Stage | Trigger | Columns written |
| --- | --- | --- |
| Capture | low-confidence extraction | `key_photo_path`, `raw_images_paths`, `unconfirmed_gemini_json`, `lowest_confidence_score`, `created_at` |
| Ground truth | `PUT /api/v1/flywheel/confirm/:apparel_id` | `confirmed_json`, `confirmed_at` |
| Studio shot | nightly render job | `catalog_render_path` |

A fully-populated row therefore contains *raw photos → what the model guessed → what a human
confirmed → the finished catalog image*: a complete supervised training example.

### 5.5 Ground-truth binding

`PUT /api/v1/flywheel/confirm/:apparel_id` accepts either shape:

```jsonc
{ "data": { "gender": "female" } }                              // flat correction
{ "data": { "gender": { "value": "female", "confidence": 1 } } } // full shape
```

A bare string is recorded at confidence `1.0` — confirmed data is ground truth by definition.
The handler writes to **both** databases: `confirmed_json` in `flywheel.db`, and
`raw_json_data` in `server_scans.db`, so the operational ledger reflects the human correction
and the two stores cannot drift.

---

## 6. Overnight rendering

### 6.1 Scheduling

`node-cron` fires on `RENDER_CRON_SCHEDULE` (default `0 20 * * *`) in `RENDER_CRON_TIMEZONE`
(default `Asia/Yerevan`). The schedule string is validated with `cron.validate()` at startup; an
invalid expression logs an error and leaves the cron unstarted rather than crashing the server.

A module-level `running` flag guards against a long batch overlapping the next trigger — a
second tick while one is in flight logs a warning and returns.

### 6.2 The render batch

```
runRenderJob(batchSize = RENDER_BATCH_SIZE)
   │
   getPendingRenders()      key_photo_path IS NOT NULL
                            AND (status = 'PENDING'
                                 OR (status = 'FAILED' AND render_attempts < RENDER_MAX_ATTEMPTS))
                            ORDER BY created_at ASC
   │
   for each record  (sequential, to respect image-model rate limits)
       readImageAsInline(key_photo_path)
            └─ missing on disk ──► status FAILED, attempt counted
       renderStudioImage(image, STUDIO_PROMPT)     retry ×3 + optional fallback
            └─ no image part returned ──► status FAILED
       writeCatalogImage()  ──► public/catalog/IMG_<apparel_id>.jpg
       setRenderingStatus(COMPLETED)
       attachRenderPath()   ──► syncs catalog_render_path into flywheel.db if sampled
```

Records are processed **sequentially**, not in parallel: image generation is the most
rate-limited and most expensive call in the system, and a warehouse's nightly backlog is not
latency-sensitive. One failure never stops the batch — each iteration is independently
try/caught.

### 6.3 Failure handling and self-healing

| Condition | Status | Retried? |
| --- | --- | --- |
| No `key_photo_path` on the record | `SKIPPED` | No — nothing would change |
| Key photo missing from disk | `FAILED` | Yes, until `RENDER_MAX_ATTEMPTS` |
| Model returned no image part | `FAILED` | Yes, until `RENDER_MAX_ATTEMPTS` |
| Transient 429/5xx | retried in-call | Then `FAILED`, retried on later nights |
| Success | `COMPLETED` | — |

Because the queue includes `FAILED` rows with attempts remaining, a Gemini outage on one night
is picked up automatically the next night. A re-scan of the same `apparel_id` resets
`render_attempts` to 0 and `render_error` to NULL: new photos supersede the old ones and deserve
a fresh budget.

### 6.4 The studio prompt

`STUDIO_PROMPT` in `renderService.ts` instructs a clean e-commerce shot on seamless white with
soft lighting, and explicitly forbids restyling, recolouring, or adding/removing elements —
the output must remain a faithful record of the physical garment, because it becomes the catalog
image for a real inventory item.

Run the batch on demand with `npm run render:now`.

---

## 7. Bilingual Armenian export

### 7.1 Offline conversion

`scripts/convertTranslations.ts` is a build step, never part of the request path:

```
data/translations.csv  ──►  data/legalArmenianMap.json
   columns: english, armenian, [domain]        { "english term": "Armenian text" }
```

The converter auto-detects column names (`english|en|term|source` and
`armenian|hy|legal_armenian|target`), strips a UTF-8 BOM from the first header, skips incomplete
rows, reports conflicting duplicates, and emits keys sorted alphabetically so the generated file
produces clean diffs in git.

### 7.2 Lookup and material handling

`exportService.ts` loads the map once and caches it. Seven fields are translatable;
`size`, `original_price`, `brand_name`, `netto` and `brutto` are legally reproduced as-is.

`material` needs special handling, because it arrives as a composition string that would never
match a dictionary key. `translateMaterial()` splits on separators **and before each `NN%`
token**, translating each fibre while preserving its percentage:

```
"38% Cotton 27% Wool 20% Polyamide 15% Polyester"
   -> "38% բամբակ, 27% բուրդ, 20% պոլիամիդ, 15% պոլիեսթեր"

"60% Cotton 40% Unobtainium"
   -> "60% բամբակ, 40% Unobtainium"      missing: ["Unobtainium"]
```

**Lookup is strict by design.** An unmapped term is passed through in English and reported in
`missing_translations` — never guessed. A wrong Armenian legal term on a customs declaration is
a compliance problem; a flagged gap is a work item.

`toBilingualCsv()` emits `<field>` and `<field>_hy` column pairs with a UTF-8 BOM so Excel opens
the Armenian script in the right encoding, and CRLF line endings for Windows tooling.

---

## 8. API reference

Base path `/api/v1`. All errors use `{ status: "error", error_code, message }`.

### `GET /health` — no auth

```json
{ "status": "ok", "uptime_seconds": 142050, "version": "1.0.0", "gemini_ready": true }
```

Deliberately outside the rate limiter; the Android app polls it on startup.

### `POST /api/v1/auth/login` — no auth

Request `{ "password": "...", "username": "emp_402" }` →
`{ "status": "success", "token": "...", "expires_in": "30d" }`

### `POST /api/v1/vision/extract` — Bearer

`multipart/form-data`:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `apparel_id` | string | yes | Scanned barcode |
| `username` | string | yes | Falls back to the JWT's username if absent |
| `key_photo_index` | integer | yes | 0–7; out-of-range falls back to 0 rather than failing the scan |
| `cloned_from` | string | no | Parent barcode; bypasses Gemini entirely |
| `images` | file[] | conditional | ≤8 JPEG/PNG/WebP; required unless `cloned_from` is set |

Response is the contract payload: `status`, `apparel_id`, `cloned_from`, `timestamp`,
`catalog_image_url`, and `data` with all 12 fields as `{ value, confidence }`.

### Hidden: `/api/v1/flywheel/*` — Bearer + `x-flywheel-key`

| Method | Path | Purpose |
| --- | --- | --- |
| `PUT` | `/confirm/:apparel_id` | Bind operator-verified ground truth |
| `GET` | `/stats` | Buffer occupancy, capacity, threshold |
| `GET` | `/sample/:apparel_id` | Inspect one stored sample |

Not published in the API contract. When `FLYWHEEL_ADMIN_KEY` is set and the header is missing or
wrong, these routes return **404**, not 401 — a 401 would confirm the endpoint exists.

### `GET /catalog/IMG_<apparel_id>.jpg` — no auth

Static rendered shots, `Cache-Control: max-age=3600`.

### Error codes

| Code | HTTP | Raised when |
| --- | --- | --- |
| `INVALID_CREDENTIALS` | 400 / 401 | Missing field, or wrong password |
| `UNAUTHORIZED` | 401 | Missing or malformed `Authorization` header |
| `INVALID_TOKEN` | 401 | Signature verification failed |
| `TOKEN_EXPIRED` | 401 | JWT past its 30-day expiry |
| `MISSING_APPAREL_ID` | 400 | `apparel_id` absent |
| `MISSING_USERNAME` | 400 | No `username` in form or token |
| `INVALID_IMAGE_PAYLOAD` | 400 | No images and no `cloned_from`; or bad MIME / too many / too large |
| `INVALID_PAYLOAD` | 400 | Confirm body contained no recognised fields |
| `PARENT_NOT_FOUND` | 404 | `cloned_from` names an unknown record |
| `PARENT_RECORD_CORRUPT` | 500 | Parent's stored JSON failed to parse |
| `SAMPLE_NOT_FOUND` | 404 | No training sample for that `apparel_id` |
| `NOT_FOUND` | 404 | Unknown route, or hidden route without its key |
| `CONFIRM_FAILED` | 500 | Ground-truth write did not persist |
| `VISION_UNAVAILABLE` | 503 | `GEMINI_API_KEY` not configured |
| `VISION_EXTRACTION_FAILED` | 502 | Gemini failed after all retries |
| `RATE_LIMITED` | 429 | Per-IP budget exceeded |
| `INTERNAL_ERROR` | 500 | Unhandled fault |

---

## 9. Data model

### 9.1 `data/server_scans.db` — operational

```sql
CREATE TABLE server_scans (
  apparel_id        TEXT PRIMARY KEY,
  cloned_from       TEXT,
  username          TEXT NOT NULL,
  timestamp         TEXT NOT NULL,          -- ISO 8601
  raw_json_data     TEXT NOT NULL,          -- the 12-field payload
  key_photo_path    TEXT,
  image_paths       TEXT,                   -- JSON array
  catalog_image_url TEXT NOT NULL,
  rendering_status  TEXT NOT NULL DEFAULT 'PENDING',
  render_attempts   INTEGER NOT NULL DEFAULT 0,
  render_error      TEXT,
  created_at        INTEGER NOT NULL,       -- epoch ms
  updated_at        INTEGER NOT NULL
);
```

Indexes on `rendering_status`, `created_at`, `username`, `cloned_from`.
`rendering_status` ∈ `PENDING | COMPLETED | FAILED | SKIPPED`.

### 9.2 `data/flywheel.db` — hidden

```sql
CREATE TABLE flywheel_training (
  apparel_id              TEXT PRIMARY KEY,
  key_photo_path          TEXT,
  raw_images_paths        TEXT,             -- JSON array
  unconfirmed_gemini_json TEXT NOT NULL,    -- normalised + raw + threshold metadata
  confirmed_json          TEXT,             -- NULL until an operator confirms
  catalog_render_path     TEXT,             -- NULL until rendered
  lowest_confidence_score REAL NOT NULL,
  created_at              INTEGER NOT NULL,
  confirmed_at            INTEGER
);
```

Indexes on `created_at` (drives FIFO eviction) and `confirmed_at`.

### 9.3 SQLite configuration

Both databases run `journal_mode = WAL` so readers never block the writer — important with 10
devices scanning while a dashboard reads. `busy_timeout = 5000` absorbs brief write contention
instead of surfacing `SQLITE_BUSY` to an operator. All statements are prepared once at module
load and reused.

### 9.4 Filesystem layout

```
uploads/<apparel_id>/IMG_<apparel_id>_<n>.<ext>   operator photos as received
public/catalog/IMG_<apparel_id>.jpg               rendered studio shot
data/server_scans.db, data/flywheel.db            SQLite (+ -wal, -shm)
data/translations.csv                             source vocabulary
data/legalArmenianMap.json                        generated lookup
```

`sanitizeId()` strips everything outside `[A-Za-z0-9._-]` from a barcode before it is used in a
path, so a malformed scan cannot traverse directories.

---

## 10. Security model

| Control | Implementation |
| --- | --- |
| API key isolation | `GEMINI_API_KEY` read only in `geminiService.ts`; never serialised into a response |
| Transport | HTTPS terminated at the reverse proxy; HSTS via Helmet |
| Device auth | JWT Bearer on every `/api/v1` route except login; 30-day expiry |
| Password comparison | `timingSafeEqual()` — constant time, and wrong-length inputs still burn a full comparison |
| Brute force | Login limited to `RATE_LIMIT_MAX / 6` per minute (floor 5), separate from the global budget |
| General rate limit | 60 req/min per IP, `draft-7` standard headers |
| Proxy awareness | `trust proxy = 1`, so limits key on the real client IP |
| Headers | Helmet defaults; `x-powered-by` disabled; catalog images marked cross-origin |
| CORS | Allowlist from `CORS_ORIGIN`; only `Content-Type`, `Authorization`, `x-flywheel-key` |
| Upload safety | MIME allowlist, ≤8 files, ≤12 MB each, memory storage |
| Path safety | `sanitizeId()` on every barcode used in a filesystem path |
| Hidden routes | 404 (not 401) when `FLYWHEEL_ADMIN_KEY` is set and the header is absent |
| Body size | JSON/urlencoded capped at 1 MB |
| Secrets in git | `.env`, `*.db`, `uploads/`, and the generated map are all gitignored |

### GDPR posture

Operator photos and extracted records never leave the VPS. The only outbound traffic is the
Gemini vision call and the nightly render call. `uploads/` and both databases are local files
under the operator's control; deleting a record is a local filesystem and SQLite operation with
no third-party coordination required. The flywheel's 10,000-record ceiling bounds how long any
low-confidence sample is retained.

---

## 11. Configuration reference

All values are read once at startup by `src/config/env.ts`. Missing **required** variables throw
before the server binds a port — the process fails loudly rather than serving in a broken state.
Relative directory paths resolve against the package root, and each is created with `mkdir -p`
semantics on boot.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Standard |
| `PORT` | `3000` | Listen port (behind the proxy) |
| `SERVER_HOST` | `localhost:3000` | **Host used in generated catalog URLs** |
| `PUBLIC_PROTOCOL` | `https` | Scheme for generated URLs |
| `JWT_SECRET` | — | **Required.** `openssl rand -hex 32` |
| `APP_MASTER_PASSWORD` | — | **Required.** Shared device password |
| `JWT_EXPIRES_IN` | `30d` | Token lifetime |
| `GEMINI_API_KEY` | *(empty)* | Absent ⇒ extraction returns 503, render job skips |
| `GEMINI_VISION_MODEL` | `gemini-3.7-flash` | Extraction model |
| `GEMINI_IMAGE_MODEL` | `gemini-3.1-flash-image` | Studio render model |
| `GEMINI_MAX_ATTEMPTS` | `3` | Total tries against the primary model |
| `GEMINI_FALLBACK_MODEL` | *(empty)* | Tried once after retries are exhausted |
| `DATA_DIR` | `data` | SQLite + translation artefacts |
| `UPLOADS_DIR` | `uploads` | Operator photos |
| `CATALOG_DIR` | `public/catalog` | Rendered shots |
| `FLYWHEEL_CONFIDENCE_THRESHOLD` | `0.85` | Capture trigger |
| `FLYWHEEL_MAX_RECORDS` | `10000` | Ring-buffer ceiling |
| `FLYWHEEL_ADMIN_KEY` | *(empty)* | Guards hidden routes; empty ⇒ JWT only |
| `MAX_IMAGES` | `8` | Per request |
| `MAX_IMAGE_BYTES` | `12582912` | 12 MB per file |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window |
| `RATE_LIMIT_MAX` | `60` | Requests per window per IP |
| `CORS_ORIGIN` | `*` | Comma-separated allowlist |
| `RENDER_CRON_ENABLED` | `true` | Master switch |
| `RENDER_CRON_SCHEDULE` | `0 20 * * *` | 20:00 daily |
| `RENDER_CRON_TIMEZONE` | `Asia/Yerevan` | Schedule timezone |
| `RENDER_BATCH_SIZE` | `200` | Records per run |
| `RENDER_MAX_ATTEMPTS` | `3` | Before giving up on a record |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |

> `SERVER_HOST` is the one value that is painful to change later: it is baked into every
> `catalog_image_url` already handed to a device or written into an export. Set it to the final
> production domain before the first real scan.

---

## 12. Installation and deployment

### 12.1 Target

Ubuntu 24.04 LTS VPS, 2 vCPU / 4 GB, reachable on 443 via a reverse proxy that terminates TLS.
The Node process itself listens on an internal port (default 3000) and is never exposed directly.

### 12.2 Prerequisites

```bash
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# better-sqlite3 compiles a native addon on install
sudo apt-get install -y build-essential python3

node --version   # v20.x
npm --version
```

### 12.3 Deploy

```bash
sudo mkdir -p /opt/apparel-middleware
sudo chown "$USER":"$USER" /opt/apparel-middleware
cd /opt/apparel-middleware

# ship the repo's middle_ware/ directory here (git clone or rsync)
rsync -av --exclude node_modules --exclude dist --exclude data \
      --exclude uploads --exclude .env  ./middle_ware/  /opt/apparel-middleware/

# Build needs the dev dependencies (TypeScript), so install everything first.
npm ci
npm run build

# Then drop the build-time packages from the runtime image.
npm prune --omit=dev
```

`npm ci` requires the committed `package-lock.json` and gives a reproducible install.
`better-sqlite3` compiles its native addon during this step — this is why
`build-essential` and `python3` are prerequisites.

### 12.4 Configure

```bash
cp .env.example .env
openssl rand -hex 32          # paste into JWT_SECRET
nano .env
chmod 600 .env                # readable only by the service user
```

Minimum production values:

```ini
NODE_ENV=production
PORT=3000
SERVER_HOST=your-domain.com
PUBLIC_PROTOCOL=https
JWT_SECRET=<64 hex chars>
APP_MASTER_PASSWORD=<the password entered in the Android app>
GEMINI_API_KEY=<key>
CORS_ORIGIN=https://your-domain.com
RENDER_CRON_TIMEZONE=Asia/Yerevan
```

### 12.5 Build the Armenian lookup

```bash
# put the client's authoritative file at data/translations.csv first
npm run convert:translations
# -> Wrote N terms -> /opt/apparel-middleware/data/legalArmenianMap.json
```

### 12.6 Verify before exposing

```bash
npm test                                  # 57 offline checks
node dist/src/index.js &                  # start it manually once
curl -s localhost:3000/health             # expect gemini_ready: true
kill %1
```

### 12.7 systemd service

`/etc/systemd/system/apparel-middleware.service`:

```ini
[Unit]
Description=Apparel Vision Processing Middleware
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=apparel
Group=apparel
WorkingDirectory=/opt/apparel-middleware
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# The process only ever writes inside its own directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/apparel-middleware/data /opt/apparel-middleware/uploads /opt/apparel-middleware/public/catalog

StandardOutput=journal
StandardError=journal
SyslogIdentifier=apparel-middleware

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin apparel
sudo chown -R apparel:apparel /opt/apparel-middleware
sudo systemctl daemon-reload
sudo systemctl enable --now apparel-middleware
sudo systemctl status apparel-middleware
```

The process handles `SIGTERM` gracefully: it stops the cron, closes the HTTP listener, closes
both databases, and exits — with a 10-second hard-exit fallback so a hung connection cannot
block a restart.

### 12.8 Reverse proxy — Caddy (recommended)

`/etc/caddy/Caddyfile`:

```
your-domain.com {
    encode gzip

    # Vision calls hold the connection for the length of a Gemini round trip.
    reverse_proxy localhost:3000 {
        transport http {
            read_timeout  180s
            write_timeout 180s
        }
    }

    request_body {
        max_size 100MB          # 8 photos x 12 MB plus multipart overhead
    }
}
```

```bash
sudo systemctl reload caddy
```

Caddy obtains and renews the TLS certificate automatically.

### 12.9 Reverse proxy — nginx alternative

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    client_max_body_size 100M;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        proxy_read_timeout    180s;
        proxy_send_timeout    180s;
        proxy_request_buffering off;
    }
}
```

`X-Forwarded-For` matters: without it every request appears to come from the proxy and the
per-IP rate limiter throttles the whole fleet as one client.

### 12.10 Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 443/tcp
sudo ufw enable          # port 3000 stays closed; only the proxy reaches it
```

### 12.11 Backups

The backup script needs the SQLite CLI: `sudo apt-get install -y sqlite3`.

```bash
# /etc/cron.daily/apparel-backup
#!/bin/sh
set -e
DEST=/var/backups/apparel/$(date +%F)
mkdir -p "$DEST"
# .backup is safe on a live WAL database; a file copy is not
sqlite3 /opt/apparel-middleware/data/server_scans.db ".backup '$DEST/server_scans.db'"
sqlite3 /opt/apparel-middleware/data/flywheel.db     ".backup '$DEST/flywheel.db'"
tar czf "$DEST/catalog.tar.gz" -C /opt/apparel-middleware public/catalog
find /var/backups/apparel -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
```

Use `sqlite3 .backup`, not `cp` — copying a WAL-mode database while it is being written can
capture a torn state.

### 12.12 Updating

```bash
cd /opt/apparel-middleware
sudo systemctl stop apparel-middleware
git pull                     # or rsync the new source
npm ci --omit=dev
npm run build
npm test
sudo systemctl start apparel-middleware
```

Schema changes are applied by `CREATE TABLE IF NOT EXISTS` at boot. Adding a column to an
existing deployment needs an explicit `ALTER TABLE` — there is no migration framework, which is
a deliberate simplification for a two-table system.

---

## 13. Operations runbook

### Daily checks

```bash
curl -s https://your-domain.com/health | jq
journalctl -u apparel-middleware --since "20:00" | grep "Render job"
```

A healthy nightly line looks like:

```
Render job finished in 184230 ms — rendered 47, failed 0, skipped 2.
```

### Common situations

| Symptom | Cause | Action |
| --- | --- | --- |
| `gemini_ready: false` | `GEMINI_API_KEY` unset or unreadable | Check `.env` and its permissions; restart |
| All devices hitting 429 | `X-Forwarded-For` not reaching the app | Fix the proxy headers; confirm `trust proxy` |
| 502 `VISION_EXTRACTION_FAILED` | Gemini failed all retries | Check `journalctl` for the underlying status; set `GEMINI_FALLBACK_MODEL` |
| 503 `VISION_UNAVAILABLE` | No API key configured | Set the key and restart |
| Renders all `FAILED` | Image-model quota or billing | Verify the key's image quota in Google AI Studio |
| Catalog URL 404s | Render has not run yet, or failed | `npm run render:now`; inspect `render_error` |
| Flywheel not capturing | Threshold too low | Raise `FLYWHEEL_CONFIDENCE_THRESHOLD` |
| Disk filling | `uploads/` grows with every scan | Add a retention policy (see gaps below) |

### Useful queries

```bash
sqlite3 data/server_scans.db \
  "SELECT rendering_status, COUNT(*) FROM server_scans GROUP BY rendering_status;"

sqlite3 data/server_scans.db \
  "SELECT apparel_id, render_attempts, render_error FROM server_scans
   WHERE rendering_status='FAILED' ORDER BY updated_at DESC LIMIT 20;"

sqlite3 data/flywheel.db \
  "SELECT COUNT(*) total,
          SUM(confirmed_json IS NOT NULL) confirmed,
          ROUND(AVG(lowest_confidence_score),3) avg_low
   FROM flywheel_training;"

# which fields most often fall below threshold — where the model needs work
sqlite3 data/flywheel.db \
  "SELECT json_extract(unconfirmed_gemini_json,'$.lowest_field') f, COUNT(*) n
   FROM flywheel_training GROUP BY f ORDER BY n DESC;"
```

### Forcing a re-render

```sql
UPDATE server_scans
SET rendering_status='PENDING', render_attempts=0, render_error=NULL
WHERE apparel_id='<barcode>';
```

Then `npm run render:now`.

---

## 14. Testing

| Command | Scope | Network |
| --- | --- | --- |
| `npm test` | 57 checks: every endpoint, both auth paths, cloning, weights, fuzzy snapping, screening, ring buffer, Armenian export | none |
| `npm run test:live -- <images...>` | Real Gemini call, full pipeline, persistence and export report | Gemini |
| `npx tsx tests/cronCheck.ts` | Cron validity, tick reaches the job, failure marking | none |
| `npm run typecheck` | `tsc --noEmit`, strict mode | none |

`tests/smoke.ts` boots the real Express app on an ephemeral port and drives it over HTTP — it
tests the assembled application, not mocks. It isolates itself by clearing
`flywheel_training` on entry, and verifies the ring buffer with a temporary cap of 25 rather
than inserting 10,000 rows.

`tests/cronCheck.ts` uses **dynamic imports** deliberately: `env.ts` snapshots `process.env` at
module load, and static `import` statements hoist above assignments, so overriding the schedule
requires `await import()`.

---

## 15. Verification results

### Live extraction

Six real photos (`sample_photo/set00/A1–A6`, one brown mock-neck pullover with hangtag) through
`POST /api/v1/vision/extract`:

| Field | Value | Confidence |
| --- | --- | --- |
| `brand_name` | LIU JO | 0.99 |
| `country_of_origin` | China | 0.99 |
| `size` | XL | 0.99 |
| `color` | brown | 0.99 |
| `material` | 38% Cotton 27% Wool 20% Polyamide 15% Polyester | 0.98 |
| `category` | clothing | 0.99 |
| `sub_category` | pullover | 0.98 |
| `gender` | male | 0.95 |
| `season` | fall | 0.85 |
| `original_price` | *(empty)* | 0.00 |
| `netto` / `brutto` | *(empty)* | 0.00 |

The empty price and weights are **correct**: that photo set contains no price tag and no scale
display, so the zero-weight rule produced `""` at `0.0` and the flywheel intercepted the record
(`lowest 0.00 on original_price`). Persistence was confirmed: `server_scans` row present,
`rendering_status=PENDING`, 6 images on disk, flywheel captured.

### Retry behaviour

The first live attempt returned `503 UNAVAILABLE` (transient model demand). The retry logic
logged two backoff waits and succeeded on the third attempt:

```
WARN  Vision extraction: 503 UNAVAILABLE on gemini-3.7-flash (attempt 1/3); retrying in 737 ms.
WARN  Vision extraction: 503 UNAVAILABLE on gemini-3.7-flash (attempt 2/3); retrying in 1097 ms.
INFO  Flywheel captured 40000000857 ...
HTTP 200 in 24306 ms
```

### Other verified behaviour

- Compiled `dist/` boots and serves; Helmet headers present, `x-powered-by` absent.
- Cron tick reaches the render job; a missing key photo is marked `FAILED` with the attempt
  counted; retries stop at `RENDER_MAX_ATTEMPTS`.
- FIFO ring buffer holds its cap, evicts oldest, retains newest.
- Fuzzy matcher: 15/15 accuracy cases including `Trousers→pants`, `Made in Viet Nam→Vietnam`,
  `Charcoal Grey→gray`, `sunglases→sunglasses`, `CN→China`.
- No `.env`, database, or upload artefact is tracked in git.

---

## 16. Known gaps and decisions needed

### Needs your input

**1. `sub_category` taxonomy is a placeholder.** The build spec says 253 options; the locked API
contract lists 14. `src/data/taxonomy/subCategories.json` currently holds the contract's 14.
Drop the real 253-item list in — same `{ "key": ..., "aliases": [...] }` shape — and the matcher,
the response schema and the Gemini system instruction all pick it up with no code change
(see [4.4](#44-prompt-and-matcher-coupling)). Add matching rows
to `data/translations.csv` and re-run `npm run convert:translations` for the Armenian side.

**2. `data/translations.csv` is a seed, not the client's file.** It holds 140 terms covering
every enum value, common apparel origin countries and the usual fibre names. The Armenian is
correct, but it is not the client's authoritative legal wording. Replace it before any real
customs declaration.

### Environmental

**3. `gemini-2.5-flash` is retired.** The model named in the spec returns
`404 — no longer available to new users`. The default is now `gemini-3.7-flash`, verified
working. Both model names are env-configurable, so moving again is a config change.

**4. Image generation is quota-blocked.** `gemini-3.1-flash-image` and `gemini-2.5-flash-image`
both returned `429 — quota exceeded` on the current key. The render path is therefore
implemented and wired but **not verified against the real model**. Enabling billing on the
Google Cloud project should be sufficient; verify with `npm run render:now` afterwards.

### Deferred by design

**5. No upload retention policy.** `uploads/` grows with every scan. A production deployment
should add a retention job (the flywheel already caps itself at 10,000 records, but operational
photos are unbounded). Recommendation: purge `uploads/<id>/` for records that are `COMPLETED`
and older than N days, keeping anything referenced by `flywheel.db`.

**6. Single shared device password.** Per the contract, all devices authenticate with one
`APP_MASTER_PASSWORD`; the JWT carries the operator's `username` for attribution but that name is
self-declared. Per-operator credentials would require a user table and a contract revision.

**7. No migration framework.** Schema is created with `CREATE TABLE IF NOT EXISTS` at boot.
Adding a column to a live deployment needs a manual `ALTER TABLE`. Reasonable for two tables;
revisit if the schema grows.

**8. Render batch is sequential.** Deliberate, to respect image-model rate limits. If nightly
volume outgrows the window, introduce a small concurrency pool with a token-bucket limiter
rather than removing the sequencing.
