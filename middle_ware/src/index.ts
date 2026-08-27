import { createApp } from './app';
import { env } from './config/env';
import { closeOperationalDb } from './db/operationalDb';
import { closeFlywheelDb } from './db/flywheelDb';
import { closeControlDb } from './db/controlDb';
import { startCronService, stopCronService } from './services/cronService';
import { startControlService, stopControlService } from './services/controlService';
import {
  startExtractionQueue,
  stopExtractionQueue,
} from './services/extractionQueue';
import { isGeminiReady } from './services/geminiService';
import { loadLegalArmenianMap } from './services/exportService';
import { logger } from './utils/logger';

function main(): void {
  const app = createApp();

  // Warm the Armenian legal map so a missing file is reported at boot, not
  // mid-export.
  loadLegalArmenianMap();

  if (!isGeminiReady()) {
    logger.warn(
      'GEMINI_API_KEY is not set — scans will still be accepted and queued, ' +
        'but extraction is deferred until a key is configured.',
    );
  }

  const server = app.listen(env.port, () => {
    logger.info(`Middleware listening on port ${env.port} (${env.nodeEnv})`);
    logger.info(`Catalog base URL: ${env.publicProtocol}://${env.serverHost}/catalog/`);
    startControlService();
    startExtractionQueue();
    startCronService();
  });

  // Vision calls hold the socket open for the duration of a Gemini round trip.
  server.requestTimeout = 120_000;
  server.headersTimeout = 125_000;

  const shutdown = (signal: string): void => {
    logger.info(`${signal} received — shutting down.`);
    stopCronService();
    stopExtractionQueue();
    stopControlService();
    server.close(() => {
      closeOperationalDb();
      closeFlywheelDb();
      closeControlDb();
      logger.info('Shutdown complete.');
      process.exit(0);
    });
    // Do not let a hung connection block the restart.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
  });
}

main();
