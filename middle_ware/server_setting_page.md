# Server Settings Page — design specification

Everything the Web UI can **read**, **change** and **command** through `control.db`, organised as
screens. Every column and code below is taken from the live schema.

Companion: [`UI_messaging_protocol.md`](UI_messaging_protocol.md) has the transport rules
(pragmas, file permissions, polling). This document is about *what to put on the page*.

---

## Contents

1. [Page map](#1-page-map)
2. [Screen A — Status dashboard](#2-screen-a--status-dashboard)
3. [Screen B — Alerts & activity log](#3-screen-b--alerts--activity-log)
4. [Screen C — Vision credentials](#4-screen-c--vision-credentials)
5. [Screen D — Operators](#5-screen-d--operators)
6. [Screen E — Training data (flywheel)](#6-screen-e--training-data-flywheel)
7. [Screen F — Message translations](#7-screen-f--message-translations)
8. [Complete field inventory](#8-complete-field-inventory)
9. [Complete command inventory](#9-complete-command-inventory)
10. [Complete message-code inventory](#10-complete-message-code-inventory)
11. [Rules the UI must honour](#11-rules-the-ui-must-honour)

---

## 1. Page map

| Screen | Purpose | Reads | Writes |
|---|---|---|---|
| **A. Status** | Is the server healthy? | `server_status` | – |
| **B. Alerts** | What needs attention? | `server_events` + `message_dictionary` | `server_events.acknowledged_*`, `ui_commands` |
| **C. Vision credentials** | API key and models | `vision_settings`, `vision_settings_pending` | `vision_settings_pending` |
| **D. Operators** | Device logins | `app_users_public`, `app_user_requests` | `app_user_requests` |
| **E. Training data** | Export and purge the flywheel | `server_status` counters | `ui_commands` |
| **F. Translations** | Armenian message text | `message_dictionary`, `message_translations` | `message_translations` |

A single **Settings** page with six tabs works; A and B can share the landing view.

---

## 2. Screen A — Status dashboard

**Read:** `SELECT * FROM server_status WHERE id = 1;` — one row, always exists.

### Header banner

Evaluate **in this order** and show the first that matches:

| # | Condition | Banner | Colour |
|---|---|---|---|
| 1 | `now - heartbeat_at > 90000` | **Server unreachable** — last seen *hh:mm:ss* | red |
| 2 | `vision_state = 'PAUSED'` | **Processing paused** — *fault text* | red |
| 3 | `state = 'RETRYING'` | **Recovering automatically** | amber |
| 4 | `queue_parked > 0` | **_n_ scans need review** | amber |
| 5 | `queue_pending > 0` | **_n_ scans processing** | blue |
| 6 | otherwise | **All systems normal** | green |

Rule 1 is not optional: `state` says `OK` even when the process is dead, because it is the last
value written. Only the heartbeat proves the server is alive.

### Tiles

| Tile | Source | Notes |
|---|---|---|
| Server state | `state` | `OK` · `RETRYING` · `DEGRADED` · `BLOCKED` |
| Vision | `vision_state` | `OK` · `PAUSED` |
| Active fault | `active_fault` → dictionary text | Blank when none |
| Fault duration | `now - active_fault_since` | "blocked for 2 h 14 m" |
| Last heartbeat | `heartbeat_at` | Show as relative time |
| Uptime | `now - started_at` | |
| **Queue — processing** | `queue_pending` | **Non-zero is normal.** Every scan passes through here |
| **Queue — needs review** | `queue_parked` | Non-zero always deserves attention |
| Training buffer | `flywheel_records` / `flywheel_capacity` | Progress bar |

`detail` is diagnostic text for a developer. Show it behind a "details" disclosure; never parse it.

### Queue trend

`queue_pending` alone doesn't say whether things are healthy — a steady 40 that drains is fine, a
growing 40 is not. Keep the last few samples client-side and show the direction (↑ ↓ →). Only warn
on sustained growth.

---

## 3. Screen B — Alerts & activity log

Two tabs over the same table.

**Open alerts:**

```sql
SELECT e.id, e.code, e.occurrences, e.created_at, e.last_seen_at,
       e.acknowledged_at, e.acknowledged_by, e.detail, e.context_json,
       d.severity, d.category, d.requires_action,
       COALESCE(t.text, d.default_text) AS text,
       COALESCE(t.hint, d.operator_hint) AS hint
FROM server_events e
JOIN message_dictionary d ON d.code = e.code
LEFT JOIN message_translations t ON t.code = e.code AND t.locale = :locale
WHERE e.resolved_at IS NULL
ORDER BY CASE d.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, e.id DESC;
```

**History:** same without the `WHERE`, `ORDER BY e.id DESC LIMIT 100`.

### Row layout

```
[severity chip] Text from the dictionary                    [Acknowledge] [Action ▸]
                Hint line, smaller                     seen 47× · first 09:12 · last 09:31
```

- Show `occurrences` only when > 1. Events **coalesce**: one open row per code, with a counter.
- `acknowledged_at` = a human saw it. It does **not** clear the fault; only the middleware sets
  `resolved_at`. Render an acknowledged-but-open alert dimmed, not hidden.

**Acknowledge button:**

```sql
UPDATE server_events SET acknowledged_at = unixepoch()*1000, acknowledged_by = :actor
WHERE id = :id AND acknowledged_at IS NULL;
```

### Action buttons per code

| Open code | Button | Action |
|---|---|---|
| `VISION_NOT_CONFIGURED` | Add API key | → Screen C |
| `VISION_BAD_CREDENTIALS` | Update API key | → Screen C |
| `VISION_MODEL_UNAVAILABLE` | Change model | → Screen C |
| `VISION_SETTINGS_REJECTED` | Try again | → Screen C |
| `VISION_BILLING_REQUIRED` | I've fixed billing | `VISION_ACCOUNT_REFRESH` |
| `VISION_RATE_LIMIT_DAY` | Retry now | `VISION_ACCOUNT_REFRESH` |
| `FLYWHEEL_FULL`, `FLYWHEEL_NEARLY_FULL` | Export & purge | → Screen E |
| `QUEUE_PARKED_ITEMS` | Review parked scans | UI-side list |
| `RENDER_JOB_FAILURES` | View render errors | UI-side list |
| `USER_REQUEST_REJECTED` | Review request | → Screen D |
| `DISK_WRITE_FAILED`, `CONFIG_RELOAD_FAILED` | *(none)* | Show hint; needs shell access |

Every paused banner should also carry:

> Scanning continues normally. *n* scans are safely stored and will be processed automatically
> once this is resolved. Nothing is lost.

That is factually true and prevents an operator concluding the system is broken.

---

## 4. Screen C — Vision credentials

### Current state (read-only panel)

```sql
SELECT api_key_fingerprint, vision_model, image_model,
       validation_status, validation_detail, validated_at, updated_at, updated_by
FROM vision_settings WHERE id = 1;
```

| Field | Display |
|---|---|
| `api_key_fingerprint` | `****3f9a` — the key itself is encrypted and unreadable by the UI |
| `vision_model` | Text; blank means "server default" |
| `image_model` | Text; blank means "server default" |
| `validation_status` | `UNSET` · `VALID` · `INVALID` chip |
| `validation_detail` | Only when `INVALID` |
| `validated_at`, `updated_by` | "Verified 12 Sep 14:02 by ui:admin" |

### Change form

| Field | Type | Required | Notes |
|---|---|---|---|
| API key | password input | yes | Never echoed back, never stored by the UI |
| Vision model | text | no | Blank = keep current |
| Image model | text | no | Blank = keep current |

**Submit:**

```sql
INSERT INTO vision_settings_pending
  (api_key, vision_model, image_model, submitted_at, submitted_by, status)
VALUES (:api_key, :vision_model, :image_model, unixepoch()*1000, :actor, 'PENDING');
```

**Then poll** `SELECT status, result_detail, resolved_at FROM vision_settings_pending WHERE id = :id;`

| `status` | UI |
|---|---|
| `PENDING` | Spinner, "Queued…" |
| `VALIDATING` | Spinner, "Testing the key against the API…" |
| `APPLIED` | Green. Refresh the panel. Vision resumes automatically — **no separate resume needed** |
| `REJECTED` | Red + `result_detail`. **Previous credentials are still active** — say so explicitly |

**A submission can return to `PENDING` after `VALIDATING`.** That means the API was unreachable, so
the key could not be verified. The middleware adopts nothing in that case and retries later. Show
"Could not verify yet — retrying", not an error.

---

## 5. Screen D — Operators

### List

```sql
SELECT username, display_name, status, last_login_at, created_at, created_by, updated_by
FROM app_users_public ORDER BY username;
```

> Read the **view**, never `app_users`. The view excludes password columns and deleted accounts
> by construction, so the UI cannot leak a credential even by mistake.

| Column | Notes |
|---|---|
| `username` | Login name. **Immutable** — no rename |
| `display_name` | Free text, may be `NULL` |
| `status` | `ACTIVE` / `DISABLED` chip |
| `last_login_at` | "last seen"; `NULL` → "never" — good for spotting dormant accounts |

Flag the three seeded test accounts (`minelli`, `karen`, `ali`) with a warning chip while they
exist — they use password = username and must be replaced before production.

### Actions — all write one row

```sql
INSERT INTO app_user_requests
  (action, username, password, display_name, submitted_at, submitted_by, status)
VALUES (:action, :username, :password, :display_name, unixepoch()*1000, :actor, 'PENDING');
```

| Button | `action` | Fields | Confirmation copy |
|---|---|---|---|
| Add operator | `CREATE` | username, password, display name | – |
| Reset password | `SET_PASSWORD` | password | "*name* will be signed out of their device immediately." |
| Disable | `DISABLE` | – | "*name* is signed out immediately and cannot log in." |
| Enable | `ENABLE` | – | – |
| Delete | `DELETE` | – | "Blocks access immediately. **Their scan history is kept.**" |
| Edit name | `RENAME` | display name | – |

Client-side validation, mirroring the server so errors are immediate:

- username `^[A-Za-z0-9._-]{3,64}$`
- password ≥ 8 characters, no leading/trailing spaces

**Poll** `SELECT status, result_detail FROM app_user_requests WHERE id = :id;` → `APPLIED` /
`REJECTED`. Show `result_detail` verbatim on rejection; the server's messages are already
operator-readable, e.g. *"Refusing to disable the last active operator."*

### Two behaviours to surface in the UI

- **Delete is a soft delete.** The account disappears from the list, but the record and the
  operator's scan history are retained. Recreating the same username restores it.
- **The last active operator cannot be removed.** Grey out Disable/Delete when exactly one
  `ACTIVE` account remains, and explain why.

---

## 6. Screen E — Training data (flywheel)

Counters come from `server_status`: `flywheel_records` / `flywheel_capacity`.

Show a progress bar and, above ~90 %, an export prompt. Explain what rotates:

> The training buffer holds **copies** of low-confidence scans for future AI improvement. When
> full, the oldest copies are dropped. **Operational records and photos are never affected.**

### The export → purge sequence (order matters)

1. Read the watermark **before** exporting, from `flywheel.db`:
   `SELECT MAX(rowid) AS watermark FROM flywheel_training;`
2. Export rows `WHERE rowid <= :watermark`.
3. Purge exactly that range:

```sql
INSERT INTO ui_commands (command, payload_json, issued_at, issued_by, status)
VALUES ('FLYWHEEL_DUMPED', json_object('exported_through_id', :watermark),
        unixepoch()*1000, :actor, 'PENDING');
```

`exported_through_id` is **required**. Without it the command is `REJECTED` and nothing is
deleted — deliberately, because scans captured during the export would otherwise be destroyed
before they were ever exported.

---

## 7. Screen F — Message translations

`message_dictionary` is reseeded from the middleware at every boot, so it always lists exactly
what the running server can emit — including codes added by an upgrade.
`message_translations` is separate and **never touched by the reseed**.

**Untranslated codes:**

```sql
SELECT d.code, d.category, d.severity, d.default_text, d.operator_hint
FROM message_dictionary d
LEFT JOIN message_translations t ON t.code = d.code AND t.locale = :locale
WHERE t.code IS NULL ORDER BY d.category, d.code;
```

**Save:**

```sql
INSERT INTO message_translations (code, locale, text, hint, updated_at)
VALUES (:code, :locale, :text, :hint, unixepoch()*1000)
ON CONFLICT(code, locale) DO UPDATE
  SET text = excluded.text, hint = excluded.hint, updated_at = excluded.updated_at;
```

A grid of *code · English · Armenian text · Armenian hint* is enough. Resolution is always
translation → `default_text`, so a missing translation degrades to English, never to blank.

---

## 8. Complete field inventory

### `server_status` — one row, read-only

`id` · `state` · `vision_state` · `active_fault` · `active_fault_since` · `detail` ·
`heartbeat_at` · `started_at` · `queue_pending` · `queue_parked` · `flywheel_records` ·
`flywheel_capacity` · `updated_at`

### `server_events` — append-only

`id` · `code` · `severity` · `detail` · `context_json` · `occurrences` · `created_at` ·
`last_seen_at` · **`acknowledged_at`** · **`acknowledged_by`** · `resolved_at`
*(bold = the only columns the UI may write)*

### `ui_commands` — UI writes

`id` · **`command`** · **`payload_json`** · **`issued_at`** · **`issued_by`** · **`status`** ·
`claimed_at` · `completed_at` · `result_detail`

### `message_dictionary` — read-only

`code` · `severity` · `category` · `requires_action` · `default_text` · `operator_hint` ·
`updated_at`

### `message_translations` — UI owns

`code` · `locale` · `text` · `hint` · `updated_at`

### `vision_settings` — read-only

`id` · `api_key_fingerprint` · `vision_model` · `image_model` · `validation_status` ·
`validation_detail` · `validated_at` · `updated_at` · `updated_by`
*(`api_key_ciphertext` / `_iv` / `_tag` exist but are encrypted — never display or attempt to use)*

### `vision_settings_pending` — UI writes

`id` · **`api_key`** · **`vision_model`** · **`image_model`** · **`submitted_at`** ·
**`submitted_by`** · `status` · `result_detail` · `resolved_at`

### `app_users_public` — read-only view

`username` · `display_name` · `status` · `created_at` · `created_by` · `updated_at` ·
`updated_by` · `last_login_at`

### `app_user_requests` — UI writes

`id` · **`action`** · **`username`** · **`password`** · **`display_name`** · **`submitted_at`** ·
**`submitted_by`** · `status` · `result_detail` · `resolved_at`

---

## 9. Complete command inventory

`ui_commands.command`, lifecycle `PENDING → IN_PROGRESS → DONE | FAILED | REJECTED`:

| Command | Payload | Effect | Where |
|---|---|---|---|
| `VISION_ACCOUNT_REFRESH` | – | Resume vision, clear queued backoff, drain now | B |
| `VISION_SETTINGS_UPDATED` | – | Re-read `.env`, resume, drain | B (advanced) |
| `FLYWHEEL_DUMPED` | `{"exported_through_id": N}` **required** | Purge up to the watermark | E |
| `DRAIN_QUEUE_NOW` | – | Drain the backlog immediately | A (advanced) |
| `PING` | – | Liveness probe → `result_detail = 'pong'` | debug |

Poll until terminal, then stop. `PENDING` means *not yet polled by the server*, never *ignored*.
An unknown command returns `REJECTED` — so a UI/server version mismatch is visible, not silent.

---

## 10. Complete message-code inventory

38 codes. `*` = `requires_action = 1`, so it needs a button and should not auto-dismiss.

| Category | Codes |
|---|---|
| **VISION** (15) | `VISION_OK`, `VISION_TRANSIENT`, `VISION_NETWORK`, `VISION_RATE_LIMIT_MINUTE`, `VISION_RATE_LIMIT_DAY`*, `VISION_BILLING_REQUIRED`*, `VISION_BAD_CREDENTIALS`*, `VISION_MODEL_UNAVAILABLE`*, `VISION_REQUEST_REJECTED`, `VISION_UNKNOWN`, `VISION_NOT_CONFIGURED`*, `VISION_SETTINGS_APPLIED`, `VISION_SETTINGS_REJECTED`*, `VISION_PAUSED`*, `VISION_RESUMED` |
| **USERS** (7) | `USER_CREATED`, `USER_UPDATED`, `USER_PASSWORD_CHANGED`, `USER_DISABLED`, `USER_ENABLED`, `USER_DELETED`, `USER_REQUEST_REJECTED`* |
| **SYSTEM** (5) | `SERVER_STARTED`, `SERVER_SHUTTING_DOWN`, `CONFIG_RELOADED`, `CONFIG_RELOAD_FAILED`*, `DISK_WRITE_FAILED`* |
| **FLYWHEEL** (5) | `FLYWHEEL_HALF_FULL`, `FLYWHEEL_NEARLY_FULL`*, `FLYWHEEL_FULL`*, `FLYWHEEL_PURGED`, `FLYWHEEL_PURGE_REJECTED`* |
| **QUEUE** (3) | `QUEUE_BACKLOG`, `QUEUE_PARKED_ITEMS`*, `QUEUE_DRAINED` |
| **RENDER** (3) | `RENDER_JOB_COMPLETED`, `RENDER_JOB_FAILURES`*, `RENDER_BILLING_REQUIRED`* |

**Do not hardcode this table.** Read `message_dictionary` at runtime — an upgrade can add codes,
and they will render correctly with no UI release. This list is for laying out the design, not for
the implementation.

---

## 11. Rules the UI must honour

1. **Switch on `code`, never on displayed text.** Text is data; it changes and gets translated.
2. **Check the heartbeat before trusting `state`.** A dead server still reads `OK`.
3. **Never write `resolved_at`.** Only the middleware resolves a fault.
4. **Never read `app_users` directly** — use `app_users_public`.
5. **Never store, log or re-display a password or API key.** Write it once, then forget it.
6. **Always send `exported_through_id` with `FLYWHEEL_DUMPED`.** Capture it *before* exporting.
7. **Stop polling at a terminal status.**
8. **`queue_pending > 0` is healthy throughput**, not a fault.
9. **Nothing is instant.** Commands take up to `CONTROL_POLL_MS` (15 s), status up to
   `CONTROL_HEARTBEAT_MS` (30 s). Show timestamps, not "live".
10. **Open with `journal_mode=WAL` and `busy_timeout=5000`** on every connection.

### Settings that are NOT editable from the UI

These live in `.env` and need shell access — show them read-only if at all, and never pretend
they are editable:

`PORT` · `SERVER_HOST` · `JWT_SECRET` · `APP_MASTER_PASSWORD` · `FLYWHEEL_CONFIDENCE_THRESHOLD` ·
`FLYWHEEL_MAX_RECORDS` · `RENDER_CRON_SCHEDULE` · `MAX_IMAGES` · rate limits ·
`SEED_TEST_ACCOUNTS` · `ALLOW_MASTER_PASSWORD_FALLBACK`

Only the vision credentials and operator accounts are UI-managed by design — everything else is a
deployment decision.
