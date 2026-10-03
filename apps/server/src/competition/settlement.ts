/**
 * Pure competition scoring helpers (no database access).
 *
 * Personal weekly points for one completed Precision Clash match:
 *   Win  = 10 + 2 bonus = 12
 *   Draw =  6 + 2 bonus =  8
 *   Loss =  3 + 2 bonus =  5
 *
 * The completion bonus is only awarded for legitimately completed matches;
 * disconnect forfeits, cancelled and incomplete matches never reach settlement.
 */

import {
  COMPETITION_DAILY_DISTRICT_CAP,
  COMPETITION_POINTS_COMPLETION_BONUS,
  COMPETITION_POINTS_DRAW,
  COMPETITION_POINTS_LOSS,
  COMPETITION_POINTS_WIN,
} from '@kerala-battle/shared';

export type MatchOutcome = 'win' | 'loss' | 'draw';

/** Weekly personal points for one completed match outcome. */
export function personalPointsFor(outcome: MatchOutcome): number {
  switch (outcome) {
    case 'win':
      return COMPETITION_POINTS_WIN + COMPETITION_POINTS_COMPLETION_BONUS;
    case 'draw':
      return COMPETITION_POINTS_DRAW + COMPETITION_POINTS_COMPLETION_BONUS;
    case 'loss':
      return COMPETITION_POINTS_LOSS + COMPETITION_POINTS_COMPLETION_BONUS;
  }
}

/**
 * District points actually credited for a match, given how much of the
 * player's daily district contribution cap is already used.
 * Never negative, never exceeds the remaining cap.
 */
export function districtAwardFor(
  personalPoints: number,
  usedToday: number,
  cap: number = COMPETITION_DAILY_DISTRICT_CAP,
): number {
  const remaining = cap - Math.max(0, usedToday);
  return Math.max(0, Math.min(personalPoints, remaining));
}
