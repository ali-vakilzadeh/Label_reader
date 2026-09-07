/**
 * Barcode and QR decoding, on Android and iOS alike.
 *
 * Chrome on Android ships a native `BarcodeDetector`; Safari does not, which is why
 * live scanning silently did nothing on iPhone. Where the native API is missing - or
 * refuses every format we care about - we fall back to the ZXing WASM ponyfill, which
 * exposes an identical `detect()` surface. The ponyfill is imported lazily so Android
 * never downloads the WASM payload, and the `.wasm` is served from our own origin so
 * the app keeps working offline and inside the CSP.
 *
 * **The two kinds are kept apart on purpose.** A garment's care label very often
 * carries a QR code beside the barcode. When one detector was asked for both, the QR
 * won as often as not and its URL was written into the barcode field - the app then
 * submitted a scan keyed on a care URL. That was the "scanner not functioning
 * correctly" fault. Barcodes now resolve from 1D formats only, and the QR reader is a
 * separate, explicitly-enabled detector whose output goes to CareInfo and nowhere else.
 */
import zxingWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

export type DetectedBarcode = {
  rawValue: string;
  format?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
};

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

/** What a garment barcode can be. One-dimensional formats only - never QR. */
export const BARCODE_FORMATS = [
  'code_128',
  'code_39',
  'code_93',
  'codabar',
  'ean_13',
  'ean_8',
  'itf',
  'upc_a',
  'upc_e'
] as const;

/** Two-dimensional formats, read only when the operator turns the QR reader on. */
export const QR_FORMATS = ['qr_code', 'data_matrix'] as const;

export type BarcodeFormat = (typeof BARCODE_FORMATS)[number];
export type QrFormat = (typeof QR_FORMATS)[number];
/** Narrower than `string[]`, so the ponyfill's own format union accepts it directly. */
export type ScanFormat = BarcodeFormat | QrFormat;

export type ScanKind = 'barcode' | 'qr';

const FORMATS_FOR: Record<ScanKind, readonly ScanFormat[]> = {
  barcode: BARCODE_FORMATS,
  qr: QR_FORMATS
};

type NativeDetectorCtor = {
  new (options?: { formats?: ScanFormat[] }): BarcodeScanner;
  getSupportedFormats?: () => Promise<string[]>;
};

async function tryNative(kind: ScanKind): Promise<ScannerHandle | null> {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;

  try {
    // Some builds expose the constructor but support nothing useful. Intersecting with
    // the reported list also avoids a throw on an unrecognised format name.
    const supported = (await Ctor.getSupportedFormats?.()) ?? [];
    const formats = FORMATS_FOR[kind].filter((f) => supported.includes(f));
    if (formats.length === 0) return null;
    return { engine: 'native', scanner: new Ctor({ formats }) };
  } catch (err) {
    console.warn(`Native BarcodeDetector unusable for ${kind}, falling back to WASM:`, err);
    return null;
  }
}

let wasmOverridesSet = false;

async function loadWasm(kind: ScanKind): Promise<ScannerHandle> {
  const { BarcodeDetector, setZXingModuleOverrides } = await import('barcode-detector/ponyfill');

  // Setting the overrides twice would re-locate an already-instantiated module.
  if (!wasmOverridesSet) {
    setZXingModuleOverrides({
      locateFile: (path: string, prefix: string) =>
        path.endsWith('.wasm') ? zxingWasmUrl : prefix + path
    });
    wasmOverridesSet = true;
  }

  return {
    engine: 'wasm',
    scanner: new BarcodeDetector({ formats: [...FORMATS_FOR[kind]] }) as BarcodeScanner
  };
}

const pending: Partial<Record<ScanKind, Promise<ScannerHandle>>> = {};

/**
 * Resolves a scanner once per kind and reuses it. Decoding is stateless, so one
 * instance is shared across mounts of the viewfinder.
 */
export function getBarcodeScanner(kind: ScanKind = 'barcode'): Promise<ScannerHandle> {
  const existing = pending[kind];
  if (existing) return existing;

  const created = (async (): Promise<ScannerHandle> => {
    const native = await tryNative(kind);
    if (native) return native;
    try {
      return await loadWasm(kind);
    } catch (err) {
      console.error(`WASM barcode engine failed to load for ${kind}:`, err);
      return {
        engine: 'unavailable' as const,
        scanner: null,
        error: (err as Error).message || 'Scanner engine failed to load.'
      };
    }
  })();

  pending[kind] = created;
  return created;
}

/**
 * Picks one result from a frame that decoded several.
 *
 * Taking `results[0]` meant whichever symbol the engine happened to emit first won,
 * so a label with two barcodes gave a different answer frame to frame. The operator
 * aims at what they want, so the symbol nearest the centre of the frame wins, and the
 * larger one breaks a tie - a distant barcode in the background never outranks the one
 * being held up to the lens.
 */
export function pickBestResult(
  results: DetectedBarcode[],
  frameWidth: number,
  frameHeight: number
): DetectedBarcode | null {
  const usable = results.filter((r) => r.rawValue?.trim());
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0];

  const cx = frameWidth / 2;
  const cy = frameHeight / 2;

  let best = usable[0];
  let bestScore = -Infinity;

  for (const result of usable) {
    const box = result.boundingBox;
    if (!box) continue;
    const dx = box.x + box.width / 2 - cx;
    const dy = box.y + box.height / 2 - cy;
    const distance = Math.hypot(dx, dy);
    const area = box.width * box.height;
    // Normalised so the two terms are comparable regardless of frame size.
    const score = area / (frameWidth * frameHeight) - distance / Math.hypot(frameWidth, frameHeight);
    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  }

  return best;
}

/** A care QR must decode to a URL; anything else is a code we have no use for. */
export function isCareUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}
