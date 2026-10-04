#!/usr/bin/env node
/**
 * Task 11 load test: concurrent Socket.IO social-lobby clients.
 *
 *   node load-tests/socket-load.mjs --url http://127.0.0.1:3101 --clients 250 --duration 60
 *
 * Each client connects, joins a district (round-robin across all 14), and
 * sends movement at a realistic ~10Hz with small random walks. Measures:
 * connection success rate, hello round-trip latency, disconnect rate.
 *
 * Movement is deliberately modest: this tests lobby presence/broadcast
 * stability, not input spam.
 */
import { argv } from 'node:process';
import { io } from 'socket.io-client';

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const URL = arg('url', 'http://127.0.0.1:3101');
const CLIENTS = Number(arg('clients', '100'));
const DURATION_S = Number(arg('duration', '60'));

const DISTRICTS = [
  'Thiruvananthapuram', 'Kollam', 'Pathanamthitta', 'Alappuzha', 'Kottayam',
  'Idukki', 'Ernakulam', 'Thrissur', 'Palakkad', 'Malappuram',
  'Kozhikode', 'Wayanad', 'Kannur', 'Kasaragod',
];

let connected = 0;
let connectFailed = 0;
let disconnected = 0;
const helloLat = [];

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function runClient(id) {
  const socket = io(URL, { transports: ['websocket'], reconnection: false });
  const district = DISTRICTS[id % DISTRICTS.length];
  let x = 100 + Math.random() * 800;
  let y = 100 + Math.random() * 500;

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      connectFailed++;
      socket.close();
      resolve();
    }, 10000);
    socket.on('connect', () => {
      clearTimeout(timer);
      connected++;
      const t0 = Date.now();
      socket.emit('client:hello', { timestamp: t0 });
      socket.on('server:welcome', () => helloLat.push(Date.now() - t0));
      socket.emit('player:join-district', {
        playerId: `load-${id}`,
        displayName: `Load ${id}`,
        district,
      });
      resolve();
    });
    socket.on('connect_error', () => {
      clearTimeout(timer);
      connectFailed++;
      resolve();
    });
  });

  if (!socket.connected) return;

  socket.on('disconnect', () => {
    disconnected++;
  });

  const endAt = Date.now() + DURATION_S * 1000;
  const mover = setInterval(() => {
    if (Date.now() >= endAt || !socket.connected) {
      clearInterval(mover);
      return;
    }
    // Small random walk at ~10Hz (realistic lobby movement).
    x = Math.min(1000, Math.max(0, x + (Math.random() - 0.5) * 60));
    y = Math.min(700, Math.max(0, y + (Math.random() - 0.5) * 60));
    socket.emit('player:move', { x: Math.round(x), y: Math.round(y) });
  }, 100);

  await new Promise((r) => setTimeout(r, DURATION_S * 1000 + 500));
  clearInterval(mover);
  socket.close();
}

const startedAt = Date.now();
// Stagger connects slightly (50ms apart) to avoid a thundering herd that
// would not resemble real beta traffic.
for (let i = 0; i < CLIENTS; i++) {
  void runClient(i);
  await new Promise((r) => setTimeout(r, 50));
}
// Wait for the run to finish.
await new Promise((r) => setTimeout(r, DURATION_S * 1000 + 15000));

const sorted = [...helloLat].sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      event: 'load.socket_result',
      clients: CLIENTS,
      durationS: DURATION_S,
      connected,
      connectFailed,
      connectSuccessPct: Math.round((connected / CLIENTS) * 1000) / 10,
      disconnected,
      helloRoundTripP50Ms: percentile(sorted, 50),
      helloRoundTripP95Ms: percentile(sorted, 95),
      helloRoundTripP99Ms: percentile(sorted, 99),
      elapsedS: Math.round((Date.now() - startedAt) / 1000),
    },
    null,
    2,
  ),
);
