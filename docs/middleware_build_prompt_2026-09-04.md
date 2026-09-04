# Build Prompt — Middleware, 2026-09-04 decisions

**How to use this file.** Everything below the line is the prompt for a Claude Code session with
full access to this repository. It is deliberately roadmap-level: it states goals, constraints and
acceptance, and leaves implementation to the session, which can read the code.

---

## PROMPT BEGINS

You have full access to this repo. Implement the middleware half of the 2026-09-04 client
decisions.

**Read these first. They are authoritative and already updated — do not re-derive or re-edit them:**

| File | Role |
|---|---|
| `docs/client_decisions_2026-09-04.md` | Every decision, with the reasoning and the rejected alternatives. §2 is your scope |
| `middle_ware/api_contract.md` | **Already at v1.4.** This is the target you implement against, not something you write |
| `Mobile_app/csv_export_format.txt` | Already at 19 columns. Context only — the app owns it |
| `middle_ware/dev_report.md` | How the middleware works. §24 covers taxonomy and material. **You must update this** |

The contract was written first, on purpose. Your job is to make the server match it.

---

## The road map

Six workstreams. The first three change what the model is asked and what comes back; the last
three change what the server sends. They are independent enough to do in any order, but this
sequence keeps the test suite green throughout.

| # | Workstream | Touches | Contract §|
|---|---|---|---|
| 1 | **Material** — stop destroying compositions | `fuzzyMatcher`, `visionService` | 8.1 |
| 2 | **Size** — European value only | `geminiService` prompt + schema | 8.4 |
| 3 | **`care_info`** — 13th extracted field, from a care QR code | `geminiService`, `types`, `visionService` | 8.4 |
| 4 | **`suggested_key_photo_index`** — AI proposes the main photo | `geminiService`, `visionService`, storage | 4.2 |
| 5 | **`data_hy`** — Armenian for every translatable field | new/`exportService`, `visionService` | 8.3 |
| 6 | **Docs + tests** — `dev_report.md`, the suite | `tests/`, `dev_report.md` | — |

### What is already done — do not redo it

- **`api_contract.md` is v1.4.** Written, committed, and sent to the Android developer. Treat it
  as fixed. If you find something in it that cannot be implemented as written, **stop and say so**
  rather than quietly diverging — it is a coordinated contract.
- **The multilingual-material and footwear-inference prompt rules** are already in
  `buildSystemInstruction()` (commit `d63e1aa`). Client comment #6 needs no new prompt work.
- **The dashboard needs nothing.** `care_info` is already plumbed there end to end.
- **`UI_messaging_protocol.md` needs nothing.** It carries reference-table names, not the
  extracted-field list.
- **No database migration is needed** for the new extracted field: `server_scans.raw_json_data`
  and `flywheel_training.unconfirmed_gemini_json` are JSON blobs. Confirm this before relying on
  it, but that is the expectation.

---

## 1. Material — the full composition

**Today's behaviour, measured:**

```
"100% Cotton"                       -> "Cotton"                    (percentage destroyed)
"80% Cotton 20% Polyester"          -> unchanged                   (survives only by accident)
"100% ALGODÓN / ALGODÃO / COTTON…"  -> unchanged
```

`material` sits in `MATCHED_FIELDS`, so the whole composition string is fuzzy-matched against a
table of 85 single fibres. A one-fibre composition gets snapped and loses its percentage; a
multi-fibre one survives only because nothing clears the threshold. That inconsistency is the
client's complaint.

**Target:** the full composition, in one language, with invariant fibre names.

```
"100% Cotton"                       -> "100% Cotton"
"80% ALGODON 20% POLIESTER"         -> "80% Cotton 20% Polyester"
"40% Cotton 40% Nylon 20% Elastane" -> unchanged
"Leather"          (shoe, inferred) -> "Leather"   confidence <= 0.50
```

**Approach:** match **per fibre segment**, not per string. Split the composition, snap each fibre
name onto the material table, reassemble with percentages preserved.

`exportService.translateMaterial()` already splits compositions exactly this way for the Armenian
legal export. Its segmentation is written and tested — **reuse it**, do not write a second parser.
If it needs to be extracted into a shared helper so both call sites use one implementation, do
that.

**Constraints:**

- Percentages are transcribed, never computed. Do not sum, normalise, or reorder them.
- A fibre absent from the table passes through as transcribed. Never force it onto a near miss —
  a wrong canonical key is worse than an unmatched one, and that principle holds everywhere in
  this codebase.
- A single-term shoe inference (`Leather`, `Suede`) must still land on itself.
- `tests/taxonomySelection.ts` asserts every term the prompt suggests is a real table entry that
  matches to itself. Expect to extend it, not to break it.

---

## 2. Size — European value only

Labels print one size in up to seven systems. Report only the European one, prefix normalised to
`EU` whether the label said `EU` or `EUR`.

```
US 6X/7  CA 6-8A  EUR 122/128  CN 130/64  MX 6-8A  AUS 7-8  UK 6-8Y   ->   EU 122/128
```

The value after the prefix is verbatim — `122/128` is not simplified, split or converted.

**The fallback matters as much as the rule.** A label carrying no European reference is reported
**as printed**, with no prefix invented: `XL` stays `XL`, `32W x 34L` stays `32W x 34L`. The rule
chooses between competing size systems; it does not manufacture one. Get this wrong and every
adult garment with a plain letter size breaks.

`size` is free text — it passes through neither `MATCHED_FIELDS` nor `CONSTRAINED_FIELDS` — so
this is a prompt and schema-description change only.

---

## 3. `care_info` — the 13th field

Garments increasingly carry a QR code linking to care and usage instructions. The model decodes it
from the photos and returns the URL.

- Goes **inside `data`**, not the envelope: it is read off the garment by the model, and `data` is
  AI output. This is the same invariant that keeps `package_code` and `set_size` out of the API.
- `{ "value": "", "confidence": 0.0 }` when no QR code is visible — the standard convention.
- Never translated; its `data_hy` entry is always `null`.

**Confidence is the interesting part.** A misread URL looks perfectly plausible and cannot be
caught by eye, unlike a misread brand name. Gemini is not a QR decoder. Cap or damp the confidence
so that QR reads fall below `FLYWHEEL_CONFIDENCE_THRESHOLD` and route into the training DB for
operator review, in the same spirit as the footwear-material inference. Use your judgement on the
exact treatment and document what you chose in `dev_report.md`.

Note for context, not for action: on-device QR decoding via ML Kit would be exact, and the client
has explicitly deferred it as a side option (`Commission_TODO_list.md`). Do not build it.

---

## 4. `suggested_key_photo_index`

The model proposes which photo is the main product shot. The operator still decides.

- **Envelope field**, never inside `data` — it is metadata about the batch, not a garment
  attribute.
- `null` until extraction completes, and `null` whenever the model could not choose. Do not
  default it to `0`; a wrong confident answer is worse than an honest absence.
- The request field `key_photo_index` **stays required and unchanged**. The operator's choice
  remains the authority.
- It must survive: `GET /vision/result/:id` replays it long after extraction, so it has to be
  persisted alongside the extraction rather than recomputed.
- **Clones** (`cloned_from` set) copy the parent's record and never call the model. The suggestion
  should be inherited with everything else.

---

## 5. `data_hy` — Armenian in the response

The response carries an Armenian rendering of every translatable field, so the device never parses
or translates anything.

**Shape** — follow the discipline `data` already has:

- All **13 keys**, always present. Never omit one.
- Plain strings or `null`. No confidence — confidence belongs to the extraction, not the
  translation.
- `null` means *"no Armenian exists — display the English value"*. It never means "show nothing".
- Seven keys are `null` by design: `brand_name`, `country_of_origin` (English everywhere by client
  decision), and the free-text `size`, `original_price`, `netto`, `brutto`, `care_info`.
- Present exactly when `data` is present — `null` for `PENDING_AI` and `NEEDS_ATTENTION`.
- Nothing Armenian is ever stored, exported, or accepted back from a client.

### A fork you must decide deliberately

There are **two** Armenian sources in this repo and they are not the same thing:

| Source | What it is | Used for |
|---|---|---|
| `referenceService.referenceCatalogue()` | The seven client tables with `hy` per entry, versioned, supervisor-editable, served to the app via `GET /api/v1/reference-tables` | The **display** vocabulary |
| `exportService.loadLegalArmenianMap()` | Built from `translations.csv` by `npm run convert:translations` | The **legal/customs** wording |

**Recommendation: source `data_hy` from the reference catalogue.** It is what the app would
otherwise look up itself, so app and server can never disagree, and a supervisor's edit propagates
without a redeploy. The legal map exists for paperwork wording and can legitimately differ.

`material` is the awkward one: it is a composition, so translate it **per fibre segment** — the
same segmentation as workstream 1 — with each fibre's Armenian coming from the chosen source.
`translateMaterial()` does this today against the legal map; if you switch the source, keep the
segmentation and swap the lookup rather than writing a third parser.

If you conclude the legal map is the better source, say why and note it in `dev_report.md`. Do not
mix the two silently.

---

## 6. Documentation and tests

**`dev_report.md` must be updated.** It is the "how this actually works" document and it currently
describes the old behaviour:

- §24.2 states the matcher drops the percentage from a single-fibre composition and that
  multi-fibre compositions survive by not matching. Both become wrong.
- §24.1's two-kinds-of-field framing needs `material` re-explained: still a reported field, but no
  longer whole-string matched.
- Add the size rule, `care_info` and its confidence treatment, `suggested_key_photo_index`, and
  `data_hy` with the source you chose and why.
- Add a v1.4 entry to the change log (§23).

**Tests.** `npm run test:all` must pass. Beyond keeping it green, add coverage for the things a
future change could silently break:

- `100% Cotton` keeps its percentage; a multi-fibre composition survives intact; a foreign fibre
  name normalises to its canonical English term; an unknown fibre passes through unchanged.
- A multi-system size label reduces to the EU value; **a label with no EU reference is unchanged**.
- `data` has 13 keys and `data_hy` has the same 13, on every path that returns them — fresh
  extraction, clone, duplicate replay, and `GET /vision/result/:id`.
- `data_hy` is `null` for `PENDING_AI` and `NEEDS_ATTENTION`.
- `suggested_key_photo_index` survives a result re-fetch.

`npx tsc --noEmit` clean.

---

## Constraints that apply throughout

1. **Never send the long reference tables to the model.** 295 sub-categories and 839 brands stay
   out of the prompt. The model reads the label; the server maps the reading onto the table. A
   model handed 295 options starts choosing instead of reading. This is a standing rule, not a
   preference.
2. **The storage invariant is sacred.** A `2xx` means the scan is on disk. Nothing you add may
   create a path where a stored scan reports failure, or an unstored one reports success.
3. **`data` is AI output only.** Operator-entered values never go in it. If something must cross
   the API that is not AI output, it goes in the envelope.
4. **Never silently rewrite a model answer.** Unmatched values pass through and are logged;
   off-list constrained values pass through and are logged at warn. Quietly "correcting" the model
   hides prompt drift.
5. **Extraction stays asynchronous.** `POST /vision/extract` answers `202` immediately and never
   blocks on the AI.

---

## Definition of done

- [ ] `data` returns 13 fields on every path that returns it
- [ ] `100% Cotton` comes back as `100% Cotton`; compositions survive with invariant fibre names
- [ ] A seven-system size label returns `EU …`; a plain `XL` label returns `XL`
- [ ] `care_info` returns a URL when a QR code is visible, empty otherwise, at a confidence that
      routes it for review
- [ ] `suggested_key_photo_index` is returned, persisted, replayed, and inherited by clones
- [ ] `data_hy` returns 13 keys with the null-means-English contract honoured
- [ ] `npm run test:all` passes; `npx tsc --noEmit` clean
- [ ] `dev_report.md` describes the new behaviour and records the Armenian-source decision
- [ ] `/health` reports `api_contract: "1.4"`

## Report back

When you finish, state plainly: what you implemented, the Armenian source you chose and why, the
`care_info` confidence treatment you chose, anything in `api_contract.md` v1.4 you could not
implement as written, and the test results as they actually came out.

**One separate action, outside the code:** confirm whether the deployed VPS is running commit
`d63e1aa`. The multilingual-material and footwear rules are committed but possibly not deployed —
if they are not, part of what the client reported is already fixed and needs only a deploy. Flag
this rather than assuming either way.

## PROMPT ENDS
