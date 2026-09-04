# API Contract Specification

**Version 1.4** · Binding contract between the Android client and the middleware.
Supersedes v1.3. Changes are listed in [§10](#10-migration-from-v13).

> **v1.4 is the first change to the response shape since v1.1.** Three additions, all driven by
> client decisions of 2026-09-04 (`docs/client_decisions_2026-09-04.md`):
>
> 1. **`data` grows from 12 to 13 fields** — `care_info` carries the URL behind a garment's care
>    QR code ([§8.4](#84-free-text-fields)).
> 2. **`suggested_key_photo_index`** — the server's suggestion for the main product photo. An
>    envelope field; the operator still decides ([§4.2](#42-submit-a-scan--post-apiv1visionextract)).
> 3. **`data_hy`** — the Armenian rendering of every translatable field, so the app never has to
>    parse or translate ([§8.3](#83-showing-values-in-armenian)).
>
> **One existing field changes meaning:** `material` is now the **full composition string**
> (`80% Cotton 20% Polyester`), not a single fibre name. `size` is now the **European value
> only**. Both are described in [§8](#8-field-vocabularies).
>
> v1.3 added [`GET /api/v1/reference-tables`](#46-reference-tables--get-apiv1reference-tables),
> serving the client's seven taxonomy tables as English key + Armenian label + numeric id, so the
> app can show the operator **Armenian** while still storing and sending the canonical **English**
> key.
>
> v1.2 replaced the controlled vocabularies with the client's reference tables: the values sent
> for `sub_category`, `brand_name`, `country_of_origin`, `material`, `color`, `gender` and
> `season` changed — see [§8](#8-field-vocabularies).
>
> v1.1 made extraction fully asynchronous: `POST /vision/extract` stores the scan, answers
> `202` immediately, and the client polls for the result.

---

## Contents

1. [Base configuration](#1-base-configuration)
2. [The storage invariant](#2-the-storage-invariant)
3. [Processing states](#3-processing-states)
4. [Endpoints](#4-endpoints)
5. [Polling guidance](#5-polling-guidance)
6. [Error responses](#6-error-responses)
7. [Client state machine](#7-client-state-machine)
8. [Field vocabularies](#8-field-vocabularies)
9. [Working in Armenian](#9-working-in-armenian)
10. [Migration from v1.3](#10-migration-from-v13)
11. [Migration from v1.2](#11-migration-from-v12)
12. [Migration from v1.1](#12-migration-from-v11)

---

## 1. Base configuration

| | |
|---|---|
| **Protocol** | `HTTPS` |
| **Port** | `443` (standard) or `3000` |
| **Base path** | `/api/v1` |
| **Authentication** | `Authorization: Bearer <JWT_TOKEN>` |
| **Token lifetime** | 30 days |

---

## 2. The storage invariant

This is the single rule that governs client retry behaviour. It holds on **every** endpoint.

| Response | Meaning | Client action |
|---|---|---|
| **2xx** | The server **has** your scan. It is on disk and recorded. | **Never resend the images.** Poll for the result. |
| **4xx** | The request was malformed or unauthorised. Nothing was stored. | Fix the request. Resending unchanged will not help. |
| **5xx** | The server does **not** have your scan. | Resend the whole request, including images. |

A `2xx` is a durability guarantee: once given, the scan survives server restarts, AI outages,
and paused processing. It is never dropped.

> v1.0 violated this: a stored-but-unprocessed scan returned `503`, which told the client to
> resend something the server already held. That response no longer exists.

---

## 3. Processing states

Every response that concerns a scan carries `processing_status`.

| `processing_status` | Meaning | Terminal? | `data` present |
|---|---|---|---|
| `PENDING_AI` | Stored; extraction queued or in progress | No — keep polling | `null` |
| `READY_TO_CONFIRM` | Extraction complete; ready for operator review | **Yes** | Yes |
| `NEEDS_ATTENTION` | Stored, but cannot be extracted from these images | **Yes** | `null` |

`data_hy` and `suggested_key_photo_index` follow `data` exactly: both are present when `data` is,
and `null` when it is not. A client that branches on `data != null` needs no new checks.

`NEEDS_ATTENTION` means a person must act — usually re-photograph the item. The record and its
photos are **never deleted**; the scan is preserved indefinitely for review.

**Stop polling on any terminal state.**

### Two orthogonal fields

Do not conflate these:

- **`status`** — `"success"` or `"error"`. Describes the **HTTP request**.
- **`processing_status`** — describes the **scan's position in the pipeline**.

`status: "success"` with `processing_status: "PENDING_AI"` is the normal, healthy response to a
new scan.

---

## 4. Endpoints

### 4.1 Authentication — `POST /api/v1/auth/login`

Unchanged in shape from v1.0. Two things to know about behaviour:

- Operators may now have **individual accounts** managed from the Web UI. A username that has an
  account is validated against it; a username that does not falls back to the shared
  `APP_MASTER_PASSWORD` while the fleet is being migrated.
- A token can be **revoked before it expires**. If an operator is disabled or their password is
  changed, their next authenticated request returns `401 ACCOUNT_DISABLED` or
  `401 TOKEN_REVOKED`. Treat both as "log in again"; only `ACCOUNT_DISABLED` should tell the
  operator to find a supervisor.

**Request** (`application/json`):

```json
{
  "password": "user_device_password",
  "username": "emp_402"
}
```

**Response `200 OK`:**

```json
{
  "status": "success",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": "30d"
}
```

---

### 4.2 Submit a scan — `POST /api/v1/vision/extract`

Stores the scan and returns immediately. **Never blocks on the AI.**

- **Request type:** `multipart/form-data`
- **Headers:** `Authorization: Bearer <JWT_TOKEN>`

| Field | Type | Required | Description |
|---|---|---|---|
| `apparel_id` | String | **Yes** | Scanned barcode, e.g. `"890123456789"` |
| `username` | String | **Yes** | Operator ID. Falls back to the JWT's username if omitted |
| `key_photo_index` | Integer | **Yes** | Zero-based index (0–7) of the main product photo. **Still required in v1.4** — the operator's choice remains the authority. `suggested_key_photo_index` in the response is a pre-selection, not a replacement |
| `cloned_from` | String | *Optional* | Parent barcode. If present the server copies the parent record and never calls the AI |
| `images` | File array | **Conditional** | Up to 8 JPEG/PNG/WebP files, ≤12 MB each. Required unless `cloned_from` is set |

#### Response `202 Accepted` — the normal case

**All successful submissions return `202`**, including clones and duplicate submissions. The
client branches on `processing_status`, never on the status code.

```json
{
  "status": "success",
  "apparel_id": "890123456789",
  "cloned_from": null,
  "timestamp": "2026-08-27T14:36:09Z",
  "catalog_image_url": "https://vps-domain.com/catalog/IMG_890123456789.jpg",
  "processing_status": "PENDING_AI",
  "queue_depth": 12,
  "estimated_wait_seconds": 60,
  "retry_after_seconds": 60,
  "blocking_fault": null,
  "suggested_key_photo_index": null,
  "data": null,
  "data_hy": null
}
```

| Field | Type | Notes |
|---|---|---|
| `processing_status` | String | See [§3](#3-processing-states) |
| `queue_depth` | Integer | Scans queued ahead of this one |
| `estimated_wait_seconds` | Integer \| null | Estimated time until ready. `null` when processing is paused and no estimate is meaningful |
| `retry_after_seconds` | Integer | **When to poll next.** Always present; clamped to 5–120 s |
| `blocking_fault` | String \| null | Set when processing is paused, e.g. `VISION_BILLING_REQUIRED`. Advisory — display as "processing paused, contact supervisor" |
| `suggested_key_photo_index` | Integer \| null | **v1.4.** Zero-based index of the photo the model judged to be the main product shot. `null` until extraction completes, and `null` whenever the model could not choose. Pre-select it; let the operator override |
| `data` | Object \| null | Populated **only** when `processing_status` is `READY_TO_CONFIRM`. **13 fields** since v1.4 |
| `data_hy` | Object \| null | **v1.4.** Armenian labels for `data`, same 13 keys. See [§8.3](#83-showing-values-in-armenian) |
| `catalog_image_url` | String | Permanent, deterministic. Valid immediately; the image itself is rendered overnight |

#### When `data` arrives in the POST response

Two cases return `READY_TO_CONFIRM` immediately, because neither needs the AI:

1. **Cloning** (`cloned_from` set) — the parent's values are copied.
2. **Duplicate submission** — the same `apparel_id` with byte-identical images was already
   extracted. The stored result is replayed; the AI is not called again and the stored result is
   not overwritten.

```json
{
  "status": "success",
  "apparel_id": "890123456790",
  "cloned_from": "890123456789",
  "timestamp": "2026-08-27T14:36:09Z",
  "catalog_image_url": "https://vps-domain.com/catalog/IMG_890123456790.jpg",
  "processing_status": "READY_TO_CONFIRM",
  "queue_depth": 0,
  "estimated_wait_seconds": 0,
  "retry_after_seconds": 5,
  "blocking_fault": null,
  "suggested_key_photo_index": 2,
  "data": {
    "brand_name":        { "value": "Nike",                      "confidence": 0.95 },
    "country_of_origin": { "value": "VIETNAM",                   "confidence": 0.88 },
    "size":              { "value": "EU 122/128",                "confidence": 0.90 },
    "color":             { "value": "Black",                     "confidence": 0.92 },
    "material":          { "value": "80% Cotton 20% Polyester",  "confidence": 0.85 },
    "original_price":    { "value": "$45.00",                    "confidence": 0.99 },
    "netto":             { "value": "240g",                      "confidence": 0.80 },
    "brutto":            { "value": "290g",                      "confidence": 0.80 },
    "category":          { "value": "clothing",                  "confidence": 0.90 },
    "sub_category":      { "value": "Trousers",                  "confidence": 0.85 },
    "gender":            { "value": "Unisex",                    "confidence": 0.75 },
    "season":            { "value": "All Seasons",               "confidence": 0.70 },
    "care_info":         { "value": "https://care.nike.com/x7f", "confidence": 0.60 }
  },
  "data_hy": {
    "brand_name":        null,
    "country_of_origin": null,
    "size":              null,
    "color":             "Սև",
    "material":          "80% Բամբակ, 20% Պոլիեսթեր",
    "original_price":    null,
    "netto":             null,
    "brutto":            null,
    "category":          "Հագուստ",
    "sub_category":      "Տաբատ",
    "gender":            "Ունիսեքս",
    "season":            "Բոլոր եղանակները",
    "care_info":         null
  }
}
```

The `data` object always contains all **13 fields**, each as `{ value, confidence }`.
An unreadable field is `{ "value": "", "confidence": 0.0 }` — never omitted, never `null`.

`data_hy` always contains the **same 13 keys**. Its values are plain strings or `null`, with no
confidence — the confidence belongs to the extraction, not to the translation. **`null` means
"no Armenian exists for this field — display the English value from `data`."** It never means
"show nothing". Seven keys are `null` by design: `brand_name` and `country_of_origin` (English
everywhere, including on the paperwork — client decision 2026-08-30), the free-text `size`,
`original_price`, `netto` and `brutto`, and the URL `care_info`.

---

### 4.3 Fetch one result — `GET /api/v1/vision/result/:apparel_id`

Uploads nothing. Results are **never purged**, so this may be called at any later time —
including after an app reinstall.

**Headers:** `Authorization: Bearer <JWT_TOKEN>`

**Response `200 OK`:**

```json
{
  "status": "success",
  "apparel_id": "890123456789",
  "cloned_from": null,
  "timestamp": "2026-08-27T14:36:09Z",
  "catalog_image_url": "https://vps-domain.com/catalog/IMG_890123456789.jpg",
  "processing_status": "READY_TO_CONFIRM",
  "queue_depth": 0,
  "estimated_wait_seconds": 0,
  "retry_after_seconds": 5,
  "blocking_fault": null,
  "attention_reason": null,
  "suggested_key_photo_index": 2,
  "data": { "…13 fields…" },
  "data_hy": { "…13 keys, string or null…" }
}
```

`attention_reason` is non-null only when `processing_status` is `NEEDS_ATTENTION`, and gives a
short human-readable cause.

Returns `404 SCAN_NOT_FOUND` if the server has no scan with that `apparel_id`.

---

### 4.4 Fetch many results — `GET /api/v1/vision/results`

Batch form of §4.3, for draining a queue after an outage. **Prefer this** when polling more than
one scan.

**Query:** `?ids=890123456789,890123456790,890123456791` — maximum **100** ids per request.

**Response `200 OK`:**

```json
{
  "status": "success",
  "results": [
    { "apparel_id": "890123456789", "processing_status": "READY_TO_CONFIRM", "data": { "…" }, "…": "…" },
    { "apparel_id": "890123456790", "processing_status": "PENDING_AI",       "data": null,    "…": "…" }
  ],
  "not_found": ["890123456791"],
  "queue_depth": 4,
  "retry_after_seconds": 20
}
```

Each entry in `results` has the same shape as §4.3. Ids the server does not know are listed in
`not_found` rather than causing an error — a partially-unknown batch still succeeds.

---

### 4.5 Health check — `GET /health`

No authentication. Used for the app's startup connectivity check.

```json
{
  "status": "ok",
  "uptime_seconds": 142050,
  "version": "1.1.0",
  "api_contract": "1.4",
  "gemini_ready": true,
  "reference_version": "93894da042acfa96"
}
```

`gemini_ready: false` means the AI is not currently usable. **Scans are still accepted and
stored** — the app should not block scanning on this flag; it is for display only.

`reference_version` is the fingerprint of the vocabulary the server is currently serving. It is
the cheapest way for the app to notice a supervisor changed a table: compare it with the version
stored alongside the cached copy, and only call
[§4.6](#46-reference-tables--get-apiv1reference-tables) when they differ. This call needs no
authentication, so it works before login.

---

### 4.6 Reference tables — `GET /api/v1/reference-tables`

The client's seven taxonomy tables: the canonical **English** key, the client's **Armenian**
label, and the client's **numeric id**. This is what lets an operator work in Armenian without
anything being translated at runtime — see [§9](#9-working-in-armenian).

**Headers:** `Authorization: Bearer <JWT_TOKEN>`, and `If-None-Match: "<version>"` when the app
already holds a copy.

**Response `200 OK`:**

```json
{
  "status": "success",
  "version": "93894da042acfa96",
  "generated_at": "2026-09-04T05:19:13Z",
  "tables": {
    "sub_category": {
      "bilingual": true,
      "entries": [
        { "en": "Hoodie",   "hy": "Հուդի",  "id": 18 },
        { "en": "Trousers", "hy": "Տաբատ",  "id": 88 }
      ]
    },
    "brand": {
      "bilingual": false,
      "entries": [
        { "en": "Nike", "hy": null, "id": 512 }
      ]
    },
    "country":  { "bilingual": false, "entries": ["…"] },
    "material": { "bilingual": true,  "entries": ["…"] },
    "color":    { "bilingual": true,  "entries": ["…"] },
    "gender":   { "bilingual": true,  "entries": ["…"] },
    "season":   { "bilingual": true,  "entries": ["…"] }
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `version` | String | Content fingerprint. Also the `ETag`, and also `reference_version` in `/health` |
| `generated_at` | String | When the server last read the tables from disk |
| `tables.<name>.bilingual` | Boolean | `false` for `brand` and `country` — the client writes both in English everywhere, **including on the paperwork**. Their `hy` is always `null`, by design |
| `entries[].en` | String | **The canonical key.** The only value the app ever stores, exports, or sends back |
| `entries[].hy` | String \| null | The Armenian label to display. `null` means show the English word |
| `entries[].id` | Integer \| null | The client's own id, stable across versions. Use it as the key when remembering a selection |

**Response `304 Not Modified`** when `If-None-Match` matches the current version. No body. This
is the normal case, so the call is cheap enough to make at every login.

The full payload is roughly 60 KB, and 1,479 entries across the seven tables.

#### How the app should use it

1. **Fetch at login**, sending `If-None-Match` with the cached version. On `304`, keep what you
   have. On `200`, replace the whole cached copy and store the new `version`.
2. **Never ship a hardcoded copy.** These tables grow, and a supervisor can add a row mid-shift.
3. **Cache it on the device** and keep working from the cache when the server is unreachable.
   A stale vocabulary is not an error — the operator can still scan and confirm.
4. **Key everything on `en`.** Display `hy`; store, export and transmit `en`.

`brand`, `country`, `material` and `sub_category` may still contain a value that is **not** in
any table, because the server returns the label's transcription unchanged when nothing matches
([§8](#8-field-vocabularies)). Treat all four as free text for storage, and use the table only
to drive the picker.

---

## 5. Polling guidance

1. **Honour `retry_after_seconds`.** It is derived from real queue depth and is clamped to
   5–120 s. Do not poll faster.
2. **Use the batch endpoint** ([§4.4](#44-fetch-many-results--get-apiv1visionresults)) when more
   than one scan is outstanding.
3. **Stop on terminal states** — `READY_TO_CONFIRM` and `NEEDS_ATTENTION`. Never poll them again.
4. **Back off when paused.** If `blocking_fault` is non-null, the wait is operator-dependent;
   poll at the 120 s ceiling and surface the pause in the UI.
5. **Poll only what you are waiting for.** The device's local queue is the authority on what is
   outstanding.
6. **Surviving a restart:** because `apparel_id` is the barcode, results can always be re-fetched
   without any server-issued handle.

### Estimating wait for the operator

`estimated_wait_seconds = queue_depth × seconds_per_item` (server-configured, default 5 s).
It is an estimate for display — "results in about 2 minutes" — not a guarantee.
When processing is paused it is `null`; show "paused" rather than a time.

---

## 6. Error responses

All errors share one envelope:

```json
{
  "status": "error",
  "error_code": "INVALID_IMAGE_PAYLOAD",
  "message": "Failed to extract values from labels. At least one readable image is required."
}
```

Branch on `error_code`, never on `message`.

| `error_code` | HTTP | Stored? | Client action |
|---|---|---|---|
| `MISSING_APPAREL_ID` | 400 | No | Fix request |
| `MISSING_USERNAME` | 400 | No | Fix request |
| `INVALID_IMAGE_PAYLOAD` | 400 | No | No images, unsupported type, >8 files, or a file >12 MB |
| `INVALID_CREDENTIALS` | 400 / 401 | No | Re-prompt for the device password |
| `ACCOUNT_DISABLED` | 401 | No | This operator account was disabled. Show "contact a supervisor" — retrying will not help |
| `TOKEN_REVOKED` | 401 | No | The account password changed. Prompt for login again |
| `UNAUTHORIZED` | 401 | No | Missing/malformed `Authorization` header |
| `INVALID_TOKEN` | 401 | No | Re-authenticate |
| `TOKEN_EXPIRED` | 401 | No | Re-authenticate |
| `PARENT_NOT_FOUND` | 404 | No | The `cloned_from` barcode is unknown to the server |
| `SCAN_NOT_FOUND` | 404 | No | No scan with that `apparel_id` |
| `RATE_LIMITED` | 429 | No | Back off; 60 requests/min per IP |
| `PARENT_RECORD_CORRUPT` | 500 | No | Report to supervisor |
| `INTERNAL_ERROR` | 500 | **No** | Safe to resend the whole request |

Per [§2](#2-the-storage-invariant), no `4xx` or `5xx` ever means "stored". A stored scan always
produces `2xx`.

> **Removed in v1.1:** `VISION_QUEUED` (503) and `VISION_UNAVAILABLE` (503). Those conditions now
> return `202` with `processing_status: "PENDING_AI"`, because the scan *is* stored.

---

## 7. Client state machine

```
   capture photos
        │
        ▼
  Room: STATUS_PENDING_VISION (0)
        │
        ▼
  POST /api/v1/vision/extract
        │
        ├── 5xx ──────────► keep in Room, resend later (server does NOT have it)
        ├── 4xx ──────────► mark Failed (3); operator fixes the item
        │
        └── 202 ──────────► server HAS it. Never resend images.
                 │
                 ├── READY_TO_CONFIRM ──► Room status 1, show review screen
                 │
                 ├── NEEDS_ATTENTION ───► Room status 3, flag for supervisor
                 │
                 └── PENDING_AI ────────► stay at status 0
                          │
                          │   wait retry_after_seconds
                          ▼
                   GET /vision/results?ids=…
                          │
                          ├── PENDING_AI ────────► wait again
                          ├── READY_TO_CONFIRM ──► Room status 1, review
                          └── NEEDS_ATTENTION ───► Room status 3, flag
```

State mapping:

| `processing_status` | Room `status` | Meaning |
|---|---|---|
| `PENDING_AI` | `0` Pending AI Vision | Queued on the server |
| `READY_TO_CONFIRM` | `1` Extracted / In Review | Show the review screen |
| `NEEDS_ATTENTION` | `3` Failed | Needs a person |

Local photos may be deleted once a `2xx` is received *and* the result has been fetched; the
server retains its own copies regardless.

---

## 8. Field vocabularies

The controlled values come from the client's reference tables, which ship with the server in
`middle_ware/reference_data/*.csv`. Two kinds of field:

### 8.1 Selected locally (long tables)

| Field | Entries | How the value is produced |
|---|---|---|
| `sub_category` | 295 | The model transcribes what the label says; the server maps it to the closest table entry |
| `brand_name` | 839 | same |
| `country_of_origin` | 222 | same. **UPPERCASE**, e.g. `VIETNAM`, `ITALY` |
| `material` | 85 | **Changed in v1.4.** The **full composition string**, e.g. `80% Cotton 20% Polyester`. The 85 entries are the *fibre names*; the server matches each fibre segment individually and keeps the percentages |

These tables are far too long to enumerate here and **will grow**. Do not hardcode them in the
app. When nothing matches closely enough the server returns the transcription unchanged, so the
client must accept a value outside the table.

#### `material` in v1.4 — read this if the app parsed it before

v1.2 sent one fibre name and v1.3 kept that. **v1.4 sends the whole composition**, because the
client needs the complete information on the paperwork:

```
label reads         100% ALGODÓN / ALGODÃO / COTTON / COTON / COTONE
server sends        100% Cotton

label reads         80% ALGODON 20% POLIESTER
server sends        80% Cotton 20% Polyester

shoe, no printed composition
server sends        Leather                    confidence <= 0.50 (inferred, not read)
```

Three properties the client can rely on:

1. **One language — English.** A composition printed in six languages is collapsed to one
   English wording before it is sent. `algodón`, `algodão` and `cotone` all arrive as `Cotton`.
2. **Invariant fibre names.** The same fibre always arrives spelled the same way, because each
   segment is matched onto the 85-entry table. This is what keeps the value groupable.
3. **Percentages preserved, verbatim.** The server never adds, divides or normalises them, and
   a fibre absent from the table is passed through as transcribed rather than forced onto a
   near-miss.

**Display it as one string.** The app should not split, re-order or re-percentage it. Its
Armenian rendering arrives ready-made in `data_hy.material`.

The full lists are in the CSVs above, and in `docs/client_data/` for reference.

### 8.2 Chosen by the model (short enums)

These are fixed and safe to hardcode for display:

**`color`** — `Red`, `Yellow`, `Green`, `Blue`, `Purple`, `Grey`, `Orange`, `Brown`, `White`, `Pink`, `Turquoise`, `Ivory`, `Cream`, `Multicolored`, `Black`, `Gold`, `Silver`, `Milk`, `Dark red`, `Blue - Dark`, `Khaki`, `Blue - Navy`, `Green-Blue`, `Blue - Light`, `Black - White`, `no color`

**`gender`** — `Men`, `Women`, `Girls`, `Boys`, `Unisex`, `Baby Girl`, `Baby Boy`

**`season`** — `Summer`, `Autumn`, `Spring`, `Winter`, `All Seasons`

**`category`** — `shoe`, `clothing`, `accessories`

Values are case-sensitive and are sent exactly as listed.

**These four are safe to hardcode for *validation*, but not for *display*** — their Armenian
labels come from [§4.6](#46-reference-tables--get-apiv1reference-tables), and a supervisor can
add a value to any of them. Prefer the served table for anything the operator sees.

### 8.3 Showing values in Armenian

Everything on the wire is English. The Armenian the operator reads comes from two places, and
**v1.4 adds the first of them**:

| Armenian for | Comes from | Why |
|---|---|---|
| **AI results** — the values in `data` | **`data_hy`**, in the same response (v1.4) | `material` is a composition, not a table key: `80% Cotton 20% Polyester` cannot be looked up in one step. The server already renders compositions per fibre for the legal export, so it renders this one too |
| **Anything the operator picks or types** — pickers, type-ahead, filters, review-screen dropdowns | Device lookup against [§4.6](#46-reference-tables--get-apiv1reference-tables), cached | The app needs the whole vocabulary offline anyway, and a picker must list terms the AI never returned |

`data_hy` does not replace the reference tables — the app still fetches and caches them. It
removes the need to *parse* anything.

The lookup, for everything not covered by `data_hy`:

```
server sends            app displays              app stores / exports / sends
"Trousers"       ──►    "Տաբատ"            ──►    "Trousers"
"Blue - Navy"    ──►    "Կապույտ - Մուգ"   ──►    "Blue - Navy"
"Nike"           ──►    "Nike"             ──►    "Nike"     (brand: English by decision)
"Chartreuse"     ──►    "Chartreuse" ⚠     ──►    "Chartreuse"  (not in the table)
```

The rules, which are the same ones the dashboard follows:

1. **Never translate. Look up, or show the English word.** No machine translation, no
   transliteration, and never a blank cell. A term with no Armenian renders in English — that is
   correct behaviour, not a bug.
2. **`brand` and `country` display in English even in Armenian mode.** The client writes both in
   English everywhere including the paperwork (their decision, 2026-08-30). Their `hy` is `null`
   and no Armenian column will be added.
3. **`size` and `original_price` are never translated in either direction.** They are free text.
4. **Store the English key, always.** The CSV ledger, the API and the local database stay
   English. This is what keeps a value searchable and groupable: one garment type is one string,
   not five spellings of it.
5. **A value outside the table** still displays, marked as unmatched, and is stored verbatim.
   Do not force it onto the nearest entry.

---

### 8.4 Free-text fields

Four fields belong to no table. They are transcribed, never matched, and never translated —
their `data_hy` entry is always `null`.

| Field | Rule |
|---|---|
| `size` | **European value only** — see below |
| `original_price` | As printed, including the currency symbol. `€79.90`, `$45.00` |
| `netto`, `brutto` | As read from the scale display, including the unit. `240g` |
| `care_info` | A URL, or an empty string — see below |

#### `size` — the European value only (v1.4)

Labels routinely print one size in seven systems. The server reports **only the European one**,
with the prefix normalised to `EU` whether the label said `EU` or `EUR`:

```
label     US 6X/7  CA 6-8A  EUR 122/128  CN 130/64  MX 6-8A  AUS 7-8  UK 6-8Y
sends     EU 122/128
```

The value after the prefix is transcribed exactly as printed — `122/128` is not simplified,
split or converted.

**When the label carries no European reference**, the size is reported **as printed**, unchanged
and without an added prefix. A garment labelled only `XL`, or only `32W x 34L`, arrives as `XL`
and `32W x 34L`. The rule selects among competing size systems; it does not invent one.

#### `care_info` — the care QR code (v1.4)

Many garments carry a QR code linking to care and usage instructions. When one is visible in the
photos, the server returns the URL it encodes:

```json
"care_info": { "value": "https://care.example.com/x7f9", "confidence": 0.60 }
```

- **No QR code visible** → `{ "value": "", "confidence": 0.0 }`, like any other unreadable field.
- **Never translated.** `data_hy.care_info` is always `null`.
- **Treat it as untrusted text.** It is a string the server read off a photograph, not a verified
  link. Display it and store it; do not follow it automatically or render it as a live link
  without the operator choosing to open it.
- **Expect low confidence.** A QR read is more error-prone than a printed word, and a wrong URL
  cannot be spotted by eye. Values below the highlight threshold are normal here.

The app stores it and exports it as the CSV column `CareInfo`. It is not an operator-entered
field, though the operator may correct it like any other extracted value.

---

### 8.5 Where each of the 19 ledger columns comes from

The daily CSV (`Mobile_app/csv_export_format.txt`) has **19 columns**. Only 13 of them come from
this API. This table exists so the Android developer can see, in one place, what to expect from
the server and what the app must produce itself.

| # | CSV column | Source | API field |
|---|---|---|---|
| 1 | `Barcode` | **Device** — scanned or typed at capture | `apparel_id` (request) |
| 2 | `Brand` | AI | `data.brand_name` |
| 3 | `Category` | AI | `data.category` |
| 4 | `SubCategory` | AI | `data.sub_category` |
| 5 | `Gender` | AI | `data.gender` |
| 6 | `Season` | AI | `data.season` |
| 7 | `Size` | AI | `data.size` — EU only ([§8.4](#84-free-text-fields)) |
| 8 | `Color` | AI | `data.color` |
| 9 | `Material` | AI | `data.material` — full composition ([§8.1](#81-selected-locally-long-tables)) |
| 10 | `Country` | AI | `data.country_of_origin` |
| 11 | `OriginalPrice` | AI | `data.original_price` |
| 12 | `Netto` | AI | `data.netto` |
| 13 | `Brutto` | AI | `data.brutto` |
| 14 | `Timestamp` | **Device** — operator's confirmation time | — |
| 15 | `Operator` | **Device** — authenticated session | `username` (request) |
| 16 | `ExportBatch` | **Device** — assigned at export cut-off | — |
| 17 | `PackageCode` | **Operator** — typed before capture, sticky | **None.** Never crosses this API |
| 18 | `SetSize` | **Operator** — chosen in the review dialog | **None.** Never crosses this API |
| 19 | `CareInfo` | AI | `data.care_info` ([§8.4](#84-free-text-fields)) |

**`PackageCode` and `SetSize` are deliberately absent from this contract.** Both are entered by
the operator, neither is AI output, and the response `data` object is AI output only. They live
in the device database and the CSV, and nowhere else. The known consequence — a device wiped
before the daily export loses its package codes — is accepted (client decision, 2026-09-04).

The remaining API field, `catalog_image_url`, is not a CSV column; it is the permanent server-side
image reference used by the dashboard.

---

## 9. Working in Armenian

The operator-facing requirement is that AI results are **read** in Armenian and the operator's
decision is **made** in Armenian.

**v1.4 changes how the first half is delivered, not the principle.** Armenian now does cross the
wire, in `data_hy` — but only ever as a *label to display*. No Armenian value is stored,
exported, or sent back to the server, and no English value is ever replaced by one. The English
key remains the only thing that is written down anywhere.

### Why the values stay English

Asking the model to answer in Armenian, or translating its answer at runtime, produces a
different wording of the same term on different scans — `տաբատ`, `Տաբատ`, `շալվար` for one
garment. Those variants are stored, exported and reported as if they were different things,
which makes the ledger impossible to group, filter or total. One canonical English key with one
Armenian label attached to it is what makes Armenian reporting possible at all.

So the split is:

| Concern | Language | Where it lives |
|---|---|---|
| Extraction, storage, transport, CSV export | **English** | This contract |
| What the operator reads and picks from | **Armenian** | Device lookup, [§4.6](#46-reference-tables--get-apiv1reference-tables) |
| Legal and invoice output | **Armenian** | Dashboard, joined on the numeric id |

### Operator input

Selectors for `category`, `sub_category`, `gender`, `season`, `color` and `material` should be
**searchable pickers over the Armenian labels**, not free-text boxes. The operator searches and
reads Armenian; the app writes the English key behind it. This is the single most effective
thing the app can do to keep the data groupable, because it removes the opportunity to type a
variant spelling at all.

Where the operator must still type — a garment type genuinely absent from the 295 — store what
they typed, verbatim, and let it flow through as an unmatched value. The dashboard's review
queue picks it up, a supervisor decides the canonical English and Armenian for it, and it
appears in the next version of the table. Nothing is silently corrected on the device.

### When a table changes

A supervisor adding a term through the dashboard changes `version`. The app notices on its next
`/health` or `/api/v1/reference-tables` call and refreshes. No app release is involved, and
scans taken against the older vocabulary remain valid — the keys they carry are never renamed
or removed.

---

## 10. Migration from v1.3

**This one is not purely additive.** Two existing fields change their content, and the response
gains three things. Auth, endpoints, status codes, the `202`-always behaviour, the storage
invariant, polling and the error envelope are all **unchanged**.

### What changed

| Change | Impact on the client |
|---|---|
| `data` is **13 fields**, not 12 — `care_info` added | Any code asserting a field count, or iterating a fixed list of 12, must be updated |
| `data.material` is now a **composition string** | If the app treated it as a table key, stop. Display it as one string |
| `data.size` is now the **European value only**, prefixed `EU` | No parsing needed; the server has already chosen |
| `suggested_key_photo_index` added to the envelope | Pre-select this photo. Operator may override |
| `data_hy` added to the envelope | Use it for the Armenian rendering of AI results |
| `/health` reports `api_contract: "1.4"` | Informational |

### Client changes required

1. **Add `care_info`** to the local record, the review screen and the CSV export (19th column,
   header `CareInfo`). Expect an empty string when no QR code was visible, and expect low
   confidence when one was — see [§8.4](#84-free-text-fields).
2. **Stop treating `material` as a single fibre.** It is a composition. Do not split it, do not
   look it up as a key, do not re-order it.
3. **Render Armenian from `data_hy`,** not from a device-side lookup, for the fields it covers.
   `null` there means *display the English value* — never a blank.
4. **Pre-select `suggested_key_photo_index`** in the review UI, and keep sending the operator's
   `key_photo_index` on submit. The request field is unchanged and still required.
5. **Nothing else.** A v1.3 client that ignores all three new fields still works, except that it
   will show a composition where it previously showed one fibre.

---

## 11. Migration from v1.2

**Nothing that exists changes.** v1.3 is purely additive: one new endpoint, two new fields in
`/health`. A v1.2 client keeps working untouched.

| Change | Impact |
|---|---|
| `GET /api/v1/reference-tables` added ([§4.6](#46-reference-tables--get-apiv1reference-tables)) | New. Nothing else calls it |
| `/health` gains `reference_version` and `api_contract` | Additive fields; existing ones unchanged |
| Twelve extracted fields | **Unchanged in v1.3.** (v1.4 makes it thirteen — see [§10](#10-migration-from-v13)) |
| Endpoints, status codes, `202`-always, storage invariant, polling, errors, auth | **Unchanged** |

### To add Armenian to the app

1. Fetch and cache [§4.6](#46-reference-tables--get-apiv1reference-tables) at login, keyed by
   `version`, with `If-None-Match`.
2. Add an **AM / EN** toggle. It changes only what is displayed, never what is stored.
3. Replace free-text inputs for the six bilingual fields with searchable pickers over the
   Armenian labels ([§9](#9-working-in-armenian)).
4. Render `brand`, `country`, `size` and `original_price` in English in both modes.
5. Mark values that are not in the table, rather than snapping them.
6. Leave the CSV export exactly as it is — it stays English
   (`Mobile_app/csv_export_format.txt`).

Nothing above is required to keep a v1.2 app working; it is the work needed to give the
operator an Armenian screen.

---

## 12. Migration from v1.1

> **Historical.** This section records the v1.1 → v1.2 step as it was written at the time. Where
> it disagrees with [§8](#8-field-vocabularies) or [§10](#10-migration-from-v13), **v1.4 wins** —
> most importantly on `material`, which v1.2 reduced to a single fibre and v1.4 restored to a
> full composition. Kept for anyone migrating a very old client.

### What changed

**Only the field values changed. No shapes, no status codes, no endpoints.**

| Field | v1.1 | v1.2 |
|---|---|---|
| `sub_category` | 14 fixed keys (`shirt`, `pants`, …) | **295** client entries (`Trousers`, `T-shirt`, `Hoodie`, …) |
| `brand_name` | free text | **839** client entries, or free text when unmatched |
| `country_of_origin` | `Vietnam` | **`VIETNAM`** — uppercase, 222 entries |
| `material` | composition string, e.g. `100% Polyester` | single fibre name, e.g. `Cotton` — 85 entries |
| `color` | 9 lowercase keys | **26** entries, e.g. `Blue - Navy`, `Multicolored`, `no color` |
| `gender` | `male`, `female`, `unisex`, `kids-boy`, `kids-girl`, `newborn` | `Men`, `Women`, `Girls`, `Boys`, `Unisex`, `Baby Girl`, `Baby Boy` |
| `season` | `spring`, `summer`, `fall`, `winter`, `all-seasons` | `Summer`, `Autumn`, `Spring`, `Winter`, `All Seasons` |
| `category` | `shoe`, `clothing`, `accessories` | **unchanged** |

### Client changes required

1. **Remove any hardcoded list for `sub_category`, `brand_name`, `country_of_origin` or
   `material`.** These come from tables that grow, and the server may return a value that is not
   in any table when the label could not be matched. Treat all four as free text for storage and
   display; validate on the four short enums only.
2. **Update the short enum lists** ([§8](#8-field-vocabularies)) wherever they drive dropdowns,
   colour swatches, icons or filters. Values are case-sensitive — `Women`, not `women`.
3. ~~**Expect `material` to be one fibre**, not a percentage composition.~~ **Reversed in v1.4**
   — `material` is the full composition again. See [§8.1](#81-selected-locally-long-tables).
4. **Expect `country_of_origin` in uppercase.** Title-case it for display if preferred.
5. Nothing about auth, polling, `processing_status`, or the storage invariant changed.

### Why the values changed

The vocabularies are now the client's own reference tables — the same ones the dashboard and the
customs export use — instead of a shorter set invented during the initial build. Sharing one
vocabulary end to end means an operator, the dashboard and a customs declaration all name a
garment the same way.

The long tables are deliberately **not** sent to the AI model. It is asked to read what the label
actually says, and the server maps that reading onto the table. A model handed 295 options starts
choosing rather than reading, and a confident wrong pick is harder to spot than an honest
transcription.

### What did not change

- Endpoints, HTTP status codes, and the `202`-always submit behaviour.
- The response shape: same 12 fields, same `{ value, confidence }`, same `processing_status`.
- The storage invariant, polling hints, and error envelope.
- Authentication, token revocation, and the multipart field names.
