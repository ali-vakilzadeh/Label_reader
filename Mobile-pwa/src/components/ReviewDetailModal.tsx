import React, { useState } from 'react';
import { AlertTriangle, Eye, Link2, ShieldCheck, Tag, X } from 'lucide-react';
import type { GarmentFields, ScanEntity } from '../types/models';
import { AutocompleteInput } from './AutocompleteInput';
import { EnumSelector } from './EnumSelector';
import { ConfidenceField } from './ConfidenceField';
import { optionsFor, useVocabulary } from '../data/vocabulary';

interface ReviewDetailModalProps {
  scan: ScanEntity;
  onClose: () => void;
  onSave: (scan: ScanEntity, verified: GarmentFields) => Promise<void>;
}

export const ReviewDetailModal: React.FC<ReviewDetailModalProps> = ({ scan, onClose, onSave }) => {
  // Re-render when the vocabulary is replaced, so a picker opened before a sync
  // does not keep offering the older list.
  useVocabulary();

  // The server's suggestion is a pre-selection; the operator's choice remains the
  // authority and is what gets sent back (contract section 4.2).
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(
    scan.suggestedKeyPhotoIndex ?? scan.keyPhotoIndex ?? 0
  );

  // A draft saved in an earlier sitting wins over the raw extraction.
  const [fields, setFields] = useState<GarmentFields>(() => ({ ...(scan.draft ?? scan.extracted) }));
  const [isSaving, setIsSaving] = useState(false);

  const conf = scan.confidences ?? {};
  const set = <K extends keyof GarmentFields>(key: K, value: GarmentFields[K]) =>
    setFields((prev) => ({ ...prev, [key]: value }));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await onSave(scan, {
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
      onClose();
    } catch (err) {
      console.error('Error confirming item:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const activePhoto = scan.photos[selectedPhotoIndex] || scan.photos[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-navy-950/50">
      <div className="bg-cream-50 border border-cocoa-200 rounded-[var(--radius-modal)] w-full max-w-2xl max-h-[92vh] flex flex-col shadow-[var(--shadow-overlay)] overflow-hidden">
        <div className="px-4 py-3 bg-cream-200 border-b border-cocoa-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-[var(--radius-control)] bg-navy-800 text-cream-50 flex items-center justify-center">
              <Tag className="w-5 h-5" />
            </div>
            <div>
              <div className="text-[0.75rem] uppercase tracking-wider text-cocoa-600">Care label audit</div>
              <h2 className="text-[1.1rem] font-semibold text-navy-900 flex items-center gap-2">
                <span>Verify</span>
                <span className="font-mono text-navy-800">{scan.apparelId}</span>
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-[var(--radius-control)] text-cocoa-600 hover:bg-cream-300 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          {scan.photos.length > 0 && (
            <div className="flex flex-col gap-2 bg-cream-200 p-3 rounded-[var(--radius-container)] border border-cocoa-200">
              <div className="relative w-full h-48 sm:h-56 bg-navy-900 rounded-[var(--radius-control)] overflow-hidden flex items-center justify-center">
                {activePhoto ? (
                  <img
                    src={activePhoto}
                    alt={`Care label for ${scan.apparelId}`}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="text-cream-300 text-[0.82rem]">No preview image</div>
                )}
                <div className="absolute top-2 right-2 px-2 py-1 rounded-[var(--radius-control)] bg-navy-950/60 text-cream-50 text-[0.75rem] flex items-center gap-1.5">
                  <Eye className="w-3.5 h-3.5" />
                  Photo {selectedPhotoIndex + 1} of {scan.photos.length}
                </div>
              </div>

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
                      {idx === scan.keyPhotoIndex && (
                        <div className="absolute bottom-0 inset-x-0 bg-navy-800 text-cream-50 text-[9px] font-semibold text-center">
                          KEY
                        </div>
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <AutocompleteInput
                label="Brand"
                value={fields.brandName}
                onChange={(v) => set('brandName', v)}
                options={optionsFor('brand')}
                placeholder="Select or enter a brand…"
                confidence={conf.brand_name}
                required
              />
            </div>

            <div className="sm:col-span-2">
              <EnumSelector
                label="Category"
                value={fields.category}
                onChange={(v) => set('category', v)}
                options={optionsFor('category')}
                confidence={conf.category}
              />
            </div>

            <div className="sm:col-span-2">
              <AutocompleteInput
                label="Sub-Category"
                value={fields.subCategory}
                onChange={(v) => set('subCategory', v)}
                options={optionsFor('sub_category')}
                placeholder="e.g. Trousers, Hoodie, Dress…"
                confidence={conf.sub_category}
                required
              />
            </div>

            <div className="sm:col-span-2">
              <EnumSelector
                label="Gender"
                value={fields.gender}
                onChange={(v) => set('gender', v)}
                options={optionsFor('gender')}
                confidence={conf.gender}
              />
            </div>

            <div className="sm:col-span-2">
              <EnumSelector
                label="Season"
                value={fields.season}
                onChange={(v) => set('season', v)}
                options={optionsFor('season')}
                confidence={conf.season}
              />
            </div>

            <ConfidenceField
              label="Size"
              value={fields.size}
              onChange={(v) => set('size', v)}
              placeholder="e.g. EU 122/128, XL"
              confidence={conf.size}
            />

            <AutocompleteInput
              label="Colour"
              value={fields.color}
              onChange={(v) => set('color', v)}
              options={optionsFor('color')}
              placeholder="Select a colour…"
              confidence={conf.color}
            />

            {/*
              v1.4 sends the whole composition, not one fibre. It is displayed and
              stored as a single string - never split, re-ordered or looked up as a key.
            */}
            <div className="sm:col-span-2">
              <AutocompleteInput
                label="Material composition"
                value={fields.material}
                onChange={(v) => set('material', v)}
                options={optionsFor('material')}
                placeholder="e.g. 80% Cotton 20% Polyester"
                confidence={conf.material}
              />
            </div>

            <div className="sm:col-span-2">
              <AutocompleteInput
                label="Country of origin"
                value={fields.countryOfOrigin}
                onChange={(v) => set('countryOfOrigin', v)}
                options={optionsFor('country')}
                placeholder="e.g. VIETNAM, PORTUGAL"
                confidence={conf.country_of_origin}
                uppercase
              />
            </div>

            <ConfidenceField
              label="Original price"
              value={fields.originalPrice}
              onChange={(v) => set('originalPrice', v)}
              placeholder="e.g. €49.95"
              confidence={conf.original_price}
            />

            <ConfidenceField
              label="Netto weight"
              value={fields.netto}
              onChange={(v) => set('netto', v)}
              placeholder="e.g. 240g"
              confidence={conf.netto}
            />

            <ConfidenceField
              label="Brutto weight"
              value={fields.brutto}
              onChange={(v) => set('brutto', v)}
              placeholder="e.g. 290g"
              confidence={conf.brutto}
            />

            {/*
              care_info is a URL the model read off a photograph, not a verified link.
              Shown and stored as plain text, never rendered as a live link, and low
              confidence here is normal (contract section 8.4).
            */}
            <div className="sm:col-span-2 flex flex-col gap-1">
              <ConfidenceField
                label="Care info (QR URL)"
                value={fields.careInfo}
                onChange={(v) => set('careInfo', v)}
                placeholder="Empty when no QR code was visible"
                confidence={conf.care_info}
              />
              {fields.careInfo && (
                <div className="flex items-center gap-1.5 text-[0.75rem] text-cocoa-400 px-1">
                  <Link2 className="w-3.5 h-3.5" />
                  <span>Read from a QR code — check it before trusting it.</span>
                </div>
              )}
            </div>
          </div>

          <div className="sticky bottom-0 bg-cream-50 pt-3 border-t border-cocoa-200 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 min-h-[44px] rounded-[var(--radius-control)] border border-cocoa-200 text-navy-800 font-semibold text-[0.82rem] hover:bg-cream-200 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="flex items-center gap-2 px-5 min-h-[44px] rounded-[var(--radius-control)] bg-navy-800 text-cream-50 font-semibold text-[0.82rem] hover:bg-navy-700 active:bg-navy-950 disabled:opacity-50 cursor-pointer"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>{isSaving ? 'Saving…' : 'Confirm & Save to Ledger'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
