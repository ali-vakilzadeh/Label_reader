import type {
  AsyncVisionResponse,
  BatchVisionResultsResponse,
  ConnectionValidationResult,
  HealthResponse,
  LoginResponse,
  ScanEntity
} from '../types/models';
import type { ReferenceTablesResponse } from '../data/referenceTables';
import { hasCredentials, loadSettings, saveSettings } from '../data/settingsStorage';

/** The contract revision this client is written against. */
export const TARGET_API_CONTRACT = '1.4';

/**
 * 401s the operator cannot retry their way out of. ACCOUNT_DISABLED needs a
 * supervisor; the rest mean "log in again" (contract section 4.1).
 */
const AUTH_ERROR_CODES = new Set(['ACCOUNT_DISABLED', 'TOKEN_REVOKED', 'INVALID_TOKEN', 'TOKEN_EXPIRED']);

export class VisionApiService {
  /**
   * Acquire or refresh the JWT. Returns null when the device has no credentials at
   * all, which is a configuration state rather than a failure - the app routes the
   * operator to Settings instead of retrying.
   */
  static async getAuthToken(forceRefresh = false): Promise<string | null> {
    const settings = loadSettings();
    if (!hasCredentials(settings)) return null;
    if (!forceRefresh && settings.sessionToken) return settings.sessionToken;

    try {
      const res = await fetch(`${settings.serverUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: settings.userId.trim(),
          password: settings.devicePassword.trim()
        })
      });

      const data: LoginResponse = await res.json().catch(() => ({}) as LoginResponse);

      if (!res.ok) {
        if (data.error_code && AUTH_ERROR_CODES.has(data.error_code)) {
          saveSettings({ sessionToken: undefined });
        }
        console.warn(`Auth failed: HTTP ${res.status} ${data.error_code ?? ''}`);
        return null;
      }

      if (data.token) {
        saveSettings({ sessionToken: data.token });
        return data.token;
      }
      return null;
    } catch (err) {
      console.warn('Auth request failed (network unreachable):', err);
      return null;
    }
  }

  /** `GET /health` - unauthenticated, so it works before login. */
  static async checkHealth(): Promise<{ ok: boolean; data?: HealthResponse; error?: string }> {
    const settings = loadSettings();
    try {
      const res = await fetch(`${settings.serverUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return { ok: true, data: await res.json() };
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message || 'Connection failed' };
    }
  }

  static async testConnectionAndAuth(): Promise<ConnectionValidationResult> {
    const settings = loadSettings();
    const healthResult = await this.checkHealth();
    const health = healthResult.data;
    const token = await this.getAuthToken(true);
    const isAuthOk = Boolean(token);

    let errorMessage: string | undefined;
    if (!healthResult.ok && !isAuthOk) {
      errorMessage = `Cannot reach the middleware at ${settings.serverUrl}. Check the address, the port and the network.`;
    } else if (healthResult.ok && !isAuthOk) {
      errorMessage = hasCredentials(settings)
        ? 'Server reached, but the credentials were rejected. Verify the operator username and password.'
        : 'Server reached. Enter an operator username and password to sign in.';
    }

    // A server older than the contract still works - care_info and data_hy simply
    // arrive empty - but the operator should know why those fields stay blank.
    const served = health?.api_contract;
    const contractWarning =
      served && served !== TARGET_API_CONTRACT
        ? `Server implements contract ${served}; this app targets ${TARGET_API_CONTRACT}. CareInfo and Armenian AI labels stay empty until the middleware is updated.`
        : undefined;

    return {
      isSuccessful: isAuthOk,
      isHealthOk: healthResult.ok,
      isAuthOk,
      serverVersion: health?.version,
      apiContract: served,
      uptimeSeconds: health?.uptime_seconds,
      geminiReady: Boolean(health?.gemini_ready),
      username: settings.userId,
      tokenPreview: token ? `${token.substring(0, 14)}...` : undefined,
      errorMessage,
      contractWarning
    };
  }

  /**
   * `GET /api/v1/reference-tables`. A 304 means the cached copy is current; a 404
   * means the server predates v1.3 and the app stays on its bundled tables.
   */
  static async fetchReferenceTables(
    cachedVersion?: string
  ): Promise<{ ok: boolean; notModified?: boolean; payload?: ReferenceTablesResponse; error?: string }> {
    const settings = loadSettings();
    const token = await this.getAuthToken();
    if (!token) return { ok: false, error: 'Not signed in.' };

    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (cachedVersion) headers['If-None-Match'] = `"${cachedVersion}"`;

      const res = await fetch(`${settings.serverUrl}/api/v1/reference-tables`, {
        headers,
        signal: AbortSignal.timeout(20000)
      });

      if (res.status === 304) return { ok: true, notModified: true };
      if (res.status === 404) {
        return { ok: false, error: 'This server does not serve reference tables (contract v1.2 or earlier).' };
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

      return { ok: true, payload: (await res.json()) as ReferenceTablesResponse };
    } catch (err) {
      return { ok: false, error: (err as Error).message || 'Network error' };
    }
  }

  private static async dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return new File([blob], filename, { type: blob.type || 'image/jpeg' });
  }

  /**
   * `POST /api/v1/vision/extract`. The request carries exactly the five fields the
   * contract defines - PackageCode and SetSize are deliberately not among them
   * (section 8.5): they are operator input and never cross this API.
   */
  static async submitVisionExtract(
    scan: ScanEntity,
    clonedFrom?: string
  ): Promise<{ ok: boolean; response?: AsyncVisionResponse; error?: string }> {
    const settings = loadSettings();

    let token = await this.getAuthToken();
    if (!token) {
      return { ok: false, error: 'AUTH_REQUIRED: sign in on the Settings screen.' };
    }

    try {
      const buildForm = async () => {
        const formData = new FormData();
        formData.append('apparel_id', scan.apparelId);
        formData.append('username', settings.userId);
        formData.append('key_photo_index', String(scan.keyPhotoIndex));
        if (clonedFrom) formData.append('cloned_from', clonedFrom);

        // A clone needs no images; the server copies the parent record.
        if (!clonedFrom) {
          for (let i = 0; i < Math.min(scan.photos.length, 8); i++) {
            const photoData = scan.photos[i];
            if (photoData) {
              formData.append('images', await this.dataUrlToFile(photoData, `IMG_${scan.apparelId}_${i + 1}.jpg`));
            }
          }
        }
        return formData;
      };

      const post = (bearer: string, body: FormData) =>
        fetch(`${settings.serverUrl}/api/v1/vision/extract`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}` },
          body
        });

      // A FormData body is consumed by the first send, so the retry rebuilds it.
      let res = await post(token, await buildForm());

      if (res.status === 401) {
        const refreshed = await this.getAuthToken(true);
        if (refreshed) {
          token = refreshed;
          res = await post(refreshed, await buildForm());
        }
      }

      if (res.status >= 200 && res.status < 300) {
        return { ok: true, response: (await res.json()) as AsyncVisionResponse };
      }

      const body = await res.json().catch(() => null);
      const code = body?.error_code ? `${body.error_code}: ` : '';
      return { ok: false, error: `${code}${body?.message || `HTTP ${res.status}`}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message || 'Transport failure' };
    }
  }

  /** `GET /api/v1/vision/results?ids=` - the batch form, capped at 100 ids. */
  static async getBatchVisionResults(
    apparelIds: string[]
  ): Promise<{ ok: boolean; response?: BatchVisionResultsResponse; error?: string }> {
    if (apparelIds.length === 0) {
      return { ok: true, response: { status: 'success', results: [] } };
    }

    const settings = loadSettings();
    let token = await this.getAuthToken();
    if (!token) return { ok: false, error: 'AUTH_REQUIRED: sign in on the Settings screen.' };

    try {
      const idsParam = encodeURIComponent(apparelIds.slice(0, 100).join(','));
      const url = `${settings.serverUrl}/api/v1/vision/results?ids=${idsParam}`;
      const get = (bearer: string) => fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });

      let res = await get(token);
      if (res.status === 401) {
        const refreshed = await this.getAuthToken(true);
        if (refreshed) {
          token = refreshed;
          res = await get(refreshed);
        }
      }

      if (res.ok) return { ok: true, response: (await res.json()) as BatchVisionResultsResponse };
      return { ok: false, error: `Batch poll HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message || 'Batch poll network error' };
    }
  }
}
