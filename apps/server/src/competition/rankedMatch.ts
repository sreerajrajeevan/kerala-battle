/**
 * Central ranked-settlement validation.
 *
 * Before any ranked points are awarded, the server verifies the match was a
 * legitimate weekly-queue match: ranked mode, weekly-queue source, the game
 * actually featured that week, and two different districts at match time.
 * Anything else settles nothing (casual matches never reach this code).
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  KERALA_DISTRICTS,
  MATCH_MODE_RANKED,
  MATCH_SOURCE_WEEKLY_QUEUE,
  type GameType,
  type KeralaDistrict,
  type MatchMode,
  type MatchSource,
} from '@kerala-battle/shared';
import { getWeekConfig } from './featuredGame.js';

export interface RankedMatchSnapshot {
  matchId: string;
  gameType: GameType;
  matchMode: MatchMode;
  matchSource: MatchSource;
  /** The week snapshotted when the server started the match. */
  competitionWeekId: string | undefined;
  /** Districts represented at match time, aligned with the players order. */
  districts: [KeralaDistrict, KeralaDistrict];
}

export type RankedValidation = { ok: true } | { ok: false; reason: string };

function isKeralaDistrict(value: unknown): value is KeralaDistrict {
  return typeof value === 'string' && (KERALA_DISTRICTS as readonly string[]).includes(value);
}

export function validateRankedMatch(
  db: DatabaseSync,
  snapshot: RankedMatchSnapshot,
): RankedValidation {
  if (snapshot.matchMode !== MATCH_MODE_RANKED) {
    return { ok: false, reason: `match ${snapshot.matchId} is not ranked` };
  }
  if (snapshot.matchSource !== MATCH_SOURCE_WEEKLY_QUEUE) {
    return { ok: false, reason: `match ${snapshot.matchId} did not come from the weekly queue` };
  }
  if (!snapshot.competitionWeekId) {
    return { ok: false, reason: `match ${snapshot.matchId} has no competition week snapshot` };
  }
  const [districtA, districtB] = snapshot.districts;
  if (!isKeralaDistrict(districtA) || !isKeralaDistrict(districtB)) {
    return { ok: false, reason: `match ${snapshot.matchId} has invalid district attribution` };
  }
  if (districtA === districtB) {
    return {
      ok: false,
      reason: `match ${snapshot.matchId} paired same-district players (${districtA})`,
    };
  }
  let week;
  try {
    week = getWeekConfig(db, snapshot.competitionWeekId);
  } catch (error) {
    return {
      ok: false,
      reason: `match ${snapshot.matchId}: ${(error as Error).message}`,
    };
  }
  if (!week) {
    return {
      ok: false,
      reason: `match ${snapshot.matchId} references unknown week ${snapshot.competitionWeekId}`,
    };
  }
  if (week.featuredGameType !== snapshot.gameType) {
    return {
      ok: false,
      reason:
        `match ${snapshot.matchId} played ${snapshot.gameType} ` +
        `but week ${snapshot.competitionWeekId} featured ${week.featuredGameType}`,
    };
  }
  return { ok: true };
}
