/**
 * Crown Rush engine unit tests: pure simulation logic, no sockets.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CROWN_RUSH_ARENA_HEIGHT,
  CROWN_RUSH_ARENA_WIDTH,
  CROWN_RUSH_MOVE_SPEED,
  CROWN_RUSH_PLAYER_RADIUS,
  CROWN_RUSH_SPAWN_PADDING,
  CROWN_RUSH_WIN_SCORE,
} from '@kerala-battle/shared';
import {
  applyCapture,
  checkCapture,
  createSim,
  decideTimeUp,
  isValidInputPayload,
  sanitizeInput,
  spawnCrown,
  stepPlayers,
  tickClock,
} from './engine.js';

describe('sanitizeInput', () => {
  it('passes through unit vectors unchanged', () => {
    assert.deepEqual(sanitizeInput(1, 0), { x: 1, y: 0 });
    assert.deepEqual(sanitizeInput(0, -1), { x: 0, y: -1 });
  });

  it('clamps extreme client values then normalizes', () => {
    const { x, y } = sanitizeInput(999, -999);
    // (999, -999) -> (1, -1) -> unit diagonal.
    assert.ok(Math.abs(x - Math.SQRT1_2) < 1e-9);
    assert.ok(Math.abs(y + Math.SQRT1_2) < 1e-9);
  });

  it('clamps single-axis extremes to exactly 1', () => {
    assert.deepEqual(sanitizeInput(999, 0), { x: 1, y: 0 });
    assert.deepEqual(sanitizeInput(0, -999), { x: 0, y: -1 });
  });

  it('normalizes diagonal vectors longer than 1', () => {
    const { x, y } = sanitizeInput(1, 1);
    const expected = Math.SQRT1_2;
    assert.ok(Math.abs(x - expected) < 1e-9);
    assert.ok(Math.abs(y - expected) < 1e-9);
    assert.ok(Math.hypot(x, y) <= 1 + 1e-9);
  });
});

describe('isValidInputPayload', () => {
  it('accepts finite numbers', () => {
    assert.equal(isValidInputPayload({ xAxis: 0.5, yAxis: -1 }), true);
  });

  it('rejects NaN, Infinity, strings, objects, missing values', () => {
    assert.equal(isValidInputPayload({ xAxis: Number.NaN, yAxis: 0 }), false);
    assert.equal(isValidInputPayload({ xAxis: Number.POSITIVE_INFINITY, yAxis: 0 }), false);
    assert.equal(isValidInputPayload({ xAxis: '1', yAxis: 0 }), false);
    assert.equal(isValidInputPayload({ xAxis: { v: 1 }, yAxis: 0 }), false);
    assert.equal(isValidInputPayload({ xAxis: 0 }), false);
    assert.equal(isValidInputPayload(null), false);
    assert.equal(isValidInputPayload('move'), false);
  });
});

describe('stepPlayers', () => {
  it('moves at the configured speed for full input', () => {
    const sim = createSim('a', 'b');
    sim.players[0].inputX = 1;
    sim.players[0].inputY = 0;
    const startX = sim.players[0].x;
    // Ten 100ms ticks (a single dt is clamped to 100ms against stalls).
    for (let i = 0; i < 10; i++) stepPlayers(sim, 100);
    assert.ok(Math.abs(sim.players[0].x - startX - CROWN_RUSH_MOVE_SPEED) < 1e-6);
  });

  it('moves diagonally no faster than straight', () => {
    const straight = createSim('a', 'b');
    straight.players[0].inputX = 1;
    for (let i = 0; i < 10; i++) stepPlayers(straight, 100);
    const diagonal = createSim('a', 'b');
    diagonal.players[0].inputX = 1;
    diagonal.players[0].inputY = 1;
    for (let i = 0; i < 10; i++) stepPlayers(diagonal, 100);
    const straightDist = Math.abs(straight.players[0].x - 180);
    const diagDist = Math.hypot(diagonal.players[0].x - 180, diagonal.players[0].y - 350);
    assert.ok(Math.abs(straightDist - diagDist) < 1e-6);
    assert.ok(Math.abs(diagDist - CROWN_RUSH_MOVE_SPEED) < 1e-6);
  });

  it('clamps players to arena bounds', () => {
    const sim = createSim('a', 'b');
    sim.players[0].x = CROWN_RUSH_ARENA_WIDTH - CROWN_RUSH_PLAYER_RADIUS;
    sim.players[0].inputX = 1;
    stepPlayers(sim, 5000);
    assert.equal(sim.players[0].x, CROWN_RUSH_ARENA_WIDTH - CROWN_RUSH_PLAYER_RADIUS);

    sim.players[1].y = CROWN_RUSH_PLAYER_RADIUS;
    sim.players[1].inputY = -1;
    stepPlayers(sim, 5000);
    assert.equal(sim.players[1].y, CROWN_RUSH_PLAYER_RADIUS);
  });

  it('ignores invalid stored input (defense in depth)', () => {
    const sim = createSim('a', 'b');
    sim.players[0].inputX = Number.NaN;
    const startX = sim.players[0].x;
    // NaN sanitizes to (0,0)-ish clamp; must not move or produce NaN.
    stepPlayers(sim, 1000);
    assert.ok(Number.isFinite(sim.players[0].x));
    assert.equal(sim.players[0].x, startX);
  });

  it('flooding inputs cannot move a player faster (speed-hack resistance)', () => {
    const slow = createSim('a', 'b');
    slow.players[0].inputX = 1;
    stepPlayers(slow, 100);

    const flooded = createSim('a', 'b');
    for (let i = 0; i < 300; i++) {
      // A malicious client spamming inputs only overwrites the stored vector.
      const sane = sanitizeInput(1, 0);
      flooded.players[0].inputX = sane.x;
      flooded.players[0].inputY = sane.y;
    }
    stepPlayers(flooded, 100);

    assert.equal(flooded.players[0].x, slow.players[0].x);
    assert.equal(flooded.players[0].y, slow.players[0].y);
  });
});

describe('spawnCrown', () => {
  it('spawns within padded bounds', () => {
    const sim = createSim('a', 'b');
    for (let i = 0; i < 50; i++) {
      const crown = spawnCrown(sim.players, false, null);
      assert.ok(crown.x >= CROWN_RUSH_SPAWN_PADDING);
      assert.ok(crown.x <= CROWN_RUSH_ARENA_WIDTH - CROWN_RUSH_SPAWN_PADDING);
      assert.ok(crown.y >= CROWN_RUSH_SPAWN_PADDING);
      assert.ok(crown.y <= CROWN_RUSH_ARENA_HEIGHT - CROWN_RUSH_SPAWN_PADDING);
    }
  });

  it('keeps minimum distance from players', () => {
    const sim = createSim('a', 'b');
    // Deterministic rand: cycles through a fixed sequence.
    let n = 0;
    const rand = () => {
      n += 1;
      return (n % 97) / 97;
    };
    for (let i = 0; i < 30; i++) {
      const crown = spawnCrown(sim.players, false, null, rand);
      for (const player of sim.players) {
        assert.ok(Math.hypot(player.x - crown.x, player.y - crown.y) >= 150);
      }
    }
  });
});

describe('checkCapture / applyCapture', () => {
  it('awards the player in capture range', () => {
    const sim = createSim('a', 'b');
    sim.crown = { x: sim.players[0].x + 10, y: sim.players[0].y, golden: false };
    assert.equal(checkCapture(sim), 0);
    const result = applyCapture(sim, 0);
    assert.equal(result.winner, null);
    assert.equal(sim.players[0].score, 1);
    assert.equal(sim.crown, null);
  });

  it('never awards one crown twice', () => {
    const sim = createSim('a', 'b');
    sim.crown = { x: sim.players[0].x + 10, y: sim.players[0].y, golden: false };
    applyCapture(sim, 0);
    assert.equal(checkCapture(sim), null);
    const again = applyCapture(sim, 0);
    assert.equal(again.winner, null);
    assert.equal(sim.players[0].score, 1);
  });

  it('resolves same-tick contention by closeness', () => {
    const sim = createSim('a', 'b');
    sim.players[0].x = 100;
    sim.players[0].y = 100;
    sim.players[1].x = 120;
    sim.players[1].y = 100;
    sim.crown = { x: 130, y: 100, golden: false };
    assert.equal(checkCapture(sim), 1);
  });

  it('breaks exact distance ties deterministically by playerId ordering', () => {
    const sim = createSim('zzz', 'aaa');
    sim.players[0].x = 100;
    sim.players[0].y = 100;
    sim.players[1].x = 100;
    sim.players[1].y = 100;
    sim.crown = { x: 110, y: 100, golden: false };
    // 'aaa' < 'zzz', so index 1 wins the tie.
    assert.equal(checkCapture(sim), 1);
  });

  it('returns null when nobody is in range', () => {
    const sim = createSim('a', 'b');
    sim.crown = { x: 500, y: 350, golden: false };
    assert.equal(checkCapture(sim), null);
  });

  it('ends the game immediately at 7 crowns', () => {
    const sim = createSim('a', 'b');
    sim.players[0].score = CROWN_RUSH_WIN_SCORE - 1;
    sim.crown = { x: sim.players[0].x + 10, y: sim.players[0].y, golden: false };
    const result = applyCapture(sim, 0);
    assert.deepEqual(result, { winner: 0 });
    assert.equal(sim.players[0].score, CROWN_RUSH_WIN_SCORE);
  });
});

describe('tickClock / decideTimeUp', () => {
  it('counts down and reports timeUp at zero', () => {
    const sim = createSim('a', 'b');
    assert.equal(tickClock(sim, 44000), 'continue');
    assert.ok(sim.timeRemainingMs > 0);
    assert.equal(tickClock(sim, 1000), 'timeUp');
  });

  it('higher score wins when time expires', () => {
    const sim = createSim('a', 'b');
    sim.players[0].score = 5;
    sim.players[1].score = 3;
    assert.equal(decideTimeUp(sim), 0);
  });

  it('tied score enters sudden death', () => {
    const sim = createSim('a', 'b');
    sim.players[0].score = 5;
    sim.players[1].score = 5;
    assert.equal(decideTimeUp(sim), 'suddenDeath');
  });

  it('any golden-crown capture wins sudden death instantly', () => {
    const sim = createSim('a', 'b');
    sim.suddenDeath = true;
    sim.players[1].score = 5;
    sim.crown = { x: sim.players[1].x + 10, y: sim.players[1].y, golden: true };
    assert.equal(checkCapture(sim), 1);
    const result = applyCapture(sim, 1);
    assert.deepEqual(result, { winner: 1 });
  });
});
