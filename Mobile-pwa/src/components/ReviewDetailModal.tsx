import React, { useState } from 'react';
import { X, Eye, Tag, AlertTriangle, ShieldCheck } from 'lucide-react';
import type { ScanEntity } from '../types/models';
import { AutocompleteInput } from './AutocompleteInput';
import { EnumSelector } from './EnumSelector';
import { ConfidenceField } from './ConfidenceField';
import {
  BRANDS,
  CATEGORIES,
  SUB_CATEGORIES,
  GENDERS,
  SEASONS,
  COLORS,
  MATERIALS,
  COUNTRIES
} from '../data/vocabulary';

interface ReviewDetailModalProps {
  scan: ScanEntity;
  onClose: () => void;
  onSave: (scan: ScanEntity, verifiedData: {
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
  }) => Promise<void>;
}

export const ReviewDetailModal: React.FC<ReviewDetailModalProps> = ({
  scan,
  onClose,
  onSave
}) => {
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(scan.keyPhotoIndex || 0);

  // Form State initialized with extracted fields
  const [brandName, setBrandName] = useState(scan.extractedBrandName || '');
  const [category, setCategory] = useState(scan.extractedCategory || 'clothing');
  const [subCategory, setSubCategory] = useState(scan.extractedSubCategory || '');
  const [gender, setGender] = useState(scan.extractedGender || 'Men');
  const [season, setSeason] = useState(scan.extractedSeason || 'All Seasons');
  const [size, setSize] = useState(scan.extractedSize || '');
  const [color, setColor] = useState(scan.extractedColor || '');
  const [material, setMaterial] = useState(scan.extractedMaterial || '');
  const [countryOfOrigin, setCountryOfOrigin] = useState(scan.extractedCountryOfOrigin || '');
  const [originalPrice, setOriginalPrice] = useState(scan.extractedOriginalPrice || '');
  const [netto, setNetto] = useState(scan.extractedNetto || '');
  const [brutto, setBrutto] = useState(scan.extractedBrutto || '');

  const [isSaving, setIsSaving] = useState(false);

  const conf = scan.confidences || {};

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await onSave(scan, {
        brandName: brandName.trim(),
        category: category.trim(),
        subCategory: subCategory.trim(),
        gender: gender.trim(),
        season: season.trim(),
        size: size.trim(),
        color: color.trim(),
        material: material.trim(),
        countryOfOrigin: countryOfOrigin.trim().toUpperCase(),
        originalPrice: originalPrice.trim(),
        netto: netto.trim(),
        brutto: brutto.trim()
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[#FFFDF9] border border-[#E6D8C1] rounded-3xl w-full max-w-2xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 bg-[#FBF6EC] border-b border-[#E6D8C1] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#86611F] text-white flex items-center justify-center font-bold text-sm shadow-md">
              <Tag className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs font-bold uppercase tracking-widest text-[#6B5442]">
                Care Label & Composition Audit
              </div>
              <h2 className="text-base sm:text-lg font-extrabold text-[#2A1D14] flex items-center gap-2">
                <span>VERIFY ITEM:</span>
                <span className="font-mono text-[#86611F]">{scan.apparelId}</span>
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-[#6B5442] hover:bg-[#F4EADA] hover:text-[#2A1D14] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-4 sm:p-6 flex flex-col gap-6">
          {/* Photo Gallery & Zoom Preview */}
          {scan.photos && scan.photos.length > 0 && (
            <div className="flex flex-col gap-2.5 bg-[#F4EADA]/60 p-3 rounded-2xl border border-[#E6D8C1]">
              <div className="relative w-full h-48 sm:h-56 bg-[#2A1D14] rounded-xl overflow-hidden shadow-inner flex items-center justify-center">
                {activePhoto ? (
                  <img
                    src={activePhoto}
                    alt={`Care label scan for ${scan.apparelId}`}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="text-[#E6D8C1] text-xs">No preview image</div>
                )}
                <div className="absolute top-2 right-2 px-2.5 py-1 rounded-lg bg-[#2A1D14]/80 text-[#E6D8C1] text-[11px] font-bold backdrop-blur-sm flex items-center gap-1.5">
                  <Eye className="w-3.5 h-3.5 text-[#BF9445]" />
                  Photo {selectedPhotoIndex + 1} of {scan.photos.length}
                </div>
              </div>

              {/* Filmstrip selector */}
              {scan.photos.length > 1 && (
                <div className="flex items-center gap-2 overflow-x-auto py-1">
                  {scan.photos.map((p, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setSelectedPhotoIndex(idx)}
                      className={`relative w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 border-2 transition-all cursor-pointer ${
                        selectedPhotoIndex === idx
                          ? 'border-[#86611F] ring-2 ring-[#86611F]/30 scale-105'
                          : 'border-transparent opacity-70 hover:opacity-100'
                      }`}
                    >
                      <img src={p} alt={`Thumbnail ${idx + 1}`} className="w-full h-full object-cover" />
                      {idx === scan.keyPhotoIndex && (
                        <div className="absolute bottom-0 inset-x-0 bg-[#86611F] text-white text-[8px] font-bold text-center">
                          KEY
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Attention Banner if applicable */}
          {scan.attentionReason && (
            <div className="flex items-start gap-2.5 p-3.5 rounded-2xl bg-[#FCEFE6] border border-[#F0CBAF] text-[#B4531B] text-xs font-medium">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-bold">Manual Review Required</div>
                <div>{scan.attentionReason}</div>
              </div>
            </div>
          )}

          {/* 12 Verified Care Attributes */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* 1. Brand Name */}
            <div className="sm:col-span-2">
              <AutocompleteInput
                label="Brand Name"
                value={brandName}
                onChange={setBrandName}
                options={BRANDS}
                placeholder="Select or enter brand name..."
                confidence={conf.brand_name}
                required
              />
            </div>

            {/* 2. Category */}
            <div className="sm:col-span-2">
              <EnumSelector
                label="Category"
                value={category}
                onChange={setCategory}
                options={CATEGORIES}
                confidence={conf.category}
              />
            </div>

            {/* 3. Sub Category */}
            <div className="sm:col-span-2">
              <AutocompleteInput
                label="Sub-Category"
                value={subCategory}
                onChange={setSubCategory}
                options={SUB_CATEGORIES}
                placeholder="Select or enter garment type (e.g. T-shirt, Jacket, Dress)..."
                confidence={conf.sub_category}
                required
              />
            </div>

            {/* 4. Gender */}
            <div className="sm:col-span-2">
              <EnumSelector
                label="Gender / Department"
                value={gender}
                onChange={setGender}
                options={GENDERS}
                confidence={conf.gender}
              />
            </div>

            {/* 5. Season */}
            <div className="sm:col-span-2">
              <EnumSelector
                label="Season"
                value={season}
                onChange={setSeason}
                options={SEASONS}
                confidence={conf.season}
              />
            </div>

            {/* 6. Size */}
            <ConfidenceField
              label="Size"
              value={size}
              onChange={setSize}
              placeholder="e.g. L, 42, 32/34..."
              confidence={conf.size}
            />

            {/* 7. Color */}
            <AutocompleteInput
              label="Dominant Color"
              value={color}
              onChange={setColor}
              options={COLORS}
              placeholder="Select color..."
              confidence={conf.color}
            />

            {/* 8. Material (Single Fibre) */}
            <div className="sm:col-span-2">
              <AutocompleteInput
                label="Material Composition (Single Fibre)"
                value={material}
                onChange={setMaterial}
                options={MATERIALS}
                placeholder="e.g. 100% Cotton, Silk, Polyester..."
                confidence={conf.material}
              />
            </div>

            {/* 9. Country of Origin */}
            <div className="sm:col-span-2">
              <AutocompleteInput
                label="Country of Origin (UPPERCASE)"
                value={countryOfOrigin}
                onChange={setCountryOfOrigin}
                options={COUNTRIES}
                placeholder="e.g. PORTUGAL, VIETNAM, ITALY..."
                confidence={conf.country_of_origin}
                uppercase
              />
            </div>

            {/* 10. Original Price */}
            <ConfidenceField
              label="Original Price"
              value={originalPrice}
              onChange={setOriginalPrice}
              placeholder="e.g. €49.95, $58.00..."
              confidence={conf.original_price}
            />

            {/* 11. Netto */}
            <ConfidenceField
              label="Netto Weight"
              value={netto}
              onChange={setNetto}
              placeholder="e.g. 240g..."
              confidence={conf.netto}
            />

            {/* 12. Brutto */}
            <div className="sm:col-span-2">
              <ConfidenceField
                label="Brutto Weight"
                value={brutto}
                onChange={setBrutto}
                placeholder="e.g. 270g..."
                confidence={conf.brutto}
              />
            </div>
          </div>

          {/* Action Bar */}
          <div className="sticky bottom-0 bg-[#FFFDF9] pt-4 border-t border-[#E6D8C1] flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-3 rounded-2xl border border-[#E6D8C1] text-[#6B5442] font-bold text-xs sm:text-sm hover:bg-[#F4EADA] transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="flex items-center gap-2 px-6 py-3 rounded-2xl bg-[#86611F] hover:bg-[#A87C2E] text-white font-bold text-xs sm:text-sm shadow-md active:scale-95 transition-all cursor-pointer disabled:opacity-50"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>{isSaving ? 'Saving...' : 'Confirm & Save to Ledger'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
