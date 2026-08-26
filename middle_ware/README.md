# Apparel Vision Processing Middleware

Express/TypeScript middleware bridging the Android scanner fleet (10 devices) and the
Gemini Vision API. Implements the locked contract in [`api_contract.md`](api_contract.md)
and the build spec in [`server_specification.json`](server_specification.json).

All operator data stays on the VPS. The only outbound traffic is the Gemini vision and
image-render calls.

---

## Quick start

```bash
npm install
cp .env.example .env          # then fill in JWT_SECRET, APP_MASTER_PASSWORD, GEMINI_API_KEY
npm run convert:translations  # data/translations.csv -> data/legalArmenianMap.json
npm run build
npm start                     # or: npm run dev
```

`npm test` runs the offline smoke suite (55 checks, no API key needed).

---

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Fast startup check for the Android client |
| `POST` | `/api/v1/auth/login` | none | Master password → 30-day JWT |
| `POST` | `/api/v1/vision/extract` | Bearer | multipart, ≤8 images; the main pipeline |
| `PUT` | `/api/v1/flywheel/confirm/:apparel_id` | Bearer + key | **Hidden** — binds ground truth |
| `GET` | `/api/v1/flywheel/stats` | Bearer + key | **Hidden** — buffer occupancy |
| `GET` | `/api/v1/flywheel/sample/:apparel_id` | Bearer + key | **Hidden** — inspect one sample |
| `GET` | `/catalog/IMG_<apparel_id>.jpg` | none | Static studio renders |

Errors always use the contract envelope: `{ status, error_code, message }`.

### The extract pipeline

```
POST /api/v1/vision/extract
        │
        ├── cloned_from set? ──► read parent from server_scans.db
        │                        rebind under new apparel_id, return   (Gemini never called)
        │
        └── otherwise ─────────► persist images to uploads/<apparel_id>/
                                 Gemini vision call (retry ×3, optional fallback model)
                                 weights array  ──► netto / brutto
                                 free text      ──► canonical enum keys (Fuse.js)
                                 write server_scans.db
                                 screen confidences ──► flywheel.db if any field is low
                                 return payload + pre-generated catalog URL
```

`catalog_image_url` is computed synchronously from `SERVER_HOST` and returned immediately —
the file it points at is produced by the 20:00 cron job that night.

---

## Business rules

**Weights.** Gemini returns every scale reading in a `weights` array. Two readings →
heaviest becomes `brutto`, lightest becomes `netto`, compared on normalised grams so a
mixed-unit pair (`1.2 kg` vs `950g`) ranks correctly while the operator-facing string is
preserved verbatim. One reading → `netto = brutto`. Zero readings → both `""` at
confidence `0.0`. See [`src/utils/weights.ts`](src/utils/weights.ts).

**Fuzzy normalisation.** `sub_category`, `country_of_origin`, `category`, `color`,
`gender` and `season` are snapped from free text onto canonical keys through three tiers:
exact map → punctuation-stripped map → Fuse.js search. A memo cache fronts all three.
Measured: **0.001 ms** cached, **1.4 ms** worst case (unmatchable input against the
280-entry country index) — inside the 2 ms budget. Nothing is invented: text that clears
no threshold is passed through unchanged. See [`src/utils/fuzzyMatcher.ts`](src/utils/fuzzyMatcher.ts).

**Cloning.** `cloned_from` short-circuits the whole vision path. The child inherits the
parent's image paths rather than duplicating bytes on disk.

---

## Dual-database architecture

Two physically separate SQLite files, so no dashboard query can reach training data.

**`data/server_scans.db`** — operational, consumed by clients and dashboards.
`apparel_id` PK, `cloned_from`, `username`, `timestamp`, `raw_json_data`, `key_photo_path`,
`image_paths`, `catalog_image_url`, `rendering_status`, `render_attempts`, `render_error`.

**`data/flywheel.db`** — hidden training corpus. Table `flywheel_training`:
`apparel_id` PK, `key_photo_path`, `raw_images_paths`, `unconfirmed_gemini_json`,
`confirmed_json`, `catalog_render_path`, `lowest_confidence_score`, `created_at`,
`confirmed_at`.

A scan is captured when **any** field scores below `FLYWHEEL_CONFIDENCE_THRESHOLD`
(default `0.85`). Capture is best-effort and wrapped in try/catch — the hidden flywheel can
never fail an operator's scan.

**FIFO ring buffer.** Capacity is enforced inside the insert transaction, trimming to
`FLYWHEEL_MAX_RECORDS` (default 10,000) so the cap holds even under concurrent writes.

A full training row accumulates over time:

| Stage | Column filled |
| --- | --- |
| Low-confidence scan | `raw_images_paths`, `key_photo_path`, `unconfirmed_gemini_json` |
| Operator review (`PUT .../flywheel/confirm/:id`) | `confirmed_json`, `confirmed_at` |
| Nightly render | `catalog_render_path` |

---

## Overnight rendering

`node-cron` at `RENDER_CRON_SCHEDULE` (default `0 20 * * *`, timezone `Asia/Yerevan`).
Each pending record's key photo goes to the image model; output is written to
`public/catalog/IMG_<apparel_id>.jpg` — the exact path the client was handed at scan time —
and the path is synced into `flywheel.db` when that item is a training sample.

The queue also picks up records that failed on an earlier night while
`render_attempts < RENDER_MAX_ATTEMPTS`, so a transient outage self-heals. Records with no
key photo are marked `SKIPPED` and never retried. An overrunning batch will not overlap the
next trigger.

Run it on demand with `npm run render:now`.

---

## Bilingual Armenian export

`scripts/convertTranslations.ts` converts `data/translations.csv` (columns `english`,
`armenian`, optional `domain`) into `data/legalArmenianMap.json`. It never runs in the
request path.

[`src/services/exportService.ts`](src/services/exportService.ts) maps extracted English
values to legal Armenian text and emits a BOM-prefixed bilingual CSV (Excel opens the
Armenian script correctly). Material is handled specially — a composition string is split
per fibre with percentages preserved:

```
38% Cotton 27% Wool 20% Polyamide 15% Polyester
  -> 38% բամբակ, 27% բուրդ, 20% պոլիամիդ, 15% պոլիեսթեր
```

Lookup is strict by design: an unmapped term is reported in `missing_translations`, never
guessed. A wrong Armenian legal term on a customs declaration is worse than a flagged gap.

---

## Security

- `GEMINI_API_KEY` lives only in server `process.env`; it never reaches a device.
- JWT bearer auth on every `/api/v1` route except login; 30-day expiry.
- Master password compared in constant time; login has its own tighter rate limit.
- `express-rate-limit` at 60 req/min per IP, Helmet headers, CORS allowlist.
- `trust proxy` is on for correct client IPs behind Caddy/nginx.
- Hidden flywheel routes answer **404** (not 401) when `FLYWHEEL_ADMIN_KEY` is set and the
  `x-flywheel-key` header is missing, so their existence is not advertised.
- Uploads are MIME-filtered and size-capped; barcodes are sanitised before use in paths.

---

## Layout

```
src/
  config/env.ts            validated environment, package-root resolution
  db/operationalDb.ts      server_scans.db
  db/flywheelDb.ts         flywheel.db + FIFO ring buffer
  middleware/              auth, upload, rate limit, error envelope
  routes/                  health, auth, vision, flywheel (hidden)
  services/
    geminiService.ts       the only egress to Google; retry + fallback
    visionService.ts       clone / extract / normalise / persist / screen
    flywheelService.ts     confidence screening and capture
    renderService.ts       studio render batch
    cronService.ts         20:00 scheduler
    exportService.ts       Armenian legal output
    storageService.ts      image persistence, deterministic catalog URLs
  utils/                   fuzzyMatcher, weights, logger
  data/taxonomy/           subCategories.json, enums.json, countries.json
scripts/                   convertTranslations.ts, runRenderJob.ts
tests/                     smoke.ts, liveExtract.ts, cronCheck.ts
```

---

## Two things needing your input

**1. `sub_category` taxonomy is a placeholder.** The build spec says 253 options; the locked
contract lists 14. The matcher reads its list from
[`src/data/taxonomy/subCategories.json`](src/data/taxonomy/subCategories.json), currently
seeded with the contract's 14. Drop the real 253-item list into that file — same
`{ "key": ..., "aliases": [...] }` shape — and both the matcher and the export pick it up
with no code change. Add matching rows to `data/translations.csv` and re-run
`npm run convert:translations` for the Armenian side.

**2. `data/translations.csv` is a seed, not the client's file.** It contains 140 terms I
wrote to cover every enum value, the common apparel origin countries, and the usual fibre
names. Replace it with the client's authoritative legal wording before any real customs
export.

## Model note

The spec pins `gemini-2.5-flash`, but that model now returns
`404 — no longer available to new users` on this API key. The default is
`gemini-3.7-flash` (verified working); `GEMINI_VISION_MODEL` and `GEMINI_IMAGE_MODEL`
override it without a code change. Image generation returned
`429 — quota exceeded` on the current key, so the render path needs billing enabled before
it can run.
