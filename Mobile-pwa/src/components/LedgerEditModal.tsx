import React, { useState } from 'react';
import { Lock, Save, Tag, X } from 'lucide-react';
import { GarmentFieldsForm } from './GarmentFieldsForm';
import { useLanguage } from '../data/i18n';
import { isLedgerItemLocked, missingRequiredFields, type DailyLedgerEntity, type GarmentFields } from '../types/models';

interface LedgerEditModalProps {
  item: DailyLedgerEntity;
  onClose: () => void;
  onSave: (
    apparelId: string,
    changes: { fields: GarmentFields; packageCode: string; setSize: number }
  ) => Promise<void>;
}

/**
 * Correcting a ledger record after the fact (client decision 1).
 *
 * Editable right up to the moment the row is written into a CSV file; from then on it
 * is read-only, because the file is already on someone's disk and a row that quietly
 * disagrees with it is worse than one that cannot be fixed. A locked record still
 * opens - an operator needs to be able to read what went out - but every control is
 * disabled and the reason is stated rather than left to be discovered.
 */
export const LedgerEditModal: React.FC<LedgerEditModalProps> = ({ item, onClose, onSave }) => {
  const { t } = useLanguage();
  const locked = isLedgerItemLocked(item);

  const [fields, setFields] = useState<GarmentFields>(() => ({ ...item.fields }));
  const [packageCode, setPackageCode] = useState(item.packageCode);
  const [setSize, setSetSize] = useState(item.setSize || 1);
  const [isSaving, setIsSaving] = useState(false);

  const missing = missingRequiredFields({ ...item, fields });

  const handleSave = async () => {
    if (locked) return;
    setIsSaving(true);
    try {
      await onSave(item.apparelId, {
        fields: { ...fields, countryOfOrigin: fields.countryOfOrigin.trim().toUpperCase() },
        packageCode: packageCode.trim(),
        setSize
      });
      onClose();
    } catch (err) {
      console.error('Error saving ledger record:', err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-navy-950/50">
      <div className="bg-cream-50 border border-cocoa-200 rounded-[var(--radius-modal)] w-full max-w-2xl max-h-[92vh] flex flex-col shadow-[var(--shadow-overlay)] overflow-hidden">
        <div
          className={`px-4 py-3 border-b border-cocoa-200 flex items-center justify-between gap-3 ${
            locked ? 'bg-cream-300' : 'bg-cream-200'
          }`}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-[var(--radius-control)] bg-navy-800 text-cream-50 flex items-center justify-center flex-shrink-0">
              {locked ? <Lock className="w-5 h-5" /> : <Tag className="w-5 h-5" />}
            </div>
            <div className="min-w-0">
              <div className="text-[0.75rem] uppercase tracking-wider text-cocoa-600">
                {locked ? t('Locked') : t('Edit')}
              </div>
              <h2 className="text-[1.1rem] font-semibold text-navy-900 font-mono truncate">{item.apparelId}</h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('Cancel')}
            className="p-2 rounded-[var(--radius-control)] text-cocoa-600 hover:bg-cream-50 cursor-pointer flex-shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          {locked && (
            <div className="flex items-start gap-2.5 p-3 rounded-[var(--radius-container)] bg-cream-300 border border-cocoa-200 text-[0.82rem] text-cocoa-600">
              <Lock className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-navy-900">
                  Exported in {item.exportBatchId ?? 'an earlier batch'}
                </div>
                <div>
                  This record has already been written into a CSV file, so it can no longer be changed. Clone it
                  if a corrected version is needed.
                </div>
              </div>
            </div>
          )}

          {!locked && missing.length > 0 && (
            <div className="flex items-start gap-2.5 p-3 rounded-[var(--radius-container)] bg-gold-100 border border-gold-500 text-[0.82rem] text-[color:var(--color-warning)]">
              <span>
                <strong className="font-semibold">{t('Incomplete')}:</strong> {missing.join(', ')}.
                {' '}Complete these, or turn the export gate off in Settings.
              </span>
            </div>
          )}

          <GarmentFieldsForm
            fields={fields}
            onChange={setFields}
            setSize={setSize}
            onSetSizeChange={setSetSize}
            packageCode={packageCode}
            onPackageCodeChange={setPackageCode}
            disabled={locked}
          />
        </div>

        <div className="px-4 py-3 bg-cream-50 border-t border-cocoa-200 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 min-h-[44px] rounded-[var(--radius-control)] text-navy-800 font-semibold text-[0.82rem] hover:bg-cream-200 cursor-pointer"
          >
            {locked ? 'Close' : t('Cancel')}
          </button>
          {!locked && (
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={isSaving}
              className="flex items-center gap-2 px-5 min-h-[44px] rounded-[var(--radius-control)] bg-navy-800 text-cream-50 font-semibold text-[0.82rem] hover:bg-navy-700 active:bg-navy-950 disabled:opacity-50 cursor-pointer"
            >
              <Save className="w-4 h-4" />
              <span>{isSaving ? 'Saving…' : t('Save changes')}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
