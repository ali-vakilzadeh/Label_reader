import React, { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ShieldCheck,
  Camera,
  Layers,
  Settings as SettingsIcon,
  Wifi,
  WifiOff,
  User,
  Sparkles
} from 'lucide-react';
import { CaptureScreen } from './screens/CaptureScreen';
import { ReviewScreen } from './screens/ReviewScreen';
import { DailyLedgerScreen } from './screens/DailyLedgerScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { ToastContainer, type ToastMessage } from './components/Toast';
import { syncEngine } from './services/syncEngine';
import { ScanDao, LedgerDao } from './data/db';
import { loadSettings } from './data/settingsStorage';

export type ScreenType = 'review' | 'capture' | 'ledger' | 'settings';

export const App: React.FC = () => {
  const settings = loadSettings();
  const [currentScreen, setCurrentScreen] = useState<ScreenType>(settings.defaultStartDestination || 'review');
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isServerOnline, setIsServerOnline] = useState(true);

  // Live badge counts
  const readyReviewCount = useLiveQuery(() => ScanDao.getUnverifiedScans(), [])?.length || 0;
  const activeLedgerCount = useLiveQuery(() => LedgerDao.getActiveLedger(), [])?.length || 0;

  // Initialize Sync Engine
  useEffect(() => {
    syncEngine.start();
    const unsubscribe = syncEngine.subscribe(() => {
      setIsServerOnline(syncEngine.isServerReachable);
    });
    return () => {
      unsubscribe();
      syncEngine.stop();
    };
  }, []);

  const showToast = (
    type: 'success' | 'warning' | 'error' | 'info',
    message: string,
    title?: string
  ) => {
    const newToast: ToastMessage = {
      id: `${Date.now()}_${Math.random()}`,
      type,
      message,
      title
    };
    setToasts((prev) => [...prev, newToast]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== newToast.id));
    }, 4500);
  };

  const handleDismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <div className="flex flex-col min-h-screen bg-[#FBF6EC] text-[#2A1D14] antialiased">
      {/* Global Floating Toast Notifications */}
      <ToastContainer toasts={toasts} onDismiss={handleDismissToast} />

      {/* Top Application Bar */}
      <header className="sticky top-0 z-40 bg-[#FFFDF9]/95 backdrop-blur-md border-b border-[#E6D8C1] px-4 py-3 sm:px-6 flex items-center justify-between shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-2xl bg-[#86611F] text-white flex items-center justify-center font-black text-base shadow-sm">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-widest text-[#86611F]">
              ENTERPRISE PWA • v1.2
            </div>
            <div className="text-base font-black text-[#2A1D14] leading-tight">
              Label Reader
            </div>
          </div>
        </div>

        {/* Status Indicators */}
        <div className="flex items-center gap-2">
          {/* Server Connection Status */}
          <div
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold border transition-colors ${
              isServerOnline
                ? 'bg-[#DCFCE7] text-[#166534] border-green-300'
                : 'bg-[#FCEFE6] text-[#B4531B] border-[#F0CBAF]'
            }`}
          >
            {isServerOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{isServerOnline ? 'Server Connected' : 'Offline / Retrying'}</span>
          </div>

          {/* User Badge */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#F4EADA] border border-[#E6D8C1] text-[11px] font-bold text-[#6B5442]">
            <User className="w-3 h-3 text-[#86611F]" />
            <span className="truncate max-w-[80px] sm:max-w-[120px]">{settings.userId}</span>
          </div>
        </div>
      </header>

      {/* Main Screen Container */}
      <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-5 sm:px-6">
        {currentScreen === 'capture' && (
          <CaptureScreen
            onScanSaved={() => setCurrentScreen('review')}
            showToast={showToast}
          />
        )}
        {currentScreen === 'review' && (
          <ReviewScreen
            onNavigateToCapture={() => setCurrentScreen('capture')}
            showToast={showToast}
          />
        )}
        {currentScreen === 'ledger' && (
          <DailyLedgerScreen
            onNavigateToCapture={() => setCurrentScreen('capture')}
            showToast={showToast}
          />
        )}
        {currentScreen === 'settings' && (
          <SettingsScreen showToast={showToast} />
        )}
      </main>

      {/* Bottom Navigation Bar */}
      <nav className="fixed bottom-0 inset-x-0 z-40 bg-[#FFFDF9]/95 backdrop-blur-lg border-t border-[#E6D8C1] py-2 px-4 flex items-center justify-around shadow-lg">
        {/* 1. Review Workspace */}
        <button
          type="button"
          onClick={() => setCurrentScreen('review')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all cursor-pointer relative ${
            currentScreen === 'review'
              ? 'text-[#86611F] font-bold'
              : 'text-[#7D6650] hover:text-[#2A1D14]'
          }`}
        >
          <div className="relative">
            <ShieldCheck className={`w-5 h-5 ${currentScreen === 'review' ? 'stroke-[2.5]' : ''}`} />
            {readyReviewCount > 0 && (
              <span className="absolute -top-1.5 -right-2.5 bg-[#B4531B] text-white text-[10px] font-extrabold px-1.5 py-0.2 rounded-full shadow-sm">
                {readyReviewCount}
              </span>
            )}
          </div>
          <span className="text-[10px] tracking-tight">Review</span>
        </button>

        {/* 2. Intake Camera (Prominent Center) */}
        <button
          type="button"
          onClick={() => setCurrentScreen('capture')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all cursor-pointer ${
            currentScreen === 'capture'
              ? 'text-[#86611F] font-bold'
              : 'text-[#7D6650] hover:text-[#2A1D14]'
          }`}
        >
          <div className={`p-2 rounded-2xl ${currentScreen === 'capture' ? 'bg-[#86611F] text-white shadow-md' : 'bg-[#F4EADA] text-[#86611F]'}`}>
            <Camera className="w-5 h-5" />
          </div>
          <span className="text-[10px] tracking-tight">Intake</span>
        </button>

        {/* 3. Daily Ledger */}
        <button
          type="button"
          onClick={() => setCurrentScreen('ledger')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all cursor-pointer relative ${
            currentScreen === 'ledger'
              ? 'text-[#86611F] font-bold'
              : 'text-[#7D6650] hover:text-[#2A1D14]'
          }`}
        >
          <div className="relative">
            <Layers className={`w-5 h-5 ${currentScreen === 'ledger' ? 'stroke-[2.5]' : ''}`} />
            {activeLedgerCount > 0 && (
              <span className="absolute -top-1.5 -right-2.5 bg-[#86611F] text-white text-[10px] font-extrabold px-1.5 py-0.2 rounded-full shadow-sm">
                {activeLedgerCount}
              </span>
            )}
          </div>
          <span className="text-[10px] tracking-tight">Ledger</span>
        </button>

        {/* 4. Settings */}
        <button
          type="button"
          onClick={() => setCurrentScreen('settings')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all cursor-pointer ${
            currentScreen === 'settings'
              ? 'text-[#86611F] font-bold'
              : 'text-[#7D6650] hover:text-[#2A1D14]'
          }`}
        >
          <SettingsIcon className={`w-5 h-5 ${currentScreen === 'settings' ? 'stroke-[2.5]' : ''}`} />
          <span className="text-[10px] tracking-tight">Settings</span>
        </button>
      </nav>
    </div>
  );
};
