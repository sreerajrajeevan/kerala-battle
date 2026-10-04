/**
 * SQLite database bootstrap.
 *
 * - Default file: <server>/data/kerala-battle.db (overridable via DB_PATH).
 * - DATA_DIR support: when DATA_DIR is set (and DB_PATH is not), the database
 *   lives at <DATA_DIR>/kerala-battle.db — the persistent volume in Docker.
 * - Applies pending schema migrations on startup; never deletes data.
 * - WAL mode for safe concurrent reads while the server writes.
 * - Startup checks: the directory must exist (or be creatable) and be
 *   writable; in production an unwritable directory fails loudly.
 *
 * The repository layer in store.ts owns all SQL; game logic never touches
 * the database directly, so SQLite can later be replaced without rewriting
 * settlement or leaderboard logic.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS } from './schema.js';
import { logger } from '../logging/logger.js';

export const DB_FILENAME = 'kerala-battle.db';

function dataDir(): string {
  if (process.env.DATA_DIR?.trim()) return resolve(process.env.DATA_DIR.trim());
  // src/competition -> <server>/data ; dist/competition -> <server>/data
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
}

function defaultDatabasePath(): string {
  return join(dataDir(), DB_FILENAME);
}

export function databasePath(): string {
  if (process.env.DB_PATH) return resolve(process.env.DB_PATH);
  return defaultDatabasePath();
}

/** Latest migration version known to this build. */
export function latestSchemaVersion(): number {
  return MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
}

/**
 * Verify the data directory exists (creating it) and is writable. Throws in
 * production when storage is not writable: the server must not start against
 * a database it cannot persist.
 */
export function ensureWritableDataDir(dir: string, isProduction: boolean): void {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe);
  } catch (error) {
    logger.error({ event: 'db.storage_unwritable', dataDir: dir }, error);
    if (isProduction) {
      throw new Error(`Configured data directory is not writable: ${dir}`);
    }
    logger.warn({
      event: 'db.storage_unwritable_dev',
      dataDir: dir,
      detail: 'continuing because NODE_ENV is not production',
    });
  }
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
    logger.info({ event: 'db.migration_applied', schemaVersion: migration.version });
  }
}

/** Current schema version recorded in an open database. */
export function currentSchemaVersion(db: DatabaseSync): number {
  try {
    const rows = db
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .all() as Array<{ v: number | null }>;
    return Number(rows[0]?.v ?? 0);
  } catch {
    return 0;
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
let readyState: { dbReady: boolean; schemaVersion: number; dbPath: string } = {
  dbReady: false,
  schemaVersion: 0,
  dbPath: '',
};

/** Process-wide database handle. Safe to call repeatedly. */
export function getDatabase(): DatabaseSync {
  if (!instance) {
    const path = databasePath();
    ensureWritableDataDir(dirname(path), process.env.NODE_ENV === 'production');
    instance = openDatabase(path);
    readyState = { dbReady: true, schemaVersion: currentSchemaVersion(instance), dbPath: path };
    logger.info({
      event: 'db.initialized',
      dbPath: path,
      schemaVersion: readyState.schemaVersion,
    });
    console.log(`[competition] SQLite database ready at ${path}`);
  }
  return instance;
}

/** Readiness info for GET /ready. Database path only — never secrets. */
export function getReadiness(): { dbReady: boolean; schemaVersion: number; dbPath: string } {
  return { ...readyState };
}

/** Close the process-wide handle (graceful shutdown). */
export function closeDatabase(): void {
  if (instance) {
    try {
      instance.close();
      logger.info({ event: 'db.closed' });
    } catch (error) {
      logger.error({ event: 'db.close_failed' }, error);
    }
    instance = null;
    readyState = { dbReady: false, schemaVersion: 0, dbPath: '' };
  }
}
