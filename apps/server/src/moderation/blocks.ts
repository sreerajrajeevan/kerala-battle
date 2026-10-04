/**
 * Persistent player blocking (Task 10).
 *
 * Directional: blocker_player_id blocked blocked_player_id. Effects:
 * - voice: the blocker's client forces the blocked player's audio to 0;
 * - direct challenges: rejected in EITHER direction with a generic
 *   'challenge-unavailable' (never reveals who blocked whom);
 * - ranked matchmaking: intentionally NOT blocked (anti-manipulation);
 * - lobby presence: the blocked avatar stays visible; the client shows a
 *   subtle "Blocked" state instead.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { BlockEntry } from '@kerala-battle/shared';

export type BlockResult =
  | { ok: true; createdAt: number }
  | { ok: false; reason: 'self-block' | 'already-blocked' };

/** Block targetId for blockerId. Idempotent-safe: duplicate → already-blocked. */
export function blockPlayer(
  db: DatabaseSync,
  blockerId: string,
  blockedId: string,
  nowMs: number = Date.now(),
): BlockResult {
  if (blockerId === blockedId) return { ok: false, reason: 'self-block' };
  const existing = db
    .prepare('SELECT 1 FROM player_blocks WHERE blocker_player_id = ? AND blocked_player_id = ?')
    .get(blockerId, blockedId);
  if (existing) return { ok: false, reason: 'already-blocked' };
  db.prepare(
    'INSERT INTO player_blocks (blocker_player_id, blocked_player_id, created_at) VALUES (?, ?, ?)',
  ).run(blockerId, blockedId, nowMs);
  return { ok: true, createdAt: nowMs };
}

/** Remove a block. Returns true when a row was deleted. */
export function unblockPlayer(db: DatabaseSync, blockerId: string, blockedId: string): boolean {
  const result = db
    .prepare('DELETE FROM player_blocks WHERE blocker_player_id = ? AND blocked_player_id = ?')
    .run(blockerId, blockedId);
  return Number(result.changes ?? 0) > 0;
}

/** One-way: has blockerId blocked blockedId? */
export function isBlocked(db: DatabaseSync, blockerId: string, blockedId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM player_blocks WHERE blocker_player_id = ? AND blocked_player_id = ?')
    .get(blockerId, blockedId);
  return !!row;
}

/**
 * Either direction: used by the challenge gate. The caller must NOT reveal
 * the direction to either party.
 */
export function isBlockedEitherWay(db: DatabaseSync, a: string, b: string): boolean {
  if (a === b) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM player_blocks
       WHERE (blocker_player_id = ? AND blocked_player_id = ?)
          OR (blocker_player_id = ? AND blocked_player_id = ?)`,
    )
    .get(a, b, b, a);
  return !!row;
}

/** Blocked playerIds for one blocker (drives client-side voice muting). */
export function getBlockedIds(db: DatabaseSync, blockerId: string): string[] {
  const rows = db
    .prepare('SELECT blocked_player_id FROM player_blocks WHERE blocker_player_id = ?')
    .all(blockerId) as Array<{ blocked_player_id: string }>;
  return rows.map((row) => row.blocked_player_id);
}

/** Blocked players with display names for the Safety panel. */
export function getBlockList(db: DatabaseSync, blockerId: string): BlockEntry[] {
  const rows = db
    .prepare(
      `SELECT b.blocked_player_id AS playerId, b.created_at AS createdAt,
              COALESCE(p.display_name, '') AS displayName
       FROM player_blocks b
       LEFT JOIN players p ON p.player_id = b.blocked_player_id
       WHERE b.blocker_player_id = ?
       ORDER BY b.created_at DESC`,
    )
    .all(blockerId) as Array<{ playerId: string; displayName: string; createdAt: number }>;
  return rows.map((row) => ({
    playerId: row.playerId,
    displayName: row.displayName,
    createdAt: row.createdAt,
  }));
}
