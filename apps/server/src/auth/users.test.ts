/**
 * Unit tests for the user store: account creation, guest-profile claiming,
 * rename cooldown, district persistence, status changes, anonymization.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../competition/db.js';
import {
  anonymizeUser,
  createUserOnFirstLogin,
  getUserByPlayerId,
  getUserBySubject,
  isPlayerIdClaimed,
  recordLogin,
  renameUser,
  setAccountStatus,
  setUserDistrict,
  toAuthPlayerInfo,
  type GuestClaim,
} from './users.js';
import type { GoogleIdClaims } from './google.js';

const NOW = 1_750_000_000_000;
const CLAIMS: GoogleIdClaims = { sub: 'google-sub-1', email: 'sree@example.com', emailVerified: true };
const GUEST: GuestClaim = { playerId: 'guest-abc', displayName: 'Sree', district: 'Kannur' };

function testDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return db;
}

test('first login without a guest creates a fresh playerId', () => {
  const db = testDb();
  const { user, claimedGuestProfile } = createUserOnFirstLogin(db, CLAIMS, null, NOW);
  assert.equal(claimedGuestProfile, false);
  assert.ok(user.playerId.length > 0);
  assert.equal(user.displayName, '');
  assert.equal(user.district, null);
  assert.equal(user.status, 'active');
  assert.equal(getUserBySubject(db, CLAIMS.sub)?.id, user.id);
});

test('first login claims the connected guest profile', () => {
  const db = testDb();
  const { user, claimedGuestProfile } = createUserOnFirstLogin(db, CLAIMS, GUEST, NOW);
  assert.equal(claimedGuestProfile, true);
  assert.equal(user.playerId, 'guest-abc');
  assert.equal(user.displayName, 'Sree');
  assert.equal(user.district, 'Kannur');
  assert.equal(isPlayerIdClaimed(db, 'guest-abc'), true);
});

test('a guest playerId already owned by another account is not claimed twice', () => {
  const db = testDb();
  createUserOnFirstLogin(db, CLAIMS, GUEST, NOW);
  const other: GoogleIdClaims = { sub: 'google-sub-2', email: 'b@example.com', emailVerified: true };
  const { user, claimedGuestProfile } = createUserOnFirstLogin(db, other, GUEST, NOW);
  // Falls back to a fresh identity instead of stealing the playerId.
  assert.equal(claimedGuestProfile, false);
  assert.notEqual(user.playerId, 'guest-abc');
  assert.equal(getUserByPlayerId(db, 'guest-abc')?.googleSubject, 'google-sub-1');
});

test('email change with the same subject does not create another account', () => {
  const db = testDb();
  const first = createUserOnFirstLogin(db, CLAIMS, null, NOW).user;
  const changed: GoogleIdClaims = { sub: CLAIMS.sub, email: 'new@example.com', emailVerified: true };
  assert.ok(getUserBySubject(db, changed.sub));
  recordLogin(db, first.id, changed, NOW + 1000);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  assert.equal(rows.n, 1);
  assert.equal(getUserBySubject(db, changed.sub)?.email, 'new@example.com');
});

test('rename: initial setup is free, then the 7-day cooldown applies', () => {
  const db = testDb();
  const { user } = createUserOnFirstLogin(db, CLAIMS, null, NOW);
  // Initial setup (empty name) never counts as a rename.
  const setup = renameUser(db, user.id, 'Sree', NOW);
  assert.equal(setup.ok, true);
  if (setup.ok) assert.equal(setup.user.displayName, 'Sree');

  // A real rename stamps the cooldown...
  const renamed = renameUser(db, user.id, 'SreeK', NOW);
  assert.equal(renamed.ok, true);

  // ...and an immediate second rename is rejected.
  const tooSoon = renameUser(db, user.id, 'SreeKK', NOW + 1000);
  assert.equal(tooSoon.ok, false);
  if (!tooSoon.ok) assert.equal(tooSoon.reason, 'cooldown');

  // After 7 days it works again.
  const later = renameUser(db, user.id, 'SreeKK', NOW + 7 * 24 * 3600 * 1000 + 1);
  assert.equal(later.ok, true);
});

test('rename rejects invalid names', () => {
  const db = testDb();
  const { user } = createUserOnFirstLogin(db, CLAIMS, null, NOW);
  assert.equal(renameUser(db, user.id, 'x', NOW).ok, false);
  assert.equal(renameUser(db, user.id, '   ', NOW).ok, false);
});

test('district persists on the account profile', () => {
  const db = testDb();
  const { user } = createUserOnFirstLogin(db, CLAIMS, GUEST, NOW);
  const updated = setUserDistrict(db, user.id, 'Kozhikode', NOW);
  assert.equal(updated?.district, 'Kozhikode');
});

test('operator status changes are readable', () => {
  const db = testDb();
  createUserOnFirstLogin(db, CLAIMS, GUEST, NOW);
  assert.equal(setAccountStatus(db, 'guest-abc', 'banned')?.status, 'banned');
  assert.equal(setAccountStatus(db, 'guest-abc', 'suspended')?.status, 'suspended');
  assert.equal(setAccountStatus(db, 'guest-abc', 'active')?.status, 'active');
  assert.equal(setAccountStatus(db, 'nope', 'banned'), null);
});

test('anonymize: unlinks Google identity, keeps history keys', () => {
  const db = testDb();
  const { user } = createUserOnFirstLogin(db, CLAIMS, GUEST, NOW);
  const deleted = anonymizeUser(db, user.id, NOW);
  assert.ok(deleted);
  assert.equal(deleted.googleSubject, null);
  assert.equal(deleted.email, null);
  assert.equal(deleted.displayName, 'Deleted Player');
  assert.ok(deleted.deletedAt !== null);
  // playerId is preserved so matches/history stay valid.
  assert.equal(deleted.playerId, 'guest-abc');
  // The same Google subject can sign in again as a NEW account later.
  assert.equal(getUserBySubject(db, CLAIMS.sub), null);
});

test('toAuthPlayerInfo never leaks internals', () => {
  const db = testDb();
  const { user } = createUserOnFirstLogin(db, CLAIMS, GUEST, NOW);
  const info = toAuthPlayerInfo(user);
  assert.deepEqual(Object.keys(info).sort(), ['displayName', 'district', 'playerId']);
  assert.equal((info as Record<string, unknown>).googleSubject, undefined);
  assert.equal((info as Record<string, unknown>).email, undefined);
});
