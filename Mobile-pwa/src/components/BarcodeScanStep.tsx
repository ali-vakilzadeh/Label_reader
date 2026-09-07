import React from 'react';
import { Barcode, Camera, Package, ScanBarcode } from 'lucide-react';
import { CameraSurface } from './CameraSurface';
import { useCameraStream } from '../hooks/useCameraStream';
import { useCodeScanner } from '../hooks/useCodeScanner';
import type { TorchMode } from '../types/models';

interface BarcodeScanStepProps {
  barcode: string;
  onBarcodeChange: (value: string) => void;
  packageCode: string;
  onPackageCodeChange: (value: string) => void;
  torchMode: TorchMode;
  onStartScan: () => void;
  onBarcodeDetected: (value: string) => void;
}

/**
 * The first half of an intake (client decision 5-A): the barcode scanner view, the two
 * manual fields, and the button that hands over to the camera.
 *
 * The package number is manual entry only - it is a box number the operator reads off
 * a sheet, not something printed on the garment - and it is deliberately not cleared
 * between items (decision 6).
 */
export const BarcodeScanStep: React.FC<BarcodeScanStepProps> = ({
  barcode,
  onBarcodeChange,
  packageCode,
  onPackageCodeChange,
  torchMode,
  onStartScan,
  onBarcodeDetected
}) => {
  const camera = useCameraStream(torchMode);
  const { barcodeEngine } = useCodeScanner({
    camera,
    enabled: true,
    scanBarcodes: true,
    scanQr: false,
    onBarcode: onBarcodeDetected
  });

  const fieldClass =
    'w-full px-3 py-2.5 min-h-[44px] rounded-[var(--radius-control)] text-[0.88rem] font-mono bg-white border border-cocoa-200 text-navy-800 placeholder:text-cocoa-400 outline-none focus:border-gold-600';

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-[0.75rem] font-semibold uppercase tracking-wider text-cocoa-600">
          Garment intake
        </div>
        <h1 className="text-[1.1rem] font-semibold text-navy-900">Scan the barcode</h1>
      </div>

      <CameraSurface
        camera={camera}
        className="w-full h-[52vh] min-h-[280px] rounded-[var(--radius-container)] border border-cocoa-400 bg-navy-900"
      >
        <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-control)] bg-navy-950/70">
          <ScanBarcode
            className={`w-3.5 h-3.5 ${
              barcodeEngine === 'unavailable'
                ? 'text-[color:var(--color-critical)]'
                : barcodeEngine === 'loading'
                  ? 'text-gold-500'
                  : 'text-[color:var(--color-good)]'
            }`}
          />
          <span className="text-[0.75rem] text-cream-300">
            {barcodeEngine === 'loading'
              ? 'Scanner loading'
              : barcodeEngine === 'unavailable'
                ? 'Scanner off — type the barcode'
                : 'Scanning'}
          </span>
        </div>

        {/* Static gold bracket overlay, sized to the region the decoder crops. */}
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

        {camera.zoom > 1 && (
          <div className="absolute bottom-2 right-2 px-2 py-1 rounded-full bg-navy-950/70 text-cream-50 text-[0.75rem]">
            {camera.zoom.toFixed(1)}×
          </div>
        )}
      </CameraSurface>

      <div className="bg-cream-50 p-4 rounded-[var(--radius-container)] border border-cocoa-200 shadow-[var(--shadow-card)] flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label
            className="text-[0.75rem] font-semibold uppercase tracking-wider text-cocoa-600 flex items-center gap-2"
            htmlFor="capture-barcode"
          >
            <Barcode className="w-4 h-4" />
            <span>Barcode Number</span>
          </label>
          <input
            id="capture-barcode"
            type="text"
            value={barcode}
            onChange={(e) => onBarcodeChange(e.target.value)}
            placeholder="Scan above, or type it here"
            className={fieldClass}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            className="text-[0.75rem] font-semibold uppercase tracking-wider text-cocoa-600 flex items-center gap-2"
            htmlFor="capture-package"
          >
            <Package className="w-4 h-4" />
            <span>Package Number</span>
          </label>
          <input
            id="capture-package"
            type="text"
            value={packageCode}
            onChange={(e) => onPackageCodeChange(e.target.value)}
            placeholder="e.g. PKG-2026-0914"
            className={fieldClass}
          />
          <span className="text-[0.75rem] text-cocoa-400">
            Manual entry. Kept for the next scans until you change it.
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={onStartScan}
        disabled={!barcode.trim()}
        className="flex items-center justify-center gap-2 px-4 min-h-[48px] rounded-[var(--radius-control)] bg-navy-800 text-cream-50 font-semibold text-[0.88rem] hover:bg-navy-700 active:bg-navy-950 disabled:opacity-50 cursor-pointer"
      >
        <Camera className="w-5 h-5" />
        <span>Start Scan</span>
      </button>
      {!barcode.trim() && (
        <span className="text-[0.75rem] text-cocoa-400 text-center -mt-2">
          A barcode is needed before photographing the garment.
        </span>
      )}
    </div>
  );
};
