import multer from 'multer';
import { env } from '../config/env';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

/**
 * Images are buffered in memory: they go straight to Gemini as base64 inline
 * parts, and only low-confidence scans (or the key photo, needed by the nightly
 * render job) are persisted to disk afterwards.
 */
const storage = multer.memoryStorage();

export const uploadImages = multer({
  storage,
  limits: {
    fileSize: env.maxImageBytes,
    files: env.maxImages,
  },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_MIME.has(file.mimetype.toLowerCase())) {
      callback(
        new multer.MulterError('LIMIT_UNEXPECTED_FILE', `unsupported type ${file.mimetype}`),
      );
      return;
    }
    callback(null, true);
  },
}).array('images', env.maxImages);
