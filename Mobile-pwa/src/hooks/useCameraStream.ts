import { useCallback, useEffect, useRef, useState } from 'react';
import type { TorchMode } from '../types/models';

/**
 * One rear-camera stream, shared by the barcode step and the capture step.
 *
 * The browser exposes camera controls through `applyConstraints`, and support is
 * uneven: Android Chrome has torch, zoom and focus; iOS Safari has none of the three.
 * Every control here therefore reports whether it is actually available, and the UI
 * hides what the device cannot do rather than offering a button that does nothing.
 */

/** Capability shapes the DOM lib does not declare. */
interface ExtendedCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  zoom?: { min: number; max: number; step: number };
  focusMode?: string[];
  pointsOfInterest?: unknown;
}

interface AdvancedConstraint {
  torch?: boolean;
  zoom?: number;
  focusMode?: string;
  pointsOfInterest?: Array<{ x: number; y: number }>;
}

type ConstrainableTrack = MediaStreamTrack & {
  applyConstraints(constraints: { advanced: AdvancedConstraint[] }): Promise<void>;
};

/** Ambient luma below this turns the auto torch on; above the upper bound, off. */
const AUTO_TORCH_ON_BELOW = 52;
const AUTO_TORCH_OFF_ABOVE = 95;
const AUTO_TORCH_INTERVAL_MS = 1500;

export interface CameraCapabilities {
  torch: boolean;
  zoom: { min: number; max: number; step: number } | null;
  focus: boolean;
}

export interface CameraController {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isLive: boolean;
  error: string | null;
  capabilities: CameraCapabilities;
  /** Hardware zoom where available, digital otherwise. 1 = no magnification. */
  zoom: number;
  maxZoom: number;
  /** True when `zoom` is achieved by cropping rather than by the lens. */
  isDigitalZoom: boolean;
  torchActive: boolean;
  start: () => Promise<void>;
  stop: () => void;
  setZoom: (value: number) => void;
  /** x and y are 0-1, relative to the displayed video. */
  focusAt: (x: number, y: number) => Promise<boolean>;
  /**
   * Grabs the current frame as a JPEG data URL, honouring digital zoom so the photo
   * matches what the operator framed.
   */
  capturePhoto: (quality?: number) => string | null;
  /** The live frame, for the decoders. Null until the first frame arrives. */
  grabFrame: (maxWidth: number) => HTMLCanvasElement | null;
}

export function useCameraStream(torchMode: TorchMode): CameraController {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lumaCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const zoomRef = useRef(1);

  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<CameraCapabilities>({
    torch: false,
    zoom: null,
    focus: false
  });
  const [zoom, setZoomState] = useState(1);
  const [torchActive, setTorchActive] = useState(false);

  const track = (): ConstrainableTrack | null =>
    (streamRef.current?.getVideoTracks()[0] as ConstrainableTrack | undefined) ?? null;

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setIsLive(false);
    setTorchActive(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());

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

      const video = videoRef.current;
      if (!video) throw new Error('Viewfinder element is not mounted.');

      video.srcObject = mediaStream;
      // Safari can reject play() when it is not tied to a gesture. The stream is
      // attached either way, so go live and let onCanPlay confirm the frames.
      await video.play().catch((err) => console.warn('Autoplay blocked; waiting for canplay:', err));
      setIsLive(true);

      const caps = (track()?.getCapabilities?.() ?? {}) as ExtendedCapabilities;
      setCapabilities({
        torch: Boolean(caps.torch),
        zoom: caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null,
        focus: Array.isArray(caps.focusMode) && caps.focusMode.length > 0
      });
      zoomRef.current = 1;
      setZoomState(1);
    } catch (err) {
      console.warn('Camera unavailable:', err);
      const name = (err as Error).name;
      const reason =
        name === 'NotAllowedError'
          ? 'Camera permission was denied for this site.'
          : name === 'NotFoundError'
            ? 'No camera device was found.'
            : (err as Error).message || 'Camera unavailable.';
      setError(reason);
      setIsLive(false);
    }
  }, []);

  useEffect(() => {
    void start();
    return stop;
  }, [start, stop]);

  /**
   * The stream is dropped when the tab is backgrounded on some devices, and comes back
   * as a black frame with the decoder still looping over it. Restarting on return is
   * cheaper than trying to detect the dead stream.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !streamRef.current?.active) {
        void start();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [start]);

  const applyTorch = useCallback(async (on: boolean) => {
    const videoTrack = track();
    if (!videoTrack) return;
    try {
      await videoTrack.applyConstraints({ advanced: [{ torch: on }] });
      setTorchActive(on);
    } catch (err) {
      console.warn('Torch constraint rejected:', err);
    }
  }, []);

  /** Mean luma of a thumbnail of the current frame, 0-255, or null if unreadable. */
  const sampleLuma = useCallback((): number | null => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return null;

    const canvas = lumaCanvasRef.current ?? (lumaCanvasRef.current = document.createElement('canvas'));
    canvas.width = 32;
    canvas.height = 24;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      total += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    return total / (data.length / 4);
  }, []);

  /**
   * Torch modes. `on` and `off` are a single constraint; `auto` has no browser
   * equivalent - `fillLightMode` is a still-capture setting, not a video-track one -
   * so it is implemented here by watching the ambient level. The two thresholds are
   * deliberately far apart: one boundary would flip the light on and off every sample
   * as the torch itself changed the reading it was reacting to.
   */
  useEffect(() => {
    if (!isLive || !capabilities.torch) return;

    if (torchMode === 'on') {
      void applyTorch(true);
      return;
    }
    if (torchMode === 'off') {
      void applyTorch(false);
      return;
    }

    let cancelled = false;
    let lit = false;

    const tick = () => {
      if (cancelled) return;
      const luma = sampleLuma();
      if (luma !== null) {
        if (!lit && luma < AUTO_TORCH_ON_BELOW) {
          lit = true;
          void applyTorch(true);
        } else if (lit && luma > AUTO_TORCH_OFF_ABOVE) {
          lit = false;
          void applyTorch(false);
        }
      }
    };

    tick();
    const id = window.setInterval(tick, AUTO_TORCH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      void applyTorch(false);
    };
  }, [isLive, capabilities.torch, torchMode, applyTorch, sampleLuma]);

  /**
   * Zoom. Where the lens supports it the constraint is applied and the preview is
   * untouched; where it does not, the same factor is achieved by cropping - the
   * preview is scaled in CSS and `capturePhoto` crops to match, so the photo is
   * always what the operator saw.
   */
  const maxZoom = capabilities.zoom?.max ?? 4;

  const setZoom = useCallback(
    (value: number) => {
      const caps = capabilities.zoom;
      const min = caps?.min ?? 1;
      const max = caps?.max ?? 4;
      const clamped = Math.min(max, Math.max(min, value));

      zoomRef.current = clamped;
      setZoomState(clamped);

      if (caps) {
        void track()
          ?.applyConstraints({ advanced: [{ zoom: clamped }] })
          .catch((err) => console.warn('Zoom constraint rejected:', err));
      }
    },
    [capabilities.zoom]
  );

  const focusAt = useCallback(
    async (x: number, y: number): Promise<boolean> => {
      const videoTrack = track();
      if (!videoTrack || !capabilities.focus) return false;
      try {
        await videoTrack.applyConstraints({
          advanced: [{ focusMode: 'single-shot', pointsOfInterest: [{ x, y }] }]
        });
        return true;
      } catch (err) {
        console.warn('Focus constraint rejected:', err);
        return false;
      }
    },
    [capabilities.focus]
  );

  const capturePhoto = useCallback(
    (quality = 0.9): string | null => {
      const video = videoRef.current;
      if (!video || !video.videoWidth) return null;

      const canvas = captureCanvasRef.current ?? (captureCanvasRef.current = document.createElement('canvas'));
      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;

      // Hardware zoom is already baked into the frame; digital zoom is not, so crop.
      const factor = capabilities.zoom ? 1 : zoomRef.current;
      const cropWidth = sourceWidth / factor;
      const cropHeight = sourceHeight / factor;
      const cropX = (sourceWidth - cropWidth) / 2;
      const cropY = (sourceHeight - cropHeight) / 2;

      canvas.width = Math.round(cropWidth);
      canvas.height = Math.round(cropHeight);

      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', quality);
    },
    [capabilities.zoom]
  );

  const grabFrame = useCallback((maxWidth: number): HTMLCanvasElement | null => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return null;

    const canvas = frameCanvasRef.current ?? (frameCanvasRef.current = document.createElement('canvas'));
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }, []);

  return {
    videoRef,
    isLive,
    error,
    capabilities,
    zoom,
    maxZoom,
    isDigitalZoom: !capabilities.zoom,
    torchActive,
    start,
    stop,
    setZoom,
    focusAt,
    capturePhoto,
    grabFrame
  };
}
