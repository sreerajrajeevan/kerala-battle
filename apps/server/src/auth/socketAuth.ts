/**
 * Socket.IO authentication bridge (Task 10).
 *
 * The browser's session cookie is sent with the Socket.IO handshake
 * (same-origin, or cross-origin with credentials). At connection time the
 * server resolves it to the canonical account identity and stores it on
 * socket.data. Game handlers then use the canonical playerId instead of
 * anything the client claims.
 *
 * Login/logout force a socket reconnect on the client, so handshake state is
 * always fresh. Account STATUS is re-checked from the database on every
 * sensitive action (join, challenge, queue, voice) so a mid-session ban or
 * suspension takes effect immediately.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Socket } from 'socket.io';
import {
  getCookieValue,
  getSessionByToken,
  SESSION_COOKIE_NAME,
} from './sessions.js';
import { getUserById, type UserRecord } from './users.js';

/** Canonical identity attached to an authenticated socket. */
export interface SocketAuth {
  userId: string;
  playerId: string;
}

const DATA_KEY = '__kb_auth';

export function setSocketAuth(socket: Socket, auth: SocketAuth | null): void {
  (socket.data as Record<string, unknown>)[DATA_KEY] = auth;
}

/** Identity captured at handshake time, or null for guests/anonymous. */
export function getSocketAuth(socket: Socket): SocketAuth | null {
  const value = (socket.data as Record<string, unknown>)[DATA_KEY];
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as SocketAuth).userId === 'string' &&
    typeof (value as SocketAuth).playerId === 'string'
  ) {
    return value as SocketAuth;
  }
  return null;
}

/**
 * Resolves the handshake cookie to a canonical identity. Returns null when
 * there is no usable session (anonymous guest socket).
 */
export function authenticateSocketHandshake(
  db: DatabaseSync,
  cookieHeader: string | undefined,
  pepper: string,
  nowMs: number = Date.now(),
): SocketAuth | null {
  const rawToken = getCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  if (!rawToken) return null;
  const session = getSessionByToken(db, rawToken, pepper, nowMs);
  if (!session) return null;
  const user = getUserById(db, session.userId);
  if (!user || user.deletedAt !== null) return null;
  return { userId: user.id, playerId: user.playerId };
}

export type AccountGateResult =
  /** user is null in guest mode (auth disabled): no account to check. */
  | { ok: true; user: UserRecord | null }
  | { ok: false; reason: 'auth-required' | 'account-unavailable' };

/**
 * Central account gate for sensitive socket actions. When auth is required,
 * the socket must carry a handshake identity AND the account must be active
 * right now. Guests (auth disabled mode) pass through with no user.
 */
export function gateSocketAccount(
  db: DatabaseSync,
  socket: Socket,
  authRequired: boolean,
): AccountGateResult {
  if (!authRequired) {
    // Development/test guest mode: no account to check. Callers fall back to
    // the socket's registered guest identity.
    return { ok: true, user: null };
  }
  const auth = getSocketAuth(socket);
  if (!auth) return { ok: false, reason: 'auth-required' };
  const user = getUserById(db, auth.userId);
  if (!user || user.deletedAt !== null || user.status !== 'active') {
    return { ok: false, reason: 'account-unavailable' };
  }
  return { ok: true, user };
}
