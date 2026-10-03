/**
 * Tests for weekly finalization (Task 9): crowning Weekly Master + District
 * Champion, immutable history snapshots, idempotency, tie-breaks, empty
 * weeks, recovery, and week-boundary settlement.
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
  KERALA_DISTRICTS,
  MATCH_MODE_RANKED,
  MATCH_SOURCE_WEEKLY_QUEUE,
  type KeralaDistrict,
} from '@kerala-battle/shared';
import { runMigrations } from './db.js';
import { getCompetitionWeek, getCompetitionWeekById } from './week.js';
import { setFeaturedGameForWeek } from './featuredGame.js';
import { settleRankedMatch, upsertPlayer, getPlayerLeaderboard, compareDistrictStandings } from './store.js';
import type { RankedPlayerInput } from './store.js';
import {
  FINALIZATION_GRACE_MS,
  ensurePastWeeksFinalized,
  finalizeCompetitionWeek,
  getHistoryDetail,
  getHistorySummaries,
  getPreviousChampion,
  isWeekFinalized,
} from './finalize.js';

function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'kb-finalize-'));
  const db = new DatabaseSync(join(dir, 'test.db'));
  runMigrations(db);
  return db;
}

function player(playerId: string, district: KeralaDistrict, score: number, displayName?: string): RankedPlayerInput {
  return { playerId, displayName: displayName ?? `Name-${playerId}`, district, score };
}

/** Settle one ranked match into an explicit week (bypasses wall-clock). */
function settle(
  db: DatabaseSync,
  weekId: string,
  a: RankedPlayerInput,
  b: RankedPlayerInput,
  winnerPlayerId: string | null,
  completedAtMs: number,
): void {
  settleRankedMatch(db, {
    matchId: randomUUID(),
    gameType: GAME_TYPE_CROWN_RUSH,
    matchMode: MATCH_MODE_RANKED,
    matchSource: MATCH_SOURCE_WEEKLY_QUEUE,
    players: [a, b],
    winnerPlayerId,
    completedAtMs,
    competitionWeekId: weekId,
  });
}

/** A timestamp safely after a week's end + grace period. */
function afterWeek(weekId: string): number {
  return Date.parse(getCompetitionWeekById(weekId).endsAt) + FINALIZATION_GRACE_MS + 60_000;
}

const WEEK = '2020-W01';
const WEEK_ENDS = Date.parse(getCompetitionWeekById(WEEK).endsAt);

function count(db: DatabaseSync, table: string, weekId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE competition_week_id = ?`)
    .get(weekId) as { n: number | bigint };
  return Number(row.n);
}

// ---------------------------------------------------------------------------
// Week-id helper
// ---------------------------------------------------------------------------

test('getCompetitionWeekById round-trips with getCompetitionWeek', () => {
  for (const ts of [
    Date.parse('2026-10-04T12:00:00+05:30'), // Sunday
    Date.parse('2026-10-05T00:00:01+05:30'), // Monday boundary
    Date.parse('2020-01-01T00:00:00+05:30'), // week 1 edge
    Date.parse('2026-12-31T23:59:59+05:30'), // year edge
  ]) {
    const fromTs = getCompetitionWeek(ts);
    assert.deepEqual(getCompetitionWeekById(fromTs.id), fromTs);
  }
});

test('getCompetitionWeekById rejects malformed ids', () => {
  assert.throws(() => getCompetitionWeekById('bogus'), /malformed/);
  assert.throws(() => getCompetitionWeekById('2020-W0'), /malformed/);
  assert.throws(() => getCompetitionWeekById('2021-W53'), /out of range/); // 2021 has 52 weeks
});

// ---------------------------------------------------------------------------
// Normal finalization
// ---------------------------------------------------------------------------

test('normal week finalization crowns Weekly Master and District Champion', () => {
  const db = freshDb();
  // Sree: 2 wins = 24 pts; Rahul: 1 win = 12 pts.
  settle(db, WEEK, player('sree', 'Kannur', 100), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 10_000);
  settle(db, WEEK, player('sree', 'Kannur', 100), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 20_000);

  const outcome = finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) });
  assert.equal(outcome.status, 'finalized');
  assert.equal(outcome.champions?.weeklyMaster?.playerId, 'sree');
  assert.equal(outcome.champions?.weeklyMaster?.displayName, 'Name-sree');
  assert.equal(outcome.champions?.weeklyMaster?.district, 'Kannur');
  assert.equal(outcome.champions?.weeklyMaster?.points, 24);
  assert.equal(outcome.champions?.districtChampion?.district, 'Kannur');
  assert.ok(isWeekFinalized(db, WEEK));

  // Snapshots: 2 players, all 14 districts.
  assert.equal(count(db, 'competition_week_player_results', WEEK), 2);
  assert.equal(count(db, 'competition_week_district_results', WEEK), 14);
  assert.equal(count(db, 'competition_week_results', WEEK), 1);

  const detail = getHistoryDetail(db, WEEK);
  assert.ok(detail);
  assert.equal(detail?.players[0]?.playerId, 'sree');
  assert.equal(detail?.players[0]?.rank, 1);
  assert.equal(detail?.districts[0]?.district, 'Kannur');
  assert.equal(detail?.districts[0]?.rank, 1);
  assert.equal(detail?.districts.length, 14);
  db.close();
});

test('finalization is idempotent: no duplicate rows on repeat runs', () => {
  const db = freshDb();
  settle(db, WEEK, player('sree', 'Kannur', 100), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 10_000);

  const first = finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) });
  assert.equal(first.status, 'finalized');
  const second = finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) + 5_000 });
  assert.equal(second.status, 'already-finalized');
  const third = finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) + 10_000 });
  assert.equal(third.status, 'already-finalized');

  assert.equal(count(db, 'competition_week_results', WEEK), 1);
  assert.equal(count(db, 'competition_week_player_results', WEEK), 2);
  assert.equal(count(db, 'competition_week_district_results', WEEK), 14);
  db.close();
});

test('finalizing a week that has not ended is refused', () => {
  const db = freshDb();
  const currentWeek = getCompetitionWeek(Date.now()).id;
  const outcome = finalizeCompetitionWeek(db, currentWeek, { nowMs: Date.now() });
  assert.equal(outcome.status, 'week-not-ended');
  assert.ok(!isWeekFinalized(db, currentWeek));
  db.close();
});

test('malformed week id throws instead of finalizing garbage', () => {
  const db = freshDb();
  assert.throws(() => finalizeCompetitionWeek(db, 'not-a-week', { nowMs: Date.now() + 1e12 }));
  db.close();
});

// ---------------------------------------------------------------------------
// Tie-breaks
// ---------------------------------------------------------------------------

test('player tie-break: equal points -> more wins wins', () => {
  const db = freshDb();
  // draws: 3 x 8 = 24 pts, 0 wins. wins: 2 x 12 = 24 pts, 2 wins.
  for (let i = 0; i < 3; i++) {
    settle(db, WEEK, player('draws', 'Kannur', 50), player('opp', 'Kozhikode', 50), null, WEEK_ENDS - i * 1000);
  }
  for (let i = 0; i < 2; i++) {
    settle(db, WEEK, player('wins', 'Kannur', 100), player('opp2', 'Kozhikode', 10), 'wins', WEEK_ENDS - 50_000 - i * 1000);
  }
  const outcome = finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) });
  assert.equal(outcome.champions?.weeklyMaster?.playerId, 'wins');
  db.close();
});

test('player tie-break: equal points+wins -> fewer matches wins, then playerId', () => {
  const db = freshDb();
  // few: 5 draws = 40 pts, 0 wins, 5 matches. many: 8 losses = 40 pts, 0 wins, 8 matches.
  for (let i = 0; i < 5; i++) {
    settle(db, WEEK, player('few', 'Kannur', 50), player('x', 'Kozhikode', 50), null, WEEK_ENDS - i * 1000);
  }
  for (let i = 0; i < 8; i++) {
    settle(db, WEEK, player('many', 'Kannur', 10), player('y', 'Kozhikode', 100), 'y', WEEK_ENDS - 60_000 - i * 1000);
  }
  // identical records -> playerId ascending.
  settle(db, WEEK, player('aaa', 'Kannur', 50), player('b1', 'Kozhikode', 50), null, WEEK_ENDS - 70_000);
  settle(db, WEEK, player('zzz', 'Kannur', 50), player('b2', 'Kozhikode', 50), null, WEEK_ENDS - 71_000);

  const detail = getHistoryDetail(db, finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) }).weekId);
  const order = detail?.players.map((p) => p.playerId) ?? [];
  assert.ok(order.indexOf('few') < order.indexOf('many'), `fewer matches first: ${order}`);
  assert.ok(order.indexOf('aaa') < order.indexOf('zzz'), `playerId ascending: ${order}`);
  db.close();
});

test('district tie-break is central and deterministic', () => {
  const base = { points: 100, wins: 3, activePlayers: 10, pointsPerActivePlayer: 10 };
  const byPoints = compareDistrictStandings(
    { ...base, district: 'Kannur' },
    { ...base, district: 'Kozhikode', points: 99 },
  );
  assert.ok(byPoints < 0, 'more points first');
  const byWins = compareDistrictStandings(
    { ...base, district: 'Kannur' },
    { ...base, district: 'Kozhikode', wins: 2 },
  );
  assert.ok(byWins < 0, 'more wins first');
  const byActive = compareDistrictStandings(
    { ...base, district: 'Kannur' },
    { ...base, district: 'Kozhikode', activePlayers: 9 },
  );
  assert.ok(byActive < 0, 'more active players first');
  const byName = compareDistrictStandings(
    { ...base, district: 'Kannur' },
    { ...base, district: 'Kozhikode' },
  );
  assert.ok(byName < 0, 'name ascending as final tie-break');
  assert.equal(
    compareDistrictStandings({ ...base, district: 'Kannur' }, { ...base, district: 'Kannur' }),
    0,
  );
});

test('district champion selection end-to-end', () => {
  const db = freshDb();
  settle(db, WEEK, player('sree', 'Kannur', 100), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 10_000);
  settle(db, WEEK, player('sree', 'Kannur', 100), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 20_000);
  const outcome = finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) });
  // Kannur: 24 district pts; Kozhikode: 10 (two losses x 5).
  assert.equal(outcome.champions?.districtChampion?.district, 'Kannur');
  assert.equal(outcome.champions?.districtChampion?.points, 24);
  db.close();
});

// ---------------------------------------------------------------------------
// Empty week + full district snapshots
// ---------------------------------------------------------------------------

test('empty week finalizes gracefully with null champions', () => {
  const db = freshDb();
  const outcome = finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) });
  assert.equal(outcome.status, 'finalized');
  assert.equal(outcome.champions?.weeklyMaster, null);
  assert.equal(outcome.champions?.districtChampion, null);

  const detail = getHistoryDetail(db, WEEK);
  assert.ok(detail);
  assert.equal(detail?.players.length, 0);
  assert.equal(detail?.districts.length, 14);
  assert.ok(detail?.districts.every((d) => d.points === 0 && d.activePlayers === 0));
  // Ranks still assigned 1..14 deterministically (name order on all-zero).
  assert.deepEqual(
    detail?.districts.map((d) => d.rank),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  );
  db.close();
});

test('all 14 districts appear in the snapshot, even with zero points', () => {
  const db = freshDb();
  settle(db, WEEK, player('sree', 'Kannur', 100), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 10_000);
  finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) });
  const detail = getHistoryDetail(db, WEEK);
  const names = (detail?.districts ?? []).map((d) => d.district).sort();
  assert.deepEqual(names, [...KERALA_DISTRICTS].sort());
  db.close();
});

// ---------------------------------------------------------------------------
// History immutability
// ---------------------------------------------------------------------------

test('history survives player district changes', () => {
  const db = freshDb();
  settle(db, WEEK, player('sree', 'Kannur', 100), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 10_000);
  finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) });

  upsertPlayer(db, 'sree', 'Name-sree', 'Kozhikode', afterWeek(WEEK));
  const detail = getHistoryDetail(db, WEEK);
  assert.equal(detail?.weeklyMaster?.district, 'Kannur');
  assert.equal(detail?.players[0]?.district, 'Kannur');
  db.close();
});

test('history survives display-name changes', () => {
  const db = freshDb();
  settle(db, WEEK, player('sree', 'Kannur', 100, 'OldName'), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 10_000);
  finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) });

  upsertPlayer(db, 'sree', 'BrandNewName', 'Kannur', afterWeek(WEEK));
  const detail = getHistoryDetail(db, WEEK);
  assert.equal(detail?.weeklyMaster?.displayName, 'OldName');
  assert.equal(detail?.players[0]?.displayName, 'OldName');
  db.close();
});

test('featured-game history is immutable', () => {
  const db = freshDb();
  settle(db, WEEK, player('sree', 'Kannur', 100), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 10_000);
  const outcome = finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) });
  const frozen = outcome.champions?.featuredGameType;
  assert.ok(frozen);

  // A later override (dev tool or rotation change) must not rewrite history.
  const other = frozen === GAME_TYPE_CROWN_RUSH ? GAME_TYPE_PRECISION_CLASH : GAME_TYPE_CROWN_RUSH;
  setFeaturedGameForWeek(db, WEEK, other, afterWeek(WEEK));
  const detail = getHistoryDetail(db, WEEK);
  assert.equal(detail?.featuredGameType, frozen);
  db.close();
});

// ---------------------------------------------------------------------------
// Previous champion + history reads
// ---------------------------------------------------------------------------

test('previous champion retrieval skips the current week', () => {
  const db = freshDb();
  settle(db, WEEK, player('sree', 'Kannur', 100), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 10_000);
  finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) });

  // "Now" is long after: the finalized week is the previous champion.
  const prev = getPreviousChampion(db, afterWeek(WEEK) + 7 * 24 * 3600_000);
  assert.ok(prev);
  assert.equal(prev?.weekId, WEEK);
  assert.equal(prev?.weeklyMaster?.playerId, 'sree');
  assert.equal(prev?.districtChampion?.district, 'Kannur');
  db.close();
});

test('previous champion is null when nothing is finalized', () => {
  const db = freshDb();
  assert.equal(getPreviousChampion(db, Date.now()), null);
  db.close();
});

test('history summaries are newest-first and limited', () => {
  const db = freshDb();
  for (const weekId of ['2020-W01', '2020-W02', '2020-W03']) {
    finalizeCompetitionWeek(db, weekId, { nowMs: afterWeek(weekId) });
  }
  const summaries = getHistorySummaries(db, 2);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0]?.competitionWeekId, '2020-W03');
  assert.equal(summaries[1]?.competitionWeekId, '2020-W02');
  assert.equal(getHistoryDetail(db, '2020-W09'), null);
  db.close();
});

// ---------------------------------------------------------------------------
// Recovery, rollover, active matches, late settlement
// ---------------------------------------------------------------------------

test('startup recovery finalizes ended unfinalized weeks', () => {
  const db = freshDb();
  settle(db, WEEK, player('sree', 'Kannur', 100), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 10_000);
  // No explicit finalize: simulate a server that was offline at week end.
  const result = ensurePastWeeksFinalized(db, { nowMs: afterWeek(WEEK) });
  assert.deepEqual(result.finalized, [WEEK]);
  assert.equal(getHistoryDetail(db, WEEK)?.weeklyMaster?.playerId, 'sree');
  // Second sweep is a no-op.
  const again = ensurePastWeeksFinalized(db, { nowMs: afterWeek(WEEK) });
  assert.deepEqual(again.finalized, []);
  db.close();
});

test('new week starts cleanly at zero; matches table is never wiped', () => {
  const db = freshDb();
  settle(db, WEEK, player('sree', 'Kannur', 100), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 10_000);
  finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) });

  const newWeek = getCompetitionWeek(afterWeek(WEEK)).id;
  assert.notEqual(newWeek, WEEK);
  assert.deepEqual(getPlayerLeaderboard(db, newWeek, 10), []);
  const matchCount = (
    db.prepare('SELECT COUNT(*) AS n FROM matches').get() as { n: number | bigint }
  ).n;
  assert.equal(Number(matchCount), 1);
  db.close();
});

test('active old-week ranked matches delay finalization', () => {
  const db = freshDb();
  settle(db, WEEK, player('sree', 'Kannur', 100), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 10_000);

  // Within the grace period: a live old-week match delays the snapshot.
  const delayed = finalizeCompetitionWeek(db, WEEK, {
    nowMs: WEEK_ENDS + 60_000,
    activeRankedMatchCount: 1,
  });
  assert.equal(delayed.status, 'active-matches');
  assert.equal(delayed.activeRankedMatches, 1);
  assert.ok(!isWeekFinalized(db, WEEK));

  // Match finished: finalization proceeds.
  const done = finalizeCompetitionWeek(db, WEEK, {
    nowMs: WEEK_ENDS + 60_000,
    activeRankedMatchCount: 0,
  });
  assert.equal(done.status, 'finalized');
  db.close();
});

test('bounded recovery: stuck matches cannot block a week forever', () => {
  const db = freshDb();
  settle(db, WEEK, player('sree', 'Kannur', 100), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 10_000);

  // Past the grace period with a supposedly-still-active match: finalize
  // anyway rather than blocking the week forever.
  const outcome = finalizeCompetitionWeek(db, WEEK, {
    nowMs: afterWeek(WEEK),
    activeRankedMatchCount: 1,
  });
  assert.equal(outcome.status, 'finalized');
  assert.equal(outcome.champions?.weeklyMaster?.playerId, 'sree');
  db.close();
});

test('no artificial grace wait when no matches are active', () => {
  const db = freshDb();
  settle(db, WEEK, player('sree', 'Kannur', 100), player('rahul', 'Kozhikode', 10), 'sree', WEEK_ENDS - 10_000);
  // One minute after week end, nothing still playing: finalize immediately.
  // (Matches starting after the boundary belong to the new week.)
  const outcome = finalizeCompetitionWeek(db, WEEK, { nowMs: WEEK_ENDS + 60_000 });
  assert.equal(outcome.status, 'finalized');
  db.close();
});

test('late old-week settlement is included before the snapshot', () => {
  const db = freshDb();
  // Match played Sunday night, settled Monday 00:00:20 IST into the old week.
  const mondayMorning = WEEK_ENDS + 21_000; // endsAt was Sunday 23:59:59.999
  settle(
    db,
    WEEK,
    player('sree', 'Kannur', 100),
    player('rahul', 'Kozhikode', 10),
    'sree',
    mondayMorning,
  );
  // Sanity: Monday morning is genuinely a different competition week.
  assert.notEqual(getCompetitionWeek(mondayMorning).id, WEEK);

  const outcome = finalizeCompetitionWeek(db, WEEK, { nowMs: afterWeek(WEEK) });
  assert.equal(outcome.status, 'finalized');
  assert.equal(outcome.champions?.weeklyMaster?.playerId, 'sree');
  assert.equal(outcome.champions?.weeklyMaster?.points, 12);
  db.close();
});

test('week-boundary: Sunday 23:59:55 start, Monday 00:00:20 finish belongs to Sunday week', () => {
  const db = freshDb();
  const sundayWeek = getCompetitionWeekById('2026-W40');
  const sundayStart = Date.parse('2026-10-04T23:59:55+05:30');
  const mondayFinish = Date.parse('2026-10-05T00:00:20+05:30');
  assert.equal(getCompetitionWeek(sundayStart).id, '2026-W40');
  assert.equal(getCompetitionWeek(mondayFinish).id, '2026-W41');

  // Explicit week snapshot from match start (Task 7 semantics).
  settle(
    db,
    '2026-W40',
    player('sree', 'Kannur', 100),
    player('rahul', 'Kozhikode', 10),
    'sree',
    mondayFinish,
  );
  const row = db
    .prepare('SELECT competition_week_id AS w FROM matches')
    .get() as { w: string };
  assert.equal(row.w, '2026-W40');

  const outcome = finalizeCompetitionWeek(db, '2026-W40', {
    nowMs: Date.parse(sundayWeek.endsAt) + FINALIZATION_GRACE_MS + 60_000,
  });
  assert.equal(outcome.champions?.weeklyMaster?.playerId, 'sree');
  db.close();
});
