/**
 * Unit tests for persistent blocking.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../competition/db.js';
import {
  blockPlayer,
  getBlockedIds,
  getBlockList,
  isBlocked,
  isBlockedEitherWay,
  unblockPlayer,
} from './blocks.js';

const NOW = 1_750_000_000_000;

function testDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO players (player_id, display_name, district, created_at, updated_at)
     VALUES ('sree', 'Sree', 'Kannur', ?, ?), ('rahul', 'Rahul', 'Kannur', ?, ?)`,
  ).run(NOW, NOW, NOW, NOW);
  return db;
}

test('block persists and is directional', () => {
  const db = testDb();
  const result = blockPlayer(db, 'sree', 'rahul', NOW);
  assert.equal(result.ok, true);
  assert.equal(isBlocked(db, 'sree', 'rahul'), true);
  // Directional: Rahul did not block Sree.
  assert.equal(isBlocked(db, 'rahul', 'sree'), false);
  // ...but either-way checks see it.
  assert.equal(isBlockedEitherWay(db, 'sree', 'rahul'), true);
  assert.equal(isBlockedEitherWay(db, 'rahul', 'sree'), true);
  assert.equal(isBlockedEitherWay(db, 'sree', 'nobody'), false);
});

test('self-block is rejected', () => {
  const db = testDb();
  const result = blockPlayer(db, 'sree', 'sree', NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'self-block');
});

test('duplicate block is rejected, not duplicated', () => {
  const db = testDb();
  assert.equal(blockPlayer(db, 'sree', 'rahul', NOW).ok, true);
  const again = blockPlayer(db, 'sree', 'rahul', NOW + 1);
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.reason, 'already-blocked');
  const rows = db.prepare('SELECT COUNT(*) AS n FROM player_blocks').get() as { n: number };
  assert.equal(rows.n, 1);
});

test('unblock removes the row', () => {
  const db = testDb();
  blockPlayer(db, 'sree', 'rahul', NOW);
  assert.equal(unblockPlayer(db, 'sree', 'rahul'), true);
  assert.equal(isBlocked(db, 'sree', 'rahul'), false);
  assert.equal(isBlockedEitherWay(db, 'sree', 'rahul'), false);
  assert.equal(unblockPlayer(db, 'sree', 'rahul'), false);
});

test('block list carries display names for the Safety panel', () => {
  const db = testDb();
  blockPlayer(db, 'sree', 'rahul', NOW);
  assert.deepEqual(getBlockedIds(db, 'sree'), ['rahul']);
  assert.deepEqual(getBlockedIds(db, 'rahul'), []);
  const list = getBlockList(db, 'sree');
  assert.equal(list.length, 1);
  assert.equal(list[0].playerId, 'rahul');
  assert.equal(list[0].displayName, 'Rahul');
});
