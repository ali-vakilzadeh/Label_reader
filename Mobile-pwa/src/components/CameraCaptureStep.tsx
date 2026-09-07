import React, { useState } from 'react';
import { ArrowLeft, Check, Link2, QrCode, Star, Zap, ZapOff } from 'lucide-react';
import { CameraSurface } from './CameraSurface';
import { PhotoLightbox } from './PhotoLightbox';
import { useCameraStream } from '../hooks/useCameraStream';
import { useCodeScanner } from '../hooks/useCodeScanner';
import type { TorchMode } from '../types/models';

const MAX_PHOTOS = 8;

/** Tap cycles through the three modes (client decision 11). */
const NEXT_TORCH_MODE: Record<TorchMode, TorchMode> = { auto: 'on', on: 'off', off: 'auto' };

interface CameraCaptureStepProps {
  barcode: string;
  packageCode: string;
  photos: string[];
  keyPhotoIndex: number;
  careInfo: string;
  torchMode: TorchMode;
  isFinishing: boolean;
  onTorchModeChange: (mode: TorchMode) => void;
  onCapture: (dataUrl: string, asKey: boolean) => void;
  onSetKey: (index: number) => void;
  onDeletePhoto: (index: number) => void;
  onCareInfoDetected: (url: string) => void;
  onBack: () => void;
  onFinish: () => void;
}

/**
 * The full-screen camera (client decision 5-A and 5-B).
 *
 * A fixed overlay above everything, including the tab bar, so the preview genuinely
 * fills the screen and every control floats over it. The background stays the live
 * image throughout - nothing here paints an opaque surface over the preview.
 */
export const CameraCaptureStep: React.FC<CameraCaptureStepProps> = ({
  barcode,
  packageCode,
  photos,
  keyPhotoIndex,
  careInfo,
  torchMode,
  isFinishing,
  onTorchModeChange,
  onCapture,
  onSetKey,
  onDeletePhoto,
  onCareInfoDetected,
  onBack,
  onFinish
}) => {
  const camera = useCameraStream(torchMode);
  const [qrEnabled, setQrEnabled] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);

  useCodeScanner({
    camera,
    enabled: lightboxIndex === null,
    // The garment barcode was settled on the previous screen. Reading barcodes again
    // here could only overwrite a confirmed value with whatever drifted into frame.
    scanBarcodes: false,
    scanQr: qrEnabled,
    onQr: onCareInfoDetected
  });

  const atLimit = photos.length >= MAX_PHOTOS;

  const shoot = (asKey: boolean) => {
    if (atLimit) return;
    const dataUrl = camera.capturePhoto();
    if (!dataUrl) return;
    onCapture(dataUrl, asKey);
    // A 120ms fill change, which is all the shutter feedback the design allows.
    setFlash(true);
    window.setTimeout(() => setFlash(false), 120);
    navigator.vibrate?.(30);
  };

  const TorchIcon = torchMode === 'off' ? ZapOff : Zap;

  return (
    <div className="fixed inset-0 z-[60] bg-navy-950">
      <CameraSurface camera={camera} className="absolute inset-0" gesturesEnabled={lightboxIndex === null}>
        {flash && (
          <div className="absolute inset-0 bg-cream-50/30 pointer-events-none transition-opacity duration-[var(--motion-fast)]" />
        )}

        {/* Top chrome */}
        <div className="absolute top-0 inset-x-0 safe-top safe-x px-3 py-2 flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to barcode"
            className="w-11 h-11 rounded-full bg-navy-950/60 text-cream-50 flex items-center justify-center cursor-pointer flex-shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div className="flex flex-col items-center gap-1 min-w-0">
            <span className="px-3 py-1 rounded-full bg-navy-950/60 text-cream-50 text-[0.82rem] font-mono truncate max-w-[52vw]">
              {barcode}
            </span>
            {packageCode && (
              <span className="px-2 py-0.5 rounded-full bg-navy-950/50 text-cream-300 text-[0.75rem] font-mono truncate max-w-[52vw]">
                {packageCode}
              </span>
            )}
          </div>

          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            {camera.capabilities.torch && (
              <button
                type="button"
                onClick={() => onTorchModeChange(NEXT_TORCH_MODE[torchMode])}
                aria-label={`Torch ${torchMode}`}
                className={`relative w-11 h-11 rounded-full flex items-center justify-center cursor-pointer ${
                  camera.torchActive ? 'bg-gold-500 text-navy-900' : 'bg-navy-950/60 text-cream-50'
                }`}
              >
                <TorchIcon className="w-5 h-5" />
                {torchMode === 'auto' && (
                  <span className="absolute bottom-1 right-1.5 text-[9px] font-bold leading-none">A</span>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={() => setQrEnabled((v) => !v)}
              aria-label={qrEnabled ? 'Turn the QR reader off' : 'Turn the QR reader on'}
              aria-pressed={qrEnabled}
              className={`w-11 h-11 rounded-full flex items-center justify-center cursor-pointer ${
                qrEnabled ? 'bg-gold-500 text-navy-900' : 'bg-navy-950/60 text-cream-50'
              }`}
            >
              <QrCode className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Status line: photo count, zoom, and the care URL once one is decoded. */}
        <div className="absolute top-1/2 inset-x-0 -translate-y-1/2 pointer-events-none flex flex-col items-center gap-2">
          {qrEnabled && !careInfo && (
            <span className="px-3 py-1 rounded-full bg-navy-950/60 text-cream-300 text-[0.75rem]">
              Point at the care QR code
            </span>
          )}
          {careInfo && (
            <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-[color:var(--color-good)] text-cream-50 text-[0.75rem] max-w-[80vw]">
              <Link2 className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="truncate">{careInfo}</span>
            </span>
          )}
        </div>

        {/* Bottom chrome */}
        <div className="absolute bottom-0 inset-x-0 safe-bottom safe-x px-3 pb-3 flex flex-col gap-3">
          {photos.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {photos.map((photo, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setLightboxIndex(idx)}
                  aria-label={`Open photo ${idx + 1}`}
                  className={`relative w-14 h-14 rounded-[var(--radius-control)] overflow-hidden flex-shrink-0 border-2 cursor-pointer ${
                    idx === keyPhotoIndex ? 'border-gold-500' : 'border-cream-50/40'
                  }`}
                >
                  <img src={photo} alt="" className="w-full h-full object-cover" />
                  {idx === keyPhotoIndex && (
                    <Star className="absolute bottom-0.5 right-0.5 w-3 h-3 text-gold-500 fill-current" />
                  )}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            {/* Shoot as key photo - the small star beside the main shutter. */}
            <button
              type="button"
              onClick={() => shoot(true)}
              disabled={atLimit || !camera.isLive}
              aria-label="Take photo and set it as the key photo"
              className="w-12 h-12 rounded-full bg-navy-950/60 text-gold-500 border border-gold-500 flex items-center justify-center cursor-pointer disabled:opacity-40"
            >
              <Star className="w-5 h-5 fill-current" />
            </button>

            <button
              type="button"
              onClick={() => shoot(false)}
              disabled={atLimit || !camera.isLive}
              aria-label="Take photo"
              className="w-[72px] h-[72px] rounded-full bg-navy-800 border-4 border-cream-50 active:bg-navy-950 flex items-center justify-center cursor-pointer disabled:opacity-40"
            >
              <span className="text-cream-50 text-[0.75rem] font-semibold">
                {photos.length}/{MAX_PHOTOS}
              </span>
            </button>

            <button
              type="button"
              onClick={onFinish}
              disabled={photos.length === 0 || isFinishing}
              aria-label="Finish this item"
              className="w-12 h-12 rounded-full bg-[color:var(--color-good)] text-cream-50 flex items-center justify-center cursor-pointer disabled:opacity-40"
            >
              <Check className="w-6 h-6" />
            </button>
          </div>

          <div className="flex items-center justify-center gap-3 text-[0.75rem] text-cream-300">
            {atLimit ? (
              <span>Maximum {MAX_PHOTOS} photos reached</span>
            ) : (
              <span>Tap to focus · pinch to zoom{camera.zoom > 1 ? ` · ${camera.zoom.toFixed(1)}×` : ''}</span>
            )}
          </div>
        </div>
      </CameraSurface>

      {lightboxIndex !== null && photos[lightboxIndex] && (
        <PhotoLightbox
          photos={photos}
          index={lightboxIndex}
          isKey={lightboxIndex === keyPhotoIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          onSetKey={(i) => onSetKey(i)}
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
