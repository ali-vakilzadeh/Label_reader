# Label Reader — Dashboard & Server Plan v1.1
**Internal build plan — supersedes v1.0. Reflects: bridge-only middleware, barcode apparel_id + clone feature, daily CSV upload flow, PostgreSQL main DB, and the internal training-data pipeline.**

## 0 — Revised system position

```
Android app ──► Middleware (Express)  ── bridge only ──► Gemini
                     │
                     ├─ returns extraction to app (app stores confirmed data locally)
                     └─ silently tees LOW-CONFIDENCE extractions + photos ──► training.sqlite (internal)

End of day:  app ► native share ► CSV file ► received manually ► uploaded in dashboard UI
                                                    │
                                                    ▼
                                     Dashboard (Express + React) ──► PostgreSQL (main DB)
                                                    │
                                                    └─ on ingest: matcher pairs confirmed rows
                                                       with training.sqlite via apparel_id
```

Key differences from v1.0:
- **Middleware stores no confirmed data.** It authenticates, bridges to Gemini, returns results. The paid scope ends there.
- **Confirmed data reaches the server only via the daily CSV upload** performed manually in the dashboard (client-accepted workflow).
- **Main DB is PostgreSQL** (dashboard analytical workload); the **internal training store is SQLite**, invisible to the dashboard UI and to the client.
- **apparel_id is operator-assigned by scanning a physical barcode** attached to each apparel; it is the join key across app, CSV, main DB, and training store.
- **Clone feature (app side):** consecutive identical apparels are recorded by scanning the next barcode only — specs copied from the previous item, no AI call. Clones arrive in the CSV as ordinary rows with distinct apparel_ids and a `cloned_from` reference.

---

## 1 — Middleware server (revised scope)

| # | Function | Detail |
|---|---|---|
| M1 | Auth | `POST /api/v1/auth/login` per-operator credentials → JWT (30d). |
| M2 | Health | `GET /api/v1/health` as specified. |
| M3 | Vision bridge | `POST /api/v1/vision/extract`: multipart images (1–6 per apparel; align spec's "8" down or proposal up — decide once) + apparel_id + username → Gemini structured output → response to app. Stateless for confirmed data. |
| M4 | Confidence tee (internal) | After each extraction, if ANY field confidence < threshold (configurable, default 0.8): write photos + full raw extraction + apparel_id + username + timestamp to `training.sqlite`. Fully synchronous-safe (write-behind queue so the app response is never delayed). |
| M5 | Cost log | Per-request Gemini cost estimate appended to a log table (monthly ops answer for the client). |
| M6 | Rate/size guards | Max image size, max images per call, per-device daily cap. |

**Explicitly out of middleware scope:** record storage, CSV handling, any dashboard endpoint.

## 2 — Internal training-data pipeline (server-side, not client-visible)

| # | Function | Detail |
|---|---|---|
| T1 | Store | `training.sqlite`, WAL mode. Tables: `samples` (apparel_id, username, ts, raw_extraction JSON, photo paths, matched flag), `confirmed` (apparel_id, confirmed JSON, matched ts). Photos under `/data/training/{apparel_id}/`. |
| T2 | Capture rule | Only extractions with ≥1 field below confidence threshold (M4). Cloned items never enter (no AI call, no photos). |
| T3 | Matcher | Triggered at each CSV ingest: for every confirmed row whose apparel_id exists unmatched in `samples`, write confirmed values to `confirmed`, set matched flag. Result: (photos + unconfirmed + confirmed) triples. |
| T4 | Volume cap | Hard cap 10,000 samples. When full: new captures evict the **oldest unmatched** sample (matched triples are the valuable asset and are preserved); if all are matched, stop capturing and log a notice. |
| T5 | Export | CLI script: dump matched triples to a dataset folder (images + JSONL) for future fine-tuning experiments. No UI. |
| T6 | Isolation | Separate file path, separate DB user-less SQLite file, no dashboard route touches it; excluded from client-facing backups; included in developer-only backup. |



## 3 — Dashboard functional plan (revised F-list)

### F1. Ingestion (replaces v1.0 live-sync design)
| # | Function | Detail |
|---|---|---|
| F1.1 | CSV upload UI | Manual upload (drag-and-drop / file picker) of daily per-operator CSV files; multi-file batch supported. |
| F1.2 | Parser & validator | Strict parse against the finalized record schema (pending client sign-off today); per-row validation (required fields, value domains, date formats); rejects reported per row, never silently dropped. |
| F1.3 | Dedup — file level | SHA-256 of each uploaded file; already-seen files skipped with notice. |
| F1.4 | Dedup — record level | Rows whose apparel_id already exists in main DB are identified and excluded from append; a dedup report (count + list) shown after each ingest. First-write-wins; supervisors can still edit via F2.6. |
| F1.5 | Training matcher hook | Each accepted ingest triggers T3 (invisible to UI). |
| F1.6 | Historical data import | Client's existing Excel of past items + prices → `historical_items` (column-mapping UI). |
| F1.7 | Import log | Every upload: filename, operator(s), rows accepted/duplicated/rejected, timestamp, uploader. |

### F2. Browsing & filtering — unchanged from v1.0 (integrated table, filters, full-text search, detail drawer with photos, saved views, tracked inline edits), plus:
| F2.7 | Clone visibility | `cloned_from` shown in detail view; clone groups collapsible in the table. |

### F3. AI imaging — unchanged (on-demand catalog render, regenerate, batch with cost preview, cost ledger). Note: photos arrive via the CSV package/ZIP share, not via middleware.

### F4. Pricing engine — unchanged (local embeddings at ingest, attribute-then-visual comparables, weighted-median suggestion, accept/adjust, price history). Note: clones share the source item's embedding — computed once.

### F5. Annex features — unchanged except:
| F5.2 | Duplicate warning | Must NOT flag intentional clones: suppress warnings within a `cloned_from` group; embedding-similarity warnings apply only across unrelated apparel_ids. |

### F6. Operations & reporting — unchanged (operator performance, XLSX/CSV export, sale recording, catalog export, HS-code column). Correction-rate metric (F6.1) now depends on the CSV including both original AI values and confirmed values per field — **must be in today's record-schema decision with the client, or the metric is lost.**

### F7. Administration — unchanged (dashboard auth viewer/supervisor, settings, backups, health panel). Backups explicitly exclude `training.sqlite` (T6).

---

## 4 — Technology requirements (deltas from v1.0)

| Component | v1.1 choice | Change vs v1.0 |
|---|---|---|
| Main database | **PostgreSQL 16** (`pg` + drizzle-orm; docker-compose service) | Was SQLite-first; PG now preferred per decision. Embedding vectors: `pgvector` extension (simpler than app-side cosine now that PG is in play). |
| Training store | SQLite (`better-sqlite3`, WAL) in middleware process | New component, middleware-owned. |
| CSV parsing | `csv-parse` (strict mode) + `zod` row schemas | New: F1.2 validation. |
| Everything else | Node 20 + Express ×2 processes, Caddy, Docker Compose, React+Vite+TanStack Table+Recharts, Transformers.js CLIP embeddings (Python sidecar fallback), `@google/genai`, exceljs / csv-stringify / puppeteer, JWT + bcrypt + helmet, Vitest + Playwright, monorepo `packages/{middleware,dashboard,db}` | Unchanged. `packages/db` now contains PG schema (shared) — training.sqlite schema stays private inside middleware package. |

## 5 — Build order (revised)

1. Record schema freeze with client (today) → `packages/db` PG schema + CSV row schema from the same source of truth.
2. Middleware deltas: confidence tee (M4), cost log (M5), guards (M6) — small, ship first since the app is already talking to it.
3. Dashboard: F1 ingestion chain (upload → validate → dedup → append → import log) end-to-end with a sample CSV.
4. F2 table/detail + F6.2 exports.
5. F4 embeddings + pricing (pgvector), F3 catalog render, F7 admin.
6. T3 matcher + T5 export script (quick, after F1 lands).
7. Annex features on client approval, quoted per the annex terms.

## 6 — Open items

1. **Finalized CSV record schema** — expected from client today; parser, PG schema, and correction-rate capture all hang on it. Push to include per-field original-AI-value + confirmed-value (or an "edited fields" list) — see F6.1 note.
2. Image count per apparel: 6 vs 8 — freeze once.
3. Confidence threshold for the training tee (default 0.8) and whether it should differ from the app's review-highlight threshold.
4. License-terms sentence covering retained processing data (Section 2 note) — strongly recommended before operators start scanning real inventory.
5. Barcode format/length for apparel_id (affects app validation + PG column type + physical label printing).
