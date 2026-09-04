# API Contract Specification

**Version 1.3** · Binding contract between the Android client and the middleware.
Supersedes v1.2. Changes are listed in [§10](#10-migration-from-v12).

> **v1.3 adds one endpoint and changes nothing else.**
> [`GET /api/v1/reference-tables`](#46-reference-tables--get-apiv1reference-tables) serves the
> client's seven taxonomy tables as English key + Armenian label + numeric id, so the app can
> show the operator **Armenian** while still storing and sending the canonical **English** key.
> No request or response shape changes, no existing field changes, and nothing on the wire
> becomes Armenian. See [§8.3](#83-showing-values-in-armenian).
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
10. [Migration from v1.2](#10-migration-from-v12)
11. [Migration from v1.1](#11-migration-from-v11)

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
| `key_photo_index` | Integer | **Yes** | Zero-based index (0–7) of the main product photo |
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
  "data": null
}
```

| Field | Type | Notes |
|---|---|---|
| `processing_status` | String | See [§3](#3-processing-states) |
| `queue_depth` | Integer | Scans queued ahead of this one |
| `estimated_wait_seconds` | Integer \| null | Estimated time until ready. `null` when processing is paused and no estimate is meaningful |
| `retry_after_seconds` | Integer | **When to poll next.** Always present; clamped to 5–120 s |
| `blocking_fault` | String \| null | Set when processing is paused, e.g. `VISION_BILLING_REQUIRED`. Advisory — display as "processing paused, contact supervisor" |
| `data` | Object \| null | Populated **only** when `processing_status` is `READY_TO_CONFIRM` |
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
  "data": {
    "brand_name":        { "value": "Nike",         "confidence": 0.95 },
    "country_of_origin": { "value": "VIETNAM",      "confidence": 0.88 },
    "size":              { "value": "XL",           "confidence": 0.90 },
    "color":             { "value": "Black",        "confidence": 0.92 },
    "material":          { "value": "Polyester",    "confidence": 0.85 },
    "original_price":    { "value": "$45.00",       "confidence": 0.99 },
    "netto":             { "value": "240g",         "confidence": 0.80 },
    "brutto":            { "value": "290g",         "confidence": 0.80 },
    "category":          { "value": "clothing",     "confidence": 0.90 },
    "sub_category":      { "value": "Trousers",     "confidence": 0.85 },
    "gender":            { "value": "Unisex",       "confidence": 0.75 },
    "season":            { "value": "All Seasons",  "confidence": 0.70 }
  }
}
```

The `data` object always contains all **12 fields**, each as `{ value, confidence }`.
An unreadable field is `{ "value": "", "confidence": 0.0 }` — never omitted, never `null`.

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
  "data": { "…12 fields…" }
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
  "api_contract": "1.3",
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
| `material` | 85 | same. A single fibre name, e.g. `Cotton` — not a composition string |

These tables are far too long to enumerate here and **will grow**. Do not hardcode them in the
app. When nothing matches closely enough the server returns the transcription unchanged, so the
client must accept a value outside the table.

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

Everything on the wire is English. The Armenian the operator reads is a **lookup**, performed on
the device against the table from
[§4.6](#46-reference-tables--get-apiv1reference-tables):

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

## 9. Working in Armenian

The operator-facing requirement is that AI results are **read** in Armenian and the operator's
decision is **made** in Armenian. Both are satisfied without any Armenian ever crossing the wire.

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

## 10. Migration from v1.2

**Nothing that exists changes.** v1.3 is purely additive: one new endpoint, two new fields in
`/health`. A v1.2 client keeps working untouched.

| Change | Impact |
|---|---|
| `GET /api/v1/reference-tables` added ([§4.6](#46-reference-tables--get-apiv1reference-tables)) | New. Nothing else calls it |
| `/health` gains `reference_version` and `api_contract` | Additive fields; existing ones unchanged |
| Twelve extracted fields | **Unchanged** — same names, same `{ value, confidence }`, same English values |
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

## 11. Migration from v1.1

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
3. **Expect `material` to be one fibre**, not a percentage composition. If the app parsed
   `"80% Cotton 20% Polyester"`, that parsing is no longer needed.
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
