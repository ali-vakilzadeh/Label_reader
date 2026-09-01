import React from 'react';
import { FileSpreadsheet, CheckCircle2, AlertCircle } from 'lucide-react';

interface CsvCutoffDialogProps {
  batchId: string;
  count: number;
  filename: string;
  onConfirmCutoff: (batchId: string) => Promise<void>;
  onDismiss: () => void;
}

export const CsvCutoffDialog: React.FC<CsvCutoffDialogProps> = ({
  batchId,
  count,
  filename,
  onConfirmCutoff,
  onDismiss
}) => {
  const [isProcessing, setIsProcessing] = React.useState(false);

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[#FFFDF9] border border-[#E6D8C1] rounded-3xl w-full max-w-md p-6 flex flex-col gap-5 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-[#DCFCE7] text-[#166534] flex items-center justify-center flex-shrink-0 shadow-sm">
            <FileSpreadsheet className="w-6 h-6" />
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-widest text-[#6B5442]">
              Two-Step Production Cut-Off
            </div>
            <h3 className="text-base font-extrabold text-[#2A1D14]">
              CSV Generated Successfully
            </h3>
          </div>
        </div>

        <div className="bg-[#F4EADA]/60 p-4 rounded-2xl border border-[#E6D8C1] flex flex-col gap-2 text-xs text-[#4D3B2C]">
          <div className="flex justify-between">
            <span className="font-semibold">Export File:</span>
            <span className="font-mono text-[#86611F] truncate max-w-[200px]">{filename}</span>
          </div>
          <div className="flex justify-between">
            <span className="font-semibold">Batch Stamp:</span>
            <span className="font-mono font-bold text-[#2A1D14]">{batchId}</span>
          </div>
          <div className="flex justify-between">
            <span className="font-semibold">Items Exported:</span>
            <span className="font-bold text-[#166534]">{count} garments</span>
          </div>
        </div>

        <div className="flex items-start gap-2.5 p-3 rounded-xl bg-[#FCEFE6] text-[#B4531B] text-xs font-medium border border-[#F0CBAF]">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            Confirming will mark these {count} items as submitted and reset your active session counter to 0. All records remain safely accessible in the History Archive.
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onDismiss}
            className="px-4 py-2.5 rounded-xl border border-[#E6D8C1] text-[#6B5442] font-semibold text-xs hover:bg-[#F4EADA] transition-colors"
          >
            Keep in Active Session
          </button>
          <button
            type="button"
            disabled={isProcessing}
            onClick={handleConfirm}
            className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-[#86611F] hover:bg-[#A87C2E] text-white font-bold text-xs shadow-md transition-all active:scale-95 disabled:opacity-50"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>{isProcessing ? 'Finalizing...' : 'Confirm Session Cut-Off'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
