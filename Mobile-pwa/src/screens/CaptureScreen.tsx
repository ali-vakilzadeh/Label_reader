import React, { useState } from 'react';
import { Barcode, Camera, CheckCircle2, Package, RotateCcw, Star, Trash2 } from 'lucide-react';
import { CameraViewfinder } from '../components/CameraViewfinder';
import { ScanDao } from '../data/db';
import { syncEngine } from '../services/syncEngine';
import { getStickyPackageCode, loadSettings, setStickyPackageCode } from '../data/settingsStorage';
import { emptyGarmentFields, type ScanEntity } from '../types/models';
import type { ShowToast } from '../App';

interface CaptureScreenProps {
  onScanSaved: (apparelId: string) => void;
  showToast: ShowToast;
}

export const CaptureScreen: React.FC<CaptureScreenProps> = ({ onScanSaved, showToast }) => {
  const [barcode, setBarcode] = useState('');
  // Seeded from the last value the operator typed and left alone between scans
  // (client decision 6); it only changes when they change it.
  const [packageCode, setPackageCode] = useState(getStickyPackageCode);
  const [photos, setPhotos] = useState<string[]>([]);
  const [keyPhotoIndex, setKeyPhotoIndex] = useState(0);
  const [isFinishing, setIsFinishing] = useState(false);

  const handlePhotoCaptured = (dataUrl: string) => {
    if (photos.length >= 8) {
      showToast('warning', 'Maximum 8 photos per garment.', 'Limit Reached');
      return;
    }
    setPhotos((prev) => [...prev, dataUrl]);
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
      if (keyPhotoIndex >= next.length) setKeyPhotoIndex(Math.max(0, next.length - 1));
      return next;
    });
  };

  const handlePackageCodeChange = (value: string) => {
    setPackageCode(value);
    setStickyPackageCode(value);
  };

  /** Clears the item but keeps the package code — the box has not changed. */
  const handleReset = () => {
    setBarcode('');
    setPhotos([]);
    setKeyPhotoIndex(0);
  };

  const handleFinishItem = async () => {
    const trimmedBarcode = barcode.trim();
    if (!trimmedBarcode) {
      showToast('error', 'Scan or type a garment barcode before finishing.', 'Barcode Required');
      return;
    }
    if (photos.length === 0) {
      showToast('error', 'Capture at least one care label photo.', 'Photo Required');
      return;
    }

    setIsFinishing(true);
    try {
      const settings = loadSettings();
      const newScan: ScanEntity = {
        apparelId: trimmedBarcode,
        userId: settings.userId,
        timestamp: Date.now(),
        photos,
        keyPhotoIndex: Math.min(keyPhotoIndex, photos.length - 1),
        status: 0,
        serverStored: false,
        processingStatus: 'PENDING_AI',
        queueDepth: 0,
        retryAfterSeconds: 5,
        suggestedKeyPhotoIndex: null,
        extracted: emptyGarmentFields(),
        armenian: {},
        confidences: {},
        packageCode: packageCode.trim(),
        setSize: 1,
        lastAttemptTime: 0,
        retryCount: 0
      };

      await ScanDao.insertScan(newScan);
      if (settings.autoSyncAiVision) void syncEngine.submitScan(newScan);

      showToast('success', `${trimmedBarcode} queued for AI extraction.`, 'Intake Complete');
      handleReset();
      onScanSaved(trimmedBarcode);
    } catch (err) {
      showToast('error', (err as Error).message || 'Failed to save scan', 'Error');
    } finally {
      setIsFinishing(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[0.75rem] font-semibold uppercase tracking-wider text-cocoa-600">
            Garment intake
          </div>
          <h1 className="text-[1.1rem] font-semibold text-navy-900">Barcode &amp; Care Tag Capture</h1>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--radius-control)] bg-cream-200 text-[0.75rem] text-cocoa-600">
          <Camera className="w-4 h-4" />
          <span>{photos.length}/8</span>
        </div>
      </div>

      <div className="bg-cream-50 p-4 rounded-[var(--radius-container)] border border-cocoa-200 shadow-[var(--shadow-card)] flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-[0.75rem] font-semibold uppercase tracking-wider text-cocoa-600 flex items-center gap-2" htmlFor="capture-barcode">
            <Barcode className="w-4 h-4" />
            <span>Barcode Number</span>
          </label>
          <input
            id="capture-barcode"
            type="text"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            placeholder="Scan or type manually…"
            className="w-full px-3 py-2.5 min-h-[44px] rounded-[var(--radius-control)] text-[0.88rem] font-mono bg-white border border-cocoa-200 text-navy-800 placeholder:text-cocoa-400 outline-none focus:border-gold-600"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[0.75rem] font-semibold uppercase tracking-wider text-cocoa-600 flex items-center gap-2" htmlFor="capture-package">
            <Package className="w-4 h-4" />
            <span>Package Number</span>
          </label>
          <input
            id="capture-package"
            type="text"
            value={packageCode}
            onChange={(e) => handlePackageCodeChange(e.target.value)}
            placeholder="e.g. PKG-2026-0914"
            className="w-full px-3 py-2.5 min-h-[44px] rounded-[var(--radius-control)] text-[0.88rem] font-mono bg-white border border-cocoa-200 text-navy-800 placeholder:text-cocoa-400 outline-none focus:border-gold-600"
          />
          <span className="text-[0.75rem] text-cocoa-400">
            Kept for the next scans until you change it. Manual entry only.
          </span>
        </div>
      </div>

      <CameraViewfinder
        onPhotoCaptured={handlePhotoCaptured}
        onBarcodeDetected={handleBarcodeDetected}
        isCapturing={isFinishing}
      />

      {photos.length > 0 && (
        <div className="bg-cream-50 p-4 rounded-[var(--radius-container)] border border-cocoa-200 shadow-[var(--shadow-card)] flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-[0.75rem] font-semibold uppercase tracking-wider text-cocoa-600">
              Captured labels ({photos.length}/8)
            </span>
            <span className="text-[0.75rem] text-cocoa-400">★ marks the key catalog image</span>
          </div>

          <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
            {photos.map((photo, idx) => {
              const isKey = idx === keyPhotoIndex;
              return (
                <div
                  key={idx}
                  className={`relative aspect-square rounded-[var(--radius-control)] overflow-hidden border ${
                    isKey ? 'border-gold-500' : 'border-cocoa-200'
                  }`}
                >
                  <img src={photo} alt={`Label ${idx + 1}`} className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setKeyPhotoIndex(idx)}
                    title={isKey ? 'Key photo' : 'Set as key photo'}
                    className={`absolute top-1 left-1 p-1 rounded ${
                      isKey ? 'bg-gold-500 text-navy-900' : 'bg-navy-950/60 text-cream-50'
                    }`}
                  >
                    <Star className="w-3 h-3 fill-current" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemovePhoto(idx)}
                    title="Remove photo"
                    className="absolute top-1 right-1 p-1 rounded bg-navy-950/60 text-cream-50"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleReset}
          disabled={!barcode && photos.length === 0}
          className="flex items-center gap-2 px-4 min-h-[44px] rounded-[var(--radius-control)] border border-cocoa-200 bg-cream-50 text-navy-800 font-semibold text-[0.82rem] hover:bg-cream-200 disabled:opacity-40 cursor-pointer"
        >
          <RotateCcw className="w-4 h-4" />
          <span>Reset</span>
        </button>

        <button
          type="button"
          onClick={handleFinishItem}
          disabled={isFinishing || !barcode || photos.length === 0}
          className="flex-1 flex items-center justify-center gap-2 px-4 min-h-[44px] rounded-[var(--radius-control)] bg-navy-800 text-cream-50 font-semibold text-[0.82rem] hover:bg-navy-700 active:bg-navy-950 disabled:opacity-50 cursor-pointer"
        >
          <CheckCircle2 className="w-5 h-5" />
          <span>{isFinishing ? 'Submitting…' : 'Finish Item'}</span>
        </button>
      </div>
    </div>
  );
};
