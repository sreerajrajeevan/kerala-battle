/**
 * Crown Rush runner tests: input validation, countdown gating, captures,
 * timer/sudden-death transitions, first-to-7, and game-loop cleanup.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@kerala-battle/shared';
import {
  CROWN_RUSH_MOVE_SPEED,
  CrownRushStateEvent,
  type CrownRushStatePayload,
} from '@kerala-battle/shared';
import { CrownRushRunner, type CrownRushFinishResult } from './runner.js';
import type { SimCrown } from './types.js';

type IoServer = Server<ClientToServerEvents, ServerToClientEvents>;

interface Emitted {
  room: string;
  event: string;
  payload: CrownRushStatePayload;
}

function makeRunner(options?: {
  durationMs?: number;
  respawnDelayMs?: number;
  suddenDeathFailsafeMs?: number;
  onFinish?: (result: CrownRushFinishResult) => void;
}): { runner: CrownRushRunner; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const fakeIo = {
    to: (room: string) => ({
      emit: (event: string, payload: CrownRushStatePayload) => {
        emitted.push({ room, event, payload });
      },
    }),
  } as unknown as IoServer;
  const runner = new CrownRushRunner(
    fakeIo,
    'Kannur',
    [
      { socketId: 'sock-a', playerId: 'player-a', displayName: 'Sree' },
      { socketId: 'sock-b', playerId: 'player-b', displayName: 'Anu' },
    ],
    {
      tickHz: 1000, // real loop unused in tests; tickForTest drives the sim
      snapshotHz: 1000,
      durationMs: options?.durationMs,
      respawnDelayMs: options?.respawnDelayMs ?? 10,
      suddenDeathFailsafeMs: options?.suddenDeathFailsafeMs ?? 30,
      onFinish: options?.onFinish ?? (() => {}),
    },
  );
  return { runner, emitted };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('CrownRushRunner input handling', () => {
  let ctx: ReturnType<typeof makeRunner>;
  beforeEach(() => {
    ctx = makeRunner();
  });
  afterEach(() => {
    ctx.runner.destroy();
  });

  it('ignores input before GO (countdown)', () => {
    ctx.runner.handleInput('sock-a', { matchId: 'x', xAxis: 1, yAxis: 0, sequence: 1 });
    assert.equal(ctx.runner.sim.players[0].inputX, 0);
  });

  it('rejects NaN, Infinity, strings, and unknown sockets', async () => {
    ctx.runner.beginCountdown(1);
    await sleep(20);
    assert.equal(ctx.runner.status, 'playing');

    ctx.runner.handleInput('sock-a', { matchId: 'x', xAxis: Number.NaN, yAxis: 0, sequence: 1 });
    ctx.runner.handleInput('sock-a', { matchId: 'x', xAxis: Number.POSITIVE_INFINITY, yAxis: 0, sequence: 2 });
    ctx.runner.handleInput('sock-a', { matchId: 'x', xAxis: '1', yAxis: 0, sequence: 3 });
    ctx.runner.handleInput('sock-a', null);
    ctx.runner.handleInput('intruder-socket', { matchId: 'x', xAxis: 1, yAxis: 0, sequence: 4 });
    assert.equal(ctx.runner.sim.players[0].inputX, 0);
    assert.equal(ctx.runner.sim.players[0].inputY, 0);
    assert.equal(ctx.runner.sim.players[1].inputX, 0);
    ctx.runner.destroy();
  });

  it('clamps extreme axes and identifies the player from the socket', async () => {
    ctx.runner.beginCountdown(1);
    await sleep(20);
    ctx.runner.handleInput('sock-b', { matchId: 'x', xAxis: 999, yAxis: -999, sequence: 1 });
    // (999, -999) clamps to (1, -1) then normalizes to a unit diagonal.
    const expected = Math.SQRT1_2;
    assert.ok(Math.abs(ctx.runner.sim.players[1].inputX - expected) < 1e-9);
    assert.ok(Math.abs(ctx.runner.sim.players[1].inputY + expected) < 1e-9);
    // Player A untouched: the payload carries no identity to spoof.
    assert.equal(ctx.runner.sim.players[0].inputX, 0);
    ctx.runner.destroy();
  });

  it('moves the player at the configured speed once playing', async () => {
    ctx.runner.beginCountdown(1);
    await sleep(20);
    ctx.runner.handleInput('sock-a', { matchId: 'x', xAxis: 1, yAxis: 0, sequence: 1 });
    const startX = ctx.runner.sim.players[0].x;
    // Ten 100ms ticks (the engine clamps a single dt to 100ms against stalls).
    for (let i = 0; i < 10; i++) ctx.runner.tickForTest(100);
    const moved = ctx.runner.sim.players[0].x - startX;
    assert.ok(Math.abs(moved - CROWN_RUSH_MOVE_SPEED) < 1e-6);
    ctx.runner.destroy();
  });

  it('ignores input after the match finished', async () => {
    const finishes: CrownRushFinishResult[] = [];
    const c2 = makeRunner({ onFinish: (r) => finishes.push(r) });
    c2.runner.beginCountdown(1);
    await sleep(20);
    // Force an immediate first-to-7 win.
    c2.runner.sim.players[0].score = 6;
    c2.runner.sim.crown = { x: c2.runner.sim.players[0].x + 5, y: c2.runner.sim.players[0].y, golden: false };
    c2.runner.tickForTest(33);
    assert.equal(finishes.length, 1);
    assert.equal(c2.runner.status, 'finished');
    const before = c2.runner.sim.players[1].inputX;
    c2.runner.handleInput('sock-b', { matchId: 'x', xAxis: 1, yAxis: 0, sequence: 9 });
    assert.equal(c2.runner.sim.players[1].inputX, before);
  });
});

describe('CrownRushRunner captures and respawn', () => {
  it('scores, clears the crown, and respawns after the delay', async () => {
    const { runner } = makeRunner({ respawnDelayMs: 15 });
    runner.beginCountdown(1);
    await sleep(20);
    runner.sim.crown = { x: runner.sim.players[0].x + 5, y: runner.sim.players[0].y, golden: false };
    runner.tickForTest(33);
    assert.equal(runner.sim.players[0].score, 1);
    assert.equal(runner.sim.crown, null);
    await sleep(40);
    // Re-read after the respawn delay (a fresh read; the earlier null check
    // must not narrow this).
    const crown = runner.sim.crown as SimCrown | null;
    assert.ok(crown);
    assert.equal(crown.golden, false);
    assert.equal(runner.status, 'playing');
    runner.destroy();
  });

  it('broadcasts snapshots with the capture feed', async () => {
    const { runner, emitted } = makeRunner({ respawnDelayMs: 15 });
    runner.beginCountdown(1);
    await sleep(20);
    runner.sim.crown = { x: runner.sim.players[0].x + 5, y: runner.sim.players[0].y, golden: false };
    runner.tickForTest(33);
    await sleep(40);
    const states = emitted.filter((e) => e.event === CrownRushStateEvent).map((e) => e.payload);
    assert.ok(states.length > 0);
    const latest = states[states.length - 1]!;
    assert.equal(latest.matchId, runner.matchId);
    assert.equal(latest.players[0]!.score, 1);
    assert.equal(latest.lastCapture?.captureSeq, 1);
    assert.equal(latest.lastCapture?.displayName, 'Sree');
    runner.destroy();
  });
});

describe('CrownRushRunner match end', () => {
  it('finishes immediately on first-to-7 with no timers left', async () => {
    const finishes: CrownRushFinishResult[] = [];
    const { runner } = makeRunner({ onFinish: (r) => finishes.push(r) });
    runner.beginCountdown(1);
    await sleep(20);
    runner.sim.players[0].score = 6;
    runner.sim.crown = { x: runner.sim.players[0].x + 5, y: runner.sim.players[0].y, golden: false };
    runner.tickForTest(33);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.winnerPlayerId, 'player-a');
    assert.deepEqual(finishes[0]!.scores, [7, 0]);
    assert.equal(runner.status, 'finished');
    assert.equal(runner.pendingTimers, 0);
  });

  it('higher score wins when the timer expires', async () => {
    const finishes: CrownRushFinishResult[] = [];
    const { runner } = makeRunner({ durationMs: 100, onFinish: (r) => finishes.push(r) });
    runner.beginCountdown(1);
    await sleep(20);
    runner.sim.players[0].score = 4;
    runner.sim.players[1].score = 2;
    runner.tickForTest(150);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.winnerPlayerId, 'player-a');
    assert.equal(runner.pendingTimers, 0);
  });

  it('a tied timer enters sudden death and the golden crown decides it', async () => {
    const finishes: CrownRushFinishResult[] = [];
    const { runner } = makeRunner({ durationMs: 100, onFinish: (r) => finishes.push(r) });
    runner.beginCountdown(1);
    await sleep(20);
    runner.sim.players[0].score = 5;
    runner.sim.players[1].score = 5;
    runner.tickForTest(150);
    assert.equal(finishes.length, 0);
    assert.equal(runner.status, 'suddenDeath');
    assert.equal(runner.sim.crown?.golden, true);
    // First golden capture wins immediately.
    runner.sim.crown = { x: runner.sim.players[1].x + 5, y: runner.sim.players[1].y, golden: true };
    runner.tickForTest(33);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.winnerPlayerId, 'player-b');
    assert.equal(runner.pendingTimers, 0);
  });

  it('sudden-death failsafe relocates the golden crown instead of drawing', async () => {
    const finishes: CrownRushFinishResult[] = [];
    const { runner } = makeRunner({
      durationMs: 60,
      suddenDeathFailsafeMs: 25,
      onFinish: (r) => finishes.push(r),
    });
    runner.beginCountdown(1);
    await sleep(20);
    runner.sim.players[0].score = 3;
    runner.sim.players[1].score = 3;
    runner.tickForTest(100); // time expires -> sudden death
    assert.equal(runner.status, 'suddenDeath');
    const first = { ...runner.sim.crown! };
    await sleep(60); // failsafe fires at least once
    assert.equal(finishes.length, 0);
    assert.equal(runner.status, 'suddenDeath');
    assert.equal(runner.sim.crown?.golden, true);
    const moved = Math.hypot(runner.sim.crown!.x - first.x, runner.sim.crown!.y - first.y);
    assert.ok(moved > 0);
    runner.destroy();
  });
});

describe('CrownRushRunner cleanup', () => {
  it('destroy() stops the loop and never settles (no onFinish)', async () => {
    const finishes: CrownRushFinishResult[] = [];
    const { runner } = makeRunner({ onFinish: (r) => finishes.push(r) });
    runner.beginCountdown(1);
    await sleep(20);
    assert.ok(runner.pendingTimers > 0);
    runner.destroy();
    assert.equal(runner.pendingTimers, 0);
    assert.equal(finishes.length, 0);
  });

  it('destroy() during countdown prevents the match from starting', async () => {
    const { runner } = makeRunner();
    runner.beginCountdown(50);
    runner.destroy();
    await sleep(80);
    assert.equal(runner.status, 'finished');
    assert.equal(runner.sim.crown, null);
  });
});
