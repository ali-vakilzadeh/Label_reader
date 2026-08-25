## API Contract Specification

This is the locked, immutable API contract binding Android Client and Middleware.

### Base Configuration

* **Protocol:** `HTTPS`
* **Port:** `443` (standard) or `3000`
* **Base Path:** `/api/v1`
* **Authentication:** HTTP Header `Authorization: Bearer <JWT_TOKEN>`

---

### Endpoints

#### 1. Authentication (`POST /api/v1/auth/login`)

Establishes a device session using the Master Device Password set in user settings.

* **Request Body (`application/json`):**

```json
{
  "password": "user_device_password",
  "username": "emp_402"
}

```

* **Response (`HTTP 200 OK`):**

```json
{
  "status": "success",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": "30d"
}

```

---

#### 2. Vision & Extract Endpoint (`POST /api/v1/vision/extract`)

Handles original scans and child duplicate records. Returns extracted values along with a pre-computed, deterministic catalog image URL.

* **Request Type:** `multipart/form-data`
* **Headers:** `Authorization: Bearer <JWT_TOKEN>`
* **Form Data Fields:**

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `apparel_id` | String | **Yes** | Scanned physical barcode (e.g., `"890123456789"`) |
| `username` | String | **Yes** | Employee/User ID from app settings |
| `key_photo_index` | Integer | **Yes** | Zero-based index (0-7) indicating which uploaded photo is the main product photo |
| `cloned_from` | String | *Optional* | Parent barcode if duplicating. If present, server skips Gemini Vision and returns parent record data under new `apparel_id` |
| `images` | File Array | **Conditional** | Up to 8 binary JPEG/PNG files. Required if `cloned_from` is null |

* **Response (`HTTP 200 OK`):**

```json
{
  "status": "success",
  "apparel_id": "890123456789",
  "cloned_from": null,
  "timestamp": "2026-08-25T14:36:09Z",
  "catalog_image_url": "https://vps-domain.com/catalog/IMG_890123456789.jpg",
  "data": {
    "brand_name": { "value": "Nike", "confidence": 0.95 },
    "country_of_origin": { "value": "Vietnam", "confidence": 0.88 },
    "size": { "value": "XL", "confidence": 0.90 },
    "color": { "value": "black", "confidence": 0.92 },
    "material": { "value": "100% Polyester", "confidence": 0.85 },
    "original_price": { "value": "$45.00", "confidence": 0.99 },
    "netto": { "value": "240g", "confidence": 0.80 },
    "brutto": { "value": "290g", "confidence": 0.80 },
    "category": { "value": "clothing", "confidence": 0.90 },
    "sub_category": { "value": "pants", "confidence": 0.85 },
    "gender": { "value": "unisex", "confidence": 0.75 },
    "season": { "value": "all-seasons", "confidence": 0.70 }
  }
}

```

* **Error Response (`HTTP 400 / 500`):**

```json
{
  "status": "error",
  "error_code": "INVALID_IMAGE_PAYLOAD",
  "message": "Failed to extract values from labels. At least one readable image is required."
}

```

---

#### 3. System Health Check (`GET /health`)

* **Response (`HTTP 200 OK`):**

```json
{
  "status": "ok",
  "uptime_seconds": 142050
}

```

---