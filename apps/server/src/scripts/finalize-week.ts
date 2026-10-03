/**
 * Development/testing: finalize one competition week (crown Weekly Master +
 * District Champion, snapshot history).
 *
 * Usage:
 *   npm run competition:finalize -- 2026-W40
 *
 * Uses the exact production finalization logic. A standalone script cannot
 * see the running server's in-memory active matches, so it finalizes with an
 * active-match count of zero: only use it for weeks with no live ranked
 * matches (old test weeks), never to rush a just-ended live week.
 *
 * Safety: refuses to run when NODE_ENV=production unless --force is passed.
 */
import { getDatabase } from '../competition/db.js';
import { finalizeCompetitionWeek } from '../competition/finalize.js';

const isProduction = process.env.NODE_ENV === 'production';
const force = process.argv.includes('--force');

if (isProduction && !force) {
  console.error(
    '[competition] refusing to finalize a week with NODE_ENV=production (pass --force to override)',
  );
  process.exit(1);
}

const weekId = process.argv[2];
if (!weekId || !/^\d{4}-W\d{1,2}$/.test(weekId)) {
  console.error('[competition] usage: npm run competition:finalize -- <weekId> (e.g. 2026-W40)');
  process.exit(1);
}

const db = getDatabase();
const outcome = finalizeCompetitionWeek(db, weekId);
switch (outcome.status) {
  case 'finalized': {
    const { weeklyMaster, districtChampion, featuredGameType } = outcome.champions ?? {};
    console.log(`[competition] week ${weekId} finalized (${featuredGameType})`);
    console.log(
      `  Weekly Master: ${weeklyMaster ? `${weeklyMaster.displayName} (${weeklyMaster.district}, ${weeklyMaster.points} pts)` : 'none'}`,
    );
    console.log(
      `  District Champion: ${districtChampion ? `${districtChampion.district} (${districtChampion.points} pts)` : 'none'}`,
    );
    break;
  }
  case 'already-finalized':
    console.log(`[competition] week ${weekId} was already finalized; nothing changed`);
    break;
  case 'week-not-ended':
    console.error(`[competition] week ${weekId} has not ended yet; refusing to finalize`);
    process.exitCode = 1;
    break;
  case 'active-matches':
    console.log(
      `[competition] week ${weekId} waiting on ${outcome.activeRankedMatches} active ranked match(es); retry in ${Math.ceil((outcome.retryAfterMs ?? 0) / 1000)}s`,
    );
    break;
}
db.close();
