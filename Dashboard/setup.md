# Setup — Label Reader Dashboard, alongside the middleware

Target: the **same** Ubuntu 24.04 VPS that already runs the Apparel Vision middleware.
Result: warehouse staff open a browser, sign in over HTTPS, and import, review, price and
export the day's scans — while the middleware keeps serving the phones, untouched.

Allow about 30 minutes. Every command is copy-pasteable; `$` lines are yours to run.

> **Read [`middle_ware/setup.md`](../middle_ware/setup.md) first and finish it.** This
> document assumes the middleware is installed at `/opt/apparel-middleware`, running as the
> `apparel` user under systemd, and reachable over HTTPS through Caddy. The dashboard is a
> second process on that same box — it cannot be installed on its own.

---

## Contents

1. [What this adds, and what it must not disturb](#1-what-this-adds-and-what-it-must-not-disturb)
2. [Decide two things first](#2-decide-two-things-first)
3. [Prepare the second service account](#3-prepare-the-second-service-account)
4. [Deploy the code](#4-deploy-the-code)
5. [Configure](#5-configure)
6. [Shared database permissions — the part that usually breaks](#6-shared-database-permissions--the-part-that-usually-breaks)
7. [First run](#7-first-run)
8. [HTTPS — a second site on the same Caddy](#8-https--a-second-site-on-the-same-caddy)
9. [Run it as a service](#9-run-it-as-a-service)
10. [Prove the two processes are really talking](#10-prove-the-two-processes-are-really-talking)
11. [First login](#11-first-login)
12. [Before real use](#12-before-real-use)
13. [Backups](#13-backups)
14. [Updating](#14-updating)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. What this adds, and what it must not disturb

```
                         Caddy :443
             ┌───────────────┴────────────────┐
   scan.yourcompany.com              dash.yourcompany.com
     (phones, Android app)             (staff, browser)
             │                                │
   apparel-middleware :3000        apparel-dashboard :3100
   user: apparel                   user: apparel-dashboard
   /opt/apparel-middleware         /opt/apparel-dashboard
             │                                │
             │  writes                        │  reads, and writes exactly five things
             ├────────► control.db ◄──────────┤
             ├────► server_scans.db ──────────┤  read
             ├──────► flywheel.db ────────────┤  read
             │                                │
             └── uploads/, public/catalog/    └──► dashboard.db  (its own, nobody else's)
```

**The two processes never call each other over HTTP.** Every exchange is a row in
`control.db`. Stop the middleware and the dashboard still imports, edits and exports; stop
the dashboard and the phones do not notice. Commands queued while the other side was down
are picked up when it returns.

Three consequences that shape everything below:

| | |
|---|---|
| **Same host, always** | The dashboard opens the middleware's SQLite files directly. There is no network path — a second server is not a supported layout (`Dashboard_plan_final.md` §14.2). |
| **Shared files, two Unix accounts** | Both accounts need read **and write** on the three middleware databases. That is §6, and it is the step that fails silently if you skip a piece of it. |
| **Nothing in `/opt/apparel-middleware` changes** | Except one line in its systemd unit (§6.3) and one block in the Caddyfile (§8). Its code, `.env` and databases are not modified. |

---

## 2. Decide two things first

### 2.1 A second hostname

The dashboard needs its own hostname on the same IP — for example `dash.yourcompany.com`,
or `dash.203-0-113-10.sslip.io` if you used the free option for the middleware. Add the `A`
record now if it is a real domain; `sslip.io` needs no DNS at all.

> **Why not `scan.yourcompany.com/dashboard`?** Both applications answer on `/health` and
> `/api`, so a path split would collide. More decisively, every link, form and asset URL in
> the dashboard is written from the site root (`/items`, `/static/app.css`), so mounting it
> under a prefix would break navigation on the first click. A second hostname costs nothing
> on the same Caddy and the same certificate machinery. Take it.

### 2.2 Who gets the first admin account

The dashboard seeds one account, `admin` / `admin`, and refuses to show anything until that
password is changed. Decide who does that, at the keyboard, in §11 — not later.

Dashboard logins are **not** the Android operator accounts. They are separate on purpose: a
dashboard bug cannot sign the warehouse fleet out. Operator accounts are still managed
*from* the dashboard, but they live in the middleware and are only ever requested through
`control.db`.

---

## 3. Prepare the second service account

```bash
$ ssh root@YOUR_IP

# A dedicated account, same pattern as the middleware's
adduser --system --group --home /opt/apparel-dashboard apparel-dashboard

# The group that lets the two processes share SQLite files
groupadd -f apparel-shared
usermod -aG apparel-shared apparel              # middleware
usermod -aG apparel-shared apparel-dashboard    # dashboard

id apparel && id apparel-dashboard
```

No new firewall ports. The dashboard is published only through Caddy on 443, exactly like
the middleware. `ufw status` should still show nothing but OpenSSH, 80 and 443.

Node.js 20 and the build packages (`build-essential`, `python3`) are already installed from
the middleware setup — `better-sqlite3` is a dependency of both and compiles the same way.

---

## 4. Deploy the code

Copy the **`Dashboard/`** directory to `/opt/apparel-dashboard`. From your workstation:

```bash
$ rsync -av --exclude node_modules --exclude dist --exclude data --exclude .env \
        ./Dashboard/  root@YOUR_IP:/opt/apparel-dashboard/
```

> `src/views/` and `src/public/` **must** be included. `tsc` compiles TypeScript only; the
> EJS templates, the stylesheet and the browser script are served from the source tree at
> runtime and are never copied into `dist/`. Do not "clean up" `src/` after building.
>
> `reference_data/` **must** be included too — it holds the 951 CN customs headings, the HS
> rule table and `category.csv`, and the dashboard refuses to start without them.

Then on the server:

```bash
cd /opt/apparel-dashboard

npm ci            # installs everything, including build tools
npm run build     # compiles TypeScript to dist/
```

Verify both halves arrived:

```bash
$ ls reference_data/            # category.csv  custom_codes.csv  hs_map.csv
$ ls src/views/ | head -3       # analytics.ejs  apply-preview.ejs  apply-result.ejs
$ ls dist/src/index.js
```

> If `npm ci` dies on `better-sqlite3` with `prebuild-install ... Request timed out` or a
> `node-gyp` `ECONNRESET`, it is the same network block described in the middleware's
> [`npm ci` fails on `better-sqlite3`](../middle_ware/setup.md#npm-ci-fails-on-better-sqlite3).
> The fix is identical, and the headers already in `/root/nodehdr` serve this tree too:
>
> ```bash
> npm ci --ignore-scripts
> npm_config_nodedir=/root/nodehdr/node-v20.20.2 npm rebuild better-sqlite3 --build-from-source
> npm run build
> ```

---

## 5. Configure

```bash
cp .env.example .env
nano .env
```

Working configuration for this layout — **use absolute paths**, because the relative
defaults resolve against the working directory and would point outside the install:

```ini
# HTTP
DASHBOARD_PORT=3100
TRUST_PROXY=1

# The middleware's files. Must match its DATA_DIR — the default install is below.
MIDDLEWARE_DATA_DIR=/opt/apparel-middleware/data

# The client's taxonomy. One shared copy with the middleware, deliberately: the English
# text the middleware snapped to and the id the dashboard exports can then never drift.
REFERENCE_DATA_DIR=/opt/apparel-middleware/reference_data

# This project's own tables (custom_codes.csv, hs_map.csv, category.csv)
LOCAL_REFERENCE_DIR=/opt/apparel-dashboard/reference_data

# The one database the dashboard owns
DASHBOARD_DATA_DIR=/opt/apparel-dashboard/data

SESSION_TTL_HOURS=12

# Behaviour — these are the defaults. They can also be changed later in the UI under
# Training → Tunables, where they are stored in dashboard.db and take precedence.
DEFAULT_LOCALE=en
PAGE_SIZE=50
FUZZY_MIN_SIMILARITY=0.85
DUP_WINDOW_HOURS=24
LOW_CONFIDENCE_THRESHOLD=0.70
MAX_DASH_USERS=10
DEFAULT_CURRENCY=EUR

# 0 = set the Secure flag on the session cookie. Correct behind Caddy, and required:
# leave it at 1 and session cookies travel without that flag.
ALLOW_INSECURE_COOKIES=0
```

> `SESSION_SECRET` appears in `.env.example` but **no code path currently reads it** —
> session tokens are 32 random bytes stored in `dashboard.db`, not signed values. Setting it
> is harmless, but do not treat it as the thing protecting sessions. The cookie is what
> matters, which is why `ALLOW_INSECURE_COOKIES=0` above is not optional.

Lock the file down and hand the tree to its account:

```bash
mkdir -p /opt/apparel-dashboard/data
chown -R apparel-dashboard:apparel-dashboard /opt/apparel-dashboard
chmod 600 /opt/apparel-dashboard/.env
```

---

## 6. Shared database permissions — the part that usually breaks

This is the step to slow down on. Get it wrong and everything works today, then the
dashboard's server page goes grey some time after the next SQLite checkpoint — **hours
after a deploy that looked fine**.

### 6.1 Why write access is required on files the dashboard only reads

`server_scans.db` and `flywheel.db` are read-only to the dashboard *by discipline*. They
still have to be opened read-write at the OS level: SQLite maintains a `-shm` shared-memory
sibling even for pure readers, so an account without write permission cannot read a WAL
database **at all**. This is stated in `UI_messaging_protocol.md` §1 and repeated as
override 11 in the dashboard plan — it is not a shortcut anyone took.

`control.db` genuinely is written by both sides. The dashboard may write exactly five
things and nothing else: `ui_commands`, `vision_settings_pending`, `app_user_requests`,
`message_translations`, and the `acknowledged_at` / `acknowledged_by` columns of
`server_events`.

### 6.2 The permissions

```bash
chgrp apparel-shared /opt/apparel-middleware/data
chmod 2770           /opt/apparel-middleware/data      # note the leading 2 = setgid
chgrp apparel-shared /opt/apparel-middleware/data/*.db*
chmod 660            /opt/apparel-middleware/data/*.db*

ls -la /opt/apparel-middleware/data
```

Expect `drwxrws--- apparel apparel-shared` on the directory and `-rw-rw---- apparel
apparel-shared` on each `.db`, `-wal` and `-shm` file.

**The setgid bit is not optional.** SQLite deletes and recreates `-wal` and `-shm` at every
checkpoint. Without setgid the new files land under the creating process's primary group and
lock the other process out at the next checkpoint — the delayed failure above.

The dashboard also needs to traverse into that directory, which `2770` grants to the group,
and to read `/opt/apparel-middleware/reference_data`. That one is **not** granted for free:
`adduser --system --home /opt/apparel-middleware` creates the middleware's top directory
`0750 apparel:apparel` on Ubuntu 24.04 (`DIR_MODE` in `/etc/adduser.conf`), and without the
search bit for the shared group `apparel-dashboard` cannot reach anything below it, however
readable the CSV files themselves are.

To grant access to Dashboard:
```bash
chgrp apparel-shared /opt/apparel-middleware
chmod 750            /opt/apparel-middleware          # g+rx for apparel-shared

chgrp -R apparel-shared /opt/apparel-middleware/reference_data
chmod 750            /opt/apparel-middleware/reference_data
chmod 640            /opt/apparel-middleware/reference_data/*.csv

check the file is existing and accessible:

ls -ld /opt/apparel-middleware /opt/apparel-middleware/reference_data
sudo -u apparel-dashboard test -r /opt/apparel-middleware/reference_data/brand.csv && echo READABLE
```

### 6.3 One line in the middleware's unit

Setgid fixes the *group* of newly created files. It does not fix their *mode*: a file
created under the default `umask 022` is `0644` — group-readable, not group-writable — and
the dashboard is locked out again. The `chmod 660` above fixes the files that exist today;
`UMask` keeps it true for every file created afterwards, after a restore or if a database is
ever recreated from scratch.

Add one line to the `[Service]` section of
`/etc/systemd/system/apparel-middleware.service`:

```ini
UMask=0007
```

```bash
systemctl daemon-reload
systemctl restart apparel-middleware
systemctl status apparel-middleware
```

The dashboard's own unit in §9 carries the same line. Nothing else in the middleware's unit
changes: same user, same `ReadWritePaths`, same hardening.

---

## 7. First run

Run the offline test suite first — it is the cheapest proof that the reference tables
parsed, the schema builds and the export layouts are intact:

```bash
$ npm run typecheck
$ REFERENCE_DATA_DIR=/opt/apparel-middleware/reference_data npm test
```

Expect roughly 46 checks and `All checks passed.` The suite uses a throwaway database under
`/tmp` and never touches `dashboard.db` or the middleware. Passing `REFERENCE_DATA_DIR`
explicitly is what points it at the middleware's tables in this side-by-side layout; without
it the tests look for a sibling `middle_ware/` directory, which exists in the repository but
not on the server.

Then start it by hand, as the service account:

```bash
$ sudo -u apparel-dashboard node dist/src/index.js
```

Expect:

```
[auth] seeded admin/admin — the password must be changed at first login.
[reference] brand            839 rows  (armenian)
[reference] sub_category     295 rows  (armenian)
[reference] country          222 rows  (armenian)
...
[middleware] server_scans.db available
[dashboard] listening on http://localhost:3100
```

`[middleware] server_scans.db not reachable` here means §5's `MIDDLEWARE_DATA_DIR` is wrong
or §6's permissions are. Fix it now rather than after the service is running.

In a second terminal:

```bash
$ curl -s localhost:3100/health
{"status":"ok","uptime_seconds":3}

$ curl -si localhost:3100/ | head -1        # expect: 302 → /login
```

Stop it with `Ctrl-C`, then drop the build-only packages:

```bash
$ npm prune --omit=dev
```

> Same warning as the middleware: **do not run `npm ci` again before the tests.** It wipes
> `node_modules` and re-runs the `better-sqlite3` native install, which needs github.com and
> nodejs.org. Test against the tree from step 4, then prune.

---

## 8. HTTPS — a second site on the same Caddy

Caddy is already installed and already obtains certificates. Add a second site block to
`/etc/caddy/Caddyfile`, leaving the middleware's block exactly as it is:

```
scan.yourcompany.com {
    encode gzip

    request_body {
        max_size 60MB
    }

    reverse_proxy localhost:3000 {
        transport http {
            read_timeout  180s
            write_timeout 180s
        }
    }
}

dash.yourcompany.com {
    encode gzip

    # CSV ledger uploads. The importer's own ceiling is 32 MB.
    request_body {
        max_size 40MB
    }

    reverse_proxy localhost:3100 {
        transport http {
            # A large xlsx export is built in memory before the first byte is sent.
            read_timeout  120s
            write_timeout 120s
        }
    }
}
```

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Caddy sets `X-Forwarded-Proto` and `X-Forwarded-For`, which is why `TRUST_PROXY=1` is in
`.env`: without it the `Secure` cookie decision and the client address in the audit log are
both taken from the proxy hop rather than the real client.

---

## 9. Run it as a service

`/etc/systemd/system/apparel-dashboard.service`:

```ini
[Unit]
Description=Label Reader Analytical Dashboard
After=network-online.target
Wants=network-online.target
# Ordering only, deliberately not Requires=: the dashboard runs perfectly well with the
# middleware stopped, and must keep doing so.
After=apparel-middleware.service

[Service]
Type=simple
User=apparel-dashboard
Group=apparel-dashboard
SupplementaryGroups=apparel-shared
UMask=0007
WorkingDirectory=/opt/apparel-dashboard
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/apparel-dashboard/data /opt/apparel-middleware/data

StandardOutput=journal
StandardError=journal
SyslogIdentifier=apparel-dashboard

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now apparel-dashboard
systemctl status apparel-dashboard
journalctl -u apparel-dashboard -f
```

Three lines there earn their place:

- **`SupplementaryGroups=apparel-shared`** — states the shared-file access in the unit
  rather than relying on the account's group list, so it survives an account being
  recreated.
- **`UMask=0007`** — the dashboard's half of §6.3.
- **`ReadWritePaths`** includes the *middleware's* data directory. `ProtectSystem=strict`
  makes the rest of the filesystem read-only, and without that entry the dashboard fails to
  open `control.db` even with the Unix permissions perfect. `reference_data/` is read-only
  at runtime and needs no entry.

---

## 10. Prove the two processes are really talking

Permissions look right far more often than they are right. Make the dashboard's account
write a row the middleware must pick up, and watch it happen:

```bash
$ sudo -u apparel-dashboard sqlite3 /opt/apparel-middleware/data/control.db \
    "INSERT INTO ui_commands (command, payload_json, issued_at, issued_by, status)
     VALUES ('PING', NULL, $(date +%s000), 'ui:setup', 'PENDING');"
```

The middleware polls every 15 seconds. Within half a minute:

```bash
$ sudo -u apparel-dashboard sqlite3 /opt/apparel-middleware/data/control.db \
    "SELECT id, command, status, result_detail FROM ui_commands ORDER BY id DESC LIMIT 1;"
1|PING|DONE|...
```

| Result | Meaning |
|---|---|
| `DONE` | Both directions work. This is the whole of §6 verified in one line. |
| The `INSERT` fails with `attempt to write a readonly database` | §6.2 — the dashboard account cannot write. Re-check the group, the `2770`, and that the shell session was reopened after `usermod` |
| Stays `PENDING` past a minute | The middleware is not running, or is not reading the same file. `systemctl status apparel-middleware`, and compare its `DATA_DIR` with `MIDDLEWARE_DATA_DIR` |

Also confirm the read path, which is what fills confidences and photo links:

```bash
$ sudo -u apparel-dashboard sqlite3 /opt/apparel-middleware/data/server_scans.db \
    "SELECT COUNT(*) FROM server_scans;"
```

An error here but not on `control.db` means `660` was applied to `control.db*` only — the
`*.db*` glob in §6.2 covers all three databases.

---

## 11. First login

Open `https://dash.yourcompany.com`. Sign in with **`admin` / `admin`**; the dashboard sends
you straight to a forced password change and will not show a single page until it is done.
Then, in this order:

1. **Set your own admin password** (8 characters minimum).
2. **Create the real accounts** under *Users* — `admin` or `viewer`, up to `MAX_DASH_USERS`.
   Everyone gets their own; the audit log should record a person, not a shared login.
3. **Open *Server*.** The banner should be green *All systems normal*, or blue with a
   pending count. Grey — *"Middleware not reachable — control.db could not be opened"* —
   means §6 is not finished, whatever §10 appeared to show.
4. **Import one day's CSV ledger** under *Import*. The preview reports every row before
   anything is written; confirm it, then check that some rows show a photo icon. That icon
   is the enrichment path from `server_scans.db` working.
5. **Run one export** under *Exports*, in both EN and AM, and open the file.

---

## 12. Before real use

- [ ] `admin`/`admin` is gone — the password was changed at first login, and real named
      accounts exist.
- [ ] `ALLOW_INSECURE_COOKIES=0` in `.env`, and the site is reached over `https://` only.
- [ ] §10 returned `DONE`, and *Server* shows a green banner with a fresh heartbeat.
- [ ] `UMask=0007` is in **both** systemd units (§6.3, §9) and both were reloaded.
- [ ] `hs_map.csv` — ships empty by design. The customs person fills it when ready; the
      history tier and the code picker work without it.
- [ ] `category.csv` — the one taxonomy table Outfit did not supply. Confirm its Armenian
      with the client before it reaches paperwork.
- [ ] Backups configured (§13). `dashboard.db` is the only copy of every price, HS code,
      article group and audit row — none of that exists in the middleware.

---

## 13. Backups

`dashboard.db` holds work that exists nowhere else. Back it up separately from, and as
seriously as, the middleware's databases.

`/etc/cron.daily/dashboard-backup` (then `chmod +x`):

```sh
#!/bin/sh
set -e
DEST=/var/backups/dashboard/$(date +%F)
mkdir -p "$DEST"

# VACUUM INTO is safe on a live WAL database; a plain cp is not
sqlite3 /opt/apparel-dashboard/data/dashboard.db "VACUUM INTO '$DEST/dashboard.db'"

# Small, and worth keeping with the database it was interpreted under
tar czf "$DEST/reference_data.tar.gz" -C /opt/apparel-dashboard reference_data

find /var/backups/dashboard -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
```

`dashboard.db` plus `reference_data/` plus `.env` is the entire dashboard state. The
middleware's own backup (`middle_ware/setup.md` §11) is unchanged and still needed.

---

## 14. Updating

```bash
systemctl stop apparel-dashboard
cd /opt/apparel-dashboard
# rsync the new Dashboard/ contents, with the same exclusions as step 4
npm ci
npm run build
REFERENCE_DATA_DIR=/opt/apparel-middleware/reference_data npm test
npm prune --omit=dev
chown -R apparel-dashboard:apparel-dashboard /opt/apparel-dashboard
systemctl start apparel-dashboard
```

Schema changes apply at boot; `dashboard.db`, `.env` and `reference_data/` are untouched by
an update. The two services update independently — there is no version handshake between
them, only the `control.db` contract, which is versioned in `UI_messaging_protocol.md`.

> `npm ci` rebuilds `better-sqlite3`. If the server cannot reach github.com or nodejs.org,
> substitute the two-command form from step 4 and keep `/root/nodehdr` in place.

---

## 15. Troubleshooting

### The banner is grey: "Middleware not reachable"

The dashboard could not open `control.db`. It is not a middleware fault — the middleware may
be perfectly healthy.

```bash
journalctl -u apparel-dashboard -n 50 --no-pager | grep '\[db\]'
```

| Message | Cause | Fix |
|---|---|---|
| `could not open ... unable to open database file` | Path wrong, or the directory is not traversable | §5 `MIDDLEWARE_DATA_DIR`; §6.2 `chmod 2770` |
| `could not open ... attempt to write a readonly database` | Mode is `640`/`644`, not `660` | §6.2, then §6.3 so it stays fixed |
| Nothing logged, banner still grey | `ReadWritePaths` missing the middleware's data directory | §9 |

### It worked yesterday and went grey overnight

The signature failure of a missing setgid bit: SQLite recreated `-wal`/`-shm` at a
checkpoint under the wrong group.

```bash
$ ls -la /opt/apparel-middleware/data/*-shm
```

If the group is `apparel` rather than `apparel-shared`, re-apply §6.2 **including the
`2770`**, and add the `UMask=0007` lines from §6.3 and §9 so it does not recur.

### The service will not start

```bash
journalctl -u apparel-dashboard -n 50 --no-pager
```

| Message | Cause | Fix |
|---|---|---|
| `Reference table <name>: ... is not there` | `reference_data/` not deployed, or the path in `.env` is wrong — the message names which of `REFERENCE_DATA_DIR` / `LOCAL_REFERENCE_DIR` it came from, and the first directory on it that does not exist | Step 4 and §5. All eight tables are required at boot, by design |
| `Reference table <name>: ... exists but this process may not read it` | A permissions problem, not a missing file — usually the search bit on a parent directory | §6.2. Confirm with `namei -l <the path in the message>` and `sudo -u apparel-dashboard test -r <path>` |
| `Cannot find module` / a missing `.ejs` template | `src/` was pruned after the build | Re-run step 4; templates are served from `src/`, not `dist/` |
| `EADDRINUSE` | Port 3100 taken | `ss -tlnp \| grep 3100` |
| `Could not locate the bindings file` | `better-sqlite3` built on a different Node | `npm rebuild better-sqlite3` |

### Signed in, then immediately signed out again

The session cookie is being dropped. With `ALLOW_INSECURE_COOKIES=0` the cookie carries
`Secure`, so it is discarded over plain HTTP — confirm you are on `https://` and going
through Caddy, not hitting port 3100 directly.

### "Session expired or the form was stale" on every form

The CSRF token is bound to the session. Either the session cookie is being dropped (above),
or the session outlived `SESSION_TTL_HOURS` in a tab left open overnight. Reload the page.

### The import found no photos or confidences

The CSV ledger cannot carry them; they come from `server_scans.db`. Check the boot line:

```bash
$ journalctl -u apparel-dashboard | grep '\[middleware\]'
[middleware] server_scans.db available
```

If it says *not reachable*, this is §6 again. The re-check runs every 5 minutes, so rows
fill in on their own once the permissions are fixed — no re-import is needed.

### A command sent from the Server page stays PENDING

`PENDING` means "not yet polled by the middleware", never "ignored" — the middleware polls
every 15 seconds. If it does not clear, the middleware is stopped. Nothing is lost; it
drains the queue when it starts.

### The capacity meter on the Training page reads empty

Known cosmetic issue, not a permissions problem: the meter sets its width with an inline
`style` attribute, which the dashboard's own Content-Security-Policy (`style-src 'self'`)
blocks. The number beside it is correct. Do not "fix" this by adding `'unsafe-inline'` to
the policy.

### Useful queries

```bash
# What the dashboard holds
sqlite3 /opt/apparel-dashboard/data/dashboard.db \
  "SELECT review_state, COUNT(*) FROM items GROUP BY review_state;"

# Import history, newest first
sqlite3 /opt/apparel-dashboard/data/dashboard.db \
  "SELECT uploaded_at, filename, rows_inserted, rows_skipped, status FROM imports ORDER BY id DESC LIMIT 10;"

# Who did what
sqlite3 /opt/apparel-dashboard/data/dashboard.db \
  "SELECT at, actor, action, entity_id FROM audit_log ORDER BY id DESC LIMIT 20;"

# The shared channel, from the dashboard's side
sqlite3 /opt/apparel-middleware/data/control.db \
  "SELECT id, command, status, issued_by FROM ui_commands ORDER BY id DESC LIMIT 10;"

# Disk
df -h /opt
du -sh /opt/apparel-dashboard/data
```

---

## Reference

| Path | Contents |
|---|---|
| `/opt/apparel-dashboard/.env` | Configuration. Absolute paths, `chmod 600` |
| `/opt/apparel-dashboard/data/dashboard.db` | Items, users, prices, imports, audit — the only file the dashboard owns |
| `/opt/apparel-dashboard/reference_data/` | `custom_codes.csv`, `hs_map.csv`, `category.csv` (required at boot) |
| `/opt/apparel-dashboard/src/views/`, `src/public/` | Templates and assets, served from source (required at runtime) |
| `/opt/apparel-middleware/data/` | `control.db` (shared), `server_scans.db`, `flywheel.db` (read) |
| `/opt/apparel-middleware/reference_data/` | The client's taxonomy — one shared copy (required at boot) |

| Port | Process | Exposed |
|---|---|---|
| 3000 | middleware | no — through Caddy on `scan.` |
| 3100 | dashboard | no — through Caddy on `dash.` |

| Document | For |
|---|---|
| [`middle_ware/setup.md`](../middle_ware/setup.md) | The middleware install this one builds on |
| [`middle_ware/UI_messaging_protocol.md`](../middle_ware/UI_messaging_protocol.md) | The `control.db` contract — locked |
| [`Dashboard_plan_final.md`](Dashboard_plan_final.md) | Why the dashboard is built the way it is |
| [`README.md`](README.md) | Layout of the code, and how to extend the suggestion engines |
