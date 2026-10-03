/**
 * Development/testing: set the current competition week's featured game.
 *
 * Usage:
 *   npm run competition:set-featured -- crown-rush
 *   npm run competition:set-featured -- precision-clash
 *
 * Safety: refuses to run when NODE_ENV=production unless --force is passed,
 * so a stray invocation cannot rewrite the live week's featured game.
 * There is no admin website; this script is the only override path.
 */
import { getDatabase } from '../competition/db.js';
import { getOrCreateWeekConfig, setFeaturedGameForWeek } from '../competition/featuredGame.js';
import { getCompetitionWeek } from '../competition/week.js';
import { GAME_DEFINITIONS, isGameType } from '@kerala-battle/shared';

const isProduction = process.env.NODE_ENV === 'production';
const force = process.argv.includes('--force');

if (isProduction && !force) {
  console.error(
    '[competition] refusing to change the featured game with NODE_ENV=production (pass --force to override)',
  );
  process.exit(1);
}

const gameType = process.argv[2];
if (!isGameType(gameType)) {
  const supported = Object.keys(GAME_DEFINITIONS).join(', ');
  console.error(`[competition] usage: npm run competition:set-featured -- <game> (supported: ${supported})`);
  process.exit(1);
}

const db = getDatabase();
const nowMs = Date.now();
const before = getOrCreateWeekConfig(db, nowMs);
const weekId = getCompetitionWeek(nowMs).id;
const updated = setFeaturedGameForWeek(db, weekId, gameType, nowMs);
console.log(
  `[competition] week ${weekId}: featured game ${before.featuredGameType} -> ${updated.featuredGameType}`,
);
db.close();
