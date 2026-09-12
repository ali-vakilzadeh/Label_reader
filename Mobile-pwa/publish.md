# Publish — Label Reader PWA at `https://pwa.outfit.am`

Target: the **same** Ubuntu VPS that already runs the middleware and the dashboard.
Result: an operator opens `https://pwa.outfit.am` in Safari or Chrome, adds it to the home
screen, and scans.

Allow about 20 minutes. `$` lines are yours to run.

> **Read [`middle_ware/setup.md`](../middle_ware/setup.md) first.** This document assumes the
> middleware is installed at `/opt/apparel-middleware` and that **Caddy** already terminates
> HTTPS on that box. The PWA is a third site on that same Caddy.

---

## Contents

1. [What you are actually publishing](#1-what-you-are-actually-publishing)
2. [Three things to settle before you build](#2-three-things-to-settle-before-you-build)
3. [Build on your workstation](#3-build-on-your-workstation)
4. [Copy the bundle to the server](#4-copy-the-bundle-to-the-server)
5. [Serve it from Caddy](#5-serve-it-from-caddy)
6. [Let the middleware accept the new origin](#6-let-the-middleware-accept-the-new-origin)
7. [Verify](#7-verify)
8. [Install on a phone](#8-install-on-a-phone)
9. [Publishing an update](#9-publishing-an-update)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. What you are actually publishing

`npm run build` produces a folder of **static files**. There is no Node process, no port, no
systemd unit, no database. Caddy serves the folder; that is the whole deployment.

```
                         Caddy :443
        ┌────────────────────┼────────────────────┐
 dev.outfit.am        dash.<your-domain>      pwa.outfit.am
 (middleware :3000)   (dashboard :3100)       static files on disk
        ▲                                            │
        └──────── HTTPS calls from the browser ──────┘
                  /api/v1/… with a Bearer token
```

Two consequences:

| | |
|---|---|
| **The PWA is a client, not a server** | It keeps everything in the browser's IndexedDB and talks to the middleware over HTTPS. Nothing on the PWA host needs a backup. |
| **It is a different origin from the API** | So the middleware must allow `https://pwa.outfit.am` in `CORS_ORIGIN` — that is §6, and it is the step that breaks logins if you skip it. |

---

## 2. Three things to settle before you build

### 2.1 DNS

Add an `A` record for **`pwa.outfit.am`** pointing at the same IP as the middleware. Caddy issues
the certificate automatically on the first request.

Both hosts live under the same parent domain, `outfit.am`: the middleware answers on
`dev.outfit.am` and this PWA on `pwa.outfit.am`. Confirm the middleware is up before you tell
operators anything:

```bash
$ curl -s https://dev.outfit.am/health
{"status":"ok","uptime_seconds":…,"api_contract":"1.4",…}
```

Whatever answers `/health` is the value operators type into the app's Settings screen, and
`https://dev.outfit.am` is also the app's built-in default.

### 2.2 It must live at the root of its own hostname

`index.html` links `/manifest.json`, `/favicon.svg` and `/icons/…` from the site root, and the
service worker claims the scope `./`. Serving this under a path such as
`https://dash.example.com/pwa/` breaks the manifest, the icons and the offline cache.

If you ever genuinely need a subpath, rebuild with `VITE_BASE=/pwa/ npm run build` and fix those
absolute links in `index.html` by hand. Take the separate hostname instead — it costs nothing on
the same Caddy.

### 2.3 HTTPS is not optional

Safari and Chrome expose `getUserMedia` — the camera — only on a secure origin. Over plain HTTP
the capture screen reports *"No camera API in this browser."* Caddy gives you HTTPS for free; just
do not put anything in front of it that terminates as HTTP.

---

## 3. Build on your workstation

Node.js 18+ and npm. From `Mobile-pwa/`:

```bash
$ npm ci                  # or: npm install
$ npm run sync:reference  # refresh the bundled taxonomy from middle_ware/reference_data
$ npm run test            # offline sync-rule checks
$ npm run build           # tsc, then vite build → dist/
```

A good build ends like this:

```
dist/index.html                          2.10 kB
dist/assets/zxing_reader-<hash>.wasm  1,093.29 kB
dist/assets/index-<hash>.css            27.30 kB
dist/assets/index-<hash>.js            465.63 kB
✓ built in 6.5s
```

Confirm the PWA parts made it out of `public/`:

```bash
$ ls dist/
assets  favicon.svg  icons  index.html  manifest.json  sw.js
```

If `sw.js` or `manifest.json` is missing, the app still loads but will not work offline and will
not install to the home screen properly.

> **`.env` is not used by this build.** That file is an AI Studio leftover. The PWA reads no
> build-time variables and ships no API key — the Gemini key lives only in the middleware.

---

## 4. Copy the bundle to the server

```bash
$ ssh root@YOUR_IP 'mkdir -p /var/www/pwa.outfit.am'

# From Mobile-pwa/ on your workstation — note the trailing slash on dist/
$ rsync -av dist/ root@YOUR_IP:/var/www/pwa.outfit.am/
```

No rsync on Windows? Git Bash ships `scp`:

```bash
$ scp -r dist/* root@YOUR_IP:/var/www/pwa.outfit.am/
```

Then make it readable by Caddy:

```bash
$ ssh root@YOUR_IP
chown -R root:root /var/www/pwa.outfit.am
chmod -R a+rX /var/www/pwa.outfit.am
ls /var/www/pwa.outfit.am/     # assets favicon.svg icons index.html manifest.json sw.js
```

> **Do not use `--delete` on a routine update.** Asset filenames carry a content hash, so a new
> build writes new names. A phone still holding the previous `index.html` will ask for the
> previous `index-<oldhash>.js`; leaving it on disk keeps that phone working until it refreshes.
> Sweep stale files a release or two later, not on publish day.

---

## 5. Serve it from Caddy

Add a third site block to `/etc/caddy/Caddyfile`, leaving the middleware's and the dashboard's
blocks exactly as they are:

```
pwa.outfit.am {
    encode gzip zstd
    root * /var/www/pwa.outfit.am

    # Hashed filenames never change content — cache them hard.
    header /assets/* Cache-Control "public, max-age=31536000, immutable"

    # The shell and the worker must be revalidated, or an update never reaches a phone.
    header /               Cache-Control "no-cache"
    header /index.html     Cache-Control "no-cache"
    header /sw.js          Cache-Control "no-cache"
    header /manifest.json  Cache-Control "no-cache"

    file_server
}
```

```bash
$ caddy validate --config /etc/caddy/Caddyfile
$ systemctl reload caddy
```

Those four `no-cache` lines are the difference between "I published an update" and "the operators
actually got it". `no-cache` does not mean *do not store*; it means *revalidate every time*, so a
changed `sw.js` is picked up on the next launch instead of up to 24 hours later.

There is **no SPA rewrite here, on purpose.** The app does no URL routing — navigation is internal
state — so a `try_files … /index.html` fallback would only mask real 404s by handing `index.html`
to a missing `.wasm` request, which surfaces as a baffling parse error instead of a clean failure.

---

## 6. Let the middleware accept the new origin

The browser now calls `https://dev.outfit.am` from the origin `https://pwa.outfit.am`. Unless that
origin is allowed, every login fails in the browser with a CORS error while `curl` from the same
machine works perfectly — a confusing pair of symptoms.

```bash
$ grep CORS_ORIGIN /opt/apparel-middleware/.env
```

* `CORS_ORIGIN=*` — nothing to do.
* Anything else — add the PWA origin to the comma-separated list:

```ini
CORS_ORIGIN=https://dash.your-domain,https://pwa.outfit.am
```

Scheme included, no trailing slash, no path. Then:

```bash
$ systemctl restart apparel-middleware
$ systemctl status apparel-middleware
```

---

## 7. Verify

```bash
# The shell, over a valid certificate
$ curl -sI https://pwa.outfit.am/ | head -3

# The worker must be JavaScript and revalidated
$ curl -sI https://pwa.outfit.am/sw.js | grep -i 'content-type\|cache-control'
content-type: text/javascript
cache-control: no-cache

# The barcode engine must be application/wasm, or the scanner falls back and slows down
$ curl -sI https://pwa.outfit.am/assets/zxing_reader-<hash>.wasm | grep -i content-type
content-type: application/wasm

# The cross-origin preflight from the PWA to the API must be allowed
$ curl -s -o /dev/null -D- -X OPTIONS https://dev.outfit.am/api/v1/auth/login \
    -H 'Origin: https://pwa.outfit.am' \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' | grep -i access-control-allow-origin
```

Then in the browser, on a phone that will actually use it:

1. Open `https://pwa.outfit.am` — the padlock must be closed.
2. **Settings** → operator username, password, and the server URL from §2.1
   (`https://dev.outfit.am`, with no `/api/v1` suffix — the app appends it).
3. Tap **Test connection** — ping, token and server version should all come back green.
4. **Capture** → allow the camera when prompted, and scan one barcode end to end.

---

## 8. Install on a phone

**iPhone / iPad — Safari only** (Chrome on iOS cannot install a PWA):
Share → **Add to Home Screen** → **Add**. Launch from the icon: full screen, no address bar, safe
area insets respected.

**Android — Chrome:** ⋮ → **Install app** / **Add to Home screen**.

Tell operators to **open it from the home screen icon, not from a browser tab**. The installed
instance has its own window, and its service worker is what keeps the app usable when the
warehouse Wi-Fi drops.

> The camera permission belongs to the origin, so it is asked once per device and remembered. If
> it was ever denied, iOS stops re-prompting — clear it under Settings → Safari → Camera, or in
> the site settings for that domain.

---

## 9. Publishing an update

The same three commands, plus one line that is easy to forget:

```bash
# 1. Bump the cache name so the old shell is evicted instead of mixed with the new one.
#    public/sw.js, first line:  const CACHE_NAME = 'label-reader-cache-v4';   ← v3 → v4

# 2. Rebuild
$ npm run build

# 3. Upload (no --delete; see §4)
$ rsync -av dist/ root@YOUR_IP:/var/www/pwa.outfit.am/
```

Caddy needs no reload — it serves whatever is on disk.

**What an operator sees:** the worker serves the cached shell first and fetches the new one behind
it, so the *next* launch after an update is the one showing new code. That is by design; it is why
the app opens instantly and works with no signal. To get everyone onto a new build at once, tell
them to close the app and reopen it twice, or to pull-to-refresh in Safari.

**Nothing an operator has scanned is at risk.** Photos, drafts and the ledger live in IndexedDB,
keyed to the origin and untouched by a redeploy. A version bump does not clear them; only the
Danger Zone in Settings does.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "No camera API in this browser" | The page is not on a secure origin | Open the `https://` URL, not `http://` or a bare IP |
| Login fails in the app but works with `curl` | Origin not in `CORS_ORIGIN` | §6 — add `https://pwa.outfit.am`, restart the middleware |
| "Test connection" says the server is unreachable | Wrong server URL, or `/api/v1` typed into it | Enter the bare host, e.g. `https://dev.outfit.am` |
| Blank page; console shows 404 for `/assets/index-<hash>.js` | An old cached `index.html` plus a `--delete` upload | Re-upload the previous `dist/`, or hard-refresh the phone |
| Update published, phones still on the old build | `sw.js` or `index.html` served with a long cache lifetime | §5 — the four `no-cache` headers; then bump `CACHE_NAME` |
| "Add to Home Screen" missing on iOS | Not Safari, or `manifest.json` 404s | Use Safari; check `curl -sI https://pwa.outfit.am/manifest.json` |
| Scanner slow or silent on first use | `.wasm` served with the wrong content type | §7 — expect `application/wasm`; a proxy in front of Caddy is the usual culprit |
| Fonts look wrong offline | Inter is fetched from Google Fonts and is not pre-cached | Cosmetic only; the system font stack takes over |
