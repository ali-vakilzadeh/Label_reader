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

/**
 * Tighter budget on login to blunt password brute forcing — but not so tight
 * that a legitimate burst trips it. A warehouse fleet sits behind one NAT, so
 * all ten devices share a source IP; a supervisor resetting passwords makes them
 * all re-authenticate at once. Passwords are scrypt-hashed, so this ceiling is
 * still far below anything useful to an attacker.
 */
export const loginRateLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: env.loginRateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    status: 'error',
    error_code: 'RATE_LIMITED',
    message: 'Too many login attempts. Please wait before retrying.',
  } satisfies ApiErrorBody,
});
