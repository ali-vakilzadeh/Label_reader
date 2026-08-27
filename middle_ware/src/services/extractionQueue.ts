import { env } from '../config/env';
import { claimPendingExtractions, extractionCounts } from '../db/operationalDb';
import { interceptLowConfidence } from './flywheelService';
import { consumeDrainRequest, isVisionPaused } from './controlService';
import { isGeminiReady } from './geminiService';
import { runExtraction } from './visionService';
import { logger } from '../utils/logger';

/**
 * Background drain for the durable intake queue.
 *
 * Every scan is recorded as PENDING before Gemini is contacted, so this worker
 * is what makes "no scan is forgotten" true rather than aspirational: whatever
 * the live request could not finish — an outage, a rate limit, a pause, a
 * restart mid-flight — is still sitting in the queue and gets completed here.
 *
 * The worker is deliberately conservative:
 *   - it does nothing while vision is paused, so it cannot hammer a dead quota
 *   - it stops the sweep on the first halting fault, rather than burning the
 *     whole batch against the same wall
 *   - it processes sequentially, to stay inside the API's rate limits
 */

let timer: NodeJS.Timeout | null = null;
let running = false;

export interface DrainResult {
  attempted: number;
  completed: number;
  deferred: number;
  parked: number;
  skipped: boolean;
  reason?: string;
}

export async function drainOnce(batchSize = env.queueDrainBatch): Promise<DrainResult> {
  const result: DrainResult = {
    attempted: 0,
    completed: 0,
    deferred: 0,
    parked: 0,
    skipped: false,
  };

  if (isVisionPaused()) {
    return { ...result, skipped: true, reason: 'vision paused pending operator action' };
  }
  if (!isGeminiReady()) {
    return { ...result, skipped: true, reason: 'GEMINI_API_KEY not configured' };
  }

  const batch = claimPendingExtractions(batchSize);
  if (batch.length === 0) return result;

  logger.info(`Queue drain starting for ${batch.length} pending scan(s).`);

  for (const scan of batch) {
    let imagePaths: string[] = [];
    try {
      imagePaths = JSON.parse(scan.image_paths ?? '[]') as string[];
    } catch {
      imagePaths = [];
    }

    result.attempted += 1;
    const outcome = await runExtraction(scan.apparel_id, imagePaths);

    if (outcome.ok) {
      result.completed += 1;
      interceptLowConfidence({
        apparelId: scan.apparel_id,
        keyPhotoPath: scan.key_photo_path,
        imagePaths,
        extraction: outcome.data,
        rawGemini: outcome.raw,
      });
      continue;
    }

    if (outcome.disposition === 'REJECT') {
      result.parked += 1;
      continue;
    }

    result.deferred += 1;

    // A halting fault will hit every remaining item identically — stop early and
    // let the operator resolve it. The unprocessed rows stay queued.
    if (outcome.disposition === 'HALT') {
      logger.warn(
        `Queue drain halted after ${result.attempted} scan(s): ${outcome.fault}. ` +
          `${batch.length - result.attempted} scan(s) remain queued.`,
      );
      break;
    }
  }

  const counts = extractionCounts();
  logger.info(
    `Queue drain finished — completed ${result.completed}, deferred ${result.deferred}, ` +
      `parked ${result.parked}; ${counts.pending} still pending.`,
  );
  return result;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await drainOnce();
  } catch (error) {
    logger.error('Queue drain crashed', error);
  } finally {
    running = false;
  }
}

export function startExtractionQueue(): void {
  if (timer) return;

  timer = setInterval(() => {
    // An operator pressing "retry" schedules an immediate sweep; otherwise the
    // regular interval applies.
    consumeDrainRequest();
    void tick();
  }, env.queueDrainMs);
  timer.unref();

  // Sweep once at boot so anything left behind by a crash or restart moves.
  void tick();

  logger.info(`Extraction queue worker started (every ${env.queueDrainMs} ms).`);
}

export function stopExtractionQueue(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Manual trigger for scripts and tests. */
export async function drainNow(): Promise<DrainResult> {
  return drainOnce();
}
