import React, { useState, useRef, useEffect } from 'react';
import { searchVocabulary } from '../data/vocabulary';
import { Check, AlertCircle } from 'lucide-react';

interface AutocompleteInputProps {
  label: string;
  value: string;
  onChange: (val: string) => void;
  options: string[];
  placeholder?: string;
  confidence?: number;
  uppercase?: boolean;
  required?: boolean;
}

export const AutocompleteInput: React.FC<AutocompleteInputProps> = ({
  label,
  value,
  onChange,
  options,
  placeholder,
  confidence,
  uppercase = false,
  required = false
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSuggestions(searchVocabulary(options, value, 8));
  }, [value, options]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const isLowConfidence = confidence !== undefined && confidence < 0.70;
  const isMissing = !value || value.trim() === '';

  const handleSelect = (item: string) => {
    onChange(uppercase ? item.toUpperCase() : item);
    setIsOpen(false);
  };

  return (
    <div className="relative flex flex-col gap-1 w-full" ref={containerRef}>
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold uppercase tracking-wider text-[#6B5442] flex items-center gap-1.5">
          {label}
          {required && <span className="text-[#B4531B]">*</span>}
        </label>
        {confidence !== undefined && (
          <span
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
              isLowConfidence
                ? 'bg-[#FCEFE6] text-[#B4531B] border border-[#F0CBAF]'
                : 'bg-[#DCFCE7] text-[#166534]'
            }`}
          >
            {isMissing ? 'Missing from scan' : `${Math.round(confidence * 100)}% Conf.`}
          </span>
        )}
      </div>

      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => {
            const val = uppercase ? e.target.value.toUpperCase() : e.target.value;
            onChange(val);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder || `Enter ${label.toLowerCase()}...`}
          className={`w-full px-3.5 py-2.5 rounded-xl text-sm font-medium border transition-colors outline-none ${
            isLowConfidence
              ? 'bg-[#FCEFE6] border-[#F0CBAF] text-[#2A1D14] focus:border-[#B4531B] focus:ring-1 focus:ring-[#B4531B]'
              : 'bg-[#FFFDF9] border-[#E6D8C1] text-[#2A1D14] focus:border-[#86611F] focus:ring-1 focus:ring-[#86611F]'
          }`}
        />
        {isLowConfidence && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-[#D2691E]">
            <AlertCircle className="w-4 h-4" />
          </div>
        )}
      </div>

      {isOpen && suggestions.length > 0 && (
        <div className="absolute top-[102%] left-0 right-0 z-30 bg-[#FFFDF9] border border-[#E6D8C1] rounded-xl shadow-xl max-h-48 overflow-y-auto p-1.5 flex flex-col gap-1">
          {suggestions.map((item) => {
            const isSelected = item.toLowerCase() === value.toLowerCase();
            return (
              <button
                key={item}
                type="button"
                onClick={() => handleSelect(item)}
                className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium text-left transition-colors ${
                  isSelected
                    ? 'bg-[#86611F] text-white font-bold'
                    : 'text-[#2A1D14] hover:bg-[#F4EADA]'
                }`}
              >
                <span>{item}</span>
                {isSelected && <Check className="w-3.5 h-3.5" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
