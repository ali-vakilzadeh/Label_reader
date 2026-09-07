import React, { useRef, useState } from 'react';
import { Camera, RefreshCw } from 'lucide-react';
import type { CameraController } from '../hooks/useCameraStream';

interface CameraSurfaceProps {
  camera: CameraController;
  /** Overlay chrome - reticle, buttons - rendered above the video. */
  children?: React.ReactNode;
  className?: string;
  /** Tap-to-focus and pinch-to-zoom. Off while a modal covers the surface. */
  gesturesEnabled?: boolean;
}

interface FocusRing {
  x: number;
  y: number;
  at: number;
  supported: boolean;
}

/**
 * The live preview, plus the two gestures that belong to the surface itself:
 * tap anywhere to focus, pinch to zoom.
 *
 * Both are handled with pointer events rather than touch events so a two-finger
 * gesture works the same on a phone and on a touch laptop, and so the ring can be
 * drawn at the exact point the operator touched.
 */
export const CameraSurface: React.FC<CameraSurfaceProps> = ({
  camera,
  children,
  className = '',
  gesturesEnabled = true
}) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ distance: number; zoom: number } | null>(null);
  const [focusRing, setFocusRing] = useState<FocusRing | null>(null);

  const distanceBetween = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!gesturesEnabled) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchStart.current = { distance: distanceBetween(a, b), zoom: camera.zoom };
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!gesturesEnabled || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()];
      const ratio = distanceBetween(a, b) / (pinchStart.current.distance || 1);
      camera.setZoom(pinchStart.current.zoom * ratio);
    }
  };

  const handlePointerUp = async (e: React.PointerEvent) => {
    const wasPinching = pointers.current.size >= 2;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
    if (!gesturesEnabled || wasPinching) return;

    // A single tap that was not part of a pinch is a focus request.
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;

    const supported = await camera.focusAt(x, y);
    // The ring is drawn either way. On a device without focus control it confirms
    // the tap registered, rather than leaving the operator tapping at nothing.
    setFocusRing({ x: e.clientX - rect.left, y: e.clientY - rect.top, at: Date.now(), supported });
    window.setTimeout(() => setFocusRing((r) => (r && Date.now() - r.at >= 700 ? null : r)), 750);
  };

  return (
    <div
      ref={surfaceRef}
      className={`relative overflow-hidden ${className}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{ touchAction: 'none' }}
    >
      {/* The video element stays mounted at all times: start() needs videoRef to
          attach the stream, so gating it on isLive would deadlock. */}
      <video
        ref={camera.videoRef}
        playsInline
        autoPlay
        muted
        className={`w-full h-full object-cover ${camera.isLive ? '' : 'invisible'}`}
        style={
          // Digital zoom has no lens to do the work, so the preview is scaled to
          // match what capturePhoto() will crop.
          camera.isDigitalZoom && camera.zoom > 1
            ? { transform: `scale(${camera.zoom})`, transformOrigin: 'center' }
            : undefined
        }
      />

      {!camera.isLive && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center bg-navy-900 text-cream-300">
          <Camera className="w-10 h-10 text-gold-500" />
          <div className="text-[0.82rem] max-w-xs leading-relaxed">
            {camera.error || 'Starting the camera…'}
          </div>
          <button
            type="button"
            onClick={() => void camera.start()}
            className="flex items-center gap-2 px-4 min-h-[44px] rounded-[var(--radius-control)] bg-navy-800 text-cream-50 text-[0.82rem] font-semibold cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
            Enable camera
          </button>
        </div>
      )}

      {focusRing && (
        <div
          className="pointer-events-none absolute w-16 h-16 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-gold-500"
          style={{
            left: focusRing.x,
            top: focusRing.y,
            opacity: focusRing.supported ? 1 : 0.5,
            transition: 'opacity var(--motion-fast) var(--motion-ease)'
          }}
        />
      )}

      {children}
    </div>
  );
};
