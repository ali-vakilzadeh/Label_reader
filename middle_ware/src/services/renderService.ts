import { env } from '../config/env';
import { getPendingRenders, setRenderingStatus } from '../db/operationalDb';
import { renderStudioImage } from './geminiService';
import { attachRenderPath } from './flywheelService';
import { catalogFilePath, readImageAsInline, writeCatalogImage } from './storageService';
import { logger } from '../utils/logger';
import type { ServerScanRow } from '../types';

/**
 * Overnight studio rendering.
 *
 * The catalog URL was already handed to the client at scan time; this job fills
 * in the file that lives at that URL. Each rendered shot is also synced back into
 * flywheel.db when the item was captured as a training sample, so a training row
 * ends up holding raw photos + prediction + ground truth + studio render.
 */

export const STUDIO_PROMPT = [
  'Re-photograph this exact garment as a clean e-commerce catalog product shot.',
  'Place it on a seamless pure white studio background with soft, even lighting',
  'and a subtle natural shadow. Keep the garment centred and fully in frame.',
  'Preserve the true colour, fabric texture, cut, and every visible detail exactly',
  'as in the original — do not restyle, recolour, or add or remove any element.',
  'Remove hands, hangers, clutter, and background distractions.',
  'Output a single square product image.',
].join(' ');

export interface RenderJobResult {
  processed: number;
  rendered: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

/** Renders one pending record. Returns the written file path, or null. */
export async function renderOne(scan: ServerScanRow): Promise<string | null> {
  if (!scan.key_photo_path) {
    setRenderingStatus(scan.apparel_id, 'SKIPPED', 'No key photo on file.', false);
    return null;
  }

  const inline = readImageAsInline(scan.key_photo_path);
  if (!inline) {
    setRenderingStatus(
      scan.apparel_id,
      'FAILED',
      `Key photo missing on disk: ${scan.key_photo_path}`,
    );
    return null;
  }

  const rendered = await renderStudioImage(inline, STUDIO_PROMPT);
  if (!rendered) {
    setRenderingStatus(scan.apparel_id, 'FAILED', 'Model returned no image part.');
    return null;
  }

  const destination = writeCatalogImage(scan.apparel_id, rendered.buffer);
  setRenderingStatus(scan.apparel_id, 'COMPLETED', null);

  // Sync the render path into the hidden training DB when this item is a sample.
  if (attachRenderPath(scan.apparel_id, destination)) {
    logger.debug(`Synced render path into flywheel for ${scan.apparel_id}`);
  }

  return destination;
}

/**
 * Processes the pending render queue. Records are handled sequentially to stay
 * within the image model's rate limits; one failure never stops the batch.
 */
export async function runRenderJob(
  batchSize = env.renderBatchSize,
): Promise<RenderJobResult> {
  const started = Date.now();
  const pending = getPendingRenders(batchSize);

  const result: RenderJobResult = {
    processed: pending.length,
    rendered: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
  };

  if (pending.length === 0) {
    result.durationMs = Date.now() - started;
    logger.info('Render job: nothing pending.');
    return result;
  }

  logger.info(`Render job starting for ${pending.length} pending record(s).`);

  for (const scan of pending) {
    try {
      const written = await renderOne(scan);
      if (written) {
        result.rendered += 1;
        logger.info(`Rendered ${scan.apparel_id} -> ${written}`);
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      result.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      setRenderingStatus(scan.apparel_id, 'FAILED', message.slice(0, 500));
      logger.error(`Render failed for ${scan.apparel_id}`, error);
    }
  }

  result.durationMs = Date.now() - started;
  logger.info(
    `Render job finished in ${result.durationMs} ms — ` +
      `rendered ${result.rendered}, failed ${result.failed}, skipped ${result.skipped}. ` +
      `Expected output path pattern: ${catalogFilePath('<apparel_id>')}`,
  );
  return result;
}
