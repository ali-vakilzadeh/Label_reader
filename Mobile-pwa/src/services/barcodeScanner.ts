/**
 * Barcode scanning that also works on iOS.
 *
 * Chrome on Android ships a native `BarcodeDetector`; Safari does not, which is
 * why live scanning silently did nothing on iPhone. Where the native API is
 * missing — or refuses every format we care about — we fall back to the ZXing
 * WASM ponyfill, which exposes an identical `detect()` surface.
 *
 * The ponyfill is imported lazily so Android never downloads the WASM payload,
 * and the `.wasm` binary is served from our own origin (Vite emits it into
 * `assets/` and rewrites the URL for whatever base path we deploy under) rather
 * than from a CDN, so the app keeps working offline and inside the CSP.
 */
import zxingWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

export type DetectedBarcode = { rawValue: string; format?: string };

export interface BarcodeScanner {
  detect(source: CanvasImageSource | Blob | ImageData): Promise<DetectedBarcode[]>;
}

export type ScannerEngine = 'native' | 'wasm' | 'unavailable';

export interface ScannerHandle {
  engine: ScannerEngine;
  scanner: BarcodeScanner | null;
  /** Populated when no engine could be started, for display in the viewfinder. */
  error?: string;
}

/** Formats the intake workflow expects, per the mobile app spec. */
export const SCAN_FORMATS = [
  'code_128',
  'code_39',
  'code_93',
  'codabar',
  'ean_13',
  'ean_8',
  'itf',
  'upc_a',
  'upc_e',
  'qr_code',
  'data_matrix'
] as const;

type NativeDetectorCtor = {
  new (options?: { formats?: string[] }): BarcodeScanner;
  getSupportedFormats?: () => Promise<string[]>;
};

async function tryNative(): Promise<ScannerHandle | null> {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;

  try {
    // Some builds expose the constructor but support nothing useful. Intersecting
    // with the reported list also avoids a throw on an unrecognised format name.
    const supported = (await Ctor.getSupportedFormats?.()) ?? [];
    const formats = SCAN_FORMATS.filter((f) => supported.includes(f));
    if (formats.length === 0) return null;
    return { engine: 'native', scanner: new Ctor({ formats }) };
  } catch (err) {
    console.warn('Native BarcodeDetector unusable, falling back to WASM:', err);
    return null;
  }
}

async function loadWasm(): Promise<ScannerHandle> {
  const { BarcodeDetector, setZXingModuleOverrides } = await import('barcode-detector/ponyfill');

  setZXingModuleOverrides({
    locateFile: (path: string, prefix: string) =>
      path.endsWith('.wasm') ? zxingWasmUrl : prefix + path
  });

  return {
    engine: 'wasm',
    scanner: new BarcodeDetector({ formats: [...SCAN_FORMATS] }) as BarcodeScanner
  };
}

let pending: Promise<ScannerHandle> | null = null;

/**
 * Resolves a scanner once and reuses it. Decoding is stateless, so a single
 * instance is shared across mounts of the viewfinder.
 */
export function getBarcodeScanner(): Promise<ScannerHandle> {
  if (!pending) {
    pending = (async () => {
      const native = await tryNative();
      if (native) return native;
      try {
        return await loadWasm();
      } catch (err) {
        console.error('WASM barcode engine failed to load:', err);
        return {
          engine: 'unavailable' as const,
          scanner: null,
          error: (err as Error).message || 'Scanner engine failed to load.'
        };
      }
    })();
  }
  return pending;
}
