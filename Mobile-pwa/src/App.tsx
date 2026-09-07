import React, { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Camera, Layers, Settings as SettingsIcon, ShieldCheck, User, Wifi, WifiOff } from 'lucide-react';
import { CaptureScreen } from './screens/CaptureScreen';
import { ReviewScreen } from './screens/ReviewScreen';
import { DailyLedgerScreen } from './screens/DailyLedgerScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { ToastContainer, type ToastMessage } from './components/Toast';
import { syncEngine } from './services/syncEngine';
import { LedgerDao, ScanDao } from './data/db';
import { hasCredentials, loadSettings } from './data/settingsStorage';
import { vocabulary } from './data/vocabulary';

export type ScreenType = 'capture' | 'review' | 'ledger' | 'settings';

export type ShowToast = (
  type: 'success' | 'warning' | 'error' | 'info',
  message: string,
  title?: string
) => void;

/** Left to right: Intake, Review, Ledger, Settings (client decision 15). */
const TABS: Array<{ id: ScreenType; label: string; Icon: typeof Camera }> = [
  { id: 'capture', label: 'Intake', Icon: Camera },
  { id: 'review', label: 'Review', Icon: ShieldCheck },
  { id: 'ledger', label: 'Ledger', Icon: Layers },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon }
];

export const App: React.FC = () => {
  const [settings, setSettings] = useState(loadSettings);
  const isConfigured = hasCredentials(settings);

  // An unconfigured device opens on Settings and stays there. No warning dialog to
  // dismiss and no anonymous path (client decisions 9 and 10) - the operator simply
  // lands where the missing values are entered.
  const [currentScreen, setCurrentScreen] = useState<ScreenType>(() =>
    hasCredentials(settings) ? settings.defaultStartDestination : 'settings'
  );
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isServerOnline, setIsServerOnline] = useState(true);

  const readyReviewCount = useLiveQuery(() => ScanDao.getUnverifiedScans(), [])?.length ?? 0;
  const activeLedgerCount = useLiveQuery(() => LedgerDao.getActiveLedger(), [])?.length ?? 0;

  useEffect(() => {
    void vocabulary.hydrateFromCache();
  }, []);

  useEffect(() => {
    if (!isConfigured) return;
    syncEngine.start();
    const unsubscribe = syncEngine.subscribe(() => setIsServerOnline(syncEngine.isServerReachable));
    // A 304 is the usual answer, so this is cheap enough to run at every start.
    void syncEngine.refreshVocabulary();
    return () => {
      unsubscribe();
      syncEngine.stop();
    };
  }, [isConfigured]);

  const showToast: ShowToast = useCallback((type, message, title) => {
    const toast: ToastMessage = { id: `${Date.now()}_${Math.random()}`, type, message, title };
    setToasts((prev) => [...prev, toast]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toast.id)), 4500);
  }, []);

  const handleSettingsChanged = useCallback(() => setSettings(loadSettings()), []);

  const handleNavigate = (screen: ScreenType) => {
    if (!isConfigured && screen !== 'settings') {
      showToast('info', 'Enter a server, username and password to start scanning.', 'Setup Required');
      return;
    }
    setCurrentScreen(screen);
  };

  const badgeFor = (id: ScreenType) =>
    id === 'review' ? readyReviewCount : id === 'ledger' ? activeLedgerCount : 0;

  return (
    <div className="flex flex-col min-h-screen bg-cream-100 text-navy-800 antialiased">
      <ToastContainer toasts={toasts} onDismiss={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />

      {/* Brand bar. Pads itself out of the notch rather than relying on body padding,
          which fixed and sticky chrome does not inherit. */}
      <header className="sticky top-0 z-40 safe-top safe-x bg-navy-900 border-b border-navy-700">
        <div className="px-4 py-2.5 sm:px-6 flex items-center justify-between min-h-[56px]">
          <div className="flex items-baseline gap-2">
            <span className="text-cream-50 font-semibold tracking-tight">OutFit</span>
            <span className="text-[0.82rem] text-[color:var(--color-gold-wordmark)]">Label Reader</span>
          </div>

          <div className="flex items-center gap-2">
            <div
              className={`flex items-center gap-1 px-2 py-1 rounded-[var(--radius-control)] text-[0.75rem] ${
                isServerOnline ? 'text-cream-300' : 'text-[color:var(--color-gold-wordmark)]'
              }`}
            >
              {isServerOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{isServerOnline ? 'online' : `offline · queue ${readyReviewCount + activeLedgerCount}`}</span>
            </div>

            {settings.userId && (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-control)] bg-navy-800 text-[0.75rem] text-cream-300">
                <User className="w-3 h-3" />
                <span className="truncate max-w-[90px]">{settings.userId}</span>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-3xl mx-auto px-3.5 py-4 sm:px-6 safe-x pb-safe-nav">
        {currentScreen === 'capture' && (
          <CaptureScreen onScanSaved={() => setCurrentScreen('review')} showToast={showToast} />
        )}
        {currentScreen === 'review' && (
          <ReviewScreen onNavigateToCapture={() => setCurrentScreen('capture')} showToast={showToast} />
        )}
        {currentScreen === 'ledger' && (
          <DailyLedgerScreen onNavigateToCapture={() => setCurrentScreen('capture')} showToast={showToast} />
        )}
        {currentScreen === 'settings' && (
          <SettingsScreen showToast={showToast} onSettingsChanged={handleSettingsChanged} />
        )}
      </main>

      {/* Tab bar: 56px, sits at the foot of the layout and pads itself clear of the
          home indicator so a scrolled screen never collides with it. */}
      <nav className="fixed bottom-0 inset-x-0 z-40 safe-bottom safe-x bg-cream-50 border-t border-cocoa-200">
        <div className="flex items-stretch justify-around h-[56px]">
          {TABS.map(({ id, label, Icon }) => {
            const isActive = currentScreen === id;
            const isLocked = !isConfigured && id !== 'settings';
            const badge = badgeFor(id);

            return (
              <button
                key={id}
                type="button"
                onClick={() => handleNavigate(id)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative flex-1 min-h-[44px] flex flex-col items-center justify-center gap-0.5 transition-colors duration-[var(--motion-fast)] ${
                  isActive ? 'bg-gold-100 text-navy-900' : 'text-cocoa-600 active:bg-cream-200'
                } ${isLocked ? 'opacity-40' : 'cursor-pointer'}`}
              >
                {isActive && <span className="absolute top-0 inset-x-0 h-0.5 bg-gold-500" />}
                <div className="relative">
                  <Icon className="w-5 h-5" />
                  {badge > 0 && (
                    <span className="absolute -top-1.5 -right-2.5 min-w-[16px] px-1 rounded-full bg-navy-800 text-cream-50 text-[10px] font-semibold text-center">
                      {badge}
                    </span>
                  )}
                </div>
                <span className="text-[0.75rem]">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
};
