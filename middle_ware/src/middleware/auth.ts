import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { tokenStillValid } from '../db/appUsers';
import type { AuthTokenPayload } from '../types';
import { ApiError } from './errorHandler';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthTokenPayload;
    }
  }
}

export function issueToken(username: string): { token: string; expiresIn: string } {
  const token = jwt.sign({ username }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
  return { token, expiresIn: env.jwtExpiresIn };
}

/** Bearer-scheme guard for every /api/v1 route except login. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(new ApiError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header.'));
    return;
  }

  const token = header.slice('Bearer '.length).trim();
  try {
    const payload = jwt.verify(token, env.jwtSecret) as AuthTokenPayload;

    // A 30-day token would otherwise outlive a disable or a password change by
    // up to a month, making "disable this operator" cosmetic. Every request
    // re-checks the account against live state.
    const standing = tokenStillValid(payload.username, payload.iat);
    if (!standing.valid) {
      next(
        new ApiError(
          401,
          standing.reason === 'DISABLED' ? 'ACCOUNT_DISABLED' : 'TOKEN_REVOKED',
          standing.reason === 'DISABLED'
            ? 'This operator account has been disabled. Contact a supervisor.'
            : 'Session ended because the account credentials changed. Please log in again.',
        ),
      );
      return;
    }

    req.auth = payload;
    next();
  } catch (error) {
    const expired = error instanceof jwt.TokenExpiredError;
    next(
      new ApiError(
        401,
        expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        expired ? 'Session token has expired, please log in again.' : 'Invalid session token.',
      ),
    );
  }
}

/**
 * Guard for the hidden flywheel routes. Requires a valid device JWT *and*, when
 * FLYWHEEL_ADMIN_KEY is configured, a matching x-flywheel-key header.
 */
export function requireFlywheelAccess(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!env.flywheelAdminKey) {
    next();
    return;
  }
  const provided = req.headers['x-flywheel-key'];
  if (typeof provided !== 'string' || !timingSafeEqual(provided, env.flywheelAdminKey)) {
    next(new ApiError(404, 'NOT_FOUND', 'Not found.'));
    return;
  }
  next();
}

/** Constant-time comparison so secrets cannot be probed byte-by-byte. */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison to keep timing flat for wrong-length inputs.
    let diff = 1;
    const max = Math.max(bufA.length, bufB.length);
    for (let i = 0; i < max; i += 1) diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
    return false;
  }
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) diff |= bufA[i]! ^ bufB[i]!;
  return diff === 0;
}
