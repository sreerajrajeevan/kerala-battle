/**
 * Pure Crown Rush simulation helpers. No sockets, no timers, no randomness
 * beyond an injectable `rand` — every function here is unit-testable.
 */
import {
  CROWN_RUSH_ARENA_HEIGHT,
  CROWN_RUSH_ARENA_WIDTH,
  CROWN_RUSH_CAPTURE_DISTANCE,
  CROWN_RUSH_DURATION_MS,
  CROWN_RUSH_MIN_SPAWN_DISTANCE,
  CROWN_RUSH_MOVE_SPEED,
  CROWN_RUSH_PLAYER_RADIUS,
  CROWN_RUSH_SPAWN_A,
  CROWN_RUSH_SPAWN_B,
  CROWN_RUSH_SPAWN_PADDING,
  CROWN_RUSH_WIN_SCORE,
} from '@kerala-battle/shared';
import type { CrownRushSim, SimCrown, SimPlayer } from './types.js';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function createSim(playerAId: string, playerBId: string): CrownRushSim {
  const mk = (playerId: string, x: number, y: number): SimPlayer => ({
    playerId,
    x,
    y,
    inputX: 0,
    inputY: 0,
    score: 0,
  });
  return {
    players: [mk(playerAId, CROWN_RUSH_SPAWN_A.x, CROWN_RUSH_SPAWN_A.y), mk(playerBId, CROWN_RUSH_SPAWN_B.x, CROWN_RUSH_SPAWN_B.y)],
    crown: null,
    timeRemainingMs: CROWN_RUSH_DURATION_MS,
    suddenDeath: false,
    captureSeq: 0,
  };
}

/**
 * Clamp an input axis pair to [-1, 1] and normalize vectors longer than 1.
 * This is what makes diagonal movement equal in speed to straight movement,
 * and what neutralizes extreme client values (999 -> 1).
 */
export function sanitizeInput(xAxis: number, yAxis: number): { x: number; y: number } {
  // Non-finite values (should never reach here — validated at ingest) stop
  // the player rather than poisoning the simulation with NaN.
  const safe = (value: number): number => (Number.isFinite(value) ? value : 0);
  const cx = clamp(safe(xAxis), -1, 1);
  const cy = clamp(safe(yAxis), -1, 1);
  const magnitude = Math.hypot(cx, cy);
  if (magnitude > 1) return { x: cx / magnitude, y: cy / magnitude };
  return { x: cx, y: cy };
}

/** Strict validation for raw socket input: finite numbers only, nothing else. */
export function isValidInputPayload(payload: unknown): payload is { xAxis: number; yAxis: number } {
  if (typeof payload !== 'object' || payload === null) return false;
  const { xAxis, yAxis } = payload as { xAxis?: unknown; yAxis?: unknown };
  return (
    typeof xAxis === 'number' &&
    typeof yAxis === 'number' &&
    Number.isFinite(xAxis) &&
    Number.isFinite(yAxis)
  );
}

/**
 * Advance both players by dtMs using their stored input vectors.
 * Speed is fixed server-side, so flooding inputs can never move a player faster.
 */
export function stepPlayers(sim: CrownRushSim, dtMs: number): void {
  const dtSeconds = clamp(dtMs, 0, 100) / 1000;
  for (const player of sim.players) {
    const { x, y } = sanitizeInput(player.inputX, player.inputY);
    player.x += x * CROWN_RUSH_MOVE_SPEED * dtSeconds;
    player.y += y * CROWN_RUSH_MOVE_SPEED * dtSeconds;
    player.x = clamp(player.x, CROWN_RUSH_PLAYER_RADIUS, CROWN_RUSH_ARENA_WIDTH - CROWN_RUSH_PLAYER_RADIUS);
    player.y = clamp(player.y, CROWN_RUSH_PLAYER_RADIUS, CROWN_RUSH_ARENA_HEIGHT - CROWN_RUSH_PLAYER_RADIUS);
  }
}

export interface SpawnAvoid {
  x: number;
  y: number;
}

/**
 * Pick a crown position: inside padded bounds, at least MIN_SPAWN_DISTANCE
 * from each player and from the avoided point (previous crown), with a
 * bounded retry loop and a safe center fallback.
 */
export function spawnCrown(
  players: readonly SimPlayer[],
  golden: boolean,
  avoid: SpawnAvoid | null,
  rand: () => number = Math.random,
): SimCrown {
  const minX = CROWN_RUSH_SPAWN_PADDING;
  const maxX = CROWN_RUSH_ARENA_WIDTH - CROWN_RUSH_SPAWN_PADDING;
  const minY = CROWN_RUSH_SPAWN_PADDING;
  const maxY = CROWN_RUSH_ARENA_HEIGHT - CROWN_RUSH_SPAWN_PADDING;
  for (let attempt = 0; attempt < 20; attempt++) {
    const x = minX + rand() * (maxX - minX);
    const y = minY + rand() * (maxY - minY);
    const clearOfPlayers = players.every(
      (player) => Math.hypot(player.x - x, player.y - y) >= CROWN_RUSH_MIN_SPAWN_DISTANCE,
    );
    const clearOfPrevious =
      !avoid || Math.hypot(avoid.x - x, avoid.y - y) >= CROWN_RUSH_MIN_SPAWN_DISTANCE;
    if (clearOfPlayers && clearOfPrevious) return { x: Math.round(x), y: Math.round(y), golden };
  }
  return { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2), golden };
}

/**
 * Server-authoritative capture check. Returns the capturing player index, or
 * null. If both players qualify on the same tick, the closest one wins; an
 * exact tie breaks deterministically on playerId ordering.
 */
export function checkCapture(sim: CrownRushSim): 0 | 1 | null {
  const crown = sim.crown;
  if (!crown) return null;
  const distances = sim.players.map((player) => Math.hypot(player.x - crown.x, player.y - crown.y));
  const inRange = distances.map((d) => d <= CROWN_RUSH_CAPTURE_DISTANCE);
  if (!inRange[0] && !inRange[1]) return null;
  if (inRange[0] && !inRange[1]) return 0;
  if (inRange[1] && !inRange[0]) return 1;
  const d0 = distances[0] ?? Number.POSITIVE_INFINITY;
  const d1 = distances[1] ?? Number.POSITIVE_INFINITY;
  if (d0 === d1) return sim.players[0].playerId < sim.players[1].playerId ? 0 : 1;
  return d0 < d1 ? 0 : 1;
}

/**
 * Award a capture. Clears the crown so it can never be awarded twice.
 * Returns the match winner when the capture ends the game (first-to-7, or
 * any golden-crown capture in sudden death).
 */
export function applyCapture(sim: CrownRushSim, index: 0 | 1): { winner: 0 | 1 | null } {
  if (!sim.crown) return { winner: null };
  sim.players[index].score += 1;
  sim.captureSeq += 1;
  sim.crown = null;
  if (sim.suddenDeath) return { winner: index };
  if (sim.players[index].score >= CROWN_RUSH_WIN_SCORE) return { winner: index };
  return { winner: null };
}

/** Advance the match clock. Returns 'timeUp' when the 45s expire. */
export function tickClock(sim: CrownRushSim, dtMs: number): 'continue' | 'timeUp' {
  if (sim.suddenDeath) return 'continue';
  sim.timeRemainingMs -= Math.max(0, dtMs);
  return sim.timeRemainingMs <= 0 ? 'timeUp' : 'continue';
}

/** Decide the outcome when the clock expires. */
export function decideTimeUp(sim: CrownRushSim): 0 | 1 | 'suddenDeath' {
  const [a, b] = sim.players;
  if (a.score === b.score) return 'suddenDeath';
  return a.score > b.score ? 0 : 1;
}
