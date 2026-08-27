import { Router } from 'express';
import { env } from '../config/env';
import { issueToken, timingSafeEqual } from '../middleware/auth';
import { loginRateLimiter } from '../middleware/rateLimit';
import { ApiError } from '../middleware/errorHandler';
import { authenticate, recordLogin } from '../db/appUsers';
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

  const name = username.trim();
  const outcome = authenticate(name, password);

  if (outcome.result === 'DISABLED') {
    logger.warn(`Login refused for disabled operator "${name}" from ${req.ip}`);
    next(
      new ApiError(
        401,
        'ACCOUNT_DISABLED',
        'This operator account has been disabled. Contact a supervisor.',
      ),
    );
    return;
  }

  if (outcome.result === 'BAD_PASSWORD') {
    logger.warn(`Rejected login for "${name}" from ${req.ip}`);
    next(new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.'));
    return;
  }

  if (outcome.result === 'NO_SUCH_USER') {
    // Migration path: deployments still on the shared device password keep
    // working until every device has a real account. Disable the fallback with
    // ALLOW_MASTER_PASSWORD_FALLBACK=false once migration is complete.
    if (!env.allowMasterPasswordFallback || !timingSafeEqual(password, env.masterPassword)) {
      logger.warn(`Rejected login for unknown operator "${name}" from ${req.ip}`);
      next(new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.'));
      return;
    }
    logger.warn(
      `"${name}" authenticated with the shared master password — create a per-operator account.`,
    );
  } else {
    recordLogin(name);
  }

  const { token, expiresIn } = issueToken(name);
  logger.info(`Issued ${expiresIn} token to "${name}"`);

  res.json({ status: 'success', token, expires_in: expiresIn });
});
