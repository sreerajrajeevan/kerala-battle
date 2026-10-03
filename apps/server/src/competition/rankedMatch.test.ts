/**
 * Unit tests for central ranked-settlement validation.
 * Covers: valid ranked queue matches pass; casual mode, wrong source,
 * featured-game mismatch, same-district pairing, unknown week, and missing
 * week snapshots are all refused.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  GAME_TYPE_CROWN_RUSH,
  GAME_TYPE_PRECISION_CLASH,
  MATCH_MODE_CASUAL,
  MATCH_MODE_RANKED,
  MATCH_SOURCE_DIRECT_CHALLENGE,
  MATCH_SOURCE_WEEKLY_QUEUE,
  type KeralaDistrict,
  type MatchMode,
  type MatchSource,
} from '@kerala-battle/shared';
import { runMigrations } from './db.js';
import { getOrCreateWeekConfig } from './featuredGame.js';
import { validateRankedMatch, type RankedMatchSnapshot } from './rankedMatch.js';

function testDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return db;
}

/** Week 2026-W40 with its default featured game (crown-rush). */
function weekDb(): DatabaseSync {
  const db = testDb();
  getOrCreateWeekConfig(db, Date.UTC(2026, 9, 3, 12, 0, 0));
  return db;
}

function snapshot(overrides: Partial<RankedMatchSnapshot> = {}): RankedMatchSnapshot {
  return {
    matchId: 'match-1',
    gameType: GAME_TYPE_CROWN_RUSH,
    matchMode: MATCH_MODE_RANKED,
    matchSource: MATCH_SOURCE_WEEKLY_QUEUE,
    competitionWeekId: '2026-W40',
    districts: ['Kannur', 'Kozhikode'] as [KeralaDistrict, KeralaDistrict],
    ...overrides,
  };
}

test('valid ranked queue match passes validation', () => {
  const db = weekDb();
  assert.deepEqual(validateRankedMatch(db, snapshot()), { ok: true });
});

test('casual mode is refused', () => {
  const db = weekDb();
  const result = validateRankedMatch(
    db,
    snapshot({ matchMode: MATCH_MODE_CASUAL as MatchMode }),
  );
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /not ranked/);
});

test('direct-challenge source is refused', () => {
  const db = weekDb();
  const result = validateRankedMatch(
    db,
    snapshot({ matchSource: MATCH_SOURCE_DIRECT_CHALLENGE as MatchSource }),
  );
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /weekly queue/);
});

test('game that was not featured that week is refused', () => {
  const db = weekDb();
  const result = validateRankedMatch(db, snapshot({ gameType: GAME_TYPE_PRECISION_CLASH }));
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /featured crown-rush/);
});

test('same-district pairing is refused', () => {
  const db = weekDb();
  const result = validateRankedMatch(
    db,
    snapshot({ districts: ['Kannur', 'Kannur'] as [KeralaDistrict, KeralaDistrict] }),
  );
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /same-district/);
});

test('unknown week is refused', () => {
  const db = weekDb();
  const result = validateRankedMatch(db, snapshot({ competitionWeekId: '2026-W99' }));
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /unknown week/);
});

test('missing week snapshot is refused', () => {
  const db = weekDb();
  const result = validateRankedMatch(db, snapshot({ competitionWeekId: undefined }));
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /no competition week/);
});
