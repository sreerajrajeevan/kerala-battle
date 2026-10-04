#!/usr/bin/env node
/**
 * Task 11 load test: simultaneous Crown Rush server simulations (in-process).
 *
 *   node --import tsx load-tests/crownrush-load.mjs --matches 25 --seconds 30
 *
 * Spins up N real CrownRushRunner instances with a stubbed Socket.IO (the
 * runner only needs io.to(room).emit), feeds scripted inputs at 12Hz, and
 * measures event-loop lag throughout — the critical signal for the 30Hz
 * server tick + 12Hz snapshot loops. Reports lag p50/p95/max.
 */
import { argv } from 'node:process';

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const MATCHES = Number(arg('matches', '25'));
const SECONDS = Number(arg('seconds', '30'));

const { CrownRushRunner } = await import('../src/games/crown-rush/runner.ts');

// Stub: the runner only calls io.to(room).emit(...).
const stubIo = { to: () => ({ emit: () => {} }) };

const lagSamples = [];
let last = Date.now();
const lagTimer = setInterval(() => {
  const now = Date.now();
  lagSamples.push(Math.max(0, now - last - 500));
  last = now;
}, 500);

let finished = 0;
const runners = [];
for (let i = 0; i < MATCHES; i++) {
  const players = [
    { socketId: `cr-a-${i}`, playerId: `cr-a-${i}`, displayName: `CRA${i}` },
    { socketId: `cr-b-${i}`, playerId: `cr-b-${i}`, displayName: `CRB${i}` },
  ];
  const runner = new CrownRushRunner(stubIo, 'Ernakulam', players, {
    matchContext: {
      matchMode: 'casual',
      matchSource: 'direct-challenge',
      districts: ['Ernakulam', 'Kollam'],
      startedAtMs: Date.now(),
    },
    onFinish: () => {
      finished++;
    },
  });
  runners.push({ runner, players });
  runner.beginCountdown(500);
}

// Scripted inputs at 12Hz: both players chase the arena center.
const inputTimer = setInterval(() => {
  for (const { runner, players } of runners) {
    if (runner.status !== 'playing' && runner.status !== 'suddenDeath') continue;
    for (const p of players) {
      runner.handleInput(p.socketId, {
        matchId: runner.matchId,
        xAxis: Math.random() * 2 - 1,
        yAxis: Math.random() * 2 - 1,
        seq: 1,
      });
    }
  }
}, 83);

await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(inputTimer);
clearInterval(lagTimer);
for (const { runner } of runners) runner.destroy();

const sorted = [...lagSamples].sort((a, b) => a - b);
const pct = (p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
console.log(
  JSON.stringify(
    {
      event: 'load.crownrush_result',
      matches: MATCHES,
      seconds: SECONDS,
      matchesFinished: finished,
      eventLoopLagP50Ms: pct(50),
      eventLoopLagP95Ms: pct(95),
      eventLoopLagMaxMs: sorted.length ? sorted[sorted.length - 1] : 0,
      samples: sorted.length,
    },
    null,
    2,
  ),
);
process.exit(0);
