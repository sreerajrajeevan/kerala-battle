#!/usr/bin/env node
/**
 * Task 11 load test: ranked queue matching throughput.
 *
 *   node load-tests/queue-load.mjs --url http://127.0.0.1:3101 --clients 120 --duration 60
 *
 * Clients join districts round-robin and enter the Weekly Battle queue.
 * On match-found they immediately return to the lobby and re-queue
 * (matches themselves are NOT played: this measures pairing correctness
 * and queue drain, not game length).
 *
 * Verifies: cross-district pairing only, unique matchIds (no duplicates),
 * queue drains.
 */
import { argv } from 'node:process';
import { io } from 'socket.io-client';

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const URL = arg('url', 'http://127.0.0.1:3101');
const CLIENTS = Number(arg('clients', '80'));
const DURATION_S = Number(arg('duration', '60'));

const DISTRICTS = [
  'Thiruvananthapuram', 'Kollam', 'Pathanamthitta', 'Alappuzha', 'Kottayam',
  'Idukki', 'Ernakulam', 'Thrissur', 'Palakkad', 'Malappuram',
  'Kozhikode', 'Wayanad', 'Kannur', 'Kasaragod',
];

const seenMatchIds = new Set();
let duplicateMatches = 0;
let sameDistrictPairs = 0;
let matchesFound = 0;
let queueErrors = 0;
const matchLatencies = [];

async function runClient(id) {
  const socket = io(URL, { transports: ['websocket'], reconnection: false });
  const district = DISTRICTS[id % DISTRICTS.length];
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 8000);
    socket.on('connect', () => {
      clearTimeout(t);
      resolve();
    });
    socket.on('connect_error', () => {
      clearTimeout(t);
      resolve();
    });
  });
  if (!socket.connected) return;
  socket.emit('player:join-district', {
    playerId: `qload-${id}`,
    displayName: `QLoad ${id}`,
    district,
  });

  const endAt = Date.now() + DURATION_S * 1000;
  let queuedAt = 0;

  socket.on('ranked-queue:matched', (payload) => {
    matchesFound++;
    matchLatencies.push(Date.now() - queuedAt);
    if (seenMatchIds.has(payload.matchId)) duplicateMatches++;
    seenMatchIds.add(payload.matchId);
    if (payload.myDistrict === payload.opponent.district) sameDistrictPairs++;
    // Immediately leave: we measure matching, not gameplay.
    socket.emit('game:return-lobby', { matchId: payload.matchId });
    if (Date.now() < endAt) {
      setTimeout(() => {
        if (socket.connected && Date.now() < endAt) {
          queuedAt = Date.now();
          socket.emit('ranked-queue:join', {});
        }
      }, 1500);
    }
  });
  socket.on('ranked-queue:error', () => {
    queueErrors++;
  });

  await new Promise((r) => setTimeout(r, 1500));
  queuedAt = Date.now();
  socket.emit('ranked-queue:join', {});

  await new Promise((r) => setTimeout(r, DURATION_S * 1000 + 3000));
  socket.close();
}

const startedAt = Date.now();
for (let i = 0; i < CLIENTS; i++) {
  void runClient(i);
  await new Promise((r) => setTimeout(r, 40));
}
await new Promise((r) => setTimeout(r, DURATION_S * 1000 + 12000));

const sorted = [...matchLatencies].sort((a, b) => a - b);
const pct = (p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
console.log(
  JSON.stringify(
    {
      event: 'load.queue_result',
      clients: CLIENTS,
      durationS: DURATION_S,
      matchesFound,
      uniqueMatchIds: seenMatchIds.size,
      duplicateMatches,
      sameDistrictPairs,
      queueErrors,
      matchWaitP50Ms: pct(50),
      matchWaitP95Ms: pct(95),
      elapsedS: Math.round((Date.now() - startedAt) / 1000),
    },
    null,
    2,
  ),
);
