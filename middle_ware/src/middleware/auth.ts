import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
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
    req.auth = jwt.verify(token, env.jwtSecret) as AuthTokenPayload;
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
