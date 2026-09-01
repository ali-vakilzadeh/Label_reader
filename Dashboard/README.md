# Label Reader — Analytical Dashboard

Server-rendered, bilingual (EN/AM) web dashboard for the Outfit Label Reader project.
Runs on the same VPS as the middleware and talks to it **only** through the shared
`control.db` file — no HTTP in either direction, so either process can be down without the
other noticing.

The design and its reasoning are in **[`Dashboard_plan_final.md`](Dashboard_plan_final.md)**.
Read that before changing anything here; the section numbers in the code comments refer to it.

---

## What it does

| | |
|---|---|
| **Import** | The Android app's daily CSV ledger, with a byte-level digest guard so the same file can never be loaded twice. Enriched from the middleware's `server_scans.db` for confidences, clone links and photo paths. |
| **Resolve** | Free text is snapped onto the client's reference tables — exact match, then fuzzy above 0.85 similarity, then left verbatim and flagged. It never invents a value. |
| **Translate** | Never. It looks up Armenian in the client's tables, or returns the English word. Brand and country are always English, including on paperwork. |
| **Enrich** | Price, weight and HS code suggestions from this database's own history. No AI call ever leaves this process. |
| **Group** | Article groups and device clones collapse into one invoice line each, with `Pieces` summed over the family. |
| **Export** | Outfit's own invoice and inspection layouts, column for column, in English or Armenian. |
| **Operate** | Server status, alerts, vision credentials, operator accounts and the training-buffer purge, all through `control.db`. |

---

## Running it

```bash
npm install
cp .env.example .env        # defaults are fine locally; see setup.md before deploying
npm run dev                 # tsx watch, http://localhost:3100
```

Production:

```bash
npm run build
npm start
```

First login is **`admin` / `admin`**, and the dashboard refuses to go any further until the
password is changed.

### Tests

```bash
npm test
```

46 checks covering the acceptance points in `Dashboard_plan_final.md` §16 that can be
verified without a running middleware: taxonomy resolution on both sides of the fuzzy gate,
the bilingual fallback rules, digest-guarded import, locked-row protection, clone
collapsing, suggestion basis and sample size, the invoice header, the BOM, and the banner's
refusal to report `OK` from a stale heartbeat.

---

## Layout

```
src/
  config/env.ts          configuration, read once at boot
  db/                    EVERY database handle. The seam for the planned merge with the middleware.
    index.ts               dashboard.db (owned) + control/scans/flywheel (middleware's)
    schema.ts              dashboard.db DDL and forward-only column adds
  data/
    referenceTables.ts     the client's taxonomy CSVs, the CN nomenclature, the HS rule table
    resolve.ts             taxonomy snapping and the EN/AM layer — the only code allowed to change a value
  suggest/               pluggable engines; see below
  services/              import, items, groups, duplicates, exports, control, auth, analytics
  routes/                one file per screen
  views/                 EJS; every page opens with partials/head and closes with partials/foot
  public/                one stylesheet, one script — nothing from a CDN
reference_data/
  custom_codes.csv         951 CN headings, converted from the client's custom_codes.xls
  hs_map.csv               the rule matrix — ships empty, filled in by Outfit's customs person
  category.csv             the one table Outfit did not supply; flagged for their confirmation
```

### Adding or changing a suggestion engine

The client's requirement was that updating these must not mean touching the rest of the code.
That is enforced structurally: each engine is one file under `src/suggest/` exporting a
default object that satisfies `SuggestionEngine`.

- **Add one:** write the file, add it to the `ENGINES` array in `src/suggest/index.ts`.
- **Remove one:** delete the file and its line. Nothing else references it by name.
- **Change one:** edit its file and bump its `version`. The version is stamped on every
  suggestion it writes, so old and new results stay distinguishable.

An engine may only **read**. The registry writes the columns, inside the caller's
transaction, so an engine can never half-update a row. Returning `null` means "no opinion",
which is normal. Every non-null result must carry a `basis` and a sample size `n` — the
registry drops one that does not, because a number without a defensible basis has no
business on an invoice.

No engine calls an AI service. Vision belongs to the middleware; see plan §1 override 5.

---

## Deployment

**Full step-by-step install: [`setup.md`](setup.md).** It assumes the middleware is already
running per [`middle_ware/setup.md`](../middle_ware/setup.md) and installs the dashboard as a
second service on the same box. What follows is the summary.

The dashboard reads the client's taxonomy from the middleware's own `reference_data/`
directory — one shared copy, so the English text the middleware matched against and the
numeric id the dashboard exports can never drift apart.

### File permissions — the part that usually breaks

Both processes need read **and write** on `control.db`, `server_scans.db`, `flywheel.db`
**and their `-wal` / `-shm` siblings**. SQLite writes shared memory even when only reading,
so a read-only account cannot read a WAL database at all.

```bash
sudo groupadd -f apparel-shared
sudo usermod -aG apparel-shared apparel            # middleware
sudo usermod -aG apparel-shared apparel-dashboard  # dashboard
sudo chgrp apparel-shared /opt/apparel-middleware/data /opt/apparel-middleware/data/*.db*
sudo chmod 2770 /opt/apparel-middleware/data     # the leading 2 (setgid) is required
sudo chmod 660  /opt/apparel-middleware/data/*.db*
```

Without setgid, SQLite recreates `-wal`/`-shm` under the wrong group at the next checkpoint
and locks the other process out — **hours after a deploy that looked fine**. Setgid fixes the
group of new files but not their mode, so both systemd units also need `UMask=0007`; see
[`setup.md`](setup.md) §6.

### Backup

`dashboard.db` nightly via `VACUUM INTO` (safe on a live WAL database). That file plus
`reference_data/` is the entire dashboard state.

---

## Things that look like bugs and are not

- **`queue_pending > 0` is rendered blue, not red.** Under async processing a non-empty
  extraction queue is normal throughput. Only sustained growth matters.
- **`Unisex` and `All Seasons` show in English under the AM toggle.** The client's own
  tables hold English in the Armenian column for those two. The fallback is working.
- **Brand and country never translate.** Client instruction, 2026-08-30: they are always
  written in English, including on paperwork.
- **A catalog image URL that 404s the same day.** Renders run nightly at 20:00; the URL is
  permanent and valid from the moment the scan arrives. The UI says "scheduled for tonight".
- **`hs_map.csv` is empty.** The rule tier of the HS engine stays dormant until Outfit fills
  it; the history tier and the code picker work regardless.
- **A typo like `trowsers` becomes `Trousers`.** That is the fuzzy snap at 0.88 similarity.
  It is stamped `FUZZY:0.88` in `field_src_json` and shown on the row, never applied
  silently. Below 0.85 the operator's text survives untouched and the row waits for review.
