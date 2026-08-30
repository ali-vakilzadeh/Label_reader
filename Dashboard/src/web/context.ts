import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { config } from '../config/env';
import { getUser, readSession, destroySession, type DashUser, type Session } from '../services/auth';
import { translator, type Locale } from '../i18n';
import { banner, readStatus } from '../services/control';
import { localised } from '../data/resolve';
import type { TaxonomyKey } from '../data/referenceTables';

declare module 'express-serve-static-core' {
  interface Request {
    user?: DashUser;
    session?: Session;
    locale: Locale;
  }
}

const COOKIE = 'lr_session';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function setSessionCookie(res: Response, token: string, maxAgeMs: number): void {
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (!config.allowInsecureCookies) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/** Attaches user, locale and the status banner to every request and every template. */
export function contextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);
  const session = readSession(cookies[COOKIE]);
  const user = session ? getUser(session.user_id) : undefined;

  if (session && !user) {
    destroySession(session.token);
  }

  req.session = session ?? undefined;
  req.user = user;

  // ?lang=hy switches for this request and, for a signed-in user, is persisted on save.
  const requested = String(req.query.lang ?? '');
  req.locale = requested === 'hy' || requested === 'en' ? requested : (user?.locale ?? config.defaultLocale);

  const status = readStatus();
  res.locals.user = user ?? null;
  res.locals.locale = req.locale;
  res.locals.t = translator(req.locale);
  // Bound localiser for templates. Armenian is joined at render time, never stored.
  res.locals.loc = (key: TaxonomyKey, value: string | null) => localised(key, value, req.locale);
  res.locals.status = status;
  res.locals.banner = banner(status, req.locale);
  res.locals.csrf = session?.csrf ?? '';
  res.locals.path = req.path;
  res.locals.query = req.query;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  if (req.user.must_change_password && req.path !== '/account/password') {
    res.redirect('/account/password');
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).render('error', { title: 'Not allowed', message: 'This page requires an administrator account.' });
    return;
  }
  next();
}

/** Every mutating form carries a token. Compared in constant time. */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const supplied = String(req.body?._csrf ?? req.headers['x-csrf-token'] ?? '');
  const expected = req.session?.csrf ?? '';
  const ok =
    expected.length > 0 &&
    supplied.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!ok) {
    res.status(403).render('error', {
      title: 'Session expired',
      message: 'Your session expired or the form was stale. Go back, reload the page and try again.',
    });
    return;
  }
  next();
}

export function actorOf(req: Request): string {
  return `ui:${req.user?.username ?? 'anonymous'}`;
}
