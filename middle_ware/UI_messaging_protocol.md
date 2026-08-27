# UI Messaging Protocol

**Version 1.1** · Transport: shared SQLite (`control.db`) · Status: implemented, tested against a live second process

The contract between the **middleware** (Node service, owns the vision pipeline) and the
**Web UI** (separate process, same host). Neither calls the other. All state passes through one
SQLite file.

> **The one rule that matters:** switch on `code`. Never on displayed text. Text is data —
> it changes, it gets translated. Codes are the contract.

---

## Contents

1. [Connecting](#1-connecting)
2. [Data model](#2-data-model)
3. [Reading server state](#3-reading-server-state)
4. [Reading messages](#4-reading-messages)
5. [Message code reference](#5-message-code-reference)
6. [Sending commands](#6-sending-commands)
7. [Changing the API key](#7-changing-the-api-key)
8. [Translations](#8-translations)
9. [Rendering guide](#9-rendering-guide)
10. [Guarantees](#10-guarantees)
11. [Reference queries](#11-reference-queries)
12. [Integration checklist](#12-integration-checklist)

---

## 1. Connecting

```
File: <DATA_DIR>/control.db      typically /opt/apparel-middleware/data/control.db
```

Every connection, without exception:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

**`busy_timeout` is mandatory.** Without it a write colliding with the middleware returns
`SQLITE_BUSY` immediately. With it SQLite waits up to 5 s and then succeeds. This is what makes
"locking never blocks anyone" true in practice. Verified with 40 interleaved writes from both
processes.

### File permissions — the part that usually breaks

Both accounts need **read *and* write** on `control.db` **and** its `-wal`/`-shm` siblings.
SQLite writes to the shared-memory file even when only reading, so a read-only account cannot
read a WAL database at all.

```bash
sudo groupadd apparel-shared
sudo usermod -aG apparel-shared apparel      # middleware
sudo usermod -aG apparel-shared www-data     # UI
sudo chgrp apparel-shared /opt/apparel-middleware/data
sudo chmod 2770 /opt/apparel-middleware/data   # note the leading 2 = setgid
sudo chmod 660  /opt/apparel-middleware/data/control.db*
```

The **setgid bit is not optional**. SQLite deletes and recreates `-wal`/`-shm`; without setgid
the new files inherit the creating user's primary group and lock the other process out at the
next checkpoint. This failure appears hours after a working deploy.

### Polling

| What | Suggested cadence |
|---|---|
| `server_status` | every page load + 60 s timer |
| `server_events` | same read |
| a command you issued | every 2 s until terminal, then stop |

Reads never block the middleware. Poll as often as you like.

---

## 2. Data model

| Table | Direction | Nature |
|---|---|---|
| `server_status` | middleware → UI | Single row, current state + heartbeat |
| `server_events` | middleware → UI | Append-only, coalesced, acknowledgeable |
| `ui_commands` | UI → middleware | Append-only, with lifecycle + result |
| `vision_settings` | middleware-owned | Active credentials (encrypted) |
| `vision_settings_pending` | UI → middleware | Credential submissions awaiting validation |
| `message_dictionary` | middleware → UI | Reseeded each boot; code → text/severity |
| `message_translations` | UI-owned | Localised text; survives upgrades |

The UI **writes** only `ui_commands`, `vision_settings_pending`, `message_translations`, and the
`acknowledged_*` columns of `server_events`. Everything else is read-only to the UI.

---

## 3. Reading server state

```sql
SELECT * FROM server_status WHERE id = 1;
```

| Column | Type | Meaning |
|---|---|---|
| `state` | text | `OK` · `RETRYING` · `DEGRADED` · `BLOCKED` |
| `vision_state` | text | `OK` · `PAUSED` |
| `active_fault` | text/null | Current blocking `code` |
| `active_fault_since` | int/null | Epoch ms the fault began |
| `detail` | text/null | Diagnostic. **Do not parse** |
| `heartbeat_at` | int | Epoch ms, last heartbeat |
| `started_at` | int | Epoch ms, last boot |
| `queue_pending` | int | Scans stored, awaiting extraction |
| `queue_parked` | int | Scans needing human review |
| `flywheel_records` / `flywheel_capacity` | int | Training buffer occupancy |

### Liveness — check this before anything else

A dead middleware leaves `state = 'OK'` behind. That row is a corpse, not a status.

```js
const age = Date.now() - row.heartbeat_at;
if (age > 3 * CONTROL_HEARTBEAT_MS) return 'SERVER UNREACHABLE';  // never 'OK'
if (age > 2 * CONTROL_HEARTBEAT_MS) return 'STALE';
return row.state;
```

`CONTROL_HEARTBEAT_MS` defaults to 30 000 → treat > 90 s as unreachable.

---

## 4. Reading messages

```sql
SELECT e.id, e.code, e.occurrences, e.created_at, e.last_seen_at,
       e.acknowledged_at, e.context_json,
       d.severity, d.category, d.requires_action,
       COALESCE(t.text, d.default_text) AS text,
       COALESCE(t.hint, d.operator_hint) AS hint
FROM server_events e
JOIN message_dictionary d ON d.code = e.code
LEFT JOIN message_translations t ON t.code = e.code AND t.locale = :locale
WHERE e.resolved_at IS NULL
ORDER BY CASE d.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, e.id;
```

**Events are coalesced.** A repeating condition bumps `occurrences` on the existing open row
instead of inserting duplicates. Show `occurrences` when > 1 ("seen 47 times"), but there is
only ever one open row per code.

**Only the middleware sets `resolved_at`.** The UI may set `acknowledged_at`/`acknowledged_by`
to record that a human saw it. Acknowledging is not resolving — an acknowledged fault is still
blocking until the middleware clears it.

---

## 5. Message code reference

`requires_action = 1` ⇒ the condition cannot clear on its own. These get buttons.
**Paused** ⇒ vision calls stop; scans continue to be accepted and stored.

### VISION

| Code | Sev | Action | Paused | Meaning / operator response |
|---|---|---|---|---|
| `VISION_OK` | INFO | – | – | Normal |
| `VISION_TRANSIENT` | WARN | – | – | Service busy, auto-retrying |
| `VISION_NETWORK` | WARN | – | – | Can't reach API, auto-retrying |
| `VISION_RATE_LIMIT_MINUTE` | INFO | – | – | Brief throttle, auto-retrying |
| `VISION_RATE_LIMIT_DAY` | WARN | ✔ | ✔ | Daily quota gone → wait for reset or raise quota, then *Account refreshed* |
| `VISION_BILLING_REQUIRED` | CRIT | ✔ | ✔ | Plan excludes the model → fix billing, then *Account refreshed* |
| `VISION_BAD_CREDENTIALS` | CRIT | ✔ | ✔ | Key rejected → submit a new key (§7) |
| `VISION_MODEL_UNAVAILABLE` | CRIT | ✔ | ✔ | Model retired/misspelled → submit a new model (§7) |
| `VISION_NOT_CONFIGURED` | CRIT | ✔ | ✔ | No key at all → submit one (§7) |
| `VISION_SETTINGS_APPLIED` | INFO | – | – | New credentials validated and adopted |
| `VISION_SETTINGS_REJECTED` | CRIT | ✔ | – | Submitted credentials failed validation; **previous ones still active** |
| `VISION_REQUEST_REJECTED` | WARN | – | – | One scan unreadable; others unaffected |
| `VISION_UNKNOWN` | WARN | – | – | Unrecognised error, auto-retrying |
| `VISION_PAUSED` | CRIT | ✔ | ✔ | Umbrella event; pairs with the specific fault above |
| `VISION_RESUMED` | INFO | – | – | Processing restarted |

Five faults pause: `VISION_BILLING_REQUIRED`, `VISION_BAD_CREDENTIALS`,
`VISION_MODEL_UNAVAILABLE`, `VISION_RATE_LIMIT_DAY`, `VISION_NOT_CONFIGURED`.
Everything else self-heals.

### QUEUE

| Code | Sev | Action | Meaning |
|---|---|---|---|
| `QUEUE_BACKLOG` | WARN | – | Scans awaiting extraction; drains automatically |
| `QUEUE_PARKED_ITEMS` | WARN | ✔ | Scans need review — **nothing lost**, photos and records on server |
| `QUEUE_DRAINED` | INFO | – | Backlog cleared |

### FLYWHEEL

| Code | Sev | Action | Meaning |
|---|---|---|---|
| `FLYWHEEL_HALF_FULL` | INFO | – | ≥ 50 % |
| `FLYWHEEL_NEARLY_FULL` | WARN | ✔ | ≥ 90 % — export soon |
| `FLYWHEEL_FULL` | WARN | ✔ | At capacity; oldest **training samples** rotating out |
| `FLYWHEEL_PURGED` | INFO | – | Exported samples removed |
| `FLYWHEEL_PURGE_REJECTED` | WARN | ✔ | Purge refused — no watermark (§6) |

Only training samples rotate. **Operational records are never affected** — say so in the UI, or
operators will think they are losing inventory data.

### RENDER / SYSTEM

| Code | Sev | Action | Meaning |
|---|---|---|---|
| `RENDER_JOB_COMPLETED` | INFO | – | Nightly render finished |
| `RENDER_JOB_FAILURES` | WARN | ✔ | Some catalog images failed; records unaffected |
| `RENDER_BILLING_REQUIRED` | WARN | ✔ | Image generation not covered by plan |
| `SERVER_STARTED` | INFO | – | Booted |
| `SERVER_SHUTTING_DOWN` | INFO | – | Stopping |
| `CONFIG_RELOADED` | INFO | – | Settings re-read |
| `CONFIG_RELOAD_FAILED` | CRIT | ✔ | Reload failed; previous settings active |
| `DISK_WRITE_FAILED` | CRIT | ✔ | Cannot write to disk |

**Never hardcode this table.** Read `message_dictionary` at runtime — an upgrade can add codes,
and they will render correctly without a UI release.

---

## 6. Sending commands

```sql
INSERT INTO ui_commands (command, payload_json, issued_at, issued_by, status)
VALUES (:command, :payload, unixepoch() * 1000, 'ui:operator_01', 'PENDING');
-- keep last_insert_rowid() to poll
```

| Command | Payload | Effect |
|---|---|---|
| `VISION_ACCOUNT_REFRESH` | – | Billing/quota fixed → resume + clear backoff + drain |
| `VISION_SETTINGS_UPDATED` | – | Re-read `.env`, then resume + drain |
| `FLYWHEEL_DUMPED` | **`{"exported_through_id": N}` required** | Purge up to watermark |
| `DRAIN_QUEUE_NOW` | – | Drain backlog immediately |
| `PING` | – | Liveness probe → `result_detail = 'pong'` |

### Lifecycle

```
PENDING ──► IN_PROGRESS ──► DONE | FAILED | REJECTED
```

```sql
SELECT status, result_detail, completed_at FROM ui_commands WHERE id = :id;
```

`PENDING` means *not yet polled* — not ignored. Poll until terminal; `result_detail` always
carries a human-readable outcome. Unknown commands come back `REJECTED`, never silently dropped.

### Resuming clears backoff

Both resume commands lift the pause, **clear every queued scan's retry timer**, and schedule an
immediate drain. An operator pressing "retry" means *now* — not "finish waiting out a delay
earned by a fault you already fixed".

### Flywheel purge — the watermark rule

`FLYWHEEL_DUMPED` **requires** `exported_through_id`. Without it the command is `REJECTED` and
nothing is deleted.

Between the UI starting an export and issuing the purge, the middleware keeps capturing samples.
A "delete everything" purge would destroy samples that were never exported. Correct sequence:

```sql
-- 1. watermark FIRST (in flywheel.db)
SELECT MAX(rowid) AS watermark FROM flywheel_training;
-- 2. export rows WHERE rowid <= :watermark
-- 3. purge exactly that range
INSERT INTO ui_commands (command, payload_json, issued_at, issued_by, status)
VALUES ('FLYWHEEL_DUMPED', json_object('exported_through_id', :watermark),
        unixepoch() * 1000, 'ui:operator_01', 'PENDING');
```

Samples captured during the export survive and go out next cycle.

---

## 7. Changing the API key

The UI **must not** write `.env` — that file also holds `JWT_SECRET` and the master device
password, so UI write access there would widen a UI compromise into a full auth compromise.

Instead the UI submits a candidate, and the middleware **validates it against the live API
before adopting it**. A typo is reported back; it never takes extraction down.

### Submit

```sql
INSERT INTO vision_settings_pending
  (api_key, vision_model, image_model, submitted_at, submitted_by, status)
VALUES (:api_key, :vision_model, :image_model, unixepoch() * 1000, 'ui:operator_01', 'PENDING');
```

`vision_model` and `image_model` may be `NULL` to keep the current values.

### Poll the outcome

```sql
SELECT status, result_detail, resolved_at FROM vision_settings_pending WHERE id = :id;
```

```
PENDING ──► VALIDATING ──► APPLIED | REJECTED
```

| Status | Meaning |
|---|---|
| `PENDING` | Not yet picked up |
| `VALIDATING` | Live probe in flight |
| `APPLIED` | Validated, encrypted, adopted; vision resumed and queue draining |
| `REJECTED` | Probe failed. **Previous credentials remain active.** `result_detail` names the fault |

On `APPLIED` the middleware also clears `VISION_NOT_CONFIGURED` and
`VISION_SETTINGS_REJECTED`, raises `VISION_SETTINGS_APPLIED`, and resumes automatically —
**no separate resume command is needed.**

### Show which key is loaded

```sql
SELECT api_key_fingerprint, vision_model, image_model,
       validation_status, validation_detail, validated_at, updated_by
FROM vision_settings WHERE id = 1;
```

`api_key_fingerprint` is `****` + last 4 characters. The key itself is **AES-256-GCM encrypted**
under a secret the UI does not have, so a `control.db` reader cannot lift the credential.
Plaintext exists only in `vision_settings_pending.api_key` between submission and validation,
and is erased the moment the outcome is decided (`APPLIED` or `REJECTED`).

### Precedence and the no-fallback rule

```
UI-managed key (validated)   ─── wins
       ↓ absent
GEMINI_API_KEY from .env     ─── bootstrap only
       ↓ absent
NONE → VISION_NOT_CONFIGURED, vision paused, scans still stored
```

**There is no fallback to a previous key.** If the active key is cleared or rejected, the
middleware waits for a corrected one — it never quietly reverts to an older value. Silently
reverting would let an operator believe a change took effect when it did not. While waiting,
scans keep being accepted and queued; nothing is lost.

---

## 8. Translations

`message_dictionary` is **reseeded at every boot**, so it always describes exactly what the
running middleware can emit — including codes added by an upgrade.

`message_translations` is keyed separately and is **never touched by the reseed**:

```sql
INSERT INTO message_translations (code, locale, text, hint, updated_at)
VALUES (:code, :locale, :text, :hint, unixepoch() * 1000)
ON CONFLICT(code, locale) DO UPDATE
  SET text = excluded.text, hint = excluded.hint, updated_at = excluded.updated_at;
```

Find what still needs translating:

```sql
SELECT d.code, d.default_text, d.operator_hint
FROM message_dictionary d
LEFT JOIN message_translations t ON t.code = d.code AND t.locale = 'hy'
WHERE t.code IS NULL;
```

Resolution order is always `translation → default_text`. A missing translation degrades to
English; it never renders blank.

---

## 9. Rendering guide

### Banner

| Condition (in order) | Banner |
|---|---|
| heartbeat > 3 intervals old | 🔴 **Server unreachable** — last seen *hh:mm* |
| `vision_state = 'PAUSED'` | 🔴 **Processing paused** — *fault text* + action button |
| `state = 'RETRYING'` | 🟡 **Recovering automatically** |
| `queue_parked > 0` | 🟡 ***n* scans need review** |
| `queue_pending > 0` | 🔵 ***n* scans queued** — draining |
| otherwise | 🟢 **All systems normal** |

### Always pair a pause with reassurance

An operator seeing "paused" assumes scanning is broken. It is not. Every pause banner should
carry a line like:

> Scanning continues normally. *n* scans are safely stored and will be processed automatically
> once this is resolved. Nothing is lost.

This is factually true — see §10.

### Action buttons

| Open event | Button | Action |
|---|---|---|
| `VISION_NOT_CONFIGURED` | "Add API key" | Open key form (§7) |
| `VISION_BAD_CREDENTIALS` | "Update API key" | Open key form (§7) |
| `VISION_MODEL_UNAVAILABLE` | "Change model" | Open key form (§7) |
| `VISION_SETTINGS_REJECTED` | "Try again" | Open key form (§7) |
| `VISION_BILLING_REQUIRED` | "I've fixed billing" | `VISION_ACCOUNT_REFRESH` |
| `VISION_RATE_LIMIT_DAY` | "Retry now" | `VISION_ACCOUNT_REFRESH` |
| `FLYWHEEL_FULL` / `_NEARLY_FULL` | "Export & purge" | Export, then `FLYWHEEL_DUMPED` + watermark |
| `QUEUE_PARKED_ITEMS` | "Review parked scans" | UI-side list; no command |
| `RENDER_JOB_FAILURES` | "View render errors" | UI-side list; no command |

### Don't

- Don't render `detail` as the primary message — it is diagnostic text, not operator copy.
- Don't hide INFO events entirely; keep a history view.
- Don't poll a terminal command forever — stop at `DONE`/`FAILED`/`REJECTED`.
- Don't set `resolved_at`. Ever.
- Don't show "OK" from a stale heartbeat.

---

## 10. Guarantees

**Guaranteed**

- A scan that reaches the server is recorded **before** any vision call. Outage, pause, crash,
  or restart cannot make it disappear. *Zero data loss = no scan is forgotten*, not "every API
  call succeeds".
- No message is lost by being overwritten — events are append-only and coalesced.
- Every command reaches a terminal status with a result.
- A pause survives a restart (stored in `control.db`, not memory).
- A purge never deletes past the stated watermark.
- Credentials are validated before adoption; a rejected candidate leaves the working one intact.
- Writes are atomic — a reader never sees a partial message.

**Not guaranteed**

- **Immediacy.** Commands take up to `CONTROL_POLL_MS`; status up to `CONTROL_HEARTBEAT_MS`
  stale. Show timestamps, not "live".
- **Every scan extracting successfully.** A genuinely unreadable image is `PARKED` for review.
  Parked scans are never deleted, but they need a person.
- **Ordering across directions.** An event and a command issued simultaneously have no defined
  order.
- **Protection from a malicious UI.** Any process that can write `control.db` can command a
  purge. File permissions are the security boundary.

---

## 11. Reference queries

```sql
-- Dashboard state
SELECT * FROM server_status WHERE id = 1;

-- Open actionable items, Armenian, most severe first
SELECT e.id, e.code, e.occurrences, e.last_seen_at, e.acknowledged_at,
       COALESCE(t.text, d.default_text) AS text,
       COALESCE(t.hint, d.operator_hint) AS hint,
       d.severity, d.category
FROM server_events e
JOIN message_dictionary d ON d.code = e.code
LEFT JOIN message_translations t ON t.code = e.code AND t.locale = 'hy'
WHERE e.resolved_at IS NULL AND d.requires_action = 1
ORDER BY CASE d.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, e.id;

-- Acknowledge (UI may set these two columns only)
UPDATE server_events
SET acknowledged_at = unixepoch() * 1000, acknowledged_by = 'ui:operator_01'
WHERE id = :id AND acknowledged_at IS NULL;

-- Issue a command
INSERT INTO ui_commands (command, payload_json, issued_at, issued_by, status)
VALUES (:command, :payload, unixepoch() * 1000, 'ui:operator_01', 'PENDING');

-- Poll it
SELECT status, result_detail, completed_at FROM ui_commands WHERE id = :id;

-- Submit new credentials
INSERT INTO vision_settings_pending
  (api_key, vision_model, image_model, submitted_at, submitted_by, status)
VALUES (:key, :vision_model, :image_model, unixepoch() * 1000, 'ui:operator_01', 'PENDING');

-- Which key is active
SELECT api_key_fingerprint, vision_model, image_model, validation_status, validated_at
FROM vision_settings WHERE id = 1;

-- Recent history (resolved included)
SELECT e.code, e.occurrences, e.created_at, e.resolved_at, d.severity
FROM server_events e JOIN message_dictionary d ON d.code = e.code
ORDER BY e.id DESC LIMIT 50;
```

---

## 12. Integration checklist

- [ ] Open with `journal_mode = WAL` **and** `busy_timeout = 5000`
- [ ] Group permissions set, **including the setgid bit** on the data directory
- [ ] Heartbeat staleness checked before trusting `state`
- [ ] All rendering driven by `code` + `message_dictionary`, no hardcoded strings
- [ ] Pause banners state that scans are still being stored
- [ ] Command polling stops at a terminal status
- [ ] `FLYWHEEL_DUMPED` always carries `exported_through_id`, captured **before** the export
- [ ] Key submissions poll until `APPLIED`/`REJECTED` and show `result_detail` on rejection
- [ ] The UI never writes `resolved_at`, `.env`, or any middleware-owned table
- [ ] Armenian translations loaded into `message_translations`

---

## Appendix — configuration

| Variable | Default | Effect |
|---|---|---|
| `CONTROL_HEARTBEAT_MS` | `30000` | Heartbeat + counter refresh |
| `CONTROL_POLL_MS` | `15000` | Command and settings poll |
| `QUEUE_DRAIN_MS` | `60000` | Backlog sweep |
| `QUEUE_DRAIN_BATCH` | `25` | Scans per sweep |
| `QUEUE_BACKLOG_WARNING` | `25` | Pending count raising `QUEUE_BACKLOG` |

For the one-minute cadence: set both `CONTROL_*` to `60000` and treat > 180 s as unreachable.
Defaults are tighter because polling a local SQLite file costs essentially nothing.
