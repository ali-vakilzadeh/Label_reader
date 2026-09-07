import React, { useState } from 'react';
import { Copy, ScanBarcode, X } from 'lucide-react';
import { BarcodeScannerOverlay } from './BarcodeScannerOverlay';
import { useLanguage } from '../data/i18n';
import type { DailyLedgerEntity } from '../types/models';

interface DuplicateModalProps {
  sourceItem: DailyLedgerEntity;
  onClose: () => void;
  onDuplicate: (originalId: string, newBarcode: string) => Promise<void>;
}

/**
 * Cloning a verified record onto further barcodes (client decision 13).
 *
 * A rail of identical garments differing only by barcode is the case this exists for,
 * so "Clone Again" commits the current barcode and stays open with the field cleared
 * and the scanner ready; "Confirm" commits and closes. Every clone is a full article
 * in its own right - a set of two garments is SetSize=2 on one row, never two rows
 * (csv_export_format.txt section 3).
 */
export const DuplicateModal: React.FC<DuplicateModalProps> = ({ sourceItem, onClose, onDuplicate }) => {
  const { t } = useLanguage();
  const [newBarcode, setNewBarcode] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloned, setCloned] = useState<string[]>([]);

  const commit = async (keepOpen: boolean) => {
    const trimmed = newBarcode.trim();
    if (!trimmed) {
      setError('Enter or scan a barcode for the cloned garment.');
      return;
    }
    if (trimmed === sourceItem.apparelId) {
      setError('The new barcode must differ from the original.');
      return;
    }
    if (cloned.includes(trimmed)) {
      setError(`${trimmed} has already been cloned in this session.`);
      return;
    }

    setIsSubmitting(true);
    try {
      await onDuplicate(sourceItem.apparelId, trimmed);
      setCloned((prev) => [...prev, trimmed]);
      setNewBarcode('');
      setError(null);
      if (!keepOpen) onClose();
    } catch (err) {
      setError((err as Error).message || 'Failed to clone the record.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy-950/50">
        <div className="bg-cream-50 border border-cocoa-200 rounded-[var(--radius-modal)] w-full max-w-md p-5 flex flex-col gap-4 shadow-[var(--shadow-overlay)]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-[var(--radius-control)] bg-navy-800 text-cream-50 flex items-center justify-center flex-shrink-0">
                <Copy className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="text-[0.75rem] uppercase tracking-wider text-cocoa-600">{t('Clone')}</div>
                <h3 className="text-[1.1rem] font-semibold text-navy-900">Clone this garment</h3>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('Cancel')}
              className="p-2 rounded-[var(--radius-control)] text-cocoa-600 hover:bg-cream-200 cursor-pointer flex-shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-3 rounded-[var(--radius-container)] bg-cream-200 border border-cocoa-200 flex flex-col gap-1 text-[0.82rem]">
            <span className="text-cocoa-600">Copying from</span>
            <span className="text-navy-900">
              <span className="font-mono">{sourceItem.apparelId}</span>
              {' · '}
              {sourceItem.fields.brandName} {sourceItem.fields.subCategory}
              {sourceItem.fields.size ? ` (${sourceItem.fields.size})` : ''}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[0.75rem] font-semibold uppercase tracking-wider text-cocoa-600" htmlFor="clone-barcode">
              {t('Barcode Number')}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="clone-barcode"
                type="text"
                value={newBarcode}
                onChange={(e) => {
                  setNewBarcode(e.target.value);
                  setError(null);
                }}
                placeholder="Scan or type the new barcode"
                className={`flex-1 px-3 py-2.5 min-h-[44px] rounded-[var(--radius-control)] text-[0.88rem] font-mono bg-white border text-navy-800 placeholder:text-cocoa-400 outline-none ${
                  error ? 'border-[color:var(--color-critical)]' : 'border-cocoa-200 focus:border-gold-600'
                }`}
              />
              <button
                type="button"
                onClick={() => setIsScanning(true)}
                aria-label={t('Scan')}
                className="w-[44px] h-[44px] rounded-[var(--radius-control)] bg-cream-50 border border-cocoa-200 text-navy-800 flex items-center justify-center hover:bg-cream-200 cursor-pointer flex-shrink-0"
              >
                <ScanBarcode className="w-5 h-5" />
              </button>
            </div>
            {error && <span className="text-[0.75rem] text-[color:var(--color-critical)]">{error}</span>}
          </div>

          {cloned.length > 0 && (
            <div className="flex flex-col gap-1 text-[0.75rem]">
              <span className="text-cocoa-600">
                Cloned in this session ({cloned.length})
              </span>
              <div className="flex flex-wrap gap-1">
                {cloned.map((code) => (
                  <span
                    key={code}
                    className="px-2 py-0.5 rounded-[var(--radius-control)] bg-cream-200 text-navy-800 font-mono"
                  >
                    {code}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 flex-wrap">
            <button
              type="button"
              onClick={onClose}
              className="px-4 min-h-[44px] rounded-[var(--radius-control)] text-navy-800 font-semibold text-[0.82rem] hover:bg-cream-200 cursor-pointer"
            >
              {t('Cancel')}
            </button>
            <button
              type="button"
              onClick={() => void commit(true)}
              disabled={isSubmitting}
              className="flex items-center gap-2 px-4 min-h-[44px] rounded-[var(--radius-control)] bg-cream-50 border border-cocoa-200 text-navy-800 font-semibold text-[0.82rem] hover:bg-cream-200 disabled:opacity-50 cursor-pointer"
            >
              <Copy className="w-4 h-4" />
              <span>{t('Clone Again')}</span>
            </button>
            <button
              type="button"
              onClick={() => void commit(false)}
              disabled={isSubmitting}
              className="px-5 min-h-[44px] rounded-[var(--radius-control)] bg-navy-800 text-cream-50 font-semibold text-[0.82rem] hover:bg-navy-700 active:bg-navy-950 disabled:opacity-50 cursor-pointer"
            >
              {isSubmitting ? 'Cloning…' : t('Confirm')}
            </button>
          </div>
        </div>
      </div>

      {isScanning && (
        <BarcodeScannerOverlay
          title="Scan the barcode to clone onto"
          onDetected={(value) => {
            setNewBarcode(value);
            setError(null);
          }}
          onClose={() => setIsScanning(false)}
        />
      )}
    </>
  );
};
