/**
 * Unit tests for server-side sessions: creation, verification, expiry,
 * revocation, peppered hashing, and cookie helpers.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../competition/db.js';
import {
  createSession,
  getCookieValue,
  getSessionByToken,
  revokeAllUserSessions,
  revokeSession,
  clearSessionCookie,
  setSessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  type SessionDeps,
} from './sessions.js';

const NOW = 1_750_000_000_000;
const DEPS: SessionDeps = { pepper: 'test-pepper', secureCookies: false };

function testDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return db;
}

function seedUser(db: DatabaseSync, id = 'user-1'): void {
  db.prepare(
    `INSERT INTO users (id, google_subject, email, email_verified, display_name,
      player_id, district, status, created_at, updated_at, last_login_at)
     VALUES (?, 'sub-1', 'a@example.com', 1, 'Sree', 'player-1', 'Kannur',
       'active', ?, ?, ?)`,
  ).run(id, NOW, NOW, NOW);
}

test('created session verifies and the DB stores only a hash', () => {
  const db = testDb();
  seedUser(db);
  const raw = createSession(db, 'user-1', DEPS, NOW);
  assert.ok(raw.length >= 32, 'opaque token');

  const session = getSessionByToken(db, raw, DEPS.pepper, NOW);
  assert.ok(session);
  assert.equal(session.userId, 'user-1');
  assert.equal(session.expiresAt, NOW + SESSION_TTL_MS);

  // The raw token must not appear anywhere in the stored row.
  const stored = db
    .prepare('SELECT token_hash FROM sessions')
    .get() as { token_hash: string };
  assert.ok(!stored.token_hash.includes(raw.slice(0, 16)));
  assert.equal(stored.token_hash.length, 64, 'sha-256 hex');
});

test('wrong pepper does not verify', () => {
  const db = testDb();
  seedUser(db);
  const raw = createSession(db, 'user-1', DEPS, NOW);
  assert.equal(getSessionByToken(db, raw, 'other-pepper', NOW), null);
});

test('expired sessions are rejected', () => {
  const db = testDb();
  seedUser(db);
  const raw = createSession(db, 'user-1', DEPS, NOW);
  assert.equal(getSessionByToken(db, raw, DEPS.pepper, NOW + SESSION_TTL_MS + 1), null);
  // Boundary: exactly at expiry is expired.
  assert.equal(getSessionByToken(db, raw, DEPS.pepper, NOW + SESSION_TTL_MS), null);
});

test('revoked sessions are rejected', () => {
  const db = testDb();
  seedUser(db);
  const raw = createSession(db, 'user-1', DEPS, NOW);
  assert.equal(revokeSession(db, raw, DEPS.pepper, NOW), true);
  assert.equal(getSessionByToken(db, raw, DEPS.pepper, NOW), null);
  // Revoking twice is a clean no-op.
  assert.equal(revokeSession(db, raw, DEPS.pepper, NOW), false);
});

test('revoke-all ends every session for the user', () => {
  const db = testDb();
  seedUser(db);
  const a = createSession(db, 'user-1', DEPS, NOW);
  const b = createSession(db, 'user-1', DEPS, NOW);
  assert.equal(revokeAllUserSessions(db, 'user-1', NOW), 2);
  assert.equal(getSessionByToken(db, a, DEPS.pepper, NOW), null);
  assert.equal(getSessionByToken(db, b, DEPS.pepper, NOW), null);
});

test('malformed tokens are rejected without DB access errors', () => {
  const db = testDb();
  seedUser(db);
  assert.equal(getSessionByToken(db, '', DEPS.pepper, NOW), null);
  assert.equal(getSessionByToken(db, 'x'.repeat(300), DEPS.pepper, NOW), null);
  assert.equal(getSessionByToken(db, 'nope', DEPS.pepper, NOW), null);
});

test('session cookie is HttpOnly + SameSite=Lax, Secure only in production', () => {
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => { headers[k] = v; } };
  setSessionCookie(res as never, 'raw-token', DEPS);
  const value = headers['Set-Cookie'];
  assert.ok(value.includes(`${SESSION_COOKIE_NAME}=raw-token`));
  assert.ok(value.includes('HttpOnly'));
  assert.ok(value.includes('SameSite=Lax'));
  assert.ok(!value.includes('Secure'));

  const prodHeaders: Record<string, string> = {};
  const prodRes = { setHeader: (k: string, v: string) => { prodHeaders[k] = v; } };
  setSessionCookie(prodRes as never, 'raw-token', { pepper: 'p', secureCookies: true });
  assert.ok(prodHeaders['Set-Cookie'].includes('Secure'));

  const clearHeaders: Record<string, string> = {};
  clearSessionCookie({ setHeader: (k: string, v: string) => { clearHeaders[k] = v; } } as never, DEPS);
  assert.ok(clearHeaders['Set-Cookie'].includes('Max-Age=0'));
});

test('cookie parser extracts the session value', () => {
  assert.equal(getCookieValue('a=1; kb_session=abc123; b=2', SESSION_COOKIE_NAME), 'abc123');
  assert.equal(getCookieValue(undefined, SESSION_COOKIE_NAME), null);
  assert.equal(getCookieValue('a=1', SESSION_COOKIE_NAME), null);
  assert.equal(getCookieValue('kb_session=hello%20world', SESSION_COOKIE_NAME), 'hello world');
});
