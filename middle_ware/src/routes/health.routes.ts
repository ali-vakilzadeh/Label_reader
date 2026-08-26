import { Router } from 'express';
import { isGeminiReady } from '../services/geminiService';

export const healthRouter: Router = Router();

/**
 * GET /health — used by the Android client for a fast startup connectivity check.
 * Unauthenticated by contract.
 */
healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
    version: process.env.npm_package_version ?? '1.0.0',
    gemini_ready: isGeminiReady(),
  });
});
