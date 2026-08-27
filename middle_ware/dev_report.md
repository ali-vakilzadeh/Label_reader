# Apparel Vision Processing Middleware — Development Report

**Component:** Middleware bridge between the Android scanner fleet and the Gemini Vision API
**Location:** `/middle_ware`
**Stack:** Node.js 20 LTS · TypeScript 5.8 · Express 4.21 · better-sqlite3 11 · @google/genai 1.x
**Status:** Feature-complete against `api_contract.md` and `server_specification.json`, plus a
durable intake queue, a UI control channel, and a fully asynchronous client protocol
(`api_contract.md` **v1.1**). Build and typecheck clean; **215 checks pass with no network
access**. The vision path is verified against the live API with real photos.

**Companion document:** [`UI_messaging_protocol.md`](UI_messaging_protocol.md) — the contract the
Web UI codes against.

---

## Table of contents

1. [What this service does](#1-what-this-service-does)
2. [Architecture](#2-architecture)
3. [Request lifecycle](#3-request-lifecycle)
4. [Business rules](#4-business-rules)
5. [The training flywheel](#5-the-training-flywheel)
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
17. [Durability and the intake queue](#17-durability-and-the-intake-queue)
18. [Concurrency and result delivery](#18-concurrency-and-result-delivery)
19. [Fault classification](#19-fault-classification)
20. [The UI control channel](#20-the-ui-control-channel)
21. [Credential management](#21-credential-management)
22. [Asynchronous client protocol (v1.1)](#22-asynchronous-client-protocol-v11)
23. [Change log](#23-change-log)

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
│   │   ├── flywheelDb.ts           flywheel.db      — hidden training corpus
│   │   ├── controlDb.ts            control.db       — shared bus with the Web UI
│   │   ├── messageCatalogue.ts     published message codes + UI command names
│   │   └── visionSettings.ts       operator-managed credentials, encrypted
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
│   │   ├── geminiErrors.ts         fault classification (the 429 disambiguation)
│   │   ├── visionService.ts        orchestration: clone / extract / normalise / persist
│   │   ├── extractionQueue.ts      background drain of the durable intake queue
│   │   ├── controlService.ts       pause state, events, UI commands, heartbeat
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
│   ├── errorClassification.ts  26 checks against real Gemini error payloads
│   ├── contractQueries.ts      30 checks: every published UI query, 2nd process
│   ├── settingsAndDelivery.ts  32 checks: credentials, replay, result recovery
│   ├── durability.ts           38 checks: the zero-data-loss guarantee
│   ├── liveExtract.ts              real Gemini call against real photos
│   └── cronCheck.ts                cron wiring + render failure handling
│
├── data/                           SQLite files, translations.csv (gitignored DBs)
├── public/catalog/                 rendered studio shots, served statically
└── uploads/<apparel_id>/           operator photos as received
```

**Total:** ~4,900 lines of TypeScript across 40 files.

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

## 5. The training flywheel

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

> **v1.1:** returns **202 Accepted** and never waits for the AI. See
> [§22](#22-asynchronous-client-protocol-v11) and [`api_contract.md`](api_contract.md).

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

### `GET /api/v1/vision/result/:apparel_id` — Bearer

Recovery path for a device that lost the extract response, and the normal way results are
collected under v1.1. Uploads nothing; results are never purged, so it can be called at any later
time. Returns the contract payload plus `processing_status`
(`PENDING_AI` / `READY_TO_CONFIRM` / `NEEDS_ATTENTION`) and `attention_reason`.
A batch form, `GET /api/v1/vision/results?ids=…`, accepts up to 100 ids.
See [§22.5](#225-result-retrieval).

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
| ~~`VISION_QUEUED`~~ | ~~503~~ | **Removed in v1.1** — a stored scan now returns `202` with `processing_status: PENDING_AI` |
| `SCAN_NOT_FOUND` | 404 | No scan stored for that `apparel_id` |
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
  -- extraction lifecycle (v1.1)
  extraction_status     TEXT NOT NULL DEFAULT 'COMPLETED',  -- PENDING|COMPLETED|PARKED
  extraction_attempts   INTEGER NOT NULL DEFAULT 0,
  extraction_error      TEXT,
  extraction_fault_code TEXT,
  next_attempt_at       INTEGER,            -- backoff timer for the drain worker
  image_digest          TEXT,               -- SHA-256 of the photos, for replay detection
  completed_at          INTEGER,
  created_at        INTEGER NOT NULL,       -- epoch ms
  updated_at        INTEGER NOT NULL
);
```

Columns are added by a forward-only `ensureColumn()` migration at boot, so an existing database
is upgraded in place rather than rebuilt.

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

### 9.3 `data/control.db` — shared with the Web UI

Seven tables: `server_status`, `server_events`, `ui_commands`, `message_dictionary`,
`message_translations`, `vision_settings`, `vision_settings_pending`. This is the only database
another process writes to. Full schema and semantics in
[`UI_messaging_protocol.md`](UI_messaging_protocol.md).

### 9.4 SQLite configuration

Both databases run `journal_mode = WAL` so readers never block the writer — important with 10
devices scanning while a dashboard reads. `busy_timeout = 5000` absorbs brief write contention
instead of surfacing `SQLITE_BUSY` to an operator. All statements are prepared once at module
load and reused.

### 9.5 Filesystem layout

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
| `CONTROL_HEARTBEAT_MS` | `30000` | Heartbeat + counter refresh |
| `CONTROL_POLL_MS` | `15000` | UI command and credential-submission poll |
| `QUEUE_DRAIN_MS` | `60000` | Extraction backlog sweep |
| `QUEUE_DRAIN_BATCH` | `25` | Scans per sweep |
| `QUEUE_BACKLOG_WARNING` | `25` | Pending count that raises `QUEUE_BACKLOG` |
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

| Command | Checks | Scope | Network |
| --- | --- | --- | --- |
| `npm test` | 58 | Every endpoint, both auth paths, cloning, weights, fuzzy snapping, screening, ring buffer, Armenian export | none |
| `npm run test:errors` | 26 | Fault classification against real captured Gemini payloads | none |
| `npm run test:contract` | 30 | Every SQL statement published to the UI, executed as a second process | none |
| `npm run test:settings` | 33 | Credential submission/validation/encryption, replay, result recovery | partial |
| `npm run test:durability` | 38 | The zero-data-loss guarantee end to end | yes (degrades to skips) |
| `npm run test:async` | 68 | api_contract.md v1.1 end to end, deliberately with no API key | none |
| `npm run test:users` | 46 | Operator accounts, revocation, soft delete, migration | none |
| `npm run test:all` | 253 | typecheck + all six offline suites | none |
| `npm run test:live -- <images...>` | — | Real Gemini call, full pipeline, persistence and export report | Gemini |
| `npx tsx tests/cronCheck.ts` | — | Cron validity, tick reaches the job, failure marking | none |
| `npm run typecheck` | — | `tsc --noEmit`, strict, **including `tests/`** | none |

Suites that touch the live API degrade to explicit `SKIP` lines when the account's own quota is
exhausted, and still assert the guarantee that must hold regardless — that nothing was lost.
A skipped check is reported as skipped, never as a pass.

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

### Resolved since v1.0

**Orphaned scans on vision failure** — scans are now persisted before the vision call and drained
by a background worker. See [§17](#17-durability-and-the-intake-queue).

**Result destroyed by device retry** — a re-submitted scan replayed from store instead of
overwriting the completed extraction. See [§18.3](#183-what-happens-when-a-device-does-not-receive-the-result).

**No operator visibility** — faults now reach the Web UI as coded, actionable events over the
control channel. See [§20](#20-the-ui-control-channel).

**API key changes required shell access** — keys are now submitted through the UI, validated
before adoption, and encrypted at rest. See [§21](#21-credential-management).

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

**9. Parked scans have no review UI.** `QUEUE_PARKED_ITEMS` tells the operator that scans need
attention and `listParkedScans()` returns them, but the dashboard screen to re-photograph or
manually complete them is not built. Parked scans are never deleted, so this is a workflow gap,
not a data risk.

**10. The device is not notified when a queued scan later completes.** A scan extracted by the
drain worker after the device gave up sits in `server_scans` until something asks for it. The
device must poll `GET /api/v1/vision/result/:apparel_id`. A push channel would need a contract
revision; polling on the existing barcode is sufficient and needs no server-issued handle.

**11. Rotating `JWT_SECRET` invalidates stored credentials.** The vision key is encrypted under a
value derived from it, so a rotation requires re-submitting the key through the UI. The
middleware logs this explicitly. Provisioning a dedicated encryption secret would remove the
coupling at the cost of one more thing to manage.

---

## 17. Durability and the intake queue

### 17.1 The problem this solves

The original build persisted photos, called Gemini, and only then wrote the database row. A
vision failure threw before that write, leaving photos on disk with **no record that the scan
ever happened**. The only surviving evidence was the Android device's local queue. Measured:

```
HTTP 502: {"error_code":"VISION_EXTRACTION_FAILED"}
photos written to disk : 1
server_scans row       : ABSENT
Verdict: ORPHANED
```

For a client with zero tolerance for data loss, a guarantee that lives only on the handset is not
a guarantee — a supervisor PIN can clear that queue, and a lost device takes the scan with it.

### 17.2 The durability boundary

`extractFromImages()` now commits before it calls anything remote:

```
persistImages()                  photos to uploads/<apparel_id>/
upsertScan(extraction_status = 'PENDING')      ◄── DURABILITY BOUNDARY
─────────────────────────────────────────────────────────────────────
  everything below may fail, pause, restart, or be abandoned:
  isGeminiReady? / isVisionPaused? / Gemini call / normalise / flywheel
```

Past that line the scan is owned by the queue. An outage costs latency, never data.

### 17.3 Extraction lifecycle

| Status | Meaning | Retried? | Deleted? |
|---|---|---|---|
| `PENDING` | Accepted; extraction still owed | Yes, indefinitely with capped backoff | Never |
| `COMPLETED` | Extracted successfully | — | Never |
| `PARKED` | This payload cannot be extracted (unreadable images) | No | **Never** |

There is deliberately **no attempt ceiling** on extraction. A scan leaves the queue only by
succeeding or by being parked for a human. This is the difference between "retry until success"
as a slogan and as a property: retries are unbounded where retrying can work, and where it
cannot, the work is preserved for a person rather than discarded.

Backoff is `min(30s × 2^attempts, 30 min)`, or the server's own `retryDelay` when it supplied a
trustworthy one.

### 17.4 The drain worker

`src/services/extractionQueue.ts` sweeps every `QUEUE_DRAIN_MS` (default 60 s):

```sql
SELECT * FROM server_scans
WHERE extraction_status = 'PENDING'
  AND (next_attempt_at IS NULL OR next_attempt_at <= :now)
  AND image_paths IS NOT NULL
ORDER BY created_at ASC LIMIT :batch
```

It is conservative by design:

- **does nothing while vision is paused** — it cannot hammer a dead quota;
- **stops the sweep on the first halting fault** — the rest of the batch would hit the same wall,
  and the unprocessed rows simply stay queued;
- **processes sequentially** — ten scanner devices plus a parallel drain would trip rate limits;
- **sweeps once at boot** — anything left mid-flight by a crash moves immediately.

The worker reads photos from disk, so it is independent of the original HTTP request.

### 17.5 Resuming clears backoff

When an operator resolves a fault, `resumeVision()` clears `next_attempt_at` on every queued
scan. A backoff earned by a condition that no longer exists is just a delay; "retry" from a human
means *now*.

---

## 18. Concurrency and result delivery

*This section answers how the middleware serves ten devices at once, and what happens when a
device never receives its answer.*

### 18.1 How ten devices are served concurrently

Node runs one JavaScript thread, but every slow operation here is I/O, so requests interleave
rather than queue:

```
device A ─┐
device B ─┼─► Express ─► per-request handler ─► await Gemini (I/O) ─┐
device C ─┘       (no shared mutable state)                          │
                                                                     ▼
                  event loop serves other requests while each await is in flight
```

**Nothing is routed anywhere.** There is no dispatcher, no correlation table, and no queue of
device sessions — because there is no need for one. Each HTTP request has its own closure
holding its own `apparel_id`, its own uploaded buffers, and its own `Promise`. Node resolves that
promise onto that request's socket. Device B cannot receive device A's result for the same reason
one browser tab cannot receive another's response: they are different TCP connections with
different response objects.

The specific properties that make this safe:

| Concern | Why it holds |
|---|---|
| Result routing | The response is written to the socket the request arrived on. No lookup, no possibility of mismatch |
| Shared state | Handlers share no mutable request state. `apparel_id`, buffers and results are all local |
| Database writes | better-sqlite3 is synchronous; SQLite serialises writers. WAL lets readers proceed concurrently |
| Write contention | `busy_timeout = 5000` absorbs collisions rather than failing |
| Row collisions | `apparel_id` is the primary key. Two devices scanning the same barcode is an upsert, not a race |
| Fuzzy matcher | Indexes are read-only after load; the memo cache is a plain `Map`, safe on one thread |
| Blocking | The only long operation is the Gemini call, and it is `await`ed — the loop stays free |

Ten concurrent devices is far below the point where this design strains. The practical ceiling
is the Gemini rate limit, not the middleware.

### 18.2 Identity: three independent keys

| Key | Scope | Purpose |
|---|---|---|
| TCP connection | One request | Where the response is written |
| JWT `username` | One device session | Who is scanning (attribution, logs) |
| `apparel_id` | Permanent | Which garment the record belongs to |

`apparel_id` is what makes the system recoverable: it is chosen by the client from the physical
barcode, so the device can always ask about a scan again without needing a server-issued handle.

### 18.3 What happens when a device does not receive the result

**Results are never purged on delivery.** A completed extraction lives in `server_scans`
indefinitely — delivery is not consumption. There is no TTL, no acknowledgement requirement, and
no cleanup job that removes results.

The device has two independent recovery paths:

**Path 1 — re-submit (what the existing app already does).** The Android client keeps its scan
queued until it gets a response, and retries. That retry is **idempotent** (see also
[§22.7](#227-idempotency)):

```
POST /api/v1/vision/extract  (same apparel_id, same photos)
   │
   ├─ digest = SHA-256 of the uploaded photo bytes
   ├─ existing row COMPLETED && digest matches?
   │     └─ YES ─► return the stored result. No Gemini call. No overwrite.
   └─ NO (different photos) ─► genuine re-scan; queue a fresh extraction
```

**This was a real bug and is now fixed.** Before the fix, a re-submission wiped the completed
extraction and re-billed the vision API:

```
after successful extraction:   status COMPLETED   data {"brand_name":"LIU JO"}
after the device re-submits:   status PENDING     data {"brand_name":""}
VERDICT: RESULT DESTROYED
```

Verified after the fix: the duplicate returns 200 with identical data, `completed_at` is
unchanged, and `extraction_attempts` does not increase — proving no second API call was made.

**Path 2 — fetch it later, with no upload.**

```
GET /api/v1/vision/result/:apparel_id     (Bearer)
```

```json
{
  "status": "success",
  "apparel_id": "890123456789",
  "extraction_status": "COMPLETED",
  "extraction_fault_code": null,
  "catalog_image_url": "https://.../catalog/IMG_890123456789.jpg",
  "data": { "...": "12 fields" }
}
```

`extraction_status` tells the client exactly what to do:

| Value | Client behaviour |
|---|---|
| `COMPLETED` | `data` is final; commit to the ledger |
| `PENDING` | Still queued — poll again later, do not re-upload |
| `PARKED` | Needs human review — stop polling, flag for a supervisor |

This endpoint is additive; it does not alter the locked contract. It costs nothing to call
because it uploads no photos, which makes recovery cheap enough to do routinely.

### 18.4 Retention

| Artefact | Retention |
|---|---|
| `server_scans` row (incl. result) | Indefinite. Never purged |
| `uploads/<apparel_id>/` photos | Indefinite (see gap #5) |
| `flywheel_training` sample | FIFO ring buffer, 10,000 |
| `public/catalog/*.jpg` | Indefinite |

The only rotating store is the training buffer, and it holds copies — never the sole record of a
scan.

---

## 19. Fault classification

`src/services/geminiErrors.ts` maps every failure onto a stable code plus a disposition, so
callers never re-interpret raw errors.

### 19.1 The 429 problem

Gemini returns `429 / RESOURCE_EXHAUSTED` for two unrelated situations: a per-minute burst limit
that clears in seconds, and a plan that does not cover the model at all. The discriminator is in
`error.details[]`, not the message text.

**The trap:** when the plan excludes a model, the API still returns a `RetryInfo` alongside
`limit: 0` — captured verbatim from the live API:

```jsonc
"message": "... limit: 0, model: gemini-3.1-flash-image ... Please retry in 43.410718034s.",
"details": [
  { "@type": ".../QuotaFailure", "violations": [{ "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
  { "@type": ".../RetryInfo", "retryDelay": "43s" }
]
```

That `retryDelay` is misleading. The classifier tests `limit: 0` **before** trusting it.

### 19.2 The taxonomy

| Fault code | HTTP | Disposition | Pauses? |
|---|---|---|---|
| `VISION_TRANSIENT` | 5xx | `RETRY` | no |
| `VISION_NETWORK` | — | `RETRY` | no |
| `VISION_RATE_LIMIT_MINUTE` | 429 + `PerMinute` | `RETRY_AFTER` | no |
| `VISION_RATE_LIMIT_DAY` | 429 + `PerDay` | `HALT` | **yes** |
| `VISION_BILLING_REQUIRED` | 429 + `limit: 0` | `HALT` | **yes** |
| `VISION_BAD_CREDENTIALS` | 400/401/403 | `HALT` | **yes** |
| `VISION_MODEL_UNAVAILABLE` | 404 | `HALT` | **yes** |
| `VISION_NOT_CONFIGURED` | — | `HALT` | **yes** |
| `VISION_REQUEST_REJECTED` | 400 (payload) | `REJECT` | no — parks one scan |
| `VISION_UNKNOWN` | — | `RETRY` | no |

Unrecognised failures classify as `RETRY`, so the system errs toward keeping work rather than
discarding it.

### 19.3 Dispositions

- **`RETRY`** — backoff and try again.
- **`RETRY_AFTER`** — same, but not before the server's stated delay.
- **`HALT`** — stop calling the API; a person must change something. Scans keep being accepted
  and stored.
- **`REJECT`** — this one payload will never succeed; park it. Other scans are unaffected.

`REJECT` is the distinction that keeps one bad photo from halting a warehouse.

---

## 20. The UI control channel

Full specification: [`UI_messaging_protocol.md`](UI_messaging_protocol.md). Summary here.

### 20.1 Why SQLite and not JSON files

The Web UI runs as a separate process on the same host. A pair of JSON status files was
considered and rejected: a single overwritten file is a *state* file, not a message queue, so two
events inside one poll interval silently lose the first — unacceptable for a system whose
premise is that nothing is lost. SQLite provides, for free, what a file-based channel would have
had to reinvent: atomic commits (no torn reads), WAL concurrency (readers never block the
writer), and real append-only tables with acknowledgement columns.

### 20.2 Tables

| Table | Direction | Purpose |
|---|---|---|
| `server_status` | → UI | Single row: state, pause, heartbeat, queue and buffer counters |
| `server_events` | → UI | Append-only, coalesced by code, acknowledgeable |
| `ui_commands` | UI → | Append-only with `PENDING→IN_PROGRESS→DONE\|FAILED\|REJECTED` |
| `message_dictionary` | → UI | Reseeded each boot; code → severity, category, text, hint |
| `message_translations` | UI-owned | Localised text; **never touched by the reseed** |
| `vision_settings` | middleware | Active credentials, encrypted |
| `vision_settings_pending` | UI → | Credential submissions awaiting validation |

### 20.3 Design decisions worth knowing

**Events coalesce.** A repeating condition bumps `occurrences` on the open row instead of
inserting duplicates — a retry storm cannot flood the table, and no message is ever lost to an
overwrite. Verified: 5 failing scans in a row produced exactly one open event.

**Liveness is explicit.** `state = 'OK'` from a process that died an hour ago still reads `OK`.
The heartbeat exists so the UI can tell a healthy server from a corpse; anything older than three
intervals must render as unreachable, never as OK.

**Pause survives restart.** The pause lives in `control.db`, not memory. A restart cannot
silently resume hammering an API that still needs a human. Verified.

**Purge is watermark-based.** `FLYWHEEL_DUMPED` requires `exported_through_id`. Between the UI
starting an export and issuing the purge, new samples arrive; "delete everything" would destroy
samples that were never exported. A command without a watermark is `REJECTED` and nothing is
deleted. Verified: a sample captured after the watermark survived the purge.

**Unknown commands are rejected, not ignored** — so a UI/middleware version mismatch is visible
rather than silent.

### 20.4 Message catalogue

31 codes across `VISION`, `QUEUE`, `FLYWHEEL`, `RENDER`, and `SYSTEM`, each carrying severity,
category, a `requires_action` flag, default English text, and an operator hint. The UI switches
on `code` and renders text from the dictionary, so wording and translation change without a UI
release. The catalogue is reseeded at every boot, so a middleware upgrade that adds codes renders
correctly against an unchanged UI.

### 20.5 Filesystem requirement

Both processes need read **and write** on `control.db` and its `-wal`/`-shm` siblings — SQLite
writes to the shared-memory file even for readers, so a read-only account cannot read a WAL
database at all. The data directory also needs the **setgid bit**: SQLite recreates `-wal`/`-shm`
at checkpoints, and without setgid the new files inherit the wrong group and lock the other
process out hours after a working deploy.

---

## 21. Credential management

### 21.1 Why the UI does not write `.env`

`.env` also holds `JWT_SECRET` and `APP_MASTER_PASSWORD`. Granting the web tier write access
there would turn a UI compromise into a full authentication compromise. Credentials are therefore
exchanged through the control channel instead.

### 21.2 Validate before adopting

```
UI inserts into vision_settings_pending  (plaintext, transient)
        │
   middleware marks VALIDATING
        │
   live probe against the candidate key + model
        │
   ┌────┴──────────────┬──────────────────────────┐
 VALID              INVALID                  INCONCLUSIVE
   │                   │                           │
 encrypt into      keep PREVIOUS creds,      keep PREVIOUS creds,
 vision_settings,  mark REJECTED,            stay PENDING,
 erase plaintext,  raise                     retry on a later poll
 mark APPLIED,     VISION_SETTINGS_REJECTED
 resume + drain
```

**Three outcomes, not two.** An early revision treated "the API was unreachable" as a pass, on
the reasoning that an outage is not the candidate's fault. That quietly inverted the guarantee:
a network blip during validation would *adopt* an unverified key and take extraction down — the
exact failure validation exists to prevent. An unreachable API now yields `INCONCLUSIVE`, which
adopts nothing and rejects nothing; the submission stays queued and the credentials already in
force keep working.

Validating before adopting is the point. Without it a typo takes extraction down and nobody finds
out until the next scan fails; with it the operator is told immediately and the working key is
still in force.

### 21.3 At rest

The key is encrypted with AES-256-GCM under a key derived (`scrypt`) from `JWT_SECRET`, which the
UI does not have — so a reader of `control.db` cannot lift the credential. Only a
`****last4` fingerprint is exposed for display. Plaintext exists solely in
`vision_settings_pending.api_key` between submission and validation, and is erased the moment the
outcome is decided.

> If `JWT_SECRET` is rotated, the stored key becomes undecryptable and must be re-submitted. The
> middleware logs this explicitly rather than failing obscurely.

### 21.4 Precedence, and the no-fallback rule

```
UI-managed key (validated)  ──► wins
        ↓ absent
GEMINI_API_KEY from .env    ──► bootstrap only
        ↓ absent
NONE ──► VISION_NOT_CONFIGURED, vision paused, scans still stored and queued
```

**There is no fallback to a previously working key.** If the active key is cleared or rejected,
the middleware waits for a corrected one. Reverting silently would let an operator believe a
change took effect when it had not — the failure would surface later, somewhere else, as
mysterious behaviour. Waiting is visible; reverting is not.

An earlier revision did fall back to the boot-time value when the current one was empty. That was
removed.

---

## 22. Asynchronous client protocol (v1.1)

Full specification: [`api_contract.md`](api_contract.md). Rationale and mechanics here.

### 22.1 Why it changed

v1.0 had the device wait while the server called Gemini. Once extraction became a durable queue
([§17](#17-durability-and-the-intake-queue)), that produced a contradiction: a scan could be
safely stored but not yet extracted, and the only way to say so was
`503 VISION_QUEUED` — a *failure* code for a *successful* store.

The consequence was concrete. The Android client marks `5xx` as `status = 3 (Failed)`, so the
operator saw a red error for a scan that was safe and progressing, and the device could re-upload
eight photos the server already held.

The app was never the obstacle. Its own specification already describes "**asynchronous** Gemini
Vision AI extraction", stores captures at `STATUS_PENDING_VISION` before transmitting, and syncs
in batches. The queue matched the app's design; only the wire vocabulary was missing.

### 22.2 The storage invariant

One rule governs all client retry behaviour:

| Response | Meaning | Client action |
|---|---|---|
| **2xx** | The server **has** the scan | Never resend images; poll |
| **4xx** | Malformed; nothing stored | Fix the request |
| **5xx** | The server does **not** have it | Resend everything |

This is the property the whole protocol rests on, and it is asserted directly in
`tests/asyncContract.ts` — including the hardening case in [§22.6](#226-protecting-the-invariant).

### 22.3 Pure async

`POST /vision/extract` no longer calls the vision API at all. It stores, nudges the queue, and
returns **202** — measured well under 3 s with no key configured.

```
POST /vision/extract
   │
   ├─ digest matches an existing scan? ──► replay its stored state
   ├─ cloned_from set? ────────────────► copy parent, READY_TO_CONFIRM
   └─ otherwise ───────────────────────► persist, queue, PENDING_AI
```

Every accepted submission answers 202, clones and replays included. The client branches on
`processing_status`, never on the status code — one HTTP branch, one state switch.

| `processing_status` | Server state | Android `status` |
|---|---|---|
| `PENDING_AI` | `PENDING` | 0 Pending AI Vision |
| `READY_TO_CONFIRM` | `COMPLETED` | 1 Extracted / In Review |
| `NEEDS_ATTENTION` | `PARKED` | 3 Failed |

That maps onto the app's **existing** enum, so no client data-model change was required.

Because the submit path never contacts Gemini, it cannot report an extraction failure — every
extraction outcome is discovered by polling. Submit therefore has exactly two outcomes: *stored*
or *not stored*.

### 22.4 Polling hints

Each response carries what the client needs to schedule its next call:

```json
"queue_depth": 12,
"estimated_wait_seconds": 60,
"retry_after_seconds": 60,
"blocking_fault": null
```

`estimated_wait_seconds` is `queue_depth × VISION_SECONDS_PER_ITEM` (default 5 s) — for operator
display. `retry_after_seconds` is the machine hint, clamped to `POLL_RETRY_MIN/MAX_SECONDS`
(5–120) so devices neither hammer the server nor sleep through a fast queue.

**When processing is paused, `estimated_wait_seconds` is `null`, not a number.** The wait then
depends on a person fixing billing or credentials, so any figure would be a guess the operator
would plan around. `blocking_fault` names the cause instead, and polling drops to the ceiling.

### 22.5 Result retrieval

| Endpoint | Purpose |
|---|---|
| `GET /vision/result/:apparel_id` | One scan |
| `GET /vision/results?ids=a,b,c` | Up to 100 at once |

The batch form exists for the realistic case: after an outage a device may be waiting on dozens
of scans, and polling them individually would be one request each. Unknown ids come back in
`not_found` rather than failing the batch, so one stale id cannot block the rest.

Neither endpoint uploads anything, and results are never purged — recovery is cheap enough to do
routinely, and works after an app reinstall because `apparel_id` is the barcode.

### 22.6 Protecting the invariant

The polling hints are read from `control.db` **after** the scan is committed. A failure there
would have produced a `5xx` for a scan that was already stored — telling the device to resend
something the server held, in direct violation of [§22.2](#222-the-storage-invariant).

Two defences, both tested:

- **`queueSnapshot()` never throws.** On any failure it logs and returns conservative hints
  (`depth 0`, no estimate, ceiling poll interval). The response stays 202.
- **`readStatus()` self-heals.** The singleton status row is seeded with the schema; if it is
  ever missing, the read recreates it rather than returning `undefined` to a caller that will
  dereference it.

The test closes `control.db` mid-run and asserts the submission still returns 202 and the scan is
still retrievable.

### 22.7 Idempotency

Re-submitting the same `apparel_id` with byte-identical photos replays the stored state — the
digest comparison happens before anything else, so it costs no API call and cannot overwrite a
finished extraction. Different photos for the same id are treated as a genuine re-scan and queue
fresh work.

A client unsure whether a submission landed can simply resend.

---

## 23. Change log

### v1.1 — asynchronous client protocol

**api_contract.md v1.1**
- `POST /vision/extract` is now **pure async**: stores, queues, returns `202`, never calls the AI.
- `processing_status` (`PENDING_AI` / `READY_TO_CONFIRM` / `NEEDS_ATTENTION`) on every scan
  response, mapping 1:1 onto the Android client's existing Room status enum.
- Polling hints derived from real queue depth: `queue_depth`, `estimated_wait_seconds`,
  `retry_after_seconds`, `blocking_fault`. No estimate is invented while paused.
- `GET /vision/results?ids=…` batch retrieval, up to 100 ids.
- `503 VISION_QUEUED` removed — it reported a *failure* for a *successful* store and caused the
  client to resend photos the server already held.
- The storage invariant (2xx = stored, 5xx = not stored) is now stated and tested.

**Operator accounts**
- `app_users` in `control.db`: per-operator logins created, disabled and deleted from the Web UI.
- Passwords hashed with scrypt and a per-user salt; plaintext exists only in the request row and
  is erased on resolution. `app_users_public` view keeps hashes out of the UI's reach.
- **Revocation is immediate.** A 30-day JWT would otherwise outlive a disable by a month, making
  it cosmetic. Each account carries a `tokens_valid_from` stamp bumped by disable, delete and
  password change; every authenticated request is checked against it.
- Delete is a *soft* delete — scans carry the operator's username for attribution and are kept
  indefinitely, so removing the row would orphan the audit trail.
- The last active operator cannot be disabled or deleted.
- Shared `APP_MASTER_PASSWORD` still works for usernames without an account, so the fleet keeps
  running during migration; `ALLOW_MASTER_PASSWORD_FALLBACK=false` closes it afterwards.

**Safety hardening**
- Account standing is cached in memory, so an unreachable `control.db` cannot 401 the entire
  fleet. Revocations issued before the outage stay enforced; only one issued during it is missed.
- `LOGIN_RATE_LIMIT_MAX` (default 30/min per IP) replaces a hard-coded 10 — a warehouse fleet
  shares one NAT, so a password reset made all ten devices re-authenticate into the old ceiling.
- Credential validation is three-state: an unreachable API is `INCONCLUSIVE`, never a pass.
  Previously a network blip during validation could adopt an unverified key.
- `queueSnapshot()` cannot throw; advisory hints degrade instead of turning a stored scan into a
  `5xx`.
- `readStatus()` self-heals a missing status row; the row is seeded with the schema rather than
  by start-up, closing a window where an early request produced a 500.
- Request path wakes the drain worker through a dependency-free signal module, removing a
  latent import cycle. Nudges are debounced so a batch of scans causes one sweep.

### v1.0.x — durability, control channel, credentials

**Zero data loss**
- Scans are persisted **before** the vision call; a failure can no longer orphan photos.
- Extraction lifecycle `PENDING`/`COMPLETED`/`PARKED` with unbounded retry and capped backoff.
- Background drain worker; sweeps at boot and every `QUEUE_DRAIN_MS`.
- Resuming after a fault clears queued backoff.

**Delivery**
- Idempotent replay via image digest — a re-submitted scan returns the stored result instead of
  destroying it and re-billing the API. *(Fixed a real data-destroying bug.)*
- `GET /api/v1/vision/result/:apparel_id` for recovery without re-uploading photos.
- Results are never purged on delivery.

**Fault handling**
- `geminiErrors.ts`: ten stable fault codes, four dispositions, `limit: 0` disambiguation.
- Retry with exponential backoff, jitter, and optional fallback model.
- Failed renders retry across nights up to `RENDER_MAX_ATTEMPTS`.

**Control channel**
- `control.db`: status + heartbeat, coalesced append-only events, command lifecycle.
- 31-code message catalogue with severities, hints, and a separate translations table.
- Watermark-based flywheel purge; watermarkless purges rejected.
- Pause state persisted, surviving restarts.

**Credentials**
- UI-submitted keys, validated by live probe before adoption, encrypted at rest.
- No fallback to stale keys; missing keys raise `VISION_NOT_CONFIGURED` and pause.

**Correctness fixes found while building**
- System instruction and response schema now generate their enum lists from the taxonomy files,
  so a 253-item `sub_category` list cannot desynchronise prompt from matcher.
- `tests/` was outside `tsconfig.json`'s include and had never been typechecked; a separate
  `tsconfig.build.json` now keeps tests out of `dist` while typechecking them.
- Settings-reload wiring moved out of `index.ts`, where any other entry point silently lost it.

**Test suites**

| Suite | Checks | Needs API |
|---|---|---|
| `smoke.ts` | 57 | no |
| `durability.ts` | 38 | yes (degrades to skips) |
| `settingsAndDelivery.ts` | 32 | partly (offline paths always run) |
| `contractQueries.ts` | 30 | no |
| `errorClassification.ts` | 26 | no |
| **Total** | **253** | all pass with no network |
