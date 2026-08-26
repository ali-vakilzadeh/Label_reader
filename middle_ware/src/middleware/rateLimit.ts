import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import type { ApiErrorBody } from '../types';

const body: ApiErrorBody = {
  status: 'error',
  error_code: 'RATE_LIMITED',
  message: 'Too many requests. Please slow down and retry shortly.',
};

/** 60 requests/min per IP by default, sized for 10 concurrent scanner devices. */
export const apiRateLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: env.rateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: body,
});

/** Tighter budget on login to blunt master-password brute forcing. */
export const loginRateLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: Math.max(5, Math.floor(env.rateLimitMax / 6)),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    status: 'error',
    error_code: 'RATE_LIMITED',
    message: 'Too many login attempts. Please wait before retrying.',
  } satisfies ApiErrorBody,
});
