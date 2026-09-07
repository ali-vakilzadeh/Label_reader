import React, { useId } from 'react';
import { Layers } from 'lucide-react';
import { FieldShell } from './FieldShell';

export const MIN_SET_SIZE = 1;
export const MAX_SET_SIZE = 10;

interface SetSizeSelectorProps {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

/**
 * "Set of X" - how many garments are inside one packaged article (client decision 12).
 *
 * One CSV row is one scanned article, so a 2-pack of stockings is ONE row with
 * SetSize=2, never two rows and never a clone. This is operator input decided after
 * extraction: it is never asked of the model and never inferred from the photos,
 * because the packaging usually hides the second item and a guess would be a
 * confident wrong answer (csv_export_format.txt section 3).
 *
 * A drag control and a discrete choice both work here; the slider is the one that
 * stays usable with a thumb, and the number is stated beside it so the value is never
 * something the operator has to read off a track.
 */
export const SetSizeSelector: React.FC<SetSizeSelectorProps> = ({ value, onChange, disabled = false }) => {
  const id = useId();
  const safe = Number.isFinite(value) && value >= MIN_SET_SIZE ? Math.min(MAX_SET_SIZE, Math.floor(value)) : 1;

  return (
    <FieldShell
      label="Set size"
      htmlFor={id}
      hint={
        safe > 1
          ? `Exported as SetSize=${safe}. Netto and Brutto stay the weight of the whole packet.`
          : 'A single garment. Leave at 1 unless the packet holds more than one.'
      }
    >
      <div
        className={`flex items-center gap-3 px-3 py-2 min-h-[44px] rounded-[var(--radius-control)] border ${
          disabled ? 'bg-cream-200 border-cocoa-200' : 'bg-white border-cocoa-200'
        }`}
      >
        <Layers className={`w-4 h-4 flex-shrink-0 ${safe > 1 ? 'text-gold-600' : 'text-cocoa-400'}`} />

        <span className="text-[0.88rem] text-navy-800 whitespace-nowrap min-w-[5.5rem]">
          Set of <strong className="font-semibold tabular-nums">{safe}</strong>
        </span>

        <input
          id={id}
          type="range"
          min={MIN_SET_SIZE}
          max={MAX_SET_SIZE}
          step={1}
          value={safe}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 accent-[color:var(--color-navy-800)] cursor-pointer disabled:cursor-not-allowed"
          aria-label={`Set size, ${safe} of a maximum ${MAX_SET_SIZE}`}
        />
      </div>
    </FieldShell>
  );
};
