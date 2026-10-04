/**
 * Server-side sessions (Task 10).
 *
 * The browser holds an opaque random token in an HttpOnly cookie
 * (SameSite=Lax, Secure in production). The database stores only a
 * peppered SHA-256 hash of the token, so a database read never reveals a
 * usable session. Sessions live 30 days and survive server restarts.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Response } from 'express';

export const SESSION_COOKIE_NAME = 'kb_session';

/** 30-day session lifetime. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashToken(rawToken: string, pepper: string): string {
  return createHash('sha256').update(`${pepper}:${rawToken}`, 'utf8').digest('hex');
}

/** One row of the sessions table. */
export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

export interface SessionDeps {
  pepper: string;
  /** Secure cookie flag (true in production, false for localhost dev). */
  secureCookies: boolean;
}

/**
 * Creates a session and returns the RAW token (shown once, to the cookie).
 * Only the hash is persisted.
 */
export function createSession(
  db: DatabaseSync,
  userId: string,
  deps: SessionDeps,
  nowMs: number = Date.now(),
): string {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken, deps.pepper);
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    `sess_${randomBytes(8).toString('hex')}`,
    userId,
    tokenHash,
    nowMs,
    nowMs + SESSION_TTL_MS,
    nowMs,
  );
  return rawToken;
}

/** Resolves a raw cookie token to its session row, or null. */
export function getSessionByToken(
  db: DatabaseSync,
  rawToken: string,
  pepper: string,
  nowMs: number = Date.now(),
): SessionRecord | null {
  if (typeof rawToken !== 'string' || rawToken.length === 0 || rawToken.length > 256) return null;
  const tokenHash = hashToken(rawToken, pepper);
  const row = db
    .prepare('SELECT * FROM sessions WHERE token_hash = ?')
    .get(tokenHash) as
    | {
        id: string;
        user_id: string;
        created_at: number;
        expires_at: number;
        last_seen_at: number;
        revoked_at: number | null;
      }
    | undefined;
  if (!row) return null;
  if (row.revoked_at !== null || row.expires_at <= nowMs) return null;
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

/** Refreshes last_seen_at on an active session (cheap heartbeat). */
export function touchSession(db: DatabaseSync, sessionId: string, nowMs: number = Date.now()): void {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowMs, sessionId);
}

/** Revokes one session by raw token. Returns true when a row was revoked. */
export function revokeSession(
  db: DatabaseSync,
  rawToken: string,
  pepper: string,
  nowMs: number = Date.now(),
): boolean {
  const session = getSessionByToken(db, rawToken, pepper, nowMs);
  if (!session) return false;
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
    nowMs,
    session.id,
  );
  return true;
}

/** Revokes every live session for a user (sign-out-everywhere / deletion). */
export function revokeAllUserSessions(
  db: DatabaseSync,
  userId: string,
  nowMs: number = Date.now(),
): number {
  const result = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(nowMs, userId);
  return Number(result.changes ?? 0);
}

/** Sets the session cookie. HttpOnly always; Secure in production. */
export function setSessionCookie(res: Response, rawToken: string, deps: SessionDeps): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (deps.secureCookies) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** Clears the session cookie. */
export function clearSessionCookie(res: Response, deps: SessionDeps): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (deps.secureCookies) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** Minimal cookie parser (no dependency): extracts one named value. */
export function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
