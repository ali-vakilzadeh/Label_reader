import { useEffect, useRef, useState } from 'react';
import {
  getBarcodeScanner,
  isCareUrl,
  pickBestResult,
  type BarcodeScanner,
  type ScannerEngine
} from '../services/barcodeScanner';
import type { CameraController } from './useCameraStream';

/** Frames are downscaled to this width before decoding. */
const SCAN_WIDTH = 1280;
const SCAN_INTERVAL_MS = 220;
/** The same tag decodes several times a second; ignore repeats for this long. */
const REPEAT_SUPPRESS_MS = 2500;

/**
 * The middle band of the frame, matching the on-screen reticle: 80% of the width and
 * 45% of the height, centred. Scanning this crop at full sensor resolution puts far
 * more pixels across each bar than downscaling the whole 1080p frame does, which is
 * what a thin EAN-13 needs.
 */
const ROI = { width: 0.8, height: 0.45 };

interface UseCodeScannerOptions {
  camera: CameraController;
  enabled: boolean;
  /** Read 1D garment barcodes. */
  scanBarcodes?: boolean;
  /** Read QR / DataMatrix, for the care URL. Off unless the operator asks. */
  scanQr?: boolean;
  onBarcode?: (value: string) => void;
  onQr?: (url: string) => void;
}

export interface ScannerStatus {
  barcodeEngine: ScannerEngine | 'loading';
  qrEngine: ScannerEngine | 'loading';
}

/**
 * Runs the decode loop against the live preview.
 *
 * Barcodes and QR codes are decoded by *separate* engines with disjoint format lists,
 * so a care QR can never be mistaken for a garment barcode - see barcodeScanner.ts.
 * Each pass alternates between the reticle crop and the whole frame, so a barcode the
 * operator has not centred still resolves, just a beat later.
 */
export function useCodeScanner({
  camera,
  enabled,
  scanBarcodes = true,
  scanQr = false,
  onBarcode,
  onQr
}: UseCodeScannerOptions): ScannerStatus {
  const barcodeScannerRef = useRef<BarcodeScanner | null>(null);
  const qrScannerRef = useRef<BarcodeScanner | null>(null);
  const roiCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastHitRef = useRef(new Map<string, number>());

  // Held in refs so a re-rendered parent does not tear the loop down and restart it,
  // which is what an `onBarcode` dependency used to do several times a second.
  const onBarcodeRef = useRef(onBarcode);
  const onQrRef = useRef(onQr);
  useEffect(() => {
    onBarcodeRef.current = onBarcode;
    onQrRef.current = onQr;
  }, [onBarcode, onQr]);

  const [status, setStatus] = useState<ScannerStatus>({
    barcodeEngine: 'loading',
    qrEngine: 'loading'
  });

  useEffect(() => {
    let cancelled = false;
    if (scanBarcodes) {
      void getBarcodeScanner('barcode').then((handle) => {
        if (cancelled) return;
        barcodeScannerRef.current = handle.scanner;
        setStatus((s) => ({ ...s, barcodeEngine: handle.engine }));
      });
    }
    if (scanQr) {
      void getBarcodeScanner('qr').then((handle) => {
        if (cancelled) return;
        qrScannerRef.current = handle.scanner;
        setStatus((s) => ({ ...s, qrEngine: handle.engine }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [scanBarcodes, scanQr]);

  /** Collapses the repeat hits from decoding one symbol several times a second. */
  const shouldEmit = (value: string): boolean => {
    const now = Date.now();
    const last = lastHitRef.current.get(value);
    if (last !== undefined && now - last < REPEAT_SUPPRESS_MS) return false;
    lastHitRef.current.set(value, now);
    return true;
  };

  /** The reticle crop, taken from the full-resolution frame. */
  const grabRoi = (): HTMLCanvasElement | null => {
    const video = camera.videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return null;

    const cropWidth = video.videoWidth * ROI.width;
    const cropHeight = video.videoHeight * ROI.height;
    const cropX = (video.videoWidth - cropWidth) / 2;
    const cropY = (video.videoHeight - cropHeight) / 2;

    const canvas = roiCanvasRef.current ?? (roiCanvasRef.current = document.createElement('canvas'));
    const scale = Math.min(1, SCAN_WIDTH / cropWidth);
    canvas.width = Math.round(cropWidth * scale);
    canvas.height = Math.round(cropHeight * scale);

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    return canvas;
  };

  useEffect(() => {
    if (!enabled || !camera.isLive) return;

    let running = true;
    let timer = 0;
    let useRoi = true;

    const scanOnce = async () => {
      if (!running) return;

      const frame = useRoi ? grabRoi() : camera.grabFrame(SCAN_WIDTH);
      useRoi = !useRoi;

      // The engine may still be downloading; keep looping until it lands.
      if (!frame) {
        if (running) timer = window.setTimeout(scanOnce, 300);
        return;
      }

      if (scanBarcodes && barcodeScannerRef.current) {
        try {
          const results = await barcodeScannerRef.current.detect(frame);
          const best = pickBestResult(results, frame.width, frame.height);
          const value = best?.rawValue?.trim();
          if (value && shouldEmit(value)) {
            navigator.vibrate?.(60);
            onBarcodeRef.current?.(value);
          }
        } catch {
          // A frame that does not decode is the normal case; keep scanning.
        }
      }

      if (scanQr && qrScannerRef.current) {
        try {
          const results = await qrScannerRef.current.detect(frame);
          for (const result of results) {
            const value = result.rawValue?.trim();
            // Only a URL is of any use as CareInfo; other QR payloads are ignored
            // rather than written into the field as noise.
            if (value && isCareUrl(value) && shouldEmit(value)) {
              navigator.vibrate?.(40);
              onQrRef.current?.(value);
              break;
            }
          }
        } catch {
          // Same as above.
        }
      }

      if (running) timer = window.setTimeout(scanOnce, SCAN_INTERVAL_MS);
    };

    void scanOnce();

    return () => {
      running = false;
      clearTimeout(timer);
    };
    // grabRoi closes over refs only, so it is stable in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, camera.isLive, scanBarcodes, scanQr, camera.grabFrame]);

  return status;
}
