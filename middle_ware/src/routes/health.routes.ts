import { Router } from 'express';
import { isGeminiReady } from '../services/geminiService';
import { referenceVersion } from '../data/referenceTables';

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
    api_contract: '1.4',
    gemini_ready: isGeminiReady(),
    // Lets a device tell in one unauthenticated call whether its cached copy of
    // the reference tables is stale, without fetching the 90 KB payload.
    reference_version: referenceVersion(),
  });
});
