import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ShieldCheck,
  Clock,
  AlertTriangle,
  RefreshCw,
  Trash2,
  Edit3,
  Camera,
  Sparkles,
  ArrowRight
} from 'lucide-react';
import { ScanDao, LedgerDao } from '../data/db';
import { syncEngine } from '../services/syncEngine';
import { ReviewDetailModal } from '../components/ReviewDetailModal';
import type { ScanEntity } from '../types/models';

interface ReviewScreenProps {
  onNavigateToCapture: () => void;
  showToast: (type: 'success' | 'warning' | 'error' | 'info', message: string, title?: string) => void;
}

export const ReviewScreen: React.FC<ReviewScreenProps> = ({ onNavigateToCapture, showToast }) => {
  const [activeTab, setActiveTab] = useState<'ready' | 'queue'>('ready');
  const [selectedScanForReview, setSelectedScanForReview] = useState<ScanEntity | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  // Live queries for extracted scans and queue items
  const readyScans = useLiveQuery(() => ScanDao.getUnverifiedScans(), []) || [];
  const queueScans = useLiveQuery(() => ScanDao.getPendingAndFailedScans(), []) || [];

  const handleSyncAll = async () => {
    setIsSyncing(true);
    try {
      await syncEngine.triggerManualSync();
      showToast('info', 'Synchronization cycle triggered.', 'Sync Queue');
    } catch (err) {
      showToast('error', (err as Error).message || 'Sync failed', 'Sync Error');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleDeleteScan = async (apparelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`Delete scan for garment "${apparelId}"?`)) {
      await ScanDao.deleteScan(apparelId);
      showToast('info', `Scan ${apparelId} deleted.`, 'Deleted');
    }
  };

  const handleRetryScan = async (scan: ScanEntity, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await syncEngine.submitScan(scan);
      showToast('info', `Re-submitting ${scan.apparelId} to AI extraction...`, 'Retry Triggered');
    } catch (err) {
      showToast('error', (err as Error).message || 'Retry failed', 'Error');
    }
  };

  const handleSaveVerified = async (
    scan: ScanEntity,
    verifiedData: {
      category: string;
      subCategory: string;
      gender: string;
      season: string;
      brandName: string;
      countryOfOrigin: string;
      size: string;
      color: string;
      material: string;
      originalPrice: string;
      netto: string;
      brutto: string;
    }
  ) => {
    const today = new Date().toISOString().split('T')[0];

    await LedgerDao.insertLedgerItem({
      apparelId: scan.apparelId,
      userId: scan.userId,
      timestamp: Date.now(),
      createdDate: today,
      category: verifiedData.category,
      subCategory: verifiedData.subCategory,
      gender: verifiedData.gender,
      season: verifiedData.season,
      brandName: verifiedData.brandName,
      countryOfOrigin: verifiedData.countryOfOrigin,
      size: verifiedData.size,
      color: verifiedData.color,
      material: verifiedData.material,
      originalPrice: verifiedData.originalPrice,
      netto: verifiedData.netto,
      brutto: verifiedData.brutto,
      photos: scan.photos,
      keyPhotoIndex: scan.keyPhotoIndex,
      isVerified: true,
      editedByUser: true,
      syncStatus: 'LOCAL_ONLY',
      submittedToCsv: false
    });

    // Mark scan as verified
    await ScanDao.updateScan({
      ...scan,
      status: 2 // VERIFIED_SAVED
    });

    showToast('success', `Item ${scan.apparelId} verified and added to Daily Ledger!`, 'Verified & Saved');
  };

  return (
    <div className="flex flex-col gap-5 pb-20">
      {/* Title & Sync Action Bar */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] font-extrabold uppercase tracking-widest text-[#86611F]">
            VERIFICATION WORKSPACE
          </div>
          <h1 className="text-xl sm:text-2xl font-black text-[#2A1D14] tracking-tight">
            Operator Extraction Review
          </h1>
        </div>

        <button
          type="button"
          onClick={handleSyncAll}
          disabled={isSyncing}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-[#FFFDF9] border border-[#E6D8C1] hover:bg-[#F4EADA] text-xs font-bold text-[#86611F] shadow-sm transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
          <span>{isSyncing ? 'Syncing...' : 'Sync Queue'}</span>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 p-1.5 rounded-2xl bg-[#F4EADA] border border-[#E6D8C1]">
        <button
          type="button"
          onClick={() => setActiveTab('ready')}
          className={`flex-1 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center gap-2 transition-all cursor-pointer ${
            activeTab === 'ready'
              ? 'bg-[#86611F] text-white shadow-md'
              : 'text-[#6B5442] hover:text-[#2A1D14]'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>Ready to Review</span>
          <span
            className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
              activeTab === 'ready' ? 'bg-white/20 text-white' : 'bg-[#E6D8C1] text-[#2A1D14]'
            }`}
          >
            {readyScans.length}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('queue')}
          className={`flex-1 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center gap-2 transition-all cursor-pointer ${
            activeTab === 'queue'
              ? 'bg-[#86611F] text-white shadow-md'
              : 'text-[#6B5442] hover:text-[#2A1D14]'
          }`}
        >
          <Clock className="w-4 h-4" />
          <span>AI Queue / Attention</span>
          <span
            className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
              activeTab === 'queue' ? 'bg-white/20 text-white' : 'bg-[#E6D8C1] text-[#2A1D14]'
            }`}
          >
            {queueScans.length}
          </span>
        </button>
      </div>

      {/* TAB 1: Ready to Review */}
      {activeTab === 'ready' && (
        <div className="flex flex-col gap-3">
          {readyScans.length === 0 ? (
            <div className="bg-[#FFFDF9] p-8 rounded-3xl border border-[#E6D8C1] text-center flex flex-col items-center justify-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-[#DCFCE7] text-[#166534] flex items-center justify-center">
                <ShieldCheck className="w-7 h-7" />
              </div>
              <h3 className="text-base font-bold text-[#2A1D14]">All Extractions Verified!</h3>
              <p className="text-xs text-[#6B5442] max-w-sm">
                There are no pending extractions awaiting operator review. Scan new garment care labels to start extracting.
              </p>
              <button
                type="button"
                onClick={onNavigateToCapture}
                className="mt-2 flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#86611F] text-white font-bold text-xs shadow-md hover:bg-[#A87C2E] transition-all cursor-pointer active:scale-95"
              >
                <Camera className="w-4 h-4" />
                <span>Capture New Garment</span>
              </button>
            </div>
          ) : (
            readyScans.map((scan) => {
              const keyPhoto = scan.photos[scan.keyPhotoIndex] || scan.photos[0];
              return (
                <div
                  key={scan.apparelId}
                  onClick={() => setSelectedScanForReview(scan)}
                  className="bg-[#FFFDF9] p-4 rounded-3xl border border-[#E6D8C1] hover:border-[#86611F] shadow-sm hover:shadow-md transition-all flex flex-col sm:flex-row items-start sm:items-center gap-4 cursor-pointer group"
                >
                  {/* Key Thumbnail */}
                  <div className="relative w-20 h-20 rounded-2xl overflow-hidden bg-[#2A1D14] flex-shrink-0 border border-[#E6D8C1]">
                    {keyPhoto ? (
                      <img src={keyPhoto} alt={scan.apparelId} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[#BF9445]">
                        <Camera className="w-6 h-6" />
                      </div>
                    )}
                    <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-[9px] font-bold text-white backdrop-blur-sm">
                      {scan.photos.length}P
                    </div>
                  </div>

                  {/* Card Content */}
                  <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-black text-sm text-[#86611F]">
                        {scan.apparelId}
                      </span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#DCFCE7] text-[#166534] flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        AI EXTRACTED
                      </span>
                    </div>

                    <div className="text-sm font-bold text-[#2A1D14] truncate">
                      {scan.extractedBrandName || 'Unknown Brand'} • {scan.extractedSubCategory || scan.extractedCategory || 'Apparel'}
                    </div>

                    <div className="flex items-center gap-2 text-xs text-[#6B5442] flex-wrap">
                      {scan.extractedSize && (
                        <span className="px-2 py-0.5 rounded-md bg-[#F4EADA] font-semibold text-[#2A1D14]">
                          Size: {scan.extractedSize}
                        </span>
                      )}
                      {scan.extractedColor && (
                        <span className="px-2 py-0.5 rounded-md bg-[#F4EADA] font-semibold text-[#2A1D14]">
                          Color: {scan.extractedColor}
                        </span>
                      )}
                      {scan.extractedOriginalPrice && (
                        <span className="px-2 py-0.5 rounded-md bg-[#F4EADA] font-semibold text-[#86611F]">
                          {scan.extractedOriginalPrice}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Right Actions */}
                  <div className="flex items-center gap-2 self-end sm:self-center">
                    <button
                      type="button"
                      onClick={(e) => handleDeleteScan(scan.apparelId, e)}
                      title="Delete Scan"
                      className="p-2.5 rounded-xl text-[#7D6650] hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <div className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#86611F] group-hover:bg-[#A87C2E] text-white font-bold text-xs transition-colors shadow-sm">
                      <span>Review</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* TAB 2: AI Queue / Attention */}
      {activeTab === 'queue' && (
        <div className="flex flex-col gap-3">
          {queueScans.length === 0 ? (
            <div className="bg-[#FFFDF9] p-8 rounded-3xl border border-[#E6D8C1] text-center flex flex-col items-center justify-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-[#F4EADA] text-[#86611F] flex items-center justify-center">
                <Clock className="w-7 h-7" />
              </div>
              <h3 className="text-base font-bold text-[#2A1D14]">Queue is Empty</h3>
              <p className="text-xs text-[#6B5442] max-w-sm">
                No items are currently waiting for background AI processing or require manual troubleshooting.
              </p>
            </div>
          ) : (
            queueScans.map((scan) => {
              const keyPhoto = scan.photos[scan.keyPhotoIndex] || scan.photos[0];
              const isNeedsAttention = scan.processingStatus === 'NEEDS_ATTENTION' || scan.status === 3;
              const isPending = scan.status === 0;

              return (
                <div
                  key={scan.apparelId}
                  className="bg-[#FFFDF9] p-4 rounded-3xl border border-[#E6D8C1] shadow-sm flex flex-col sm:flex-row items-start sm:items-center gap-4"
                >
                  {/* Thumbnail */}
                  <div className="relative w-16 h-16 rounded-2xl overflow-hidden bg-[#2A1D14] flex-shrink-0 border border-[#E6D8C1]">
                    {keyPhoto ? (
                      <img src={keyPhoto} alt={scan.apparelId} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[#BF9445]">
                        <Camera className="w-5 h-5" />
                      </div>
                    )}
                  </div>

                  {/* Card Content */}
                  <div className="flex-1 flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-black text-sm text-[#86611F]">
                        {scan.apparelId}
                      </span>

                      {isNeedsAttention ? (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#FCEFE6] text-[#B4531B] border border-[#F0CBAF] flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          NEEDS ATTENTION
                        </span>
                      ) : (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#F4EADA] text-[#6B5442] flex items-center gap-1">
                          <Clock className="w-3 h-3 text-[#86611F]" />
                          {scan.serverStored ? 'QUEUED ON SERVER' : 'LOCAL QUEUE'}
                        </span>
                      )}
                    </div>

                    <div className="text-xs text-[#6B5442]">
                      {scan.errorMessage || scan.attentionReason || (
                        isPending ? 'Waiting for Gemini Vision extraction...' : 'Extraction pending'
                      )}
                    </div>

                    {scan.queueDepth > 0 && (
                      <div className="text-[11px] text-[#7D6650]">
                        Queue Depth: {scan.queueDepth} • Est. wait: {scan.estimatedWaitSeconds || 10}s
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 self-end sm:self-center">
                    <button
                      type="button"
                      onClick={(e) => handleRetryScan(scan, e)}
                      title="Retry Extraction"
                      className="p-2.5 rounded-xl bg-[#F4EADA] hover:bg-[#E6D8C1] text-[#86611F] text-xs font-bold flex items-center gap-1 transition-colors cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Retry</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setSelectedScanForReview(scan)}
                      className="px-3.5 py-2.5 rounded-xl bg-[#86611F] hover:bg-[#A87C2E] text-white text-xs font-bold flex items-center gap-1.5 transition-colors shadow-sm cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>Manual Entry</span>
                    </button>

                    <button
                      type="button"
                      onClick={(e) => handleDeleteScan(scan.apparelId, e)}
                      className="p-2.5 rounded-xl text-[#7D6650] hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
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

      {/* Review Detail Modal */}
      {selectedScanForReview && (
        <ReviewDetailModal
          scan={selectedScanForReview}
          onClose={() => setSelectedScanForReview(null)}
          onSave={handleSaveVerified}
        />
      )}
    </div>
  );
};
