import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  ArrowRight,
  Camera,
  Clock,
  Edit3,
  RefreshCw,
  ShieldCheck,
  Trash2
} from 'lucide-react';
import { LedgerDao, ScanDao } from '../data/db';
import { syncEngine } from '../services/syncEngine';
import { ReviewDetailModal, type ReviewOutcome } from '../components/ReviewDetailModal';
import { useLanguage } from '../data/i18n';
import { displayValue } from '../data/vocabulary';
import type { ScanEntity } from '../types/models';
import type { ShowToast } from '../App';

interface ReviewScreenProps {
  onNavigateToCapture: () => void;
  showToast: ShowToast;
}

const cardClass =
  'bg-cream-50 p-4 rounded-[var(--radius-container)] border border-cocoa-200 shadow-[var(--shadow-card)]';
const chipClass = 'px-2 py-0.5 rounded-[var(--radius-control)] bg-cream-200 text-[0.75rem] text-navy-800';

export const ReviewScreen: React.FC<ReviewScreenProps> = ({ onNavigateToCapture, showToast }) => {
  const { language, t } = useLanguage();
  const [activeTab, setActiveTab] = useState<'ready' | 'queue'>('ready');
  const [selectedScan, setSelectedScan] = useState<ScanEntity | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const readyScans = useLiveQuery(() => ScanDao.getUnverifiedScans(), []) || [];
  const queueScans = useLiveQuery(() => ScanDao.getPendingAndFailedScans(), []) || [];
  const draftCount = readyScans.filter((s) => s.draft).length;

  const handleSyncAll = async () => {
    setIsSyncing(true);
    try {
      await syncEngine.triggerManualSync();
      showToast('info', 'Synchronisation cycle triggered.', 'Sync Queue');
    } catch (err) {
      showToast('error', (err as Error).message || 'Sync failed', 'Sync Error');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleDeleteScan = async (apparelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`Delete the scan for "${apparelId}"?`)) {
      await ScanDao.deleteScan(apparelId);
      showToast('info', `Scan ${apparelId} deleted.`, 'Deleted');
    }
  };

  const handleRetryScan = async (scan: ScanEntity, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      // Retry is the operator overriding the 4xx verdict - a clone whose parent has
      // since been uploaded is the case that matters - so the permanent mark is
      // lifted for this attempt and only reapplied if the server refuses again.
      await syncEngine.submitScan({ ...scan, permanentFailure: false });
      showToast('info', `Re-submitting ${scan.apparelId}…`, 'Retry Triggered');
    } catch (err) {
      showToast('error', (err as Error).message || 'Retry failed', 'Error');
    }
  };

  /**
   * A part-finished record stays here, keeping everything typed so far, and reaches
   * the ledger only on confirm (client decision 4). Drafts are deliberately exempt
   * from the completeness rule - being unfinished is the point.
   */
  const handleSaveDraft = async (scan: ScanEntity, outcome: ReviewOutcome) => {
    await ScanDao.updateScan({
      ...scan,
      draft: outcome.fields,
      draftSavedAt: Date.now(),
      packageCode: outcome.packageCode,
      setSize: outcome.setSize,
      keyPhotoIndex: outcome.keyPhotoIndex
    });
    showToast('info', `${scan.apparelId} saved as a draft. It stays here until you confirm it.`, t('Draft'));
  };

  const handleConfirm = async (scan: ScanEntity, outcome: ReviewOutcome) => {
    const today = new Date().toISOString().split('T')[0];

    await LedgerDao.insertLedgerItem({
      apparelId: scan.apparelId,
      userId: scan.userId,
      timestamp: Date.now(),
      createdDate: today,
      fields: outcome.fields,
      // Operator input, never sent to the server (contract section 8.5).
      packageCode: outcome.packageCode,
      setSize: outcome.setSize,
      photos: scan.photos,
      keyPhotoIndex: outcome.keyPhotoIndex,
      isVerified: true,
      editedByUser: true,
      syncStatus: 'LOCAL_ONLY',
      submittedToCsv: false
    });

    // The draft has served its purpose; clearing it keeps a re-opened record from
    // showing stale edits beside the confirmed ledger row.
    await ScanDao.updateScan({ ...scan, status: 2, draft: undefined, draftSavedAt: undefined });

    showToast('success', `${scan.apparelId} confirmed and added to the ledger.`, 'Confirmed');
  };

  const tabButton = (id: 'ready' | 'queue', label: string, count: number, Icon: typeof ShieldCheck) => (
    <button
      type="button"
      onClick={() => setActiveTab(id)}
      className={`flex-1 min-h-[44px] px-3 rounded-[var(--radius-control)] text-[0.82rem] flex items-center justify-center gap-2 transition-colors duration-[var(--motion-fast)] cursor-pointer ${
        activeTab === id ? 'bg-navy-800 text-cream-50' : 'text-cocoa-600 hover:bg-cream-50'
      }`}
    >
      <Icon className="w-4 h-4" />
      <span>{label}</span>
      <span
        className={`text-[0.75rem] px-1.5 rounded-full ${
          activeTab === id ? 'bg-navy-950 text-cream-50' : 'bg-cream-300 text-navy-800'
        }`}
      >
        {count}
      </span>
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[0.75rem] font-semibold uppercase tracking-wider text-cocoa-600">
            Verification workspace
          </div>
          <h1 className="text-[1.1rem] font-semibold text-navy-900">{t('Review')}</h1>
        </div>

        <button
          type="button"
          onClick={handleSyncAll}
          disabled={isSyncing}
          className="flex items-center gap-1.5 px-3 min-h-[44px] rounded-[var(--radius-control)] bg-cream-50 border border-cocoa-200 text-[0.82rem] text-navy-800 hover:bg-cream-200 disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
          <span>{isSyncing ? 'Syncing…' : 'Sync'}</span>
        </button>
      </div>

      {draftCount > 0 && (
        <div className="px-3 py-2 rounded-[var(--radius-container)] bg-gold-100 border border-gold-500 text-[0.82rem] text-navy-800">
          {draftCount} record{draftCount === 1 ? '' : 's'} saved as a draft — they stay here until confirmed.
        </div>
      )}

      <div className="flex items-center gap-1.5 p-1.5 rounded-[var(--radius-container)] bg-cream-200 border border-cocoa-200">
        {tabButton('ready', 'Ready', readyScans.length, ShieldCheck)}
        {tabButton('queue', 'Queue', queueScans.length, Clock)}
      </div>

      {activeTab === 'ready' && (
        <div className="flex flex-col gap-3">
          {readyScans.length === 0 ? (
            <div className={`${cardClass} text-center flex flex-col items-center gap-3 py-8`}>
              <div className="w-12 h-12 rounded-[var(--radius-container)] bg-cream-200 text-[color:var(--color-good)] flex items-center justify-center">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <h3 className="text-[0.88rem] font-semibold text-navy-900">Nothing waiting to review</h3>
              <p className="text-[0.82rem] text-cocoa-600 max-w-sm">
                Extractions appear here once the AI has read them.
              </p>
              <button
                type="button"
                onClick={onNavigateToCapture}
                className="flex items-center gap-2 px-4 min-h-[44px] rounded-[var(--radius-control)] bg-navy-800 text-cream-50 font-semibold text-[0.82rem] hover:bg-navy-700 cursor-pointer"
              >
                <Camera className="w-4 h-4" />
                <span>{t('Intake')}</span>
              </button>
            </div>
          ) : (
            readyScans.map((scan) => {
              const shown = scan.draft ?? scan.extracted;
              const keyPhoto = scan.photos[scan.keyPhotoIndex] || scan.photos[0];

              return (
                <button
                  key={scan.apparelId}
                  type="button"
                  onClick={() => setSelectedScan(scan)}
                  className={`${cardClass} flex items-center gap-3 text-left hover:border-cocoa-400 transition-colors duration-[var(--motion-fast)] cursor-pointer`}
                >
                  <div className="relative w-16 h-16 rounded-[var(--radius-control)] overflow-hidden bg-navy-900 flex-shrink-0 border border-cocoa-200">
                    {keyPhoto ? (
                      <img src={keyPhoto} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <Camera className="w-5 h-5 text-cream-300 absolute inset-0 m-auto" />
                    )}
                    <span className="absolute bottom-0.5 right-0.5 px-1 rounded bg-navy-950/70 text-[9px] text-cream-50">
                      {scan.photos.length}
                    </span>
                  </div>

                  <div className="flex-1 flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[0.82rem] text-navy-900">{scan.apparelId}</span>
                      {scan.draft ? (
                        <span className="text-[0.75rem] px-1.5 rounded bg-gold-100 text-[color:var(--color-warning)] border border-gold-500">
                          {t('Draft')}
                        </span>
                      ) : (
                        <span className="text-[0.75rem] px-1.5 rounded bg-cream-200 text-[color:var(--color-good)]">
                          AI extracted
                        </span>
                      )}
                    </div>

                    <div className="text-[0.88rem] text-navy-800 truncate">
                      {shown.brandName || 'Unknown brand'} ·{' '}
                      {displayValue(language, shown.subCategory, {
                        table: 'sub_category',
                        fromServer: scan.armenian.sub_category
                      }) ||
                        displayValue(language, shown.category, {
                          table: 'category',
                          fromServer: scan.armenian.category
                        }) ||
                        'Apparel'}
                    </div>

                    <div className="flex items-center gap-1.5 flex-wrap">
                      {shown.size && <span className={chipClass}>{shown.size}</span>}
                      {shown.color && (
                        <span className={chipClass}>
                          {displayValue(language, shown.color, {
                            table: 'color',
                            fromServer: scan.armenian.color
                          })}
                        </span>
                      )}
                      {scan.setSize > 1 && <span className={chipClass}>{t('Set of')} {scan.setSize}</span>}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <span
                      onClick={(e) => void handleDeleteScan(scan.apparelId, e)}
                      role="button"
                      tabIndex={-1}
                      aria-label={t('Delete')}
                      className="p-2 rounded-[var(--radius-control)] text-cocoa-400 hover:text-[color:var(--color-critical)] cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </span>
                    <ArrowRight className="w-4 h-4 text-cocoa-400" />
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}

      {activeTab === 'queue' && (
        <div className="flex flex-col gap-3">
          {queueScans.length === 0 ? (
            <div className={`${cardClass} text-center flex flex-col items-center gap-3 py-8`}>
              <div className="w-12 h-12 rounded-[var(--radius-container)] bg-cream-200 text-navy-800 flex items-center justify-center">
                <Clock className="w-6 h-6" />
              </div>
              <h3 className="text-[0.88rem] font-semibold text-navy-900">The queue is empty</h3>
            </div>
          ) : (
            queueScans.map((scan) => {
              const needsAttention = scan.processingStatus === 'NEEDS_ATTENTION' || scan.status === 3;

              return (
                <div key={scan.apparelId} className={`${cardClass} flex items-center gap-3`}>
                  <div className="w-14 h-14 rounded-[var(--radius-control)] overflow-hidden bg-navy-900 flex-shrink-0 border border-cocoa-200 relative">
                    {scan.photos[0] ? (
                      <img src={scan.photos[0]} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <Camera className="w-5 h-5 text-cream-300 absolute inset-0 m-auto" />
                    )}
                  </div>

                  <div className="flex-1 flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[0.82rem] text-navy-900">{scan.apparelId}</span>
                      {needsAttention ? (
                        <span className="text-[0.75rem] px-1.5 rounded bg-cream-50 text-[color:var(--color-critical)] border border-[color:var(--color-critical)] flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          Needs attention
                        </span>
                      ) : (
                        <span className="text-[0.75rem] px-1.5 rounded bg-cream-200 text-cocoa-600">
                          {scan.serverStored ? 'Queued on the server' : 'Waiting to upload'}
                        </span>
                      )}
                    </div>

                    <div className="text-[0.82rem] text-cocoa-600 line-clamp-2">
                      {scan.errorMessage || scan.attentionReason || 'Waiting for extraction…'}
                    </div>

                    {scan.queueDepth > 0 && (
                      <div className="text-[0.75rem] text-cocoa-400">
                        {scan.queueDepth} ahead
                        {scan.estimatedWaitSeconds ? ` · about ${scan.estimatedWaitSeconds}s` : ''}
                      </div>
                    )}

                    {scan.blockingFault && (
                      <div className="text-[0.75rem] text-[color:var(--color-warning)]">
                        Processing paused — contact a supervisor.
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      type="button"
                      onClick={(e) => void handleRetryScan(scan, e)}
                      aria-label={t('Retry')}
                      className="p-2.5 rounded-[var(--radius-control)] bg-cream-200 text-navy-800 hover:bg-cream-300 cursor-pointer"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedScan(scan)}
                      aria-label={t('Edit')}
                      className="p-2.5 rounded-[var(--radius-control)] bg-navy-800 text-cream-50 hover:bg-navy-700 cursor-pointer"
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => void handleDeleteScan(scan.apparelId, e)}
                      aria-label={t('Delete')}
                      className="p-2.5 rounded-[var(--radius-control)] text-cocoa-400 hover:text-[color:var(--color-critical)] cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {selectedScan && (
        <ReviewDetailModal
          scan={selectedScan}
          onClose={() => setSelectedScan(null)}
          onConfirm={handleConfirm}
          onSaveDraft={handleSaveDraft}
        />
      )}
    </div>
  );
};
