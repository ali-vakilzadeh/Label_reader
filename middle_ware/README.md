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
cp .env.example .env   # then fill in JWT_SECRET, APP_MASTER_PASSWORD, GEMINI_API_KEY
npm run build
npm start              # or: npm run dev
```

`npm run test:all` runs every offline suite — 355 checks, no API key or network needed.

**Deploying to a server?** Follow [`setup.md`](setup.md).

### Test operator accounts

On a **fresh install** the server seeds three throwaway accounts so devices can be tested before
the Web UI exists:

| Username | Password |
|---|---|
| `minelli` | `minelli` |
| `karen` | `karen` |
| `ali` | `ali` |

They are created only when no accounts exist at all, so they can never resurrect an account an
administrator removed. **Set `SEED_TEST_ACCOUNTS=false` before production** — the boot log warns
about them every time until you do.

---

## How extraction works

Two kinds of field, handled deliberately differently:

| | Fields | Gemini's job | Middleware's job |
|---|---|---|---|
| **Reported** | `sub_category`, `brand_name`, `country_of_origin`, `material` | Transcribe what is printed on the label, verbatim. **No option list is sent.** | A local selector replaces the transcription with the closest entry from the client table |
| **Constrained** | `category`, `color`, `gender`, `season` | Choose one option from the list in the prompt | Value used **exactly as returned** |

The reference tables run to 1,441 entries (295 sub-categories, 839 brands, 222 countries,
85 materials). Sending them on every request would bloat cost and latency, and push the model
toward picking a plausible-looking option instead of reading the label. So it reads, and the
server decides.

When nothing in the table is close enough, the transcription is kept unchanged — a wrong table
entry is worse than an unmatched one.

**Tables live as committed, hand-editable data**, not code:

```
middle_ware/reference_data/*.csv    the client's tables: armenian, id, english
```

One copy, shipped with the server. The middleware reads only the English column at boot; the
dashboard reads the same files for Armenian and the numeric ids. Customs codes are dashboard-only
too. **To change a table, edit the CSV and restart** — no build step, no parser, no second copy
to keep in sync.

`category` is the exception: the client has no table for it, so its three values stay in
`src/data/taxonomy/enums.json`.

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Fast startup check for the Android client |
| `POST` | `/api/v1/auth/login` | none | Operator account or master password → 30-day JWT |
| `POST` | `/api/v1/vision/extract` | Bearer | multipart, ≤8 images. **Always 202** — stores and queues |
| `GET` | `/api/v1/vision/result/:apparel_id` | Bearer | Fetch one result; never purged |
| `GET` | `/api/v1/vision/results?ids=` | Bearer | Batch fetch, max 100 ids |
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
                                 write server_scans.db (extraction_status = PENDING)
                                 return 202 + PENDING_AI + catalog URL   ◄── no AI call here
                                              │
        background drain worker ──────────────┘
                                 Gemini vision call (retry, optional fallback model)
                                 weights array   ──► netto / brutto
                                 reported fields ──► local table selection
                                 screen confidences ──► flywheel.db if any field is low
                                 extraction_status = COMPLETED
```

The submit path never contacts the AI, so it returns in milliseconds and an outage costs
latency, never data. The device polls `/vision/result/:apparel_id` for the outcome.

`catalog_image_url` is computed synchronously from `SERVER_HOST` and returned immediately —
the file it points at is produced by the 20:00 cron job that night.

---

## Business rules

**Weights.** Gemini returns every scale reading in a `weights` array. Two readings →
heaviest becomes `brutto`, lightest becomes `netto`, compared on normalised grams so a
mixed-unit pair (`1.2 kg` vs `950g`) ranks correctly while the operator-facing string is
preserved verbatim. One reading → `netto = brutto`. Zero readings → both `""` at
confidence `0.0`. See [`src/utils/weights.ts`](src/utils/weights.ts).

**Local table selection.** The four reported fields are snapped onto client table entries
through three tiers: exact map → punctuation-stripped map → Fuse.js search, with a memo cache
in front. Measured at real table sizes: **0.001 ms** cached, **0.0006 ms** for a realistic
mixed workload, **1.5 ms** worst case (unmatchable text against the 839-entry brand index).
Nothing is invented — text that clears no threshold passes through unchanged.
See [`src/utils/fuzzyMatcher.ts`](src/utils/fuzzyMatcher.ts).

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

## Bilingual export — dashboard scope

Armenian text and the numeric taxonomy ids are **not used by the middleware**. It works in
canonical English and emits English. The dashboard joins to Armenian and the ids using
[`reference_data/*.csv`](../reference_data/), which carry `english, armenian, id` per table.
Customs codes are likewise dashboard-only.

`src/services/exportService.ts`, `scripts/convertTranslations.ts` and `data/translations.csv`
predate that decision and are no longer wired into the server. They are retained for now so the
work can be moved to the dashboard rather than rewritten.

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

## Open item

The client reference tables changed the values on the wire: `color` now has 26 options (was 9),
`gender` uses `Men`/`Women` (was `male`/`female`), `season` uses `Autumn` (was `fall`), and
`sub_category` has 295 entries (was 14). `api_contract.md` still documents the old enums and
needs a coordinated update with the Android developer.

---

## Model note

The spec pins `gemini-2.5-flash`, but that model now returns
`404 — no longer available to new users` on this API key. The default is
`gemini-3.7-flash` (verified working); `GEMINI_VISION_MODEL` and `GEMINI_IMAGE_MODEL`
override it without a code change. Image generation returned
`429 — quota exceeded` on the current key, so the render path needs billing enabled before
it can run.
