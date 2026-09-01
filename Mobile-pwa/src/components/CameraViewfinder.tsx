import React, { useRef, useState, useEffect } from 'react';
import { Camera, Zap, ZapOff, Upload, Sparkles, RefreshCw, ScanBarcode } from 'lucide-react';
import { getBarcodeScanner } from '../services/barcodeScanner';
import type { BarcodeScanner, ScannerEngine } from '../services/barcodeScanner';

/** Frames are downscaled to this width before decoding. */
const SCAN_WIDTH = 1280;
const SCAN_INTERVAL_MS = 250;
/** The same tag decodes several times a second; ignore repeats for this long. */
const REPEAT_SUPPRESS_MS = 2500;

interface CameraViewfinderProps {
  onPhotoCaptured: (dataUrl: string) => void;
  onBarcodeDetected?: (barcode: string) => void;
  isCapturing?: boolean;
}

export const CameraViewfinder: React.FC<CameraViewfinderProps> = ({
  onPhotoCaptured,
  onBarcodeDetected,
  isCapturing = false
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Mirrors `stream` so the unmount cleanup sees the live value rather than the
  // null it closed over at mount, which left the camera running after navigation.
  const streamRef = useRef<MediaStream | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scannerRef = useRef<BarcodeScanner | null>(null);
  const lastBarcodeRef = useRef<{ value: string; at: number }>({ value: '', at: 0 });

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [scannerEngine, setScannerEngine] = useState<ScannerEngine | 'loading'>('loading');

  // Start Camera Stream
  const startCamera = async () => {
    setCameraError(null);
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          'No camera API in this browser. The page must be served over HTTPS (or localhost) for the camera to be exposed.'
        );
      }

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });

      streamRef.current = mediaStream;
      setStream(mediaStream);

      const video = videoRef.current;
      if (!video) {
        throw new Error('Viewfinder element is not mounted.');
      }

      video.srcObject = mediaStream;
      // Safari can reject play() when it is not tied to a gesture. The stream is
      // attached either way, so go live and let onCanPlay confirm the frames.
      await video.play().catch((err) => {
        console.warn('Autoplay blocked; waiting for canplay:', err);
      });
      setIsLive(true);

      // Check for torch capability
      const track = mediaStream.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.() as { torch?: boolean } | undefined;
      setHasTorch(!!capabilities?.torch);
    } catch (err) {
      console.warn('Camera access denied or unavailable:', err);
      const reason =
        (err as Error).name === 'NotAllowedError'
          ? 'Camera permission was denied for this site.'
          : (err as Error).name === 'NotFoundError'
            ? 'No camera device was found.'
            : (err as Error).message || 'Camera unavailable.';
      setCameraError(`${reason} You can upload photos from the gallery or use the synthetic sample generator.`);
      setIsLive(false);
    }
  };

  useEffect(() => {
    startCamera();
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  // Holds the latest callback so the scan loop is not torn down and rebuilt on
  // every parent render, which is what the old `onBarcodeDetected` dependency did.
  const onBarcodeDetectedRef = useRef(onBarcodeDetected);
  useEffect(() => {
    onBarcodeDetectedRef.current = onBarcodeDetected;
  }, [onBarcodeDetected]);

  // Resolve an engine once: native BarcodeDetector where it exists, ZXing WASM
  // everywhere else (notably every browser on iOS).
  useEffect(() => {
    let cancelled = false;
    getBarcodeScanner().then((handle) => {
      if (cancelled) return;
      scannerRef.current = handle.scanner;
      setScannerEngine(handle.engine);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Collapses the repeat hits from decoding the same tag ~4x a second, while
   * still allowing the operator to re-scan the same code after a reset.
   */
  const emitBarcode = (value: string) => {
    const now = Date.now();
    const last = lastBarcodeRef.current;
    if (last.value === value && now - last.at < REPEAT_SUPPRESS_MS) return;
    lastBarcodeRef.current = { value, at: now };
    navigator.vibrate?.(60);
    onBarcodeDetectedRef.current?.(value);
  };

  // Continuous barcode scan loop
  useEffect(() => {
    if (!isLive) return;

    let isScanning = true;

    const scanLoop = async () => {
      if (!isScanning) return;
      const video = videoRef.current;
      const scanner = scannerRef.current;

      // The engine may still be downloading; keep looping until it lands.
      if (!scanner || !video || video.readyState < 2 || !video.videoWidth) {
        if (isScanning) setTimeout(scanLoop, 300);
        return;
      }

      try {
        // Decode a downscaled snapshot rather than the raw element. Handing the
        // <video> straight to ZXing means re-reading a full 1080p frame every
        // pass, which is far too slow on a phone; 1280px still resolves thin
        // EAN bars while cutting the pixel work by more than half.
        const frame = scanCanvasRef.current ?? (scanCanvasRef.current = document.createElement('canvas'));
        const scale = Math.min(1, SCAN_WIDTH / video.videoWidth);
        frame.width = Math.round(video.videoWidth * scale);
        frame.height = Math.round(video.videoHeight * scale);

        const ctx = frame.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, frame.width, frame.height);
          const results = await scanner.detect(frame);
          const value = results?.[0]?.rawValue?.trim();
          if (value) emitBarcode(value);
        }
      } catch {
        // A frame that does not decode is the normal case; keep scanning.
      }

      if (isScanning) setTimeout(scanLoop, SCAN_INTERVAL_MS);
    };

    scanLoop();

    return () => {
      isScanning = false;
    };
  }, [isLive]);

  // Toggle Torch
  const toggleTorch = async () => {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    try {
      const newTorch = !torchOn;
      await (track as unknown as { applyConstraints: (c: { advanced: Array<{ torch?: boolean }> }) => Promise<void> }).applyConstraints({
        advanced: [{ torch: newTorch }]
      });
      setTorchOn(newTorch);
    } catch (err) {
      console.warn('Torch constraint error:', err);
    }
  };

  // Snap photo from live video stream
  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      onPhotoCaptured(dataUrl);
    }
  };

  // Upload photo files from gallery
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          onPhotoCaptured(event.target.result as string);
        }
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  };

  // Generate realistic sample care label canvas
  const generateSampleLabel = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 1000;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Background fabric texture
    ctx.fillStyle = '#FAF7F2';
    ctx.fillRect(0, 0, 800, 1000);

    // Label border & stitching effect
    ctx.strokeStyle = '#D5C4A1';
    ctx.lineWidth = 4;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(30, 30, 740, 940);
    ctx.setLineDash([]);

    // Brand Name
    ctx.fillStyle = '#2A1D14';
    ctx.font = 'bold 44px Inter, sans-serif';
    ctx.textAlign = 'center';
    const brands = ['ZARA ENTERPRISE', 'MASSIMO DUTTI', 'LEVI STRAUSS & CO.', 'ECOWEAVE ATELIER', 'NORDIC LINEN'];
    const brand = brands[Math.floor(Math.random() * brands.length)];
    ctx.fillText(brand, 400, 120);

    // Subheader
    ctx.font = '500 24px Inter, sans-serif';
    ctx.fillStyle = '#6B5442';
    ctx.fillText('COLLECTION 2026 • PREMIUM APPAREL', 400, 165);

    // Divider
    ctx.strokeStyle = '#E6D8C1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(80, 200);
    ctx.lineTo(720, 200);
    ctx.stroke();

    // Size Box
    ctx.fillStyle = '#86611F';
    ctx.fillRect(320, 230, 160, 70);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 36px Inter, sans-serif';
    ctx.fillText('SIZE L', 400, 278);

    // Material composition
    ctx.textAlign = 'left';
    ctx.fillStyle = '#2A1D14';
    ctx.font = 'bold 26px Inter, sans-serif';
    ctx.fillText('COMPOSITION / COMPOSIÇÃO:', 90, 360);

    ctx.font = '22px Inter, sans-serif';
    ctx.fillStyle = '#4D3B2C';
    ctx.fillText('• 100% ORGANIC COTTON / ALGODÃO', 90, 405);
    ctx.fillText('• RN 93243 / CA 25594', 90, 445);
    ctx.fillText('• MADE IN PORTUGAL / FABRIQUÉ EN PORTUGAL', 90, 485);

    // Care instructions
    ctx.font = 'bold 24px Inter, sans-serif';
    ctx.fillStyle = '#2A1D14';
    ctx.fillText('CARE INSTRUCTIONS / CONSEILS D’ENTRETIEN:', 90, 550);

    ctx.font = '20px Inter, sans-serif';
    ctx.fillStyle = '#6B5442';
    ctx.fillText('30° MACHINE WASH DELICATE CYCLE', 90, 590);
    ctx.fillText('DO NOT BLEACH • TUMBLE DRY LOW', 90, 625);
    ctx.fillText('WARM IRON MAX 150°C', 90, 660);

    // Barcode representation
    ctx.fillStyle = '#2A1D14';
    const startX = 140;
    const barY = 740;
    const barHeight = 90;
    const randomBarcode = '73500' + Math.floor(1000000 + Math.random() * 9000000);
    
    // Draw synthetic bars
    for (let x = 0; x < 520; x += 10) {
      const w = (x % 30 === 0 || x % 20 === 0) ? 6 : 3;
      ctx.fillRect(startX + x, barY, w, barHeight);
    }
    
    ctx.textAlign = 'center';
    ctx.font = 'bold 22px monospace';
    ctx.fillText(randomBarcode, 400, 870);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
    onPhotoCaptured(dataUrl);
    if (onBarcodeDetected) {
      onBarcodeDetected(randomBarcode);
    }
  };

  return (
    <div className="relative w-full aspect-[4/3] max-h-[360px] bg-[#2A1D14] rounded-2xl overflow-hidden shadow-inner flex items-center justify-center border border-[#E6D8C1]">
      <canvas ref={canvasRef} className="hidden" />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* The video element stays mounted at all times. startCamera() needs
          videoRef.current to attach the stream, so gating it on isLive would
          deadlock: no video element -> no stream attached -> never live. */}
      <video
        ref={videoRef}
        playsInline
        autoPlay
        muted
        onCanPlay={() => setIsLive(true)}
        className={`w-full h-full object-cover ${isLive ? '' : 'invisible'}`}
      />

      {!isLive && (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-[#E6D8C1] gap-3">
          <Camera className="w-12 h-12 text-[#BF9445] opacity-80" />
          <div className="text-xs max-w-xs leading-relaxed opacity-90">
            {cameraError || 'Camera inactive. Click to initialize live viewfinder.'}
          </div>
          <button
            type="button"
            onClick={startCamera}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#86611F] text-white text-xs font-semibold hover:bg-[#A87C2E] transition-colors cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
            Enable Camera
          </button>
        </div>
      )}

      {/* Scanner engine status — tells the operator whether live scanning is armed */}
      {isLive && (
        <div className="absolute top-2 left-2 z-20 flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[#2A1D14]/80 backdrop-blur-sm">
          <ScanBarcode
            className={`w-3.5 h-3.5 ${
              scannerEngine === 'unavailable'
                ? 'text-red-400'
                : scannerEngine === 'loading'
                  ? 'text-[#BF9445] animate-pulse'
                  : 'text-green-400'
            }`}
          />
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#E6D8C1]">
            {scannerEngine === 'loading'
              ? 'Scanner loading'
              : scannerEngine === 'unavailable'
                ? 'Scanner off'
                : 'Scanning'}
          </span>
        </div>
      )}

      {/* Target Reticle Overlay */}
      {isLive && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div className="w-3/4 h-3/5 border-2 border-[#BF9445]/60 rounded-xl relative">
            <div className="absolute top-0 left-0 w-4 h-4 border-t-4 border-l-4 border-[#BF9445]" />
            <div className="absolute top-0 right-0 w-4 h-4 border-t-4 border-r-4 border-[#BF9445]" />
            <div className="absolute bottom-0 left-0 w-4 h-4 border-b-4 border-l-4 border-[#BF9445]" />
            <div className="absolute bottom-0 right-0 w-4 h-4 border-b-4 border-r-4 border-[#BF9445]" />
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[1px] bg-[#BF9445]/30" />
            <span className="absolute -top-6 left-1/2 -translate-x-1/2 bg-[#2A1D14]/80 text-[#E6D8C1] text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider backdrop-blur-sm">
              Align Care Label
            </span>
          </div>
        </div>
      )}

      {/* Viewfinder Floating Controls */}
      <div className="absolute bottom-3 inset-x-3 flex items-center justify-between z-20 pointer-events-auto">
        {/* Sample Tag Button */}
        <button
          type="button"
          onClick={generateSampleLabel}
          title="Generate Realistic Care Tag Sample"
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#2A1D14]/85 text-[#E6D8C1] border border-[#E6D8C1]/30 hover:bg-[#2A1D14] text-xs font-medium backdrop-blur-md transition-all shadow-md active:scale-95 cursor-pointer"
        >
          <Sparkles className="w-3.5 h-3.5 text-[#BF9445]" />
          <span>Sample Tag</span>
        </button>

        {/* Shutter Button */}
        <button
          type="button"
          onClick={capturePhoto}
          disabled={isCapturing}
          title="Take Photo"
          className="w-14 h-14 rounded-full border-4 border-white/90 bg-[#86611F] hover:bg-[#A87C2E] text-white flex items-center justify-center shadow-xl active:scale-90 transition-transform cursor-pointer"
        >
          <Camera className="w-6 h-6" />
        </button>

        {/* Right Tools: Torch + Gallery */}
        <div className="flex items-center gap-2">
          {hasTorch && (
            <button
              type="button"
              onClick={toggleTorch}
              className={`p-2.5 rounded-xl border backdrop-blur-md transition-all shadow-md cursor-pointer ${
                torchOn
                  ? 'bg-[#BF9445] text-[#2A1D14] border-white'
                  : 'bg-[#2A1D14]/85 text-[#E6D8C1] border-[#E6D8C1]/30'
              }`}
            >
              {torchOn ? <Zap className="w-4 h-4" /> : <ZapOff className="w-4 h-4" />}
            </button>
          )}

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Import from Photo Album"
            className="p-2.5 rounded-xl bg-[#2A1D14]/85 text-[#E6D8C1] border border-[#E6D8C1]/30 hover:bg-[#2A1D14] backdrop-blur-md transition-all shadow-md active:scale-95 cursor-pointer"
          >
            <Upload className="w-4 h-4 text-[#BF9445]" />
          </button>
        </div>
      </div>
    </div>
  );
};
