import React from 'react';
import { Link2, Package } from 'lucide-react';
import { VocabularyPicker } from './fields/VocabularyPicker';
import { EnumPicker } from './fields/EnumPicker';
import { TextField } from './fields/TextField';
import { SetSizeSelector } from './fields/SetSizeSelector';
import { FieldShell, FIELD_BASE, FIELD_CLASS } from './fields/FieldShell';
import { useLanguage } from '../data/i18n';
import type { AiFieldKey, ArmenianLabels, GarmentFields } from '../types/models';

interface GarmentFieldsFormProps {
  fields: GarmentFields;
  onChange: (fields: GarmentFields) => void;
  /** By contract key. Absent for a record the operator is entering by hand. */
  confidences?: Partial<Record<AiFieldKey, number>>;
  /** `data_hy` from the server, when it sent any. */
  armenian?: ArmenianLabels;
  setSize: number;
  onSetSizeChange: (value: number) => void;
  packageCode: string;
  onPackageCodeChange: (value: string) => void;
  /** An exported record is read-only (client decision 1). */
  disabled?: boolean;
}

/**
 * The thirteen AI fields plus the two the operator owns, in one form.
 *
 * Shared by the review dialog and the ledger editor so a record looks and behaves the
 * same whether it is being confirmed for the first time or corrected afterwards -
 * there is no second, divergent copy of the field rules to keep in step.
 */
export const GarmentFieldsForm: React.FC<GarmentFieldsFormProps> = ({
  fields,
  onChange,
  confidences = {},
  armenian = {},
  setSize,
  onSetSizeChange,
  packageCode,
  onPackageCodeChange,
  disabled = false
}) => {
  const { t } = useLanguage();
  const set = <K extends keyof GarmentFields>(key: K, value: GarmentFields[K]) =>
    onChange({ ...fields, [key]: value });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="sm:col-span-2">
        <VocabularyPicker
          label={t('Brand')}
          table="brand"
          value={fields.brandName}
          onChange={(v) => set('brandName', v)}
          placeholder="Select or enter a brand…"
          confidence={confidences.brand_name}
          serverArmenian={armenian.brand_name}
          disabled={disabled}
          required
        />
      </div>

      <div className="sm:col-span-2">
        <EnumPicker
          label={t('Category')}
          table="category"
          value={fields.category}
          onChange={(v) => set('category', v)}
          confidence={confidences.category}
          serverArmenian={armenian.category}
          disabled={disabled}
        />
      </div>

      <div className="sm:col-span-2">
        <VocabularyPicker
          label={t('Sub-Category')}
          table="sub_category"
          value={fields.subCategory}
          onChange={(v) => set('subCategory', v)}
          placeholder="e.g. Trousers, Hoodie, Dress…"
          confidence={confidences.sub_category}
          serverArmenian={armenian.sub_category}
          disabled={disabled}
          required
        />
      </div>

      <div className="sm:col-span-2">
        <EnumPicker
          label={t('Gender')}
          table="gender"
          value={fields.gender}
          onChange={(v) => set('gender', v)}
          confidence={confidences.gender}
          serverArmenian={armenian.gender}
          disabled={disabled}
        />
      </div>

      <div className="sm:col-span-2">
        <EnumPicker
          label={t('Season')}
          table="season"
          value={fields.season}
          onChange={(v) => set('season', v)}
          confidence={confidences.season}
          serverArmenian={armenian.season}
          disabled={disabled}
        />
      </div>

      {/* Free text: European value only since v1.4, and never translated. */}
      <TextField
        label={t('Size')}
        value={fields.size}
        onChange={(v) => set('size', v)}
        placeholder="e.g. EU 122/128, XL"
        confidence={confidences.size}
        disabled={disabled}
      />

      <VocabularyPicker
        label={t('Colour')}
        table="color"
        value={fields.color}
        onChange={(v) => set('color', v)}
        placeholder="Select a colour…"
        confidence={confidences.color}
        serverArmenian={armenian.color}
        disabled={disabled}
      />

      {/*
        v1.4 sends the whole composition, not one fibre. It is displayed and stored as
        a single string - never split, re-ordered or looked up as a key - and its
        Armenian arrives ready-made in data_hy because a composition is not a table key.
      */}
      <div className="sm:col-span-2">
        <VocabularyPicker
          label={t('Material composition')}
          table="material"
          value={fields.material}
          onChange={(v) => set('material', v)}
          placeholder="e.g. 80% Cotton 20% Polyester"
          confidence={confidences.material}
          serverArmenian={armenian.material}
          disabled={disabled}
        />
      </div>

      <div className="sm:col-span-2">
        <VocabularyPicker
          label={t('Country of origin')}
          table="country"
          value={fields.countryOfOrigin}
          onChange={(v) => set('countryOfOrigin', v)}
          placeholder="e.g. VIETNAM, PORTUGAL"
          confidence={confidences.country_of_origin}
          disabled={disabled}
          uppercase
        />
      </div>

      <TextField
        label={t('Original price')}
        value={fields.originalPrice}
        onChange={(v) => set('originalPrice', v)}
        placeholder="e.g. €49.95"
        confidence={confidences.original_price}
        disabled={disabled}
      />

      <TextField
        label={t('Netto weight')}
        value={fields.netto}
        onChange={(v) => set('netto', v)}
        placeholder="e.g. 240g"
        confidence={confidences.netto}
        disabled={disabled}
      />

      <TextField
        label={t('Brutto weight')}
        value={fields.brutto}
        onChange={(v) => set('brutto', v)}
        placeholder="e.g. 290g"
        confidence={confidences.brutto}
        disabled={disabled}
      />

      {/*
        care_info is a URL read off a photograph, not a verified link. Displayed and
        stored as plain text, never rendered as something the operator can follow by
        accident, and low confidence here is normal (contract section 8.4).
      */}
      <div className="sm:col-span-2">
        <TextField
          label={t('Care info (QR URL)')}
          value={fields.careInfo}
          onChange={(v) => set('careInfo', v)}
          placeholder="Empty when no QR code was visible"
          confidence={confidences.care_info}
          disabled={disabled}
          mono
          hint={fields.careInfo ? 'Read from a QR code — check it before trusting it.' : undefined}
        />
        {fields.careInfo && (
          <div className="flex items-center gap-1.5 text-[0.75rem] text-cocoa-400 px-1 pt-1">
            <Link2 className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate">{fields.careInfo}</span>
          </div>
        )}
      </div>

      {/* Operator input. Neither of these ever crosses the API (contract 8.5). */}
      <div className="sm:col-span-2 pt-2 border-t border-cocoa-100 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldShell label={t('Package Number')} hint="CSV only — never sent to the AI.">
          <div className="relative">
            <Package className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-cocoa-400 pointer-events-none" />
            <input
              type="text"
              value={packageCode}
              disabled={disabled}
              onChange={(e) => onPackageCodeChange(e.target.value)}
              placeholder="e.g. PKG-2026-0914"
              className={`${FIELD_BASE} ${FIELD_CLASS[disabled ? 'disabled' : 'rest']} font-mono pl-9`}
            />
          </div>
        </FieldShell>

        <SetSizeSelector value={setSize} onChange={onSetSizeChange} disabled={disabled} />
      </div>
    </div>
  );
};
