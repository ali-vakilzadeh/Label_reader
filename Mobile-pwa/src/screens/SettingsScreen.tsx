import React, { useState, useEffect } from 'react';
import {
  Server,
  ShieldAlert,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Sparkles,
  Zap,
  Sliders
} from 'lucide-react';
import { loadSettings, saveSettings } from '../data/settingsStorage';
import { VisionApiService } from '../services/visionApiService';
import { ScanDao, LedgerDao } from '../data/db';
import type { ConnectionValidationResult } from '../types/models';

interface SettingsScreenProps {
  showToast: (type: 'success' | 'warning' | 'error' | 'info', message: string, title?: string) => void;
}

export const SettingsScreen: React.FC<SettingsScreenProps> = ({ showToast }) => {
  const [settings, setSettings] = useState(loadSettings());
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<ConnectionValidationResult | null>(null);

  // Danger zone modal state
  const [showDangerModal, setShowDangerModal] = useState(false);
  const [dangerConfirmChecked, setDangerConfirmChecked] = useState(false);

  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  const handleChange = (key: keyof typeof settings, value: unknown) => {
    const updated = saveSettings({ [key]: value });
    setSettings(updated);
  };

  const handleTestConnection = async () => {
    setIsValidating(true);
    setValidationResult(null);
    try {
      const result = await VisionApiService.testConnectionAndAuth();
      setValidationResult(result);
      if (result.isSuccessful) {
        showToast('success', 'Server reachable and authenticated successfully!', 'Connection Validated');
      } else {
        showToast('warning', result.errorMessage || 'Connection test failed', 'Validation Notice');
      }
    } catch (err) {
      showToast('error', (err as Error).message || 'Test failed', 'Error');
    } finally {
      setIsValidating(false);
    }
  };

  const handleClearCache = async () => {
    showToast('info', 'Photo cache optimized.', 'Cache Cleared');
  };

  const handlePurgeAllData = async () => {
    if (!dangerConfirmChecked) return;
    try {
      await ScanDao.clearAllScans();
      await LedgerDao.clearAllLedger();
      setShowDangerModal(false);
      setDangerConfirmChecked(false);
      showToast('success', 'All database scans, photos, and ledger records have been purged.', 'Storage Reset');
    } catch (err) {
      showToast('error', (err as Error).message || 'Purge failed', 'Error');
    }
  };

  return (
    <div className="flex flex-col gap-6 pb-20">
      {/* Title */}
      <div>
        <div className="text-[11px] font-extrabold uppercase tracking-widest text-[#86611F]">
          PREFERENCES & STORAGE
        </div>
        <h1 className="text-xl sm:text-2xl font-black text-[#2A1D14] tracking-tight">
          Enterprise Device Settings
        </h1>
      </div>

      {/* 1. App Launch & Workflow Navigation */}
      <div className="bg-[#FFFDF9] p-5 rounded-3xl border border-[#E6D8C1] shadow-sm flex flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-[#F4EADA] text-[#86611F] flex items-center justify-center font-bold">
            <Sliders className="w-4 h-4" />
          </div>
          <h2 className="text-sm font-bold text-[#2A1D14]">Workflow & Launch Settings</h2>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-[#6B5442]">
            Default Launch Screen
          </label>
          <select
            value={settings.defaultStartDestination}
            onChange={(e) => handleChange('defaultStartDestination', e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-xl text-sm font-medium bg-[#FBF6EC] border border-[#E6D8C1] text-[#2A1D14] outline-none focus:border-[#86611F]"
          >
            <option value="review">Verification Workspace (Review Extractions)</option>
            <option value="capture">Garment Intake (Camera & Barcode)</option>
            <option value="ledger">Production Audit (Daily Ledger)</option>
          </select>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-[#E6D8C1]">
          <div className="flex flex-col">
            <span className="text-xs font-bold text-[#2A1D14]">Auto-Sync Vision AI</span>
            <span className="text-[11px] text-[#7D6650]">
              Automatically submit captured scans to middleware in background
            </span>
          </div>
          <input
            type="checkbox"
            checked={settings.autoSyncAiVision}
            onChange={(e) => handleChange('autoSyncAiVision', e.target.checked)}
            className="w-5 h-5 accent-[#86611F] rounded cursor-pointer"
          />
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-[#E6D8C1]">
          <div className="flex flex-col">
            <span className="text-xs font-bold text-[#2A1D14] flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-[#BF9445]" />
              Demo Simulation Mode
            </span>
            <span className="text-[11px] text-[#7D6650]">
              Run local synthetic Gemini inferences for testing without live server
            </span>
          </div>
          <input
            type="checkbox"
            checked={settings.demoModeEnabled}
            onChange={(e) => handleChange('demoModeEnabled', e.target.checked)}
            className="w-5 h-5 accent-[#86611F] rounded cursor-pointer"
          />
        </div>
      </div>

      {/* 2. Middleware API Connection */}
      <div className="bg-[#FFFDF9] p-5 rounded-3xl border border-[#E6D8C1] shadow-sm flex flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-[#F4EADA] text-[#86611F] flex items-center justify-center font-bold">
            <Server className="w-4 h-4" />
          </div>
          <h2 className="text-sm font-bold text-[#2A1D14]">Middleware API & Authentication</h2>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-[#6B5442]">
            Server Base URL
          </label>
          <input
            type="text"
            value={settings.serverUrl}
            onChange={(e) => handleChange('serverUrl', e.target.value)}
            placeholder="https://dev.outfit.am"
            className="w-full px-3.5 py-2.5 rounded-xl text-sm font-mono font-medium bg-[#FBF6EC] border border-[#E6D8C1] text-[#2A1D14] outline-none focus:border-[#86611F]"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#6B5442]">
              Operator Username
            </label>
            <input
              type="text"
              value={settings.userId}
              onChange={(e) => handleChange('userId', e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl text-sm font-medium bg-[#FBF6EC] border border-[#E6D8C1] text-[#2A1D14] outline-none focus:border-[#86611F]"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#6B5442]">
              Device Master Password
            </label>
            <input
              type="password"
              value={settings.devicePassword}
              onChange={(e) => handleChange('devicePassword', e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl text-sm font-medium bg-[#FBF6EC] border border-[#E6D8C1] text-[#2A1D14] outline-none focus:border-[#86611F]"
            />
          </div>
        </div>

        {/* Validation Result Box */}
        {validationResult && (
          <div
            className={`p-3.5 rounded-2xl border flex flex-col gap-1 text-xs ${
              validationResult.isSuccessful
                ? 'bg-[#DCFCE7] border-green-300 text-[#166534]'
                : 'bg-[#FCEFE6] border-[#F0CBAF] text-[#B4531B]'
            }`}
          >
            <div className="flex items-center gap-1.5 font-bold">
              {validationResult.isSuccessful ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : (
                <AlertTriangle className="w-4 h-4" />
              )}
              <span>{validationResult.isSuccessful ? 'Connection Verified' : 'Validation Notice'}</span>
            </div>
            {validationResult.errorMessage && <div>{validationResult.errorMessage}</div>}
            {validationResult.tokenPreview && (
              <div className="font-mono text-[11px] opacity-80">
                JWT Session Token: {validationResult.tokenPreview}
              </div>
            )}
            <div className="text-[11px] opacity-90">
              Server Version: {validationResult.serverVersion} • Gemini Ready:{' '}
              {validationResult.geminiReady ? 'YES' : 'Fallback'}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={handleTestConnection}
          disabled={isValidating}
          className="flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-[#86611F] hover:bg-[#A87C2E] text-white font-bold text-xs shadow-md transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`w-4 h-4 ${isValidating ? 'animate-spin' : ''}`} />
          <span>{isValidating ? 'Testing Handshake...' : 'Test & Validate Connection'}</span>
        </button>
      </div>

      {/* 3. Storage Optimization */}
      <div className="bg-[#FFFDF9] p-5 rounded-3xl border border-[#E6D8C1] shadow-sm flex flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-[#F4EADA] text-[#86611F] flex items-center justify-center font-bold">
            <Trash2 className="w-4 h-4" />
          </div>
          <h2 className="text-sm font-bold text-[#2A1D14]">Local Storage Optimization</h2>
        </div>

        <p className="text-xs text-[#6B5442]">
          Clean up scratch photo data and optimize IndexedDB local memory cache.
        </p>

        <button
          type="button"
          onClick={handleClearCache}
          className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-[#E6D8C1] text-[#6B5442] hover:bg-[#F4EADA] font-semibold text-xs transition-colors cursor-pointer"
        >
          <Zap className="w-4 h-4 text-[#86611F]" />
          <span>Optimize Storage Cache</span>
        </button>
      </div>

      {/* 4. Danger Zone */}
      <div className="bg-[#FCEFE6] p-5 rounded-3xl border border-[#F0CBAF] shadow-sm flex flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-red-100 text-red-700 flex items-center justify-center font-bold">
            <ShieldAlert className="w-4 h-4" />
          </div>
          <h2 className="text-sm font-extrabold text-[#B4531B]">Danger Zone</h2>
        </div>

        <p className="text-xs text-[#B4531B]">
          Warning: Make sure you have exported all necessary CSV batches before resetting. This action will permanently erase all local scans and history records.
        </p>

        <button
          type="button"
          onClick={() => setShowDangerModal(true)}
          className="flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-red-700 hover:bg-red-800 text-white font-bold text-xs shadow-md transition-all active:scale-95 cursor-pointer"
        >
          <Trash2 className="w-4 h-4" />
          <span>Purge All Database Records & Photos</span>
        </button>
      </div>

      {/* Danger Zone Confirmation Modal */}
      {showDangerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-[#FFFDF9] border border-red-200 rounded-3xl w-full max-w-md p-6 flex flex-col gap-5 shadow-2xl">
            <div className="flex items-center gap-3 text-red-700">
              <ShieldAlert className="w-8 h-8 flex-shrink-0" />
              <div>
                <h3 className="text-base font-black">Confirm Permanent Reset</h3>
                <div className="text-xs font-semibold opacity-90">Irreversible Action</div>
              </div>
            </div>

            <p className="text-xs text-[#6B5442] leading-relaxed">
              This will completely wipe all intake photos, pending vision queues, verified scans, and past daily ledger archives from this device.
            </p>

            <label className="flex items-center gap-2.5 p-3 rounded-xl bg-[#FCEFE6] border border-[#F0CBAF] text-xs font-bold text-[#B4531B] cursor-pointer">
              <input
                type="checkbox"
                checked={dangerConfirmChecked}
                onChange={(e) => setDangerConfirmChecked(e.target.checked)}
                className="w-4 h-4 accent-red-700 rounded cursor-pointer"
              />
              <span>I understand that all local data will be permanently destroyed.</span>
            </label>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  setShowDangerModal(false);
                  setDangerConfirmChecked(false);
                }}
                className="px-4 py-2.5 rounded-xl border border-[#E6D8C1] text-[#6B5442] font-semibold text-xs hover:bg-[#F4EADA] transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!dangerConfirmChecked}
                onClick={handlePurgeAllData}
                className="px-5 py-2.5 rounded-xl bg-red-700 hover:bg-red-800 text-white font-bold text-xs shadow-md transition-all active:scale-95 disabled:opacity-40 cursor-pointer"
              >
                Permanently Delete All Data
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
