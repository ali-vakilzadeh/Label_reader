import express from 'express';
import helmet from 'helmet';
import { config } from './config/env';
import { contextMiddleware } from './web/context';
import authRoutes from './routes/auth';
import itemRoutes from './routes/items';
import importRoutes from './routes/imports';
import exportRoutes from './routes/exports';
import analyticsRoutes from './routes/analytics';
import settingsRoutes from './routes/settings';
import apiRoutes from './routes/api';

export function createApp(): express.Express {
  const app = express();

  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', config.viewsDir);

  app.use(
    helmet({
      contentSecurityPolicy: {
        // Everything is served from this origin. No CDN, by design: the VPS and the
        // warehouse may both be offline (plan §3.3).
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/static', express.static(config.publicDir, { maxAge: '1h' }));

  app.use(contextMiddleware);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime_seconds: Math.floor(process.uptime()) });
  });

  app.use(authRoutes);
  app.use(itemRoutes);
  app.use(importRoutes);
  app.use(exportRoutes);
  app.use(analyticsRoutes);
  app.use(settingsRoutes);
  app.use('/api', apiRoutes);

  app.get('/', (req, res) => res.redirect(req.user ? '/items' : '/login'));

  app.use((_req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[error]', err);
    res.status(500).render('error', { title: 'Something went wrong', message: err.message });
  });

  return app;
}
