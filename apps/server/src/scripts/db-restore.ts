/**
 * Task 11: operator database restore (dev/operator only).
 *
 *   npm run db:restore -- <backup-file> --force
 *
 * Safety rules:
 * - Requires --force (explicit confirmation). Without it, prints what WOULD
 *   happen and exits non-zero.
 * - Refuses when NODE_ENV=production unless KERALA_BATTLE_I_UNDERSTAND=1 is
 *   also set — restoring over a live production DB is never casual.
 * - Validates the backup first: opens it read-only and runs
 *   PRAGMA integrity_check plus a schema_migrations presence check.
 * - Backs up the CURRENT database to the backup dir before replacing it.
 * - Never touches the developer's real DB in automated tests: this script
 *   only runs when explicitly invoked by an operator.
 *
 * The server must be STOPPED before restoring (SQLite file replacement).
 */

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { databasePath } from '../competition/db.js';
import { backupFileName, defaultBackupDir, isBackupFile } from './db-backup.js';

export interface RestoreOptions {
  backupFile: string;
  force: boolean;
  productionOverride: boolean;
  dbPath: string;
  backupDir: string;
}

export interface RestoreResult {
  restoredFrom: string;
  dbPath: string;
  preRestoreBackup: string;
}

/** Validate that a file is a healthy Kerala Battle database. */
export function validateBackup(backupFile: string): void {
  if (!existsSync(backupFile)) {
    throw new Error(`backup file not found: ${backupFile}`);
  }
  const db = new DatabaseSync(backupFile, { readOnly: true });
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    const bad = rows.filter((r) => r.integrity_check !== 'ok');
    if (bad.length > 0) {
      throw new Error(`integrity_check failed: ${bad.map((r) => r.integrity_check).join('; ')}`);
    }
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .all();
    if (tables.length === 0) {
      throw new Error('not a Kerala Battle database: schema_migrations table missing');
    }
  } finally {
    db.close();
  }
}

/**
 * Restore dbPath from a validated backup. Steps:
 * 1. validate backup integrity;
 * 2. snapshot the current DB into the backup dir (pre-restore safety net);
 * 3. replace the DB file (removing stale WAL sidecars).
 */
export function restoreDatabase(options: RestoreOptions): RestoreResult {
  const { backupFile, force, productionOverride, dbPath, backupDir } = options;
  if (!force) {
    throw new Error(
      'refusing to restore without --force: re-run with --force to confirm you understand ' +
        'the current database will be replaced.',
    );
  }
  if (process.env.NODE_ENV === 'production' && !productionOverride) {
    throw new Error(
      'refusing to restore in NODE_ENV=production without KERALA_BATTLE_I_UNDERSTAND=1. ' +
        'Stop the server first, verify the backup, then set the override.',
    );
  }
  if (!isBackupFile(basename(backupFile))) {
    throw new Error(`does not look like a Kerala Battle backup file: ${backupFile}`);
  }
  validateBackup(backupFile);

  mkdirSync(backupDir, { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });

  // Safety net: snapshot the current DB before replacing it.
  let preRestoreBackup = '';
  if (existsSync(dbPath)) {
    preRestoreBackup = join(backupDir, `pre-restore-${backupFileName()}`);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`VACUUM INTO '${preRestoreBackup.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
  }

  copyFileSync(backupFile, dbPath);
  // Stale WAL sidecars must not survive a file replacement.
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
    if (existsSync(sidecar)) rmSync(sidecar);
  }
  return { restoredFrom: backupFile, dbPath, preRestoreBackup };
}

function parseArgs(argv: string[]): { backupFile: string | null; force: boolean } {
  let backupFile: string | null = null;
  let force = false;
  for (const arg of argv) {
    if (arg === '--force') force = true;
    else if (!arg.startsWith('--')) backupFile = resolve(arg);
  }
  return { backupFile, force };
}

const scriptName = process.argv[1] !== undefined ? basename(process.argv[1]) : '';
const isMain = scriptName === 'db-restore.ts' || scriptName === 'db-restore.js';
if (isMain) {
  try {
    const { backupFile, force } = parseArgs(process.argv.slice(2));
    if (!backupFile) {
      console.error('usage: npm run db:restore -- <backup-file> --force');
      process.exit(2);
    }
    const result = restoreDatabase({
      backupFile,
      force,
      productionOverride: process.env.KERALA_BATTLE_I_UNDERSTAND === '1',
      dbPath: databasePath(),
      backupDir: defaultBackupDir(),
    });
    console.log(
      JSON.stringify({
        event: 'db.restore_completed',
        restoredFrom: result.restoredFrom,
        dbPath: result.dbPath,
        preRestoreBackup: result.preRestoreBackup,
      }),
    );
  } catch (error) {
    console.error(JSON.stringify({ event: 'db.restore_failed', error: String(error) }));
    process.exit(1);
  }
}
