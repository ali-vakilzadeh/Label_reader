import { Router } from 'express';
import { env } from '../config/env';
import { issueToken, timingSafeEqual } from '../middleware/auth';
import { loginRateLimiter } from '../middleware/rateLimit';
import { ApiError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

export const authRouter: Router = Router();

/**
 * POST /api/v1/auth/login
 * Validates the shared master device password and issues a 30-day JWT.
 */
authRouter.post('/login', loginRateLimiter, (req, res, next) => {
  const { password, username } = (req.body ?? {}) as {
    password?: unknown;
    username?: unknown;
  };

  if (typeof username !== 'string' || username.trim() === '') {
    next(new ApiError(400, 'INVALID_CREDENTIALS', 'A username is required.'));
    return;
  }
  if (typeof password !== 'string' || password === '') {
    next(new ApiError(400, 'INVALID_CREDENTIALS', 'A password is required.'));
    return;
  }

  if (!timingSafeEqual(password, env.masterPassword)) {
    logger.warn(`Rejected login for "${username}" from ${req.ip}`);
    next(new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.'));
    return;
  }

  const { token, expiresIn } = issueToken(username.trim());
  logger.info(`Issued ${expiresIn} token to "${username.trim()}"`);

  res.json({ status: 'success', token, expires_in: expiresIn });
});
