# Handoff — CSV v2: `PackageCode` and `SetSize`

**Date:** 2026-09-04 · **Scope:** two client requests, both resolved as *CSV-only* changes.
**Purpose of this file:** transfer state to a follow-up conversation that will compare these
decisions against newer client comments and route work to the right module.

---

## 1. What was asked, and what was decided

Two separate client requests arrived in one session. Both looked like they might need the
Android↔middleware contract changed. **Neither did.**

### Request A — package id

> "The mobile app should report *package id*. It is not needed by Gemini; it is only
> reported in the CSV file."

**Decided (user, 2026-09-04):**

| Question | Decision | Rejected alternative |
|---|---|---|
| Carry it through the API? | **No.** Device-local → Room → CSV. `api_contract.md` untouched. | Adding an optional `package_code` to `POST /vision/extract`, echoed in responses and stored on `server_scans`. Would have survived a device wipe before export; judged not worth reopening a locked contract. |
| Field name | **`package_code`** / CSV header **`PackageCode`** | `package_id` / `PackageId`. Rejected because the dashboard schema, the importer, the client's invoice column and the order letter all already say *package code*. |

**Known consequence, accepted:** a device wiped before the daily export loses its package
codes. Every other field is recoverable from the server by barcode; this one is not.

### Request B — sets

> "Apparels that come in sets (set of 2 stockings, set of 2 undies). The user defines
> 'set of x' when they review the result — not examined or decided by the AI, as it may not
> see all of the set in the photos. The data should be reported in the CSV."

**Decided (user, 2026-09-04):**

| Question | Decision | Rejected alternative |
|---|---|---|
| Which column? | **New `SetSize` column. `Pieces` untouched.** | Reusing `Pieces` (would have lit up every existing quantity export for free, but conflates a 2-pack with "quantity 2"). Also rejected: emitting both. |
| Weights when `SetSize > 1` | **Per packet, exactly as read from the label. The app never divides.** | App divides label weight by set size; or operator types per-unit weights. Rejected in favour of the app reporting only what it saw. |

---

## 2. The invariant that made both answers "CSV-only"

Verified in code, not assumed — `geminiService.ts` sends **only** image parts plus a fixed
`SYSTEM_INSTRUCTION`. No request metadata (not `apparel_id`, not `username`) ever reaches the
model. Any new operator-entered field is therefore excluded from Gemini *by construction*: no
prompt change, no schema change, no cost. This is consistent with the standing rule that long
reference lists are never sent to Gemini.

**Use this when triaging new client comments:** the question "does Gemini need to see it?" is
answered by *where the value comes from*, not by adding exclusions. Operator-entered → invisible
to the model automatically.

---

## 3. Module routing — the rule this session established

| Kind of field | Module that owns it | Travels via |
|---|---|---|
| Read off a label by the AI | middleware (Gemini + taxonomy snapping) | `api_contract.md` response `data`, 12 fields, each `{value, confidence}` |
| Chosen by the operator before capture | Android app | Room → CSV column |
| Chosen by the operator at review | Android app | Room → CSV column |
| Commercial / legal decisions (price, HS code, article grouping) | Dashboard | Never in the CSV; dashboard-owned columns |
| Armenian text, numeric `*_id`, customs codes | Dashboard only | Joined at render from `reference_data/*.csv` |

**Two invariants that constrain any future field:**

1. The `data` object in the API response is **AI output only** — always 12 fields, each
   `{value, confidence}`. An operator-entered field must never be added there; it would break
   what the app and dashboard branch on. If such a field ever must cross the API, it goes in
   the **envelope**, beside `apparel_id` / `cloned_from`.
2. `api_contract.md` is **locked**. Changing it costs coordination with the Android developer.
   Both requests this session were routed around it deliberately.

---

## 4. `Pieces` vs `SetSize` — the distinction to preserve

These are two different counts and **nothing in the system multiplies them**.

| | Counts | Set by | In the mobile CSV? |
|---|---|---|---|
| `pieces` | Scanned **articles** on one invoice line — a parent plus its clones, or an article group | Dashboard: manual entry, or by collapsing (`collapseToLines`) | **No** — dashboard-only, still deferred per plan §14.1 |
| `set_size` | Garments inside **one** packaged article | Operator, in the app's review dialog | **Yes** — `SetSize` |

A 2-pack scanned once and cloned twice is `pieces = 3`, `set_size = 2` — six garments, which
neither the app nor the dashboard computes. The reader does that division knowingly.

**Why the weights rule matters:** every export prints `Netto`/`Brutto` from the *representative*
row while `Pieces` is a *sum* over the clone family. That establishes the existing convention as
*per-piece weight × quantity*. A set breaks it — the label's weight covers the whole packet. The
client's call keeps the app honest (report what was seen, invent no arithmetic) and pushes the
division to whoever reads the invoice.

---

## 5. Final state of the mobile CSV — 18 columns

`Mobile_app/csv_export_format.txt` is the spec. v1 was 16 columns; v2 adds two.

```
Barcode, Brand, Category, SubCategory, Gender, Season, Size, Color,
Material, Country, OriginalPrice, Netto, Brutto, Timestamp, Operator, ExportBatch,
PackageCode, SetSize
```

| Column | Type | Null | Rules |
|---|---|---|---|
| `PackageCode` | String | Yes | Physical package/box. Operator-entered on the **Pre-Capture** screen, sticky across scans until changed. |
| `SetSize` | Integer | Yes | Garments inside one packaged article. Operator-entered in the **review dialog**. Blank, absent, `0` or non-numeric all mean `1`; must never fail a row. |

A new **Section 3** in that file states the row semantics: one row = one scanned article = one
packet; a set is one row, not two and not a clone; `Netto`/`Brutto` are the whole packet
undivided; `SetSize` is not the invoice quantity; a packet of mixed sizes or colours is not a
set and must be scanned as separate articles.

---

## 6. Files changed in this session

All changes are **uncommitted** in the working tree.

### Android app spec (for the Android developer)

| File | Change |
|---|---|
| `Mobile_app/csv_export_format.txt` | 16 → 18 columns; `PackageCode`, `SetSize`; new Section 3 on set semantics |
| `Mobile_app/architecture.md` | `package_code` and `set_size` in the schema table; "Set size" subsection under review-dialog behaviour (no confidence, never highlighted yellow, never pre-filled from Gemini); setup steps for the Pre-Capture package field and the `Set of X` stepper |

### Dashboard (code + spec)

`PackageCode` needed **no** dashboard code — it was already in `V2_OPTIONAL` and mapped.
`SetSize` did, or the importer would have silently dropped it:

| File | Change |
|---|---|
| `Dashboard/src/db/schema.ts` | `items.set_size INTEGER NOT NULL DEFAULT 1` + an `ensureColumns` entry so existing databases upgrade in place |
| `Dashboard/src/services/import.ts` | `SetSize` in `V2_OPTIONAL`; parsed with the same defensive fallback as `Pieces`; added to `INSERT_COLUMNS`. **Deliberately not in `PROTECTED_ON_OVERWRITE`** — the app is its source, so a re-import refreshes it |
| `Dashboard/src/services/items.ts` | `set_size` editable; `case 'pieces'` and `case 'set_size'` share a numeric handler |
| `Dashboard/src/services/exportPresets.ts` | `set_size` in preset 4 (FULL). Safe because preset 4 does not collapse, so `representative` *is* the row |
| `Dashboard/src/types/item.ts` | `set_size: number` on `ItemRow` |
| `Dashboard/src/views/item.ejs`, `src/i18n/index.ts` | Detail-page field; EN `Set of`, HY `Կոմպլեկտ` |
| `Dashboard/tests/smoke.ts` | v2 ledger import checks (see §7) |
| `Dashboard/Dashboard_plan_final.md` | §4 schema block, §5.1 (18 columns), §7.3 (`set_size` is never folded into the `Pieces` sum), §14.1 rewritten — the parked "when the app supplies them later" case has arrived for both fields |

### Middleware

**No changes.** `api_contract.md` was not touched by this work.

---

## 7. Verification performed

- `Dashboard`: `npm test` → **70 checks, all pass**. `npx tsc --noEmit` clean.
- New checks specifically cover: an 18-column v2 ledger imports; `PackageCode` → `package_code`;
  blank `SetSize` → `1`; `SetSize=2` → `set_size=2`; **a set does not inflate `Pieces`**;
  **the packet weight is kept as labelled, not divided**; `not-a-number` falls back to `1`
  rather than failing the row.
- Confirmed v1 16-column fixtures still import — `validateHeaders()` requires only the v1 set
  and tolerates extra headers.
- Confirmed by reading `geminiService.ts` that no request metadata reaches the model.

---

## 8. Open — decide these against the new client comments

1. **Presets 1–3 and `SetSize`.** The seller invoice, customs sheet and inspection form all
   collapse clone families into one line. If the client wants set size on any of them, someone
   must first say what it means for a *collapsed* line — the representative's value, or a sum.
   Deliberately not guessed. One line each once decided.
2. **`package_code` is in `PROTECTED_ON_OVERWRITE`.** A value typed in the dashboard survives a
   re-import, so the CSV will *not* overwrite it. Correct while the column was manual-entry
   only; now that the app is the source it may be backwards. One line to remove.
3. **Does the client expect to do the `pieces × set_size` arithmetic themselves?** That follows
   from the "per packet, as read" decision, but it has not been confirmed with them.
4. **Armenian label `Կոմպլեկտ`** for the dashboard item page needs a native check. It is a UI
   label only — it never reaches an export or a declaration.
5. **Still deferred, unchanged:** `Pieces` and `care information` remain dashboard-only,
   manual-entry, not emitted by the app (plan §14.1).

---

## 9. ⚠️ Repo state — parallel work in flight

The working tree contains substantial changes **from outside this conversation**. Read this
before planning anything, and do not attribute the following to the CSV work:

- **`middle_ware/api_contract.md` is now v1.3**, not v1.2. It adds
  `GET /api/v1/reference-tables` — the client's seven taxonomy tables served as English key +
  Armenian label + numeric id, so the app can display Armenian while still storing and sending
  canonical English. Roughly 19 middleware files modified, ~1,500 lines, plus four new untracked
  files: `src/db/referenceRequests.ts`, `src/routes/reference.routes.ts`,
  `src/services/referenceService.ts`, `tests/referenceTables.ts`.
  **The CSV decisions above still hold under v1.3** — neither `PackageCode` nor `SetSize`
  appears anywhere in it. But statements in this session's transcript that "the contract stays
  at v1.2" describe the contract *as it was when the decisions were taken*.
- **`Mobile_app/csv_export_format.txt` and `Dashboard/Dashboard_plan_final.md` have further
  edits from that other work**, layered on top of the changes described here. (The CSV file
  gained a "Section 4: Language" about the file being English.) All edits from this session
  were verified still present.
- **`Mobile_app/api_contract.md` and `Mobile_app/api_contract copy.md` are deleted** in the
  working tree. Not deleted by this session; they were stale duplicates of the middleware
  contract. Confirm the deletion is intentional before committing.
- `Dashboard/app_test_files/` is untracked.

**Nothing from this session has been committed.**

---

## 10. Source-of-truth documents (read before changing anything)

| File | Role |
|---|---|
| `middle_ware/api_contract.md` | **Locked** contract with the Android app. Now v1.3. |
| `middle_ware/UI_messaging_protocol.md` | Middleware ⇄ dashboard contract over `control.db`. |
| `middle_ware/dev_report.md` | How the middleware works; deploy runbook; open gaps. |
| `Dashboard/Dashboard_plan_final.md` | Authoritative dashboard spec. §14 tracks closed/open client gaps. |
| `Mobile_app/csv_export_format.txt` | The daily ledger the dashboard ingests. The contract with the Android app for everything that never crosses the API. |
