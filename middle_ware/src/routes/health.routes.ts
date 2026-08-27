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
    version: process.env.npm_package_version ?? '1.1.0',
    // API contract revision this build implements (api_contract.md).
    api_contract: '1.1',
    gemini_ready: isGeminiReady(),
  });
});
