import React from 'react';
import { AlertCircle } from 'lucide-react';

interface EnumSelectorProps {
  label: string;
  value: string;
  onChange: (val: string) => void;
  options: string[];
  confidence?: number;
}

export const EnumSelector: React.FC<EnumSelectorProps> = ({
  label,
  value,
  onChange,
  options,
  confidence
}) => {
  const isLowConfidence = confidence !== undefined && confidence < 0.70;
  const isMissing = !value || value.trim() === '';

  return (
    <div className="flex flex-col gap-1.5 w-full">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold uppercase tracking-wider text-[#6B5442]">
          {label}
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

      <div
        className={`flex flex-wrap gap-1.5 p-1.5 rounded-xl border ${
          isLowConfidence ? 'bg-[#FCEFE6] border-[#F0CBAF]' : 'bg-[#F4EADA] border-[#E6D8C1]'
        }`}
      >
        {options.map((opt) => {
          const isSelected = opt.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all cursor-pointer ${
                isSelected
                  ? 'bg-[#86611F] text-white shadow-sm ring-1 ring-[#86611F]'
                  : 'bg-[#FFFDF9] text-[#6B5442] hover:text-[#2A1D14] hover:bg-white border border-[#E6D8C1]'
              }`}
            >
              {opt}
            </button>
          );
        })}
      </div>
      {isLowConfidence && (
        <div className="flex items-center gap-1 text-[11px] text-[#B4531B] px-1 font-medium">
          <AlertCircle className="w-3.5 h-3.5" />
          <span>Low model confidence — verify label on physical garment</span>
        </div>
      )}
    </div>
  );
};
