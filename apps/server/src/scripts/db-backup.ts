/**
 * Task 11: operator database backup.
 *
 *   npm run db:backup [-- --keep N] [--dir <backup-dir>]
 *
 * Uses SQLite `VACUUM INTO`, which writes a transactionally consistent
 * snapshot of a live database — safe while the server is running, unlike a
 * raw file copy. Output: <backup-dir>/kerala-battle-<UTC timestamp>.db
 *
 * Retention: keeps the latest N backups (default 14), deleting only files
 * matching kerala-battle-*.db inside the configured backup directory.
 *
 * Suitable for a daily scheduler (cron/systemd). Provider-independent: it
 * just writes a local file; copy it to remote storage separately.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { databasePath } from '../competition/db.js';

const BACKUP_PREFIX = 'kerala-battle-';
const BACKUP_SUFFIX = '.db';

export function backupFileName(when: Date = new Date()): string {
  // 2026-10-04T120000Z — filesystem-safe, sortable.
  const stamp = when.toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `${BACKUP_PREFIX}${stamp}${BACKUP_SUFFIX}`;
}

export function defaultBackupDir(): string {
  if (process.env.BACKUP_DIR?.trim()) return resolve(process.env.BACKUP_DIR.trim());
  return resolve(process.env.DATA_DIR?.trim() || 'apps/server/data', 'backups');
}

export function isBackupFile(name: string): boolean {
  return name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX);
}

export interface BackupResult {
  sourceDb: string;
  backupPath: string;
  bytes: number;
  pruned: string[];
}

/** Create a consistent backup of the database at dbPath. */
export function createBackup(
  dbPath: string = databasePath(),
  backupDir: string = defaultBackupDir(),
  keep = 14,
  when: Date = new Date(),
): BackupResult {
  if (!existsSync(dbPath)) {
    throw new Error(`database file not found: ${dbPath}`);
  }
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, backupFileName(when));
  // VACUUM INTO takes a consistent snapshot even while the server writes.
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  const bytes = statSync(backupPath).size;

  // Retention: keep the newest `keep` backups, delete older ones. Never
  // touches anything outside backupDir, and only kerala-battle-*.db files.
  const pruned: string[] = [];
  if (keep >= 0) {
    const backups = readdirSync(backupDir)
      .filter(isBackupFile)
      .sort()
      .reverse();
    for (const name of backups.slice(keep)) {
      const full = join(backupDir, name);
      rmSync(full);
      pruned.push(full);
    }
  }
  return { sourceDb: dbPath, backupPath, bytes, pruned };
}

function parseArgs(argv: string[]): { keep: number; dir: string | null } {
  let keep = 14;
  let dir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keep' && argv[i + 1]) keep = Math.max(0, Number(argv[++i]) || 0);
    if (argv[i] === '--dir' && argv[i + 1]) dir = resolve(argv[++i]);
  }
  return { keep, dir };
}

// CLI entry: `npm run db:backup [-- --keep N] [--dir <dir>]`
// (also runnable compiled: `node dist/scripts/db-backup.js`)
const scriptName = process.argv[1] !== undefined ? basename(process.argv[1]) : '';
const isMain = scriptName === 'db-backup.ts' || scriptName === 'db-backup.js';
if (isMain) {
  try {
    const { keep, dir } = parseArgs(process.argv.slice(2));
    const result = createBackup(databasePath(), dir ?? defaultBackupDir(), keep);
    console.log(
      JSON.stringify({
        event: 'db.backup_created',
        sourceDb: result.sourceDb,
        backupPath: result.backupPath,
        bytes: result.bytes,
        pruned: result.pruned,
      }),
    );
  } catch (error) {
    console.error(JSON.stringify({ event: 'db.backup_failed', error: String(error) }));
    process.exit(1);
  }
}
