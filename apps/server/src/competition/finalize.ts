/**
 * Weekly finalization: when a competition week ends, crown the Weekly Master
 * (#1 player) and District Champion (#1 district) and snapshot the complete
 * standings as immutable history.
 *
 * Correctness notes:
 * - finalizeCompetitionWeek is idempotent: a second call for the same week
 *   changes nothing and creates no duplicate rows.
 * - Champions reuse the exact live-leaderboard ordering (players: points /
 *   wins / fewer matches / playerId; districts: the central
 *   compareDistrictStandings tie-break), so the crowned winners are the ones
 *   players saw at #1 all week.
 * - A week is only finalized after it has ended AND no ranked match that
 *   started in that week is still active. A bounded grace period keeps a
 *   stuck match from blocking a week forever.
 * - History is snapshotted (display names, districts, featured game), never
 *   derived from mutable current state, so later profile/district changes or
 *   rotation changes cannot rewrite it.
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  GAME_DEFINITIONS,
  type DistrictChampionSummary,
  type GameType,
  type HistoricalDistrictResult,
  type HistoricalPlayerResult,
  type HistoricalWeekDetail,
  type HistoricalWeekSummary,
  type PreviousChampionInfo,
  type WeeklyMasterSummary,
} from '@kerala-battle/shared';
import { inTransaction } from './db.js';
import {
  compareDistrictStandings,
  getAllPlayerWeeklyStats,
  getDistrictStandings,
} from './store.js';
import { getOrCreateWeekConfig, getWeekConfig } from './featuredGame.js';
import { getCompetitionWeek, getCompetitionWeekById } from './week.js';

/**
 * How long after week end finalization still waits for genuinely active
 * old-week ranked matches before finalizing anyway (bounded recovery).
 */
export const FINALIZATION_GRACE_MS = 10 * 60 * 1000;

/** Recent-weeks default for the history API. */
export const HISTORY_DEFAULT_LIMIT = 12;

export type FinalizeStatus =
  | 'finalized'
  | 'already-finalized'
  | 'week-not-ended'
  | 'active-matches';

export interface FinalizeChampions {
  weeklyMaster: WeeklyMasterSummary | null;
  districtChampion: DistrictChampionSummary | null;
  featuredGameType: GameType;
}

export interface FinalizeOutcome {
  status: FinalizeStatus;
  weekId: string;
  /** Present when status is 'finalized'. */
  champions?: FinalizeChampions;
  /** Present when status is 'active-matches'. */
  activeRankedMatches?: number;
  /** Present when status is 'active-matches'. */
  retryAfterMs?: number;
}

export interface FinalizeOptions {
  nowMs?: number;
  /** Ranked matches still in progress whose week snapshot is this week. */
  activeRankedMatchCount?: number;
}

interface WeekResultRow {
  competition_week_id: string;
  featured_game_type: string;
  starts_at: string;
  ends_at: string;
  finalized_at: number;
  weekly_master_player_id: string | null;
  weekly_master_display_name: string | null;
  weekly_master_district: string | null;
  weekly_master_points: number;
  weekly_master_wins: number;
  weekly_master_matches_played: number;
  district_champion: string | null;
  district_champion_points: number;
  district_champion_wins: number;
  district_champion_active_players: number;
}

interface WeekPlayerResultRow {
  final_rank: number;
  player_id: string;
  display_name: string;
  district: string;
  points: number;
  wins: number;
  losses: number;
  draws: number;
  matches_played: number;
}

interface WeekDistrictResultRow {
  final_rank: number;
  district: string;
  points: number;
  wins: number;
  active_players: number;
  points_per_active_player: number;
}

function asNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

/** True when the week already has an immutable result row. */
export function isWeekFinalized(db: DatabaseSync, weekId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS one FROM competition_week_results WHERE competition_week_id = ?')
    .get(weekId) as { one: number } | undefined;
  return row !== undefined;
}

function weekEndsAtMs(db: DatabaseSync, weekId: string): { startsAt: string; endsAt: string; endsAtMs: number } {
  const config = getWeekConfig(db, weekId);
  const info = config
    ? { startsAt: config.startsAt, endsAt: config.endsAt }
    : (() => {
        const byId = getCompetitionWeekById(weekId);
        return { startsAt: byId.startsAt, endsAt: byId.endsAt };
      })();
  const endsAtMs = Date.parse(info.endsAt);
  if (!Number.isFinite(endsAtMs)) throw new Error(`[competition] unparseable week end: ${info.endsAt}`);
  return { ...info, endsAtMs };
}

/**
 * Finalize one competition week. Synchronous and idempotent; safe to call
 * from startup recovery, the history API path, a timer, or the dev script.
 */
export function finalizeCompetitionWeek(
  db: DatabaseSync,
  weekId: string,
  options: FinalizeOptions = {},
): FinalizeOutcome {
  const nowMs = options.nowMs ?? Date.now();
  const activeRankedMatches = options.activeRankedMatchCount ?? 0;

  if (isWeekFinalized(db, weekId)) {
    return { status: 'already-finalized', weekId };
  }

  const { startsAt, endsAt, endsAtMs } = weekEndsAtMs(db, weekId);
  if (nowMs <= endsAtMs) {
    return { status: 'week-not-ended', weekId };
  }

  const graceEndsAtMs = endsAtMs + FINALIZATION_GRACE_MS;
  if (activeRankedMatches > 0) {
    if (nowMs < graceEndsAtMs) {
      // Legitimate old-week matches may still settle into this week: wait
      // for them. (A match starting after the boundary belongs to the new
      // week, so with zero active matches there is nothing to wait for.)
      return {
        status: 'active-matches',
        weekId,
        activeRankedMatches,
        retryAfterMs: graceEndsAtMs - nowMs,
      };
    }
    // Bounded recovery: a stuck match must not block the week forever.
    console.warn(
      `[competition] finalizing ${weekId} with ${activeRankedMatches} ranked match(es) still ` +
        `active past the grace period`,
    );
  }

  // Featured game is the week's frozen config (never the live rotation).
  const weekConfig = getOrCreateWeekConfig(db, endsAtMs - 1);
  const featuredGameType = weekConfig.featuredGameType;

  const players = getAllPlayerWeeklyStats(db, weekId);
  const districts = getDistrictStandings(db, weekId).sort(compareDistrictStandings);

  const topPlayer = players[0];
  const weeklyMaster: WeeklyMasterSummary | null = topPlayer
    ? {
        playerId: topPlayer.playerId,
        displayName: topPlayer.displayName,
        district: topPlayer.district,
        points: topPlayer.points,
        wins: topPlayer.wins,
        matchesPlayed: topPlayer.matchesPlayed,
      }
    : null;

  // Never crown an arbitrary zero-point district: no qualifying district
  // means no District Champion for the week.
  const topDistrict = districts[0]?.points ? districts[0] : undefined;
  const districtChampion: DistrictChampionSummary | null = topDistrict
    ? {
        district: topDistrict.district,
        points: topDistrict.points,
        wins: topDistrict.wins,
        activePlayers: topDistrict.activePlayers,
      }
    : null;

  const finalizedAt = nowMs;
  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO competition_week_results (
         competition_week_id, featured_game_type, starts_at, ends_at, finalized_at,
         weekly_master_player_id, weekly_master_display_name, weekly_master_district,
         weekly_master_points, weekly_master_wins, weekly_master_matches_played,
         district_champion, district_champion_points, district_champion_wins,
         district_champion_active_players
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      weekId,
      featuredGameType,
      startsAt,
      endsAt,
      finalizedAt,
      weeklyMaster?.playerId ?? null,
      weeklyMaster?.displayName ?? null,
      weeklyMaster?.district ?? null,
      weeklyMaster?.points ?? 0,
      weeklyMaster?.wins ?? 0,
      weeklyMaster?.matchesPlayed ?? 0,
      districtChampion?.district ?? null,
      districtChampion?.points ?? 0,
      districtChampion?.wins ?? 0,
      districtChampion?.activePlayers ?? 0,
    );

    const insertPlayer = db.prepare(
      `INSERT INTO competition_week_player_results (
         competition_week_id, final_rank, player_id, display_name, district,
         points, wins, losses, draws, matches_played
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    players.forEach((player, index) => {
      insertPlayer.run(
        weekId,
        index + 1,
        player.playerId,
        player.displayName,
        player.district,
        player.points,
        player.wins,
        player.losses,
        player.draws,
        player.matchesPlayed,
      );
    });

    const insertDistrict = db.prepare(
      `INSERT INTO competition_week_district_results (
         competition_week_id, final_rank, district, points, wins,
         active_players, points_per_active_player
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    districts.forEach((district, index) => {
      insertDistrict.run(
        weekId,
        index + 1,
        district.district,
        district.points,
        district.wins,
        district.activePlayers,
        district.pointsPerActivePlayer,
      );
    });
  });

  console.log(
    `[competition] week ${weekId} finalized: master=${weeklyMaster?.displayName ?? 'none'} ` +
      `champion=${districtChampion?.district ?? 'none'} players=${players.length}`,
  );
  return {
    status: 'finalized',
    weekId,
    champions: { weeklyMaster, districtChampion, featuredGameType },
  };
}

export interface EnsureFinalizedOptions {
  nowMs?: number;
  /** Live count of unfinished ranked matches snapshotted to the given week. */
  activeRankedMatchCountForWeek?: (weekId: string) => number;
}

export interface EnsureFinalizedOutcome {
  finalized: string[];
  /** Weeks that ended but are waiting (active matches / grace period). */
  delayed: string[];
}

/**
 * Recovery scan: finalize every ended but unfinalized week that has any
 * trace (a week-config row or ranked matches). Called on server startup,
 * on a timer, and when current-competition data is requested, so correctness
 * never depends on the process being awake at Monday 00:00.
 */
export function ensurePastWeeksFinalized(
  db: DatabaseSync,
  options: EnsureFinalizedOptions = {},
): EnsureFinalizedOutcome {
  const nowMs = options.nowMs ?? Date.now();
  const activeCountFor = options.activeRankedMatchCountForWeek ?? (() => 0);
  const rows = db
    .prepare(
      `SELECT competition_week_id AS weekId FROM competition_weeks
       UNION
       SELECT DISTINCT competition_week_id AS weekId FROM matches`,
    )
    .all() as Array<{ weekId: string }>;

  const finalized: string[] = [];
  const delayed: string[] = [];
  for (const { weekId } of rows) {
    if (isWeekFinalized(db, weekId)) continue;
    let endsAtMs: number;
    try {
      endsAtMs = weekEndsAtMs(db, weekId).endsAtMs;
    } catch {
      continue; // Malformed week id: leave it alone, never crash recovery.
    }
    if (nowMs <= endsAtMs) continue; // Current or future week.
    try {
      const outcome = finalizeCompetitionWeek(db, weekId, {
        nowMs,
        activeRankedMatchCount: activeCountFor(weekId),
      });
      if (outcome.status === 'finalized') finalized.push(weekId);
      else delayed.push(weekId);
    } catch (error) {
      console.error(`[competition] recovery finalization failed for ${weekId}:`, error);
      delayed.push(weekId);
    }
  }
  return { finalized, delayed };
}

// ---------------------------------------------------------------------------
// History reads (finalized weeks only)
// ---------------------------------------------------------------------------

function rowToSummary(row: WeekResultRow): HistoricalWeekSummary {
  const featuredGameType = row.featured_game_type as GameType;
  return {
    competitionWeekId: row.competition_week_id,
    featuredGameType,
    featuredGameLabel: GAME_DEFINITIONS[featuredGameType]?.label ?? featuredGameType,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    finalizedAt: asNumber(row.finalized_at),
    weeklyMaster: row.weekly_master_player_id
      ? {
          playerId: row.weekly_master_player_id,
          displayName: row.weekly_master_display_name ?? '',
          district: (row.weekly_master_district ?? 'Kannur') as WeeklyMasterSummary['district'],
          points: asNumber(row.weekly_master_points),
          wins: asNumber(row.weekly_master_wins),
          matchesPlayed: asNumber(row.weekly_master_matches_played),
        }
      : null,
    districtChampion: row.district_champion
      ? {
          district: row.district_champion as DistrictChampionSummary['district'],
          points: asNumber(row.district_champion_points),
          wins: asNumber(row.district_champion_wins),
          activePlayers: asNumber(row.district_champion_active_players),
        }
      : null,
  };
}

/** Newest-first summaries of finalized weeks. */
export function getHistorySummaries(db: DatabaseSync, limit: number = HISTORY_DEFAULT_LIMIT): HistoricalWeekSummary[] {
  const rows = db
    .prepare(
      `SELECT * FROM competition_week_results
       ORDER BY competition_week_id DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(52, Math.floor(limit)))) as unknown as WeekResultRow[];
  return rows.map(rowToSummary);
}

/** Full snapshotted detail for one finalized week; null when not finalized. */
export function getHistoryDetail(db: DatabaseSync, weekId: string): HistoricalWeekDetail | null {
  const row = db
    .prepare('SELECT * FROM competition_week_results WHERE competition_week_id = ?')
    .get(weekId) as unknown as WeekResultRow | undefined;
  if (!row) return null;
  const summary = rowToSummary(row);
  const playerRows = db
    .prepare(
      `SELECT * FROM competition_week_player_results
       WHERE competition_week_id = ? ORDER BY final_rank ASC`,
    )
    .all(weekId) as unknown as WeekPlayerResultRow[];
  const districtRows = db
    .prepare(
      `SELECT * FROM competition_week_district_results
       WHERE competition_week_id = ? ORDER BY final_rank ASC`,
    )
    .all(weekId) as unknown as WeekDistrictResultRow[];
  const players: HistoricalPlayerResult[] = playerRows.map((r) => ({
    rank: asNumber(r.final_rank),
    playerId: r.player_id,
    displayName: r.display_name,
    district: r.district as HistoricalPlayerResult['district'],
    points: asNumber(r.points),
    wins: asNumber(r.wins),
    losses: asNumber(r.losses),
    draws: asNumber(r.draws),
    matchesPlayed: asNumber(r.matches_played),
  }));
  const districts: HistoricalDistrictResult[] = districtRows.map((r) => ({
    rank: asNumber(r.final_rank),
    district: r.district as HistoricalDistrictResult['district'],
    points: asNumber(r.points),
    wins: asNumber(r.wins),
    activePlayers: asNumber(r.active_players),
    pointsPerActivePlayer: asNumber(r.points_per_active_player),
  }));
  return { ...summary, players, districts };
}

/**
 * The most recently finalized week before the current one, for the lobby's
 * "last week" banner and badges. Null when no week has been finalized yet.
 */
export function getPreviousChampion(db: DatabaseSync, nowMs: number = Date.now()): PreviousChampionInfo | null {
  const currentWeekId = getCompetitionWeek(nowMs).id;
  const row = db
    .prepare(
      `SELECT * FROM competition_week_results
       WHERE competition_week_id < ?
       ORDER BY competition_week_id DESC
       LIMIT 1`,
    )
    .get(currentWeekId) as unknown as WeekResultRow | undefined;
  if (!row) return null;
  const summary = rowToSummary(row);
  return {
    weekId: summary.competitionWeekId,
    weeklyMaster: summary.weeklyMaster,
    districtChampion: summary.districtChampion,
  };
}
