import React from 'react';
import { ArrowLeft, Star, Trash2 } from 'lucide-react';

interface PhotoLightboxProps {
  photos: string[];
  index: number;
  isKey: boolean;
  onClose: () => void;
  onSetKey: (index: number) => void;
  onDelete: (index: number) => void;
  onNavigate: (index: number) => void;
}

/**
 * Full-screen view of one captured photo (client decision 7).
 *
 * Sits above the camera screen, so its controls float over the image the same way the
 * camera's do, and it pads itself clear of the notch and the home indicator rather
 * than relying on any parent to do it.
 */
export const PhotoLightbox: React.FC<PhotoLightboxProps> = ({
  photos,
  index,
  isKey,
  onClose,
  onSetKey,
  onDelete,
  onNavigate
}) => {
  const photo = photos[index];
  if (!photo) return null;

  return (
    <div className="fixed inset-0 z-[70] bg-navy-950 flex flex-col">
      <img src={photo} alt={`Photo ${index + 1}`} className="absolute inset-0 w-full h-full object-contain" />

      <div className="relative safe-top safe-x flex items-center justify-between px-3 py-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="w-11 h-11 rounded-full bg-navy-950/60 text-cream-50 flex items-center justify-center cursor-pointer"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <span className="px-3 py-1.5 rounded-full bg-navy-950/60 text-cream-50 text-[0.82rem]">
          {index + 1} / {photos.length}
          {isKey && ' · key'}
        </span>

        <div className="w-11" />
      </div>

      <div className="flex-1" />

      <div className="relative safe-bottom safe-x px-4 pb-4 flex items-center justify-center gap-6">
        <button
          type="button"
          onClick={() => onSetKey(index)}
          aria-label={isKey ? 'Already the key photo' : 'Set as key photo'}
          className={`w-14 h-14 rounded-full flex items-center justify-center cursor-pointer ${
            isKey ? 'bg-gold-500 text-navy-900' : 'bg-navy-950/60 text-cream-50'
          }`}
        >
          <Star className={`w-6 h-6 ${isKey ? 'fill-current' : ''}`} />
        </button>

        <button
          type="button"
          onClick={() => onDelete(index)}
          aria-label="Delete photo"
          className="w-14 h-14 rounded-full bg-navy-950/60 text-[color:var(--color-critical)] flex items-center justify-center cursor-pointer"
        >
          <Trash2 className="w-6 h-6" />
        </button>
      </div>

      {photos.length > 1 && (
        <div className="relative safe-bottom safe-x px-3 pb-3 flex items-center gap-2 overflow-x-auto">
          {photos.map((p, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onNavigate(i)}
              className={`w-12 h-12 rounded-[var(--radius-control)] overflow-hidden flex-shrink-0 border-2 cursor-pointer ${
                i === index ? 'border-gold-500' : 'border-transparent opacity-60'
              }`}
            >
              <img src={p} alt={`Thumbnail ${i + 1}`} className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
