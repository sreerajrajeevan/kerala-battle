/**
 * SQLite database bootstrap.
 *
 * - Default file: <server>/data/kerala-battle.db (overridable via DB_PATH).
 * - Applies pending schema migrations on startup; never deletes data.
 * - WAL mode for safe concurrent reads while the server writes.
 *
 * The repository layer in store.ts owns all SQL; game logic never touches
 * the database directly, so SQLite can later be replaced without rewriting
 * settlement or leaderboard logic.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS } from './schema.js';

function defaultDatabasePath(): string {
  if (process.env.DB_PATH) return resolve(process.env.DB_PATH);
  // src/competition -> <server>/data ; dist/competition -> <server>/data
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'kerala-battle.db');
}

export function databasePath(): string {
  return process.env.DB_PATH ? resolve(process.env.DB_PATH) : defaultDatabasePath();
}

/** Runs `fn` inside a single SQLite transaction (commit or full rollback). */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Applies any migrations not yet recorded in schema_migrations. */
export function runMigrations(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((row) => Number(row.version)));
  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    inTransaction(db, () => {
      for (const statement of migration.statements) db.exec(statement);
      record.run(migration.version, Date.now());
    });
    console.log(`[competition] applied schema migration v${migration.version}`);
  }
}

/** Opens (creating parent dirs) and migrates a database file. */
export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  runMigrations(db);
  return db;
}

let instance: DatabaseSync | null = null;

/** Process-wide database handle. Safe to call repeatedly. */
export function getDatabase(): DatabaseSync {
  if (!instance) {
    const path = databasePath();
    instance = openDatabase(path);
    console.log(`[competition] SQLite database ready at ${path}`);
  }
  return instance;
}
