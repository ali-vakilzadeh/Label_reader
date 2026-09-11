import React, { useState } from 'react';
import { Barcode, Link2, Minus, Package, Pencil, Plus, QrCode, Send, X, Zap, ZapOff } from 'lucide-react';
import { CameraSurface } from './CameraSurface';
import { PhotoLightbox } from './PhotoLightbox';
import { MAX_SET_SIZE, MIN_SET_SIZE } from './fields/SetSizeSelector';
import { useCameraStream } from '../hooks/useCameraStream';
import { useCodeScanner } from '../hooks/useCodeScanner';
import type { TorchMode } from '../types/models';

const MAX_PHOTOS = 8;

/** Tap cycles off -> on -> auto (client decision 4-6). */
const NEXT_TORCH_MODE: Record<TorchMode, TorchMode> = { off: 'on', on: 'auto', auto: 'off' };

/** Which decoder is running over the preview. `null` is the resting state. */
type ScanMode = 'barcode' | 'qr' | null;

interface ScanCameraProps {
  barcode: string;
  onBarcodeChange: (value: string) => void;
  packageCode: string;
  onPackageCodeChange: (value: string) => void;
  setSize: number;
  onSetSizeChange: (value: number) => void;
  photos: string[];
  keyPhotoIndex: number;
  careInfo: string;
  torchMode: TorchMode;
  isFinishing: boolean;
  onTorchModeChange: (mode: TorchMode) => void;
  onCapture: (dataUrl: string) => void;
  onSetKey: (index: number) => void;
  onDeletePhoto: (index: number) => void;
  onBarcodeDetected: (value: string) => void;
  onCareInfoDetected: (url: string) => void;
  onTorchUnavailable: () => void;
  onFinish: () => void;
}

/**
 * The whole of intake on one screen (client decisions 1-4-9, 2026-09-12).
 *
 * The preview is full bleed and everything else floats on top of it: the barcode the
 * item is keyed on, the package it is going into, the set size, the photos taken so
 * far, and the four controls. There is no second page and no scroll - the surface is
 * exactly the space between the status bar and the tab bar, and it never moves.
 *
 * The two decoders are mutually exclusive. Only one can be armed at a time, and each
 * disarms itself the moment it resolves, so a code drifting through frame afterwards
 * cannot quietly reassign the item.
 */
export const ScanCamera: React.FC<ScanCameraProps> = ({
  barcode,
  onBarcodeChange,
  packageCode,
  onPackageCodeChange,
  setSize,
  onSetSizeChange,
  photos,
  keyPhotoIndex,
  careInfo,
  torchMode,
  isFinishing,
  onTorchModeChange,
  onCapture,
  onSetKey,
  onDeletePhoto,
  onBarcodeDetected,
  onCareInfoDetected,
  onTorchUnavailable,
  onFinish
}) => {
  const camera = useCameraStream(torchMode);
  const [scanMode, setScanMode] = useState<ScanMode>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [dialog, setDialog] = useState<'barcode' | 'package' | null>(null);
  const [draftBarcode, setDraftBarcode] = useState('');
  const [draftPackage, setDraftPackage] = useState('');
  const [flash, setFlash] = useState(false);

  const overlayOpen = lightboxIndex !== null || dialog !== null;

  useCodeScanner({
    camera,
    enabled: scanMode !== null && !overlayOpen,
    scanBarcodes: scanMode === 'barcode',
    scanQr: scanMode === 'qr',
    onBarcode: (value) => {
      // The operator armed this deliberately, so a hit replaces whatever was there -
      // re-scanning a mistyped code is the reason they pressed the button.
      onBarcodeDetected(value);
      setScanMode(null);
    },
    onQr: (url) => {
      onCareInfoDetected(url);
      setScanMode(null);
    }
  });

  const atLimit = photos.length >= MAX_PHOTOS;
  const canShoot = !atLimit && camera.isLive;

  const shoot = () => {
    if (!canShoot) return;
    const dataUrl = camera.capturePhoto();
    if (!dataUrl) return;
    onCapture(dataUrl);
    // A 120ms fill change, which is all the shutter feedback the design allows.
    setFlash(true);
    window.setTimeout(() => setFlash(false), 120);
    navigator.vibrate?.(30);
  };

  const toggleScanMode = (mode: Exclude<ScanMode, null>) =>
    setScanMode((current) => (current === mode ? null : mode));

  const cycleTorch = () => {
    if (!camera.capabilities.torch) {
      onTorchUnavailable();
      return;
    }
    onTorchModeChange(NEXT_TORCH_MODE[torchMode]);
  };

  const openBarcodeDialog = () => {
    setDraftBarcode(barcode);
    setDialog('barcode');
  };

  const openPackageDialog = () => {
    setDraftPackage(packageCode);
    setDialog('package');
  };

  const commitDialog = () => {
    if (dialog === 'barcode') onBarcodeChange(draftBarcode.trim());
    if (dialog === 'package') onPackageCodeChange(draftPackage.trim());
    setDialog(null);
  };

  const TorchIcon = torchMode === 'off' ? ZapOff : Zap;
  const glass = 'bg-navy-950/75 border border-cream-50/20 text-cream-50';
  const controlBase =
    'rounded-full flex items-center justify-center cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-[var(--motion-fast)]';

  return (
    <div className="relative w-full h-full overflow-hidden bg-navy-950">
      <CameraSurface camera={camera} className="absolute inset-0" gesturesEnabled={!overlayOpen}>
        {flash && <div className="absolute inset-0 bg-cream-50/30 pointer-events-none" />}

        {/* The item's identity. Tapping it types the barcode by hand, which is the only
            way in when a label is torn and the decoder can make nothing of it.
            The notch inset goes on the wrapper: as padding on the pill itself it would
            pad the inside of the button and sit its text off-centre. */}
        <div className="absolute top-0 inset-x-0 safe-top pt-3 flex justify-center px-14 pointer-events-none">
          <button
            type="button"
            onClick={openBarcodeDialog}
            className={`pointer-events-auto max-w-full flex items-center gap-2 px-3 py-2 rounded-full cursor-pointer ${glass} ${
              barcode ? 'border-gold-500' : ''
            }`}
          >
            <Barcode className={`w-4 h-4 flex-shrink-0 ${barcode ? 'text-gold-500' : 'text-cocoa-200'}`} />
            <span className="text-[0.82rem] font-mono truncate">
              {barcode
                ? `${barcode}${careInfo ? ' · URL attached' : ''}`
                : careInfo
                  ? 'URL attached — barcode still needed'
                  : 'No barcode yet — tap to type'}
            </span>
            <Pencil className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />
          </button>
        </div>

        {/* Right rail: torch, package, set size. */}
        <div className="absolute top-[4.5rem] right-3 safe-top flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={cycleTorch}
            aria-label={`Torch ${torchMode}`}
            className={`relative w-11 h-11 rounded-full flex items-center justify-center cursor-pointer ${
              camera.torchActive ? 'bg-gold-500 text-navy-900 border border-gold-500' : glass
            } ${camera.capabilities.torch ? '' : 'opacity-50'}`}
          >
            <TorchIcon className="w-5 h-5" />
            {torchMode === 'auto' && (
              <span className="absolute bottom-1 right-1.5 text-[9px] font-bold leading-none">A</span>
            )}
          </button>

          <button
            type="button"
            onClick={openPackageDialog}
            aria-label={packageCode ? `Package ${packageCode}` : 'Set the package code'}
            className={`relative w-11 h-11 rounded-[12px] flex items-center justify-center cursor-pointer ${glass} ${
              packageCode ? 'border-gold-500 text-gold-500' : ''
            }`}
          >
            <Package className="w-5 h-5" />
            {packageCode && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-gold-500" />
            )}
          </button>

          {/* Set size. One packet, several garments - written to the CSV SetSize column. */}
          <div className={`w-[50px] h-[150px] rounded-[14px] overflow-hidden grid grid-rows-3 ${glass}`}>
            <button
              type="button"
              onClick={() => onSetSizeChange(Math.min(MAX_SET_SIZE, setSize + 1))}
              disabled={setSize >= MAX_SET_SIZE}
              aria-label="Increase set size"
              className="flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Plus className="w-4 h-4" />
            </button>
            <div
              className={`flex items-center justify-center border-y border-cream-50/20 text-[1.15rem] font-bold tabular-nums ${
                setSize > 1 ? 'text-gold-500' : ''
              }`}
              aria-live="polite"
              aria-label={`Set of ${setSize}`}
            >
              {setSize}
            </div>
            <button
              type="button"
              onClick={() => onSetSizeChange(Math.max(MIN_SET_SIZE, setSize - 1))}
              disabled={setSize <= MIN_SET_SIZE}
              aria-label="Decrease set size"
              className="flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Minus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Eight slots, outlined from the start so the operator can see how many shots
            are left without counting what they have already taken. */}
        <div className="absolute left-3 top-[4.5rem] bottom-[calc(7rem+env(safe-area-inset-bottom,0px))] safe-top flex flex-col gap-2 overflow-y-auto">
          {Array.from({ length: MAX_PHOTOS }, (_, idx) => {
            const photo = photos[idx];
            if (!photo) {
              return (
                <div
                  key={idx}
                  className="w-11 h-11 flex-shrink-0 rounded-[10px] border border-cream-50/35 bg-cream-50/5 flex items-center justify-center text-[0.7rem] text-cream-50/50 tabular-nums"
                >
                  {idx + 1}
                </div>
              );
            }
            return (
              <div key={idx} className="relative flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setLightboxIndex(idx)}
                  aria-label={`Open photo ${idx + 1}`}
                  className={`w-11 h-11 rounded-[10px] overflow-hidden border-2 cursor-pointer ${
                    idx === keyPhotoIndex ? 'border-gold-500' : 'border-cream-50'
                  }`}
                >
                  <img src={photo} alt="" className="w-full h-full object-cover" />
                </button>
                <button
                  type="button"
                  onClick={() => onDeletePhoto(idx)}
                  aria-label={`Remove photo ${idx + 1}`}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-navy-950 border border-cream-50/40 text-cream-50 flex items-center justify-center cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Reticle, drawn over the crop the decoder actually reads. */}
        {scanMode && camera.isLive && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className={`relative ${scanMode === 'qr' ? 'w-[56%] h-[30%]' : 'w-[80%] h-[34%]'}`}>
              <div className="absolute top-0 left-0 w-5 h-5 border-t-2 border-l-2 border-gold-500" />
              <div className="absolute top-0 right-0 w-5 h-5 border-t-2 border-r-2 border-gold-500" />
              <div className="absolute bottom-0 left-0 w-5 h-5 border-b-2 border-l-2 border-gold-500" />
              <div className="absolute bottom-0 right-0 w-5 h-5 border-b-2 border-r-2 border-gold-500" />
            </div>
          </div>
        )}

        {/* One status line, directly above the controls. */}
        <div className="absolute bottom-[calc(6.5rem+env(safe-area-inset-bottom,0px))] inset-x-0 pointer-events-none flex flex-col items-center gap-2 px-4">
          {scanMode && (
            <span className={`px-3 py-1 rounded-full text-[0.75rem] ${glass}`}>
              {scanMode === 'qr' ? 'Point at the care QR code' : 'Scanning for a barcode'}
            </span>
          )}
          {careInfo && !scanMode && (
            <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-[color:var(--color-good)] text-cream-50 text-[0.75rem] max-w-full">
              <Link2 className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="truncate">{careInfo}</span>
            </span>
          )}
          {atLimit && !scanMode && (
            <span className={`px-3 py-1 rounded-full text-[0.75rem] ${glass}`}>
              Maximum {MAX_PHOTOS} photos reached
            </span>
          )}
        </div>

        {/* Shoot · barcode · QR · send. The outer two are 70px, the inner two 58px.
            The home-indicator inset is folded into one padding-bottom rather than set
            twice: `safe-bottom` and a Tailwind `pb-*` would fight over the property,
            and whichever lost would take either the gap or the inset with it. */}
        <div
          className="absolute bottom-0 inset-x-0 safe-x flex items-center justify-evenly"
          style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <button
            type="button"
            onClick={shoot}
            disabled={!canShoot}
            aria-label="Take photo"
            className={`${controlBase} w-[70px] h-[70px] bg-cream-50 border-[3px] border-cream-50 shadow-[0_0_0_2px_rgba(8,24,44,0.3)] active:bg-cream-300`}
          />

          <button
            type="button"
            onClick={() => toggleScanMode('barcode')}
            aria-label="Scan barcode"
            aria-pressed={scanMode === 'barcode'}
            className={`${controlBase} w-[58px] h-[58px] ${
              scanMode === 'barcode' ? 'bg-gold-500 text-navy-900 border border-gold-500' : glass
            }`}
          >
            <Barcode className="w-6 h-6" />
          </button>

          <button
            type="button"
            onClick={() => toggleScanMode('qr')}
            aria-label="Scan QR code"
            aria-pressed={scanMode === 'qr'}
            className={`${controlBase} w-[58px] h-[58px] ${
              scanMode === 'qr' ? 'bg-gold-500 text-navy-900 border border-gold-500' : glass
            }`}
          >
            <QrCode className="w-6 h-6" />
          </button>

          <button
            type="button"
            onClick={onFinish}
            disabled={isFinishing}
            aria-label="Finish and commit this item"
            className={`${controlBase} w-[70px] h-[70px] bg-gold-500 text-navy-900 border border-gold-500 active:bg-gold-600`}
          >
            <Send className="w-6 h-6" />
          </button>
        </div>
      </CameraSurface>

      {/* Barcode and package both take one short string, so they share a dialog. */}
      {dialog && (
        <div className="absolute inset-0 z-10 bg-navy-950/70 flex items-center justify-center p-5">
          <div className="w-full max-w-sm bg-cream-50 rounded-[var(--radius-modal)] p-4 flex flex-col gap-3 shadow-[var(--shadow-overlay)]">
            <h3 className="text-[0.95rem] font-semibold text-navy-900">
              {dialog === 'barcode' ? 'Barcode' : 'Package code'}
            </h3>
            <label
              className="text-[0.75rem] font-semibold uppercase tracking-wider text-cocoa-600"
              htmlFor="scan-dialog-input"
            >
              {dialog === 'barcode' ? 'Type it, or scan with the barcode button' : 'Box this item goes into'}
            </label>
            <input
              id="scan-dialog-input"
              type="text"
              autoFocus
              value={dialog === 'barcode' ? draftBarcode : draftPackage}
              onChange={(e) =>
                dialog === 'barcode' ? setDraftBarcode(e.target.value) : setDraftPackage(e.target.value)
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitDialog();
                if (e.key === 'Escape') setDialog(null);
              }}
              placeholder={dialog === 'barcode' ? '890123456789' : 'PKG-2026-0914'}
              className="w-full px-3 py-2.5 min-h-[44px] rounded-[var(--radius-control)] text-[0.88rem] font-mono bg-white border border-cocoa-200 text-navy-800 placeholder:text-cocoa-400 outline-none focus:border-gold-600"
            />
            {dialog === 'package' && (
              <span className="text-[0.75rem] text-cocoa-600 -mt-1">
                Kept for the next scans until you change it.
              </span>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setDialog(null)}
                className="px-4 min-h-[44px] rounded-[var(--radius-control)] text-[0.82rem] font-semibold text-cocoa-600 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={commitDialog}
                className="px-4 min-h-[44px] rounded-[var(--radius-control)] bg-navy-800 text-cream-50 text-[0.82rem] font-semibold hover:bg-navy-700 cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {lightboxIndex !== null && photos[lightboxIndex] && (
        <PhotoLightbox
          photos={photos}
          index={lightboxIndex}
          isKey={lightboxIndex === keyPhotoIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          onSetKey={onSetKey}
          onDelete={(i) => {
            onDeletePhoto(i);
            // Step back rather than closing, so deleting one of several keeps the
            // operator in the preview they were working through.
            setLightboxIndex(photos.length <= 1 ? null : Math.max(0, i - 1));
          }}
        />
      )}
    </div>
  );
};
