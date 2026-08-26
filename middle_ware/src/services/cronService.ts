import cron from 'node-cron';
import { env } from '../config/env';
import { isGeminiReady } from './geminiService';
import { runRenderJob } from './renderService';
import { logger } from '../utils/logger';

/**
 * Nightly scheduler. Default RENDER_CRON_SCHEDULE is "0 20 * * *" — 20:00 daily
 * in RENDER_CRON_TIMEZONE.
 */

let task: cron.ScheduledTask | null = null;
/** Guards against a long batch overlapping the next trigger. */
let running = false;

async function tick(): Promise<void> {
  if (running) {
    logger.warn('Render job still running from a previous trigger; skipping this tick.');
    return;
  }
  if (!isGeminiReady()) {
    logger.warn('Render job skipped: GEMINI_API_KEY is not configured.');
    return;
  }

  running = true;
  try {
    await runRenderJob();
  } catch (error) {
    logger.error('Render job crashed', error);
  } finally {
    running = false;
  }
}

export function startCronService(): void {
  if (!env.renderCronEnabled) {
    logger.info('Render cron disabled (RENDER_CRON_ENABLED=false).');
    return;
  }
  if (task) {
    logger.warn('Cron service already started.');
    return;
  }
  if (!cron.validate(env.renderCronSchedule)) {
    logger.error(`Invalid RENDER_CRON_SCHEDULE "${env.renderCronSchedule}"; cron not started.`);
    return;
  }

  task = cron.schedule(env.renderCronSchedule, () => void tick(), {
    scheduled: true,
    timezone: env.renderCronTimezone,
  });

  logger.info(
    `Render cron scheduled "${env.renderCronSchedule}" (${env.renderCronTimezone}).`,
  );
}

export function stopCronService(): void {
  if (!task) return;
  task.stop();
  task = null;
  logger.info('Render cron stopped.');
}

/** Manual trigger for ops and for scripts/runRenderJob.ts. */
export async function triggerRenderJobNow(): Promise<void> {
  await tick();
}
