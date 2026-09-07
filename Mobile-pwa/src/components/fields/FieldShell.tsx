import React from 'react';
import { AlertCircle, Check } from 'lucide-react';

/** Below this the extraction is highlighted for the operator to check. */
export const LOW_CONFIDENCE = 0.7;

export type FieldState = 'rest' | 'low' | 'error' | 'disabled';

export function fieldStateFor(confidence: number | undefined, disabled: boolean): FieldState {
  if (disabled) return 'disabled';
  if (confidence !== undefined && confidence < LOW_CONFIDENCE) return 'low';
  return 'rest';
}

/**
 * Field fills and borders, from the design basis "Field states" table. Colour never
 * arrives alone: every state that is not `rest` also carries a word or an icon.
 */
export const FIELD_CLASS: Record<FieldState, string> = {
  rest: 'bg-white border-cocoa-200 text-navy-800 focus:border-gold-600',
  low: 'bg-gold-100 border-gold-500 text-navy-800 focus:border-gold-600',
  error: 'bg-white border-[color:var(--color-critical)] text-navy-800',
  disabled: 'bg-cream-200 border-cocoa-200 text-cocoa-400 cursor-not-allowed'
};

export const FIELD_BASE =
  'w-full px-3 py-2.5 min-h-[44px] rounded-[var(--radius-control)] text-[0.88rem] border outline-none placeholder:text-cocoa-400 transition-colors duration-[var(--motion-fast)]';

interface FieldShellProps {
  label: string;
  required?: boolean;
  confidence?: number;
  /** Set when the value is outside its reference table (contract section 8.3 rule 5). */
  unmatched?: boolean;
  /** True when the field holds no value at all. */
  empty?: boolean;
  hint?: string;
  children: React.ReactNode;
  htmlFor?: string;
}

/**
 * Label row, confidence chip and hint, shared by every field so the three field types
 * cannot drift apart. Nothing here decides a value - it only frames one.
 */
export const FieldShell: React.FC<FieldShellProps> = ({
  label,
  required = false,
  confidence,
  unmatched = false,
  empty = false,
  hint,
  children,
  htmlFor
}) => {
  const isLow = confidence !== undefined && confidence < LOW_CONFIDENCE;

  return (
    <div className="flex flex-col gap-1 w-full">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="text-[0.75rem] font-semibold uppercase tracking-wider text-cocoa-600">
          {label}
          {required && <span className="text-[color:var(--color-critical)]"> *</span>}
        </label>

        {confidence !== undefined && (
          <span
            className={`text-[0.75rem] px-1.5 py-0.5 rounded-[var(--radius-control)] flex items-center gap-1 ${
              isLow
                ? 'bg-gold-100 text-[color:var(--color-warning)] border border-gold-500'
                : 'text-[color:var(--color-good)]'
            }`}
          >
            {isLow ? <AlertCircle className="w-3 h-3" /> : <Check className="w-3 h-3" />}
            {empty ? 'Not on the label' : `${Math.round(confidence * 100)}%`}
          </span>
        )}
      </div>

      {children}

      {unmatched && (
        <div className="flex items-center gap-1 text-[0.75rem] text-[color:var(--color-warning)] px-1">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>Not in the reference list — it will be exported exactly as written.</span>
        </div>
      )}

      {hint && <div className="text-[0.75rem] text-cocoa-400 px-1">{hint}</div>}
    </div>
  );
};
