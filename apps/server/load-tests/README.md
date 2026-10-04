# Task 11 — load & latency test tooling

Node-based drivers (k6 is not installed here; these need nothing beyond
`npm ci`). **Never run these against the dev or production database.**
Always start a scratch server first:

```bash
# Terminal 1: scratch server with an isolated database
DB_PATH=/tmp/kb-load.db PORT=3101 AUTH_REQUIRED=false \
  INTERNAL_METRICS_TOKEN=load-secret \
  node --import tsx apps/server/src/index.ts

# Terminal 2: run the tests (from the repo root)
```

| Command | What it measures |
|---|---|
| `npm run load:http --workspace=@kerala-battle/server -- --url http://127.0.0.1:3101 --rps 50 --duration 20` | HTTP req/s, p50/p95/p99, error % on `/health`, `/api/competition/current`, `/api/leaderboards/*` |
| `npm run load:socket --workspace=@kerala-battle/server -- --clients 250 --duration 60` | Concurrent lobby sockets across all 14 districts, ~10Hz movement; connect success %, hello round-trip p50/p95/p99, disconnects |
| `npm run load:queue --workspace=@kerala-battle/server -- --clients 120 --duration 60` | Ranked queue matching: matches formed, duplicate matchIds, same-district violations (must be 0), match-wait p50/p95 |
| `npm run load:settle --workspace=@kerala-battle/server -- --settlements 2000` | In-process ranked settlements against a **temp** DB: settlements/sec, leaderboard query ms, idempotency spot-check |
| `npm run load:crownrush --workspace=@kerala-battle/server -- --matches 25 --seconds 30` | N simultaneous Crown Rush simulations in-process; event-loop lag p50/p95/max (the 30Hz tick signal) |
| `npm run load:leak --workspace=@kerala-battle/server -- --cycles 300` | connect→join→queue→cancel→disconnect cycles; `/internal/metrics` before/after — maps must return near baseline |
| `npm run load:latency --workspace=@kerala-battle/server` | Precision Clash 250ms-delay tap disadvantage; Crown Rush delayed-input snapshot jumps |

Notes:

- `load:settle` and `load:crownrush` import TypeScript directly, so they run
  with `node --import tsx` (the npm scripts already do this).
- `load:leak` needs `INTERNAL_METRICS_TOKEN` set on the scratch server and in
  the test's environment.
- These are **not** unit tests: they live in `load-tests/` and never run in CI.
- Do not hammer Google or LiveKit: no test touches external auth/voice APIs.
- Suggested socket stages: `--clients 50`, `100`, `250`, `500` — record each
  in `LOAD_TEST_REPORT.md`.
