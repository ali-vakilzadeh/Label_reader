import React from 'react';
import { AlertCircle } from 'lucide-react';

interface ConfidenceFieldProps {
  label: string;
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  confidence?: number;
  type?: string;
}

export const ConfidenceField: React.FC<ConfidenceFieldProps> = ({
  label,
  value,
  onChange,
  placeholder,
  confidence,
  type = 'text'
}) => {
  const isLowConfidence = confidence !== undefined && confidence < 0.70;
  const isMissing = !value || value.trim() === '';

  return (
    <div className="flex flex-col gap-1 w-full">
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

      <div className="relative">
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
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
      {isLowConfidence && (
        <div className="flex items-center gap-1 text-[11px] text-[#B4531B] px-1 font-medium">
          <AlertCircle className="w-3.5 h-3.5" />
          <span>Low model confidence — verify label</span>
        </div>
      )}
    </div>
  );
};
