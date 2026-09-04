# Client Decisions — 2026-09-04

**Status:** decided, not yet implemented. Nothing in this file has been written into the
source-of-truth specs or the code yet.

**Purpose.** A single consolidated record of every decision taken on 2026-09-04, split by the
module that owns the work. It is the input from which an AI Studio build prompt will be
assembled — the prompt itself is deliberately **not** written yet, because more client comments
are still arriving.

**Inputs consolidated here:**

| Source | Items |
|---|---|
| Client Feedback #1 | 12 comments |
| Follow-up decisions (8 questions, this session) | material, Armenian, key photo, approval gating, required-field set, ledger edit, v1.4 scope |
| Second batch, same day | 10 mobile items + 2 AI rules (A, B) |
| Prior session | `docs/handoff_csv_v2_2026-09-04.md` — `PackageCode`, `SetSize` |

**Numbering used below.** `C#n` = Client Feedback #1 comment *n*. `M#n` = second-batch mobile
item *n*. `R-A` / `R-B` = the two AI rules.

---

## 0. Cross-cutting — the API contract goes to v1.4

`middle_ware/api_contract.md` has been **locked** since v1.2 and was deliberately routed around
twice (see the CSV v2 handoff §1). Three decisions now require reopening it. They are batched
into **one** version bump and **one** coordination round with the Android developer.

| Change | Driver | Shape |
|---|---|---|
| `data` grows 12 → **13 fields** | C#10 / M#10 / R-B | `care_info` added, `{value, confidence}` like every other AI field |
| `suggested_key_photo_index` | C#5 | **Envelope** field, beside `apparel_id`. Integer, 0-based |
| `data_hy` | C#3, C#11 | **Envelope** object, Armenian labels for every translatable field |

**The invariant still holds.** `data` is AI output only. `care_info` is read by the model off a
QR code, so it belongs there; `suggested_key_photo_index` and `data_hy` are server-derived
metadata, so they go in the envelope. `PackageCode` and `SetSize` remain operator-entered and
therefore stay out of the API entirely — see §0.1.

Every document that asserts "always 12 fields" must be updated: `api_contract.md` §4.2 and §4.3,
`dev_report.md`, and the CSV v2 handoff's §3 routing table.

### 0.1 Reconfirmed: `PackageCode` and `SetSize` stay CSV-only

Asked again now that the contract is being reopened anyway, and **reaffirmed**. Both are
operator-entered, neither is AI output, and carrying them would buy only the recovery of package
codes after a device wipe before export. That consequence remains knowingly accepted.

### 0.2 Field naming — one name, chosen to avoid dashboard work

The client calls it *"Care instructions"*. The dashboard already ships a `care_info` column, a
`CareInfo` CSV header in its importer's `V2_OPTIONAL`, and an editable field on the item page.
Adopting the dashboard's existing name means **zero importer changes**.

| Layer | Name |
|---|---|
| Gemini schema / API `data` | `care_info` |
| CSV column (19th) | `CareInfo` |
| Dashboard column | `care_info` (already exists) |
| Operator-facing label | "Care instructions" / Armenian equivalent |

---

## 1. Mobile app

The largest share of the work. Six of the twelve original comments and nine of the ten
second-batch items are Android-only.

### 1.1 Capture flow — rebuilt (M#1, M#2, M#3, M#7, M#8, C#10, C#12)

**M#1 — two-stage capture, full-bleed preview.** The camera preview is currently too small. It
becomes edge-to-edge with all controls floating over it. The flow splits into two screens:

```
Screen A — Barcode                      Screen B — Capture
  live barcode scanner                    full-bleed camera preview
  manual barcode entry                    floating shutter / done / flash
  package code entry  (M#8)               floating thumbnail strip
  [ Start scan ]  ────────────────────►   tap a thumbnail → photo viewer
```

**M#8 — package code moves.** It is entered on **Screen A**, not on a separate pre-capture
screen, and stays sticky across scans until the operator types a different one.

> **Supersedes** `Mobile_app/architecture.md` "Technical Setup Plan" step 1, which places the
> package field on a Pre-Capture screen alongside Category / Sub-category / Gender / Season
> dropdowns. Those four dropdowns are **stale** — since contract v1.2 all four are AI-extracted,
> not operator-selected before capture. Screen A replaces that screen entirely.
> *Flagged for confirmation: no pre-capture taxonomy selection survives.*

**M#2 / C#10 — photo viewer.** Tapping a thumbnail opens a large preview with three floating
controls. This is the fuller specification of C#10 ("enlarge the photo") and supersedes it.

| Control | Action |
|---|---|
| Back | Close the preview, return to Screen B |
| Star | Set this photo as the key photo (`key_photo_index`) |
| Delete | Remove the photo from the batch |

The star is also how the operator **overrides** the AI's suggestion from C#5 (§2.4).

**M#3 — barcode scanner is not working correctly.** The whole ML Kit module needs review and
repair, not a patch. Treat it as a defect with no diagnosis yet.

**C#12 — the clone dialog has no scanner at all.** Verified in source: `DailyLedgerScreen.kt`
lines 302–335 render a plain `OutlinedTextField` for the new barcode, and ML Kit is never
invoked in that flow. This is not a broken scanner — the scanner was never wired in. Add the
same component Screen A uses.

**M#7 — three-state flash.** Currently a boolean torch. `CaptureScreen.kt:108` sets
`ImageCapture.FLASH_MODE_AUTO`, then lines 113–115 immediately override it from the torch
boolean, so Auto is unreachable. Replace with an explicit **Off / On / Auto** control mapping to
`FLASH_MODE_OFF` / `FLASH_MODE_ON` / `FLASH_MODE_AUTO`, kept separate from continuous torch.

### 1.2 Navigation (M#9)

Bottom bar order, left to right: **Scan › Review › Ledger › Settings**.

Current declaration order in `MainActivity.kt` is Review, Capture, Ledger, Settings. `Capture`
moves to first position and is relabelled **"Scan"**.

### 1.3 Authentication and first run (M#4, M#5, M#6)

| Item | Decision |
|---|---|
| M#4 | Remove every path that lets the app operate without a user and password |
| M#5 | Remove Demo Mode entirely — the mode, the `demo_0001` id sequence, the amber DEMO badge, the local heuristic fallback, and the "activate demo mode" quick action on the connection banner |
| M#6 | First run **must** collect server address, username and password before any other screen is reachable |

**Scope note:** Demo Mode is Android-only. There are 43 references in the Android source and
**zero** in the middleware. Removing it needs no server work. It also has no CSV impact: the
`record_type` column from the v1.0-era spec is already absent from the current 16-column export
header.

### 1.4 Review dialog and approval (C#4, C#7)

These two comments contradict each other — "save as draft" versus "no approval unless all fields
are complete" — and C#7 also contradicts `architecture.md` §4, which lets an operator knowingly
accept a blank yellow field, and the CSV spec, which declares `OriginalPrice`, `Netto` and
`Brutto` nullable.

**Resolution — a settings switch, because the client is expected to change their mind:**

> **"Submit approval requires all fields complete"** — default **OFF**.
> **OFF:** approval warns about empty fields but does not block.
> **ON:** approval is blocked until every required field is filled.

**Required set when ON — 12 fields:**

```
Barcode  Brand  Category  SubCategory  Gender  Season
Size     Color  Material  Country      Netto   Brutto
```

Never blocking: `OriginalPrice`, `PackageCode`, `SetSize`, `CareInfo`.

> **Consequence, stated deliberately.** Because this is a toggle, rows produced with it OFF can
> still carry blank weights. `Netto` and `Brutto` therefore stay **Nullable** in
> `csv_export_format.txt`. The gate is an operator-side policy, not a schema change — flipping
> the schema would break the dashboard importer, which is out of scope for this batch.

**C#4 — save as draft.** An explicit draft action saves an incomplete item regardless of the
toggle. Drafts are not approved, do not enter the Ledger, and are not exported.

### 1.5 Ledger editing (C#1)

Approved Ledger items become editable, **until the batch they belong to is submitted**. After
that they are locked.

The app already has the state to hang this on: `stampExportBatch` marks rows with an
`ExportBatch`, and `confirmCsvCutOff` / `confirmAllActiveCsvCutOff` record submission. Edit is
allowed while a row is unsubmitted; the lock engages at cut-off. `LedgerDao.updateLedgerItem`
already exists.

**No new CSV column and no audit trail.** A row therefore never appears in two export files with
different values, and the CSV stays a true record of what was sent. The accepted cost: an error
found the morning after export cannot be fixed in the app and becomes a dashboard correction.

### 1.6 Armenian display (C#3, C#11)

**The app must stop hardcoding the vocabulary.** `ReferenceVocabulary.kt` is 1,539 lines of
literal tables and `GET /api/v1/reference-tables` is never called — directly against
`api_contract.md` §4.6 ("Never ship a hardcoded copy"). Beyond blocking Armenian, this is a
latent correctness bug: the moment a supervisor adds a brand or sub-category, app and server
disagree silently.

| Source | Used for |
|---|---|
| `GET /api/v1/reference-tables` (cached, `If-None-Match` at login) | Pickers, type-ahead, and the Armenian label for any value the operator chooses |
| `data_hy` in the extraction response (§2.5) | The Armenian rendering of AI results, including material compositions |

Rules, unchanged from `api_contract.md` §8.3: display `hy`, **store and export `en`**; a value
with no Armenian renders in English, never blank; `brand` and `country` display in English by the
client's 2026-08-30 decision; `size` and `original_price` are never translated. `care_info` is a
URL and is never translated.

### 1.7 CSV export (C#8, M#10, encoding)

**19 columns.** v1 was 16; the CSV v2 handoff added two; `CareInfo` is the nineteenth.

```
Barcode, Brand, Category, SubCategory, Gender, Season, Size, Color,
Material, Country, OriginalPrice, Netto, Brutto, Timestamp, Operator, ExportBatch,
PackageCode, SetSize, CareInfo
```

**C#8 / `PackageCode` / `SetSize` are still unbuilt.** Verified: the export header at
`ApparelRepository.kt:360` is still the 16-column v1 set. The specification is complete in
`Mobile_app/csv_export_format.txt` and `architecture.md`; only the implementation is missing.

**Encoding — the `ALGODÃ“N` mojibake is found, and it is one line.**
`ApparelRepository.kt:382` writes the file with `csvFile.writeText(sb.toString())`. Kotlin
defaults to UTF-8 **with no BOM**, so Excel on a Windows locale reads it as CP1252 and `ALGODÓN`
renders as `ALGODÃ“N`. Prepend a UTF-8 BOM (`U+FEFF`) to the file.

> This is a **separate defect** from C#6. It is not caused by the AI prompt and would have
> survived the material fix untouched — it corrupts any accented value, including brand names
> and countries.

### 1.8 Mobile summary

| Ref | Work | Kind |
|---|---|---|
| M#1, M#8 | Two-stage capture, full-bleed preview, floating controls, package code on Screen A | Rebuild |
| M#2, C#10 | Full-screen photo viewer: back / star / delete | New |
| M#3 | Barcode scanner module review and repair | Defect |
| C#12 | Wire ML Kit into the clone dialog | Missing feature |
| M#7 | Flash Off / On / Auto | Defect |
| M#9 | Nav order Scan › Review › Ledger › Settings | Trivial |
| M#4, M#5, M#6 | Mandatory credentials, remove Demo Mode, first-run setup | Removal |
| C#4, C#7 | Draft save + strict-approval toggle | New |
| C#1 | Ledger edit until batch submitted | New |
| C#3, C#11 | Reference tables from the server; render `data_hy` | Rebuild |
| C#5 | Pre-select `suggested_key_photo_index`, star to override | New |
| C#8 | `PackageCode` + `SetSize` → 18 columns | Unbuilt spec |
| M#10 | `CareInfo` → 19 columns | New |
| — | UTF-8 BOM on the CSV | Defect |

---

## 2. Middleware

### 2.1 Material — full composition, one language, invariant fibre names (C#2, C#6)

**The defect, measured.** Run against the real 85-entry table:

```
"100% Cotton"                                      -> "Cotton"      (matched — percentage lost)
"80% Cotton 20% Polyester"                         -> unchanged     (no match)
"100% ALGODÓN / ALGODÃO / COTTON / COTON / COTONE" -> unchanged     (no match)
"Upper: Leather, Sole: Rubber"                     -> unchanged     (no match)
```

`material` is in `MATCHED_FIELDS` (`fuzzyMatcher.ts:233`), so the whole composition string is
snapped against a table of single fibres. A single-fibre composition loses its percentage; a
multi-fibre one survives only because nothing matches. That inconsistency is C#2.

**Decision.** Report the **full composition**, in **one language**, with **invariant fibre
names** — `cotton` always resolves to the same canonical English term.

**Implementation — snap per fibre segment, not per string.** Split the composition, match each
fibre name onto the material table, reassemble with the percentages preserved.
`exportService.translateMaterial()` (`exportService.ts:80`) already splits compositions exactly
this way for the Armenian legal export, so the segmentation logic is written and tested — it gets
reused, not reinvented.

```
"100% Cotton"                       -> "100% Cotton"
"80% ALGODON 20% POLIESTER"         -> "80% Cotton 20% Polyester"
"40% Cotton 40% Nylon 20% Elastane" -> "40% Cotton 40% Nylon 20% Elastane"
"Leather"          (shoe, inferred) -> "Leather"   confidence <= 0.50
```

**Docs that currently assert the opposite and must change:**

| File | Says |
|---|---|
| `api_contract.md` §8.1 | "A single fibre name, e.g. `Cotton` — not a composition string" |
| `csv_export_format.txt` | "Single fibre name matched from 85 reference fibres" |
| `dev_report.md` §24.2 | "the matcher drops the percentage from a single-fibre composition" |

**C#6 needs no new prompt work.** The multilingual rule and the footwear-inference rule are
**already committed** at `d63e1aa` ("debug - material report corrected") — `buildSystemInstruction()`
carries both, and the working-tree diff against it is pure re-indentation. The open question is
**deployment**, not authoring: confirm the VPS is running `d63e1aa` before touching the prompt.

### 2.2 Size — EU only (R-A)

Labels list the same size in many systems. The model extracts **only** the European value and
reports it with a normalised `EU ` prefix, whether the label printed `EUR` or `EU`.

```
label    US 6X/7  CA 6-8A  EUR 122/128  CN 130/64  MX 6-8A  AUS 7-8  UK 6-8Y
report   EU 122/128
```

The numeric portion is transcribed verbatim; only the system prefix is normalised. `size` is free
text — it passes through neither `MATCHED_FIELDS` nor `CONSTRAINED_FIELDS` — so this is a prompt
and schema-description change only.

> **Interpretation, flagged for confirmation.** The rule is read as applying to labels listing
> **several** size systems. A label showing only `XL`, or only `32W x 34L`, has no European value
> to select and is reported as printed. See §4.

### 2.3 Care instructions from a QR code (R-B, M#10)

A garment may carry a QR code linking to usage and care information. The model decodes it and
returns the URL in the new `care_info` field. Empty string at confidence 0.0 when no QR code is
visible — the same convention as every other field.

Routing is already settled by §0.2: API `care_info` → CSV `CareInfo` → dashboard `care_info`.

> **Risk worth stating, and a cheaper path.** Gemini is not a QR decoder; it reads QR content
> with real but imperfect reliability, and a plausible-looking wrong URL is worse than an empty
> field — it cannot be spotted by eye. Two mitigations, neither of which blocks the decision:
> cap the confidence so low-confidence links route to the flywheel for review, and note that
> **ML Kit already decodes QR codes** on the device (it is in the app's supported-format list)
> and can run against a still image. If accuracy disappoints in testing, decoding on-device is
> exact and free. Proceeding as decided; raising it so the fallback is on record.

### 2.4 Suggested key photo (C#5)

Today `key_photo_index` is **required in the request** and chosen by the operator
(`api_contract.md` §4.2); the app sends it from `ScanEntity.keyPhotoIndex`. The client expects
the main product image to be detected automatically.

**Decision.** The model suggests it; the operator overrides.

- The server returns `suggested_key_photo_index` in the response **envelope** — never in `data`.
- The request field `key_photo_index` **stays required**; the operator's choice remains the
  authority, and the suggestion is a pre-selection.
- The app pre-selects the suggested photo and the operator changes it with the star control (§1.1).

### 2.5 Armenian in the response (C#3, C#11)

The server returns `data_hy` alongside `data`: **every translatable field**, not only the ones
the device cannot resolve alone.

```
"data":    { ...13 English fields, each {value, confidence}... },
"data_hy": { "sub_category": "Տաբատ",
             "material":     "80% Բամբակ, 20% Պոլիամիդ",
             "color": "…", "gender": "…", "season": "…", "category": "…",
             "brand_name": null, "country_of_origin": null,
             "size": null, "original_price": null,
             "netto": null, "brutto": null, "care_info": null }
```

**Shape rules**, following the existing discipline that `data` never omits a key:

- `data_hy` carries **all 13 keys**. `null` means *no Armenian exists — display the English word*,
  per `api_contract.md` §8.3 rule 1. Never blank, never machine-translated.
- `null` by design for `brand_name` and `country_of_origin` (English everywhere including
  paperwork, client decision 2026-08-30), and for the free-text fields `size`, `original_price`,
  `netto`, `brutto`, and the URL `care_info`.
- Present only when `data` is present — absent for `PENDING_AI` and `NEEDS_ATTENTION`.
- Nothing Armenian is ever **stored, exported or sent back**. English keys remain the wire and
  ledger vocabulary.

`exportService.translateMaterial()` and `toArmenian()` already produce exactly these strings for
the legal export; `data_hy` reuses them.

### 2.6 Middleware summary

| Ref | Work |
|---|---|
| C#2 | Per-segment material matching; `material` leaves `MATCHED_FIELDS` as a whole-string snap |
| C#6 | **No code change** — verify `d63e1aa` is deployed |
| R-A | EU-only size extraction, `EUR`/`EU` normalised to `EU` |
| R-B, M#10 | `care_info` field: prompt, response schema, `EXTRACTED_FIELDS`, normalisation |
| C#5 | `suggested_key_photo_index` in the envelope |
| C#3, C#11 | `data_hy` in the envelope |
| — | `api_contract.md` → **v1.4**; `dev_report.md` §24.2 and the change log |

**`UI_messaging_protocol.md` needs no change.** Checked: it carries reference-table names for
the control channel, not the extracted-field list. Nothing in it enumerates the 12/13 fields.

---

## 3. Dashboard

Explicitly out of scope for this batch as a build target. Recorded here so the routing is
complete and nothing is lost.

### 3.1 `CareInfo` — already fully plumbed, no code change

The one second-batch item that touches the dashboard turns out to need **no dashboard code at
all**. Verified across five files:

| File | State |
|---|---|
| `src/db/schema.ts:40` | `care_info TEXT` — column exists, plus an `ensureColumns` entry at :200 |
| `src/services/import.ts:46` | `CareInfo` already in `V2_OPTIONAL` |
| `src/services/import.ts:188` | Already mapped: `values.care_info = trimOrNull(raw.CareInfo)` |
| `src/services/import.ts:208` | In `INSERT_COLUMNS`, and **not** in `PROTECTED_ON_OVERWRITE` — so a re-import refreshes it, which is correct now that the app is its source |
| `src/views/item.ejs:77`, `services/items.ts:153`, `services/exportPresets.ts:127` | Editable on the item page; in preset 4 (FULL) |

The 19-column CSV will simply import. **Documentation only:**

- `Dashboard_plan_final.md` §14.1 currently reads *"`care information` remains deferred and
  manual-entry only."* That parked case has now arrived, exactly as `package code` did earlier
  the same day. Rewrite it the same way.
- §5.1 column count 18 → 19.

### 3.2 Carried over, still open from the CSV v2 handoff

Neither is touched by this batch; both are recorded so they are not lost.

1. **Presets 1–3 and `SetSize`.** The seller invoice, customs sheet and inspection form all
   collapse clone families into one line. Nobody has said what a set size means for a *collapsed*
   line — the representative's value, or a sum. Deliberately not guessed.
2. **`package_code` is in `PROTECTED_ON_OVERWRITE`.** A dashboard-typed value survives a
   re-import. That was right while the column was manual-entry only; now that the app is its
   source it is probably backwards. One line to remove — but it is a dashboard change and waits
   for a dashboard batch.
3. **Armenian label `Կոմպլեկտ`** for `SetSize` on the item page still needs a native check.
4. **`Pieces`** remains dashboard-only, manual-entry, not emitted by the app.

---

## 4. Open — not decided

| # | Question | Blocking |
|---|---|---|
| 1 | **C#9 — "need to discuss file export/output".** No actionable content. The 19-column CSV is fully specified; unknown whether they want a different format, a different delivery channel, or more columns | The client |
| 2 | **R-A fallback.** What to report when a label shows no European size at all. Assumption: report as printed, unchanged. Needs one word of confirmation | §2.2 |
| 3 | **Pre-capture taxonomy dropdowns.** Assumed removed — Category / Sub-category / Gender / Season have been AI-extracted since v1.2, and M#1's Screen A does not mention them | §1.1 |
| 4 | **Is `d63e1aa` deployed to the VPS?** If not, C#6 may already be closed and needs only a deploy | §2.1 |
| 5 | **Which APK did the client test?** The source inspected here is `apparel-vision_update7_source.zip`, which may not be that build | All mobile findings |

---

## 5. What was verified in code, and what was not

Everything asserted above about current behaviour was read or executed, not inferred from the
specs — which in several places describe the system as it was designed rather than as it runs.

**Executed.** `materialIndex.matchOrKeep()` against the live 85-entry reference table, producing
the four results in §2.1.

**Read in the middleware.** `fuzzyMatcher.ts` (`MATCHED_FIELDS`, `FUSE_OPTIONS`, `matchOrKeep`),
`geminiService.ts` (`buildSystemInstruction`, `buildExtractionSchema`, and that only images plus a
fixed prompt reach the model), `visionService.ts` (`normalizeExtraction`), `exportService.ts`
(`translateMaterial`, `toArmenian`), `types/index.ts` (`EXTRACTED_FIELDS`), `api_contract.md`
v1.3, `dev_report.md` §24, `UI_messaging_protocol.md`.

**Read in the dashboard.** `schema.ts`, `import.ts`, `items.ts`, `exportPresets.ts`, `item.ejs`,
`types/item.ts`, `Dashboard_plan_final.md` §14.1.

**Read in the Android app.** Extracted from `Mobile_app/build/apparel-vision_update7_source.zip`
— `ApparelRepository.kt` (CSV writer, 16-column header, export batch and cut-off),
`DailyLedgerScreen.kt` (clone dialog), `MainActivity.kt` (nav destinations),
`CaptureScreen.kt` and `CameraPreviewView.kt` (flash and torch),
`ReferenceVocabulary.kt` (1,539 hardcoded lines), `LedgerDao.kt`, `ScanEntity.kt`,
`MiddlewareApiService.kt`, `VisionExtractionService.kt`.

**Not verified.** Whether the VPS runs `d63e1aa`; which APK the client tested; and whether
`update7` is the newest source zip in `Mobile_app/build/` — nine archives are present and they
are not dated in their filenames.
