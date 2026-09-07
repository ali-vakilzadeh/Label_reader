import React from 'react';
import { FieldShell } from './FieldShell';
import { useVocabulary, vocabulary } from '../../data/vocabulary';
import { useLanguage } from '../../data/i18n';
import type { TableName } from '../../data/referenceTables';

interface EnumPickerProps {
  label: string;
  table: TableName;
  value: string;
  onChange: (english: string) => void;
  confidence?: number;
  disabled?: boolean;
  serverArmenian?: string | null;
}

/**
 * Chips for the short vocabularies - category, gender, season.
 *
 * These four are safe to hardcode for validation but NOT for display: their Armenian
 * labels come from the served tables and a supervisor can add a value to any of them
 * (contract section 8.2). So the options are read from the same store as every other
 * picker rather than from a constant.
 */
export const EnumPicker: React.FC<EnumPickerProps> = ({
  label,
  table,
  value,
  onChange,
  confidence,
  disabled = false,
  serverArmenian
}) => {
  const { language } = useLanguage();
  useVocabulary();

  const entries = vocabulary.table(table).entries;

  return (
    <FieldShell label={label} confidence={confidence} empty={!value.trim()}>
      <div
        className={`flex flex-wrap gap-1.5 p-1.5 rounded-[var(--radius-control)] border ${
          disabled ? 'bg-cream-200 border-cocoa-200' : 'bg-cream-200 border-cocoa-200'
        }`}
      >
        {entries.map((entry) => {
          const isSelected = entry.en.toLowerCase() === value.toLowerCase();
          // data_hy wins for the selected value; the table supplies the rest.
          const text =
            language === 'hy' ? (isSelected && serverArmenian) || entry.hy || entry.en : entry.en;

          return (
            <button
              key={entry.en}
              type="button"
              disabled={disabled}
              onClick={() => onChange(entry.en)}
              className={`px-3 min-h-[36px] rounded-[var(--radius-control)] text-[0.82rem] transition-colors duration-[var(--motion-fast)] ${
                isSelected
                  ? 'bg-navy-800 text-cream-50'
                  : 'bg-cream-50 text-navy-800 border border-cocoa-200 hover:bg-white'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              {text}
            </button>
          );
        })}

        {/* A value the model returned that is not in the table still has to be visible
            and selected, or confirming the record would silently drop it. */}
        {value.trim() && !entries.some((e) => e.en.toLowerCase() === value.toLowerCase()) && (
          <span className="px-3 min-h-[36px] flex items-center rounded-[var(--radius-control)] text-[0.82rem] bg-gold-100 text-[color:var(--color-warning)] border border-gold-500">
            {value}
          </span>
        )}
      </div>
    </FieldShell>
  );
};
