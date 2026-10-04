#!/usr/bin/env node
/**
 * Task 11: latency probes for the two game types.
 *
 *   node load-tests/latency-probe.mjs --url http://127.0.0.1:3101
 *
 * Precision Clash: two clients challenge each other; both tap at the same
 * wall-clock instant, but client B's tap packet is held back 250ms to
 * simulate a high-latency player. Compares round scores — the game scores by
 * SERVER RECEIVE TIME, so this quantifies the latency disadvantage.
 *
 * Crown Rush: two clients play with B's inputs delayed 250ms; measures the
 * delayed player's snapshot-to-snapshot position jumps (rubber-banding
 * indicator). The server stays authoritative throughout.
 *
 * No external network shaping is used; delays are applied in the test
 * clients, which is equivalent for server-receive-time mechanics.
 */
import { argv } from 'node:process';
import { io } from 'socket.io-client';

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const URL = arg('url', 'http://127.0.0.1:3101');
const DELAY_MS = 250;

function connect(id, district) {
  return new Promise((resolve) => {
    const socket = io(URL, { transports: ['websocket'], reconnection: false });
    socket.on('connect', () => {
      socket.emit('player:join-district', {
        playerId: `lat-${id}`,
        displayName: `Lat ${id}`,
        district,
      });
      setTimeout(() => resolve(socket), 800);
    });
  });
}

async function precisionClashProbe() {
  const a = await connect('pc-a', 'Ernakulam');
  const b = await connect('pc-b', 'Ernakulam');
  const results = await new Promise((resolve) => {
    const scores = {};
    let challengeId = null;
    b.on('challenge:received', (p) => {
      challengeId = p.challengeId;
      b.emit('challenge:accept', { challengeId });
    });
    const onRound = (payload) => {
      if (payload.round !== 1) return;
      const targetAt = payload.roundStartTime + 800; // same instant for both
      const waitA = Math.max(0, targetAt - Date.now());
      setTimeout(() => a.emit('game:tap', { matchId: payload.matchId, round: 1 }), waitA);
      // B taps at the same wall-clock instant, but the packet is delayed.
      setTimeout(
        () => b.emit('game:tap', { matchId: payload.matchId, round: 1 }),
        waitA + DELAY_MS,
      );
    };
    a.on('round:started', onRound);
    const onResult = (payload) => {
      if (payload.round !== 1) return;
      for (const r of payload.results) scores[r.playerId] = r.score;
      a.emit('game:return-lobby', { matchId: payload.matchId });
      b.emit('game:return-lobby', { matchId: payload.matchId });
      resolve(scores);
    };
    a.on('round:result', onResult);
    setTimeout(() => resolve(scores), 25000);
    a.emit('challenge:send', { targetPlayerId: 'lat-pc-b', gameType: 'precision-clash' });
    void challengeId;
  });
  a.close();
  b.close();
  return {
    playerAImmediate: results['lat-pc-a'] ?? null,
    playerBDelayed250ms: results['lat-pc-b'] ?? null,
  };
}

async function crownRushProbe() {
  const a = await connect('cr-a', 'Ernakulam');
  const b = await connect('cr-b', 'Ernakulam');
  const jumps = { a: [], b: [] };
  const last = {};
  return new Promise((resolve) => {
    let matchId = null;
    const onState = (who) => (payload) => {
      if (payload.matchId !== matchId) return;
      for (const p of payload.players) {
        const key = `${who}:${p.playerId}`;
        if (last[key]) {
          const dx = p.x - last[key].x;
          const dy = p.y - last[key].y;
          jumps[who].push(Math.hypot(dx, dy));
        }
        last[key] = { x: p.x, y: p.y };
      }
    };
    a.on('crown-rush:state', onState('a'));
    b.on('crown-rush:state', onState('b'));
    b.on('challenge:received', (p) => b.emit('challenge:accept', { challengeId: p.challengeId }));
    const onStart = (payload) => {
      matchId = payload.matchId;
    };
    a.on('crown-rush:started', onStart);
    // Inputs: A immediate, B delayed 250ms, both drive toward +x.
    const inputTimer = setInterval(() => {
      if (!matchId) return;
      a.emit('crown-rush:input', { matchId, xAxis: 1, yAxis: 0, seq: 1 });
      setTimeout(() => {
        if (b.connected) b.emit('crown-rush:input', { matchId, xAxis: 1, yAxis: 0, seq: 1 });
      }, DELAY_MS);
    }, 100);
    setTimeout(() => {
      clearInterval(inputTimer);
      a.emit('game:return-lobby', { matchId });
      b.emit('game:return-lobby', { matchId });
      const summary = (arr) => {
        const s = [...arr].sort((x, y) => x - y);
        return {
          snapshots: s.length,
          p50: s.length ? s[Math.floor(s.length * 0.5)] : 0,
          p95: s.length ? s[Math.floor(s.length * 0.95)] : 0,
          max: s.length ? s[s.length - 1] : 0,
        };
      };
      a.close();
      b.close();
      resolve({ immediatePlayerJumps: summary(jumps.a), delayedPlayerJumps: summary(jumps.b) });
    }, 20000);
    a.emit('challenge:send', { targetPlayerId: 'lat-cr-b', gameType: 'crown-rush' });
  });
}

console.log('precision-clash:', JSON.stringify(await precisionClashProbe()));
console.log('crown-rush:', JSON.stringify(await crownRushProbe()));
process.exit(0);
