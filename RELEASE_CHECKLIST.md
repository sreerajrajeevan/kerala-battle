# Kerala Battle — Release Checklist (Task 11)

Copy this for every beta release. All boxes must be checked before traffic.

## Pre-release

- [ ] Git working tree clean (`git status`), release commit tagged
- [ ] `npm run lint` green
- [ ] `npm run typecheck` green
- [ ] `npm run build` green
- [ ] Server tests green (`npm run test --workspace=@kerala-battle/server`)
- [ ] Web tests green (`npm run test --workspace=@kerala-battle/web`)
- [ ] CI green on the release commit

## Data safety

- [ ] **Backup completed**: `npm run db:backup` (record path below)
- [ ] Migration diff reviewed (additive? destructive?)
- [ ] Rollback version known (previous image tag): `kerala-battle:_____`

## Build & config

- [ ] Docker image built with version metadata:
  `docker build --build-arg APP_VERSION=x.y.z --build-arg GIT_COMMIT=<sha> -t kerala-battle:x.y.z .`
- [ ] `.env.production` validated (see `DEPLOYMENT.md` §7):
  `WEB_URLS`, `SESSION_COOKIE_SECRET`, `AUTH_REQUIRED=true`,
  `GOOGLE_CLIENT_ID`, LiveKit vars (all or none), `DATA_DIR`,
  `INTERNAL_METRICS_TOKEN`
- [ ] Google OAuth: production domain in authorized JavaScript origins
- [ ] LiveKit: URL/key/secret set, `wss://` reachable from browsers
- [ ] HTTPS working on the public domain (cookies are `Secure` in prod)

## Post-deploy smoke tests

- [ ] `GET /health` → `{ "status": "ok" }`
- [ ] `GET /ready` → `{ "status": "ready" }`
- [ ] `GET /api/version` shows the new version + git commit
- [ ] Frontend loads at `/`; `/competition` deep-link returns the SPA
- [ ] Socket.IO connects (lobby shows, district population updates)
- [ ] Google sign-in works (or the configured "not configured" state)
- [ ] Ranked queue pairs two test accounts cross-district
- [ ] Leaderboards load; history loads
- [ ] `/internal/metrics` requires the bearer token (401 without it)

## Rollback readiness

- [ ] Previous image tag recorded above and still available
- [ ] Pre-deployment backup path recorded: `____________________`
- [ ] Rollback policy understood (`DEPLOYMENT.md` §12)

## Sign-off

- Release version: ___________
- Deployed by: ___________
- Date/time (IST): ___________
