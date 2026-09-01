import React, { useRef, useState, useEffect } from 'react';
import { Camera, Zap, ZapOff, Upload, Sparkles, RefreshCw } from 'lucide-react';

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

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);

  // Start Camera Stream
  const startCamera = async () => {
    setCameraError(null);
    try {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });

      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        await videoRef.current.play();
        setIsLive(true);
      }

      // Check for torch capability
      const track = mediaStream.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.() as { torch?: boolean } | undefined;
      setHasTorch(!!capabilities?.torch);
    } catch (err) {
      console.warn('Camera access denied or unavailable:', err);
      setCameraError('Camera access not granted or unavailable. You can upload photos from gallery or use the synthetic sample generator.');
      setIsLive(false);
    }
  };

  useEffect(() => {
    startCamera();
    return () => {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  // Continuous Barcode Detector loop if available
  useEffect(() => {
    if (!isLive || !videoRef.current || !onBarcodeDetected) return;

    let isScanning = true;
    const BarcodeDetectorClass = (window as unknown as { BarcodeDetector?: new (options?: { formats: string[] }) => { detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;

    if (BarcodeDetectorClass) {
      try {
        const detector = new BarcodeDetectorClass({
          formats: ['code_128', 'ean_13', 'ean_8', 'qr_code', 'upc_a', 'upc_e']
        });

        const scanLoop = async () => {
          if (!isScanning || !videoRef.current || videoRef.current.readyState < 2) {
            if (isScanning) requestAnimationFrame(scanLoop);
            return;
          }
          try {
            const barcodes = await detector.detect(videoRef.current);
            if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
              onBarcodeDetected(barcodes[0].rawValue);
            }
          } catch {
            // ignore frame parse errors
          }
          if (isScanning) {
            setTimeout(scanLoop, 400);
          }
        };
        scanLoop();
      } catch (err) {
        console.warn('BarcodeDetector initialization warning:', err);
      }
    }

    return () => {
      isScanning = false;
    };
  }, [isLive, onBarcodeDetected]);

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

      {isLive ? (
        <video
          ref={videoRef}
          playsInline
          autoPlay
          muted
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="flex flex-col items-center justify-center p-6 text-center text-[#E6D8C1] gap-3">
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
