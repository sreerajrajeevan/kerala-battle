# Kerala Battle — Load Test Report (Task 11)

All results below are **measured**, not estimated. Anything not measured is
marked UNVERIFIED.

## Environment

- Machine: 2 vCPU, ~8 GB RAM (shared sandbox VM; load generator and server
  on the same box unless noted)
- Node.js v24.20.0, `node --import tsx` (dev-mode server)
- Server: scratch instance, `DB_PATH=/tmp/kb-load.db`, `AUTH_REQUIRED=false`,
  voice disabled, `INTERNAL_METRICS_TOKEN` set
- Commit: Task 11 working tree (post Task 10 push `8066991`)

> Production will run the compiled `dist/` build inside Docker; tsx adds
> overhead, so these numbers are conservative for CPU but optimistic for
> memory (no container limits were applied).

## 1. HTTP load (`load-tests/http-load.mjs`)

Read-only endpoints: `/health`, `/api/competition/current`,
`/api/leaderboards/districts`, `/api/leaderboards/players`.

| Target | Requests | req/s | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|---|
| 50 rps × 20s | 991 | 49.3 | 2ms | 4ms | 7ms | 0% |

Leaderboard query timings (server-side, from `/internal/metrics`):
districts avg 0.29ms (max 4ms), players avg 0.15ms (max 2ms).

## 2. Socket / social-lobby load (`load-tests/socket-load.mjs`)

Clients connect, join a district (round-robin across all 14), send movement
at ~10Hz with small random walks, for 45s.

| Clients | Connected | Success | hello RTT p50/p95/p99 | Notes |
|---|---|---|---|---|
| 250 | 250/250 | 100% | 1ms / 5ms / 10ms | stable |
| 500 | 363/500 | 72.6% | 1ms / 291ms / 642ms | degraded |

During the 500-client run the server's event-loop lag (rolling 2-min window)
hit p95 **271ms**, max **852ms**; 137 clients failed to connect within the
10s handshake timeout. Heap stayed modest (41MB); RSS 227MB (includes tsx).

Interpretation: on this 2-vCPU box with the generator on the same machine,
**250 concurrent lobby sockets are stable; 500 are not**. The bottleneck was
not isolated (shared CPU between generator and server), so the true server
ceiling on a dedicated host is unknown — but the beta cap below stays well
under the measured stable point.

## 3. Ranked queue (`load-tests/queue-load.mjs`)

120 clients across 14 districts, 45s; on match-found they return to the
lobby and re-queue (matching throughput, not gameplay).

- Unique matches formed: **600** (1200 matched events = both sides notified)
- Duplicate matchIds: **0**
- Same-district pairs: **0** (restriction holds under load)
- Queue errors: **0**
- Match-wait latency: p50 1ms, p95 23ms

Bug found & fixed during this test: returning to the lobby during the 1.5s
match-found intro previously let the server ghost-start the match anyway
(the client showed the lobby while the server marked them in-match). The
return-lobby handler now cancels the pending intro via the matchmaker.
After the fix the intro-abort + requeue flow is clean (0 errors above).

## 4. Competition settlement (`load-tests/settle-load.mjs`)

2000 synthetic ranked settlements against an isolated temp DB using the real
`settleRankedMatch` + leaderboard code:

- **2304 settlements/sec**
- Players leaderboard (50 rows): 45ms; districts leaderboard: 7ms
- Idempotency spot-check: re-settling the same matchId did not double-count

Settlement is not the bottleneck: even a pathological burst of ranked
finishes settles in well under a second.

## 5. Crown Rush simultaneous matches (`load-tests/crownrush-load.mjs`)

Real `CrownRushRunner` instances in-process (stubbed Socket.IO), scripted
12Hz inputs, 25s runs. The 30Hz tick + 12Hz snapshot loops are the concern.

| Matches | Event-loop lag p50 | p95 | max |
|---|---|---|---|
| 25 | 0ms | 1ms | 1ms |
| 50 | 0ms | 1ms | 2ms |
| 100 | 0ms | 1ms | 1ms |

No knee found up to 100 simultaneous matches: the simulation is pure math
and very cheap. (Matches did not finish inside the 25–30s windows — Crown
Rush is first-to-7 / 45s + sudden death — but the tick stability signal is
what matters here.)

## 6. Lifecycle memory leak (`load-tests/leak-load.mjs`)

300 cycles of connect → join district → join queue → cancel → disconnect,
sampling `/internal/metrics` before/after.

Methodology note: the first run was **invalid** — the test client used
`Kochi`, which is not one of the 14 `KeralaDistrict` names (the district is
`Ernakulam`), so all joins were server-rejected and the test measured
nothing. The server correctly rejected them (`socket.invalid_join` in the
logs). Re-ran with the valid district name; results below are from the
valid run.

300/300 cycles completed on the valid run. Full before/after gauge table
from the measured re-run:

| Gauge | Before | After |
|---|---|---|
| sockets.connected | 0 | 1* |
| queue.ranked.size | 0 | 0 |
| matches.active | 0 | 0 |
| challenges.pending | 0 | 0 |
| memory.rssMB | 88.3 | 87.3 |
| memory.heapUsedMB | 23.9 | 25.8 (+1.9MB over 300 cycles — noise) |

\* The single lingering "connected" socket was an engine.io half-closed
transport, not a leaked player: server logs show 728 `socket.connected`
events and 728 matching `socket.disconnected` events, with zero players
left in any district. The gauge now tracks our own connect/disconnect
counter instead of `io.engine.clientsCount` to avoid this artifact.

**No leaks detected**: socket maps, queue entries, challenge records and
match maps all returned to baseline.

## 7. Event-loop lag under lobby load

Covered in §2: idle p50 1ms / p95 1ms / max 2ms; 250-client run p95 6ms /
max 30ms; 500-client run p95 271ms / max 852ms.

## 8. Latency probes (`load-tests/latency-probe.mjs`)

Measured live against the scratch server (client-side packet delays, which
are equivalent for server-receive-time mechanics).

**Precision Clash** — both players tapped at the same wall-clock instant
(round start + 800ms); one packet held back 250ms:

- Immediate player: round score **0**
- 250ms-delayed player: round score **63**

The same tap intent produced a **63-point swing** from 250ms of latency.
This confirms the known design property: scoring uses server receive time
(cheat-resistant), so a player's score depends on their latency phase within
the 1600ms marker cycle. The *direction* of the disadvantage varies with
cycle phase, but the *magnitude* (~60 points on a 0–100 scale) is meaningful
unfairness between a fiber player and a 250ms player. Documented as a known
limitation; a redesign (e.g. latency-compensated scoring) is explicitly out
of scope for Task 11 unless beta device testing proves it unusable.

**Crown Rush** — one player's inputs delayed 250ms for 20s of play:

- Snapshot position jumps (per 12Hz snapshot): p50 0u, p95 25u, max 26u —
  identical for the immediate and delayed player.

The server never rubber-bands itself: it simply applies late inputs to the
authoritative sim, so snapshots stay smooth. The cost of 250ms delay is
input→response lag for that player (their avatar reacts a quarter-second
late), inherent to the server-authoritative design — authority was not
weakened. Client-side prediction/reconciliation feel under real network
conditions is UNVERIFIED (needs the device test plan).

## 9. Network resilience

Simulated 100/200/300ms latency and packet loss: **not tested** — no `tc`
or equivalent shaping tool in this environment. The client-delay probes in
§8 are the closest equivalent for server-receive-time mechanics.
Interpolation/reconciliation behavior under real network conditions is
UNVERIFIED and belongs in the device test plan (`BETA_TEST_CHECKLIST.md`).

## 10. Recommended conservative beta capacity

Based strictly on measured results on the 2-vCPU test box:

- **Max connected users: 150** (comfortable margin under the stable 250).
- **Max simultaneous Crown Rush matches: 50** (no degradation measured up
  to 100; 50 keeps 2× headroom).
- Ranked settlement: no practical limit (2300+/s).
- Revisit after production telemetry (`/internal/metrics` event-loop lag
  p95 should stay under ~50ms in steady state).

If the production host is weaker than the test box, or the generator-shared
CPU materially flattered these numbers, treat capacity as unknown and
re-measure in place.

## 11. Real-world tests actually performed

- Real Google login: **UNVERIFIED** (no OAuth credentials in test env).
- Real LiveKit two-device voice: **UNVERIFIED** (no credentials/devices).
- Mobile devices: **UNVERIFIED**.
- Docker image build/run: **UNVERIFIED** — no container tooling in this
  environment (Dockerfile + compose provided; CI builds the image).
- SQLite durability: **verified** — wrote 6 player rows, stopped the server
  (SIGTERM → graceful shutdown), restarted on the same DB file, all rows
  byte-identical.
- Backup/restore: **verified** on scratch DBs (backup → modify → restore →
  integrity ok; retention keeps latest 14; `--force` refusal works).
- Graceful shutdown: **verified** (SIGTERM → shutdown_start →
  shutdown_complete in logs; no ranked points for aborted matches by design).

## 12. Dependency / security audit

- `npm audit` could not run here: the sandbox registry proxy denies the
  audit endpoint (403 `policy_denied`). An informational
  `npm audit --omit=dev --audit-level=high` step was added to CI instead;
  findings must be reviewed per `SECURITY_REVIEW.md` before beta.
- Pre-beta security review: `SECURITY_REVIEW.md` (sessions, CSRF/CORS,
  Socket.IO auth, Google verification, LiveKit secrets, report inputs,
  parameterized SQL, rate limits, no `dangerouslySetInnerHTML`).

## 13. Test commands (quality gates)

- `npm run build` — pass
- `npm run lint` — (run at gate time)
- `npm run typecheck` — pass (server + web)
- Server tests: 193/193 pass · Web tests: 16/16 pass
- Existing Tasks 1–10 regression: no test weakened; all green.
