# Kerala Battle — Pre-Beta Security Check (Task 11)

Reviewed 2026-10-04 against the Task 10 + Task 11 codebase. Method: code
review of the auth, session, socket, moderation, competition, and HTTP
layers, plus live verification of headers and the metrics endpoint on a
scratch server.

## Findings

### Session cookies — OK
- Opaque 32-byte token; only a peppered SHA-256 is stored server-side.
- Cookie flags: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production.
- 30-day TTL; expired/revoked sessions do not authenticate; logout revokes.
- Never in `localStorage`; never logged (logger has no secret fields).

### Origin / CSRF — OK
- Credentialed CORS uses an explicit origin list (`WEB_URLS`/`WEB_URL`),
  never `*`. Production refuses to start with localhost origins.
- Cookie-authenticated state changes additionally validate
  `Origin`/`Referer` (`requireSameOrigin` in auth + safety routes).

### Socket.IO auth — OK
- Handshake resolves the session cookie once per connection; the canonical
  `{userId, playerId}` is stored server-side. Client-sent playerId/display
  name are ignored when auth is required (live-tested in Task 10).
- Maintenance/shutdown rejects new handshakes with a clear reason.

### Google token verification — OK
- `google-auth-library` `verifyIdToken`: signature, issuer, audience
  (`GOOGLE_CLIENT_ID`), expiry. Client-sent email/name are never trusted.
- Missing `GOOGLE_CLIENT_ID` → `/api/auth/google` answers 503.
- Production with `AUTH_REQUIRED=true` and no client ID **fails fast**
  (new in Task 11).

### LiveKit secrets — OK
- `LIVEKIT_API_SECRET` is only read server-side for token minting; the
  browser receives a scoped token (one district room) and the public URL.
- Partial LiveKit config in production fails fast (all three vars or none).

### Report / block inputs — OK
- Report reasons are an allowlist; description capped at 500 chars
  (rejected, not truncated); context types allowlisted; ranked-match context
  must reference a real settled match the reporter played.
- 10/hour/account + 10-minute dedup; blocks are directional with a unique
  pair constraint; self-block/self-report rejected.

### SQL — OK
- All queries use parameterized prepared statements (`node:sqlite`).
- No `${...}` interpolation into SQL strings anywhere in server code.
- `ORDER BY` clauses use fixed column names; week IDs are regex-validated
  (`/^\d{4}-W\d{1,2}$/`) before use.

### Rate limits — OK
- In-memory fixed-window limits on: Google auth attempts (10/min/IP),
  voice tokens (10/min/player), reports (10/hour/player), challenge sends
  (20/min/player), ranked queue joins (10/min/player), renames (5/min),
  block ops (20/min). Movement and match input are never limited.
- Single-instance note: limits are per-process, which is correct for the
  one-instance beta; they would need Redis if multi-instance ever happens.

### Rendering user text — OK
- No `dangerouslySetInnerHTML` anywhere in the web client. Display names
  are validated server-side (2–20 chars, bidi overrides rejected) and
  rendered as React text.

### New Task 11 surface
- `GET /internal/metrics`: bearer-token protected; **404 when no
  `INTERNAL_METRICS_TOKEN` is configured** (verified live: 401 without
  token). Contains aggregate counts/timings only — no player names.
- Security headers on all responses: `nosniff`, `SAMEORIGIN` framing,
  `strict-origin-when-cross-origin` referrer, microphone-only
  permissions policy. CSP is applied when serving the production SPA and
  explicitly allows Google Identity Services
  (`accounts.google.com` script/frame/connect), WebRTC/LiveKit (`wss:`),
  and Socket.IO — review before tightening further.
- Production env validation fails fast on: missing session secret,
  missing Google client ID when auth required, partial LiveKit config,
  localhost web origins.

## Residual risks (accepted for beta)

1. **Single secret for sessions** (`SESSION_COOKIE_SECRET`): rotation would
   invalidate all sessions. Acceptable for beta; document rotation as
   "change the secret, users re-login".
2. **In-memory rate limits**: correct for one instance; revisit if the
   architecture ever goes multi-instance.
3. **No WAF / DDoS protection**: the beta relies on the hosting platform.
4. **Dependency audit**: see `npm audit` notes in `LOAD_TEST_REPORT.md` §—
   recorded separately; no critical production findings at Task 11 time.
