/**
 * Authentication HTTP routes (Task 10).
 *
 * POST /api/auth/google  — verify Google ID token, find/create account, set
 *                          session cookie. Binds the guest claim to the
 *                          server-known identity of the given socket id; the
 *                          client can never choose the claimed playerId.
 * GET  /api/auth/me      — public/account-safe session info.
 * POST /api/auth/logout  — revoke session, clear cookie.
 * PATCH /api/auth/profile — display-name rename (7-day cooldown) + district.
 * DELETE /api/auth/account — delete/anonymize account.
 * GET  /api/auth/config  — public feature flags (no secrets).
 *
 * State-changing routes require a same-origin request (Origin/Referer check)
 * on top of the SameSite=Lax session cookie.
 */

import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AuthConfigPayload,
  type AuthMePayload,
  type GoogleLoginRequest,
  type GoogleLoginResponse,
  type KeralaDistrict,
} from '@kerala-battle/shared';
import { KERALA_DISTRICTS } from '@kerala-battle/shared';
import type { AuthConfig } from './config.js';
import type { IdTokenVerifier } from './google.js';
import { GoogleTokenError } from './google.js';
import {
  createSession,
  clearSessionCookie,
  getCookieValue,
  getSessionByToken,
  revokeAllUserSessions,
  revokeSession,
  setSessionCookie,
  touchSession,
  SESSION_COOKIE_NAME,
  type SessionDeps,
} from './sessions.js';
import {
  anonymizeUser,
  createUserOnFirstLogin,
  getUserById,
  getUserBySubject,
  recordLogin,
  renameUser,
  setUserDistrict,
  toAuthPlayerInfo,
  type GuestClaim,
  type UserRecord,
} from './users.js';
import { RATE_LIMIT_RULES, type RateLimiter } from '../rate-limit/limiter.js';

export interface AuthRouteDeps {
  db: DatabaseSync;
  config: AuthConfig;
  verifier: IdTokenVerifier;
  limiter: RateLimiter;
  sessionDeps: SessionDeps;
  /** Server-known origins allowed for credentialed requests. */
  allowedOrigins: string[];
  /** Server-known guest profile for a socket id, or null. */
  getGuestForSocket: (socketId: string) => GuestClaim | null;
}

function isKeralaDistrict(value: unknown): value is KeralaDistrict {
  return typeof value === 'string' && (KERALA_DISTRICTS as readonly string[]).includes(value);
}

/**
 * CSRF guard for cookie-authenticated state changes: when the browser sends
 * an Origin (or only a Referer), it must match a configured web origin.
 * Requests without either (curl, tests, same-origin navigations) pass.
 */
export function requireSameOrigin(allowedOrigins: string[]) {
  return (req: Request, res: Response, next: () => void): void => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) {
      if (!allowedOrigins.includes(origin)) {
        res.status(403).json({ error: 'cross-origin request rejected' });
        return;
      }
      next();
      return;
    }
    const referer = req.headers.referer;
    if (typeof referer === 'string' && referer.length > 0) {
      try {
        const refererOrigin = new URL(referer).origin;
        if (!allowedOrigins.includes(refererOrigin)) {
          res.status(403).json({ error: 'cross-origin request rejected' });
          return;
        }
      } catch {
        res.status(403).json({ error: 'cross-origin request rejected' });
        return;
      }
    }
    next();
  };
}

export interface SessionAuth {
  user: UserRecord;
  sessionId: string;
}

/** Resolves the session cookie to an active user, or null. */
export function authenticateRequest(
  db: DatabaseSync,
  req: Request,
  pepper: string,
  nowMs: number = Date.now(),
): SessionAuth | null {
  const rawToken = getCookieValue(req.headers.cookie, SESSION_COOKIE_NAME);
  if (!rawToken) return null;
  const session = getSessionByToken(db, rawToken, pepper, nowMs);
  if (!session) return null;
  const user = getUserById(db, session.userId);
  if (!user || user.deletedAt !== null) return null;
  touchSession(db, session.id, nowMs);
  return { user, sessionId: session.id };
}

function rateLimitHit(
  limiter: RateLimiter,
  key: string,
  rule: { windowMs: number; max: number },
  res: Response,
): boolean {
  const result = limiter.check(key, rule);
  if (!result.ok) {
    res
      .status(429)
      .json({ error: 'rate limited', retryAfterMs: result.retryAfterMs ?? rule.windowMs });
    return true;
  }
  return false;
}

export function buildAuthRouter(deps: AuthRouteDeps): Router {
  const { db, config, verifier, limiter, sessionDeps, allowedOrigins, getGuestForSocket } = deps;
  const router = Router();
  const csrf = requireSameOrigin(allowedOrigins);

  router.get('/config', (_req, res) => {
    const payload: AuthConfigPayload = {
      googleConfigured: config.googleClientId !== null,
      // The OAuth client id is public by design (it ships in the GIS button).
      googleClientId: config.googleClientId,
      authRequired: config.authRequired,
    };
    res.json(payload);
  });

  router.post('/google', csrf, (req, res) => {
    (async () => {
      if (!config.googleClientId) {
        res.status(503).json({ error: 'Google sign-in is not configured' });
        return;
      }
      const clientIp = req.ip ?? 'unknown';
      if (rateLimitHit(limiter, `auth:${clientIp}`, RATE_LIMIT_RULES.authAttempts, res)) return;
      const body = (req.body ?? {}) as Partial<GoogleLoginRequest>;
      if (typeof body.idToken !== 'string' || body.idToken.length === 0) {
        res.status(400).json({ error: 'idToken required' });
        return;
      }
      let claims;
      try {
        claims = await verifier.verify(body.idToken);
      } catch (error) {
        const detail = error instanceof GoogleTokenError ? error.message : 'verification failed';
        console.warn(`[auth] Google token rejected: ${detail}`);
        res.status(401).json({ error: 'invalid Google credential' });
        return;
      }
      const now = Date.now();
      const existing = getUserBySubject(db, claims.sub);
      let user: UserRecord;
      let isNewAccount = false;
      if (existing) {
        if (existing.status !== 'active') {
          res.status(403).json({ error: 'This account is unavailable.' });
          return;
        }
        recordLogin(db, existing.id, claims, now);
        const refreshed = getUserById(db, existing.id);
        if (!refreshed) {
          res.status(500).json({ error: 'login failed' });
          return;
        }
        user = refreshed;
      } else {
        // First sign-in: the claimable guest identity comes ONLY from the
        // server-known socket registration. A forged playerId in the body
        // is impossible because the body carries no playerId at all.
        const socketId = typeof body.socketId === 'string' ? body.socketId : null;
        const guest = socketId ? getGuestForSocket(socketId) : null;
        try {
          const created = createUserOnFirstLogin(db, claims, guest, now);
          user = created.user;
          isNewAccount = true;
        } catch (error) {
          console.error('[auth] account creation failed:', error);
          res.status(500).json({ error: 'login failed' });
          return;
        }
      }
      const rawToken = createSession(db, user.id, sessionDeps, now);
      setSessionCookie(res, rawToken, sessionDeps);
      const player = toAuthPlayerInfo(user);
      const payload: GoogleLoginResponse = {
        authenticated: true,
        player,
        isNewAccount,
        profileComplete: player.displayName !== '' && player.district !== null,
      };
      res.json(payload);
    })().catch((error) => {
      console.error('[auth] /google failed:', error);
      if (!res.headersSent) res.status(500).json({ error: 'login failed' });
    });
  });

  router.get('/me', (req, res) => {
    const auth = authenticateRequest(db, req, sessionDeps.pepper);
    if (!auth) {
      const payload: AuthMePayload = { authenticated: false, player: null };
      res.json(payload);
      return;
    }
    const player = toAuthPlayerInfo(auth.user);
    const payload: AuthMePayload = {
      authenticated: true,
      player,
      profileComplete: player.displayName !== '' && player.district !== null,
    };
    res.json(payload);
  });

  router.post('/logout', csrf, (req, res) => {
    const rawToken = getCookieValue(req.headers.cookie, SESSION_COOKIE_NAME);
    if (rawToken) revokeSession(db, rawToken, sessionDeps.pepper);
    clearSessionCookie(res, sessionDeps);
    res.json({ ok: true });
  });

  router.patch('/profile', csrf, (req, res) => {
    const auth = authenticateRequest(db, req, sessionDeps.pepper);
    if (!auth) {
      res.status(401).json({ error: 'not authenticated' });
      return;
    }
    if (auth.user.status !== 'active') {
      res.status(403).json({ error: 'This account is unavailable.' });
      return;
    }
    if (
      rateLimitHit(limiter, `rename:${auth.user.playerId}`, RATE_LIMIT_RULES.profileRename, res)
    ) {
      return;
    }
    const body = (req.body ?? {}) as { displayName?: unknown; district?: unknown };
    let user = auth.user;
    if (body.displayName !== undefined) {
      if (typeof body.displayName !== 'string') {
        res.status(400).json({ error: 'invalid display name' });
        return;
      }
      const result = renameUser(db, user.id, body.displayName);
      if (!result.ok) {
        if (result.reason === 'cooldown') {
          res.status(429).json({
            error: 'display name was changed recently',
            retryAfterMs: result.retryAfterMs,
          });
        } else {
          res.status(400).json({ error: 'invalid display name', detail: result.detail });
        }
        return;
      }
      user = result.user;
    }
    if (body.district !== undefined) {
      if (!isKeralaDistrict(body.district)) {
        res.status(400).json({ error: 'invalid district' });
        return;
      }
      const updated = setUserDistrict(db, user.id, body.district);
      if (updated) user = updated;
    }
    res.json({ ok: true, player: toAuthPlayerInfo(user) });
  });

  router.delete('/account', csrf, (req, res) => {
    const auth = authenticateRequest(db, req, sessionDeps.pepper);
    if (!auth) {
      res.status(401).json({ error: 'not authenticated' });
      return;
    }
    anonymizeUser(db, auth.user.id);
    revokeAllUserSessions(db, auth.user.id);
    clearSessionCookie(res, sessionDeps);
    res.json({ ok: true, deleted: true });
  });

  return router;
}
