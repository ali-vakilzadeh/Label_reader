import type {
  AsyncVisionResponse,
  BatchVisionResultsResponse,
  ConnectionValidationResult,
  HealthResponse,
  LoginResponse,
  ScanEntity,
  VisionExtraction
} from '../types/models';
import { loadSettings, saveSettings } from '../data/settingsStorage';

export class VisionApiService {
  /**
   * Acquire or refresh JWT device token
   */
  static async getAuthToken(forceRefresh = false): Promise<string | null> {
    const settings = loadSettings();
    if (!forceRefresh && settings.sessionToken) {
      return settings.sessionToken;
    }

    try {
      const loginPayload = {
        username: settings.userId.trim(),
        user_id: settings.userId.trim(),
        password: settings.devicePassword.trim()
      };

      const res = await fetch(`${settings.serverUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginPayload)
      });

      if (!res.ok) {
        console.warn(`Auth failed with HTTP ${res.status}`);
        return null;
      }

      const data: LoginResponse = await res.json();
      const token = data.token;
      if (token) {
        saveSettings({ sessionToken: token });
        return token;
      }
      return null;
    } catch (err) {
      console.warn('Auth request failed (network unreachable):', err);
      return null;
    }
  }

  /**
   * Ping server health
   */
  static async checkHealth(): Promise<{ ok: boolean; data?: HealthResponse; error?: string }> {
    const settings = loadSettings();
    try {
      let res = await fetch(`${settings.serverUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok && res.status === 404) {
        res = await fetch(`${settings.serverUrl}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
      }

      if (res.ok) {
        const data = await res.json();
        return { ok: true, data };
      }
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message || 'Connection failed' };
    }
  }

  /**
   * Full end-to-end diagnostic test
   */
  static async testConnectionAndAuth(): Promise<ConnectionValidationResult> {
    const settings = loadSettings();
    const healthResult = await this.checkHealth();
    const isHealthOk = healthResult.ok;
    const health = healthResult.data;

    const token = await this.getAuthToken(true);
    const isAuthOk = !!token;
    const isSuccess = isAuthOk || (isHealthOk && !!settings.sessionToken);

    let errorReason: string | undefined;
    if (!isHealthOk && !isAuthOk) {
      errorReason = `Cannot reach middleware server at ${settings.serverUrl}. Please check host address, port, and network connection.`;
    } else if (isHealthOk && !isAuthOk) {
      errorReason = 'Server reached, but device credentials were rejected. Please verify Operator Username and Device Password.';
    }

    return {
      isSuccessful: isSuccess,
      isHealthOk,
      isAuthOk,
      serverVersion: health?.version || '1.0.0',
      uptimeSeconds: health?.uptime_seconds || health?.uptimeSeconds || 0,
      geminiReady: health?.gemini_ready || health?.geminiConfigured || false,
      username: settings.userId,
      tokenPreview: token ? `${token.substring(0, 14)}...` : undefined,
      errorMessage: errorReason
    };
  }

  /**
   * Convert data URL / Blob to File object for multipart form upload
   */
  private static async dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return new File([blob], filename, { type: blob.type || 'image/jpeg' });
  }

  /**
   * Submit scan with up to 8 images for Gemini extraction
   */
  static async submitVisionExtract(scan: ScanEntity, clonedFrom?: string): Promise<{ ok: boolean; response?: AsyncVisionResponse; error?: string }> {
    const settings = loadSettings();

    // If demo mode is on, return local synthetic output
    if (settings.demoModeEnabled) {
      const synthetic = this.generateSyntheticExtraction(scan.apparelId);
      return {
        ok: true,
        response: {
          status: 'success',
          apparel_id: scan.apparelId,
          processing_status: 'READY_TO_CONFIRM',
          data: {
            brand_name: synthetic.brandName,
            category: synthetic.category,
            sub_category: synthetic.subCategory,
            gender: synthetic.gender,
            season: synthetic.season,
            size: synthetic.size,
            color: synthetic.color,
            material: synthetic.material,
            country_of_origin: synthetic.countryOfOrigin,
            original_price: synthetic.originalPrice,
            netto: synthetic.netto,
            brutto: synthetic.brutto
          }
        }
      };
    }

    let token = await this.getAuthToken();
    if (!token) {
      return { ok: false, error: 'AUTH_REQUIRED: Invalid device credentials or server unreachable' };
    }

    try {
      const formData = new FormData();
      formData.append('apparel_id', scan.apparelId);
      formData.append('username', settings.userId);
      formData.append('key_photo_index', String(scan.keyPhotoIndex));
      if (clonedFrom) {
        formData.append('cloned_from', clonedFrom);
      }

      // Append up to 8 photos
      for (let i = 0; i < Math.min(scan.photos.length, 8); i++) {
        const photoData = scan.photos[i];
        if (photoData) {
          const file = await this.dataUrlToFile(photoData, `IMG_${scan.apparelId}_${i + 1}.jpg`);
          formData.append('images', file);
        }
      }

      let res = await fetch(`${settings.serverUrl}/api/v1/vision/extract`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: formData
      });

      // Handle 401 token refresh
      if (res.status === 401) {
        token = await this.getAuthToken(true);
        if (token) {
          res = await fetch(`${settings.serverUrl}/api/v1/vision/extract`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`
            },
            body: formData
          });
        }
      }

      if (res.status >= 200 && res.status < 300) {
        const body: AsyncVisionResponse = await res.json();
        return { ok: true, response: body };
      }

      const errText = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${errText}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message || 'Transport failure' };
    }
  }

  /**
   * Batch poll results for scans waiting on AI
   */
  static async getBatchVisionResults(apparelIds: string[]): Promise<{ ok: boolean; response?: BatchVisionResultsResponse; error?: string }> {
    if (apparelIds.length === 0) {
      return { ok: true, response: { status: 'success', results: [] } };
    }

    const settings = loadSettings();
    let token = await this.getAuthToken();
    if (!token) {
      return { ok: false, error: 'AUTH_REQUIRED: Invalid session token' };
    }

    try {
      const idsParam = encodeURIComponent(apparelIds.slice(0, 100).join(','));
      let res = await fetch(`${settings.serverUrl}/api/v1/vision/results?ids=${idsParam}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (res.status === 401) {
        token = await this.getAuthToken(true);
        if (token) {
          res = await fetch(`${settings.serverUrl}/api/v1/vision/results?ids=${idsParam}`, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`
            }
          });
        }
      }

      if (res.ok) {
        const data: BatchVisionResultsResponse = await res.json();
        return { ok: true, response: data };
      }

      return { ok: false, error: `Batch poll HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message || 'Batch poll network error' };
    }
  }

  /**
   * High-fidelity local synthetic generator for demo mode & offline fallback testing
   */
  static generateSyntheticExtraction(_barcode: string): VisionExtraction {
    const brands = ['Zara', 'Nike', "Levi'S", 'Adidas', 'H&M', 'Massimo Dutti', 'Mango', 'Puma', 'Tommy Hilfiger', 'Calvin Klein'];
    const subCategories = ['T-shirt', 'Trousers', 'Hoodie', 'Shirt', 'Dress', 'Jeans', 'Jacket', 'Sweater', 'Shorts', 'Skirt'];
    const materials = ['Cotton', 'Polyester', 'Wool', 'Silk', 'Linen', 'Viscose', 'Elastane', 'Denim'];
    const countries = ['PORTUGAL', 'VIETNAM', 'ITALY', 'TURKEY', 'BANGLADESH', 'CHINA', 'SPAIN', 'INDIA'];
    const colors = ['Blue - Navy', 'Black', 'White', 'Grey', 'Dark red', 'Khaki', 'Green', 'Brown'];
    const sizes = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '38', '40', '42'];

    const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

    return {
      brandName: { value: pick(brands), confidence: 0.95 },
      category: { value: 'clothing', confidence: 0.92 },
      subCategory: { value: pick(subCategories), confidence: 0.89 },
      gender: { value: 'Men', confidence: 0.90 },
      season: { value: 'All Seasons', confidence: 0.85 },
      size: { value: pick(sizes), confidence: 0.92 },
      color: { value: pick(colors), confidence: 0.89 },
      material: { value: pick(materials), confidence: 0.88 },
      countryOfOrigin: { value: pick(countries), confidence: 0.85 },
      originalPrice: { value: '€49.95', confidence: 0.80 },
      netto: { value: '260g', confidence: 0.65 }, // < 0.70 triggers review highlight
      brutto: { value: '290g', confidence: 0.60 }  // < 0.70 triggers review highlight
    };
  }
}
