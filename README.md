# Kerala Battle

Browser-based real-time multiplayer social game for Kerala.

This repo currently holds the Task 1 technical foundation: a React (Vite) frontend, an
Express + Socket.IO backend, and a shared TypeScript types package — all wired through npm
workspaces. No game features yet.

## Prerequisites

- Node.js 20+ and npm 10+

## Installation

```bash
npm install
```

## Development

```bash
npm run dev
```

This builds the shared package once, then starts both apps concurrently:

- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## Project structure

```text
kerala-battle/
├── apps/
│   ├── web/        # React + Vite frontend (port 5173)
│   └── server/     # Express + Socket.IO backend (port 3001)
├── packages/
│   └── shared/     # Shared TypeScript event/type definitions
├── package.json    # npm workspaces + root scripts
├── eslint.config.mjs
├── .prettierrc
├── .gitignore
└── README.md
```

## URLs

- Frontend: http://localhost:5173
- Backend: http://localhost:3001
- Health check: `GET http://localhost:3001/health` → `{ "status": "ok" }`

## Verifying the Socket.IO connection

1. Run `npm run dev`.
2. First visit shows an onboarding screen: enter a display name (2–20 chars) and pick one of
   Kerala's 14 districts, then `Enter Kerala Battle`.
3. The lobby shows your district hub: a shared 2D arena with live player avatars
   (name above each circle, deterministic color per player, local player highlighted).
   Move with WASD/arrow keys on desktop or the virtual joystick on touch devices.
4. Open a second browser/incognito window with another name in the same district — both
   windows update to `2 players online` automatically, and you can see each other move
   in real time.
5. `Change District` moves you to another district's room; counts update live on both sides.
6. Stop the backend and the arena shows `Reconnecting…` without losing your
   saved profile; reconnecting rejoins your district automatically.
7. Server logs show `connected: <socket id>` / `disconnected: <socket id> (<reason>)`, district
   joins/leaves with spawn positions, and the `player:join-district` → `district:population` /
   `district:players` / `player:moved` exchange.

## Precision Clash (first mini-game)

Click/tap another player's avatar in the district lobby to open their player card, then
`Challenge`. The target can Accept or Decline (challenges expire after ~15s). On accept,
both players enter a synchronized 3-2-1-GO countdown, then play 3 rounds: a marker sweeps
the bar and each player taps once per round to stop it as close to the center as possible
(0–100, center = 100). Scoring is server-authoritative — the client only sends the tap
instant; the server derives the marker position from its own clock. After round 3, totals
and the winner are shown, with Rematch / Return to Lobby options. Players in a match show
an `IN MATCH` badge and cannot be challenged.

## Configuration

Copy the examples and adjust as needed (development defaults work without any `.env` file):

- `apps/web/.env.example` → `apps/web/.env`
  - `VITE_SERVER_URL` (default `http://localhost:3001`)
- `apps/server/.env.example` → `apps/server/.env`
  - `PORT` (default `3001`)
  - `WEB_URL` (default `http://localhost:5173`, used for CORS)
  - `DB_PATH` (default `apps/server/data/kerala-battle.db`, the SQLite competition database)

## Weekly competition (persistent rankings)

Every legitimately completed Precision Clash match is settled server-side into a
SQLite database (`apps/server/data/kerala-battle.db`, git-ignored):

- Personal weekly points: win **12**, draw **8**, loss **5** (result + completion bonus).
- The winner's district earns district points, capped at **50 per player per day**
  (Asia/Kolkata). Personal points are never capped.
- Competition weeks run Monday 00:00 IST → Sunday 23:59:59 IST; all boundaries use
  the `Asia/Kolkata` timezone regardless of the server's local timezone.
- District attribution is historical: points stay with the district the player
  represented when the match finished, even if they switch districts later.
- Settlement is idempotent (unique `matchId`); disconnect forfeits and cancelled
  matches are never scored.

APIs: `GET /api/leaderboards/players?limit=50&playerId=…`,
`GET /api/leaderboards/districts`. After each settled match the server broadcasts
`competition:updated` and clients refetch. The lobby's 🏆 Competition button shows
district/player standings, your weekly stats, and a countdown to week end.

## Scripts (repo root)

- `npm run dev` — build shared types, then start web + server together
- `npm run build` — build shared → web → server (order matters: web/server resolve shared via its `dist`)
- `npm run lint` — ESLint across the repo
- `npm run typecheck` — `tsc --noEmit` in every workspace
- `npm run test --workspace=@kerala-battle/server` — build, then run the
  competition unit/integration tests (`node:test`, no extra framework)
- `npm run format` — Prettier write across the repo

Server-only helpers (`apps/server`):

- `npm run db:reset` — **development only**: deletes the local SQLite database file.
  Refuses to run with `NODE_ENV=production` unless `--force` is passed.
- `npm run db:seed` — **development only**: inserts clearly-labeled fake leaderboard
  data (`DevSeed …` players) for all 14 districts. Never runs automatically;
  also guarded against `NODE_ENV=production`.
