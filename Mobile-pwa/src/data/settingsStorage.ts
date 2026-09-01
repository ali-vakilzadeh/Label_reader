import type { AppSettingsData } from '../types/models';

const SETTINGS_KEY = 'apparel_vision_enterprise_settings';

const DEFAULT_SETTINGS: AppSettingsData = {
  userId: 'operator_01',
  devicePassword: 'enterprise2026',
  serverUrl: 'http://localhost:3000',
  sessionToken: undefined,
  defaultStartDestination: 'review',
  autoSyncAiVision: true,
  demoModeEnabled: false,
  lastScannedBarcode: undefined,
  demoCounter: 1
};

export function normalizeServerUrl(input: string): string {
  let url = (input || '').trim();
  if (!url) return 'http://localhost:3000';
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `http://${url}`;
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
    const parsed = JSON.parse(raw);
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
    serverUrl: settings.serverUrl !== undefined ? normalizeServerUrl(settings.serverUrl) : current.serverUrl
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
  } catch (err) {
    console.warn('Failed to save settings to localStorage:', err);
  }
  return updated;
}

export function getNextDemoBarcode(): string {
  const current = loadSettings();
  const nextSeq = current.demoCounter || 1;
  saveSettings({ demoCounter: nextSeq + 1 });
  return `demo_${String(nextSeq).padStart(4, '0')}`;
}
