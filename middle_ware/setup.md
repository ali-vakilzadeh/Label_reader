# Setup — Apparel Vision Middleware on an Ubuntu VPS

Target: Ubuntu 24.04 LTS, 2 vCPU, 4 GB RAM, public IP.
Result: the Android app can log in, upload scans, and collect results over HTTPS.

Allow about 45 minutes. Every command is copy-pasteable; `$` lines are yours to run.

---

## Contents

1. [Decide three things first](#1-decide-three-things-first)
2. [Prepare the server](#2-prepare-the-server)
3. [Install Node.js](#3-install-nodejs)
4. [Deploy the code](#4-deploy-the-code)
5. [Configure](#5-configure)
6. [First run](#6-first-run)
7. [HTTPS](#7-https)
8. [Run it as a service](#8-run-it-as-a-service)
9. [Verify from a phone](#9-verify-from-a-phone)
10. [Before real use](#10-before-real-use)
11. [Backups](#11-backups)
12. [Updating](#12-updating)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Decide three things first

### 1.1 A hostname — this is the one that bites

**An IP address alone is not enough.** Android 9+ blocks unencrypted HTTP by default, and a
trusted TLS certificate cannot be issued for a bare IP. You need a hostname.

| Option | Cost | Notes |
|---|---|---|
| **A real domain** (`scan.yourcompany.com`) | ~€10/yr | Recommended. Point an `A` record at your IP |
| **`sslip.io`** — `<your-ip>.sslip.io` | free | Works immediately, no DNS setup, and Let's Encrypt will issue for it. Fine for pilots |
| Bare IP over plain HTTP | free | **Do not.** Passwords and tokens would travel in clear |

With IP `203.0.113.10` the free hostname is `203-0-113-10.sslip.io`.

> **Choose now and don't change it later.** The hostname is baked into every
> `catalog_image_url` the server hands out, and those URLs are stored in scan records and
> exports. Changing it afterwards leaves old records pointing at a dead host.

### 1.2 A Gemini API key

From [Google AI Studio](https://aistudio.google.com/apikey). **Enable billing** — the free tier
will not carry a working fleet, and image generation is not included at all.

You can install without a key: scans are accepted and queued, and processing starts the moment a
key is added through the Web UI.

### 1.3 The master device password

One shared password used by any device that does not yet have its own operator account. Pick
something long; you will enter it in the Android app's settings.

---

## 2. Prepare the server

```bash
$ ssh root@YOUR_IP

# Updates and the packages the build needs
apt update && apt upgrade -y
apt install -y build-essential python3 git curl sqlite3 ufw

# A dedicated service account with no login shell
adduser --system --group --home /opt/apparel-middleware apparel

# Firewall: SSH and HTTPS only. The Node process is never exposed directly.
ufw allow OpenSSH
ufw allow 80/tcp      # needed for the certificate challenge
ufw allow 443/tcp
ufw --force enable
ufw status
```

`build-essential` and `python3` are required: `better-sqlite3` compiles a native module during
install.

---

## 3. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

node --version    # expect v20.x
npm --version
```

---

## 4. Deploy the code

Copy the **`middle_ware/`** directory to `/opt/apparel-middleware`. From your workstation:

```bash
$ rsync -av --exclude node_modules --exclude dist --exclude data \
        --exclude uploads --exclude .env \
        ./middle_ware/  root@YOUR_IP:/opt/apparel-middleware/
```

> `reference_data/` **must** be included — it holds the client's taxonomy tables and the server
> refuses to start without them. The exclusions above already keep it.

Then on the server:

```bash
cd /opt/apparel-middleware

npm ci            # installs everything, including build tools
npm run build     # compiles TypeScript to dist/
npm prune --omit=dev   # drop build-only packages from the runtime
```

Verify the tables shipped:

```bash
$ ls reference_data/
brand.csv  color.csv  country.csv  gender.csv  material.csv  season.csv  sub-category.csv
```

---

## 5. Configure

```bash
cp .env.example .env
openssl rand -hex 32        # copy this for JWT_SECRET
nano .env
```

Minimum working configuration:

```ini
NODE_ENV=production
PORT=3000

# MUST match the hostname from step 1.1 — no https://, no trailing slash
SERVER_HOST=scan.yourcompany.com
PUBLIC_PROTOCOL=https

JWT_SECRET=<the 64 hex characters you just generated>
APP_MASTER_PASSWORD=<your shared device password>

GEMINI_API_KEY=<your key, or leave empty for now>
GEMINI_VISION_MODEL=gemini-3.7-flash
GEMINI_IMAGE_MODEL=gemini-3.1-flash-image

CORS_ORIGIN=https://scan.yourcompany.com
RENDER_CRON_TIMEZONE=Asia/Yerevan

# Three test accounts (minelli / karen / ali) are created on first start.
# Set false once real operators exist — see step 10.
SEED_TEST_ACCOUNTS=true
```

On a 4 GB box, also lower the per-image ceiling. The app compresses photos to roughly 200–400 KB,
so the 12 MB default is far above anything real, and 8 images × 10 devices at full size would be
enough to matter:

```ini
MAX_IMAGE_BYTES=4194304        # 4 MB
```

Lock the file down — it holds your JWT secret and master password:

```bash
chown -R apparel:apparel /opt/apparel-middleware
chmod 600 /opt/apparel-middleware/.env
```

---

## 6. First run

```bash
$ sudo -u apparel node dist/src/index.js
```

Expect:

```
Reference tables loaded — subCategories:295 brands:839 countries:222 materials:85 ...
Taxonomy indexes built — matched: sub_category:295 brand:839 ...
Operational DB ready ...  Flywheel DB ready ...  Control DB ready ...
Seeded 3 TEST operator accounts (minelli, karen, ali) ...
Middleware listening on port 3000 (production)
```

In a second terminal:

```bash
$ curl -s localhost:3000/health
{"status":"ok","uptime_seconds":3,"version":"1.1.0","api_contract":"1.2","gemini_ready":true}

$ curl -s -X POST localhost:3000/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"username":"minelli","password":"minelli"}'
{"status":"success","token":"eyJ...","expires_in":"30d"}
```

`gemini_ready:false` just means no key yet — scans will still be accepted and queued.

Stop it with `Ctrl-C`. Then confirm the offline test suite passes on this machine:

```bash
$ npm ci && npm run test:all      # ~355 checks, no network needed
$ npm prune --omit=dev
```

---

## 7. HTTPS

Caddy obtains and renews certificates automatically.

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Replace `/etc/caddy/Caddyfile` with:

```
scan.yourcompany.com {
    encode gzip

    # Vision uploads: 8 photos plus multipart overhead
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
```

```bash
systemctl reload caddy
systemctl status caddy
```

> Caddy sets `X-Forwarded-For` automatically. That matters: without it every device looks like one
> client and the rate limiter throttles the whole fleet.

---

## 8. Run it as a service

`/etc/systemd/system/apparel-middleware.service`:

```ini
[Unit]
Description=Apparel Vision Processing Middleware
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=apparel
Group=apparel
WorkingDirectory=/opt/apparel-middleware
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/apparel-middleware/data /opt/apparel-middleware/uploads /opt/apparel-middleware/public/catalog

StandardOutput=journal
StandardError=journal
SyslogIdentifier=apparel-middleware

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now apparel-middleware
systemctl status apparel-middleware
journalctl -u apparel-middleware -f
```

`reference_data/` is read-only at runtime, so it needs no write path.

---

## 9. Verify from a phone

```bash
$ curl -s https://scan.yourcompany.com/health
$ curl -s -X POST https://scan.yourcompany.com/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"username":"minelli","password":"minelli"}'
```

Then in the Android app's settings:

| Setting | Value |
|---|---|
| Server URL | `https://scan.yourcompany.com` |
| Username | `minelli` |
| Password | `minelli` |

Do one real scan. Expected behaviour:

1. The app reports the scan accepted almost immediately (**HTTP 202**) — it does **not** wait for
   the AI.
2. The app polls and the result arrives seconds later.

Check the server side:

```bash
$ sqlite3 /opt/apparel-middleware/data/server_scans.db \
    "SELECT apparel_id, extraction_status, username FROM server_scans ORDER BY created_at DESC LIMIT 5;"
```

`PENDING` means it is queued (normal, briefly). `COMPLETED` means extraction finished.
If it stays `PENDING`, see [troubleshooting](#13-troubleshooting).

---

## 10. Before real use

- [ ] **Create real operator accounts** through the Web UI, then set `SEED_TEST_ACCOUNTS=false`
      in `.env` and restart. The seeded accounts use password = username and the server warns
      about them on every boot.
- [ ] **Disable the shared password** once every device has its own account:
      `ALLOW_MASTER_PASSWORD_FALLBACK=false`.
- [ ] Confirm `SERVER_HOST` is final — it is baked into stored catalog URLs.
- [ ] Confirm billing is enabled on the Gemini key, including image generation if you want the
      nightly catalog renders.
- [ ] Set up backups (step 11).
- [ ] Note the nightly render job runs at 20:00 in `RENDER_CRON_TIMEZONE`.

---

## 11. Backups

`/etc/cron.daily/apparel-backup` (then `chmod +x`):

```sh
#!/bin/sh
set -e
DEST=/var/backups/apparel/$(date +%F)
mkdir -p "$DEST"

# .backup is safe on a live WAL database; a plain cp is not
sqlite3 /opt/apparel-middleware/data/server_scans.db ".backup '$DEST/server_scans.db'"
sqlite3 /opt/apparel-middleware/data/flywheel.db     ".backup '$DEST/flywheel.db'"
sqlite3 /opt/apparel-middleware/data/control.db      ".backup '$DEST/control.db'"

tar czf "$DEST/catalog.tar.gz" -C /opt/apparel-middleware public/catalog
find /var/backups/apparel -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
```

`uploads/` holds the original photos and grows steadily. It is not in the daily backup because of
its size — copy it to external storage on your own schedule, and watch free space with `df -h`.

---

## 12. Updating

```bash
systemctl stop apparel-middleware
cd /opt/apparel-middleware
# rsync or git pull the new middle_ware/ contents
npm ci
npm run build
npm run test:all
npm prune --omit=dev
systemctl start apparel-middleware
```

Database schema changes apply automatically at boot. Your `.env`, databases, uploads and rendered
catalog images are untouched by an update.

---

## 13. Troubleshooting

### The service will not start

```bash
journalctl -u apparel-middleware -n 50 --no-pager
```

| Message | Cause | Fix |
|---|---|---|
| `Missing required environment variable JWT_SECRET` | `.env` incomplete | Fill it in; check `chmod 600` still lets `apparel` read it |
| `Reference table ... could not be read` | `reference_data/` not deployed | Re-copy it from `middle_ware/reference_data/` |
| `EADDRINUSE` | Port 3000 taken | `ss -tlnp \| grep 3000` |
| `Could not locate the bindings file` | Native module built on a different Node | `npm rebuild better-sqlite3` |

### Scans stay `PENDING`

```bash
$ sqlite3 /opt/apparel-middleware/data/control.db \
    "SELECT state, vision_state, active_fault, detail FROM server_status WHERE id=1;"
```

| `active_fault` | Meaning |
|---|---|
| `VISION_NOT_CONFIGURED` | No API key. Add one via the Web UI |
| `VISION_BAD_CREDENTIALS` | Key rejected. Replace it |
| `VISION_BILLING_REQUIRED` | Plan does not cover the model. Enable billing — waiting will not help |
| `VISION_RATE_LIMIT_DAY` | Daily quota exhausted. Resets on Google's boundary |

Nothing is lost while paused: scans keep being accepted and drain automatically once resolved.

### All devices getting `429`

`X-Forwarded-For` is not reaching the app, so the whole fleet counts as one client. Confirm you
are going through Caddy on 443, not hitting port 3000 directly.

### The app reports an error on every scan

Check that the app treats **HTTP 202 as success**. Under `api_contract.md` v1.2, a successful
submission returns 202, not 200. An app still expecting 200 will report healthy scans as failures.

### Useful queries

```bash
# Queue health
sqlite3 data/server_scans.db \
  "SELECT extraction_status, COUNT(*) FROM server_scans GROUP BY extraction_status;"

# Scans needing a human
sqlite3 data/server_scans.db \
  "SELECT apparel_id, extraction_error FROM server_scans WHERE extraction_status='PARKED';"

# Open alerts the Web UI would show
sqlite3 data/control.db \
  "SELECT code, occurrences, detail FROM server_events WHERE resolved_at IS NULL;"

# Disk
df -h /opt/apparel-middleware
du -sh /opt/apparel-middleware/uploads
```

---

## Reference

| Path | Contents |
|---|---|
| `/opt/apparel-middleware/.env` | Secrets and configuration |
| `/opt/apparel-middleware/data/` | `server_scans.db`, `flywheel.db`, `control.db` |
| `/opt/apparel-middleware/uploads/` | Original operator photos |
| `/opt/apparel-middleware/public/catalog/` | Nightly studio renders |
| `/opt/apparel-middleware/reference_data/` | Client taxonomy tables (required at boot) |

| Document | For |
|---|---|
| [`api_contract.md`](api_contract.md) | The Android developer |
| [`UI_messaging_protocol.md`](UI_messaging_protocol.md) | The Web UI developer — transport |
| [`server_setting_page.md`](server_setting_page.md) | The Web UI developer — page design |
| [`dev_report.md`](dev_report.md) | How it works, and what is still open |
