import React, { useEffect, useId, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { FieldShell, FIELD_BASE, FIELD_CLASS, fieldStateFor } from './FieldShell';
import { isValueUnmatched, labelFor, suggestionsFor, useVocabulary } from '../../data/vocabulary';
import { useLanguage } from '../../data/i18n';
import type { TableName } from '../../data/referenceTables';

interface VocabularyPickerProps {
  label: string;
  table: TableName;
  /** The stored English key. */
  value: string;
  onChange: (english: string) => void;
  placeholder?: string;
  confidence?: number;
  disabled?: boolean;
  required?: boolean;
  uppercase?: boolean;
  /** Armenian for this value as the server rendered it, when it sent one. */
  serverArmenian?: string | null;
}

/**
 * A searchable picker over one reference table.
 *
 * The operator reads and searches Armenian; the app writes the English key behind it.
 * This is the single most effective thing the app can do to keep the ledger groupable,
 * because it removes the opportunity to type a variant spelling at all
 * (api_contract.md section 9).
 *
 * Free text is still accepted: when a garment type is genuinely absent from the 295,
 * what the operator typed is stored verbatim and flows through as an unmatched value
 * for a supervisor to canonicalise. Nothing is silently corrected on the device.
 */
export const VocabularyPicker: React.FC<VocabularyPickerProps> = ({
  label,
  table,
  value,
  onChange,
  placeholder,
  confidence,
  disabled = false,
  required = false,
  uppercase = false,
  serverArmenian
}) => {
  const id = useId();
  const { language } = useLanguage();
  // Re-render when a sync replaces the tables, so an open picker is never stale.
  useVocabulary();

  const containerRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  /** What the operator has typed. Empty means "show the stored value". */
  const [query, setQuery] = useState<string | null>(null);

  useEffect(() => {
    const onClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setQuery(null);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const state = fieldStateFor(confidence, disabled);
  const unmatched = Boolean(value.trim()) && isValueUnmatched(table, value);

  // In Armenian mode the box shows the Armenian label, but the English key is what
  // onChange emits and what is stored. data_hy wins where the server sent one.
  const armenianLabel = serverArmenian || undefined;
  const displayed =
    query !== null ? query : language === 'hy' ? armenianLabel ?? labelFor(table, value) : value;

  const suggestions = suggestionsFor(table, query ?? '', 8);

  const commit = (english: string) => {
    onChange(uppercase ? english.toUpperCase() : english);
    setQuery(null);
    setIsOpen(false);
  };

  return (
    <div className="relative w-full" ref={containerRef}>
      <FieldShell
        label={label}
        required={required}
        confidence={confidence}
        empty={!value.trim()}
        unmatched={unmatched}
        htmlFor={id}
      >
        <input
          id={id}
          type="text"
          value={displayed}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
            // Typing is a free-text entry until a suggestion is chosen; store it as
            // typed so an absent term is never lost.
            onChange(uppercase ? e.target.value.toUpperCase() : e.target.value);
          }}
          onFocus={() => !disabled && setIsOpen(true)}
          placeholder={placeholder}
          autoComplete="off"
          className={`${FIELD_BASE} ${FIELD_CLASS[state]}`}
        />
      </FieldShell>

      {isOpen && !disabled && suggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-30 mt-1 bg-cream-50 border border-cocoa-200 rounded-[var(--radius-control)] shadow-[var(--shadow-overlay)] max-h-52 overflow-y-auto p-1 flex flex-col gap-0.5">
          {suggestions.map((hit) => {
            const isSelected = hit.en.toLowerCase() === value.toLowerCase();
            return (
              <button
                key={hit.en}
                type="button"
                onClick={() => commit(hit.en)}
                className={`flex items-center justify-between gap-2 px-3 min-h-[40px] rounded-[var(--radius-control)] text-[0.82rem] text-left cursor-pointer ${
                  isSelected ? 'bg-navy-800 text-cream-50' : 'text-navy-800 hover:bg-cream-200'
                }`}
              >
                <span className="flex flex-col">
                  <span>{language === 'hy' ? hit.label : hit.en}</span>
                  {/* The other language stays visible: an operator working in Armenian
                      still needs to see the English key that will be exported. */}
                  {language === 'hy' && hit.hy && (
                    <span className={`text-[0.75rem] ${isSelected ? 'text-cream-300' : 'text-cocoa-400'}`}>
                      {hit.en}
                    </span>
                  )}
                </span>
                {isSelected && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
