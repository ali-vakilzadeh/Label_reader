import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { apiRateLimiter } from './middleware/rateLimit';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { healthRouter } from './routes/health.routes';
import { authRouter } from './routes/auth.routes';
import { visionRouter } from './routes/vision.routes';
import { flywheelRouter } from './routes/flywheel.routes';
import { referenceRouter } from './routes/reference.routes';

export function createApp(): Express {
  const app = express();

  // Behind Caddy/nginx on the VPS, so client IPs (and thus rate limiting) come
  // from X-Forwarded-For.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // Catalog images are consumed cross-origin by the dashboard and clients.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(
    cors({
      origin: env.corsOrigin === '*' ? true : env.corsOrigin.split(',').map((o) => o.trim()),
      methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-flywheel-key'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Health check stays outside the rate limiter: devices poll it on startup.
  app.use(healthRouter);

  // Rendered catalog shots, served straight off disk at the pre-generated URL.
  app.use(
    '/catalog',
    express.static(env.catalogDir, {
      maxAge: '1h',
      fallthrough: true,
      index: false,
    }),
  );

  app.use('/api/v1', apiRateLimiter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/vision', visionRouter);
  app.use('/api/v1/reference-tables', referenceRouter);
  // Hidden — not published in the API contract.
  app.use('/api/v1/flywheel', flywheelRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
