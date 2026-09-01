import React, { useState } from 'react';
import { Camera, Barcode, Trash2, Star, CheckCircle2, RotateCcw, Sparkles } from 'lucide-react';
import { CameraViewfinder } from '../components/CameraViewfinder';
import { ScanDao } from '../data/db';
import { syncEngine } from '../services/syncEngine';
import { loadSettings, getNextDemoBarcode } from '../data/settingsStorage';
import type { ScanEntity } from '../types/models';

interface CaptureScreenProps {
  onScanSaved: (apparelId: string) => void;
  showToast: (type: 'success' | 'warning' | 'error' | 'info', message: string, title?: string) => void;
}

export const CaptureScreen: React.FC<CaptureScreenProps> = ({ onScanSaved, showToast }) => {
  const [barcode, setBarcode] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [keyPhotoIndex, setKeyPhotoIndex] = useState(0);
  const [isFinishing, setIsFinishing] = useState(false);

  const handlePhotoCaptured = (dataUrl: string) => {
    if (photos.length >= 8) {
      showToast('warning', 'Maximum 8 photos allowed per garment intake.', 'Limit Reached');
      return;
    }
    setPhotos((prev) => [...prev, dataUrl]);
    showToast('info', `Photo ${photos.length + 1} added to batch.`, 'Photo Captured');
  };

  const handleBarcodeDetected = (detected: string) => {
    if (!barcode) {
      setBarcode(detected);
      showToast('success', `Barcode detected: ${detected}`, 'Scanned');
    }
  };

  const handleRemovePhoto = (index: number) => {
    setPhotos((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (keyPhotoIndex >= next.length) {
        setKeyPhotoIndex(Math.max(0, next.length - 1));
      }
      return next;
    });
  };

  const handleReset = () => {
    setBarcode('');
    setPhotos([]);
    setKeyPhotoIndex(0);
  };

  const handleFinishItem = async () => {
    const trimmedBarcode = barcode.trim();
    if (!trimmedBarcode) {
      showToast('error', 'Please enter or scan a garment barcode / ID before finishing.', 'Barcode Required');
      return;
    }

    if (photos.length === 0) {
      showToast('error', 'Please capture at least one care label photo before submitting.', 'Photo Required');
      return;
    }

    setIsFinishing(true);
    try {
      const settings = loadSettings();
      const newScan: ScanEntity = {
        apparelId: trimmedBarcode,
        userId: settings.userId,
        timestamp: Date.now(),
        photos: photos,
        keyPhotoIndex: Math.min(keyPhotoIndex, photos.length - 1),
        status: 0, // PENDING_VISION
        serverStored: false,
        processingStatus: 'PENDING_AI',
        queueDepth: 0,
        retryAfterSeconds: 5,
        extractedCategory: '',
        extractedSubCategory: '',
        extractedGender: '',
        extractedSeason: '',
        extractedBrandName: '',
        extractedCountryOfOrigin: '',
        extractedSize: '',
        extractedColor: '',
        extractedMaterial: '',
        extractedOriginalPrice: '',
        extractedNetto: '',
        extractedBrutto: '',
        confidences: {},
        lastAttemptTime: 0,
        retryCount: 0
      };

      await ScanDao.insertScan(newScan);
      
      // Trigger background sync
      if (settings.autoSyncAiVision) {
        syncEngine.submitScan(newScan);
      }

      showToast('success', `Item ${trimmedBarcode} submitted to AI extraction queue.`, 'Garment Intake Complete');
      handleReset();
      onScanSaved(trimmedBarcode);
    } catch (err) {
      showToast('error', (err as Error).message || 'Failed to save scan', 'Error');
    } finally {
      setIsFinishing(false);
    }
  };

  const handleGenerateBarcode = () => {
    const gen = getNextDemoBarcode();
    setBarcode(gen);
    showToast('info', `Generated Demo Barcode: ${gen}`, 'Auto Barcode');
  };

  return (
    <div className="flex flex-col gap-5 pb-20">
      {/* Screen Title Bar */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] font-extrabold uppercase tracking-widest text-[#86611F]">
            GARMENT INTAKE
          </div>
          <h1 className="text-xl sm:text-2xl font-black text-[#2A1D14] tracking-tight">
            Barcode & Care Tag Capture
          </h1>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#F4EADA] border border-[#E6D8C1] text-xs font-semibold text-[#6B5442]">
          <Camera className="w-4 h-4 text-[#86611F]" />
          <span>{photos.length}/8 Photos</span>
        </div>
      </div>

      {/* Barcode Intake Card */}
      <div className="bg-[#FFFDF9] p-4 rounded-3xl border border-[#E6D8C1] shadow-sm flex flex-col gap-3">
        <label className="text-xs font-bold uppercase tracking-wider text-[#6B5442] flex items-center gap-2">
          <Barcode className="w-4 h-4 text-[#86611F]" />
          <span>Garment Barcode / Article ID</span>
        </label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            placeholder="Scan barcode or type manually..."
            className="flex-1 px-4 py-3 rounded-2xl text-sm font-mono font-medium bg-[#FBF6EC] border border-[#E6D8C1] text-[#2A1D14] outline-none focus:border-[#86611F] focus:ring-1 focus:ring-[#86611F]"
          />
          <button
            type="button"
            onClick={handleGenerateBarcode}
            title="Generate Demo Barcode"
            className="px-3.5 py-3 rounded-2xl bg-[#F4EADA] hover:bg-[#E6D8C1] text-[#6B5442] text-xs font-bold flex items-center gap-1.5 border border-[#E6D8C1] transition-all cursor-pointer active:scale-95"
          >
            <Sparkles className="w-4 h-4 text-[#BF9445]" />
            <span>Auto ID</span>
          </button>
        </div>
      </div>

      {/* Live Camera Viewfinder */}
      <div className="flex flex-col gap-2">
        <CameraViewfinder
          onPhotoCaptured={handlePhotoCaptured}
          onBarcodeDetected={handleBarcodeDetected}
          isCapturing={isFinishing}
        />
      </div>

      {/* Captured Care Labels Carousel */}
      {photos.length > 0 && (
        <div className="bg-[#FFFDF9] p-4 rounded-3xl border border-[#E6D8C1] shadow-sm flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-[#6B5442]">
              Captured Care Labels ({photos.length}/8)
            </span>
            <span className="text-[11px] text-[#7D6650]">
              ★ Tap star on thumbnail to set Key catalog image
            </span>
          </div>

          <div className="grid grid-cols-4 sm:grid-cols-8 gap-2.5">
            {photos.map((photo, idx) => {
              const isKey = idx === keyPhotoIndex;
              return (
                <div
                  key={idx}
                  className={`relative aspect-square rounded-2xl overflow-hidden border-2 transition-all group ${
                    isKey ? 'border-[#86611F] shadow-md ring-2 ring-[#86611F]/20' : 'border-[#E6D8C1]'
                  }`}
                >
                  <img src={photo} alt={`Label photo ${idx + 1}`} className="w-full h-full object-cover" />
                  
                  {/* Key Star Toggle */}
                  <button
                    type="button"
                    onClick={() => setKeyPhotoIndex(idx)}
                    title={isKey ? 'Primary Key Photo' : 'Set as Key Photo'}
                    className={`absolute top-1 left-1 p-1 rounded-lg backdrop-blur-sm transition-colors ${
                      isKey ? 'bg-[#86611F] text-white shadow-sm' : 'bg-black/60 text-white/80 hover:text-white'
                    }`}
                  >
                    <Star className="w-3 h-3 fill-current" />
                  </button>

                  {/* Delete Button */}
                  <button
                    type="button"
                    onClick={() => handleRemovePhoto(idx)}
                    title="Remove Photo"
                    className="absolute top-1 right-1 p-1 rounded-lg bg-black/60 text-white/80 hover:text-red-400 backdrop-blur-sm transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>

                  <div className="absolute bottom-1 inset-x-1 bg-black/60 text-white text-[9px] font-bold text-center rounded py-0.5 backdrop-blur-sm">
                    {idx + 1}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Action Footer */}
      <div className="flex items-center justify-between gap-3 pt-2">
        <button
          type="button"
          onClick={handleReset}
          disabled={!barcode && photos.length === 0}
          className="flex items-center gap-2 px-5 py-3.5 rounded-2xl border border-[#E6D8C1] text-[#6B5442] hover:bg-[#F4EADA] font-bold text-xs sm:text-sm transition-all disabled:opacity-40"
        >
          <RotateCcw className="w-4 h-4" />
          <span>Reset Intake</span>
        </button>

        <button
          type="button"
          onClick={handleFinishItem}
          disabled={isFinishing || !barcode || photos.length === 0}
          className="flex-1 flex items-center justify-center gap-2 px-6 py-3.5 rounded-2xl bg-[#86611F] hover:bg-[#A87C2E] text-white font-extrabold text-xs sm:text-sm shadow-lg active:scale-95 transition-all disabled:opacity-40 cursor-pointer"
        >
          <CheckCircle2 className="w-5 h-5" />
          <span>{isFinishing ? 'Submitting to AI...' : 'Finish Item (Extract AI)'}</span>
        </button>
      </div>
    </div>
  );
};
