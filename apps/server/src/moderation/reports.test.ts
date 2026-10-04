/**
 * Unit tests for player reporting: validation, dedup, context rules, and
 * operator status transitions.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../competition/db.js';
import {
  createReport,
  listReports,
  setReportStatus,
  MAX_REPORT_DESCRIPTION_LENGTH,
} from './reports.js';

const NOW = 1_750_000_000_000;

function testDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return db;
}

function seedRankedMatch(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO matches (match_id, game_type, player_a_id, player_b_id,
      player_a_score, player_b_score, player_a_district, player_b_district,
      player_a_personal_points, player_b_personal_points,
      player_a_district_contribution, player_b_district_contribution,
      winner_player_id, completed_at, competition_week_id, match_mode, match_source)
     VALUES ('match-1', 'precision-clash', 'sree', 'rahul', 100, 50,
       'Kannur', 'Kozhikode', 12, 5, 12, 5, 'sree', ?, '2026-W40', 'ranked', 'weekly-queue')`,
  ).run(NOW);
}

test('valid report is stored as open', () => {
  const db = testDb();
  const result = createReport(
    db,
    {
      reporterPlayerId: 'sree',
      reportedPlayerId: 'rahul',
      reason: 'harassment',
      description: 'Spamming voice',
      contextType: 'district-lobby',
    },
    NOW,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.report.status, 'open');
    assert.equal(result.report.reason, 'harassment');
    assert.equal(result.report.description, 'Spamming voice');
    assert.ok(result.report.id.length > 0);
  }
});

test('self-report is rejected', () => {
  const db = testDb();
  const result = createReport(
    db,
    { reporterPlayerId: 'sree', reportedPlayerId: 'sree', reason: 'spam' },
    NOW,
  );
  assert.deepEqual(result, { ok: false, reason: 'self-report' });
});

test('invalid reason is rejected', () => {
  const db = testDb();
  const result = createReport(
    db,
    { reporterPlayerId: 'sree', reportedPlayerId: 'rahul', reason: 'not-a-reason' },
    NOW,
  );
  assert.deepEqual(result, { ok: false, reason: 'invalid-reason' });
});

test('overlong description is rejected', () => {
  const db = testDb();
  const tooLong = createReport(
    db,
    {
      reporterPlayerId: 'sree',
      reportedPlayerId: 'rahul',
      reason: 'spam',
      description: 'x'.repeat(MAX_REPORT_DESCRIPTION_LENGTH + 1),
    },
    NOW,
  );
  assert.deepEqual(tooLong, { ok: false, reason: 'description-too-long' });
  const exact = createReport(
    db,
    {
      reporterPlayerId: 'sree',
      reportedPlayerId: 'rahul',
      reason: 'spam',
      description: 'x'.repeat(MAX_REPORT_DESCRIPTION_LENGTH),
    },
    NOW,
  );
  assert.equal(exact.ok, true);
});

test('duplicate identical report in the window is rejected', () => {
  const db = testDb();
  const input = {
    reporterPlayerId: 'sree',
    reportedPlayerId: 'rahul',
    reason: 'cheating' as const,
    contextType: 'voice' as const,
  };
  assert.equal(createReport(db, input, NOW).ok, true);
  const dup = createReport(db, input, NOW + 60_000);
  assert.deepEqual(dup, { ok: false, reason: 'duplicate' });
  // A different reason is not a duplicate.
  const other = createReport(db, { ...input, reason: 'spam' }, NOW + 60_000);
  assert.equal(other.ok, true);
});

test('ranked-match context must be a real match the reporter played', () => {
  const db = testDb();
  seedRankedMatch(db);
  const good = createReport(
    db,
    {
      reporterPlayerId: 'sree',
      reportedPlayerId: 'rahul',
      reason: 'cheating',
      contextType: 'ranked-match',
      contextId: 'match-1',
    },
    NOW,
  );
  assert.equal(good.ok, true);

  // Forged match id.
  const forged = createReport(
    db,
    {
      reporterPlayerId: 'sree',
      reportedPlayerId: 'rahul',
      reason: 'cheating',
      contextType: 'ranked-match',
      contextId: 'match-999',
    },
    NOW,
  );
  assert.deepEqual(forged, { ok: false, reason: 'invalid-context' });

  // Reporter was not a participant.
  const outsider = createReport(
    db,
    {
      reporterPlayerId: 'mallu',
      reportedPlayerId: 'rahul',
      reason: 'cheating',
      contextType: 'ranked-match',
      contextId: 'match-1',
    },
    NOW,
  );
  assert.deepEqual(outsider, { ok: false, reason: 'invalid-context' });
});

test('operator can list and transition report statuses', () => {
  const db = testDb();
  const created = createReport(
    db,
    { reporterPlayerId: 'sree', reportedPlayerId: 'rahul', reason: 'spam' },
    NOW,
  );
  assert.equal(created.ok, true);
  const id = created.ok ? created.report.id : '';
  assert.equal(listReports(db).length, 1);
  assert.equal(listReports(db, { status: 'open' }).length, 1);
  assert.equal(listReports(db, { status: 'reviewed' }).length, 0);
  const updated = setReportStatus(db, id, 'reviewed');
  assert.equal(updated?.status, 'reviewed');
  assert.equal(listReports(db, { status: 'reviewed' }).length, 1);
  assert.equal(setReportStatus(db, 'rep_missing', 'dismissed'), null);
});
