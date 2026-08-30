import { Router } from 'express';
import { config } from '../config/env';
import {
  createSession,
  destroySession,
  setLocale,
  setPassword,
  verifyLogin,
  validatePassword,
} from '../services/auth';
import { audit } from '../services/audit';
import { clearSessionCookie, requireAuth, requireCsrf, setSessionCookie } from '../web/context';

const router = Router();

/** Simple per-IP throttle. 10 users on one LAN does not need a rate-limit package. */
const attempts = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 60_000;

function throttled(ip: string): boolean {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip: string): void {
  const entry = attempts.get(ip) ?? { count: 0, until: Date.now() + LOCKOUT_MS };
  entry.count += 1;
  entry.until = Date.now() + LOCKOUT_MS;
  attempts.set(ip, entry);
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/items');
  res.render('login', { title: 'Sign in', error: null, next: String(req.query.next ?? '/items') });
});

router.post('/login', (req, res) => {
  const ip = req.ip ?? 'unknown';
  const nextUrl = String(req.body.next || '/items');

  if (throttled(ip)) {
    return res.status(429).render('login', {
      title: 'Sign in',
      error: 'Too many attempts. Wait a minute and try again.',
      next: nextUrl,
    });
  }

  const username = String(req.body.username ?? '').trim();
  const password = String(req.body.password ?? '');
  const user = verifyLogin(username, password);

  if (!user) {
    recordFailure(ip);
    // Deliberately vague: naming which half was wrong helps an attacker enumerate users.
    return res.status(401).render('login', {
      title: 'Sign in',
      error: 'Incorrect username or password.',
      next: nextUrl,
    });
  }

  attempts.delete(ip);
  const session = createSession(user.id);
  setSessionCookie(res, session.token, config.sessionTtlMs);
  audit(`ui:${user.username}`, 'LOGIN', 'dash_user', user.username);
  res.redirect(user.must_change_password ? '/account/password' : nextUrl);
});

router.post('/logout', requireCsrf, (req, res) => {
  if (req.session) destroySession(req.session.token);
  clearSessionCookie(res);
  res.redirect('/login');
});

/**
 * The forced password change. `admin`/`admin` exists so the first person can get in; this
 * is the half that makes shipping it acceptable.
 */
router.get('/account/password', requireAuth, (req, res) => {
  res.render('password', {
    title: 'Change password',
    forced: !!req.user!.must_change_password,
    error: null,
  });
});

router.post('/account/password', requireAuth, requireCsrf, (req, res) => {
  const password = String(req.body.password ?? '');
  const confirm = String(req.body.confirm ?? '');
  const forced = !!req.user!.must_change_password;

  if (password !== confirm) {
    return res.status(400).render('password', { title: 'Change password', forced, error: 'The two passwords do not match.' });
  }
  const err = validatePassword(password) ?? setPassword(`ui:${req.user!.username}`, req.user!.id, password);
  if (err) {
    return res.status(400).render('password', { title: 'Change password', forced, error: err });
  }
  // setPassword drops every session for this user, so a fresh one is needed.
  const session = createSession(req.user!.id);
  setSessionCookie(res, session.token, config.sessionTtlMs);
  res.redirect('/items');
});

/** Language toggle. Persisted per user; it changes display only, never stored data. */
router.post('/account/locale', requireAuth, requireCsrf, (req, res) => {
  const locale = req.body.locale === 'hy' ? 'hy' : 'en';
  setLocale(req.user!.id, locale);
  res.redirect(String(req.body.back || '/items'));
});

export default router;
