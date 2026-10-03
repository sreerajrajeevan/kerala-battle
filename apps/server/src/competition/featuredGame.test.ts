/**
 * Unit tests for the weekly featured-game configuration.
 * Covers: deterministic default rotation, persistence across restarts,
 * frozen history, dev override validation, and week-boundary settlement.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  GAME_TYPE_CROWN_RUSH,
  GAME_TYPE_PRECISION_CLASH,
  MATCH_MODE_RANKED,
  MATCH_SOURCE_WEEKLY_QUEUE,
  type GameType,
  type KeralaDistrict,
} from '@kerala-battle/shared';
import { runMigrations } from './db.js';
import {
  defaultFeaturedGameForWeek,
  getOrCreateWeekConfig,
  getWeekConfig,
  setFeaturedGameForWeek,
} from './featuredGame.js';
import { settleRankedMatch, type RankedPlayerInput } from './store.js';
import { getCompetitionWeek } from './week.js';

function testDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return db;
}

test('default rotation alternates crown-rush / precision-clash', () => {
  // Matches the spec example: W40 -> Crown Rush, W41 -> Precision Clash.
  assert.equal(defaultFeaturedGameForWeek('2026-W40'), GAME_TYPE_CROWN_RUSH);
  assert.equal(defaultFeaturedGameForWeek('2026-W41'), GAME_TYPE_PRECISION_CLASH);
  assert.equal(defaultFeaturedGameForWeek('2026-W42'), GAME_TYPE_CROWN_RUSH);
  assert.equal(defaultFeaturedGameForWeek('2027-W01'), GAME_TYPE_PRECISION_CLASH);
});

test('default rotation falls back for malformed week ids', () => {
  assert.equal(defaultFeaturedGameForWeek('nope'), GAME_TYPE_CROWN_RUSH);
  assert.equal(defaultFeaturedGameForWeek('2026-W99'), GAME_TYPE_CROWN_RUSH);
  assert.equal(defaultFeaturedGameForWeek(''), GAME_TYPE_CROWN_RUSH);
});

test('first encounter creates the week row with the rotation game', () => {
  const db = testDb();
  // 2026-10-03 12:00 UTC == 17:30 IST Saturday -> 2026-W40.
  const config = getOrCreateWeekConfig(db, Date.UTC(2026, 9, 3, 12, 0, 0));
  assert.equal(config.competitionWeekId, '2026-W40');
  assert.equal(config.featuredGameType, GAME_TYPE_CROWN_RUSH);
  assert.equal(config.startsAt, '2026-09-28T00:00:00.000+05:30');
  assert.equal(config.endsAt, '2026-10-04T23:59:59.999+05:30');
});

test('featured game is stable once the row exists', () => {
  const db = testDb();
  const first = getOrCreateWeekConfig(db, Date.UTC(2026, 9, 3, 12, 0, 0));
  const second = getOrCreateWeekConfig(db, Date.UTC(2026, 9, 4, 12, 0, 0));
  assert.equal(second.featuredGameType, first.featuredGameType);
  assert.equal(getWeekConfig(db, '2026-W40')?.featuredGameType, GAME_TYPE_CROWN_RUSH);
});

test('featured game survives a server restart (same database file)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-featured-'));
  const path = join(dir, 'test.db');
  const open = (): DatabaseSync => {
    const db = new DatabaseSync(path);
    runMigrations(db);
    return db;
  };
  const first = open();
  const created = getOrCreateWeekConfig(first, Date.UTC(2026, 9, 3, 12, 0, 0));
  assert.equal(created.featuredGameType, GAME_TYPE_CROWN_RUSH);
  first.close();

  const second = open();
  const reread = getOrCreateWeekConfig(second, Date.UTC(2026, 9, 3, 12, 0, 0));
  assert.equal(reread.featuredGameType, GAME_TYPE_CROWN_RUSH);
  second.close();
});

test('dev override changes the week game and rejects bad games', () => {
  const db = testDb();
  const nowMs = Date.UTC(2026, 9, 3, 12, 0, 0);
  const updated = setFeaturedGameForWeek(db, '2026-W40', GAME_TYPE_PRECISION_CLASH, nowMs);
  assert.equal(updated.featuredGameType, GAME_TYPE_PRECISION_CLASH);
  // Still stable afterwards: later encounters keep the override.
  assert.equal(getOrCreateWeekConfig(db, nowMs).featuredGameType, GAME_TYPE_PRECISION_CLASH);
  assert.throws(
    () => setFeaturedGameForWeek(db, '2026-W40', 'chess' as unknown as GameType, nowMs),
    /unsupported featured game/,
  );
});

function player(playerId: string, district: KeralaDistrict, score: number): RankedPlayerInput {
  return { playerId, displayName: `Name-${playerId}`, district, score };
}

test('settlement attributed to the week the match started in (boundary)', () => {
  const db = testDb();
  // Match starts Sunday 2026-10-04 23:59:55 IST (week 2026-W40) and finishes
  // Monday 2026-10-05 00:00:20 IST (week 2026-W41). The authoritative week
  // snapshot is W40, so the result must land in W40.
  const startedAtMs = Date.UTC(2026, 9, 4, 18, 29, 55); // 23:59:55 IST Sunday
  const finishedAtMs = Date.UTC(2026, 9, 4, 18, 30, 20); // 00:00:20 IST Monday
  assert.equal(getCompetitionWeek(startedAtMs).id, '2026-W40');
  assert.equal(getCompetitionWeek(finishedAtMs).id, '2026-W41');

  const outcome = settleRankedMatch(db, {
    matchId: randomUUID(),
    gameType: GAME_TYPE_CROWN_RUSH,
    matchMode: MATCH_MODE_RANKED,
    matchSource: MATCH_SOURCE_WEEKLY_QUEUE,
    players: [player('sree', 'Kannur', 7), player('rahul', 'Kozhikode', 4)],
    winnerPlayerId: 'sree',
    completedAtMs: finishedAtMs,
    competitionWeekId: '2026-W40',
  });
  assert.equal(outcome.weekId, '2026-W40');
  const row = db
    .prepare('SELECT competition_week_id, match_mode, match_source FROM matches')
    .get() as { competition_week_id: string; match_mode: string; match_source: string };
  assert.equal(row.competition_week_id, '2026-W40');
  assert.equal(row.match_mode, 'ranked');
  assert.equal(row.match_source, 'weekly-queue');
});

test('settlement without an explicit week uses the completion week', () => {
  const db = testDb();
  const finishedAtMs = Date.UTC(2026, 9, 5, 12, 0, 0); // Monday -> 2026-W41
  const outcome = settleRankedMatch(db, {
    matchId: randomUUID(),
    gameType: GAME_TYPE_PRECISION_CLASH,
    matchMode: MATCH_MODE_RANKED,
    matchSource: MATCH_SOURCE_WEEKLY_QUEUE,
    players: [player('sree', 'Kannur', 200), player('rahul', 'Kozhikode', 100)],
    winnerPlayerId: 'sree',
    completedAtMs: finishedAtMs,
  });
  assert.equal(outcome.weekId, '2026-W41');
});
