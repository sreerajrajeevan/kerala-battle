#!/usr/bin/env node
/**
 * Task 11 load test: competition settlement throughput (in-process).
 *
 *   DB_PATH=/tmp/kb-settle-test.db node load-tests/settle-load.mjs --settlements 2000
 *
 * Runs N synthetic ranked settlements against a TEST database (never the
 * dev/prod DB) and measures settlements/sec plus leaderboard query time.
 * Uses the real settleRankedMatch + leaderboard code paths.
 */
import { argv } from 'node:process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const SETTLEMENTS = Number(arg('settlements', '2000'));

// Isolated temp DB unless the caller explicitly set DB_PATH.
if (!process.env.DB_PATH) {
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'kb-settle-')), 'test.db');
}

const { openDatabase } = await import('../src/competition/db.ts');
const { settleRankedMatch, getPlayerLeaderboard, getDistrictLeaderboard } = await import(
  '../src/competition/store.ts'
);
const { getCompetitionWeek } = await import('../src/competition/week.ts');

const db = openDatabase(process.env.DB_PATH);
const week = getCompetitionWeek(Date.now());
const districts = ['Ernakulam', 'Kollam'];

const t0 = Date.now();
for (let i = 0; i < SETTLEMENTS; i++) {
  settleRankedMatch(db, {
    matchId: `load-match-${i}`,
    gameType: 'crown-rush',
    matchMode: 'ranked',
    matchSource: 'weekly-queue',
    players: [
      { playerId: `lp-a-${i}`, displayName: `LA${i}`, district: districts[i % 2], score: 7 },
      { playerId: `lp-b-${i}`, displayName: `LB${i}`, district: districts[(i + 1) % 2], score: 5 },
    ],
    winnerPlayerId: `lp-a-${i}`,
    completedAtMs: Date.now(),
    competitionWeekId: week.id,
  });
}
const settleMs = Date.now() - t0;

const q0 = Date.now();
getPlayerLeaderboard(db, week.id, 50);
const playersQMs = Date.now() - q0;
const q1 = Date.now();
getDistrictLeaderboard(db, week.id);
const districtsQMs = Date.now() - q1;

// Settlement idempotency spot-check: re-settling must not double-count.
const before = getPlayerLeaderboard(db, week.id, 10000).find((p) => p.playerId === 'lp-a-0');
settleRankedMatch(db, {
  matchId: 'load-match-0',
  gameType: 'crown-rush',
  matchMode: 'ranked',
  matchSource: 'weekly-queue',
  players: [
    { playerId: 'lp-a-0', displayName: 'LA0', district: districts[0], score: 7 },
    { playerId: 'lp-b-0', displayName: 'LB0', district: districts[1], score: 5 },
  ],
  winnerPlayerId: 'lp-a-0',
  completedAtMs: Date.now(),
  competitionWeekId: week.id,
});
const after = getPlayerLeaderboard(db, week.id, 10000).find((p) => p.playerId === 'lp-a-0');

db.close();

console.log(
  JSON.stringify(
    {
      event: 'load.settle_result',
      settlements: SETTLEMENTS,
      settlementsPerSec: Math.round((SETTLEMENTS / (settleMs / 1000)) * 10) / 10,
      settleTotalMs: settleMs,
      playersLeaderboardMs: playersQMs,
      districtsLeaderboardMs: districtsQMs,
      idempotent: before?.points === after?.points,
    },
    null,
    2,
  ),
);
