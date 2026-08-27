# API Contract Specification

**Version 1.1** · Binding contract between the Android client and the middleware.
Supersedes v1.0. Changes are listed in [§8](#8-migration-from-v10).

> **v1.1 makes extraction fully asynchronous.** `POST /vision/extract` no longer waits for the
> AI. It stores the scan, answers immediately, and the client polls for the result. This matches
> the app's existing `STATUS_PENDING_VISION` queue — see [§8](#8-migration-from-v10) for exactly
> what the client must change.

---

## Contents

1. [Base configuration](#1-base-configuration)
2. [The storage invariant](#2-the-storage-invariant)
3. [Processing states](#3-processing-states)
4. [Endpoints](#4-endpoints)
5. [Polling guidance](#5-polling-guidance)
6. [Error responses](#6-error-responses)
7. [Client state machine](#7-client-state-machine)
8. [Migration from v1.0](#8-migration-from-v10)

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

Unchanged from v1.0.

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
    "brand_name":        { "value": "Nike",            "confidence": 0.95 },
    "country_of_origin": { "value": "Vietnam",         "confidence": 0.88 },
    "size":              { "value": "XL",              "confidence": 0.90 },
    "color":             { "value": "black",           "confidence": 0.92 },
    "material":          { "value": "100% Polyester",  "confidence": 0.85 },
    "original_price":    { "value": "$45.00",          "confidence": 0.99 },
    "netto":             { "value": "240g",            "confidence": 0.80 },
    "brutto":            { "value": "290g",            "confidence": 0.80 },
    "category":          { "value": "clothing",        "confidence": 0.90 },
    "sub_category":      { "value": "pants",           "confidence": 0.85 },
    "gender":            { "value": "unisex",          "confidence": 0.75 },
    "season":            { "value": "all-seasons",     "confidence": 0.70 }
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
  "gemini_ready": true
}
```

`gemini_ready: false` means the AI is not currently usable. **Scans are still accepted and
stored** — the app should not block scanning on this flag; it is for display only.

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

## 8. Migration from v1.0

### What changed

| | v1.0 | v1.1 |
|---|---|---|
| `POST /vision/extract` success | `200` + `data` | **`202`**, `data` only when `READY_TO_CONFIRM` |
| Waits for the AI | Yes, up to ~25 s | **No** — returns immediately |
| Stored-but-unprocessed | `503 VISION_QUEUED` | **`202 PENDING_AI`** |
| Result retrieval | *(none)* | `GET /vision/result/:id`, `GET /vision/results` |
| Pipeline state | *(none)* | `processing_status` on every scan response |
| Poll timing | *(none)* | `retry_after_seconds`, `estimated_wait_seconds`, `queue_depth` |

### Client changes required

1. **Accept `202`** as success on `POST /vision/extract`. Treating it as an error would mark
   healthy scans as failed.
2. **Branch on `processing_status`**, not on the HTTP status code.
3. **Implement polling** for `PENDING_AI` — preferably the batch endpoint.
4. **Handle `NEEDS_ATTENTION`** as a distinct terminal state from a transport failure. The scan
   is safe on the server; it needs a person, not a retry.
5. **Stop treating `5xx` as "maybe stored"** — `5xx` now reliably means *not* stored, so resending
   is always correct and never duplicates.

### What did **not** change

- The `data` object: same 12 fields, same `{ value, confidence }` shape, same enum values.
- `POST /auth/login` and `GET /health`.
- `catalog_image_url`: same deterministic format, still returned before the image exists.
- The error envelope `{ status, error_code, message }`.
- Multipart field names and the 8-image / 12 MB limits.

### Safe to resend

Re-submitting the same `apparel_id` with the same images is **idempotent**: the server replays
the stored result rather than re-running the AI or overwriting a completed extraction. A client
that is unsure whether a submission landed can simply resend.

Re-submitting the same `apparel_id` with **different** images is treated as a genuine re-scan and
queues a fresh extraction.
