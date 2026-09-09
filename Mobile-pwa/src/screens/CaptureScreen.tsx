import React, { useState } from 'react';
import { BarcodeScanStep } from '../components/BarcodeScanStep';
import { CameraCaptureStep } from '../components/CameraCaptureStep';
import { ScanDao } from '../data/db';
import { syncEngine } from '../services/syncEngine';
import { getStickyPackageCode, loadSettings, saveSettings, setStickyPackageCode } from '../data/settingsStorage';
import { emptyGarmentFields, type ScanEntity, type TorchMode } from '../types/models';
import type { ShowToast } from '../App';

interface CaptureScreenProps {
  onScanSaved: (apparelId: string) => void;
  showToast: ShowToast;
}

type Phase = 'barcode' | 'camera';

/**
 * Intake, in two phases (client decision 5-A).
 *
 * Phase one settles the identity of the item - the barcode, scanned or typed, and the
 * package it is going into. Phase two is the full-screen camera. Splitting them is
 * what lets the camera fill the screen: there are no form fields left to make room for.
 */
export const CaptureScreen: React.FC<CaptureScreenProps> = ({ onScanSaved, showToast }) => {
  const [phase, setPhase] = useState<Phase>('barcode');
  const [barcode, setBarcode] = useState('');
  // Seeded from the last value the operator typed and left alone (decision 6).
  const [packageCode, setPackageCode] = useState(getStickyPackageCode);
  const [photos, setPhotos] = useState<string[]>([]);
  const [keyPhotoIndex, setKeyPhotoIndex] = useState(0);
  // False while the key photo is only the app's default - the first shot taken. The
  // model's suggestion is allowed to replace a default, never a deliberate choice.
  const [keyPhotoExplicit, setKeyPhotoExplicit] = useState(false);
  const [careInfo, setCareInfo] = useState('');
  const [torchMode, setTorchMode] = useState<TorchMode>(() => loadSettings().torchMode);
  const [isFinishing, setIsFinishing] = useState(false);

  const handleTorchModeChange = (mode: TorchMode) => {
    setTorchMode(mode);
    saveSettings({ torchMode: mode });
  };

  const handlePackageCodeChange = (value: string) => {
    setPackageCode(value);
    setStickyPackageCode(value);
  };

  const handleBarcodeDetected = (detected: string) => {
    // Only fills an empty field. Overwriting a barcode the operator has already
    // accepted would let a code drifting through frame silently reassign the item.
    if (barcode.trim()) return;
    setBarcode(detected);
    showToast('success', `Barcode detected: ${detected}`, 'Scanned');
  };

  const handleCapture = (dataUrl: string, asKey: boolean) => {
    setPhotos((prev) => {
      if (prev.length >= 8) return prev;
      const next = [...prev, dataUrl];
      if (asKey) {
        // The star shutter: the operator said "this one".
        setKeyPhotoIndex(next.length - 1);
        setKeyPhotoExplicit(true);
      } else if (prev.length === 0) {
        // Nothing chosen yet, so the first photo stands in until someone - the
        // operator or the model - says otherwise.
        setKeyPhotoIndex(0);
      }
      return next;
    });
  };

  /** The star in the photo viewer. Same meaning as the star shutter. */
  const handleSetKeyPhoto = (index: number) => {
    setKeyPhotoIndex(index);
    setKeyPhotoExplicit(true);
  };

  const handleDeletePhoto = (index: number) => {
    setPhotos((prev) => {
      const next = prev.filter((_, i) => i !== index);
      setKeyPhotoIndex((current) => {
        if (index === current) {
          // The chosen photo is gone, so the record is back on the default and the
          // model's suggestion becomes useful again.
          setKeyPhotoExplicit(false);
          return 0;
        }
        return index < current ? current - 1 : current;
      });
      return next;
    });
  };

  const handleCareInfoDetected = (url: string) => {
    if (careInfo === url) return;
    setCareInfo(url);
    showToast('success', 'Care QR code read into CareInfo.', 'QR Decoded');
  };

  /** Clears the item but keeps the package code — the box has not changed. */
  const resetItem = () => {
    setBarcode('');
    setPhotos([]);
    setKeyPhotoIndex(0);
    setKeyPhotoExplicit(false);
    setCareInfo('');
    setPhase('barcode');
  };

  const handleFinishItem = async () => {
    const trimmedBarcode = barcode.trim();
    if (!trimmedBarcode) {
      showToast('error', 'Scan or type a garment barcode before finishing.', 'Barcode Required');
      setPhase('barcode');
      return;
    }
    if (photos.length === 0) {
      showToast('error', 'Capture at least one care label photo.', 'Photo Required');
      return;
    }

    setIsFinishing(true);
    try {
      const settings = loadSettings();
      const extracted = emptyGarmentFields();
      // A QR read on the device is a real value for the field. It is also kept in
      // `deviceCareInfo`, which is what actually makes it survive: the AI result
      // replaces `extracted` wholesale, and the device's read outranks the model's.
      if (careInfo) extracted.careInfo = careInfo;

      const newScan: ScanEntity = {
        apparelId: trimmedBarcode,
        userId: settings.userId,
        timestamp: Date.now(),
        photos,
        keyPhotoIndex: Math.min(keyPhotoIndex, photos.length - 1),
        keyPhotoExplicit,
        deviceCareInfo: careInfo || undefined,
        status: 0,
        serverStored: false,
        processingStatus: 'PENDING_AI',
        queueDepth: 0,
        retryAfterSeconds: 5,
        suggestedKeyPhotoIndex: null,
        extracted,
        armenian: {},
        confidences: careInfo ? { care_info: 1 } : {},
        packageCode: packageCode.trim(),
        setSize: 1,
        lastAttemptTime: 0,
        retryCount: 0
      };

      await ScanDao.insertScan(newScan);
      if (settings.autoSyncAiVision) void syncEngine.submitScan(newScan);

      showToast('success', `${trimmedBarcode} queued for AI extraction.`, 'Intake Complete');
      resetItem();
      onScanSaved(trimmedBarcode);
    } catch (err) {
      showToast('error', (err as Error).message || 'Failed to save scan', 'Error');
    } finally {
      setIsFinishing(false);
    }
  };

  if (phase === 'camera') {
    return (
      <CameraCaptureStep
        barcode={barcode}
        packageCode={packageCode}
        photos={photos}
        keyPhotoIndex={keyPhotoIndex}
        careInfo={careInfo}
        torchMode={torchMode}
        isFinishing={isFinishing}
        onTorchModeChange={handleTorchModeChange}
        onCapture={handleCapture}
        onSetKey={handleSetKeyPhoto}
        onDeletePhoto={handleDeletePhoto}
        onCareInfoDetected={handleCareInfoDetected}
        onBack={() => setPhase('barcode')}
        onFinish={handleFinishItem}
      />
    );
  }

  return (
    <BarcodeScanStep
      barcode={barcode}
      onBarcodeChange={setBarcode}
      packageCode={packageCode}
      onPackageCodeChange={handlePackageCodeChange}
      torchMode={torchMode}
      onStartScan={() => setPhase('camera')}
      onBarcodeDetected={handleBarcodeDetected}
    />
  );
};
