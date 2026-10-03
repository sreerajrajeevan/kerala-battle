/**
 * Competition repository: all persistent reads/writes for weekly rankings.
 *
 * Design notes:
 * - Every settlement runs inside a single SQLite transaction.
 * - settleRankedMatch is idempotent: the PRIMARY KEY on matches.match_id
 *   means a repeated call for the same matchId changes nothing and re-reads
 *   the stored awards.
 * - District scores always use the capped per-match district contribution
 *   stored on the matches row, attributed to the district each player
 *   represented when the match finished (historical attribution).
 * - This module is the only place that issues SQL, so a future PostgreSQL
 *   port only rewrites this file.
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  COMPETITION_DAILY_DISTRICT_CAP,
  KERALA_DISTRICTS,
  type DistrictLeaderboardEntry,
  type KeralaDistrict,
  type MatchMode,
  type MatchSource,
  type MyWeeklyStats,
  type PlayerLeaderboardEntry,
  type PlayerSettlement,
} from '@kerala-battle/shared';
import { districtAwardFor, personalPointsFor, type MatchOutcome } from './settlement.js';
import { getCompetitionDay, getCompetitionWeek } from './week.js';
import { inTransaction } from './db.js';

// ---------------------------------------------------------------------------
// Settlement input (game-agnostic: future mini-games reuse this interface)
// ---------------------------------------------------------------------------

export interface RankedPlayerInput {
  playerId: string;
  displayName: string;
  district: KeralaDistrict;
  /** Final game score (e.g. Precision Clash total). */
  score: number;
}

export interface SettleRankedMatchInput {
  matchId: string;
  gameType: string;
  /** Server-authoritative: only 'ranked' matches reach settlement. */
  matchMode: MatchMode;
  /** Server-authoritative: only 'weekly-queue' matches are ranked. */
  matchSource: MatchSource;
  players: [RankedPlayerInput, RankedPlayerInput];
  /** Null for a draw; otherwise must be one of the two playerIds. */
  winnerPlayerId: string | null;
  /** Unix ms when the match legitimately finished. */
  completedAtMs: number;
  /**
   * Authoritative competition week, snapshotted when the server started the
   * match. A match that starts Sunday night and finishes Monday morning
   * settles into the week it started in. Defaults to the completion time's
   * week when omitted (legacy direct path).
   */
  competitionWeekId?: string;
}

export interface SettlementOutcome {
  /** True when this matchId was already settled; nothing was changed. */
  alreadySettled: boolean;
  weekId: string;
  /** Awards keyed by playerId. */
  awards: Record<string, PlayerSettlement>;
}

interface MatchRow {
  match_id: string;
  player_a_id: string;
  player_b_id: string;
  player_a_district: string;
  player_b_district: string;
  player_a_personal_points: number;
  player_b_personal_points: number;
  player_a_district_contribution: number;
  player_b_district_contribution: number;
  competition_week_id: string;
  completed_at: number;
}

interface WeeklyStatsRow {
  player_id: string;
  display_name: string;
  district: string;
  matches_played: number;
  wins: number;
  losses: number;
  draws: number;
  points: number;
}

/** One player's complete weekly aggregate (no limit, deterministic order). */
export interface PlayerWeeklyAggregate {
  playerId: string;
  displayName: string;
  district: KeralaDistrict;
  points: number;
  wins: number;
  losses: number;
  draws: number;
  matchesPlayed: number;
}

/** One district's weekly aggregate, before ranking. */
export interface DistrictWeeklyAggregate {
  district: KeralaDistrict;
  points: number;
  wins: number;
  activePlayers: number;
  pointsPerActivePlayer: number;
}

/**
 * Central district tie-break, used by the live leaderboard and by week
 * finalization alike so the crowned champion is always the district the
 * players saw at #1: points desc, wins desc, activePlayers desc, name asc.
 * Never falls back to database row ordering.
 */
export function compareDistrictStandings(
  a: DistrictWeeklyAggregate,
  b: DistrictWeeklyAggregate,
): number {
  return (
    b.points - a.points ||
    b.wins - a.wins ||
    b.activePlayers - a.activePlayers ||
    (a.district < b.district ? -1 : a.district > b.district ? 1 : 0)
  );
}

function asNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/**
 * Insert or refresh a guest player. Called when a player joins a district
 * (and therefore also when they switch districts): the same playerId keeps
 * a single row whose district always reflects the current one.
 */
export function upsertPlayer(
  db: DatabaseSync,
  playerId: string,
  displayName: string,
  district: KeralaDistrict,
  nowMs: number = Date.now(),
): void {
  db.prepare(
    `INSERT INTO players (player_id, display_name, district, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(player_id) DO UPDATE SET
       display_name = excluded.display_name,
       district = excluded.district,
       updated_at = excluded.updated_at`,
  ).run(playerId, displayName, district, nowMs, nowMs);
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

function getDailyContribution(db: DatabaseSync, dayId: string, playerId: string): number {
  const row = db
    .prepare('SELECT contribution FROM daily_district_contribution WHERE competition_day_id = ? AND player_id = ?')
    .get(dayId, playerId) as { contribution: number | bigint } | undefined;
  return row ? asNumber(row.contribution) : 0;
}

function addDailyContribution(
  db: DatabaseSync,
  dayId: string,
  playerId: string,
  district: KeralaDistrict,
  points: number,
): void {
  if (points <= 0) return;
  db.prepare(
    `INSERT INTO daily_district_contribution (competition_day_id, player_id, district, contribution)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(competition_day_id, player_id) DO UPDATE SET
       district = excluded.district,
       contribution = daily_district_contribution.contribution + excluded.contribution`,
  ).run(dayId, playerId, district, points);
}

function upsertWeeklyStats(
  db: DatabaseSync,
  weekId: string,
  player: RankedPlayerInput,
  outcome: MatchOutcome,
  personalPoints: number,
): void {
  db.prepare(
    `INSERT INTO weekly_player_stats
       (competition_week_id, player_id, display_name, district, matches_played, wins, losses, draws, points)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(competition_week_id, player_id) DO UPDATE SET
       display_name = excluded.display_name,
       district = excluded.district,
       matches_played = weekly_player_stats.matches_played + 1,
       wins = weekly_player_stats.wins + excluded.wins,
       losses = weekly_player_stats.losses + excluded.losses,
       draws = weekly_player_stats.draws + excluded.draws,
       points = weekly_player_stats.points + excluded.points`,
  ).run(
    weekId,
    player.playerId,
    player.displayName,
    player.district,
    outcome === 'win' ? 1 : 0,
    outcome === 'loss' ? 1 : 0,
    outcome === 'draw' ? 1 : 0,
    personalPoints,
  );
}

function getWeeklyPoints(db: DatabaseSync, weekId: string, playerId: string): number {
  const row = db
    .prepare('SELECT points FROM weekly_player_stats WHERE competition_week_id = ? AND player_id = ?')
    .get(weekId, playerId) as { points: number | bigint } | undefined;
  return row ? asNumber(row.points) : 0;
}

function buildAwards(
  db: DatabaseSync,
  weekId: string,
  dayId: string,
  entries: Array<{
    player: RankedPlayerInput;
    personalPoints: number;
    districtPoints: number;
  }>,
): Record<string, PlayerSettlement> {
  const awards: Record<string, PlayerSettlement> = {};
  for (const entry of entries) {
    awards[entry.player.playerId] = {
      personalPointsAwarded: entry.personalPoints,
      districtPointsAwarded: entry.districtPoints,
      weeklyPersonalPoints: getWeeklyPoints(db, weekId, entry.player.playerId),
      dailyDistrictContribution: getDailyContribution(db, dayId, entry.player.playerId),
      dailyDistrictContributionCap: COMPETITION_DAILY_DISTRICT_CAP,
      district: entry.player.district,
    };
  }
  return awards;
}

/**
 * Records one legitimately completed ranked match and all of its ranking
 * effects. Idempotent: calling twice with the same matchId returns the
 * stored awards without duplicating any points.
 */
export function settleRankedMatch(db: DatabaseSync, input: SettleRankedMatchInput): SettlementOutcome {
  const [playerA, playerB] = input.players;
  if (!playerA || !playerB) throw new Error('settleRankedMatch requires exactly two players');
  if (playerA.playerId === playerB.playerId) throw new Error('settleRankedMatch players must be distinct');
  if (
    input.winnerPlayerId !== null &&
    input.winnerPlayerId !== playerA.playerId &&
    input.winnerPlayerId !== playerB.playerId
  ) {
    throw new Error('settleRankedMatch winner must be one of the players');
  }

  const week = input.competitionWeekId
    ? { id: input.competitionWeekId }
    : getCompetitionWeek(input.completedAtMs);
  const day = getCompetitionDay(input.completedAtMs);
  const outcomeFor = (player: RankedPlayerInput): MatchOutcome =>
    input.winnerPlayerId === null ? 'draw' : input.winnerPlayerId === player.playerId ? 'win' : 'loss';

  const settle = (): SettlementOutcome =>
    inTransaction(db, (): SettlementOutcome => {
    const computed = [playerA, playerB].map((player) => {
      const personalPoints = personalPointsFor(outcomeFor(player));
      const usedToday = getDailyContribution(db, day.id, player.playerId);
      return { player, personalPoints, districtPoints: districtAwardFor(personalPoints, usedToday) };
    });

    const insert = db.prepare(
      `INSERT INTO matches (
         match_id, game_type, match_mode, match_source,
         player_a_id, player_b_id,
         player_a_score, player_b_score,
         player_a_district, player_b_district,
         player_a_personal_points, player_b_personal_points,
         player_a_district_contribution, player_b_district_contribution,
         winner_player_id, completed_at, competition_week_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_id) DO NOTHING`,
    );
    const result = insert.run(
      input.matchId,
      input.gameType,
      input.matchMode,
      input.matchSource,
      playerA.playerId,
      playerB.playerId,
      playerA.score,
      playerB.score,
      playerA.district,
      playerB.district,
      computed[0]?.personalPoints ?? 0,
      computed[1]?.personalPoints ?? 0,
      computed[0]?.districtPoints ?? 0,
      computed[1]?.districtPoints ?? 0,
      input.winnerPlayerId,
      input.completedAtMs,
      week.id,
    );

    if (asNumber(result.changes) === 0) {
      // Already settled: re-read the stored awards, change nothing.
      const row = db.prepare('SELECT * FROM matches WHERE match_id = ?').get(input.matchId) as
        | MatchRow
        | undefined;
      if (!row) throw new Error('settleRankedMatch: match vanished mid-transaction');
      const stored = [
        {
          player: { ...playerA, district: row.player_a_district as KeralaDistrict },
          personalPoints: asNumber(row.player_a_personal_points),
          districtPoints: asNumber(row.player_a_district_contribution),
        },
        {
          player: { ...playerB, district: row.player_b_district as KeralaDistrict },
          personalPoints: asNumber(row.player_b_personal_points),
          districtPoints: asNumber(row.player_b_district_contribution),
        },
      ];
      return {
        alreadySettled: true,
        weekId: row.competition_week_id,
        awards: buildAwards(db, row.competition_week_id, day.id, stored),
      };
    }

    for (const entry of computed) {
      addDailyContribution(db, day.id, entry.player.playerId, entry.player.district, entry.districtPoints);
      const outcome = outcomeFor(entry.player);
      upsertWeeklyStats(db, week.id, entry.player, outcome, entry.personalPoints);
      upsertPlayer(db, entry.player.playerId, entry.player.displayName, entry.player.district, input.completedAtMs);
    }

    return { alreadySettled: false, weekId: week.id, awards: buildAwards(db, week.id, day.id, computed) };
  });

  return settle();
}

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

/**
 * Every player's aggregate for a competition week, in the canonical
 * leaderboard order (points desc, wins desc, fewer matches first, playerId).
 * No limit: finalization snapshots the complete standings from this.
 */
export function getAllPlayerWeeklyStats(db: DatabaseSync, weekId: string): PlayerWeeklyAggregate[] {
  const rows = db
    .prepare(
      `SELECT player_id, display_name, district, points, wins, losses, draws, matches_played
       FROM weekly_player_stats
       WHERE competition_week_id = ?
       ORDER BY points DESC, wins DESC, matches_played ASC, player_id ASC`,
    )
    .all(weekId) as unknown as WeeklyStatsRow[];
  return rows.map((row) => ({
    playerId: row.player_id,
    displayName: row.display_name,
    district: row.district as KeralaDistrict,
    points: asNumber(row.points),
    wins: asNumber(row.wins),
    losses: asNumber(row.losses),
    draws: asNumber(row.draws),
    matchesPlayed: asNumber(row.matches_played),
  }));
}

/**
 * Top players for a competition week. Deterministic tie-break:
 * points desc, wins desc, fewer matches played first, then playerId.
 */
export function getPlayerLeaderboard(
  db: DatabaseSync,
  weekId: string,
  limit: number,
): PlayerLeaderboardEntry[] {
  const capped = Math.max(1, Math.min(100, Math.floor(limit)));
  return getAllPlayerWeeklyStats(db, weekId)
    .slice(0, capped)
    .map((entry, index): PlayerLeaderboardEntry => ({
      rank: index + 1,
      playerId: entry.playerId,
      displayName: entry.displayName,
      district: entry.district,
      points: entry.points,
      wins: entry.wins,
      matchesPlayed: entry.matchesPlayed,
    }));
}

/** One player's own weekly stats, or null when they have no ranked matches. */
export function getMyWeeklyStats(
  db: DatabaseSync,
  weekId: string,
  dayId: string,
  playerId: string,
): MyWeeklyStats | null {
  const row = db
    .prepare(
      `SELECT player_id, display_name, district, points, wins, losses, draws, matches_played
       FROM weekly_player_stats
       WHERE competition_week_id = ? AND player_id = ?`,
    )
    .get(weekId, playerId) as WeeklyStatsRow | undefined;
  if (!row) return null;

  const points = asNumber(row.points);
  const wins = asNumber(row.wins);
  const matchesPlayed = asNumber(row.matches_played);
  const better = db
    .prepare(
      `SELECT COUNT(*) AS better FROM weekly_player_stats
       WHERE competition_week_id = ?
         AND (points > ?
           OR (points = ? AND wins > ?)
           OR (points = ? AND wins = ? AND matches_played < ?)
           OR (points = ? AND wins = ? AND matches_played = ? AND player_id < ?))`,
    )
    .get(weekId, points, points, wins, points, wins, matchesPlayed, points, wins, matchesPlayed, playerId) as
    | { better: number | bigint }
    | undefined;

  return {
    rank: asNumber(better?.better) + 1,
    points,
    wins,
    losses: asNumber(row.losses),
    draws: asNumber(row.draws),
    matchesPlayed,
    winRate: matchesPlayed === 0 ? 0 : wins / matchesPlayed,
    district: row.district as KeralaDistrict,
    dailyDistrictContribution: getDailyContribution(db, dayId, playerId),
    dailyDistrictContributionCap: COMPETITION_DAILY_DISTRICT_CAP,
  };
}

/**
 * All 14 districts' aggregates for a competition week (unordered).
 * Districts with no matches appear with zeros.
 */
export function getDistrictStandings(db: DatabaseSync, weekId: string): DistrictWeeklyAggregate[] {
  const pointsRows = db
    .prepare(
      `SELECT district, SUM(contribution) AS points FROM (
         SELECT player_a_district AS district, player_a_district_contribution AS contribution
         FROM matches WHERE competition_week_id = ?
         UNION ALL
         SELECT player_b_district, player_b_district_contribution
         FROM matches WHERE competition_week_id = ?
       ) GROUP BY district`,
    )
    .all(weekId, weekId) as Array<{ district: string; points: number | bigint }>;
  const winsRows = db
    .prepare(
      `SELECT
         CASE WHEN winner_player_id = player_a_id THEN player_a_district ELSE player_b_district END AS district,
         COUNT(*) AS wins
       FROM matches
       WHERE competition_week_id = ? AND winner_player_id IS NOT NULL
       GROUP BY district`,
    )
    .all(weekId) as Array<{ district: string; wins: number | bigint }>;
  const activeRows = db
    .prepare(
      `SELECT district, COUNT(*) AS active FROM (
         SELECT player_a_district AS district, player_a_id AS pid FROM matches WHERE competition_week_id = ?
         UNION
         SELECT player_b_district, player_b_id FROM matches WHERE competition_week_id = ?
       ) GROUP BY district`,
    )
    .all(weekId, weekId) as Array<{ district: string; active: number | bigint }>;

  const pointsByDistrict = new Map(pointsRows.map((r) => [r.district, asNumber(r.points)]));
  const winsByDistrict = new Map(winsRows.map((r) => [r.district, asNumber(r.wins)]));
  const activeByDistrict = new Map(activeRows.map((r) => [r.district, asNumber(r.active)]));

  return KERALA_DISTRICTS.map((district) => {
    const points = pointsByDistrict.get(district) ?? 0;
    const activePlayers = activeByDistrict.get(district) ?? 0;
    return {
      district,
      points,
      activePlayers,
      wins: winsByDistrict.get(district) ?? 0,
      pointsPerActivePlayer: activePlayers === 0 ? 0 : points / activePlayers,
    };
  });
}

/**
 * All 14 districts for a competition week, ranked by total capped district
 * contribution using the central tie-break. Districts with no matches appear
 * with zeros.
 */
export function getDistrictLeaderboard(db: DatabaseSync, weekId: string): DistrictLeaderboardEntry[] {
  return getDistrictStandings(db, weekId)
    .sort(compareDistrictStandings)
    .map((entry, index): DistrictLeaderboardEntry => ({ rank: index + 1, ...entry }));
}
