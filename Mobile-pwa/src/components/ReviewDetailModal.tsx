import React, { useState } from 'react';
import { AlertTriangle, Eye, Save, ShieldCheck, Star, Tag, X } from 'lucide-react';
import { GarmentFieldsForm } from './GarmentFieldsForm';
import { PhotoLightbox } from './PhotoLightbox';
import { useLanguage } from '../data/i18n';
import type { GarmentFields, ScanEntity } from '../types/models';

/** Everything the operator decides about a record, as opposed to what the AI read. */
export interface ReviewOutcome {
  fields: GarmentFields;
  packageCode: string;
  setSize: number;
  keyPhotoIndex: number;
}

interface ReviewDetailModalProps {
  scan: ScanEntity;
  onClose: () => void;
  /** Confirms the record into the ledger. */
  onConfirm: (scan: ScanEntity, outcome: ReviewOutcome) => Promise<void>;
  /** Keeps the record in Review, with the operator's work so far. */
  onSaveDraft: (scan: ScanEntity, outcome: ReviewOutcome) => Promise<void>;
}

const trimAll = (fields: GarmentFields): GarmentFields => ({
  ...fields,
  brandName: fields.brandName.trim(),
  category: fields.category.trim(),
  subCategory: fields.subCategory.trim(),
  gender: fields.gender.trim(),
  season: fields.season.trim(),
  size: fields.size.trim(),
  color: fields.color.trim(),
  material: fields.material.trim(),
  countryOfOrigin: fields.countryOfOrigin.trim().toUpperCase(),
  originalPrice: fields.originalPrice.trim(),
  netto: fields.netto.trim(),
  brutto: fields.brutto.trim(),
  careInfo: fields.careInfo.trim()
});

/**
 * Reviewing one extraction.
 *
 * An operator may work through a record over several sittings (client decision 4):
 * "Save draft" keeps it in Review with everything typed so far, and only "Confirm"
 * moves it to the ledger. A draft is deliberately not held to the completeness rule -
 * being unfinished is the entire point of it.
 */
export const ReviewDetailModal: React.FC<ReviewDetailModalProps> = ({
  scan,
  onClose,
  onConfirm,
  onSaveDraft
}) => {
  const { t } = useLanguage();

  // `scan.keyPhotoIndex` already carries the outcome of the pre-selection: the sync
  // engine applied the model's suggestion when the operator had not chosen a photo,
  // and left their choice alone when they had (contract section 4.2). Both the viewer
  // and the star read from it, so what is starred is what reaches the ledger.
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(scan.keyPhotoIndex ?? 0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [keyPhotoIndex, setKeyPhotoIndex] = useState(scan.keyPhotoIndex ?? 0);

  // A draft from an earlier sitting wins over the raw extraction.
  const [fields, setFields] = useState<GarmentFields>(() => ({ ...(scan.draft ?? scan.extracted) }));
  const [packageCode, setPackageCode] = useState(scan.packageCode);
  const [setSize, setSetSize] = useState(scan.setSize || 1);
  const [busy, setBusy] = useState<'draft' | 'confirm' | null>(null);

  const run = async (kind: 'draft' | 'confirm') => {
    setBusy(kind);
    try {
      const outcome = {
        fields: trimAll(fields),
        packageCode: packageCode.trim(),
        setSize,
        keyPhotoIndex
      };
      await (kind === 'confirm' ? onConfirm(scan, outcome) : onSaveDraft(scan, outcome));
      onClose();
    } catch (err) {
      console.error(`Error on ${kind}:`, err);
    } finally {
      setBusy(null);
    }
  };

  const activePhoto = scan.photos[selectedPhotoIndex] || scan.photos[0];
  const isSuggested =
    scan.suggestedKeyPhotoIndex !== null &&
    scan.suggestedKeyPhotoIndex !== undefined &&
    selectedPhotoIndex === scan.suggestedKeyPhotoIndex;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-navy-950/50">
      <div className="bg-cream-50 border border-cocoa-200 rounded-[var(--radius-modal)] w-full max-w-2xl max-h-[92vh] flex flex-col shadow-[var(--shadow-overlay)] overflow-hidden">
        <div className="px-4 py-3 bg-cream-200 border-b border-cocoa-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-[var(--radius-control)] bg-navy-800 text-cream-50 flex items-center justify-center flex-shrink-0">
              <Tag className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="text-[0.75rem] uppercase tracking-wider text-cocoa-600 flex items-center gap-2">
                <span>Care label audit</span>
                {scan.draft && (
                  <span className="px-1.5 rounded bg-gold-100 text-[color:var(--color-warning)] border border-gold-500">
                    {t('Draft')}
                  </span>
                )}
              </div>
              <h2 className="text-[1.1rem] font-semibold text-navy-900 font-mono truncate">{scan.apparelId}</h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('Cancel')}
            className="p-2 rounded-[var(--radius-control)] text-cocoa-600 hover:bg-cream-300 cursor-pointer flex-shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          {scan.photos.length > 0 && (
            <div className="flex flex-col gap-2 bg-cream-200 p-3 rounded-[var(--radius-container)] border border-cocoa-200">
              <button
                type="button"
                onClick={() => setLightboxIndex(selectedPhotoIndex)}
                className="relative w-full h-48 sm:h-56 bg-navy-900 rounded-[var(--radius-control)] overflow-hidden flex items-center justify-center cursor-pointer"
              >
                {activePhoto ? (
                  <img
                    src={activePhoto}
                    alt={`Care label for ${scan.apparelId}`}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <span className="text-cream-300 text-[0.82rem]">No preview image</span>
                )}
                <span className="absolute top-2 right-2 px-2 py-1 rounded-[var(--radius-control)] bg-navy-950/60 text-cream-50 text-[0.75rem] flex items-center gap-1.5">
                  <Eye className="w-3.5 h-3.5" />
                  {selectedPhotoIndex + 1} / {scan.photos.length}
                </span>
                {isSuggested && (
                  <span className="absolute bottom-2 left-2 px-2 py-1 rounded-[var(--radius-control)] bg-gold-500 text-navy-900 text-[0.75rem]">
                    Suggested by the model
                  </span>
                )}
              </button>

              {scan.photos.length > 1 && (
                <div className="flex items-center gap-2 overflow-x-auto py-1">
                  {scan.photos.map((p, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setSelectedPhotoIndex(idx)}
                      className={`relative w-14 h-14 rounded-[var(--radius-control)] overflow-hidden flex-shrink-0 border-2 cursor-pointer ${
                        selectedPhotoIndex === idx ? 'border-gold-500' : 'border-transparent opacity-70'
                      }`}
                    >
                      <img src={p} alt={`Thumbnail ${idx + 1}`} className="w-full h-full object-cover" />
                      {idx === keyPhotoIndex && (
                        <Star className="absolute bottom-0.5 right-0.5 w-3 h-3 text-gold-500 fill-current" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {scan.attentionReason && (
            <div className="flex items-start gap-2.5 p-3 rounded-[var(--radius-container)] bg-cream-50 border border-[color:var(--color-critical)] text-[color:var(--color-critical)] text-[0.82rem]">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">Manual review required</div>
                <div>{scan.attentionReason}</div>
              </div>
            </div>
          )}

          <GarmentFieldsForm
            fields={fields}
            onChange={setFields}
            confidences={scan.confidences}
            armenian={scan.armenian}
            setSize={setSize}
            onSetSizeChange={setSetSize}
            packageCode={packageCode}
            onPackageCodeChange={setPackageCode}
          />
        </div>

        <div className="px-4 py-3 bg-cream-50 border-t border-cocoa-200 flex items-center justify-end gap-2 flex-wrap">
          <button
            type="button"
            onClick={onClose}
            className="px-4 min-h-[44px] rounded-[var(--radius-control)] text-navy-800 font-semibold text-[0.82rem] hover:bg-cream-200 cursor-pointer"
          >
            {t('Cancel')}
          </button>
          <button
            type="button"
            onClick={() => void run('draft')}
            disabled={busy !== null}
            className="flex items-center gap-2 px-4 min-h-[44px] rounded-[var(--radius-control)] bg-cream-50 border border-cocoa-200 text-navy-800 font-semibold text-[0.82rem] hover:bg-cream-200 disabled:opacity-50 cursor-pointer"
          >
            <Save className="w-4 h-4" />
            <span>{busy === 'draft' ? 'Saving…' : t('Save draft')}</span>
          </button>
          <button
            type="button"
            onClick={() => void run('confirm')}
            disabled={busy !== null}
            className="flex items-center gap-2 px-5 min-h-[44px] rounded-[var(--radius-control)] bg-navy-800 text-cream-50 font-semibold text-[0.82rem] hover:bg-navy-700 active:bg-navy-950 disabled:opacity-50 cursor-pointer"
          >
            <ShieldCheck className="w-4 h-4" />
            <span>{busy === 'confirm' ? 'Saving…' : t('Confirm')}</span>
          </button>
        </div>
      </div>

      {lightboxIndex !== null && (
        <PhotoLightbox
          photos={scan.photos}
          index={lightboxIndex}
          isKey={lightboxIndex === keyPhotoIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          onSetKey={setKeyPhotoIndex}
          canDelete={false}
        />
      )}
    </div>
  );
};
