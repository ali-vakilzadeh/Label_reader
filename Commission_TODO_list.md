# Commission TODO List

Work that must be finished before the system is handed over. Distinct from `dev_log.md`, which
tracks progress; this file tracks **what is still owed**.

---

## Documentation

- [ ] **Update and finalize `Mobile_app/architecture.md`.**
      It is the oldest spec in the repo and is now substantially out of date. Known drift:
      - The Gemini system prompt and response schema in §2 show **8 fields** and the original
        wording. The live prompt is in `middle_ware/src/services/geminiService.ts` and the
        contract carries **13**.
      - §3's export schema is the v1.0 shape (`apparel_id`, `parent_item_id`, `record_type`,
        `image_files`). The real ledger is the 19 columns in `Mobile_app/csv_export_format.txt`.
      - "Technical Setup Plan" step 1 describes a Pre-Capture screen with Category /
        Sub-category / Gender / Season dropdowns. All four have been AI-extracted since contract
        v1.2, and the 2026-09-04 decisions replace that screen with the barcode screen
        (`docs/client_decisions_2026-09-04.md` §1.1).
      - §1's endpoint list predates the async protocol (v1.1) and the reference-table endpoint
        (v1.3).
      - Demo Mode, removed by decision M#5, is still described as a feature.
      Rewrite it against `middle_ware/api_contract.md` v1.4 and
      `docs/client_decisions_2026-09-04.md`, and mark it as a source-of-truth document or retire
      it in favour of the two files that already are.

- [ ] `Mobile_app/mobile_app_specs.txt` is v1.0-era throughout (synchronous `/api/extract/apparel`,
      `success: true` envelopes, 9 lowercase colours). Either refresh it or mark it historical.

- [ ] `Dashboard/Dashboard_plan_final.md` §14.1 — `care information` is no longer deferred; the
      app supplies it as the 19th CSV column. §5.1 column count 18 → 19.

---

## Verification before handover

- [ ] **Confirm the VPS is running commit `d63e1aa`.** The multilingual-material and
      footwear-inference prompt rules are committed but may not be deployed. Client comment C#6
      may already be closed by a deploy alone.

- [ ] **Establish which APK the client is testing.** `Mobile_app/build/` holds nine archives with
      no dates in their filenames. Every Android finding in
      `docs/client_decisions_2026-09-04.md` was read from `apparel-vision_update7_source.zip`,
      which may not be that build.

- [ ] Native Armenian check on the dashboard item-page label `Կոմպլեկտ` (`SetSize`).

---

## Open questions for the client

- [ ] **C#9 — "need to discuss file export/output".** No actionable content yet. The 19-column
      CSV is fully specified; unknown whether they want a different format, a different delivery
      channel, or more columns.

- [ ] **Presets 1–3 and `SetSize`** (dashboard). The seller invoice, customs sheet and inspection
      form collapse clone families into one line. Nobody has said what a set size means for a
      collapsed line — the representative's value, or a sum.

- [ ] **`pieces × set_size` arithmetic.** Follows from the "weights per packet, as read" decision,
      but has not been confirmed with the client.

---

## Deferred by decision

- **`Pieces`** — dashboard-only, manual entry, not emitted by the app.
- **`package_code` in `PROTECTED_ON_OVERWRITE`** (dashboard importer) — a dashboard-typed value
  survives a re-import. Correct while the column was manual-entry only; probably backwards now
  that the app is its source. One line, waiting for a dashboard batch.
- **QR decoding on the device** — ML Kit already decodes QR codes and could read care links
  exactly, but the client's decision is that the AI does it and that on-device QR reading is a
  **side option, not a main concern** (2026-09-04). Recorded as a fallback if AI accuracy
  disappoints in testing.
