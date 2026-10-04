/**
 * Unit tests for the Socket.IO auth bridge: handshake cookie resolution and
 * the central account gate.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../competition/db.js';
import {
  authenticateSocketHandshake,
  gateSocketAccount,
  getSocketAuth,
  setSocketAuth,
} from './socketAuth.js';
import { createSession, SESSION_COOKIE_NAME, type SessionDeps } from './sessions.js';
import { setAccountStatus } from './users.js';

const NOW = 1_750_000_000_000;
const PEPPER = 'test-pepper';
const DEPS: SessionDeps = { pepper: PEPPER, secureCookies: false };

function testDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO users (id, google_subject, email, email_verified, display_name,
      player_id, district, status, created_at, updated_at, last_login_at)
     VALUES ('user-1', 'sub-1', 'a@example.com', 1, 'Sree', 'player-1', 'Kannur',
       'active', ?, ?, ?)`,
  ).run(NOW, NOW, NOW);
  return db;
}

function fakeSocket(): { data: Record<string, unknown> } {
  return { data: {} };
}

test('handshake resolves a valid session cookie to the canonical identity', () => {
  const db = testDb();
  const raw = createSession(db, 'user-1', DEPS, NOW);
  const auth = authenticateSocketHandshake(
    db,
    `${SESSION_COOKIE_NAME}=${raw}; other=1`,
    PEPPER,
    NOW,
  );
  assert.deepEqual(auth, { userId: 'user-1', playerId: 'player-1' });
});

test('handshake returns null without a usable session', () => {
  const db = testDb();
  assert.equal(authenticateSocketHandshake(db, undefined, PEPPER, NOW), null);
  assert.equal(authenticateSocketHandshake(db, 'a=1', PEPPER, NOW), null);
  assert.equal(
    authenticateSocketHandshake(db, `${SESSION_COOKIE_NAME}=bogus`, PEPPER, NOW),
    null,
  );
});

test('socket auth round-trips through socket.data', () => {
  const socket = fakeSocket();
  assert.equal(getSocketAuth(socket as never), null);
  setSocketAuth(socket as never, { userId: 'u', playerId: 'p' });
  assert.deepEqual(getSocketAuth(socket as never), { userId: 'u', playerId: 'p' });
  setSocketAuth(socket as never, null);
  assert.equal(getSocketAuth(socket as never), null);
});

test('gate: auth-required mode rejects anonymous sockets', () => {
  const db = testDb();
  const socket = fakeSocket();
  const result = gateSocketAccount(db, socket as never, true);
  assert.deepEqual(result, { ok: false, reason: 'auth-required' });
});

test('gate: auth-required mode accepts a live session', () => {
  const db = testDb();
  const raw = createSession(db, 'user-1', DEPS, NOW);
  const socket = fakeSocket();
  setSocketAuth(
    socket as never,
    authenticateSocketHandshake(db, `${SESSION_COOKIE_NAME}=${raw}`, PEPPER, NOW),
  );
  const result = gateSocketAccount(db, socket as never, true);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.user?.playerId, 'player-1');
});

test('gate: banned accounts are rejected even with a live session', () => {
  const db = testDb();
  const raw = createSession(db, 'user-1', DEPS, NOW);
  setAccountStatus(db, 'player-1', 'banned', NOW);
  const socket = fakeSocket();
  setSocketAuth(
    socket as never,
    authenticateSocketHandshake(db, `${SESSION_COOKIE_NAME}=${raw}`, PEPPER, NOW),
  );
  const result = gateSocketAccount(db, socket as never, true);
  assert.deepEqual(result, { ok: false, reason: 'account-unavailable' });
});

test('gate: guest mode passes through without an account', () => {
  const db = testDb();
  const socket = fakeSocket();
  const result = gateSocketAccount(db, socket as never, false);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.user, null);
});
