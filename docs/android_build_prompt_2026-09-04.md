# Build Prompt — Apparel Vision Android App, 2026-09-04 revision

**How to use this file.** Everything below the line is the prompt. Attach the two specification
files it references before sending:

- `middle_ware/api_contract.md` (v1.4) — the binding contract with the server
- `Mobile_app/csv_export_format.txt` — the 19-column daily ledger

The same prompt drives the PWA rewrite, with the platform note at the very end substituted.

---

## PROMPT BEGINS

You are working on **Apparel Vision**, an Android warehouse intake app. Operators scan a garment's
barcode, photograph its labels, a server extracts the label data with a vision model, the operator
reviews and approves it, and at end of shift the app exports a CSV ledger.

**Stack:** Kotlin, Jetpack Compose (Material 3), CameraX, Google ML Kit barcode scanning, Room,
Retrofit + OkHttp + Moshi, Coil, EncryptedSharedPreferences.

Two attached files are **authoritative and must not be contradicted**:

| File | Governs |
|---|---|
| `api_contract.md` (v1.4) | Every request and response between app and server |
| `csv_export_format.txt` | The exact CSV the app exports |

Where this prompt and those files disagree, **the files win**. Where this prompt is silent, follow
the files.

---

## 0. Ground rules that apply to every task

1. **Never store or export Armenian.** Armenian is displayed and discarded. The English key is the
   only value written to Room, to the CSV, or sent to the server.
2. **Never hardcode a vocabulary.** Brands, sub-categories, countries and materials come from the
   server and grow between releases.
3. **The CSV column order is fixed** by the spec. Do not reorder, rename, add or omit columns.
4. **Do not change any request field name or shape.** The contract is coordinated with a server
   that is already deployed.
5. **Offline must keep working.** A scan taken with no connectivity is stored locally and sent
   later. Losing a scan is the worst possible failure.
6. Preserve the existing visual language — the current colour tokens (`LsCocoa900`, `LsRust700`,
   `LsLinen`) and Material 3 components.

---

## 1. Capture flow — rebuild

The camera preview is far too small. Rebuild the capture flow as **two screens plus a viewer**,
with the preview edge-to-edge and every control floating over it.

### Screen A — Barcode

The entry point of a new scan. Contains:

- A **live barcode scanner** using the repaired ML Kit module (task 2), with the existing aiming
  reticle and haptic-pulse-on-lock behaviour.
- A **manual barcode entry** field, for when a barcode is damaged or missing.
- A **package code** text field (see task 8).
- A **`Start scan`** button, enabled only once a barcode is locked or typed.

Tapping `Start scan` navigates to Screen B.

There is **no pre-capture taxonomy selection**. Category, sub-category, gender and season are
extracted by the AI and confirmed later in the review dialog. If the current code has dropdowns
for those on a pre-capture screen, remove them.

### Screen B — Capture

- **Full-bleed camera preview.** It fills the screen edge to edge. Nothing is laid out beside or
  below it.
- All controls **float over** the preview as translucent overlays: shutter, done/finish, flash
  mode (task 4), and the thumbnail strip.
- Capture 1–8 photos, named `IMG_<apparel_id>_<index>.jpg` in internal storage as today.
- The thumbnail strip stays visible over the preview. Tapping a thumbnail opens the photo viewer.
- `Finish Item` bundles the photos with the barcode and enqueues the scan, exactly as today.

### Screen C — Photo viewer

Opened by tapping any thumbnail, on Screen B **and** in the review dialog. Shows the photo large,
with three floating controls:

| Control | Behaviour |
|---|---|
| **Back** | Close the viewer, return to where it was opened from |
| **Star** | Set this photo as the key photo. Reflected immediately in the thumbnail strip |
| **Delete** | Remove the photo from the batch, with a confirmation |

The star writes `key_photo_index`. It is the operator's override of the server's suggestion — see
task 7.

**Acceptance:** the preview occupies the full screen on a 5" device with no letterboxing; every
control is reachable one-handed; deleting the key photo reassigns the key to the first remaining
photo rather than leaving a dangling index.

---

## 2. Barcode scanner — review and repair

**The ML Kit barcode module is not working correctly.** Review the whole module and fix it; do
not patch symptoms. No diagnosis has been made, so start by establishing what actually fails —
detection rate, focus, lifecycle, analyzer backpressure, or the resolution handed to ML Kit.

Points worth checking, in rough order of likelihood:

- The `ImageAnalysis` backpressure strategy and whether frames are being closed correctly. A
  leaked `ImageProxy` stalls the analyzer after a handful of frames.
- Whether the analyzer resolution is high enough for a small EAN-13 at working distance.
- Camera lifecycle across configuration change, screen off, and returning from another screen.
- Whether the barcode format list is set explicitly. Scanning "all formats" is materially slower
  than a declared set.
- Continuous autofocus, and whether tap-to-focus cancels it.

Supported formats stay as they are: EAN-13, UPC-A, QR Code, Code-128, Code-39.

**Also: the clone dialog has no scanner at all.** In `DailyLedgerScreen.kt` the "Clone Item
Attributes" dialog asks for the new barcode with a plain text field, and ML Kit is never invoked
there. The operator is being forced to type barcodes by hand. Wire the same scanner component
Screen A uses into that dialog, keeping manual entry as the fallback.

**Acceptance:** a printed EAN-13 locks in under a second at normal working distance, repeatedly,
including after backgrounding the app; the clone dialog scans.

---

## 3. Flash — three states

Flash is currently a boolean torch. `ImageCapture.FLASH_MODE_AUTO` is set at construction and then
immediately overridden by the torch flag, so **Auto is unreachable**.

Replace it with an explicit three-state control on Screen B:

| State | `ImageCapture.flashMode` |
|---|---|
| Off | `FLASH_MODE_OFF` |
| On | `FLASH_MODE_ON` |
| Auto | `FLASH_MODE_AUTO` |

Keep continuous torch as a separate concern from capture flash mode; do not let one overwrite the
other. Persist the chosen state across sessions.

---

## 4. Navigation order

Bottom bar, left to right: **Scan › Review › Ledger › Settings**.

The destination currently called `Capture` moves to first position and is relabelled **"Scan"**.
Its route may stay `capture`.

---

## 5. Authentication — mandatory, no exceptions

Three related removals and one addition. The app must not be operable by an unauthenticated user.

**Remove Demo Mode entirely.** Every part of it:

- the mode itself and its settings toggle,
- the `demo_0001` sequential id generator,
- the amber DEMO badge in the Review list and Daily Ledger,
- the local heuristic extraction fallback used when the server is unreachable,
- the "activate demo mode" quick action on the first-run connection banner,
- the `is_demo_record` column and any `record_type` CSV logic still referencing it.

Demo Mode exists only in the app — the server has no knowledge of it, so nothing server-side is
affected. The current CSV header has no `record_type` column already.

**Remove every path that lets the app work without credentials.** No skip, no guest, no
"continue offline without logging in", no default password.

**First run must collect, and validate, three things before any other screen is reachable:**

1. Server address
2. Username
3. Password

Exchange them for a session token via `POST /api/v1/auth/login` and store the token in
EncryptedSharedPreferences as today. Only on success does the app proceed to the main navigation.

Handle the contract's auth errors distinctly: `ACCOUNT_DISABLED` tells the operator to find a
supervisor (retrying will not help); `TOKEN_REVOKED` and `TOKEN_EXPIRED` prompt for login again.

**Connectivity is not authentication.** Once logged in, an unreachable server must not lock the
operator out — scans continue to be captured and queued offline. Only the *absence of credentials*
blocks use of the app.

---

## 6. Reference tables — stop hardcoding the vocabulary

`ReferenceVocabulary.kt` contains roughly 1,500 lines of hardcoded tables, and
`GET /api/v1/reference-tables` is never called. The contract forbids this in §4.6: *"Never ship a
hardcoded copy."* Beyond blocking Armenian, it is a correctness bug — the moment a supervisor adds
a brand or sub-category through the dashboard, app and server disagree silently.

Replace it:

1. **Fetch at login**, sending `If-None-Match` with the cached `version`. On `304`, keep the
   cache. On `200`, replace the whole cached copy and store the new `version`.
2. **Cache on the device** (Room or a file) and keep working from the cache when the server is
   unreachable. A stale vocabulary is not an error.
3. **Cheap freshness check:** `/health` returns `reference_version`. Only call the tables endpoint
   when it differs from the cached version. `/health` needs no authentication.
4. **Key everything on `en`.** Display `hy`; store, export and transmit `en`.
5. Accept values **not** in any table — the server returns an unmatched transcription unchanged.
   Mark them as unmatched; never snap them to the nearest entry.

Delete the hardcoded lists. The four short enums (`category`, `gender`, `season`, `color`) may
stay hardcoded **for validation only**, never for display — their Armenian labels come from the
served tables.

---

## 7. Review dialog

### 7.1 Thirteen fields, not twelve

The response `data` object now carries **13** fields. `care_info` is new: the URL behind the
garment's care QR code, decoded by the AI from the photos.

Add it to the review dialog as an editable field labelled **"Care instructions"**. It is a URL.
Expect an empty string when no QR code was visible, and expect **lower confidence** than printed
fields when one was — a misread URL looks plausible and cannot be checked by eye. Display it as
text; do not auto-open it or render it as a live link without the operator choosing to.

### 7.2 Material is now a composition

`data.material` used to be a single fibre name (`Cotton`). It is now the **full composition**
(`80% Cotton 20% Polyester`), in English, with percentages preserved.

Display it as **one string**. Do not split it, re-order it, re-percentage it, or look it up as a
table key. If any existing code parses material, remove that parsing.

### 7.3 Size is the European value

`data.size` now carries only the European size, prefixed `EU` (`EU 122/128`). A label with no
European reference arrives as printed (`XL`). No client-side parsing — the server has chosen.

### 7.4 Armenian display

Render Armenian for AI results from the response's **`data_hy`** object, which carries the same 13
keys as `data`.

- A `null` in `data_hy` means **display the English value from `data`** — never a blank.
- Seven keys are `null` by design: `brand_name`, `country_of_origin`, `size`, `original_price`,
  `netto`, `brutto`, `care_info`.
- Use the cached reference tables (task 6) for everything the *operator* picks or types — pickers,
  type-ahead, filters — not `data_hy`.

Add an **AM / EN toggle**. It changes only what is displayed, never what is stored.

Selectors for `category`, `sub_category`, `gender`, `season`, `color` and `material` should be
**searchable pickers over the Armenian labels**, not free-text boxes. This is the single most
effective thing the app can do to keep the data groupable — it removes the opportunity to type a
variant spelling at all. Where the operator must still type a garment type genuinely absent from
the table, store what they typed verbatim and let it flow through as unmatched.

### 7.5 Suggested key photo

The response envelope now carries `suggested_key_photo_index` — the photo the model judged to be
the main product shot. It is `null` until extraction completes and `null` when the model could not
choose.

**Pre-select it** in the review dialog's photo carousel. The operator overrides with the star
control in the photo viewer (task 1). The request field `key_photo_index` is **unchanged and still
required** on submit — the operator's choice remains the authority.

### 7.6 Set size

A `Set of X` stepper, default `1`, for articles sold as a packaged set — a 2-pack of stockings, a
2-pack of undies.

It sits **outside** the confidence-highlighting logic: no confidence, never highlighted amber,
never pre-filled from a response. The packaging hides the second garment, so the AI is never asked.

Raising it changes nothing else. The row still describes one packet: `Netto` and `Brutto` stay as
read from the label — **the app never divides by set size**. A packet holding mixed sizes or
colours is not a set and must be scanned as separate articles.

### 7.7 Draft, and the approval gate

Two client requests that contradict each other, resolved as a setting.

**Save as draft.** An explicit draft action saves an incomplete item regardless of any validation.
Drafts are not approved, do not enter the Ledger, and are not exported.

**New setting: "Submit approval requires all fields complete"** — default **OFF**.

| State | Behaviour on approve |
|---|---|
| OFF | Warn about empty fields, listing them, but let the operator through |
| ON | Block approval until every required field is non-empty |

**Required set when ON — 12 fields:**

```
Barcode  Brand  Category  SubCategory  Gender  Season
Size     Color  Material  Country      Netto   Brutto
```

Never blocking, in either state: `OriginalPrice`, `PackageCode`, `SetSize`, `CareInfo`.

Keep the existing confidence behaviour: any field with `confidence < 0.70` gets the amber
background (`#FFF9C4`); a field the model returned empty displays empty and amber. An operator may
knowingly accept a blank when the toggle is OFF.

---

## 8. Package code

A text field on **Screen A**, beside the barcode.

It is **sticky**: once typed it persists across subsequent scans until the operator types a
different one. It is not cleared by finishing an item, by approving, or by leaving the screen.

It is never sent to the server and never sent to the AI — it exists only in Room and in the CSV
column `PackageCode`.

---

## 9. Ledger — editable until the batch is submitted

Approved Ledger items become editable, **until the export batch they belong to is submitted**.
After that they are locked.

The state already exists: rows are stamped with an `ExportBatch` at export, and
`confirmCsvCutOff` / `confirmAllActiveCsvCutOff` record submission. Edit is allowed while a row is
unsubmitted; the lock engages at cut-off. `LedgerDao.updateLedgerItem` already exists.

- A locked row is visibly locked and its fields are read-only.
- **No new CSV column and no audit trail.** A row therefore never appears in two export files with
  different values.
- The accepted consequence: an error found after export cannot be fixed in the app. It becomes a
  dashboard correction.

---

## 10. CSV export — 19 columns, and the encoding fix

### 10.1 The columns

```
Barcode, Brand, Category, SubCategory, Gender, Season, Size, Color,
Material, Country, OriginalPrice, Netto, Brutto, Timestamp, Operator, ExportBatch,
PackageCode, SetSize, CareInfo
```

The current export writes only the first 16. Three are missing:

| Column | Source |
|---|---|
| `PackageCode` | Operator, Screen A (task 8) |
| `SetSize` | Operator, review dialog (task 7.6). Blank, absent, `0` or non-numeric all mean `1` |
| `CareInfo` | AI, `data.care_info` (task 7.1) |

Exact types, nullability and per-column rules are in the attached `csv_export_format.txt`. Follow
it literally.

### 10.2 The encoding bug — fix this even though it looks trivial

The file is written with `csvFile.writeText(sb.toString())`. Kotlin defaults to **UTF-8 with no
BOM**, so Excel on a Windows locale opens it as CP1252 and every accented character is corrupted:
`ALGODÓN` renders as `ALGODÃ“N`. The client has reported this as a data defect.

**Write a UTF-8 BOM (`U+FEFF`, bytes `EF BB BF`) as the first three bytes of the file.**

This corrupts Brand, Country, SubCategory and Material alike — it is not specific to material, and
it is not caused by the AI.

### 10.3 Unchanged

One row = one scanned article = one packet. Export via the native share sheet
(`Intent.ACTION_SEND`). RFC 4180 quoting as today.

---

## 11. Data model

Room changes, with a migration — **do not destroy existing rows**; operators may hold unexported
scans.

**Add** to `ScanEntity` and `DailyLedgerEntity` as appropriate:

| Column | Type | Notes |
|---|---|---|
| `package_code` | `String?` | Operator, sticky |
| `set_size` | `Int` | Default `1` |
| `care_info` | `String?` | AI |
| `care_info_conf` | `Float` | AI, like the other 12 confidences |
| `suggested_key_photo_index` | `Int?` | From the response envelope; `key_photo_index` remains the operator's value |
| `is_draft` | `Boolean` | Default `false` (task 7.7) |

**Remove:** `is_demo_record` and anything else that exists only to serve Demo Mode.

**Settings** (`AppSettings`): add the strict-approval toggle (default off), the AM/EN display
language, and the persisted flash mode.

---

## 12. Definition of done

- [ ] Camera preview is full-bleed; all controls float over it
- [ ] Screen A → `Start scan` → Screen B flow works, package code sticky across scans
- [ ] Thumbnail tap opens the viewer; back / star / delete all work; star sets the key photo
- [ ] Barcode scanner locks an EAN-13 reliably, including after backgrounding
- [ ] Clone dialog scans a barcode instead of requiring typing
- [ ] Flash Off / On / Auto all reachable and persisted
- [ ] Nav order is Scan › Review › Ledger › Settings
- [ ] No path exists into the app without server + username + password
- [ ] No trace of Demo Mode remains
- [ ] `ReferenceVocabulary.kt`'s hardcoded tables are gone; tables come from the server and cache
- [ ] Review dialog shows 13 fields including Care instructions
- [ ] Material renders as a full composition string, unparsed
- [ ] AM/EN toggle works; `data_hy` drives AI-result Armenian; `null` falls back to English
- [ ] `suggested_key_photo_index` is pre-selected and overridable
- [ ] Draft saves an incomplete item; the strict toggle blocks approval on the 12 required fields
- [ ] CSV has all 19 columns in order, starts with a UTF-8 BOM, and opens correctly in Excel with
      an accented brand name in it
- [ ] Room migration preserves existing unexported scans
- [ ] An offline scan is still captured, queued and sent when connectivity returns

---

## Platform note — Android

Target the existing Compose/CameraX/ML Kit stack. Keep Room as the local store and Retrofit as the
transport.

> **For the PWA variant, substitute:** implement the same behaviour with the browser's
> `BarcodeDetector` API (with a ZXing/`zxing-wasm` fallback where unsupported), `getUserMedia` +
> `<video>` for the full-bleed preview, IndexedDB in place of Room, and the File System Access API
> or a download for the CSV export — the BOM requirement is identical. Every rule about the
> contract, the vocabulary, Armenian, the 19 columns and the approval gate applies unchanged.

## PROMPT ENDS
