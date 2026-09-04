# UI Messaging Protocol

**Version 1.4** · Transport: shared SQLite (`control.db`) · Middleware 1.1.0 · Status: implemented, tested against a live second process

> **What changed in 1.4:** the dashboard can now send **supervisor decisions about the taxonomy
> tables** to the middleware — filling in a missing Armenian label, or adding a term the label
> vocabulary was missing. See [§9.2](#92-reference-data--supervisor-decisions). One new table
> (`reference_data_requests`), one new published view of state (`reference_data_status`), one new
> command (`REFERENCE_DATA_RELOAD`) and four `REFERENCE_*` message codes. Nothing existing
> changed.
>
> **What changed in 1.3:** operator account management — the UI can now create, disable and
> delete the logins used by the Android devices. See
> [§8](#8-managing-operator-accounts). Two new tables (`app_users_public`, `app_user_requests`)
> and seven `USER_*` message codes; nothing existing changed.
>
> **What changed in 1.2:** the middleware now processes every scan asynchronously
> (`api_contract.md` v1.1). A non-zero extraction queue is the **normal steady state**, not a
> symptom — see [§3.1](#31-reading-the-queue-counters-under-async-processing). Nothing about the
> tables, codes, or commands changed.

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
8. [Managing operator accounts](#8-managing-operator-accounts)
9. [Translations and reference data](#9-translations-and-reference-data)
10. [Rendering guide](#10-rendering-guide)
11. [Guarantees](#11-guarantees)
12. [Reference queries](#12-reference-queries)
13. [Integration checklist](#13-integration-checklist)

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
| `app_users_public` | middleware → UI | **View.** Operator accounts, credentials excluded |
| `app_user_requests` | UI → middleware | Account changes awaiting validation |
| `reference_data_status` | middleware → UI | Single row. The vocabulary the fleet is being served |
| `reference_data_requests` | UI → middleware | Taxonomy changes awaiting validation |

The UI **writes** only `ui_commands`, `vision_settings_pending`, `app_user_requests`,
`reference_data_requests`, `message_translations`, and the `acknowledged_*` columns of
`server_events`. Everything else is read-only to the UI — and `app_users` should never be read
directly; use the `app_users_public` view, which cannot expose a password hash.

**The middleware is the only process that writes `reference_data/*.csv`.** The dashboard reads
those files freely, but proposes changes through `reference_data_requests` rather than editing
them. One writer means no torn file and no lost edit, and it is what lets the middleware
re-read the tables and reprogram the live matcher in the same step.

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

### 3.1 Reading the queue counters under async processing

Since middleware 1.1.0, **every scan is queued before extraction**. A device uploads, the server
stores it and answers immediately, and a background worker performs the AI call. So:

| Counter | Normal | Worth surfacing |
|---|---|---|
| `queue_pending` | **Non-zero is healthy.** Scans flow in and drain out continuously | Sustained growth, or non-zero while `vision_state = 'PAUSED'` |
| `queue_parked` | **Zero** | Any non-zero value — these need a person |

Do **not** render `queue_pending > 0` as a fault. It means the pipeline is working. The signal
that matters is whether it is *draining*: sample it across two polls and compare.

`queue_parked` is different — a parked scan is stored and safe, but it will never extract without
someone re-photographing the item. That one always deserves attention.

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
| `QUEUE_BACKLOG` | WARN | – | Backlog above the configured threshold. Some queue is normal; this fires only when it is unusually deep |
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

### USERS

| Code | Sev | Action | Meaning |
|---|---|---|---|
| `USER_CREATED` | INFO | – | A new operator account was created |
| `USER_UPDATED` | INFO | – | An operator account was updated |
| `USER_PASSWORD_CHANGED` | INFO | – | Password changed; that operator's sessions were signed out |
| `USER_DISABLED` | WARN | – | Account disabled and signed out immediately |
| `USER_ENABLED` | INFO | – | Account re-enabled |
| `USER_DELETED` | WARN | – | Account deleted; scan history retained |
| `USER_REQUEST_REJECTED` | WARN | ✔ | An account change was rejected — see `result_detail` on the request |

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
| `REFERENCE_DATA_RELOADED` | INFO | – | Reference tables re-read from disk |
| `REFERENCE_DATA_UPDATED` | INFO | – | A supervisor's taxonomy change was written |
| `REFERENCE_REQUEST_REJECTED` | WARN | ✔ | A taxonomy change was refused; nothing was written |
| `REFERENCE_DATA_UNREADABLE` | CRIT | ✔ | Tables could not be re-read; previous ones still in force |

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
| `REFERENCE_DATA_RELOAD` | – | Re-read `reference_data/*.csv` and rebuild the matcher ([§9.2](#92-reference-data--supervisor-decisions)) |
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
| `PENDING` | Not yet picked up — **or** a probe was inconclusive and it will be retried. `result_detail` says which |
| `VALIDATING` | Live probe in flight |
| `APPLIED` | Validated, encrypted, adopted; vision resumed and queue draining |
| `REJECTED` | Probe returned a definitive failure. **Previous credentials remain active.** `result_detail` names the fault |

**A submission can return to `PENDING`.** If the API could not be reached, the middleware neither
adopts nor rejects — an unverified key is never put into service. Keep polling; show it as
"verifying…" rather than as an error. It resolves once the API is reachable again.

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

## 8. Managing operator accounts

The UI creates, disables and deletes the operator logins used by the Android devices. Same
handoff shape as credentials ([§7](#7-changing-the-api-key)): the UI submits a request, the
middleware validates it, hashes any password, and reports the outcome.

**The UI never stores or displays a password.** Plaintext exists only in
`app_user_requests.password`, between submission and processing, and is erased the moment the
request resolves.

### Listing operators

Read the **view**, never `app_users` directly — the view excludes credential columns and
soft-deleted accounts by construction:

```sql
SELECT username, display_name, status, created_at, created_by,
       updated_at, updated_by, last_login_at
FROM app_users_public
ORDER BY username;
```

| Column | Notes |
|---|---|
| `username` | Login name. Immutable once created |
| `display_name` | Free text for the UI; may be `NULL` |
| `status` | `ACTIVE` or `DISABLED` (deleted accounts are not in this view) |
| `last_login_at` | Epoch ms, or `NULL` if never used |
| `created_by` / `updated_by` | Whoever submitted the change, e.g. `ui:admin` |

### Submitting a change

```sql
INSERT INTO app_user_requests
  (action, username, password, display_name, submitted_at, submitted_by, status)
VALUES (:action, :username, :password, :display_name, unixepoch() * 1000, 'ui:admin', 'PENDING');
-- keep last_insert_rowid() to poll
```

| `action` | `password` | `display_name` | Effect |
|---|---|---|---|
| `CREATE` | **required** | optional | New operator, `ACTIVE`. Restores a deleted account if the name was used before |
| `SET_PASSWORD` | **required** | – | New password. **Signs the operator out everywhere** |
| `DISABLE` | – | – | Blocks login and **signs them out immediately** |
| `ENABLE` | – | – | Restores a disabled account |
| `DELETE` | – | – | Soft delete: blocks login, signs out, hides from the list, keeps the record |
| `RENAME` | – | **required** | Changes `display_name` only |

### Polling the outcome

```sql
SELECT status, result_detail, resolved_at FROM app_user_requests WHERE id = :id;
```

```
PENDING ──► APPLIED | REJECTED
```

`result_detail` always carries a human-readable outcome — show it verbatim on rejection. Typical
rejections:

- `Username must be 3-64 characters, letters/digits/dot/underscore/hyphen only.`
- `Password must be at least 8 characters.`
- `An operator named "x" already exists.`
- `No operator named "x".`
- `Refusing to disable the last active operator.`

### Rules the middleware enforces

**Immediate sign-out.** Device tokens last 30 days. `DISABLE`, `DELETE` and `SET_PASSWORD` all
stamp a revocation point on the account, and every authenticated request is checked against it —
so a disabled operator is locked out on their **next request**, not in a month. The device
receives `401 ACCOUNT_DISABLED` or `401 TOKEN_REVOKED`; both mean "log in again".

**Delete is a soft delete.** Scans carry the operator's username for attribution, and those
records are kept indefinitely. Hard-deleting the account would orphan that audit trail. The row
stays, hidden from `app_users_public`; recreating the same username restores it with its history.

**The last active operator cannot be removed.** `DISABLE` and `DELETE` are rejected when they
would leave no active account, so the UI cannot lock the whole fleet out.

**Passwords are validated before they take effect** — length and no leading/trailing whitespace
(a pasted trailing space is invisible in the UI and then fails at the device keypad).

### Migration from the shared password

Devices currently authenticate with one shared `APP_MASTER_PASSWORD`. Both schemes run side by
side so the fleet keeps working while accounts are created:

```
login(username, password)
   │
   ├─ account exists? ──► validate against it. The master password is NOT accepted
   │                      for a username that has a real account.
   └─ no account ───────► fall back to APP_MASTER_PASSWORD (if still enabled)
```

Once every device has its own account, set `ALLOW_MASTER_PASSWORD_FALLBACK=false` and the shared
password stops working. Until then the middleware logs a warning on every fallback login, so the
remaining unmigrated devices are visible in the server log.

### Suggested UI

An **Operators** screen listing `app_users_public`, with:

- **Add operator** — username + password + display name → `CREATE`
- **Reset password** → `SET_PASSWORD`, warning that it signs the operator out of their device
- **Disable / Enable** toggle → `DISABLE` / `ENABLE`
- **Delete** → `DELETE`, worded as "blocks access; scan history is kept"
- `last_login_at` shown as "last seen", so dormant accounts are easy to spot

Poll the request row until terminal, then refresh the list.

---

## 9. Translations and reference data

Two different things, deliberately kept apart. **9.1** is the Armenian for the middleware's own
status messages. **9.2** is the Armenian for the client's *taxonomy* — garment types, colours,
materials — which is warehouse data, not UI copy.

### 9.1 Message text

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

### 9.2 Reference data — supervisor decisions

The client's seven taxonomy tables live in `middle_ware/reference_data/*.csv` as
`English · Armenian · id`. The dashboard reads them directly for its own rendering. The
middleware reads them too, snaps every AI reading onto their English column, and — since
`api_contract.md` v1.3 — **serves them to the Android fleet**, so an operator can read and choose
in Armenian while the value that gets stored stays the canonical English key.

That makes the tables shared, live state, and gives the dashboard a job it could not do before:
when an operator meets a garment type outside the 295, or a row turns out to have no Armenian, a
supervisor decides the wording **once** and it reaches every handset without an app release.

#### The rule that governs this whole section

> **Additive only. An English key is never renamed and never deleted.**

That key is the join. Stored scans carry it, the dashboard's `*_id` lookups resolve through it,
and exports already delivered to the client contain it. Renaming `Trousers` would orphan every
record that already says `Trousers`. So there are exactly two actions:

| Action | Effect | Requires |
|---|---|---|
| `SET_ARMENIAN` | Fills in or corrects the Armenian label of an **existing** row | The English key must exist; the table must have an Armenian column |
| `ADD_ENTRY` | Appends a **new** row | The English key must **not** already exist |

Deleting a wrong entry, or correcting an English spelling, is a hand edit to the CSV plus a
`REFERENCE_DATA_RELOAD` — a deliberate, reviewable, human act, not something a dashboard button
can do by accident.

#### Submit

```sql
INSERT INTO reference_data_requests
  (action, table_name, english, armenian, entry_id, submitted_at, submitted_by, status)
VALUES (:action, :table_name, :english, :armenian, :entry_id,
        unixepoch() * 1000, 'ui:supervisor_01', 'PENDING');
-- keep last_insert_rowid() to poll
```

| Column | Notes |
|---|---|
| `action` | `SET_ARMENIAN` or `ADD_ENTRY`. Anything else is `REJECTED` |
| `table_name` | `sub_category` · `brand` · `country` · `material` · `color` · `gender` · `season` |
| `english` | The canonical key. Required, non-blank, at most 200 characters |
| `armenian` | Required for `SET_ARMENIAN`; optional for `ADD_ENTRY`, so a row can be added now and translated later |
| `entry_id` | `ADD_ENTRY` only, and normally `NULL` — the middleware assigns the next id above the client's highest. Supply one only to match a number the client has already issued |

#### Poll the outcome

```sql
SELECT status, result_detail, resolved_at FROM reference_data_requests WHERE id = :id;
```

```
PENDING ──► APPLIED | REJECTED
```

`result_detail` always says what happened, in words worth showing the supervisor verbatim:
`sub_category: "Ski trousers" now reads "Դահուկային տաբատ".`

#### What gets rejected, and why

A rejection **writes nothing at all**. A wrong Armenian term on a customs declaration is worse
than a missing one, so anything the middleware cannot verify comes back with a reason instead of
being guessed at.

| Refused | Reason |
|---|---|
| `SET_ARMENIAN` on `brand` or `country` | Those tables have no Armenian column. The client writes brand and country in English everywhere, including on the paperwork (2026-08-30) |
| Armenian text containing no Armenian characters | Almost always a paste into the wrong column. **Escape hatch:** for a row with *no* Armenian yet, repeating the English term exactly is accepted, and is how you record "this one stays English" — which is what `Unisex` and `All Seasons` already do |
| The English word, for a row that **already has** Armenian | Refused. That submission is far more likely a copied cell than a decision, and applying it would discard a translation the client supplied. Un-translating a term deliberately is a hand edit plus a reload |
| `SET_ARMENIAN` for an English key that does not exist | Use `ADD_ENTRY` |
| `ADD_ENTRY` for a key that already exists | Use `SET_ARMENIAN` |
| An `entry_id` already in use | The ids are the client's; a collision is never resolved silently |
| A label identical to the one already stored | Nothing to do — reported rather than rewriting the file |

#### What happens on success

In one pass, so the fleet and the matcher can never disagree:

1. The CSV is rewritten **atomically** (temp file, then rename), preserving its BOM, line
   endings, column order and quoting. A timestamped copy of the previous file is kept in
   `reference_data/.backups/` — the last 20 per table.
2. Every table is re-read from disk and the fuzzy-matcher indexes are **rebuilt in place**, so
   the new term is matchable immediately, with no restart.
3. The constrained-enum lists in the AI prompt are regenerated from the same tables, so a new
   colour or season is offered to the model on the very next scan.
4. `reference_data_status.version` changes. Handsets notice on their next `/health` call.
5. `REFERENCE_DATA_UPDATED` is raised carrying the detail.

If the re-read fails — a CSV corrupted by a concurrent hand edit — the **previous tables stay in
force**, `REFERENCE_DATA_UNREADABLE` is raised, and the batch stops. Same principle as the API
key: an unverifiable candidate never takes a working server down.

#### Read what the fleet is being served

```sql
SELECT version, counts_json, untranslated, loaded_at, updated_at
FROM reference_data_status WHERE id = 1;
```

| Column | Meaning |
|---|---|
| `version` | 16-hex fingerprint of the vocabulary. Matches `reference_version` in the middleware's `/health` and the endpoint's `ETag` |
| `counts_json` | Per table: `{"sub_category":{"rows":295,"armenian":295,"bilingual":true}, ...}` |
| `untranslated` | Bilingual rows that still have no Armenian label — the supervisor's to-do count |
| `loaded_at` | When the middleware last read the files from disk |

`untranslated` is the number to put in front of a supervisor. It is exactly the gap between what
operators could be shown in Armenian and what they still see in English.

#### Reload after a hand edit

Editing a CSV on the VPS does not reach the running server on its own:

```sql
INSERT INTO ui_commands (command, issued_at, issued_by, status)
VALUES ('REFERENCE_DATA_RELOAD', unixepoch() * 1000, 'ui:supervisor_01', 'PENDING');
```

`DONE` carries the new version. `FAILED` means the files on disk are not loadable and the
previous ones are still serving traffic. The server keeps running either way.

---

## 10. Rendering guide

### Banner

| Condition (in order) | Banner |
|---|---|
| heartbeat > 3 intervals old | 🔴 **Server unreachable** — last seen *hh:mm* |
| `vision_state = 'PAUSED'` | 🔴 **Processing paused** — *fault text* + action button |
| `state = 'RETRYING'` | 🟡 **Recovering automatically** |
| `queue_parked > 0` | 🟡 ***n* scans need review** |
| `queue_pending > 0` | 🔵 ***n* scans queued** — draining *(normal; only escalate if it stops falling)* |
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
| `REFERENCE_REQUEST_REJECTED` | "Review submission" | UI-side; show `result_detail` and let the supervisor correct and resubmit |
| `REFERENCE_DATA_UNREADABLE` | "Reload reference data" | `REFERENCE_DATA_RELOAD` after the CSV is fixed on disk |

### Don't

- Don't render `detail` as the primary message — it is diagnostic text, not operator copy.
- Don't hide INFO events entirely; keep a history view.
- Don't poll a terminal command forever — stop at `DONE`/`FAILED`/`REJECTED`.
- Don't set `resolved_at`. Ever.
- Don't show "OK" from a stale heartbeat.

---

## 11. Guarantees

**Guaranteed**

- A scan that reaches the server is recorded **before** any vision call. Outage, pause, crash,
  or restart cannot make it disappear. *Zero data loss = no scan is forgotten*, not "every API
  call succeeds".
- Scanning **never stops** because the AI is unavailable. Devices keep uploading and the server
  keeps accepting; work accumulates in `queue_pending` and drains when processing resumes. A
  paused pipeline is a delay, never a refusal (see `api_contract.md` v1.1 §2).
- No message is lost by being overwritten — events are append-only and coalesced.
- Every command reaches a terminal status with a result.
- A pause survives a restart (stored in `control.db`, not memory).
- A purge never deletes past the stated watermark.
- Credentials are validated before adoption; a rejected candidate leaves the working one intact.
- Writes are atomic — a reader never sees a partial message.
- A reference-table change is validated before anything is written, and a rejected one leaves the
  CSV untouched. An English key is never renamed or deleted, so a value already stored on a scan
  can always still be resolved.

**Not guaranteed**

- **Immediacy.** Commands take up to `CONTROL_POLL_MS`; status up to `CONTROL_HEARTBEAT_MS`
  stale. Show timestamps, not "live".
- **Every scan extracting successfully.** A genuinely unreadable image is `PARKED` for review.
  Parked scans are never deleted, but they need a person.
- **Ordering across directions.** An event and a command issued simultaneously have no defined
  order.
- **Protection from a malicious UI.** Any process that can write `control.db` can command a
  purge, or create an operator account. File permissions are the security boundary.
- **Instant revocation while the account store is unreachable.** If `control.db` cannot be read,
  the middleware keeps serving devices using the last known account standing rather than locking
  the fleet out. Revocations issued *before* the outage are still enforced; one issued *during*
  it takes effect when the database returns.

---

## 12. Reference queries

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

-- Operator list
SELECT username, display_name, status, last_login_at, created_by
FROM app_users_public ORDER BY username;

-- Create an operator
INSERT INTO app_user_requests
  (action, username, password, display_name, submitted_at, submitted_by, status)
VALUES ('CREATE', :username, :password, :display_name, unixepoch() * 1000, 'ui:admin', 'PENDING');

-- Disable one (signs them out immediately)
INSERT INTO app_user_requests (action, username, submitted_at, submitted_by, status)
VALUES ('DISABLE', :username, unixepoch() * 1000, 'ui:admin', 'PENDING');

-- Poll any account change
SELECT status, result_detail, resolved_at FROM app_user_requests WHERE id = :id;

-- What vocabulary the fleet is being served
SELECT version, counts_json, untranslated, loaded_at FROM reference_data_status WHERE id = 1;

-- Give an existing term its Armenian label
INSERT INTO reference_data_requests
  (action, table_name, english, armenian, submitted_at, submitted_by, status)
VALUES ('SET_ARMENIAN', :table_name, :english, :armenian,
        unixepoch() * 1000, 'ui:supervisor_01', 'PENDING');

-- Add a term the label vocabulary was missing (id assigned by the middleware)
INSERT INTO reference_data_requests
  (action, table_name, english, armenian, submitted_at, submitted_by, status)
VALUES ('ADD_ENTRY', :table_name, :english, :armenian,
        unixepoch() * 1000, 'ui:supervisor_01', 'PENDING');

-- Poll either of them
SELECT status, result_detail, resolved_at FROM reference_data_requests WHERE id = :id;

-- Re-read the CSVs after a hand edit on the server
INSERT INTO ui_commands (command, issued_at, issued_by, status)
VALUES ('REFERENCE_DATA_RELOAD', unixepoch() * 1000, 'ui:supervisor_01', 'PENDING');

-- Recent history (resolved included)
SELECT e.code, e.occurrences, e.created_at, e.resolved_at, d.severity
FROM server_events e JOIN message_dictionary d ON d.code = e.code
ORDER BY e.id DESC LIMIT 50;
```

---

## 13. Integration checklist

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
- [ ] `queue_pending > 0` rendered as healthy throughput, not as a fault
- [ ] Operator list read from `app_users_public`, never from `app_users`
- [ ] Passwords never stored, logged, or re-displayed by the UI
- [ ] "Reset password" and "Disable" warn that the operator is signed out immediately
- [ ] Account-change requests polled until `APPLIED`/`REJECTED`, showing `result_detail`
- [ ] Reference-table changes submitted through `reference_data_requests`, never by writing the CSV
- [ ] Taxonomy requests polled until `APPLIED`/`REJECTED`, showing `result_detail` verbatim
- [ ] `untranslated` from `reference_data_status` surfaced as the supervisor's to-do count
- [ ] No UI path offers to rename or delete an English key
- [ ] A CSV edited by hand on the server is followed by `REFERENCE_DATA_RELOAD`

---

## Appendix — configuration

| Variable | Default | Effect |
|---|---|---|
| `CONTROL_HEARTBEAT_MS` | `30000` | Heartbeat + counter refresh |
| `CONTROL_POLL_MS` | `15000` | Command and settings poll |
| `QUEUE_DRAIN_MS` | `60000` | Backlog sweep |
| `QUEUE_DRAIN_BATCH` | `25` | Scans per sweep |
| `QUEUE_BACKLOG_WARNING` | `25` | Pending count raising `QUEUE_BACKLOG` |
| `VISION_SECONDS_PER_ITEM` | `5` | Per-scan estimate the middleware sends to devices |
| `PASSWORD_MIN_LENGTH` | `8` | Minimum operator password length |
| `ALLOW_MASTER_PASSWORD_FALLBACK` | `true` | Shared-password login for devices without an account |
| `LOGIN_RATE_LIMIT_MAX` | `30` | Login attempts per minute per IP |
| `POLL_RETRY_MIN_SECONDS` / `_MAX_` | `5` / `120` | Bounds on the device polling hint |

The last two are mobile-facing (`api_contract.md` v1.1 §5) and are listed here only so the
dashboard can show operators the same wait estimate the handsets are being given.

For the one-minute cadence: set both `CONTROL_*` to `60000` and treat > 180 s as unreachable.
Defaults are tighter because polling a local SQLite file costs essentially nothing.
