# Label Reader — Technical Scoping & Specification
**Internal working document — for the development team (v1.0, Aug 2026)**

## Architecture principle (applies to all options)

Operator clients (PWA or APK) never call the AI vendor directly. All AI calls go through the backend ("AI proxy"): the client uploads photos to the server, the server calls the multimodal model, and returns structured JSON. Reasons: API keys never live on devices, prompts/schemas can be updated centrally without app releases, every request is logged for cost tracking and (Option C) fine-tuning data collection.

Flow: `Client → POST /scan (photos) → AI proxy → multimodal API → JSON + per-field confidence → Client review → POST /records (approved data) → DB`

---

## 1 — PWA (Operator Web App)

| Scope | Option A | Option B | Option C |
|---|---|---|---|
| Availability | Primary operator client | — (replaced by APK) | — (replaced by APK) |
| Stack | React + Vite, installable PWA (manifest + service worker for home-screen icon only, not offline data) | — | — |
| Camera capture | HTML5 `capture` / `getUserMedia`; 1–4 photos per garment; client-side resize ≤1600px & JPEG compression (~200–400 KB/photo) before upload | — | — |
| Scan workflow | Guided sequence: label 1 → label 2 (optional) → label 3 (optional) → garment overview; thumbnails with retake | — | — |
| Review screen | Editable form of extracted fields; low-confidence fields highlighted (amber); mandatory-field validation before submit | — | — |
| Bundle tagging | Manual bundle/shipment ID entry (text field, remembered between scans) | — | — |
| Auth | Simple email+password via backend auth (single operator role); session token in memory/localStorage | — | — |
| Offline behaviour | None — connection required; clear "offline" banner and blocked submit | — | — |
| Browser support | Chrome/Android and Safari/iOS (current −2 versions) | — | — |
| UI language | Single language (client's choice); strings externalized for cheap later translation | — | — |

## 2 — APK (Native Android Operator App)

| Scope | Option A | Option B | Option C |
|---|---|---|---|
| Availability | — | Primary operator client | Primary operator client |
| Stack | — | Kotlin + Jetpack Compose; min SDK 26 (Android 8) | Same as B |
| Camera | — | CameraX: tap-to-focus, torch toggle, framing overlay for labels, auto-capture stillness hint; same 1–4 photo workflow | Same as B |
| Image handling | — | On-device resize/compress; EXIF-stripped; photos cached until sync confirmed | Same as B |
| Bundle tagging | — | Barcode/QR scan of bundle tag (ML Kit); fallback manual entry; active bundle shown persistently | Same as B |
| Offline queue | — | Room (SQLite) local store; scans queue when offline; WorkManager background sync with exponential backoff; queue status badge; conflict-safe idempotent submits (client-generated UUID per record) | Same as B |
| Review screen | — | Same field set as PWA + confidence highlights; large touch targets; "fix only amber fields" fast path | B + auto-confirm mode: if all fields ≥ threshold, single-tap approve; threshold configurable per deployment |
| Auth & roles | — | Per-operator login (JWT + refresh token); device remembers operator; supervisor PIN for deleting local queue | Same as B |
| App distribution & updates | — | Private distribution (direct APK link or Play Store internal track); in-app "update available" check against backend version endpoint | B + silent self-update download prompt; staged rollout flag per device group |
| Device management | — | Optional kiosk/pinned mode; screen-on during scanning | Same as B |
| Crash/telemetry | — | Sentry (crashes + sync failures); anonymous usage counters (scans/day/device) | B + per-operator throughput metrics feeding analytics dashboard |

## 3 — Server (Backend)

| Scope | Option A | Option B | Option C |
|---|---|---|---|
| Hosting model | Backend-as-a-Service (Supabase: managed Postgres, Auth, Storage, Edge Functions) — zero server administration | Single VPS (2 vCPU/4 GB), Docker Compose: API + Postgres + Caddy (auto-HTTPS); fully remote-managed | 2 VPS or small managed k8s/PaaS: API, worker (reports/sync), Postgres (managed if available), S3-compatible object storage |
| API framework | Supabase Edge Functions (TypeScript) for AI proxy + export; direct PostgREST for CRUD | Node.js (NestJS/Fastify) or Python (FastAPI) REST API; OpenAPI spec as the contract with the app | Same as B + versioned API (/v1) and webhook subsystem |
| AI proxy | Edge function: receives photos, calls multimodal API with JSON-schema prompt, returns fields + per-field confidence; retry ×2, fallback model on failure | Dedicated API module; prompt & schema stored in DB (hot-editable); request/response logging with cost accounting | B + prompt profiles per brand/label style; model routing (cheap model first, escalate on low confidence); response cache for duplicate labels |
| AI model | Budget multimodal API (Haiku / Gemini Flash class), structured-output mode | Same, model name configurable via env/DB | Same + optional custom fine-tuned model endpoint (see fine-tuning row) |
| Data model | `records`, `bundles`, `operators`, `hs_codes` | A's tables + `shipments`, `devices`, `app_versions`, `export_jobs` | B's tables + `tenants/warehouses`, `audit_log`, `report_schedules`, `integrations`, `model_versions`, `training_samples` |
| Image storage | Supabase Storage; original + thumbnail; 12-month retention default | VPS volume or external S3; nightly offsite copy; retention policy configurable | S3 with lifecycle rules (hot 90 days → cold); signed URLs only |
| HS-code service | Static lookup table (garment type + material → code) applied at export time | Editable table (supervisor CRUD via dashboard); applied at record creation, re-applyable in bulk | B + AI-suggested code validated against table; discrepancy flag for supervisor review |
| Export | CSV endpoint (filter by date/bundle) | CSV + XLSX generation (server-side, styled headers); export history | B + scheduled exports (cron worker), email delivery (SMTP/API), report templates |
| Auth & roles | Supabase Auth, single role | JWT auth service; roles: operator, supervisor; per-endpoint authorization | B + admin role, full RBAC, API keys for integrations, audit trail on every mutation |
| Integrations | — | — | Outbound webhooks (record.created, export.ready); REST push adapters (generic ERP/accounting JSON); CSV drop to SFTP if required |
| Backups & recovery | Supabase automatic daily backups | Nightly `pg_dump` + image sync to offsite storage; documented restore runbook; RPO 24 h | Managed PG point-in-time recovery; RPO ≤ 1 h; quarterly restore drill |
| Fine-tuning pipeline | — | — | **Optional add-on:** consent-flagged collection of (photos + AI output + operator corrections) into `training_samples`; periodic dataset export; fine-tune cycle on vendor tuning API or hosted open model; frozen evaluation set with accuracy gate before a new model version is activated; rollback switch |
| Monitoring | Supabase dashboard + uptime ping | Uptime + disk/CPU alerts (e.g., Netdata/UptimeRobot); daily cost log of AI usage | B + centralized logs (Loki/CloudWatch), alerting to team chat, monthly ops report |

## 4 — Admin Dashboard (Web)

| Scope | Option A | Option B | Option C |
|---|---|---|---|
| Availability | Minimal export page only (login + filtered CSV download) | Full supervisor dashboard (SPA) | Full dashboard + analytics & administration |
| Stack | Static page + Supabase client | React SPA served by the API (same repo/deploy) | Same as B |
| Records browser | — | Paginated table: search, filter (date, bundle, operator, garment type, origin); inline edit with change tracking; photo viewer per record | B + bulk actions (re-run HS lookup, bulk edit, merge duplicates) |
| Bundle/shipment view | — | Bundle list with progress (scanned count, operators involved, status open/closed) | B + shipment-level rollups and manifest comparison (expected vs scanned counts) |
| HS-code management | — | CRUD editor for the lookup table; CSV import of code list | B + review queue for AI-vs-table discrepancies |
| Export & reports | — | On-demand CSV/XLSX with saved filter presets | B + report scheduler UI, email recipients, template picker |
| User & device management | — | Create/disable operators; reset passwords; registered device list | B + roles/permissions matrix, per-warehouse assignment, API key management |
| Analytics | — | — | Charts: garments/day, per-operator throughput, correction rate per field (proxy for AI accuracy), garment-mix per shipment; date-range compare |
| Audit & compliance | — | Simple "last edited by/at" on records | Full audit log viewer (who changed what, before/after), export of audit trail |
| Model management | — | — | (With fine-tuning add-on) model version list, accuracy per version, activate/rollback control |

## 5 — Cross-cutting: AI Extraction Contract (all options)

| Scope | Option A | Option B | Option C |
|---|---|---|---|
| Extracted fields | garment_type, brand, country_of_origin, material_composition[], color, size, care_symbols (best-effort), notes | Same + bundle linkage, label_language detected | Same + per-brand extra fields via prompt profiles |
| Output format | Strict JSON schema; each field `{value, confidence 0–1}`; `needs_review` flag when any confidence < threshold (default 0.8) | Same; threshold configurable server-side | Same; thresholds tunable per field and per model version |
| Multi-language labels | Supported natively by model; output normalized to English (configurable) | Same | Same + normalization dictionaries (e.g., color names) |
| Cost guardrails | Per-day request cap; image size cap | B: + per-device cap, monthly budget alert | C: + cost dashboard, per-warehouse budgets |

## 6 — Cross-cutting: DevOps, Security, Delivery

| Scope | Option A | Option B | Option C |
|---|---|---|---|
| Repos & CI | Single monorepo; GitHub Actions: lint, test, deploy edge functions & PWA | Monorepo; CI builds API image, dashboard, signed APK; one-command VPS deploy (Docker) | B + staging environment, migration gating, staged APK rollout |
| Environments | prod only | dev + prod | dev + staging + prod |
| Security | HTTPS everywhere; auth on all endpoints; images via signed URLs | B: + rate limiting, secrets in env vault, dependency scanning | C: + RBAC review, audit logging, data-retention policy doc, optional pen-test |
| Remote maintenance | Everything cloud-side; no client premises access ever needed | Same (VPS via SSH/wireguard) | Same |
| Documentation | README + operator one-pager | B: + API (OpenAPI), deployment runbook, restore runbook | C: + integration guide, admin manual, model-training runbook |
| Est. team split (2 devs) | Dev1: PWA + review UX · Dev2: backend/AI proxy + export | Dev1: Android app · Dev2: API/VPS + dashboard (dashboard is the schedule risk — start early) | Phased: B-scope first, then analytics/integrations, fine-tuning pipeline last |
