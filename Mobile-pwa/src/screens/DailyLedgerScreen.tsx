import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  FileSpreadsheet,
  CheckCircle2,
  Copy,
  Trash2,
  Archive,
  Clock,
  Layers,
  Tag,
  Camera
} from 'lucide-react';
import { LedgerDao } from '../data/db';
import { syncEngine } from '../services/syncEngine';
import { CsvCutoffDialog } from '../components/CsvCutoffDialog';
import { DuplicateModal } from '../components/DuplicateModal';
import type { DailyLedgerEntity } from '../types/models';

interface DailyLedgerScreenProps {
  onNavigateToCapture: () => void;
  showToast: (type: 'success' | 'warning' | 'error' | 'info', message: string, title?: string) => void;
}

export const DailyLedgerScreen: React.FC<DailyLedgerScreenProps> = ({
  onNavigateToCapture,
  showToast
}) => {
  const [activeTab, setActiveTab] = useState<'active' | 'history'>('active');
  const [duplicateTargetItem, setDuplicateTargetItem] = useState<DailyLedgerEntity | null>(null);

  // CSV Two-Step state
  const [csvDialogData, setCsvDialogData] = useState<{
    batchId: string;
    count: number;
    filename: string;
  } | null>(null);

  const [isExporting, setIsExporting] = useState(false);

  // Live queries
  const activeLedger = useLiveQuery(() => LedgerDao.getActiveLedger(), []) || [];
  const allLedgerHistory = useLiveQuery(() => LedgerDao.getAllLedgerHistory(), []) || [];

  const handleExportCsv = async () => {
    if (activeLedger.length === 0) {
      showToast('warning', 'No active items in the current session to export.', 'Session Empty');
      return;
    }

    setIsExporting(true);
    try {
      const exportResult = await syncEngine.generateAndDownloadCsv();
      showToast('success', `Exported ${exportResult.count} garments to ${exportResult.filename}`, 'CSV Downloaded');
      setCsvDialogData(exportResult);
    } catch (err) {
      showToast('error', (err as Error).message || 'Export failed', 'Export Error');
    } finally {
      setIsExporting(false);
    }
  };

  const handleConfirmCutoff = async (batchId: string) => {
    await LedgerDao.confirmBatchSubmission(batchId, Date.now());
    showToast('success', `Production batch ${batchId} marked as submitted. Active session reset!`, 'Cut-Off Complete');
  };

  const handleDeleteItem = async (apparelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`Delete ledger entry for "${apparelId}"?`)) {
      await LedgerDao.deleteLedgerItem(apparelId);
      showToast('info', `Item ${apparelId} removed from ledger.`, 'Deleted');
    }
  };

  const handleDuplicate = async (originalId: string, newBarcode: string) => {
    const original = await LedgerDao.getLedgerItemById(originalId);
    if (!original) return;

    const today = new Date().toISOString().split('T')[0];
    const duplicated: DailyLedgerEntity = {
      ...original,
      apparelId: newBarcode,
      timestamp: Date.now(),
      createdDate: today,
      submittedToCsv: false,
      exportedAt: undefined,
      exportBatchId: undefined,
      submittedAt: undefined
    };

    await LedgerDao.insertLedgerItem(duplicated);
    showToast('success', `Created clone ${newBarcode} with attributes from ${originalId}`, 'Garment Cloned');
  };

  const currentList = activeTab === 'active' ? activeLedger : allLedgerHistory;

  return (
    <div className="flex flex-col gap-5 pb-20">
      {/* Title & Export Action Bar */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] font-extrabold uppercase tracking-widest text-[#86611F]">
            PRODUCTION AUDIT
          </div>
          <h1 className="text-xl sm:text-2xl font-black text-[#2A1D14] tracking-tight">
            Verified Daily Ledger
          </h1>
        </div>

        <button
          type="button"
          onClick={handleExportCsv}
          disabled={isExporting || activeLedger.length === 0}
          className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-[#86611F] hover:bg-[#A87C2E] text-white font-extrabold text-xs shadow-md transition-all active:scale-95 disabled:opacity-40 cursor-pointer"
        >
          <FileSpreadsheet className="w-4 h-4" />
          <span>{isExporting ? 'Exporting...' : 'Export CSV'}</span>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 p-1.5 rounded-2xl bg-[#F4EADA] border border-[#E6D8C1]">
        <button
          type="button"
          onClick={() => setActiveTab('active')}
          className={`flex-1 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center gap-2 transition-all cursor-pointer ${
            activeTab === 'active'
              ? 'bg-[#86611F] text-white shadow-md'
              : 'text-[#6B5442] hover:text-[#2A1D14]'
          }`}
        >
          <Clock className="w-4 h-4" />
          <span>Active Session</span>
          <span
            className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
              activeTab === 'active' ? 'bg-white/20 text-white' : 'bg-[#E6D8C1] text-[#2A1D14]'
            }`}
          >
            {activeLedger.length}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('history')}
          className={`flex-1 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center gap-2 transition-all cursor-pointer ${
            activeTab === 'history'
              ? 'bg-[#86611F] text-white shadow-md'
              : 'text-[#6B5442] hover:text-[#2A1D14]'
          }`}
        >
          <Archive className="w-4 h-4" />
          <span>History Archive</span>
          <span
            className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
              activeTab === 'history' ? 'bg-white/20 text-white' : 'bg-[#E6D8C1] text-[#2A1D14]'
            }`}
          >
            {allLedgerHistory.length}
          </span>
        </button>
      </div>

      {/* Ledger List */}
      <div className="flex flex-col gap-3.5">
        {currentList.length === 0 ? (
          <div className="bg-[#FFFDF9] p-8 rounded-3xl border border-[#E6D8C1] text-center flex flex-col items-center justify-center gap-3">
            <div className="w-14 h-14 rounded-2xl bg-[#F4EADA] text-[#86611F] flex items-center justify-center">
              <Layers className="w-7 h-7" />
            </div>
            <h3 className="text-base font-bold text-[#2A1D14]">
              {activeTab === 'active' ? 'No Active Verified Garments' : 'No Archive Records Found'}
            </h3>
            <p className="text-xs text-[#6B5442] max-w-sm">
              {activeTab === 'active'
                ? 'Garments confirmed in the Verification Workspace will appear here ready for CSV batch export.'
                : 'All past verified garments and submitted CSV batches will be stored here.'}
            </p>
            {activeTab === 'active' && (
              <button
                type="button"
                onClick={onNavigateToCapture}
                className="mt-2 flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#86611F] text-white font-bold text-xs shadow-md hover:bg-[#A87C2E] transition-all cursor-pointer active:scale-95"
              >
                <Camera className="w-4 h-4" />
                <span>Start Intake</span>
              </button>
            )}
          </div>
        ) : (
          currentList.map((item) => {
            const keyPhoto = item.photos[item.keyPhotoIndex] || item.photos[0];
            const dateStr = new Date(item.timestamp).toLocaleString();

            return (
              <div
                key={item.apparelId}
                className="bg-[#FFFDF9] p-4 sm:p-5 rounded-3xl border border-[#E6D8C1] shadow-sm flex flex-col sm:flex-row items-start sm:items-center gap-4 transition-all"
              >
                {/* Thumbnail */}
                <div className="relative w-20 h-20 rounded-2xl overflow-hidden bg-[#2A1D14] flex-shrink-0 border border-[#E6D8C1]">
                  {keyPhoto ? (
                    <img src={keyPhoto} alt={item.apparelId} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[#BF9445]">
                      <Tag className="w-6 h-6" />
                    </div>
                  )}
                  <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-[9px] font-bold text-white backdrop-blur-sm">
                    {item.photos.length}P
                  </div>
                </div>

                {/* Details */}
                <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-black text-sm text-[#86611F]">
                      {item.apparelId}
                    </span>

                    {item.submittedToCsv ? (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#F4EADA] text-[#6B5442] border border-[#E6D8C1] flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3 text-[#166534]" />
                        SUBMITTED CSV ({item.exportBatchId || 'EXPORT'})
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#DCFCE7] text-[#166534] flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        ACTIVE SESSION
                      </span>
                    )}
                  </div>

                  <div className="text-sm font-extrabold text-[#2A1D14]">
                    {item.brandName} • {item.subCategory} ({item.category})
                  </div>

                  {/* Attributes Badges */}
                  <div className="flex items-center gap-1.5 text-[11px] text-[#6B5442] flex-wrap">
                    <span className="px-2 py-0.5 rounded-md bg-[#F4EADA] font-semibold text-[#2A1D14]">
                      {item.gender}
                    </span>
                    <span className="px-2 py-0.5 rounded-md bg-[#F4EADA] font-semibold text-[#2A1D14]">
                      {item.season}
                    </span>
                    <span className="px-2 py-0.5 rounded-md bg-[#F4EADA] font-semibold text-[#2A1D14]">
                      Size: {item.size || 'N/A'}
                    </span>
                    <span className="px-2 py-0.5 rounded-md bg-[#F4EADA] font-semibold text-[#2A1D14]">
                      {item.color}
                    </span>
                    {item.material && (
                      <span className="px-2 py-0.5 rounded-md bg-[#F4EADA] font-semibold text-[#2A1D14] truncate max-w-[140px]">
                        {item.material}
                      </span>
                    )}
                    {item.countryOfOrigin && (
                      <span className="px-2 py-0.5 rounded-md bg-[#F4EADA] font-semibold text-[#2A1D14]">
                        {item.countryOfOrigin}
                      </span>
                    )}
                    {item.originalPrice && (
                      <span className="px-2 py-0.5 rounded-md bg-[#F4EADA] font-bold text-[#86611F]">
                        {item.originalPrice}
                      </span>
                    )}
                  </div>

                  <div className="text-[10px] text-[#7D6650] flex items-center gap-2 mt-0.5">
                    <span>Operator: {item.userId}</span>
                    <span>•</span>
                    <span>{dateStr}</span>
                  </div>
                </div>

                {/* Card Actions */}
                <div className="flex items-center gap-2 self-end sm:self-center">
                  <button
                    type="button"
                    onClick={() => setDuplicateTargetItem(item)}
                    title="Duplicate Composition (Clone Barcode)"
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#F4EADA] hover:bg-[#E6D8C1] text-[#86611F] font-bold text-xs transition-colors cursor-pointer"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>Clone</span>
                  </button>

                  <button
                    type="button"
                    onClick={(e) => handleDeleteItem(item.apparelId, e)}
                    title="Delete Entry"
                    className="p-2 rounded-xl text-[#7D6650] hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* CSV Cut-Off Dialog */}
      {csvDialogData && (
        <CsvCutoffDialog
          batchId={csvDialogData.batchId}
          count={csvDialogData.count}
          filename={csvDialogData.filename}
          onConfirmCutoff={handleConfirmCutoff}
          onDismiss={() => setCsvDialogData(null)}
        />
      )}

      {/* Duplicate / Clone Modal */}
      {duplicateTargetItem && (
        <DuplicateModal
          sourceItem={duplicateTargetItem}
          onClose={() => setDuplicateTargetItem(null)}
          onDuplicate={handleDuplicate}
        />
      )}
    </div>
  );
};
