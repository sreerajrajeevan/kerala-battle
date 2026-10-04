#!/usr/bin/env node
/**
 * Task 11 load test: HTTP endpoints.
 *
 *   node load-tests/http-load.mjs --url http://127.0.0.1:3101 --rps 50 --duration 20
 *
 * Hits read-only endpoints only (never Google/LiveKit):
 *   /health, /api/competition/current,
 *   /api/leaderboards/districts, /api/leaderboards/players
 * Reports requests/sec, p50/p95/p99 latency, error percentage.
 */
import { argv } from 'node:process';

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const BASE = (arg('url', 'http://127.0.0.1:3101') ?? '').replace(/\/$/, '');
const RPS = Number(arg('rps', '50'));
const DURATION_S = Number(arg('duration', '20'));
const PATHS = ['/health', '/api/competition/current', '/api/leaderboards/districts', '/api/leaderboards/players'];

const latencies = [];
let ok = 0;
let errors = 0;
let pathIndex = 0;

async function one() {
  const path = PATHS[pathIndex++ % PATHS.length];
  const start = Date.now();
  try {
    const res = await fetch(BASE + path);
    // Consume the body so the timing is honest.
    await res.text();
    if (res.ok) ok++;
    else errors++;
  } catch {
    errors++;
  }
  latencies.push(Date.now() - start);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const startedAt = Date.now();
const intervalMs = 1000 / RPS;
let inFlight = 0;
let stopped = false;

const timer = setInterval(() => {
  if (stopped) return;
  if (Date.now() - startedAt >= DURATION_S * 1000) {
    stopped = true;
    clearInterval(timer);
    // Drain in-flight requests before reporting.
    const wait = setInterval(() => {
      if (inFlight === 0) {
        clearInterval(wait);
        report();
      }
    }, 100);
    return;
  }
  inFlight++;
  void one().finally(() => inFlight--);
}, intervalMs);

function report() {
  const total = ok + errors;
  const elapsedS = (Date.now() - startedAt) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        event: 'load.http_result',
        url: BASE,
        targetRps: RPS,
        durationS: DURATION_S,
        requests: total,
        requestsPerSec: Math.round((total / elapsedS) * 10) / 10,
        ok,
        errors,
        errorPct: total ? Math.round((errors / total) * 1000) / 10 : 0,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
      },
      null,
      2,
    ),
  );
}
