Here is the updated, comprehensive **Analytical Dashboard & System Management Plan** incorporating your new server control requirements, dual-database architecture (`control.db`/`server_scans.db`/`flywheel.db` SQLite + PostgreSQL), and operational controls.

---

## Architectural & Integration Foundations

* **Data Access Strategy:**
* **PostgreSQL:** Manages core UI authentication, user roles (max 10 active users), UI activity logs, and historical pricing records.
* **SQLite Stack (`control.db`, `server_scans.db`, `flywheel.db`):** Interacts directly with the VPS filesystem and middleware databases. Reads operational scans, training samples, and writes commands/user requests via `control.db` following the strict polling and permission rules.




* **System Rules & Safety:**
* Liveness is determined by checking `now - heartbeat_at > 90000` (heartbeat check).


* Security enforcement: Read `app_users_public` instead of `app_users`; API keys/passwords are write-only and never echoed back; `control.db` SQLite connections open with `journal_mode=WAL` and `busy_timeout=5000`.





---

## Complete Dashboard Module Breakdown

### 1. Header & Live Server Status Banner (Screen A)

A persistent status header across the dashboard evaluating health in priority order:

1. 🔴 **Server Unreachable:** `now - heartbeat_at > 90000`.


2. 🔴 **Processing Paused:** `vision_state = 'PAUSED'`.


3. 🟡 **Recovering Automatically:** `state = 'RETRYING'`.


4. 🟡 **Review Required:** `queue_parked > 0`.


5. 🔵 **Processing Active:** `queue_pending > 0`.


6. 🟢 **All Systems Normal:** Standard operation.



**Key Status Indicators:** Server state (`OK`/`DEGRADED`), Vision status (`OK`/`PAUSED`), Queue trends ($\uparrow\downarrow\rightarrow$), and Training buffer occupancy bar (`flywheel_records` / `flywheel_capacity`).

---

### 2. Operational Cards (Item Grid, Import, Analytics, Exports)

* **User Login & Profile Card:**
* Zero-point user: `user=admin`, `pass=admin`.
* Allows managing up to 10 users with lock/unlock options. Device account changes route through `app_user_requests`.




* **Data Import Card (CSV Ingestion & Processing):**
* **Logs Table:** 10-day / 1,000-record scrolling log.
* **Automated Processing Pipeline (3.a–3.h):**
1. Parse CSV & validate `apparel_id`.
2. Prompt duplicate overwrite confirmation if `apparel_id` exists.
3. Pass values through local `Fuse.js` fuzzy matcher (`country_of_origin`, `color`, `sub_category`) to resolve standard values.


4. Inject numerical master codes (`brand_code`, `category_code`, `sub_category_code`, `size_code`, `country_code`).
5. Match normalized text with `legalArmenianMap.json` to populate Armenian translation columns (`_armenian`).






* **Item Card (Data Grid):**
* Icon controls (no text): Lock (🔴), Delete (🗑️), Set Price (🏷️), View Original Photo (🖼️), View/Trigger Catalog Photo (✨).




* **Analytics Card:**
* Daily scan trends & scans per user/operator.


* **Exports Card:**
* Range/date export to formatted Excel `.xlsx` in English or Armenian (with UTF-8 BOM encoding).





---

### 3. Server Settings Card 1: Operations, Alerts & Fleet (Screens B, C, D)

```
+---------------------------------------------------------------------------------+
| SERVER SETTINGS 1: OPERATIONS & FLEET                                           |
+---------------------------------------------------+-----------------------------+
| [Tab 1: Alerts & Logs]                            | [Tab 2: Vision Credentials] |
| - Open alerts table (coalesced by code)           | - Fingerprint (e.g. ****3f9a)|
| - Severity chips & Action buttons                 | - Vision & Image model input|
|   (e.g., [Retry Now], [View Render Errors])       | - Status: PENDING/VALID/INVALID
| - Acknowledge action writes to server_events      | - Submits via pending table |
+---------------------------------------------------+-----------------------------+
| [Tab 3: Operator Fleet Management]                                              |
| - Read from app_users_public view (no credentials leaked)                      |
| - Create, Disable, Enable, Delete, Reset Password via app_user_requests table   |
| - Flag test accounts (minelli, karen, ali); prevent last admin removal          |
+---------------------------------------------------------------------------------+

```

* **Alerts & Activity Log:** Reads `server_events` joined with `message_dictionary` and translations. Contextual action buttons route users directly to resolution steps (e.g., updating keys or reviewing parked items).


* **Vision Credentials Management:** Views key fingerprints (`****3f9a`) and model profiles. Changes write to `vision_settings_pending` and poll for validation status without exposing raw credentials.


* **Operator Fleet Management:** Manages device operator accounts via `app_users_public` and `app_user_requests`. Safeguards prevent removing the final active operator.



---

### 4. Server Settings Card 2: Training Flywheel & Localization (Screens E, F)

```
+---------------------------------------------------------------------------------+
| SERVER SETTINGS 2: FLYWHEEL & LOCALIZATION                                      |
+---------------------------------------------------+-----------------------------+
| [Tab 1: Training Data (Flywheel)]                 | [Tab 2: Armenian Messaging] |
| - Capacity & usage progress bar                   | - Runtime message dictionary|
| - Watermark export sequence:                      | - English default vs.       |
|   1. Read MAX(rowid) watermark from flywheel.db   |   Armenian translations     |
|   2. Download export package                      | - Direct edit grid for      |
|   3. Issue FLYWHEEL_DUMPED with exported_through_id|   system alerts & hints     |
+---------------------------------------------------+-----------------------------+

```

* **Training Data Control (Flywheel):** Manages low-confidence training samples. Enforces safe purging by capturing `MAX(rowid)` as `exported_through_id` before deletion to prevent un-exported data loss.


* **Message Dictionary & Armenian Translations:** Reads codes dynamically from `message_dictionary`. Allows editing Armenian translations (`message_translations`) with seamless fallback to English defaults if un-translated.



Here is the fully updated, end-to-end **Analytical Dashboard Blueprint & Development Plan**, updated with your exact database column definitions, custom AI inference logic (pricing, weight, HS code), and specialized export workflows.



### Dashboard AI Suggestions Engine Rules

#### 1. AI Suggested Price Engine

Evaluates historical non-empty `user_decided_price` records using two combined models:

* **Spec Suggested Model:** Aggregates records matching `[sub-category, brand, gender, size, season, material, country-of-origin]`. Applies direct positive weighting to attributes and a negative decay factor based on `item age in months`.
* **Photo Suggested Model:** Executes visual similarity matching (>85% feature similarity) against rendered catalog images (`/public/catalog/`) to extract price benchmarks.


* **Synthesis:** Merges Spec and Photo models to derive the final `suggested price`.



#### 2. Weight Suggestion Engine

* **Condition:** Activates only when both `netto == 0` and `brutto == 0`.
* **Step 1 (Historical Match):** SQL lookup averaging weights of past items matching `[brand, gender, size, season, material]`.
* **Step 2 (Local Vision AI Fallback):** If SQL returns zero records, passes the item photo to local vision processing to estimate weight.

#### 3. HS Code Classification Engine

* **Step 1 (Rule-Based Matrix):** Parses `[category, sub-category, material, netto, brutto]` against `Custom_codes.csv` lookup matrix.
* **Step 2 (Historical Similarity Fallback):** If Step 1 returns no match, queries historical items matching the Weight Suggestion similarity criteria to infer the most common `HS Code`.

---

### Updated UI Cards & Layout Plan

```
+-----------------------------------------------------------------------------------+
| LIVENESS BANNER: [Priority Evaluation: Heartbeat > Paused > Retrying > Parked]    |
+-----------------------------------------------------------------------------------+
| CARD 1: USER AUTH & CONTROL                                                       |
| - Predefined Admin (user=admin, pass=admin). Cap: 10 active users.                |
| - Controls: Add, Reset Password, Lock/Unlock (writes to app_user_requests).       |
+-----------------------------------------------------------------------------------+
| CARD 2: DATA IMPORT ENGINE                                                        |
| - Logs Table: Scrolling 10-day / 1,000-record import history.                     |
| - Processing Sequence: CSV Parse -> Overwrite Guard -> Fuse.js Fuzzy Snapping     |
|   -> Master Code Injection -> Armenian Translation Auto-fill.                     |
+-----------------------------------------------------------------------------------+
| CARD 3: ITEM DATA MANAGEMENT GRID                                                 |
| - Displays full master table columns + Armenian copy pairs.                       |
| - Action Icons: Lock (🔴), Delete (🗑️), Set Price (🏷️), View Original Photo (🖼️),|
|   View/Render Catalog Photo (✨).                                                 |
+-----------------------------------------------------------------------------------+
| CARD 4: ANALYTICS DASHBOARD                                                       |
| - Bar Charts: Scans Per Day, Scans Per User/Operator. Extensible layout.          |
+-----------------------------------------------------------------------------------+
| CARD 5: ADVANCED EXPORTS CARD                                                     |
| - Range Selector: Export Last X items OR Select Date Window (Date A to Date B).   |
| - Custom Preset 1: "Seller Invoice" CSV                                           |
|   * Filters out items where cloned_from IS NOT EMPTY.                             |
|   * Columns: [category, sub-category, size, country of origin, group_qty, netto,  |
|               brutto, tag price]. Output: seller_invoice_<datetime>.csv            |
| - Custom Preset 2: "Customs Clearance" CSV                                        |
|   * Filters out items where cloned_from IS NOT EMPTY.                             |
|   * Columns: [row, HSCode, category, sub-category, gender, season, netto, brutto,  |
|               group_qty, brand, country of origin, size, tag price, color,        |
|               material, scanned_date].                                            |
| - Standard Preset 3: Formatted XLS Export (English / Armenian toggle).            |
+-----------------------------------------------------------------------------------+
| CARD 6: SERVER SETTINGS 1 (Operations & Fleet Management)                         |
| - Tab 1: Alerts & Logs (server_events + message_dictionary).                      |
| - Tab 2: Vision Credentials (Fingerprint, Model Config, Pending Table Submits).   |
| - Tab 3: Operator Fleet Management (app_users_public / app_user_requests).        |
+-----------------------------------------------------------------------------------+
| CARD 7: SERVER SETTINGS 2 (Training Flywheel & Localization)                      |
| - Tab 1: Flywheel Management (Watermark read -> Export -> Safe Purge).             |
| - Tab 2: Message Translations (Runtime dictionary + Armenian overrides).          |
+-----------------------------------------------------------------------------------+

```
