/**
 * Development-only: deletes the local competition SQLite database
 * (data/kerala-battle.db plus WAL sidecars).
 *
 * Usage: npm run db:reset --workspace=@kerala-battle/server
 *
 * Safety: refuses to run when NODE_ENV=production unless --force is passed,
 * so a stray invocation cannot wipe production data.
 */
import { existsSync, rmSync } from 'node:fs';
import { databasePath } from '../competition/db.js';

const dbPath = databasePath();
const isProduction = process.env.NODE_ENV === 'production';
const force = process.argv.includes('--force');

if (isProduction && !force) {
  console.error('[competition] refusing to reset the database with NODE_ENV=production (pass --force to override)');
  process.exit(1);
}

for (const suffix of ['', '-wal', '-shm']) {
  const file = `${dbPath}${suffix}`;
  if (existsSync(file)) {
    rmSync(file);
    console.log(`[competition] removed ${file}`);
  }
}
console.log('[competition] database reset complete; it will be recreated on next server start');
