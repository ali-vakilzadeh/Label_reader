import React, { useState } from 'react';
import { ScanCamera } from '../components/ScanCamera';
import { MIN_SET_SIZE } from '../components/fields/SetSizeSelector';
import { ScanDao } from '../data/db';
import { syncEngine } from '../services/syncEngine';
import { getStickyPackageCode, loadSettings, saveSettings, setStickyPackageCode } from '../data/settingsStorage';
import { emptyGarmentFields, type ScanEntity, type TorchMode } from '../types/models';
import type { ShowToast } from '../App';

interface CaptureScreenProps {
  showToast: ShowToast;
}

/**
 * Intake, on one screen (client decisions 1-4-9, 2026-09-12).
 *
 * This component owns everything that survives a single photo - the barcode, the
 * package, the set size, the photos and the care URL - and `ScanCamera` owns only
 * what is on screen. Committing writes the record locally first and hands it to the
 * sync engine second, so an intake is never blocked on the network.
 */
export const CaptureScreen: React.FC<CaptureScreenProps> = ({ showToast }) => {
  const [barcode, setBarcode] = useState('');
  // Seeded from the last value the operator typed and left alone (decision 6).
  const [packageCode, setPackageCode] = useState(getStickyPackageCode);
  const [setSize, setSetSize] = useState(MIN_SET_SIZE);
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
    showToast(
      'success',
      value ? `Package ${value} — kept for the next scans.` : 'Package code cleared.',
      'Package'
    );
  };

  const handleBarcodeDetected = (detected: string) => {
    if (detected === barcode) return;
    setBarcode(detected);
    showToast('success', `Barcode detected: ${detected}`, 'Scanned');
  };

  const handleCapture = (dataUrl: string) => {
    setPhotos((prev) => {
      if (prev.length >= 8) return prev;
      // Nothing chosen yet, so the first photo stands in until someone - the operator
      // in the photo preview, or the model - says otherwise.
      if (prev.length === 0) setKeyPhotoIndex(0);
      return [...prev, dataUrl];
    });
  };

  /** The star in the photo preview: the operator said "this one". */
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

  /**
   * Clears the article, keeps the box.
   *
   * The package code is sticky by decision 6 - the operator is filling one carton over
   * many scans. Set size is not: it describes one article, so leaving it at 2 would
   * silently double-count the next garment.
   */
  const resetItem = () => {
    setBarcode('');
    setPhotos([]);
    setKeyPhotoIndex(0);
    setKeyPhotoExplicit(false);
    setCareInfo('');
    setSetSize(MIN_SET_SIZE);
  };

  const handleFinishItem = async () => {
    const trimmedBarcode = barcode.trim();
    if (!trimmedBarcode) {
      showToast('error', 'Scan or type a garment barcode before sending.', 'Barcode Required');
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
        setSize,
        lastAttemptTime: 0,
        retryCount: 0
      };

      await ScanDao.insertScan(newScan);
      if (settings.autoSyncAiVision) void syncEngine.submitScan(newScan);

      showToast('success', `${trimmedBarcode} queued for AI extraction.`, 'Scan Committed');
      // The operator stays on the camera for the next garment; the Review tab carries
      // the count of what is waiting.
      resetItem();
    } catch (err) {
      showToast('error', (err as Error).message || 'Failed to save scan', 'Error');
    } finally {
      setIsFinishing(false);
    }
  };

  return (
    <ScanCamera
      barcode={barcode}
      onBarcodeChange={setBarcode}
      packageCode={packageCode}
      onPackageCodeChange={handlePackageCodeChange}
      setSize={setSize}
      onSetSizeChange={setSetSize}
      photos={photos}
      keyPhotoIndex={keyPhotoIndex}
      careInfo={careInfo}
      torchMode={torchMode}
      isFinishing={isFinishing}
      onTorchModeChange={handleTorchModeChange}
      onCapture={handleCapture}
      onSetKey={handleSetKeyPhoto}
      onDeletePhoto={handleDeletePhoto}
      onBarcodeDetected={handleBarcodeDetected}
      onCareInfoDetected={handleCareInfoDetected}
      onTorchUnavailable={() =>
        showToast('info', 'This device exposes no torch control to the browser.', 'Torch Unavailable')
      }
      onFinish={handleFinishItem}
    />
  );
};
