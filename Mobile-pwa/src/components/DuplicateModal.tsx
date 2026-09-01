import React, { useState } from 'react';
import { Copy, X, Sparkles } from 'lucide-react';
import type { DailyLedgerEntity } from '../types/models';
import { getNextDemoBarcode } from '../data/settingsStorage';

interface DuplicateModalProps {
  sourceItem: DailyLedgerEntity;
  onClose: () => void;
  onDuplicate: (originalId: string, newBarcode: string) => Promise<void>;
}

export const DuplicateModal: React.FC<DuplicateModalProps> = ({
  sourceItem,
  onClose,
  onDuplicate
}) => {
  const [newBarcode, setNewBarcode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newBarcode.trim();
    if (!trimmed) {
      setError('Please enter a target barcode for the cloned garment.');
      return;
    }
    if (trimmed === sourceItem.apparelId) {
      setError('New barcode must be distinct from original.');
      return;
    }

    setIsSubmitting(true);
    try {
      await onDuplicate(sourceItem.apparelId, trimmed);
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Failed to clone item');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGenRandom = () => {
    setNewBarcode(getNextDemoBarcode());
    setError(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[#FFFDF9] border border-[#E6D8C1] rounded-3xl w-full max-w-md p-6 flex flex-col gap-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#86611F] text-white flex items-center justify-center font-bold text-sm shadow-md">
              <Copy className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs font-bold uppercase tracking-widest text-[#6B5442]">
                Composition Cloning
              </div>
              <h3 className="text-base font-extrabold text-[#2A1D14]">
                Clone Garment Attributes
              </h3>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-[#6B5442] hover:bg-[#F4EADA] hover:text-[#2A1D14] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="bg-[#F4EADA]/60 p-3.5 rounded-2xl border border-[#E6D8C1] flex flex-col gap-1 text-xs">
          <div className="text-[#6B5442] font-semibold">Copying Verified Template From:</div>
          <div className="font-bold text-[#2A1D14] flex items-center gap-2">
            <span className="font-mono text-[#86611F]">{sourceItem.apparelId}</span>
            <span>•</span>
            <span>{sourceItem.brandName}</span>
            <span>•</span>
            <span>{sourceItem.subCategory} ({sourceItem.size})</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#6B5442]">
              New Garment Barcode / ID
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newBarcode}
                onChange={(e) => {
                  setNewBarcode(e.target.value);
                  setError(null);
                }}
                placeholder="Scan or enter new barcode..."
                className="flex-1 px-3.5 py-2.5 rounded-xl text-sm font-mono font-medium bg-[#FFFDF9] border border-[#E6D8C1] text-[#2A1D14] outline-none focus:border-[#86611F] focus:ring-1 focus:ring-[#86611F]"
              />
              <button
                type="button"
                onClick={handleGenRandom}
                title="Generate Demo Barcode"
                className="px-3 py-2.5 rounded-xl bg-[#F4EADA] hover:bg-[#E6D8C1] text-[#6B5442] text-xs font-semibold flex items-center gap-1 border border-[#E6D8C1] transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5 text-[#BF9445]" />
                Auto
              </button>
            </div>
            {error && <div className="text-xs text-[#B4531B] font-medium">{error}</div>}
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-[#E6D8C1] text-[#6B5442] font-semibold text-xs hover:bg-[#F4EADA] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-[#86611F] hover:bg-[#A87C2E] text-white font-bold text-xs shadow-md transition-all active:scale-95 disabled:opacity-50"
            >
              <Copy className="w-4 h-4" />
              <span>{isSubmitting ? 'Cloning...' : 'Clone & Add to Active'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
