# Kerala Battle — Production Deployment Guide (Task 11)

## 1. Architecture decision

The beta runs as **one application server instance**:

| Layer | Choice |
|---|---|
| Frontend | React + Vite (production build, served by Express) |
| Backend | Node.js + Express + Socket.IO |
| Database | SQLite (`node:sqlite`, WAL mode) |
| Voice | LiveKit (external SFU; server issues scoped tokens) |
| Auth | Google Identity Services (GIS) + server sessions |

**Single-instance constraint:** SQLite plus in-memory realtime state
(lobby presence, ranked queue, match engines, Socket.IO rooms) means exactly
**ONE active backend instance**. Do NOT configure horizontal autoscaling,
replicas, or a load balancer with multiple backends: two instances would
split lobby presence, double-run the ranked queue, and break match
ownership. Multi-instance support (Redis/shared state) is explicitly
out of scope for the beta and would be a future task.

We need real load measurements before any scaling decision — see
`LOAD_TEST_REPORT.md`.

## 2. What you need

- Docker + Docker Compose (or plain Node.js 22+ for non-container runs)
- A public HTTPS domain (beta requires HTTPS — see §9)
- Google OAuth client ID (see §10)
- LiveKit project (optional; voice degrades cleanly when absent — see §11)
- A persistent directory for SQLite (see §4)

## 3. Build & run

```bash
# Build the production image (version metadata baked in)
docker build \
  --build-arg APP_VERSION=0.2.0 \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  -t kerala-battle .

# Configure (copy the template, fill in REAL values — never commit them)
cp .env.production.example .env.production
$EDITOR .env.production

# Run (local production simulation)
docker compose up --build
```

The app is then at `http://localhost:3001` (or your `HOST_PORT`). One
container serves everything: the React SPA, `/api/*`, Socket.IO, and the
health/readiness endpoints. No second web server is needed.

Non-container run:

```bash
npm ci && npm run build
NODE_ENV=production PORT=3001 DATA_DIR=/var/lib/kerala-battle \
  WEB_URLS=https://battle.example.com \
  SESSION_COOKIE_SECRET=<random-32-bytes> AUTH_REQUIRED=true \
  GOOGLE_CLIENT_ID=<client-id> \
  node apps/server/dist/index.js
```

## 4. Persistent storage

The database file lives at **`$DATA_DIR/kerala-battle.db`**
(`DB_PATH` overrides the full path when set, e.g. for tests/dev).
In Docker, `/data` is a volume (`./data` on the host with compose).

Rules:

- **Never bake the database into the image** (`.dockerignore` excludes it).
- On startup the server verifies the data directory exists and is writable,
  runs pending migrations, and logs `database initialized` with the schema
  version and path. In production an unwritable directory is **fatal**.
- Migrations run once at startup and never delete data. Always
  **back up the database before deploying** (see §5).

## 5. Backup & restore

```bash
npm run db:backup                      # -> <backup-dir>/kerala-battle-<UTC>.db
npm run db:backup -- --keep 14         # retention: keep latest 14 (default)
npm run db:backup -- --dir /mnt/nas   # custom directory
```

Backups use SQLite `VACUUM INTO`: a transactionally consistent snapshot,
safe while the server is running. Recommended beta schedule: **daily**
(cron/systemd timer), plus a manual backup before every deployment.
Inside the container (no tsx), run the compiled script:
`node apps/server/dist/scripts/db-backup.js` with the same flags.

Restore (operator only, server **stopped**):

```bash
npm run db:restore -- <backup-file> --force
```

Safety: refuses without `--force`; refuses in `NODE_ENV=production`
unless `KERALA_BATTLE_I_UNDERSTAND=1` is set; validates the backup
(`PRAGMA integrity_check` + schema check); snapshots the current DB to the
backup dir as `pre-restore-<timestamp>.db` before replacing anything.
See `RELEASE_CHECKLIST.md` for the deployment-time procedure and
`ROLLBACK` (§12) for the restore policy.

## 6. Health, readiness, version, metrics

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness: `{ "status": "ok" }` |
| `GET /ready` | Readiness: 200 `{ "status": "ready", "schemaVersion": N }` or 503. Checks DB + migrations only — Google/LiveKit outages never make the app unready |
| `GET /api/version` | `{ version, gitCommit, environment, maintenance }` — no secrets |
| `GET /internal/metrics` | JSON counters/gauges/timings (connections, queue, matches, reports, voice failures, HTTP errors, event-loop lag, memory). Bearer-token protected via `INTERNAL_METRICS_TOKEN`; **404s when no token is configured** so it can never leak publicly. No player names or personal data |

## 7. Required / optional environment

Required in production (`NODE_ENV=production` fails fast otherwise):

| Var | Meaning |
|---|---|
| `WEB_URLS` | Public origin(s), comma-separated. Must not be localhost |
| `SESSION_COOKIE_SECRET` | Random 32+ byte secret for session signing |
| `GOOGLE_CLIENT_ID` | Required when `AUTH_REQUIRED=true` |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | All three together when voice is enabled, or none |
| `DATA_DIR` | Persistent directory (default `/data` in the image) |

Operational:

| Var | Default | Meaning |
|---|---|---|
| `AUTH_REQUIRED` | `false` | `true` in production: guests cannot play |
| `MAINTENANCE_MODE` | `false` | `true`: users see a maintenance notice; no new games/queues |
| `INTERNAL_METRICS_TOKEN` | unset | Bearer token for `/internal/metrics` |
| `LOG_LEVEL` | `info` (prod) | `debug`/`info`/`warn`/`error` |
| `BACKUP_DIR` | `<DATA_DIR>/backups` | Where `db:backup` writes |
| `SERVE_STATIC` | `true` (prod) | Serve the built React app from Express |
| `APP_VERSION`, `GIT_COMMIT` | build args | Shown by `/api/version` |

## 8. Startup & shutdown behavior

At startup the server logs (structured JSON, no secrets): app version, git
commit, `NODE_ENV`, port, auth mode, voice enabled/disabled, maintenance
mode, DB path, schema version, allowed origins.

On `SIGTERM`/`SIGINT` (e.g. `docker stop`):

1. stop accepting new HTTP requests;
2. block new queue joins, challenges, and matches;
3. notify browsers (`server:shutdown` → "restarting" notice, auto-reconnect);
4. clear game timers; abort in-flight matches **without awarding ranked points**
   (same rule as an opponent disconnect — see §13);
5. close Socket.IO, close the database, exit — bounded by a 10s timeout.

`uncaughtException` is logged and triggers the same shutdown (exit 1);
`unhandledRejection` is logged loudly.

## 9. HTTPS

Production **must** terminate HTTPS (reverse proxy / load balancer / platform).
Secure session cookies require it, and browsers only grant microphone
permission on secure origins (LiveKit voice needs this). `localhost` is fine
for development; the public beta requires HTTPS.

## 10. Google OAuth setup (beta)

1. Google Cloud Console → create an OAuth client ID (Web application).
2. Authorized JavaScript origins: `https://battle.example.com`
   (no redirect URIs needed — GIS uses ID tokens).
3. Set `GOOGLE_CLIENT_ID` to the client ID; set `AUTH_REQUIRED=true`.
4. The server verifies ID-token signature/issuer/audience/expiry with
   `google-auth-library`; the browser never sends email/name as identity.

## 11. LiveKit setup (beta)

1. LiveKit Cloud project (or self-hosted) → URL, API key, API secret.
2. Set `LIVEKIT_URL` (wss), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
3. Token flow: browser → `voice:token` over the authenticated socket →
   server mints a token scoped to `kerala-battle-district-<name>` →
   browser joins with the LiveKit client. The API secret never reaches the
   browser. Without credentials, `/api/voice/status` reports disabled and
   everything else works.

## 12. Rollback

- **Application:** redeploy the previous image tag
  (`kerala-battle:<previous-version>`). Keep the last known-good tag in
  `RELEASE_CHECKLIST.md` for every release.
- **Database:** there are no downgrade migrations. Policy:
  - If the migration is forward-compatible (additive), roll the application
    back and leave the database alone.
  - If the database must go back, restore the pre-deployment backup with
    `npm run db:restore -- <backup> --force` (the restore snapshots the
    current DB first, so the operation is reversible).

## 13. Shutdown match policy (beta)

If the server stops during active matches, incomplete matches are aborted
with **no ranked points awarded** — identical to an opponent disconnect.
Clients reconnect cleanly after restart and can re-queue. This is
deliberate: points are only ever awarded for finished, settled matches.

## 14. CI

`.github/workflows/ci.yml` runs on push/PR: `npm ci`, lint, typecheck,
build, server tests, web tests, and a production Docker image build. Tests
use `:memory:`/temp databases; no secrets required.

## 15. Single-instance protection checklist

Before any infra change, confirm:

- [ ] Exactly one backend container/instance is running.
- [ ] No autoscaling / replica count > 1 is configured.
- [ ] Sticky sessions are unnecessary (only one instance exists).
- [ ] Backups run daily and restore was tested (see `RELEASE_CHECKLIST.md`).
