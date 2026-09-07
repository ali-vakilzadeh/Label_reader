import type { AppSettingsData } from '../types/models';

const SETTINGS_KEY = 'apparel_vision_enterprise_settings';

export const DEFAULT_SERVER_URL = 'https://dev.outfit.am';

/**
 * No credentials ship with the app. The operator must enter a username, a password and
 * a server before anything can be scanned (client decisions 9 and 10) - there is no
 * demo mode and no anonymous path, so a blank username is the signal for first run.
 */
const DEFAULT_SETTINGS: AppSettingsData = {
  userId: '',
  devicePassword: '',
  serverUrl: DEFAULT_SERVER_URL,
  sessionToken: undefined,
  defaultStartDestination: 'capture',
  autoSyncAiVision: true,
  requireCompleteForExport: true,
  packageCode: '',
  torchMode: 'auto',
  language: 'en'
};

export function normalizeServerUrl(input: string): string {
  let url = (input || '').trim();
  if (!url) return DEFAULT_SERVER_URL;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }
  url = url.replace(/\/+$/, '');
  if (url.toLowerCase().endsWith('/api/v1')) {
    url = url.substring(0, url.length - '/api/v1'.length).replace(/\/+$/, '');
  }
  return url;
}

export function loadSettings(): AppSettingsData {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettingsData>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      serverUrl: normalizeServerUrl(parsed.serverUrl || DEFAULT_SETTINGS.serverUrl)
    };
  } catch (err) {
    console.warn('Failed to load settings from localStorage:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Partial<AppSettingsData>): AppSettingsData {
  const current = loadSettings();
  const updated: AppSettingsData = {
    ...current,
    ...settings,
    serverUrl:
      settings.serverUrl !== undefined ? normalizeServerUrl(settings.serverUrl) : current.serverUrl
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
  } catch (err) {
    console.warn('Failed to save settings to localStorage:', err);
  }
  return updated;
}

/**
 * Whether the device is configured enough to talk to the middleware. Until this is
 * true the app opens on Settings instead of showing a warning the operator has to
 * dismiss (client decision 10).
 */
export function hasCredentials(settings: AppSettingsData = loadSettings()): boolean {
  return Boolean(settings.userId.trim() && settings.devicePassword.trim() && settings.serverUrl.trim());
}

/** Drops the session token and the password, keeping the server and username typed in. */
export function signOut(): AppSettingsData {
  return saveSettings({ sessionToken: undefined, devicePassword: '' });
}

/** The package code the operator last typed, reused until they change it (decision 6). */
export function getStickyPackageCode(): string {
  return loadSettings().packageCode;
}

export function setStickyPackageCode(code: string): void {
  saveSettings({ packageCode: code });
}
