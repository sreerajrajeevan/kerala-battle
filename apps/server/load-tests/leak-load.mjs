#!/usr/bin/env node
/**
 * Task 11 load test: lifecycle memory-leak check.
 *
 *   INTERNAL_METRICS_TOKEN=secret node load-tests/leak-load.mjs --url http://127.0.0.1:3101 --cycles 300
 *
 * Repeats connect -> join district -> join queue -> cancel -> disconnect
 * cycles and samples GET /internal/metrics (bearer token) before and after.
 * Socket maps, queue entries, challenge records and match maps should
 * return near baseline after cleanup.
 */
import { argv } from 'node:process';
import { io } from 'socket.io-client';

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const URL = arg('url', 'http://127.0.0.1:3101');
const CYCLES = Number(arg('cycles', '300'));
const TOKEN = process.env.INTERNAL_METRICS_TOKEN ?? '';

async function sampleMetrics() {
  const res = await fetch(URL + '/internal/metrics', {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`metrics returned ${res.status}`);
  return res.json();
}

async function oneCycle(id) {
  const socket = io(URL, { transports: ['websocket'], reconnection: false });
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 5000);
    socket.on('connect', () => {
      clearTimeout(t);
      resolve();
    });
    socket.on('connect_error', () => {
      clearTimeout(t);
      resolve();
    });
  });
  if (!socket.connected) return false;
  socket.emit('player:join-district', {
    playerId: `leak-${id}`,
    displayName: `Leak ${id}`,
    district: 'Ernakulam',
  });
  await new Promise((r) => setTimeout(r, 120));
  socket.emit('ranked-queue:join', {});
  await new Promise((r) => setTimeout(r, 400));
  socket.emit('ranked-queue:cancel', {});
  await new Promise((r) => setTimeout(r, 120));
  socket.close();
  await new Promise((r) => setTimeout(r, 120));
  return true;
}

const before = await sampleMetrics();
let completed = 0;
for (let i = 0; i < CYCLES; i++) {
  if (await oneCycle(i)) completed++;
  if (i % 50 === 0) process.stdout.write(`\r${i}/${CYCLES}`);
}
process.stdout.write('\n');
// Let any trailing cleanup settle.
await new Promise((r) => setTimeout(r, 3000));
const after = await sampleMetrics();

function pick(snap, key) {
  return snap.gauges[key] ?? snap.counters[key] ?? null;
}

const keys = [
  'sockets.connected',
  'queue.ranked.size',
  'matches.active',
  'challenges.pending',
  'memory.rssMB',
  'memory.heapUsedMB',
];
const delta = {};
for (const k of keys) delta[k] = { before: pick(before, k), after: pick(after, k) };

console.log(
  JSON.stringify({ event: 'load.leak_result', cycles: CYCLES, completed, delta }, null, 2),
);
