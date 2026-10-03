/**
 * Weekly featured-game configuration.
 *
 * Every competition week has exactly one featured ranked game. The first
 * time a week is encountered its row is created with the deterministic
 * default rotation; afterwards the stored game is frozen, so history never
 * shifts even if the game registry changes later.
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  GAME_TYPE_CROWN_RUSH,
  GAME_TYPE_PRECISION_CLASH,
  isGameType,
  type CompetitionWeekInfo,
  type GameType,
} from '@kerala-battle/shared';
import { getCompetitionWeek } from './week.js';

/**
 * Default featured-game rotation for newly created weeks. The rotation is
 * only a default: once a week row exists, the stored game wins.
 */
export const FEATURED_GAME_ROTATION: readonly GameType[] = [
  GAME_TYPE_CROWN_RUSH,
  GAME_TYPE_PRECISION_CLASH,
] as const;

export interface CompetitionWeekConfig {
  competitionWeekId: string;
  featuredGameType: GameType;
  startsAt: string;
  endsAt: string;
}

interface CompetitionWeekRow {
  competition_week_id: string;
  featured_game_type: string;
  starts_at: string;
  ends_at: string;
}

/**
 * Deterministic default featured game for a week ID like "2026-W40".
 * Week 40 -> crown-rush, week 41 -> precision-clash, alternating.
 * Malformed IDs fall back to the first rotation entry.
 */
export function defaultFeaturedGameForWeek(weekId: string): GameType {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(weekId);
  const weekNumber = match ? Number.parseInt(match[2] as string, 10) : NaN;
  if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 53) {
    return FEATURED_GAME_ROTATION[0] as GameType;
  }
  return FEATURED_GAME_ROTATION[weekNumber % FEATURED_GAME_ROTATION.length] as GameType;
}

function rowToConfig(row: CompetitionWeekRow): CompetitionWeekConfig {
  if (!isGameType(row.featured_game_type)) {
    // Fail fast: a stored game the registry no longer knows must not start
    // silently wrong matches.
    throw new Error(
      `[competition] week ${row.competition_week_id} has unsupported featured game "${row.featured_game_type}"`,
    );
  }
  return {
    competitionWeekId: row.competition_week_id,
    featuredGameType: row.featured_game_type,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

/** Read a week config without creating it. Undefined when never encountered. */
export function getWeekConfig(db: DatabaseSync, weekId: string): CompetitionWeekConfig | undefined {
  const row = db
    .prepare('SELECT * FROM competition_weeks WHERE competition_week_id = ?')
    .get(weekId) as CompetitionWeekRow | undefined;
  return row ? rowToConfig(row) : undefined;
}

/**
 * Get the config for the week containing `nowMs`, creating the row (with the
 * default rotation game) on first encounter.
 */
export function getOrCreateWeekConfig(db: DatabaseSync, nowMs: number): CompetitionWeekConfig {
  const week: CompetitionWeekInfo = getCompetitionWeek(nowMs);
  const existing = getWeekConfig(db, week.id);
  if (existing) return existing;
  const featuredGameType = defaultFeaturedGameForWeek(week.id);
  db.prepare(
    `INSERT INTO competition_weeks
       (competition_week_id, featured_game_type, starts_at, ends_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(week.id, featuredGameType, week.startsAt, week.endsAt, nowMs);
  console.log(`[competition] week ${week.id} created with featured game ${featuredGameType}`);
  return {
    competitionWeekId: week.id,
    featuredGameType,
    startsAt: week.startsAt,
    endsAt: week.endsAt,
  };
}

/**
 * Development/testing override: set the featured game for a specific week
 * (normally the current one). Rejects anything that is not a supported game.
 * Production guard lives in the script that calls this, not here.
 */
export function setFeaturedGameForWeek(
  db: DatabaseSync,
  weekId: string,
  gameType: GameType,
  nowMs: number = Date.now(),
): CompetitionWeekConfig {
  if (!isGameType(gameType)) throw new Error(`unsupported featured game: ${String(gameType)}`);
  const existing = getWeekConfig(db, weekId);
  const week: CompetitionWeekInfo = existing
    ? { id: existing.competitionWeekId, startsAt: existing.startsAt, endsAt: existing.endsAt }
    : getCompetitionWeek(nowMs);
  db.prepare(
    `INSERT INTO competition_weeks
       (competition_week_id, featured_game_type, starts_at, ends_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(competition_week_id) DO UPDATE SET
       featured_game_type = excluded.featured_game_type`,
  ).run(weekId, gameType, week.startsAt, week.endsAt, nowMs);
  console.log(`[competition] week ${weekId} featured game set to ${gameType}`);
  const updated = getWeekConfig(db, weekId);
  if (!updated) throw new Error(`[competition] week ${weekId} missing after override`);
  return updated;
}
