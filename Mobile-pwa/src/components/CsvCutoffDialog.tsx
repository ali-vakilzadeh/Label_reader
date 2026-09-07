import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, FileSpreadsheet } from 'lucide-react';

interface CsvCutoffDialogProps {
  batchId: string;
  count: number;
  filename: string;
  onConfirmCutoff: (batchId: string) => Promise<void>;
  onDismiss: () => void;
}

/**
 * The second half of the two-step export.
 *
 * The file is already written and its rows are already locked; this only asks whether
 * the batch was received, which is what ends the session. Dismissing is safe - the
 * rows stay in the active list, still locked, until someone confirms.
 */
export const CsvCutoffDialog: React.FC<CsvCutoffDialogProps> = ({
  batchId,
  count,
  filename,
  onConfirmCutoff,
  onDismiss
}) => {
  const [isProcessing, setIsProcessing] = useState(false);

  const handleConfirm = async () => {
    setIsProcessing(true);
    try {
      await onConfirmCutoff(batchId);
      onDismiss();
    } catch (err) {
      console.error('Error confirming CSV cut-off:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-3">
      <span className="text-cocoa-600">{label}</span>
      <span className="font-mono text-navy-900 truncate">{value}</span>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy-950/50">
      <div className="bg-cream-50 border border-cocoa-200 rounded-[var(--radius-modal)] w-full max-w-md p-5 flex flex-col gap-4 shadow-[var(--shadow-overlay)]">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-[var(--radius-control)] bg-cream-200 text-[color:var(--color-good)] flex items-center justify-center flex-shrink-0">
            <FileSpreadsheet className="w-6 h-6" />
          </div>
          <div>
            <div className="text-[0.75rem] uppercase tracking-wider text-cocoa-600">Production cut-off</div>
            <h3 className="text-[1.1rem] font-semibold text-navy-900">CSV generated</h3>
          </div>
        </div>

        <div className="bg-cream-200 p-3.5 rounded-[var(--radius-container)] border border-cocoa-200 flex flex-col gap-1.5 text-[0.82rem]">
          {row('File', filename)}
          {row('Batch', batchId)}
          {row('Records', `${count}`)}
        </div>

        <div className="flex items-start gap-2.5 p-3 rounded-[var(--radius-container)] bg-gold-100 border border-gold-500 text-[0.82rem] text-[color:var(--color-warning)]">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            Confirming marks these {count} record{count === 1 ? '' : 's'} as submitted and clears the active
            session. They remain readable in History. These rows are already read-only either way, because they
            have been written into a file.
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="px-4 min-h-[44px] rounded-[var(--radius-control)] border border-cocoa-200 text-navy-800 font-semibold text-[0.82rem] hover:bg-cream-200 cursor-pointer"
          >
            Not yet
          </button>
          <button
            type="button"
            disabled={isProcessing}
            onClick={() => void handleConfirm()}
            className="flex items-center gap-2 px-5 min-h-[44px] rounded-[var(--radius-control)] bg-navy-800 text-cream-50 font-semibold text-[0.82rem] hover:bg-navy-700 active:bg-navy-950 disabled:opacity-50 cursor-pointer"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>{isProcessing ? 'Finalising…' : 'Confirm cut-off'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
