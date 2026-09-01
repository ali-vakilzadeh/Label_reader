# Label Reader Enterprise PWA (Progressive Web Application)

A high-performance, mobile-optimized Enterprise Progressive Web Application for apparel care label composition auditing, barcode scanning, Gemini Vision AI automated extraction, and daily production ledger management.

Fully compatible with **Apple devices (iPhone, iPad, Mac)** and modern mobile browsers, with complete offline capabilities, zero Android runtime dependencies, and strict adherence to the enterprise middleware API contract.

---

## 🌟 Features & Workflow Catalog

### 1. Garment Intake (`/capture`)
* **Live Camera Viewfinder**: High-resolution mobile camera feed with an alignment reticle, real-time autofocus, torch/flashlight controls (where hardware supported), and touch capture.
* **Continuous Barcode Recognition**: Automatic detection of Code 128, EAN-13, EAN-8, UPC, and QR codes via the HTML5 BarcodeDetector API.
* **Multi-Photo Care Label Filmstrip**: Capture up to 8 care label / wash-tag photos per garment.
* **Key Photo Flagging**: One-tap star toggle to designate the primary catalog image.
* **Sample Care Tag Generator**: Built-in synthetic care label generator for instant end-to-end testing without physical apparel.
* **Photo Import**: Upload high-res images directly from device photo library / album.

### 2. Verification Workspace (`/review`)
* **Operator Extraction Review**: Split-tab view for "Ready to Review" extractions and "AI Queue / Attention".
* **12 Care Attribute Auditing**:
  1. **Brand Name** (Searchable Autocomplete from verified brand dictionary)
  2. **Category** (Interactive pill selector: Clothing, Shoe, Accessories)
  3. **Sub-Category** (Autocomplete garment type)
  4. **Gender / Department** (Men, Women, Girls, Boys, Unisex, Baby Girl, Baby Boy)
  5. **Season** (Summer, Autumn, Spring, Winter, All Seasons)
  6. **Size** (Confidence-highlighted text input)
  7. **Dominant Color** (Autocomplete color palette)
  8. **Material Composition** (Single-fibre standard autocomplete)
  9. **Country of Origin** (Auto-capitalized ISO standard origin list)
  10. **Original Price**
  11. **Netto Weight**
  12. **Brutto Weight**
* **Confidence Highlight System**: Visual alerting (LsRust background & badge) for any attribute confidence `< 70%` or missing values.
* **High-Resolution Photo Zoom Carousel**: Zoom into stitched care label text while editing fields.

### 3. Production Audit & Daily Ledger (`/ledger`)
* **Active Session Ledger**: Real-time view of verified garments for the active production shift.
* **Two-Step Production Cut-Off**:
  1. **Step 1**: Generates RFC 4180 compliant CSV file (`apparel_ledger_YYYYMMDD_HHMMSS.csv`) and triggers immediate download.
  2. **Step 2**: Confirms operator receipt and stamps batch ID, advancing the active session to 0 while archiving all records in the History Archive.
* **Garment Composition Cloning**: Instant 1-tap clone tool to duplicate verified composition attributes to a new garment barcode.
* **History Archive**: Full retrospective database of all historical scanned batches.

### 4. Middleware Synchronization Engine
* **Background Polling Loop**: Automatic interval polling every 6 seconds for pending AI jobs.
* **Storage Invariant Guarantee**: Unprocessed scans remain safely in local IndexedDB until an HTTP `2xx` confirmation is returned by the server.
* **Synthetic Fallback Mode**: When offline or in Demo Mode, generates deterministic Gemini-grade inferences with simulated confidence scores.

### 5. Enterprise Settings & Security (`/settings`)
* **Configurable Base URL**: Connect to local or remote middleware servers.
* **Operator ID & Master Password Authentication**: Bearer JWT token handshake with automatic renewal.
* **Connection Diagnostics**: Live test tool verifying ping, auth token, server version, and Gemini status.
* **Storage Sanitization & Danger Zone**: Purge cached photos and reset IndexedDB records with confirmation guardrails.

---

## 🛠️ Technology Stack

| Layer | Technology |
|---|---|
| **Framework** | React 19 + TypeScript (Strict mode) |
| **Bundler & Dev Server** | Vite 6 |
| **Styling & Design System** | Tailwind CSS with warm luxury brand palette (LsCreme, LsGold, LsCocoa, LsRust) |
| **Client-Side Database** | IndexedDB via `Dexie.js` + `dexie-react-hooks` |
| **PWA Service Worker** | Custom Cache-First Service Worker (`public/sw.js`) |
| **PWA Manifest** | `manifest.json` with iOS standalone display settings & icons |
| **Icons** | Lucide React Icons |

---

## 🚀 Getting Started & Compiling the PWA

### Prerequisites
* Node.js 18+ and npm installed on your machine.

### Installation & Development
```bash
# 1. Install dependencies
npm install

# 2. Run local development server
npm run dev
```

### Production Build
```bash
# Compile TypeScript and bundle optimized production PWA into /dist
npm run build

# Preview production build locally
npm run preview
```

---

## 📱 How to Install and Run on Apple Devices (iOS / iPadOS / macOS)

### Step 1: Open in Safari
1. Open **Safari** on your iPhone or iPad.
2. Navigate to your hosted PWA URL (or your local network dev URL, e.g., `http://192.168.1.X:5173` or production HTTPS domain).

> **Note for Apple Camera Access**: iOS Safari requires **HTTPS** (or `localhost`) to grant hardware camera permissions. When deploying to staging or production, ensure your server is served over HTTPS.

### Step 2: Add to Home Screen (PWA Installation)
1. Tap the **Share** button (the square with an arrow pointing upward) in Safari's bottom toolbar.
2. Scroll down the share sheet and tap **Add to Home Screen** (`+`).
3. Tap **Add** in the top-right corner.

### Step 3: Launch Standalone App
1. The **Label Reader** app icon will appear on your iOS home screen.
2. Tap the icon to launch the application in **full-screen standalone mode** (without Safari URL bars or browser chrome).
3. The app is fully cached offline by the Service Worker and runs natively with iOS safe-area insets.

---

## 🔌 Middleware Server Integration & API Contract

The PWA integrates directly with the backend middleware server defined in `/middleware-server/server.js`:

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | `GET` | Server health check and Gemini API readiness status |
| `/api/auth/token` | `POST` | Authenticates operator credentials and issues a JWT Bearer token |
| `/api/vision/extract` | `POST` (Multipart) | Uploads garment photos (`photos[]`), apparel ID, and operator metadata |
| `/api/vision/results` | `POST` | Batch queries status (`READY_TO_CONFIRM`, `PENDING_AI`, `NEEDS_ATTENTION`) |

### API Contract Data Mapping
Every extraction returns the 12 verified attributes mapped with value and confidence:
```json
{
  "category": { "value": "clothing", "confidence": 0.95 },
  "sub_category": { "value": "T-shirt", "confidence": 0.92 },
  "gender": { "value": "Men", "confidence": 0.90 },
  "season": { "value": "Summer", "confidence": 0.88 },
  "brand_name": { "value": "ZARA", "confidence": 0.98 },
  "country_of_origin": { "value": "PORTUGAL", "confidence": 0.94 },
  "size": { "value": "L", "confidence": 0.91 },
  "color": { "value": "Navy Blue", "confidence": 0.89 },
  "material": { "value": "100% Cotton", "confidence": 0.95 },
  "original_price": { "value": "€29.95", "confidence": 0.85 },
  "netto": { "value": "210g", "confidence": 0.70 },
  "brutto": { "value": "230g", "confidence": 0.65 }
}
```

---

## 📂 Project Structure

```
├── public/
│   ├── favicon.svg          # Vector SVG app icon
│   ├── icons/               # PWA icons (192x192, 512x512)
│   ├── manifest.json        # Web App Manifest for iOS/Android PWA
│   └── sw.js                # Service Worker for offline asset caching
├── src/
│   ├── components/          # Reusable UI components
│   │   ├── AutocompleteInput.tsx   # Searchable dropdown with chips
│   │   ├── CameraViewfinder.tsx    # HTML5 live camera & barcode reticle
│   │   ├── ConfidenceField.tsx     # <70% confidence warning highlights
│   │   ├── CsvCutoffDialog.tsx     # 2-step production session cut-off
│   │   ├── DuplicateModal.tsx      # Garment composition cloner
│   │   ├── EnumSelector.tsx        # M3 interactive category/gender pills
│   │   ├── ReviewDetailModal.tsx   # 12-attribute modal dialog
│   │   └── Toast.tsx               # Floating pill notification system
│   ├── data/
│   │   ├── db.ts                   # Dexie IndexedDB schemas and DAOs
│   │   ├── settingsStorage.ts      # Persistent local storage for configs
│   │   └── vocabulary.ts           # Standard reference dictionaries
│   ├── screens/
│   │   ├── CaptureScreen.tsx       # Garment intake & photo capturing
│   │   ├── DailyLedgerScreen.tsx   # Production ledger & CSV export
│   │   ├── ReviewScreen.tsx        # Verification workspace
│   │   └── SettingsScreen.tsx      # Connectivity & device configuration
│   ├── services/
│   │   ├── syncEngine.ts           # Background synchronization manager
│   │   └── visionApiService.ts     # Middleware HTTP client & fallback
│   ├── types/
│   │   └── models.ts               # Core domain interfaces
│   ├── App.tsx                     # Application Shell & bottom navigation
│   ├── index.css                   # Brand theme tokens & Tailwind styles
│   └── main.tsx                    # React application entrypoint
├── index.html                      # HTML5 container with iOS meta tags
├── package.json                    # Project dependencies and scripts
├── tsconfig.json                   # TypeScript configuration
└── vite.config.ts                  # Vite build configuration
```
