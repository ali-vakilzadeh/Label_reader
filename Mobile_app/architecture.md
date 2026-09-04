## Updated Architecture & Middleware Design

With up to 10 mobile devices running concurrently, moving the Gemini API key and prompt logic to the middleware server is the ideal architecture. The mobile app becomes a lean client, while the Node.js/Express server acts as a centralized request coordinator.

```
[ Mobile App 1..10 ] ──(HTTPS + API Token)──> [ Middleware Server ]
                                                     │
                                        (API Key Stored on Server)
                                                     │
                                                     ▼
                                         [ Gemini Vision API ]

```

---

## 1. Middleware Requirements & API Endpoints

### Server Security & Device Auth

* **API Key Management:** The Gemini API key resides solely in the server’s environment variables (`process.env.GEMINI_API_KEY`).
* **Device Authentication:** To protect the server, the server holds a master password (set by you). When a user enters the password in the app's settings, the app exchanges it with the server for a persistent **Device Session Token**. All subsequent API requests send this token in the `Authorization` header.

### API Endpoints

* **`POST /api/v1/auth/login`**
* **Input:** `{ "password": "user_entered_password" }`
* **Output:** `{ "token": "session_jwt_token" }`


* **`POST /api/v1/vision/extract`**
* **Input:** Multipart form data containing up to 8 images, `username`, and client-side metadata (`apparel_id`, `timestamp`, pre-selected `category`, `sub-category`, `gender`, `season`).
* **Function:** Sends images + system prompt to Gemini, parses confidence scores, and returns structured data.



---

## 2. Gemini System Prompt & Structured JSON Output

The middleware server will send the following system instructions and JSON Schema to Gemini.

### System Prompt

```text
You are an expert apparel label extraction assistant. Analyze the provided images of an apparel item.
Extract brand name, country of origin, size, material, and original price directly from the visual tags/labels.
Infer net weight (netto), gross weight (brutto), and dominant color from the given list: [black, white, blue, red, orange, yellow, brown, green, gray].

Rules:
1. Return a confidence score between 0.0 and 1.0 for EVERY field.
2. If a field is NOT explicitly found on the labels, make a reasonable guess ONLY if your confidence is > 0.50. Otherwise, leave the field value as an empty string ("") with a confidence score of 0.0.

```

### Response JSON Schema

```json
{
  "type": "OBJECT",
  "properties": {
    "brand_name": { "type": "OBJECT", "properties": { "value": { "type": "STRING" }, "confidence": { "type": "NUMBER" } } },
    "country_of_origin": { "type": "OBJECT", "properties": { "value": { "type": "STRING" }, "confidence": { "type": "NUMBER" } } },
    "size": { "type": "OBJECT", "properties": { "value": { "type": "STRING" }, "confidence": { "type": "NUMBER" } } },
    "color": { "type": "OBJECT", "properties": { "value": { "type": "STRING" }, "confidence": { "type": "NUMBER" } } },
    "material": { "type": "OBJECT", "properties": { "value": { "type": "STRING" }, "confidence": { "type": "NUMBER" } } },
    "original_price": { "type": "OBJECT", "properties": { "value": { "type": "STRING" }, "confidence": { "type": "NUMBER" } } },
    "netto": { "type": "OBJECT", "properties": { "value": { "type": "STRING" }, "confidence": { "type": "NUMBER" } } },
    "brutto": { "type": "OBJECT", "properties": { "value": { "type": "STRING" }, "confidence": { "type": "NUMBER" } } }
  }
}

```

---

## 3. Data Structure & Export Schema

When the user taps **"Confirm & Save"**, the record is saved locally in SQLite/Room database. The final exported CSV table matches this structure:

| Column Name | Field Origin / Processing |
| --- | --- |
| `apparel_id` | Auto-incrementing integer (starts at 0, strictly monotonic per device) |
| `username` | Pulled from App User Settings |
| `timestamp` | Device system datetime at capture time (`YYYY-MM-DD HH:mm:ss`) |
| `category` | Pre-selected by user prior to photo capture |
| `sub-category` | Pre-selected by user prior to photo capture |
| `gender` | Pre-selected by user prior to photo capture |
| `season` | Pre-selected by user prior to photo capture |
| `netto` | AI estimated value (e.g., `"250g"`) |
| `brutto` | AI estimated value (e.g., `"280g"`) |
| `brand_name` | AI extracted / User verified |
| `country_of_origin` | AI extracted / User verified |
| `size` | AI extracted / User verified |
| `color` | AI matched / User verified |
| `material` | AI extracted / User verified |
| `original_price` | AI extracted / User verified |
| `image_files` | Semicolon-separated local image filenames (e.g., `IMG_001_1.jpg; IMG_001_2.jpg`) |
| `package_code` | Operator-entered on the Pre-Capture screen; sticky across scans until changed. Never sent to Gemini and never sent to the middleware — it exists only in Room and in the exported CSV (`PackageCode`, see `csv_export_format.txt`) |
| `set_size` | Integer, default `1`. Operator-entered in the Floating Review Dialog for articles sold as a set (2-pack of stockings, 2-pack of undies). Never asked of Gemini — the packaging hides the second item. CSV column `SetSize`; not sent to the middleware |

---

## 4. UI Behavior for Low-Confidence Fields

* **Threshold Logic:** Any field returned by Gemini where `confidence < 0.70` triggers a yellow background (`#FFF9C4`) on the input container in the Floating Review Dialog.
* **Blank Fields:** If Gemini returns a confidence $\le 0.50$ for missing data, the field displays as empty with a yellow background, prompting the user to either fill it in manually or accept it as blank.

### Set size

The review dialog also carries a **`Set of X`** stepper, defaulting to `1`. The operator raises it when the article is a packaged set — a 2-pack of stockings, a 2-pack of undies. It is deliberately outside the AI-extracted block: it carries no confidence, is never highlighted yellow, and is never pre-filled from a Gemini response, because the second item is usually inside the packaging where the camera cannot see it.

Raising it does **not** change any other field. The row still describes one packet: `Netto` and `Brutto` stay as read from the label (the whole packet), and size, colour and price describe the set as a whole. A packet holding mixed sizes or colours is not a set — scan those as separate articles.

---

## Technical Setup Plan

1. **Pre-Capture Screen:** Add quick dropdown selectors for `Category`, `Sub-category`, `Gender`, and `Season` before opening the CameraX interface, plus a `Package code` text field that persists across scans until the operator changes it.
2. **Review Dialog:** Add the `Set of X` stepper (default `1`) alongside the extracted fields, outside the confidence-highlighting logic.
3. **App Settings Screen:** Add `Username` and `Server Password` fields. Storing the valid password unlocks app capabilities and enables the Danger Zone button to purge local scan history.
4. **CSV Export:** Implement native sharing (`Intent.ACTION_SEND`) passing the generated `.csv` containing all 18 schema columns.
