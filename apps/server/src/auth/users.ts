/**
 * Stable account store (Task 10).
 *
 * A user row links a Google identity (google_subject, unique) to a stable
 * playerId (unique) that every game system already uses. Game code never sees
 * the Google subject: Google Account -> user record -> playerId -> games.
 *
 * Claim rule: on first sign-in the account may claim the guest playerId of
 * the currently-connected socket session, but only when no other account
 * owns it. The check + insert run in one transaction; the UNIQUE constraint
 * on player_id is the final backstop against double-claims.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { KERALA_DISTRICTS, type KeralaDistrict } from '@kerala-battle/shared';
import { inTransaction } from '../competition/db.js';
import { checkDisplayName, renameAllowed } from './displayName.js';
import type { GoogleIdClaims } from './google.js';

export type AccountStatus = 'active' | 'suspended' | 'banned';

const VALID_STATUSES: readonly string[] = ['active', 'suspended', 'banned'];

export function isAccountStatus(value: unknown): value is AccountStatus {
  return typeof value === 'string' && (VALID_STATUSES as readonly string[]).includes(value);
}

/** One row of the users table. */
export interface UserRecord {
  id: string;
  googleSubject: string | null;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
  playerId: string;
  district: KeralaDistrict | null;
  displayNameChangedAt: number | null;
  status: AccountStatus;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
}

interface UserRow {
  id: string;
  google_subject: string | null;
  email: string | null;
  email_verified: number;
  display_name: string;
  player_id: string;
  district: string | null;
  display_name_changed_at: number | null;
  status: string;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

function isKeralaDistrict(value: unknown): value is KeralaDistrict {
  return typeof value === 'string' && (KERALA_DISTRICTS as readonly string[]).includes(value);
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    googleSubject: row.google_subject,
    email: row.email,
    emailVerified: row.email_verified === 1,
    displayName: row.display_name,
    playerId: row.player_id,
    district: isKeralaDistrict(row.district) ? row.district : null,
    displayNameChangedAt: row.display_name_changed_at,
    status: isAccountStatus(row.status) ? row.status : 'active',
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

export function getUserBySubject(db: DatabaseSync, googleSubject: string): UserRecord | null {
  const row = db
    .prepare('SELECT * FROM users WHERE google_subject = ?')
    .get(googleSubject) as UserRow | undefined;
  return row ? toUserRecord(row) : null;
}

export function getUserByPlayerId(db: DatabaseSync, playerId: string): UserRecord | null {
  const row = db
    .prepare('SELECT * FROM users WHERE player_id = ?')
    .get(playerId) as UserRow | undefined;
  return row ? toUserRecord(row) : null;
}

export function getUserById(db: DatabaseSync, id: string): UserRecord | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? toUserRecord(row) : null;
}

/** True when any account already owns this playerId. */
export function isPlayerIdClaimed(db: DatabaseSync, playerId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM users WHERE player_id = ?')
    .get(playerId) as { '1': number } | undefined;
  return !!row;
}

/** Guest profile the server knows for the currently-connected socket. */
export interface GuestClaim {
  playerId: string;
  displayName: string;
  district: KeralaDistrict;
}

export interface FirstLoginResult {
  user: UserRecord;
  /** True when the guest playerId was successfully claimed. */
  claimedGuestProfile: boolean;
}

/**
 * First Google sign-in: creates the user row. When a connected guest session
 * offers a claimable playerId, the account links to it so ranked points,
 * match history and Weekly Master records keep belonging to the same
 * playerId. Otherwise a fresh stable playerId is minted.
 *
 * The claim check and insert are transactional; the UNIQUE(player_id)
 * constraint rejects a race that slips through the check.
 */
export function createUserOnFirstLogin(
  db: DatabaseSync,
  claims: GoogleIdClaims,
  guest: GuestClaim | null,
  nowMs: number = Date.now(),
): FirstLoginResult {
  return inTransaction(db, () => {
    const existing = getUserBySubject(db, claims.sub);
    if (existing) {
      throw new Error('[auth] account already exists for this Google subject');
    }
    let playerId: string = randomUUID();
    let displayName = '';
    let district: KeralaDistrict | null = null;
    let claimedGuestProfile = false;
    if (guest && !isPlayerIdClaimed(db, guest.playerId)) {
      // Safe to claim: this socket proved it holds the guest identity, and
      // no account owns the playerId yet.
      playerId = guest.playerId;
      const nameCheck = checkDisplayName(guest.displayName);
      displayName = nameCheck.ok ? nameCheck.normalized : '';
      district = guest.district;
      claimedGuestProfile = true;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO users
         (id, google_subject, email, email_verified, display_name, player_id,
          district, display_name_changed_at, status, deleted_at,
          created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active', NULL, ?, ?, ?)`,
    ).run(
      id,
      claims.sub,
      claims.email || null,
      claims.emailVerified ? 1 : 0,
      displayName,
      playerId,
      district,
      nowMs,
      nowMs,
      nowMs,
    );
    const created = getUserById(db, id);
    if (!created) throw new Error('[auth] failed to read back created user');
    return { user: created, claimedGuestProfile };
  });
}

/** Returning sign-in: refresh email + last login. Never creates a second row. */
export function recordLogin(db: DatabaseSync, userId: string, claims: GoogleIdClaims, nowMs: number): void {
  db.prepare(
    `UPDATE users SET email = ?, email_verified = ?, last_login_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(claims.email || null, claims.emailVerified ? 1 : 0, nowMs, nowMs, userId);
}

export type RenameResult =
  | { ok: true; user: UserRecord }
  | { ok: false; reason: 'invalid-name'; detail?: string }
  | { ok: false; reason: 'cooldown'; retryAfterMs: number };

/**
 * Authenticated display-name change. Initial setup (empty current name)
 * never counts as a rename; afterwards one change per 7 days.
 */
export function renameUser(
  db: DatabaseSync,
  userId: string,
  rawName: string,
  nowMs: number = Date.now(),
): RenameResult {
  const user = getUserById(db, userId);
  if (!user) return { ok: false, reason: 'invalid-name', detail: 'unknown user' };
  const check = checkDisplayName(rawName);
  if (!check.ok) return { ok: false, reason: 'invalid-name', detail: check.reason };
  const isInitialSetup = user.displayName === '';
  if (!isInitialSetup) {
    const gate = renameAllowed(user.displayNameChangedAt, nowMs);
    if (!gate.allowed) return { ok: false, reason: 'cooldown', retryAfterMs: gate.retryAfterMs };
  }
  const changedAt = isInitialSetup ? user.displayNameChangedAt : nowMs;
  db.prepare(
    'UPDATE users SET display_name = ?, display_name_changed_at = ?, updated_at = ? WHERE id = ?',
  ).run(check.normalized, changedAt, nowMs, userId);
  // Keep the competitive profile row in sync; Hall of Fame snapshots are
  // separate immutable tables and are never touched.
  if (user.district) {
    db.prepare(
      `INSERT INTO players (player_id, display_name, district, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
    ).run(user.playerId, check.normalized, user.district, nowMs, nowMs);
  }
  const updated = getUserById(db, userId);
  if (!updated) return { ok: false, reason: 'invalid-name', detail: 'unknown user' };
  return { ok: true, user: updated };
}

/** Persist the player's current district on the account profile. */
export function setUserDistrict(
  db: DatabaseSync,
  userId: string,
  district: KeralaDistrict,
  nowMs: number = Date.now(),
): UserRecord | null {
  db.prepare('UPDATE users SET district = ?, updated_at = ? WHERE id = ?').run(
    district,
    nowMs,
    userId,
  );
  return getUserById(db, userId);
}

/** Operator action: change account status. Returns the updated row. */
export function setAccountStatus(
  db: DatabaseSync,
  playerId: string,
  status: AccountStatus,
  nowMs: number = Date.now(),
): UserRecord | null {
  db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE player_id = ?').run(
    status,
    nowMs,
    playerId,
  );
  return getUserByPlayerId(db, playerId);
}

/**
 * Account deletion / anonymization (Task 10, section 33).
 *
 * - revokes every session for the account;
 * - unlinks the Google identity (google_subject/email cleared);
 * - deletes blocks in both directions;
 * - marks the row deleted and renames the public profile to "Deleted Player";
 * - KEEPS player_id, matches, weekly stats and Hall of Fame snapshots
 *   untouched so historical competition records stay valid.
 */
export function anonymizeUser(db: DatabaseSync, userId: string, nowMs: number = Date.now()): UserRecord | null {
  return inTransaction(db, () => {
    const user = getUserById(db, userId);
    if (!user) return null;
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
      nowMs,
      userId,
    );
    db.prepare(
      `UPDATE users
       SET google_subject = NULL, email = NULL, email_verified = 0,
           display_name = 'Deleted Player', deleted_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(nowMs, nowMs, userId);
    db.prepare(
      'DELETE FROM player_blocks WHERE blocker_player_id = ? OR blocked_player_id = ?',
    ).run(user.playerId, user.playerId);
    // Reports are operator history and stay; the reporter's identity is the
    // stable playerId, which is intentionally preserved.
    return getUserById(db, userId);
  });
}

/** Public shape: safe to return from APIs. No subject, email, or internals. */
export function toAuthPlayerInfo(user: UserRecord): {
  playerId: string;
  displayName: string;
  district: KeralaDistrict | null;
} {
  return { playerId: user.playerId, displayName: user.displayName, district: user.district };
}
