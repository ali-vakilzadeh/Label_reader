import React, { useState } from 'react';
import {
  Archive,
  Camera,
  CheckCircle2,
  Clock,
  Copy,
  FileSpreadsheet,
  Layers,
  Lock,
  Pencil,
  Tag,
  Trash2
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { LedgerDao, ScanDao } from '../data/db';
import { syncEngine } from '../services/syncEngine';
import { CsvCutoffDialog } from '../components/CsvCutoffDialog';
import { DuplicateModal } from '../components/DuplicateModal';
import { LedgerEditModal } from '../components/LedgerEditModal';
import { ExportBlockedError, NothingToExportError } from '../services/csvExport';
import { useLanguage } from '../data/i18n';
import { displayValue } from '../data/vocabulary';
import {
  emptyGarmentFields,
  isLedgerItemLocked,
  missingRequiredFields,
  type DailyLedgerEntity,
  type GarmentFields,
  type ScanEntity
} from '../types/models';
import type { ShowToast } from '../App';

interface DailyLedgerScreenProps {
  onNavigateToCapture: () => void;
  showToast: ShowToast;
}

const chipClass = 'px-2 py-0.5 rounded-[var(--radius-control)] bg-cream-200 text-[0.75rem] text-navy-800';

export const DailyLedgerScreen: React.FC<DailyLedgerScreenProps> = ({ onNavigateToCapture, showToast }) => {
  const { language, t } = useLanguage();
  const [activeTab, setActiveTab] = useState<'active' | 'history'>('active');
  const [duplicateTarget, setDuplicateTarget] = useState<DailyLedgerEntity | null>(null);
  const [editTarget, setEditTarget] = useState<DailyLedgerEntity | null>(null);
  const [csvDialogData, setCsvDialogData] = useState<{ batchId: string; count: number; filename: string } | null>(
    null
  );
  const [isExporting, setIsExporting] = useState(false);

  const activeLedger = useLiveQuery(() => LedgerDao.getActiveLedger(), []) || [];
  const allLedgerHistory = useLiveQuery(() => LedgerDao.getAllLedgerHistory(), []) || [];
  // Only rows that have never been written into a file can go into the next one.
  const exportableCount = useLiveQuery(() => LedgerDao.getUnexportedLedger(), [])?.length ?? 0;

  const handleExportCsv = async () => {
    setIsExporting(true);
    try {
      const result = await syncEngine.generateAndDownloadCsv();
      showToast('success', `Exported ${result.count} garments to ${result.filename}`, 'CSV Downloaded');

      // The gate was Off and rows went out short. Say so rather than letting an
      // incomplete file leave quietly.
      if (result.incomplete.length > 0) {
        showToast(
          'warning',
          `${result.incomplete.length} record(s) were exported with blank columns.`,
          'Incomplete Records'
        );
      }
      setCsvDialogData(result);
    } catch (err) {
      const error = err as Error;
      if (error instanceof ExportBlockedError) {
        showToast(
          'error',
          `${error.message} Complete them, or turn the export gate off in Settings.`,
          'Export Blocked'
        );
      } else if (error instanceof NothingToExportError) {
        showToast('warning', error.message, 'Nothing to Export');
      } else {
        showToast('error', error.message || 'Export failed', 'Export Error');
      }
    } finally {
      setIsExporting(false);
    }
  };

  const handleConfirmCutoff = async (batchId: string) => {
    await LedgerDao.confirmBatchSubmission(batchId, Date.now());
    showToast('success', `Batch ${batchId} confirmed. The session is reset.`, 'Cut-Off Complete');
  };

  const handleSaveEdit = async (
    apparelId: string,
    changes: { fields: GarmentFields; packageCode: string; setSize: number }
  ) => {
    const result = await LedgerDao.updateLedgerItem(apparelId, changes);
    if (result === 'locked') {
      showToast('warning', `${apparelId} is in an exported batch and can no longer be changed.`, t('Locked'));
    } else if (result === 'missing') {
      showToast('error', `${apparelId} is no longer in the ledger.`, 'Not Found');
    } else {
      showToast('success', `${apparelId} updated.`, 'Saved');
    }
  };

  const handleDeleteItem = async (apparelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const item = await LedgerDao.getLedgerItemById(apparelId);
    if (item && isLedgerItemLocked(item)) {
      showToast('warning', `${apparelId} is already in an exported batch and cannot be deleted.`, t('Locked'));
      return;
    }
    if (window.confirm(`Delete the ledger entry for "${apparelId}"?`)) {
      await LedgerDao.deleteLedgerItem(apparelId);
      showToast('info', `${apparelId} removed from the ledger.`, 'Deleted');
    }
  };

  const handleDuplicate = async (originalId: string, newBarcode: string) => {
    const original = await LedgerDao.getLedgerItemById(originalId);
    if (!original) throw new Error(`${originalId} is no longer in the ledger.`);

    const existing = await LedgerDao.getLedgerItemById(newBarcode);
    if (existing) throw new Error(`${newBarcode} is already in the ledger.`);

    await LedgerDao.insertLedgerItem({
      ...original,
      apparelId: newBarcode,
      timestamp: Date.now(),
      createdDate: new Date().toISOString().split('T')[0],
      // A clone is a new article: never exported, whatever its parent's state.
      submittedToCsv: false,
      exportedAt: undefined,
      exportBatchId: undefined,
      submittedAt: undefined,
      editedByUser: true
    });

    // The ledger row is the operator's deliverable and is written first, so a clone
    // is never blocked by the network. But a clone is a real article: the server must
    // hold its own record so it gets a catalog image and appears wherever the parent
    // does. That goes through the normal scan queue - `cloned_from` needs no images
    // (contract section 4.2) and rides the queue's retry and storage invariant.
    if (!(await ScanDao.getScanById(newBarcode))) {
      const registration: ScanEntity = {
        apparelId: newBarcode,
        userId: original.userId,
        timestamp: Date.now(),
        // The server rebinds the parent's photos; copying the base64 would double the
        // storage on the device for nothing.
        photos: [],
        keyPhotoIndex: original.keyPhotoIndex,
        // The ledger row is already confirmed, so nothing may revise its key photo.
        keyPhotoExplicit: true,
        clonedFrom: originalId,
        status: 0,
        serverStored: false,
        processingStatus: 'PENDING_AI',
        queueDepth: 0,
        retryAfterSeconds: 5,
        suggestedKeyPhotoIndex: null,
        extracted: emptyGarmentFields(),
        armenian: {},
        confidences: {},
        packageCode: original.packageCode,
        setSize: original.setSize,
        lastAttemptTime: 0,
        retryCount: 0
      };

      await ScanDao.insertScan(registration);
      // Not awaited: a clone must complete offline. The sync loop carries it, and a
      // failure surfaces on the Review queue rather than blocking the dialog.
      void syncEngine.submitScan(registration);
    }

    showToast('success', `Cloned ${originalId} onto ${newBarcode}.`, 'Cloned');
  };

  const currentList = activeTab === 'active' ? activeLedger : allLedgerHistory;

  const tabButton = (id: 'active' | 'history', label: string, count: number, Icon: typeof Clock) => (
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
            Production audit
          </div>
          <h1 className="text-[1.1rem] font-semibold text-navy-900">{t('Ledger')}</h1>
        </div>

        <button
          type="button"
          onClick={handleExportCsv}
          disabled={isExporting || exportableCount === 0}
          className="flex items-center gap-2 px-4 min-h-[44px] rounded-[var(--radius-control)] bg-navy-800 text-cream-50 font-semibold text-[0.82rem] hover:bg-navy-700 active:bg-navy-950 disabled:opacity-50 cursor-pointer"
        >
          <FileSpreadsheet className="w-4 h-4" />
          <span>
            {isExporting ? 'Exporting…' : `${t('Export CSV')}${exportableCount ? ` (${exportableCount})` : ''}`}
          </span>
        </button>
      </div>

      <div className="flex items-center gap-1.5 p-1.5 rounded-[var(--radius-container)] bg-cream-200 border border-cocoa-200">
        {tabButton('active', 'Active', activeLedger.length, Clock)}
        {tabButton('history', 'History', allLedgerHistory.length, Archive)}
      </div>

      <div className="flex flex-col gap-3">
        {currentList.length === 0 ? (
          <div className="bg-cream-50 p-8 rounded-[var(--radius-container)] border border-cocoa-200 shadow-[var(--shadow-card)] text-center flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-[var(--radius-container)] bg-cream-200 text-navy-800 flex items-center justify-center">
              <Layers className="w-6 h-6" />
            </div>
            <h3 className="text-[0.88rem] font-semibold text-navy-900">
              {activeTab === 'active' ? 'No verified garments yet' : 'No archived records'}
            </h3>
            <p className="text-[0.82rem] text-cocoa-600 max-w-sm">
              {activeTab === 'active'
                ? 'Records confirmed in Review appear here, ready for the CSV batch export.'
                : 'Submitted batches are kept here.'}
            </p>
            {activeTab === 'active' && (
              <button
                type="button"
                onClick={onNavigateToCapture}
                className="flex items-center gap-2 px-4 min-h-[44px] rounded-[var(--radius-control)] bg-navy-800 text-cream-50 font-semibold text-[0.82rem] hover:bg-navy-700 cursor-pointer"
              >
                <Camera className="w-4 h-4" />
                <span>{t('Intake')}</span>
              </button>
            )}
          </div>
        ) : (
          currentList.map((item) => {
            const keyPhoto = item.photos[item.keyPhotoIndex] || item.photos[0];
            const locked = isLedgerItemLocked(item);
            const missing = missingRequiredFields(item);

            return (
              <div
                key={item.apparelId}
                className={`p-4 rounded-[var(--radius-container)] border shadow-[var(--shadow-card)] flex items-start gap-3 ${
                  // Locked-row fill from the design basis, so an exported record reads
                  // as settled rather than as one more editable row.
                  locked ? 'bg-cream-300 border-cocoa-200' : 'bg-cream-50 border-cocoa-200'
                }`}
              >
                <div className="relative w-16 h-16 rounded-[var(--radius-control)] overflow-hidden bg-navy-900 flex-shrink-0 border border-cocoa-200">
                  {keyPhoto ? (
                    <img src={keyPhoto} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Tag className="w-5 h-5 text-cream-300 absolute inset-0 m-auto" />
                  )}
                  <span className="absolute bottom-0.5 right-0.5 px-1 rounded bg-navy-950/70 text-[9px] text-cream-50">
                    {item.photos.length}
                  </span>
                </div>

                <div className="flex-1 flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[0.82rem] text-navy-900">{item.apparelId}</span>

                    {item.submittedToCsv ? (
                      <span className="text-[0.75rem] px-1.5 rounded bg-cream-200 text-cocoa-600 border border-cocoa-200 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3 text-[color:var(--color-good)]" />
                        Submitted · {item.exportBatchId ?? 'batch'}
                      </span>
                    ) : item.exportBatchId ? (
                      <span className="text-[0.75rem] px-1.5 rounded bg-cream-200 text-cocoa-600 border border-cocoa-200 flex items-center gap-1">
                        <Lock className="w-3 h-3" />
                        {t('Exported')} · {item.exportBatchId}
                      </span>
                    ) : (
                      <span className="text-[0.75rem] px-1.5 rounded bg-cream-200 text-[color:var(--color-good)]">
                        Active
                      </span>
                    )}

                    {missing.length > 0 && !locked && (
                      <span
                        className="text-[0.75rem] px-1.5 rounded bg-gold-100 text-[color:var(--color-warning)] border border-gold-500"
                        title={`Missing: ${missing.join(', ')}`}
                      >
                        {t('Incomplete')}
                      </span>
                    )}
                  </div>

                  <div className="text-[0.88rem] text-navy-800 truncate">
                    {item.fields.brandName} ·{' '}
                    {displayValue(language, item.fields.subCategory, { table: 'sub_category' })} (
                    {displayValue(language, item.fields.category, { table: 'category' })})
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    {item.fields.gender && (
                      <span className={chipClass}>
                        {displayValue(language, item.fields.gender, { table: 'gender' })}
                      </span>
                    )}
                    {item.fields.season && (
                      <span className={chipClass}>
                        {displayValue(language, item.fields.season, { table: 'season' })}
                      </span>
                    )}
                    {item.fields.size && <span className={chipClass}>{item.fields.size}</span>}
                    {item.fields.color && (
                      <span className={chipClass}>
                        {displayValue(language, item.fields.color, { table: 'color' })}
                      </span>
                    )}
                    {item.fields.material && (
                      <span className={`${chipClass} truncate max-w-[160px]`}>{item.fields.material}</span>
                    )}
                    {item.fields.countryOfOrigin && (
                      <span className={chipClass}>{item.fields.countryOfOrigin}</span>
                    )}
                    {item.setSize > 1 && (
                      <span className="px-2 py-0.5 rounded-[var(--radius-control)] bg-gold-100 border border-gold-500 text-[0.75rem] text-[color:var(--color-warning)]">
                        {t('Set of')} {item.setSize}
                      </span>
                    )}
                  </div>

                  <div className="text-[0.75rem] text-cocoa-400 flex items-center gap-2 flex-wrap">
                    <span>{item.userId}</span>
                    <span>·</span>
                    <span>{new Date(item.timestamp).toLocaleString()}</span>
                    {item.packageCode && (
                      <>
                        <span>·</span>
                        <span className="font-mono">{item.packageCode}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => setEditTarget(item)}
                    aria-label={locked ? 'View this exported record' : t('Edit')}
                    title={locked ? 'Exported records are read-only' : t('Edit')}
                    className="p-2.5 rounded-[var(--radius-control)] bg-cream-200 text-navy-800 hover:bg-cream-50 cursor-pointer"
                  >
                    {locked ? <Lock className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => setDuplicateTarget(item)}
                    aria-label={t('Clone')}
                    className="p-2.5 rounded-[var(--radius-control)] bg-cream-200 text-navy-800 hover:bg-cream-50 cursor-pointer"
                  >
                    <Copy className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={(e) => void handleDeleteItem(item.apparelId, e)}
                    disabled={locked}
                    aria-label={t('Delete')}
                    title={locked ? 'Exported records are read-only' : t('Delete')}
                    className="p-2.5 rounded-[var(--radius-control)] text-cocoa-400 hover:text-[color:var(--color-critical)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {csvDialogData && (
        <CsvCutoffDialog
          batchId={csvDialogData.batchId}
          count={csvDialogData.count}
          filename={csvDialogData.filename}
          onConfirmCutoff={handleConfirmCutoff}
          onDismiss={() => setCsvDialogData(null)}
        />
      )}

      {duplicateTarget && (
        <DuplicateModal
          sourceItem={duplicateTarget}
          onClose={() => setDuplicateTarget(null)}
          onDuplicate={handleDuplicate}
        />
      )}

      {editTarget && (
        <LedgerEditModal item={editTarget} onClose={() => setEditTarget(null)} onSave={handleSaveEdit} />
      )}
    </div>
  );
};
