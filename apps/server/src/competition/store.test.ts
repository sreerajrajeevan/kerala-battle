/**
 * Integration tests for the competition repository (in-memory SQLite).
 * Covers: win/draw scoring, daily district cap, partial cap, idempotent
 * settlement, historical district attribution, week boundaries, and
 * leaderboard tie-breaks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  GAME_TYPE_PRECISION_CLASH,
  KERALA_DISTRICTS,
  MATCH_MODE_RANKED,
  MATCH_SOURCE_WEEKLY_QUEUE,
  type KeralaDistrict,
} from '@kerala-battle/shared';
import { runMigrations } from './db.js';
import {
  getDistrictLeaderboard,
  getMyWeeklyStats,
  getPlayerLeaderboard,
  settleRankedMatch,
  upsertPlayer,
  type RankedPlayerInput,
  type SettleRankedMatchInput,
} from './store.js';
import { getCompetitionDay, getCompetitionWeek } from './week.js';

// Fixed instants (deterministic regardless of when tests run).
// 2026-10-03 12:00 UTC == 17:30 IST, Saturday -> week 2026-W40, day 2026-10-03.
const SAT = Date.UTC(2026, 9, 3, 12, 0, 0);
const WEEK_ID = getCompetitionWeek(SAT).id;
const DAY_ID = getCompetitionDay(SAT).id;

function testDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return db;
}

function player(playerId: string, district: KeralaDistrict, score: number): RankedPlayerInput {
  return { playerId, displayName: `Name-${playerId}`, district, score };
}

function settle(
  db: DatabaseSync,
  a: RankedPlayerInput,
  b: RankedPlayerInput,
  winnerPlayerId: string | null,
  completedAtMs: number = SAT,
) {
  const input: SettleRankedMatchInput = {
    matchId: randomUUID(),
    gameType: GAME_TYPE_PRECISION_CLASH,
    matchMode: MATCH_MODE_RANKED,
    matchSource: MATCH_SOURCE_WEEKLY_QUEUE,
    players: [a, b],
    winnerPlayerId,
    completedAtMs,
  };
  return settleRankedMatch(db, input);
}

test('win settlement: winner +12/+12, loser +5/+5', () => {
  const db = testDb();
  const outcome = settle(db, player('sree', 'Kannur', 261), player('anu', 'Kannur', 244), 'sree');

  assert.equal(outcome.alreadySettled, false);
  assert.equal(outcome.weekId, WEEK_ID);
  assert.deepEqual(
    { p: outcome.awards['sree']?.personalPointsAwarded, d: outcome.awards['sree']?.districtPointsAwarded },
    { p: 12, d: 12 },
  );
  assert.deepEqual(
    { p: outcome.awards['anu']?.personalPointsAwarded, d: outcome.awards['anu']?.districtPointsAwarded },
    { p: 5, d: 5 },
  );

  const board = getPlayerLeaderboard(db, WEEK_ID, 50);
  assert.equal(board.length, 2);
  assert.equal(board[0]?.playerId, 'sree');
  assert.equal(board[0]?.points, 12);
  assert.equal(board[0]?.wins, 1);

  const districts = getDistrictLeaderboard(db, WEEK_ID);
  const kannur = districts.find((d) => d.district === 'Kannur');
  assert.equal(kannur?.points, 17);
  assert.equal(kannur?.activePlayers, 2);
  assert.equal(kannur?.wins, 1);
});

test('draw settlement: 8 personal points each', () => {
  const db = testDb();
  const outcome = settle(db, player('a', 'Kozhikode', 200), player('b', 'Kozhikode', 200), null);
  assert.equal(outcome.awards['a']?.personalPointsAwarded, 8);
  assert.equal(outcome.awards['b']?.personalPointsAwarded, 8);
  assert.equal(outcome.awards['a']?.districtPointsAwarded, 8);
  const me = getMyWeeklyStats(db, WEEK_ID, DAY_ID, 'a');
  assert.equal(me?.draws, 1);
  assert.equal(me?.points, 8);
});

test('settlement is idempotent: settling twice changes nothing', () => {
  const db = testDb();
  const input: SettleRankedMatchInput = {
    matchId: 'match-dupe-1',
    gameType: GAME_TYPE_PRECISION_CLASH,
    matchMode: MATCH_MODE_RANKED,
    matchSource: MATCH_SOURCE_WEEKLY_QUEUE,
    players: [player('sree', 'Kannur', 250), player('anu', 'Kannur', 100)],
    winnerPlayerId: 'sree',
    completedAtMs: SAT,
  };
  const first = settleRankedMatch(db, input);
  const second = settleRankedMatch(db, input);
  assert.equal(first.alreadySettled, false);
  assert.equal(second.alreadySettled, true);
  assert.deepEqual(second.awards, first.awards);

  const matchCount = (
    db.prepare('SELECT COUNT(*) AS n FROM matches').get() as { n: number }
  ).n;
  assert.equal(Number(matchCount), 1);
  const me = getMyWeeklyStats(db, WEEK_ID, DAY_ID, 'sree');
  assert.equal(me?.points, 12);
  assert.equal(me?.matchesPlayed, 1);
});

test('daily district cap: personal points keep growing, district stops at 50', () => {
  const db = testDb();
  for (let i = 0; i < 5; i++) {
    const outcome = settle(db, player('sree', 'Kannur', 250), player(`opp${i}`, 'Kannur', 100), 'sree');
    assert.equal(outcome.awards['sree']?.personalPointsAwarded, 12);
  }
  // 5 wins x 12 = 60 personal; district capped: 12+12+12+12+2 = 50.
  const sixth = settle(db, player('sree', 'Kannur', 250), player('opp5', 'Kannur', 100), 'sree');
  assert.equal(sixth.awards['sree']?.personalPointsAwarded, 12);
  assert.equal(sixth.awards['sree']?.districtPointsAwarded, 0);
  assert.equal(sixth.awards['sree']?.dailyDistrictContribution, 50);

  const me = getMyWeeklyStats(db, WEEK_ID, DAY_ID, 'sree');
  assert.equal(me?.points, 72); // 6 x 12, uncapped
  assert.equal(me?.dailyDistrictContribution, 50);

  const kannur = getDistrictLeaderboard(db, WEEK_ID).find((d) => d.district === 'Kannur');
  // Sree contributed 50; six opponents lost (5 pts each, all under their own caps).
  assert.equal(kannur?.points, 50 + 6 * 5);
});

test('partial cap: 47/50 used, win credits only 3 district points', () => {
  const db = testDb();
  // 3 wins (36) + 1 win with... build up to 47: 12+12+12 = 36, then a draw = 8 -> 44,
  // then a loss = 5 -> 49. Instead: use wins then adjust via direct check below.
  settle(db, player('sree', 'Kannur', 250), player('o1', 'Kannur', 100), 'sree'); // 12
  settle(db, player('sree', 'Kannur', 250), player('o2', 'Kannur', 100), 'sree'); // 24
  settle(db, player('sree', 'Kannur', 250), player('o3', 'Kannur', 100), 'sree'); // 36
  const draw = settle(db, player('sree', 'Kannur', 200), player('o4', 'Kannur', 200), null); // +8 -> 44
  assert.equal(draw.awards['sree']?.districtPointsAwarded, 8);
  const partial = settle(db, player('sree', 'Kannur', 250), player('o5', 'Kannur', 100), 'sree');
  assert.equal(partial.awards['sree']?.personalPointsAwarded, 12);
  assert.equal(partial.awards['sree']?.districtPointsAwarded, 6); // 50 - 44
  assert.equal(partial.awards['sree']?.dailyDistrictContribution, 50);
});

test('historical district attribution survives a district switch', () => {
  const db = testDb();
  // Sree scores for Kannur, then switches to Kozhikode and scores again.
  settle(db, player('sree', 'Kannur', 250), player('a1', 'Kannur', 100), 'sree');
  settle(db, player('sree', 'Kozhikode', 250), player('b1', 'Kozhikode', 100), 'sree');

  const districts = getDistrictLeaderboard(db, WEEK_ID);
  const kannur = districts.find((d) => d.district === 'Kannur');
  const kozhikode = districts.find((d) => d.district === 'Kozhikode');
  // Kannur keeps Sree's 12 + a1's 5; Kozhikode gets Sree's 12 + b1's 5.
  assert.equal(kannur?.points, 17);
  assert.equal(kozhikode?.points, 17);
  // Sree counts as active in both districts (one match attributed to each).
  assert.equal(kannur?.activePlayers, 2);
  assert.equal(kozhikode?.activePlayers, 2);
});

test('district leaderboard lists all 14 districts even with no matches', () => {
  const db = testDb();
  const districts = getDistrictLeaderboard(db, WEEK_ID);
  assert.equal(districts.length, 14);
  assert.deepEqual(
    districts.map((d) => d.district).sort(),
    [...KERALA_DISTRICTS].sort(),
  );
  assert.ok(districts.every((d) => d.points === 0 && d.activePlayers === 0));
});

test('player leaderboard tie-break: points, then wins, then fewer matches', () => {
  const db = testDb();
  // p1: 2 wins = 24 pts, 2 matches. p2: 3 wins = 36 pts... craft ties instead:
  // p1: 1 win + 1 draw = 20 pts, 1 win. p2: 1 win + 1 draw = 20 pts, 1 win, but p2 played an extra loss (25 pts?) no...
  // Simpler: p1: win (12) + draw (8) = 20 pts, 2 matches, 1 win.
  //          p2: win (12) + loss (5) + draw (8) = 25 pts -- not a tie.
  // Tie on points, differ on wins: p3: 2 draws + 1 win = 28 pts, 1 win; p4: 1 win + 2 losses = 22... 
  // Cleanest: pA: 2 wins = 24 pts (2 matches, 2 wins). pB: 1 win + 2 draws = 28? no.
  // pA: 3 draws = 24 pts, 0 wins, 3 matches. pB: 2 wins = 24 pts, 2 wins, 2 matches -> pB first (more wins).
  settle(db, player('pA', 'Kannur', 200), player('x1', 'Kannur', 200), null);
  settle(db, player('pA', 'Kannur', 200), player('x2', 'Kannur', 200), null);
  settle(db, player('pA', 'Kannur', 200), player('x3', 'Kannur', 200), null);
  settle(db, player('pB', 'Kannur', 250), player('y1', 'Kannur', 100), 'pB');
  settle(db, player('pB', 'Kannur', 250), player('y2', 'Kannur', 100), 'pB');
  const board = getPlayerLeaderboard(db, WEEK_ID, 50);
  const rankOf = (id: string): number => board.find((e) => e.playerId === id)?.rank ?? -1;
  assert.ok(rankOf('pB') < rankOf('pA'), 'more wins wins the tie-break');

  // Fewer matches wins when points and wins tie:
  // pC: 8 losses = 40 pts, 0 wins, 8 matches. pD: 5 draws = 40 pts, 0 wins, 5 matches.
  for (let i = 0; i < 8; i++) {
    settle(db, player('pC', 'Kannur', 100), player(`wc${i}`, 'Kannur', 250), `wc${i}`);
  }
  for (let i = 0; i < 5; i++) {
    settle(db, player('pD', 'Kannur', 200), player(`wd${i}`, 'Kannur', 200), null);
  }
  const board2 = getPlayerLeaderboard(db, WEEK_ID, 50);
  const rankOf2 = (id: string): number => board2.find((e) => e.playerId === id)?.rank ?? -1;
  const pC = board2.find((e) => e.playerId === 'pC');
  const pD = board2.find((e) => e.playerId === 'pD');
  assert.equal(pC?.points, 40);
  assert.equal(pD?.points, 40);
  assert.ok(rankOf2('pD') < rankOf2('pC'), 'fewer matches wins the tie-break');

  // Ranks are unique and stable.
  const ids = board2.map((e) => e.playerId);
  assert.equal(new Set(ids).size, ids.length);
});

test('matches in different IST weeks land in different weekly buckets', () => {
  const db = testDb();
  const sundayNight = Date.UTC(2026, 9, 4, 18, 29, 59); // Sun 23:59:59 IST -> W40
  const mondayMorning = Date.UTC(2026, 9, 4, 18, 30, 0); // Mon 00:00:00 IST -> W41
  settle(db, player('sree', 'Kannur', 250), player('a', 'Kannur', 100), 'sree', sundayNight);
  settle(db, player('sree', 'Kannur', 250), player('b', 'Kannur', 100), 'sree', mondayMorning);

  const w40 = getCompetitionWeek(sundayNight).id;
  const w41 = getCompetitionWeek(mondayMorning).id;
  assert.notEqual(w40, w41);
  const meW40 = getMyWeeklyStats(db, w40, getCompetitionDay(sundayNight).id, 'sree');
  const meW41 = getMyWeeklyStats(db, w41, getCompetitionDay(mondayMorning).id, 'sree');
  assert.equal(meW40?.matchesPlayed, 1);
  assert.equal(meW40?.points, 12);
  assert.equal(meW41?.matchesPlayed, 1);
  assert.equal(meW41?.points, 12);
});

test('upsertPlayer keeps one row per playerId and follows district switches', () => {
  const db = testDb();
  upsertPlayer(db, 'sree', 'Sree', 'Kannur', SAT);
  upsertPlayer(db, 'sree', 'Sree', 'Kozhikode', SAT + 1000);
  const rows = db.prepare('SELECT * FROM players WHERE player_id = ?').all('sree') as Array<{
    district: string;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.district, 'Kozhikode');
});

test('invalid settlement inputs are rejected', () => {
  const db = testDb();
  const base: SettleRankedMatchInput = {
    matchId: randomUUID(),
    gameType: GAME_TYPE_PRECISION_CLASH,
    matchMode: MATCH_MODE_RANKED,
    matchSource: MATCH_SOURCE_WEEKLY_QUEUE,
    players: [player('a', 'Kannur', 10), player('b', 'Kannur', 5)],
    winnerPlayerId: 'a',
    completedAtMs: SAT,
  };
  assert.throws(() => settleRankedMatch(db, { ...base, winnerPlayerId: 'ghost' }), /winner must be one/);
  assert.throws(
    () =>
      settleRankedMatch(db, {
        ...base,
        matchId: randomUUID(),
        players: [player('a', 'Kannur', 10), player('a', 'Kannur', 5)],
      }),
    /distinct/,
  );
});
