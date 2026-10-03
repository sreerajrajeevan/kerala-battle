/**
 * Development-only: seeds fake leaderboard records for all 14 districts so
 * the Competition UI can be visually tested.
 *
 * Usage: npm run db:seed --workspace=@kerala-battle/server
 *
 * - Never runs automatically; invoke it explicitly.
 * - Fake players are named "DevSeed <Name>" with playerIds starting with
 *   "devseed-", so seed data is always recognizable as development data.
 * - Refuses to run when NODE_ENV=production unless --force is passed.
 */
import { randomUUID } from 'node:crypto';
import {
  GAME_TYPE_PRECISION_CLASH,
  KERALA_DISTRICTS,
  MATCH_MODE_RANKED,
  MATCH_SOURCE_WEEKLY_QUEUE,
  type KeralaDistrict,
} from '@kerala-battle/shared';
import { getDatabase } from '../competition/db.js';
import { settleRankedMatch, type RankedPlayerInput } from '../competition/store.js';

/** Deterministic PRNG (mulberry32) so seed output is stable between runs. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = ['Akhil', 'Anu', 'Rahul', 'Divya', 'Vishnu', 'Meera', 'Arun', 'Lakshmi', 'Nikhil'];

function main(): void {
  const isProduction = process.env.NODE_ENV === 'production';
  const force = process.argv.includes('--force');
  if (isProduction && !force) {
    console.error('[competition] refusing to seed with NODE_ENV=production (pass --force to override)');
    process.exit(1);
  }

  const db = getDatabase();
  const rand = mulberry32(42);
  const now = Date.now();
  let matches = 0;

  KERALA_DISTRICTS.forEach((district: KeralaDistrict, districtIndex: number) => {
    const makePlayer = (slot: number): RankedPlayerInput => ({
      playerId: `devseed-${district.toLowerCase()}-${slot}`,
      displayName: `DevSeed ${FIRST_NAMES[(districtIndex + slot) % FIRST_NAMES.length]}`,
      district,
      score: 0,
    });
    const players = [makePlayer(0), makePlayer(1), makePlayer(2)];
    // Round-robin: every pair plays 3 matches with pseudo-random scores.
    for (let a = 0; a < players.length; a++) {
      for (let b = a + 1; b < players.length; b++) {
        for (let m = 0; m < 3; m++) {
          const playerA = players[a];
          const playerB = players[b];
          if (!playerA || !playerB) continue;
          const scoreA = 120 + Math.floor(rand() * 140);
          const scoreB = 120 + Math.floor(rand() * 140);
          settleRankedMatch(db, {
            matchId: randomUUID(),
            gameType: GAME_TYPE_PRECISION_CLASH,
            matchMode: MATCH_MODE_RANKED,
            matchSource: MATCH_SOURCE_WEEKLY_QUEUE,
            players: [
              { ...playerA, score: scoreA },
              { ...playerB, score: scoreB },
            ],
            winnerPlayerId: scoreA === scoreB ? null : scoreA > scoreB ? playerA.playerId : playerB.playerId,
            completedAtMs: now,
          });
          matches++;
        }
      }
    }
  });

  console.log(`[competition] seeded ${matches} dev matches across ${KERALA_DISTRICTS.length} districts`);
}

main();
