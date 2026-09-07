import React from 'react';
import { X } from 'lucide-react';
import { CameraSurface } from './CameraSurface';
import { useCameraStream } from '../hooks/useCameraStream';
import { useCodeScanner } from '../hooks/useCodeScanner';
import { loadSettings } from '../data/settingsStorage';

interface BarcodeScannerOverlayProps {
  onDetected: (barcode: string) => void;
  onClose: () => void;
  title?: string;
}

/**
 * A full-screen barcode scanner that can be raised from anywhere - the clone dialog
 * uses it so a cloned garment's barcode can be scanned rather than typed.
 *
 * Same engine and the same 1D-only format list as the intake scanner, so a care QR
 * cannot end up as a barcode here either.
 */
export const BarcodeScannerOverlay: React.FC<BarcodeScannerOverlayProps> = ({
  onDetected,
  onClose,
  title = 'Scan the barcode'
}) => {
  const camera = useCameraStream(loadSettings().torchMode);

  useCodeScanner({
    camera,
    enabled: true,
    scanBarcodes: true,
    scanQr: false,
    onBarcode: (value) => {
      onDetected(value);
      onClose();
    }
  });

  return (
    <div className="fixed inset-0 z-[80] bg-navy-950">
      <CameraSurface camera={camera} className="absolute inset-0">
        <div className="absolute top-0 inset-x-0 safe-top safe-x px-3 py-2 flex items-center justify-between gap-2">
          <span className="px-3 py-1.5 rounded-full bg-navy-950/60 text-cream-50 text-[0.82rem]">{title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close scanner"
            className="w-11 h-11 rounded-full bg-navy-950/60 text-cream-50 flex items-center justify-center cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {camera.isLive && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="relative w-[80%] h-[45%]">
              <div className="absolute top-0 left-0 w-5 h-5 border-t-2 border-l-2 border-gold-500" />
              <div className="absolute top-0 right-0 w-5 h-5 border-t-2 border-r-2 border-gold-500" />
              <div className="absolute bottom-0 left-0 w-5 h-5 border-b-2 border-l-2 border-gold-500" />
              <div className="absolute bottom-0 right-0 w-5 h-5 border-b-2 border-r-2 border-gold-500" />
            </div>
          </div>
        )}

        <div className="absolute bottom-0 inset-x-0 safe-bottom safe-x px-4 pb-5 text-center">
          <span className="text-[0.75rem] text-cream-300">Tap to focus · pinch to zoom</span>
        </div>
      </CameraSurface>
    </div>
  );
};
