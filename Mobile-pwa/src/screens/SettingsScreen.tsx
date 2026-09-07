import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  HardDrive,
  LogOut,
  RefreshCw,
  Server,
  ShieldAlert,
  Sliders,
  Trash2
} from 'lucide-react';
import { hasCredentials, loadSettings, saveSettings, signOut } from '../data/settingsStorage';
import { VisionApiService } from '../services/visionApiService';
import { vocabulary } from '../data/vocabulary';
import { LedgerDao, ScanDao, db } from '../data/db';
import type { AppSettingsData, ConnectionValidationResult } from '../types/models';
import type { ShowToast } from '../App';

interface SettingsScreenProps {
  showToast: ShowToast;
  onSettingsChanged?: () => void;
}

/** One framed block. The order of these on screen is client decision 17-B. */
const Section: React.FC<{
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  tone?: 'default' | 'danger';
}> = ({ icon, title, children, tone = 'default' }) => (
  <section
    className={`p-4 rounded-[var(--radius-container)] border shadow-[var(--shadow-card)] flex flex-col gap-3.5 ${
      tone === 'danger' ? 'bg-cream-50 border-[color:var(--color-critical)]/40' : 'bg-cream-50 border-cocoa-200'
    }`}
  >
    <div className="flex items-center gap-2.5">
      <div
        className={`w-8 h-8 rounded-[var(--radius-control)] flex items-center justify-center ${
          tone === 'danger' ? 'text-[color:var(--color-critical)] bg-cream-200' : 'text-navy-800 bg-cream-200'
        }`}
      >
        {icon}
      </div>
      <h2 className={`text-[0.88rem] font-semibold ${tone === 'danger' ? 'text-[color:var(--color-critical)]' : 'text-navy-900'}`}>
        {title}
      </h2>
    </div>
    {children}
  </section>
);

const fieldClass =
  'w-full px-3 py-2.5 min-h-[44px] rounded-[var(--radius-control)] text-[0.88rem] bg-white border border-cocoa-200 text-navy-800 placeholder:text-cocoa-400 outline-none focus:border-gold-600';

const labelClass = 'text-[0.75rem] font-semibold uppercase tracking-wider text-cocoa-600';

export const SettingsScreen: React.FC<SettingsScreenProps> = ({ showToast, onSettingsChanged }) => {
  const [settings, setSettings] = useState(loadSettings);
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<ConnectionValidationResult | null>(null);
  const [isSyncingVocab, setIsSyncingVocab] = useState(false);
  const [vocabState, setVocabState] = useState(vocabulary.current);
  const [storage, setStorage] = useState<{ scans: number; ledger: number; photos: number } | null>(null);
  const [showDangerModal, setShowDangerModal] = useState(false);
  const [dangerConfirmChecked, setDangerConfirmChecked] = useState(false);

  const isConfigured = hasCredentials(settings);

  useEffect(() => vocabulary.subscribe(setVocabState), []);

  const refreshStorage = async () => {
    const [scans, ledger] = await Promise.all([ScanDao.getAllScans(), LedgerDao.getAllLedgerHistory()]);
    const photos = scans.reduce((n, s) => n + s.photos.length, 0) + ledger.reduce((n, l) => n + l.photos.length, 0);
    setStorage({ scans: scans.length, ledger: ledger.length, photos });
  };

  useEffect(() => {
    void refreshStorage();
  }, []);

  const change = <K extends keyof AppSettingsData>(key: K, value: AppSettingsData[K]) => {
    // Changing a credential invalidates the token minted from the old one.
    const invalidates = key === 'userId' || key === 'devicePassword' || key === 'serverUrl';
    const updated = saveSettings(invalidates ? { [key]: value, sessionToken: undefined } : { [key]: value });
    setSettings(updated);
    onSettingsChanged?.();
  };

  const handleTestConnection = async () => {
    setIsValidating(true);
    setValidationResult(null);
    try {
      const result = await VisionApiService.testConnectionAndAuth();
      setValidationResult(result);
      if (result.isSuccessful) {
        showToast('success', 'Server reachable and credentials accepted.', 'Connection Verified');
        onSettingsChanged?.();
        void vocabulary.refreshFromServer();
      } else {
        showToast('warning', result.errorMessage || 'Connection test failed.', 'Validation Notice');
      }
    } catch (err) {
      showToast('error', (err as Error).message || 'Test failed', 'Error');
    } finally {
      setIsValidating(false);
    }
  };

  const handleSignOut = () => {
    const updated = signOut();
    setSettings(updated);
    setValidationResult(null);
    onSettingsChanged?.();
    showToast('info', 'Signed out. Local scans and the ledger are untouched.', 'Signed Out');
  };

  const handleVocabSync = async () => {
    setIsSyncingVocab(true);
    try {
      const result = await vocabulary.refreshFromServer();
      if (result.status === 'updated') {
        showToast('success', `Vocabulary updated to version ${result.version}.`, 'Reference Tables');
      } else if (result.status === 'unchanged') {
        showToast('info', 'Vocabulary is already current.', 'Reference Tables');
      } else {
        // Not an error the operator must act on: a stale vocabulary is explicitly
        // acceptable, and the bundled tables are complete.
        showToast('warning', `${result.message} Using the tables bundled with the app.`, 'Reference Tables');
      }
    } finally {
      setIsSyncingVocab(false);
    }
  };

  /**
   * Photos held by scans that were confirmed into the ledger. The ledger keeps its own
   * copy, and the server keeps its own regardless (contract section 7), so these are
   * duplicates the device does not need.
   */
  const handlePurgeUnusedPhotos = async () => {
    const scans = await ScanDao.getAllScans();
    const spent = scans.filter((s) => s.status === 2 && s.photos.length > 0);
    if (spent.length === 0) {
      showToast('info', 'No unused photos to purge.', 'Storage');
      return;
    }
    const freed = spent.reduce((n, s) => n + s.photos.length, 0);
    await db.transaction('rw', db.scans, async () => {
      for (const scan of spent) await db.scans.update(scan.apparelId, { photos: [] });
    });
    await refreshStorage();
    showToast('success', `Released ${freed} photo(s) from ${spent.length} confirmed scan(s).`, 'Storage Reclaimed');
  };

  const handlePurgeAllData = async () => {
    if (!dangerConfirmChecked) return;
    try {
      await ScanDao.clearAllScans();
      await LedgerDao.clearAllLedger();
      await vocabulary.resetToBundle();
      setShowDangerModal(false);
      setDangerConfirmChecked(false);
      await refreshStorage();
      showToast('success', 'All local scans, photos and ledger records purged.', 'Storage Reset');
    } catch (err) {
      showToast('error', (err as Error).message || 'Purge failed', 'Error');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-[0.75rem] font-semibold uppercase tracking-wider text-cocoa-600">
          Preferences &amp; storage
        </div>
        <h1 className="text-[1.1rem] font-semibold text-navy-900">Device Settings</h1>
      </div>

      {!isConfigured && (
        <div className="p-3.5 rounded-[var(--radius-container)] bg-gold-100 border border-gold-500 text-[0.82rem] text-navy-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 text-[color:var(--color-warning)] flex-shrink-0" />
          <span>
            Enter the operator username, password and server address below, then test the connection. Scanning
            unlocks once the device is signed in.
          </span>
        </div>
      )}

      {/* 1. User name · 2. Password · 3. Server URL · 4. Test connection · 5. Sign out */}
      <Section icon={<Server className="w-4 h-4" />} title="Middleware &amp; Authentication">
        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="settings-username">
            User Name
          </label>
          <input
            id="settings-username"
            type="text"
            autoComplete="username"
            value={settings.userId}
            onChange={(e) => change('userId', e.target.value)}
            placeholder="operator id, e.g. emp_402"
            className={fieldClass}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="settings-password">
            Password
          </label>
          <input
            id="settings-password"
            type="password"
            autoComplete="current-password"
            value={settings.devicePassword}
            onChange={(e) => change('devicePassword', e.target.value)}
            className={fieldClass}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="settings-server">
            Server URL
          </label>
          <input
            id="settings-server"
            type="url"
            inputMode="url"
            value={settings.serverUrl}
            onChange={(e) => change('serverUrl', e.target.value)}
            placeholder="https://dev.outfit.am"
            className={`${fieldClass} font-mono`}
          />
        </div>

        {validationResult && (
          <div
            className={`p-3 rounded-[var(--radius-control)] border flex flex-col gap-1 text-[0.75rem] ${
              validationResult.isSuccessful
                ? 'bg-cream-50 border-[color:var(--color-good)] text-[color:var(--color-good)]'
                : 'bg-cream-50 border-[color:var(--color-critical)] text-[color:var(--color-critical)]'
            }`}
          >
            <div className="flex items-center gap-1.5 font-semibold">
              {validationResult.isSuccessful ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : (
                <AlertTriangle className="w-4 h-4" />
              )}
              <span>{validationResult.isSuccessful ? 'Connection verified' : 'Validation notice'}</span>
            </div>
            {validationResult.errorMessage && <div>{validationResult.errorMessage}</div>}
            {validationResult.isHealthOk && (
              <div className="text-navy-800">
                Server {validationResult.serverVersion ?? 'unknown'} · contract{' '}
                {validationResult.apiContract ?? 'pre-1.3'} · Gemini{' '}
                {validationResult.geminiReady ? 'ready' : 'unavailable'}
              </div>
            )}
            {validationResult.contractWarning && (
              <div className="text-[color:var(--color-warning)]">{validationResult.contractWarning}</div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={handleTestConnection}
          disabled={isValidating}
          className="flex items-center justify-center gap-2 px-4 min-h-[44px] rounded-[var(--radius-control)] bg-navy-800 text-cream-50 font-semibold text-[0.82rem] transition-colors duration-[var(--motion-fast)] hover:bg-navy-700 active:bg-navy-950 disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`w-4 h-4 ${isValidating ? 'animate-spin' : ''}`} />
          <span>{isValidating ? 'Testing…' : 'Test Connection'}</span>
        </button>

        <button
          type="button"
          onClick={handleSignOut}
          disabled={!settings.sessionToken && !settings.devicePassword}
          className="flex items-center justify-center gap-2 px-4 min-h-[44px] rounded-[var(--radius-control)] bg-cream-50 border border-cocoa-200 text-navy-800 font-semibold text-[0.82rem] transition-colors duration-[var(--motion-fast)] hover:bg-cream-200 disabled:opacity-40 cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
          <span>Sign Out</span>
        </button>
      </Section>

      {/* 6. Auto Sync Vision AI · 7. Default start screen */}
      <Section icon={<Sliders className="w-4 h-4" />} title="Workflow">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-[0.88rem] font-medium text-navy-900">Auto Sync Vision AI</span>
            <span className="text-[0.75rem] text-cocoa-600">
              Submit captured scans to the middleware in the background
            </span>
          </div>
          <input
            type="checkbox"
            checked={settings.autoSyncAiVision}
            onChange={(e) => change('autoSyncAiVision', e.target.checked)}
            className="w-5 h-5 accent-[color:var(--color-navy-800)] cursor-pointer flex-shrink-0"
          />
        </div>

        <div className="flex items-center justify-between gap-3 pt-3 border-t border-cocoa-100">
          <div className="flex flex-col">
            <span className="text-[0.88rem] font-medium text-navy-900">
              Require all fields complete to Export
            </span>
            <span className="text-[0.75rem] text-cocoa-600">
              On blocks the export while any required column is blank; Off warns and exports anyway
            </span>
          </div>
          <input
            type="checkbox"
            checked={settings.requireCompleteForExport}
            onChange={(e) => change('requireCompleteForExport', e.target.checked)}
            className="w-5 h-5 accent-[color:var(--color-navy-800)] cursor-pointer flex-shrink-0"
          />
        </div>

        <div className="flex flex-col gap-1.5 pt-3 border-t border-cocoa-100">
          <label className={labelClass} htmlFor="settings-start">
            Default Start Screen
          </label>
          <select
            id="settings-start"
            value={settings.defaultStartDestination}
            onChange={(e) => change('defaultStartDestination', e.target.value as AppSettingsData['defaultStartDestination'])}
            className={fieldClass}
          >
            <option value="capture">Intake — barcode &amp; camera</option>
            <option value="review">Review — verify extractions</option>
            <option value="ledger">Ledger — daily audit</option>
            <option value="settings">Settings</option>
          </select>
        </div>
      </Section>

      {/* 8. Reference Vocabulary sync */}
      <Section icon={<BookOpen className="w-4 h-4" />} title="Reference Vocabulary">
        <p className="text-[0.82rem] text-cocoa-600">
          Brand, SubCategory, Country, Material, Colour, Gender and Season come from the server and grow as a
          supervisor adds rows. The app ships with a complete copy so it works before it has ever reached the
          server.
        </p>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[0.75rem] p-3 rounded-[var(--radius-control)] bg-cream-200">
          <span className="text-cocoa-600">Source</span>
          <span className="text-right text-navy-800 font-medium">
            {vocabState.origin === 'server' ? 'Server' : 'Bundled with app'}
          </span>
          <span className="text-cocoa-600">Version</span>
          <span className="text-right font-mono text-navy-800">{vocabState.version}</span>
          <span className="text-cocoa-600">Entries</span>
          <span className="text-right text-navy-800">
            {Object.values(vocabState.tables).reduce((n, t) => n + t.entries.length, 0)}
          </span>
        </div>

        <button
          type="button"
          onClick={handleVocabSync}
          disabled={isSyncingVocab || !isConfigured}
          className="flex items-center justify-center gap-2 px-4 min-h-[44px] rounded-[var(--radius-control)] bg-cream-50 border border-cocoa-200 text-navy-800 font-semibold text-[0.82rem] transition-colors duration-[var(--motion-fast)] hover:bg-cream-200 disabled:opacity-40 cursor-pointer"
        >
          <RefreshCw className={`w-4 h-4 ${isSyncingVocab ? 'animate-spin' : ''}`} />
          <span>{isSyncingVocab ? 'Syncing…' : 'Sync Reference Vocabulary'}</span>
        </button>
      </Section>

      {/* 9. Storage & unused photo purge */}
      <Section icon={<HardDrive className="w-4 h-4" />} title="Storage">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[0.75rem] p-3 rounded-[var(--radius-control)] bg-cream-200">
          <span className="text-cocoa-600">Scans held</span>
          <span className="text-right text-navy-800">{storage?.scans ?? '—'}</span>
          <span className="text-cocoa-600">Ledger records</span>
          <span className="text-right text-navy-800">{storage?.ledger ?? '—'}</span>
          <span className="text-cocoa-600">Photos on device</span>
          <span className="text-right text-navy-800">{storage?.photos ?? '—'}</span>
        </div>

        <p className="text-[0.82rem] text-cocoa-600">
          Photos belonging to scans already confirmed into the ledger are duplicates — the ledger holds its own
          copy and the server keeps one regardless.
        </p>

        <button
          type="button"
          onClick={handlePurgeUnusedPhotos}
          className="flex items-center justify-center gap-2 px-4 min-h-[44px] rounded-[var(--radius-control)] bg-cream-50 border border-cocoa-200 text-navy-800 font-semibold text-[0.82rem] transition-colors duration-[var(--motion-fast)] hover:bg-cream-200 cursor-pointer"
        >
          <Trash2 className="w-4 h-4" />
          <span>Purge Unused Photos</span>
        </button>
      </Section>

      {/* 10. Danger zone */}
      <Section icon={<ShieldAlert className="w-4 h-4" />} title="Danger Zone" tone="danger">
        <p className="text-[0.82rem] text-cocoa-600">
          Export every outstanding CSV batch before resetting. This permanently erases all local scans, photos
          and ledger history on this device.
        </p>
        <button
          type="button"
          onClick={() => setShowDangerModal(true)}
          className="flex items-center justify-center gap-2 px-4 min-h-[44px] rounded-[var(--radius-control)] bg-cream-50 border border-cocoa-200 text-[color:var(--color-critical)] font-semibold text-[0.82rem] transition-colors duration-[var(--motion-fast)] hover:bg-cream-200 cursor-pointer"
        >
          <Trash2 className="w-4 h-4" />
          <span>Purge All Records &amp; Photos</span>
        </button>
      </Section>

      {showDangerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy-950/50">
          <div className="bg-cream-50 border border-cocoa-200 rounded-[var(--radius-modal)] w-full max-w-md p-5 flex flex-col gap-4 shadow-[var(--shadow-overlay)]">
            <div className="flex items-center gap-3 text-[color:var(--color-critical)]">
              <ShieldAlert className="w-7 h-7 flex-shrink-0" />
              <div>
                <h3 className="text-[1.1rem] font-semibold">Confirm permanent reset</h3>
                <div className="text-[0.75rem]">This cannot be undone</div>
              </div>
            </div>

            <p className="text-[0.82rem] text-cocoa-600">
              Every intake photo, pending vision queue entry, verified scan and past ledger archive on this
              device will be erased.
            </p>

            <label className="flex items-center gap-2.5 p-3 rounded-[var(--radius-control)] bg-cream-200 text-[0.82rem] text-navy-800 cursor-pointer">
              <input
                type="checkbox"
                checked={dangerConfirmChecked}
                onChange={(e) => setDangerConfirmChecked(e.target.checked)}
                className="w-4 h-4 accent-[color:var(--color-critical)] cursor-pointer"
              />
              <span>I understand all local data will be permanently destroyed.</span>
            </label>

            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowDangerModal(false);
                  setDangerConfirmChecked(false);
                }}
                className="px-4 min-h-[44px] rounded-[var(--radius-control)] border border-cocoa-200 text-navy-800 font-semibold text-[0.82rem] hover:bg-cream-200 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!dangerConfirmChecked}
                onClick={handlePurgeAllData}
                className="px-4 min-h-[44px] rounded-[var(--radius-control)] bg-[color:var(--color-critical)] text-cream-50 font-semibold text-[0.82rem] disabled:opacity-40 cursor-pointer"
              >
                Delete Everything
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
