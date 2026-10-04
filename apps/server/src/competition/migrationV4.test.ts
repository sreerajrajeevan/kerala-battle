/**
 * Migration test: a Task 9 (v3) database upgrades to v4 without losing data.
 * Applies migrations 1-3 manually, seeds representative rows, then runs the
 * real migration pipeline and verifies old data is intact and new tables
 * exist.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.js';
import { runMigrations, inTransaction } from './db.js';

function applyUpTo(db: DatabaseSync, maxVersion: number): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (migration.version > maxVersion) continue;
    inTransaction(db, () => {
      for (const statement of migration.statements) db.exec(statement);
      record.run(migration.version, Date.now());
    });
  }
}

test('v3 database upgrades to v4 with data intact', () => {
  const db = new DatabaseSync(':memory:');
  applyUpTo(db, 3);

  // Representative Task 5-9 data.
  db.prepare(
    `INSERT INTO players (player_id, display_name, district, created_at, updated_at)
     VALUES ('p1', 'Sree', 'Kannur', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO matches (match_id, game_type, player_a_id, player_b_id,
      player_a_score, player_b_score, player_a_district, player_b_district,
      player_a_personal_points, player_b_personal_points,
      player_a_district_contribution, player_b_district_contribution,
      winner_player_id, completed_at, competition_week_id, match_mode, match_source)
     VALUES ('m1', 'crown-rush', 'p1', 'p2', 7, 3, 'Kannur', 'Kozhikode',
       12, 5, 12, 5, 'p1', 2, '2026-W40', 'ranked', 'weekly-queue')`,
  ).run();
  db.prepare(
    `INSERT INTO competition_weeks (competition_week_id, featured_game_type, starts_at, ends_at, created_at)
     VALUES ('2026-W40', 'crown-rush', '2026-09-28', '2026-10-04', 3)`,
  ).run();

  // Now run the real pipeline: only v4 should apply.
  runMigrations(db);
  const versions = (
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
      version: number;
    }>
  ).map((row) => row.version);
  assert.deepEqual(versions, [1, 2, 3, 4]);

  // Old data untouched.
  const player = db.prepare('SELECT display_name FROM players WHERE player_id = ?').get('p1') as {
    display_name: string;
  };
  assert.equal(player.display_name, 'Sree');
  const match = db.prepare('SELECT game_type FROM matches WHERE match_id = ?').get('m1') as {
    game_type: string;
  };
  assert.equal(match.game_type, 'crown-rush');
  const week = db
    .prepare('SELECT featured_game_type FROM competition_weeks WHERE competition_week_id = ?')
    .get('2026-W40') as { featured_game_type: string };
  assert.equal(week.featured_game_type, 'crown-rush');

  // New tables exist and accept writes.
  for (const table of ['users', 'sessions', 'player_blocks', 'player_reports']) {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name: string } | undefined;
    assert.ok(row, `table ${table} exists`);
  }
  db.prepare(
    `INSERT INTO users (id, google_subject, display_name, player_id, status, created_at, updated_at)
     VALUES ('u1', 'sub-1', 'Sree', 'p1', 'active', 4, 4)`,
  ).run();
  const user = db.prepare('SELECT player_id FROM users WHERE id = ?').get('u1') as {
    player_id: string;
  };
  assert.equal(user.player_id, 'p1');
});

test('fresh database gets all migrations including v4', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const versions = (
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
      version: number;
    }>
  ).map((row) => row.version);
  assert.deepEqual(versions, [1, 2, 3, 4]);
});
