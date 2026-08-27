# Control Channel Contract — Middleware ⇄ Web UI

**Version 1.0** · Transport: shared SQLite database · Status: implemented and tested

This is the published contract between the middleware and the Web UI. Both run on the same
host; neither calls the other. They exchange state through one SQLite file.

The UI **must** switch on `code` values, never on displayed text. Text is data and can change
or be translated at any time; codes are the contract.

---

## 1. Connecting

```
File: <DATA_DIR>/control.db        default: /opt/apparel-middleware/data/control.db
```

Open it with these pragmas, every connection, no exceptions:

```sql
PRAGMA journal_mode = WAL;    -- already set by the middleware; harmless to repeat
PRAGMA busy_timeout = 5000;   -- wait out contention instead of erroring
```

**`busy_timeout` is not optional.** Without it, a write that collides with the middleware's
write returns `SQLITE_BUSY` immediately instead of waiting. With it, SQLite blocks for up to
5 s and then succeeds — which is what "locking shouldn't block anyone" means in practice.

### File permissions

Both processes need **read *and* write** on the database *and* its `-wal` and `-shm` siblings.
SQLite readers write to the shared-memory file, so a read-only account cannot read a WAL
database at all.

```bash
sudo groupadd apparel-shared
sudo usermod -aG apparel-shared apparel      # middleware account
sudo usermod -aG apparel-shared www-data     # UI account
sudo chgrp apparel-shared /opt/apparel-middleware/data /opt/apparel-middleware/data/control.db*
sudo chmod 770 /opt/apparel-middleware/data
sudo chmod 660 /opt/apparel-middleware/data/control.db*
sudo chmod g+s /opt/apparel-middleware/data  # new -wal/-shm inherit the group
```

The `g+s` on the directory matters: SQLite deletes and recreates `-wal`/`-shm`, and without the
setgid bit the new files get the creator's primary group and lock the other process out.

### Polling

Poll `server_status` and `server_events` on whatever cadence you like — once per page load plus
a 60 s timer is plenty. Reads never block the middleware.

---

## 2. Reading server state

```sql
SELECT * FROM server_status WHERE id = 1;
```

| Column | Meaning |
|---|---|
| `state` | `OK` · `RETRYING` · `DEGRADED` · `BLOCKED` |
| `vision_state` | `OK` · `PAUSED` — when `PAUSED`, no vision calls are being made |
| `active_fault` | `message_dictionary.code`, or `NULL` |
| `active_fault_since` | epoch ms the current fault began |
| `detail` | free text, diagnostic only — do not parse |
| `heartbeat_at` | epoch ms of the last heartbeat |
| `started_at` | epoch ms the middleware last booted |
| `queue_pending` | scans stored and awaiting extraction |
| `queue_parked` | scans that need human review |
| `flywheel_records` / `flywheel_capacity` | training buffer occupancy |

### Liveness — read this carefully

`state = 'OK'` from a process that died an hour ago still reads `OK`. **Always check the
heartbeat before trusting any other field:**

```
age = now_ms - heartbeat_at

age <= 2 × CONTROL_HEARTBEAT_MS   ->  trust `state`
age >  3 × CONTROL_HEARTBEAT_MS   ->  render "SERVER UNREACHABLE"  (never "OK")
```

`CONTROL_HEARTBEAT_MS` defaults to 30 000, so treat anything over ~90 s stale as unknown.

---

## 3. Reading messages

Open (unresolved) conditions:

```sql
SELECT e.*, d.severity, d.category, d.requires_action,
       COALESCE(t.text, d.default_text) AS text,
       COALESCE(t.hint, d.operator_hint) AS hint
FROM server_events e
JOIN message_dictionary d ON d.code = e.code
LEFT JOIN message_translations t ON t.code = e.code AND t.locale = ?   -- 'hy', 'ru', ...
WHERE e.resolved_at IS NULL
ORDER BY e.id ASC;
```

| Column | Meaning |
|---|---|
| `code` | **The contract.** Switch on this |
| `occurrences` | How many times this condition recurred while open |
| `created_at` / `last_seen_at` | First and most recent occurrence |
| `context_json` | Diagnostic JSON (`httpStatus`, `quotaIds`, counts) — display only |
| `acknowledged_at` / `_by` | Set by the UI when an operator has seen it |
| `resolved_at` | Set by the **middleware** when the condition clears |

Events are **append-only and coalesced**: a repeated condition bumps `occurrences` on the open
row rather than inserting duplicates, so a retry storm cannot flood the table and no message is
ever lost by being overwritten.

The UI may set `acknowledged_at`/`acknowledged_by`. It must **never** set `resolved_at` — only
the middleware knows whether a condition actually cleared.

### The message dictionary

`message_dictionary` is reseeded at every boot, so it always describes exactly what the running
middleware can emit — including codes added by an upgrade. Render an unknown code by falling
back to the dictionary row; never hardcode strings in the UI.

`message_translations` is **never touched by the reseed**. Insert Armenian or Russian text and
it survives upgrades:

```sql
INSERT INTO message_translations (code, locale, text, hint, updated_at)
VALUES ('VISION_BILLING_REQUIRED', 'hy', '...', '...', unixepoch() * 1000)
ON CONFLICT(code, locale) DO UPDATE SET text = excluded.text, hint = excluded.hint;
```

---

## 4. Message codes

`requires_action = 1` means the condition cannot clear until a person does something — these
are the ones that deserve a button.

### VISION

| Code | Severity | Action? | Meaning | What the operator should do |
|---|---|---|---|---|
| `VISION_OK` | INFO | no | Working normally | — |
| `VISION_TRANSIENT` | WARNING | no | Service busy; auto-retrying | Nothing unless it lasts > 1 h |
| `VISION_NETWORK` | WARNING | no | Server can't reach the API | Check connectivity if persistent |
| `VISION_RATE_LIMIT_MINUTE` | INFO | no | Brief throttle | Nothing |
| `VISION_RATE_LIMIT_DAY` | WARNING | **yes** | Daily quota gone; **paused** | Wait for reset or raise quota → *Account refreshed* |
| `VISION_BILLING_REQUIRED` | CRITICAL | **yes** | Plan excludes the model; **paused** | Fix billing → *Account refreshed* |
| `VISION_BAD_CREDENTIALS` | CRITICAL | **yes** | API key rejected; **paused** | Fix key in `.env` → *Settings updated* |
| `VISION_MODEL_UNAVAILABLE` | CRITICAL | **yes** | Model retired/misspelled; **paused** | Fix model in `.env` → *Settings updated* |
| `VISION_REQUEST_REJECTED` | WARNING | no | One scan unreadable; others fine | Re-photograph that item |
| `VISION_UNKNOWN` | WARNING | no | Unrecognised error; auto-retrying | Nothing |
| `VISION_PAUSED` | CRITICAL | **yes** | Processing halted; **scans still stored** | Resolve the paired fault |
| `VISION_RESUMED` | INFO | no | Processing restarted | — |

Four faults pause processing: `VISION_BILLING_REQUIRED`, `VISION_BAD_CREDENTIALS`,
`VISION_MODEL_UNAVAILABLE`, `VISION_RATE_LIMIT_DAY`. Everything else retries automatically.

### QUEUE

| Code | Severity | Action? | Meaning |
|---|---|---|---|
| `QUEUE_BACKLOG` | WARNING | no | Scans awaiting extraction; drains automatically |
| `QUEUE_PARKED_ITEMS` | WARNING | **yes** | Scans needing review — **nothing was lost** |
| `QUEUE_DRAINED` | INFO | no | Backlog cleared |

### FLYWHEEL

| Code | Severity | Action? | Meaning |
|---|---|---|---|
| `FLYWHEEL_HALF_FULL` | INFO | no | ≥ 50 % — plan an export |
| `FLYWHEEL_NEARLY_FULL` | WARNING | **yes** | ≥ 90 % — export soon |
| `FLYWHEEL_FULL` | WARNING | **yes** | At capacity; oldest samples now rotating out |
| `FLYWHEEL_PURGED` | INFO | no | Exported samples removed |
| `FLYWHEEL_PURGE_REJECTED` | WARNING | **yes** | Purge refused — no watermark supplied |

Only *training samples* rotate. Operational records are never affected.

### RENDER / SYSTEM

| Code | Severity | Action? | Meaning |
|---|---|---|---|
| `RENDER_JOB_COMPLETED` | INFO | no | Nightly render finished |
| `RENDER_JOB_FAILURES` | WARNING | **yes** | Some catalog images failed; records unaffected |
| `RENDER_BILLING_REQUIRED` | WARNING | **yes** | Image generation not covered by the plan |
| `SERVER_STARTED` | INFO | no | Middleware booted |
| `SERVER_SHUTTING_DOWN` | INFO | no | Middleware stopping |
| `CONFIG_RELOADED` | INFO | no | Settings re-read successfully |
| `CONFIG_RELOAD_FAILED` | CRITICAL | **yes** | Reload failed; previous settings still active |
| `DISK_WRITE_FAILED` | CRITICAL | **yes** | Cannot write to disk |

---

## 5. Sending commands

Insert a row; the middleware polls every `CONTROL_POLL_MS` (default 15 s).

```sql
INSERT INTO ui_commands (command, payload_json, issued_at, issued_by, status)
VALUES (?, ?, unixepoch() * 1000, 'ui:operator_01', 'PENDING');
```

| Command | Payload | Effect |
|---|---|---|
| `VISION_ACCOUNT_REFRESH` | — | Billing/quota fixed → resume and drain |
| `VISION_SETTINGS_UPDATED` | — | Re-read `.env` (key/model), then resume and drain |
| `FLYWHEEL_DUMPED` | **`{"exported_through_id": <rowid>}` — required** | Purge samples up to that watermark |
| `DRAIN_QUEUE_NOW` | — | Drain the backlog immediately |
| `PING` | — | Liveness probe; completes with `pong` |

### Lifecycle — how to know it worked

```
PENDING ──► IN_PROGRESS ──► DONE | FAILED | REJECTED
```

Poll the row you inserted:

```sql
SELECT status, result_detail, completed_at FROM ui_commands WHERE id = ?;
```

`PENDING` means not yet polled — **not** ignored. `result_detail` carries a human-readable
outcome for either success or failure. This is why commands are a table and not a file: the UI
can always distinguish "not yet" from "in progress" from "done".

### Resuming after a fault

Both `VISION_ACCOUNT_REFRESH` and `VISION_SETTINGS_UPDATED` do the same three things: lift the
pause, **clear every queued scan's retry backoff** (resume means *try again now*, not *finish
waiting out a timer earned by a fault you already fixed*), and schedule an immediate drain.

Use `VISION_SETTINGS_UPDATED` when `.env` changed — it re-reads the file. Use
`VISION_ACCOUNT_REFRESH` when only the remote account changed and `.env` is untouched.

### Purging the flywheel — the watermark rule

`FLYWHEEL_DUMPED` **requires** `exported_through_id`. A command without it is `REJECTED` and
nothing is deleted.

The reason is a race. Between the UI starting an export and issuing the purge, the middleware
keeps capturing new samples. A "delete everything" purge would destroy samples that were never
exported. The watermark makes the purge exactly cover what was exported:

```sql
-- 1. take the watermark FIRST
SELECT MAX(rowid) AS watermark FROM flywheel_training;   -- in flywheel.db

-- 2. export rows WHERE rowid <= watermark

-- 3. purge exactly that range
INSERT INTO ui_commands (command, payload_json, issued_at, issued_by, status)
VALUES ('FLYWHEEL_DUMPED', json_object('exported_through_id', :watermark),
        unixepoch() * 1000, 'ui:operator_01', 'PENDING');
```

Samples captured during the export survive and are exported next cycle.

---

## 6. What the UI should render

**Banner** — derived from `server_status`:

| Condition | Banner |
|---|---|
| heartbeat stale > 3 intervals | 🔴 Server unreachable |
| `vision_state = 'PAUSED'` | 🔴 Processing paused — *dictionary text for `active_fault`* + action button |
| `state = 'RETRYING'` | 🟡 Recovering automatically |
| `queue_parked > 0` | 🟡 *n* scans need review |
| `state = 'OK'` | 🟢 All systems normal |

**Always pair a pause banner with reassurance.** Scans are still being accepted and stored
while paused — the operator's instinct will be that scanning is broken, and it is not.

**Action buttons** — render one per open event with `requires_action = 1`:

| Event code | Button | Command |
|---|---|---|
| `VISION_BILLING_REQUIRED` | "I've fixed billing" | `VISION_ACCOUNT_REFRESH` |
| `VISION_RATE_LIMIT_DAY` | "Retry now" | `VISION_ACCOUNT_REFRESH` |
| `VISION_BAD_CREDENTIALS` | "I've updated the key" | `VISION_SETTINGS_UPDATED` |
| `VISION_MODEL_UNAVAILABLE` | "I've updated the model" | `VISION_SETTINGS_UPDATED` |
| `FLYWHEEL_FULL` / `_NEARLY_FULL` | "Export & purge" | `FLYWHEEL_DUMPED` + watermark |
| `QUEUE_PARKED_ITEMS` | "Review parked scans" | *(UI-side; no command)* |

---

## 7. Guarantees and non-guarantees

**Guaranteed**

- A scan that reaches the server is recorded before any Gemini call. An outage, a pause, or a
  crash cannot make it disappear. Zero data loss means *no scan is forgotten* — not that every
  API call succeeds.
- No message is lost by being overwritten. Events are append-only and coalesced.
- Commands are acknowledged with a terminal status and a result.
- A pause survives a restart; it is stored in `control.db`, not in memory.
- A purge never deletes beyond the stated watermark.
- Writes are atomic. A reader can never see a partial message.

**Not guaranteed**

- **Immediacy.** Commands take up to `CONTROL_POLL_MS`; status is up to `CONTROL_HEARTBEAT_MS`
  stale. Show timestamps, not "live".
- **Every scan extracting successfully.** A genuinely unreadable image is `PARKED` for review.
  Parked scans are never deleted, but they need a person.
- **Ordering across the two directions.** An event and a command issued at the same moment have
  no defined order. Neither side should assume one.
- **Protection from a malicious UI.** Any process that can write `control.db` can command a
  purge. The file's permissions are the security boundary — keep the UI account's write access
  scoped to this database.

---

## 8. Configuration

| Variable | Default | Effect |
|---|---|---|
| `CONTROL_HEARTBEAT_MS` | `30000` | Heartbeat and counter refresh |
| `CONTROL_POLL_MS` | `15000` | Command poll interval |
| `QUEUE_DRAIN_MS` | `60000` | Backlog sweep interval |
| `QUEUE_DRAIN_BATCH` | `25` | Scans per sweep |
| `QUEUE_BACKLOG_WARNING` | `25` | Pending count that raises `QUEUE_BACKLOG` |

To move to the one-minute cadence you asked about, set `CONTROL_POLL_MS=60000` and
`CONTROL_HEARTBEAT_MS=60000`, and treat > 180 s as stale in the UI. The defaults are tighter
because polling a local SQLite file costs effectively nothing.

---

## 9. Reference queries

```sql
-- Everything the dashboard needs, in one read
SELECT * FROM server_status WHERE id = 1;

-- Open actionable items, localised
SELECT e.code, e.occurrences, e.last_seen_at,
       COALESCE(t.text, d.default_text) AS text,
       COALESCE(t.hint, d.operator_hint) AS hint,
       d.severity
FROM server_events e
JOIN message_dictionary d ON d.code = e.code
LEFT JOIN message_translations t ON t.code = e.code AND t.locale = 'hy'
WHERE e.resolved_at IS NULL AND d.requires_action = 1
ORDER BY CASE d.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, e.id;

-- Acknowledge (UI may set this; never set resolved_at)
UPDATE server_events
SET acknowledged_at = unixepoch() * 1000, acknowledged_by = 'ui:operator_01'
WHERE id = ? AND acknowledged_at IS NULL;

-- Untranslated codes still needing Armenian text
SELECT d.code, d.default_text
FROM message_dictionary d
LEFT JOIN message_translations t ON t.code = d.code AND t.locale = 'hy'
WHERE t.code IS NULL;
```
