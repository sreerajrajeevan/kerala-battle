import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  AuthRequiredEvent,
  CHALLENGE_EXPIRY_MS,
  ChallengeAcceptEvent,
  ChallengeCancelledEvent,
  ChallengeDeclineEvent,
  ChallengeExpiredEvent,
  ChallengeFailedEvent,
  ChallengeReceivedEvent,
  ChallengeSendEvent,
  ChallengeWithdrawEvent,
  ClientHelloEvent,
  CompetitionUpdatedEvent,
  CompetitionWeekFinalizedEvent,
  CrownRushInputEvent,
  CrownRushStartedEvent,
  DistrictPlayersEvent,
  DistrictPopulationEvent,
  GAME_DEFINITIONS,
  GAME_TYPE_CROWN_RUSH,
  GAME_TYPE_PRECISION_CLASH,
  GameRematchCancelEvent,
  GameRematchEvent,
  GameReturnLobbyEvent,
  GameTapEvent,
  KERALA_DISTRICTS,
  LOBBY_HEIGHT,
  LOBBY_SPAWN_PADDING,
  LOBBY_WIDTH,
  MATCH_COUNTDOWN_MS,
  MATCH_MODE_CASUAL,
  MATCH_MODE_RANKED,
  MATCH_SOURCE_DIRECT_CHALLENGE,
  MATCH_TOTAL_ROUNDS,
  MatchFinishedEvent,
  MatchOpponentDisconnectedEvent,
  MatchStartedEvent,
  PlayerJoinDistrictEvent,
  PlayerMoveEvent,
  PlayerMovedEvent,
  ROUND_CYCLE_MS,
  ROUND_DURATION_MS,
  ROUND_PAUSE_MS,
  RankedQueueCancelEvent,
  RankedQueueJoinEvent,
  RematchCancelledEvent,
  RematchWaitingEvent,
  RoundResultEvent,
  RoundStartedEvent,
  RoundTapEvent,
  ServerWelcomeEvent,
  VoiceTokenEvent,
  isGameType,
  type ChallengeCancelledReason,
  type ChallengeFailedReason,
  type ClientHelloPayload,
  type ClientToServerEvents,
  type CompetitionHistoryPayload,
  type CrownRushStartedPayload,
  type CurrentCompetitionPayload,
  type DistrictPlayersPayload,
  type DistrictsLeaderboardPayload,
  type GameType,
  type HistoricalWeekDetail,
  type KeralaDistrict,
  type LobbyPlayer,
  type MatchContext,
  type MatchFinishedPayload,
  type MatchSettlementMap,
  type MatchStartedPayload,
  type PlayerJoinDistrictPayload,
  type PlayerMovePayload,
  type PlayerMovedPayload,
  type PlayersLeaderboardPayload,
  type RoundResultPayload,
  type RoundScoreEntry,
  type ServerToClientEvents,
  type ServerWelcomePayload,
  type VoiceTokenResponse,
} from '@kerala-battle/shared';
import { getDatabase } from './competition/db.js';
import {
  getDistrictLeaderboard,
  getMyWeeklyStats,
  getPlayerLeaderboard,
  settleRankedMatch,
  upsertPlayer,
  type RankedPlayerInput,
} from './competition/store.js';
import { getCompetitionDay, getCompetitionWeek } from './competition/week.js';
import { getOrCreateWeekConfig, type CompetitionWeekConfig } from './competition/featuredGame.js';
import {
  ensurePastWeeksFinalized,
  finalizeCompetitionWeek,
  getHistoryDetail,
  getHistorySummaries,
  getPreviousChampion,
  HISTORY_DEFAULT_LIMIT,
} from './competition/finalize.js';
import { validateRankedMatch } from './competition/rankedMatch.js';
import { RankedQueue } from './matchmaking/rankedQueue.js';
import {
  RankedMatchmaker,
  rankedMatchContext,
  type RankedPlayerInfo,
} from './matchmaking/rankedMatchmaker.js';
import { CrownRushRunner, type CrownRushFinishResult } from './games/crown-rush/runner.js';
import { createVoiceToken, loadVoiceConfig } from './voice/token.js';
import { loadAuthConfig, warnIfAuthDisabledInProduction } from './auth/config.js';
import { FakeIdTokenVerifier, GoogleIdTokenVerifier, type IdTokenVerifier } from './auth/google.js';
import { buildAuthRouter } from './auth/routes.js';
import { type SessionDeps } from './auth/sessions.js';
import {
  authenticateSocketHandshake,
  gateSocketAccount,
  setSocketAuth,
} from './auth/socketAuth.js';
import { setUserDistrict, type GuestClaim } from './auth/users.js';
import { buildSafetyRouter } from './moderation/routes.js';
import { isBlockedEitherWay } from './moderation/blocks.js';
import { RateLimiter, RATE_LIMIT_RULES, type RateLimitRule } from './rate-limit/limiter.js';

dotenv.config();

const PORT = Number(process.env.PORT) || 3001;
const WEB_URL = process.env.WEB_URL || 'http://localhost:5173';

// ---------------------------------------------------------------------------
// Task 10: authentication + safety configuration
// ---------------------------------------------------------------------------

const authConfig = loadAuthConfig();
warnIfAuthDisabledInProduction(authConfig);
const sessionDeps: SessionDeps = {
  pepper: authConfig.sessionCookieSecret,
  // Localhost dev runs over plain http; production must use https cookies.
  secureCookies: authConfig.isProduction,
};
/** Shared abuse-protection limiter (auth, voice, reports, challenges, queue). */
const abuseLimiter = new RateLimiter();
const googleVerifier: IdTokenVerifier = authConfig.googleClientId
  ? new GoogleIdTokenVerifier(authConfig.googleClientId)
  : new FakeIdTokenVerifier();
// Credentialed web origins (Socket.IO + fetch with cookies). Comma-separated
// WEB_URLS overrides the single WEB_URL.
const allowedOrigins = (process.env.WEB_URLS || WEB_URL)
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

// LiveKit voice config. Null when credentials are absent: voice is then
// disabled and every other feature keeps working normally.
const voiceConfig = loadVoiceConfig();
if (voiceConfig) {
  console.log(`[voice] enabled (url=${voiceConfig.url})`);
} else {
  console.log('[voice] disabled: LIVEKIT_URL/API_KEY/API_SECRET not set');
}

/**
 * Runtime info for one connected socket. In-memory only, no database.
 * The server is authoritative for membership and accepted positions.
 */
interface ConnectedPlayer {
  socketId: string;
  playerId: string;
  displayName: string;
  district: KeralaDistrict;
  x: number;
  y: number;
  inMatch: boolean;
}

/**
 * Presence tracking: exactly one entry per connected socket, so a socket is
 * never counted twice. Keyed by socket id; a browser refresh shows up as a
 * new socket after the old one disconnects.
 */
const connectedPlayers = new Map<string, ConnectedPlayer>();

function districtRoom(district: KeralaDistrict): string {
  return `district:${district.toLowerCase()}`;
}

function isKeralaDistrict(value: unknown): value is KeralaDistrict {
  return typeof value === 'string' && (KERALA_DISTRICTS as readonly string[]).includes(value);
}

function isValidJoinPayload(payload: unknown): payload is PlayerJoinDistrictPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const { playerId, displayName, district } = payload as Record<string, unknown>;
  return (
    typeof playerId === 'string' &&
    playerId.length >= 1 &&
    playerId.length <= 128 &&
    typeof displayName === 'string' &&
    displayName.trim().length >= 2 &&
    displayName.trim().length <= 20 &&
    isKeralaDistrict(district)
  );
}

function isValidMovePayload(payload: unknown): payload is PlayerMovePayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const { x, y } = payload as Record<string, unknown>;
  return (
    typeof x === 'number' &&
    typeof y === 'number' &&
    Number.isFinite(x) &&
    Number.isFinite(y)
  );
}

function clampLobby(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

function randomSpawn(): { x: number; y: number } {
  const x = LOBBY_SPAWN_PADDING + Math.random() * (LOBBY_WIDTH - 2 * LOBBY_SPAWN_PADDING);
  const y = LOBBY_SPAWN_PADDING + Math.random() * (LOBBY_HEIGHT - 2 * LOBBY_SPAWN_PADDING);
  return { x: Math.round(x), y: Math.round(y) };
}

function onlineCount(district: KeralaDistrict): number {
  let count = 0;
  for (const player of connectedPlayers.values()) {
    if (player.district === district) count += 1;
  }
  return count;
}

function findPlayerById(playerId: string): ConnectedPlayer | undefined {
  for (const player of connectedPlayers.values()) {
    if (player.playerId === playerId) return player;
  }
  return undefined;
}

/**
 * Task 10: socket-event abuse guard. Over-limit events are dropped (with a
 * log line) instead of disconnecting the user. Hot game loops (movement,
 * match input) never go through this.
 */
function socketRateLimitOk(key: string, rule: RateLimitRule): boolean {
  const result = abuseLimiter.check(key, rule);
  if (!result.ok) {
    console.warn(`[ratelimit] dropping event for ${key}`);
  }
  return result.ok;
}

/** Full player snapshot for a district room. Never exposes socket IDs. */
function districtSnapshot(district: KeralaDistrict): DistrictPlayersPayload {
  const players: LobbyPlayer[] = [];
  for (const player of connectedPlayers.values()) {
    if (player.district === district) {
      players.push({
        playerId: player.playerId,
        displayName: player.displayName,
        x: player.x,
        y: player.y,
        inMatch: player.inMatch,
      });
    }
  }
  return { district, players };
}

const app = express();
// Credentials (session cookie) require explicit origins: never `*`.
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Competition leaderboards (current Asia/Kolkata week)
// ---------------------------------------------------------------------------

app.get('/api/leaderboards/players', (req, res) => {
  try {
    const week = getCompetitionWeek(Date.now());
    const day = getCompetitionDay(Date.now());
    const parsed = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
    const limit = Number.isNaN(parsed) ? 50 : Math.max(1, Math.min(100, parsed));
    const playerId = typeof req.query.playerId === 'string' ? req.query.playerId : undefined;
    const payload: PlayersLeaderboardPayload = {
      week,
      players: getPlayerLeaderboard(db, week.id, limit),
      me: playerId ? getMyWeeklyStats(db, week.id, day.id, playerId) : null,
    };
    res.json(payload);
  } catch (error) {
    console.error('[competition] players leaderboard failed:', error);
    res.status(500).json({ error: 'leaderboard unavailable' });
  }
});

app.get('/api/leaderboards/districts', (_req, res) => {
  try {
    const week = getCompetitionWeek(Date.now());
    const payload: DistrictsLeaderboardPayload = {
      week,
      districts: getDistrictLeaderboard(db, week.id),
    };
    res.json(payload);
  } catch (error) {
    console.error('[competition] districts leaderboard failed:', error);
    res.status(500).json({ error: 'leaderboard unavailable' });
  }
});

// ---------------------------------------------------------------------------
// Current competition: week boundaries + this week's featured ranked game
// ---------------------------------------------------------------------------

app.get('/api/competition/current', (_req, res) => {
  try {
    // Lazy recovery: finalizing past weeks must not depend on the process
    // being awake at Monday 00:00, so every current-competition request also
    // sweeps ended-but-unfinalized weeks.
    ensurePastWeeksFinalized(db, { activeRankedMatchCountForWeek });
    const config = getOrCreateWeekConfig(db, Date.now());
    const payload: CurrentCompetitionPayload = {
      week: {
        id: config.competitionWeekId,
        startsAt: config.startsAt,
        endsAt: config.endsAt,
      },
      featuredGame: {
        gameType: config.featuredGameType,
        label: GAME_DEFINITIONS[config.featuredGameType].label,
      },
      previousChampion: getPreviousChampion(db, Date.now()),
    };
    res.json(payload);
  } catch (error) {
    console.error('[competition] current competition failed:', error);
    res.status(500).json({ error: 'competition unavailable' });
  }
});

// ---------------------------------------------------------------------------
// Competition history: finalized weeks only (immutable snapshots)
// ---------------------------------------------------------------------------

app.get('/api/competition/history', (req, res) => {
  try {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) ? rawLimit : HISTORY_DEFAULT_LIMIT;
    const payload: CompetitionHistoryPayload = {
      weeks: getHistorySummaries(db, limit),
    };
    res.json(payload);
  } catch (error) {
    console.error('[competition] history failed:', error);
    res.status(500).json({ error: 'history unavailable' });
  }
});

app.get('/api/competition/history/:weekId', (req, res) => {
  try {
    const weekId = req.params.weekId;
    if (!/^\d{4}-W\d{1,2}$/.test(weekId)) {
      res.status(400).json({ error: 'invalid week id' });
      return;
    }
    const detail: HistoricalWeekDetail | null = getHistoryDetail(db, weekId);
    if (!detail) {
      res.status(404).json({ error: 'week not finalized' });
      return;
    }
    res.json(detail);
  } catch (error) {
    console.error('[competition] history detail failed:', error);
    res.status(500).json({ error: 'history unavailable' });
  }
});

// ---------------------------------------------------------------------------
// District voice: whether the LiveKit layer is configured
// ---------------------------------------------------------------------------

app.get('/api/voice/status', (_req, res) => {
  res.json({ enabled: voiceConfig !== null });
});

const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: allowedOrigins, credentials: true },
});

// Persistent competition database (SQLite). Migrations run on startup;
// existing data is never deleted.
const db = getDatabase();

// ---------------------------------------------------------------------------
// Task 10: auth + safety routes
// ---------------------------------------------------------------------------

app.use(
  '/api/auth',
  buildAuthRouter({
    db,
    config: authConfig,
    verifier: googleVerifier,
    limiter: abuseLimiter,
    sessionDeps,
    allowedOrigins,
    // The claimable guest identity comes ONLY from the server-known socket
    // registration: the login body carries no playerId to forge.
    getGuestForSocket: (socketId: string): GuestClaim | null => {
      const player = connectedPlayers.get(socketId);
      return player
        ? { playerId: player.playerId, displayName: player.displayName, district: player.district }
        : null;
    },
  }),
);
app.use(
  '/api',
  buildSafetyRouter({ db, limiter: abuseLimiter, pepper: sessionDeps.pepper, allowedOrigins }),
);

// ---------------------------------------------------------------------------
// Weekly ranked battle queue (cross-district matchmaking)
// ---------------------------------------------------------------------------

const rankedQueue = new RankedQueue();
const rankedMatchmaker = new RankedMatchmaker({
  io,
  queue: rankedQueue,
  getPlayer: (socketId): RankedPlayerInfo | undefined => {
    const player = connectedPlayers.get(socketId);
    return player
      ? {
          socketId: player.socketId,
          playerId: player.playerId,
          displayName: player.displayName,
          district: player.district,
        }
      : undefined;
  },
  isBusy: (playerId): boolean => busyByPlayerId.has(playerId),
  hasPendingChallenge: (playerId): boolean =>
    challengeByChallenger.has(playerId) || challengeByTarget.has(playerId),
  getWeekConfig: (nowMs): CompetitionWeekConfig => getOrCreateWeekConfig(db, nowMs),
  startRankedMatch: (a, b, week): void => {
    const context = rankedMatchContext(a, b, week, Date.now());
    const aInfo = { socketId: a.socketId, playerId: a.playerId, displayName: a.displayName };
    const bInfo = { socketId: b.socketId, playerId: b.playerId, displayName: b.displayName };
    // The featured game is dispatched through the existing game lifecycle;
    // no game implementation is duplicated here.
    if (week.featuredGameType === GAME_TYPE_CROWN_RUSH) {
      createCrownRushMatch(aInfo, bInfo, context);
    } else {
      createMatch(aInfo, bInfo, context);
    }
  },
});

function broadcastPopulation(district: KeralaDistrict): void {
  io.to(districtRoom(district)).emit(DistrictPopulationEvent, {
    district,
    onlineCount: onlineCount(district),
  });
}

function broadcastPlayers(district: KeralaDistrict): void {
  io.to(districtRoom(district)).emit(DistrictPlayersEvent, districtSnapshot(district));
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

interface PendingChallenge {
  challengeId: string;
  challengerSocketId: string;
  challengerPlayerId: string;
  challengerName: string;
  targetSocketId: string;
  targetPlayerId: string;
  district: KeralaDistrict;
  gameType: GameType;
  timer: NodeJS.Timeout;
}

const challenges = new Map<string, PendingChallenge>();
const challengeByChallenger = new Map<string, string>(); // playerId -> challengeId
const challengeByTarget = new Map<string, string>(); // playerId -> challengeId

function removeChallenge(challengeId: string): PendingChallenge | undefined {
  const challenge = challenges.get(challengeId);
  if (!challenge) return undefined;
  clearTimeout(challenge.timer);
  challenges.delete(challengeId);
  challengeByChallenger.delete(challenge.challengerPlayerId);
  challengeByTarget.delete(challenge.targetPlayerId);
  return challenge;
}

function notifyChallengeCancelled(challenge: PendingChallenge, reason: ChallengeCancelledReason): void {
  io.to(challenge.challengerSocketId).emit(ChallengeCancelledEvent, {
    challengeId: challenge.challengeId,
    reason,
  });
  io.to(challenge.targetSocketId).emit(ChallengeCancelledEvent, {
    challengeId: challenge.challengeId,
    reason,
  });
}

function expireChallenge(challengeId: string): void {
  const challenge = removeChallenge(challengeId);
  if (!challenge) return;
  io.to(challenge.challengerSocketId).emit(ChallengeExpiredEvent, { challengeId });
  io.to(challenge.targetSocketId).emit(ChallengeExpiredEvent, { challengeId });
  console.log(`[challenge] ${challengeId} expired`);
}

// ---------------------------------------------------------------------------
// Precision Clash matches
// ---------------------------------------------------------------------------

interface MatchParticipant {
  socketId: string;
  playerId: string;
  displayName: string;
}

interface ActiveMatch {
  matchId: string;
  /** Server-authoritative: mode, source, week snapshot, district attribution. */
  context: MatchContext;
  players: [MatchParticipant, MatchParticipant];
  round: number;
  totalRounds: number;
  /** playerId -> per-round scores. */
  scores: Map<string, number[]>;
  /** playerId -> score for the current round (first tap wins). */
  taps: Map<string, number>;
  status: 'countdown' | 'playing' | 'roundResult' | 'finished';
  roundStartTime: number;
  roundTimer?: NodeJS.Timeout;
  rematchWants: Set<string>;
  returnedToLobby: Set<string>;
}

const matches = new Map<string, ActiveMatch>();
/** playerId -> matchId for players currently inside a match. */
const busyByPlayerId = new Map<string, string>();

const matchRoom = (matchId: string): string => `match:${matchId}`;

function setBusy(playerId: string, matchId: string | null): void {
  if (matchId) busyByPlayerId.set(playerId, matchId);
  else busyByPlayerId.delete(playerId);
  const player = findPlayerById(playerId);
  if (player) {
    player.inMatch = matchId !== null;
    broadcastPlayers(player.district);
  }
}

/**
 * Server-authoritative scoring: marker position is derived from the server's
 * tap-receive time, never from any client-supplied score.
 */
function scoreForTap(elapsedMs: number, cycleMs: number): number {
  const phase = (elapsedMs % cycleMs) / cycleMs; // 0..1
  const position = phase < 0.5 ? phase * 2 : 2 - phase * 2; // 0 -> 1 -> 0
  const distanceFromCenter = Math.abs(position - 0.5) * 2; // 0 at center, 1 at edge
  return Math.max(0, Math.round(100 - distanceFromCenter * 100));
}

function labelForScore(score: number): string {
  if (score >= 97) return 'PERFECT!';
  if (score >= 85) return 'GREAT!';
  if (score >= 65) return 'GOOD!';
  return 'MISS!';
}

function createMatch(
  a: MatchParticipant,
  b: MatchParticipant,
  context: MatchContext,
): void {
  const matchId = randomUUID();
  const match: ActiveMatch = {
    matchId,
    context,
    players: [a, b],
    round: 0,
    totalRounds: MATCH_TOTAL_ROUNDS,
    scores: new Map([
      [a.playerId, []],
      [b.playerId, []],
    ]),
    taps: new Map(),
    status: 'countdown',
    roundStartTime: 0,
    rematchWants: new Set(),
    returnedToLobby: new Set(),
  };
  matches.set(matchId, match);
  for (const participant of [a, b]) {
    io.sockets.sockets.get(participant.socketId)?.join(matchRoom(matchId));
    setBusy(participant.playerId, matchId);
  }
  const serverNow = Date.now();
  const payload: MatchStartedPayload = {
    matchId,
    gameType: GAME_TYPE_PRECISION_CLASH,
    matchMode: context.matchMode,
    matchSource: context.matchSource,
    players: [
      { playerId: a.playerId, displayName: a.displayName },
      { playerId: b.playerId, displayName: b.displayName },
    ],
    districts: context.districts,
    competitionWeekId: context.competitionWeekId,
    totalRounds: MATCH_TOTAL_ROUNDS,
    startsAt: serverNow + MATCH_COUNTDOWN_MS,
    serverNow,
  };
  io.to(matchRoom(matchId)).emit(MatchStartedEvent, payload);
  console.log(
    `[match] ${matchId} created: ${a.displayName} vs ${b.displayName} (${context.matchMode}/${context.matchSource})`,
  );
  match.roundTimer = setTimeout(() => startRound(matchId, 1), MATCH_COUNTDOWN_MS);
}

function startRound(matchId: string, round: number): void {
  const match = matches.get(matchId);
  if (!match || match.status === 'finished') return;
  match.status = 'playing';
  match.round = round;
  match.roundStartTime = Date.now();
  match.taps.clear();
  io.to(matchRoom(matchId)).emit(RoundStartedEvent, {
    matchId,
    round,
    totalRounds: match.totalRounds,
    roundStartTime: match.roundStartTime,
    cycleDurationMs: ROUND_CYCLE_MS,
    roundDurationMs: ROUND_DURATION_MS,
  });
  match.roundTimer = setTimeout(() => finishRound(matchId), ROUND_DURATION_MS);
}

function finishRound(matchId: string): void {
  const match = matches.get(matchId);
  if (!match || match.status !== 'playing') return;
  match.status = 'roundResult';
  const results: RoundScoreEntry[] = match.players.map((participant) => {
    const score = match.taps.get(participant.playerId) ?? 0;
    match.scores.get(participant.playerId)?.push(score);
    return {
      playerId: participant.playerId,
      displayName: participant.displayName,
      score,
      label: labelForScore(score),
    };
  });
  const payload: RoundResultPayload = { matchId, round: match.round, results };
  io.to(matchRoom(matchId)).emit(RoundResultEvent, payload);
  console.log(
    `[match] ${matchId} round ${match.round}: ${results.map((r) => `${r.displayName}=${r.score}`).join(', ')}`,
  );
  match.roundTimer = setTimeout(() => {
    if (match.round >= match.totalRounds) finishMatch(matchId);
    else startRound(matchId, match.round + 1);
  }, ROUND_PAUSE_MS);
}

function finishMatch(matchId: string): void {
  const match = matches.get(matchId);
  if (!match) return;
  match.status = 'finished';
  const totals = match.players.map((participant) => ({
    playerId: participant.playerId,
    displayName: participant.displayName,
    total: (match.scores.get(participant.playerId) ?? []).reduce((sum, score) => sum + score, 0),
  }));
  const [first, second] = totals;
  const winnerPlayerId =
    first.total === second.total ? null : first.total > second.total ? first.playerId : second.playerId;

  // Persistent competition settlement: server-authoritative, idempotent, and
  // based on the same totals announced to the players. Only ranked matches
  // settle; casual matches award nothing. District attribution comes from the
  // snapshot taken when the server started the match, never the live profile.
  const ranked = match.players.map((participant, index): RankedPlayerInput => {
    const total = totals.find((entry) => entry.playerId === participant.playerId)?.total ?? 0;
    return {
      playerId: participant.playerId,
      displayName: participant.displayName,
      district: match.context.districts[index] ?? match.context.districts[0],
      score: total,
    };
  });
  const { settlement, competitionWeekId } =
    ranked[0] && ranked[1]
      ? settleRankedGame({
          matchId,
          gameType: GAME_TYPE_PRECISION_CLASH,
          ranked: [ranked[0], ranked[1]],
          winnerPlayerId,
          context: match.context,
        })
      : { settlement: undefined, competitionWeekId: undefined };

  const payload: MatchFinishedPayload = {
    matchId,
    gameType: GAME_TYPE_PRECISION_CLASH,
    matchMode: match.context.matchMode,
    matchSource: match.context.matchSource,
    totals,
    winnerPlayerId,
    districts: match.context.districts,
    competitionWeekId: match.context.competitionWeekId,
    settlement,
  };
  io.to(matchRoom(matchId)).emit(MatchFinishedEvent, payload);
  if (competitionWeekId) {
    // Lightweight ping; clients refetch leaderboard data themselves.
    io.emit(CompetitionUpdatedEvent, { competitionWeekId });
  }
  console.log(
    `[match] ${matchId} finished: ${totals.map((t) => `${t.displayName}=${t.total}`).join(', ')}`,
  );
}

/**
 * Shared ranked-settlement path for every game type.
 *
 * Casual matches never settle: no ranking points, no district contribution,
 * no leaderboard updates. Ranked matches pass central validation (ranked
 * mode, weekly-queue source, featured game of the snapshotted week, two
 * different districts) before any points are awarded. Settlement itself is
 * server-authoritative and idempotent; a failure is logged but never breaks
 * the result screen.
 */
function settleRankedGame(input: {
  matchId: string;
  gameType: GameType;
  ranked: [RankedPlayerInput, RankedPlayerInput];
  winnerPlayerId: string | null;
  context: MatchContext;
}): { settlement: MatchSettlementMap | undefined; competitionWeekId: string | undefined } {
  if (input.context.matchMode !== MATCH_MODE_RANKED) {
    return { settlement: undefined, competitionWeekId: undefined };
  }
  const validation = validateRankedMatch(db, {
    matchId: input.matchId,
    gameType: input.gameType,
    matchMode: input.context.matchMode,
    matchSource: input.context.matchSource,
    competitionWeekId: input.context.competitionWeekId,
    districts: input.context.districts,
  });
  if (!validation.ok) {
    console.error(`[competition] refusing ranked settlement: ${validation.reason}`);
    return { settlement: undefined, competitionWeekId: undefined };
  }
  try {
    const outcome = settleRankedMatch(db, {
      matchId: input.matchId,
      gameType: input.gameType,
      matchMode: input.context.matchMode,
      matchSource: input.context.matchSource,
      players: input.ranked,
      winnerPlayerId: input.winnerPlayerId,
      completedAtMs: Date.now(),
      // Week-boundary rule: the result belongs to the week the server
      // started the match, even if it finished after a rollover.
      competitionWeekId: input.context.competitionWeekId,
    });
    // A settled ranked match may complete an ended week: attempt finalization.
    maybeFinalizeWeek(outcome.weekId);
    return { settlement: outcome.awards, competitionWeekId: outcome.weekId };
  } catch (error) {
    console.error(`[competition] settlement failed for match ${input.matchId}:`, error);
    return { settlement: undefined, competitionWeekId: undefined };
  }
}

/**
 * Live count of unfinished ranked matches snapshotted to a competition week.
 * Used to delay finalization until old-week matches settle (bounded by the
 * grace period so a stuck match cannot block a week forever).
 */
function activeRankedMatchCountForWeek(weekId: string): number {
  let count = 0;
  for (const match of matches.values()) {
    if (
      match.status !== 'finished' &&
      match.context.matchMode === MATCH_MODE_RANKED &&
      match.context.competitionWeekId === weekId
    ) {
      count += 1;
    }
  }
  for (const runner of crownRushMatches.values()) {
    if (
      runner.status !== 'finished' &&
      runner.matchContext.matchMode === MATCH_MODE_RANKED &&
      runner.matchContext.competitionWeekId === weekId
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Attempt to finalize a week; on success broadcast a lightweight
 * competition:week-finalized event so clients refetch history data.
 */
function maybeFinalizeWeek(weekId: string): void {
  const outcome = finalizeCompetitionWeek(db, weekId, {
    activeRankedMatchCount: activeRankedMatchCountForWeek(weekId),
  });
  if (outcome.status !== 'finalized' || !outcome.champions) return;
  io.emit(CompetitionWeekFinalizedEvent, {
    competitionWeekId: weekId,
    featuredGameType: outcome.champions.featuredGameType,
    weeklyMaster: outcome.champions.weeklyMaster,
    districtChampion: outcome.champions.districtChampion,
  });
}

// ---------------------------------------------------------------------------
// Crown Rush matches
// ---------------------------------------------------------------------------

const crownRushMatches = new Map<string, CrownRushRunner>();

function createCrownRushMatch(
  a: MatchParticipant,
  b: MatchParticipant,
  context: MatchContext,
): void {
  const runner = new CrownRushRunner(io, context.districts[0], [a, b], {
    onFinish: (result) => finishCrownRushMatch(runner, result),
    matchContext: context,
  });
  crownRushMatches.set(runner.matchId, runner);
  for (const participant of [a, b]) {
    io.sockets.sockets.get(participant.socketId)?.join(runner.matchRoom);
    setBusy(participant.playerId, runner.matchId);
  }
  const serverNow = Date.now();
  const payload: CrownRushStartedPayload = {
    matchId: runner.matchId,
    gameType: GAME_TYPE_CROWN_RUSH,
    matchMode: context.matchMode,
    matchSource: context.matchSource,
    players: [
      { playerId: a.playerId, displayName: a.displayName },
      { playerId: b.playerId, displayName: b.displayName },
    ],
    districts: context.districts,
    competitionWeekId: context.competitionWeekId,
    startsAt: serverNow + MATCH_COUNTDOWN_MS,
    serverNow,
  };
  io.to(runner.matchRoom).emit(CrownRushStartedEvent, payload);
  console.log(
    `[crownrush] ${runner.matchId} created: ${a.displayName} vs ${b.displayName} (${context.matchMode}/${context.matchSource})`,
  );
  runner.beginCountdown(MATCH_COUNTDOWN_MS);
}

function finishCrownRushMatch(runner: CrownRushRunner, result: CrownRushFinishResult): void {
  const [a, b] = runner.players;
  const context = runner.matchContext;
  const toRanked = (
    participant: MatchParticipant,
    score: number,
    district: KeralaDistrict,
  ): RankedPlayerInput => ({
    playerId: participant.playerId,
    displayName: participant.displayName,
    // Ranked: the district snapshotted at match start (historical attribution).
    district,
    score,
  });
  // Same reusable ranked settlement as Precision Clash; only the gameType differs.
  // Casual matches settle nothing.
  const { settlement, competitionWeekId } = settleRankedGame({
    matchId: runner.matchId,
    gameType: GAME_TYPE_CROWN_RUSH,
    ranked: [toRanked(a, result.scores[0], context.districts[0]), toRanked(b, result.scores[1], context.districts[1])],
    winnerPlayerId: result.winnerPlayerId,
    context,
  });
  const payload: MatchFinishedPayload = {
    matchId: runner.matchId,
    gameType: GAME_TYPE_CROWN_RUSH,
    matchMode: context.matchMode,
    matchSource: context.matchSource,
    totals: [
      { playerId: a.playerId, displayName: a.displayName, total: result.scores[0] },
      { playerId: b.playerId, displayName: b.displayName, total: result.scores[1] },
    ],
    winnerPlayerId: result.winnerPlayerId,
    districts: context.districts,
    competitionWeekId: context.competitionWeekId,
    settlement,
  };
  io.to(runner.matchRoom).emit(MatchFinishedEvent, payload);
  if (competitionWeekId) {
    io.emit(CompetitionUpdatedEvent, { competitionWeekId });
  }
  console.log(
    `[crownrush] ${runner.matchId} finished: ${a.displayName}=${result.scores[0]}, ${b.displayName}=${result.scores[1]}`,
  );
}

/** A match of either game type, resolved by matchId. */
type ResolvedMatch =
  | { kind: 'precision'; match: ActiveMatch }
  | { kind: 'crownrush'; runner: CrownRushRunner };

function resolveMatch(matchId: unknown): ResolvedMatch | undefined {
  if (typeof matchId !== 'string') return undefined;
  const match = matches.get(matchId);
  if (match) return { kind: 'precision', match };
  const runner = crownRushMatches.get(matchId);
  if (runner) return { kind: 'crownrush', runner };
  return undefined;
}

function resolveParticipant(
  resolved: ResolvedMatch,
  socketId: string,
): MatchParticipant | undefined {
  const players = resolved.kind === 'precision' ? resolved.match.players : resolved.runner.players;
  return players.find((participant) => participant.socketId === socketId);
}

/** Rematch flow for Crown Rush: a brand-new match, 0-0, new matchId, same game. */
function handleCrownRushRematch(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  runner: CrownRushRunner,
): void {
  if (runner.status !== 'finished') return;
  const me = runner.players.find((participant) => participant.socketId === socket.id);
  if (!me || runner.returnedToLobby.has(me.playerId)) return;
  runner.rematchWants.add(me.playerId);
  const other = runner.players.find((participant) => participant.playerId !== me.playerId);
  if (!other) return;
  if (runner.rematchWants.has(other.playerId) && !runner.returnedToLobby.has(other.playerId)) {
    const meConn = findPlayerById(me.playerId);
    const otherConn = findPlayerById(other.playerId);
    if (!meConn || !otherConn) {
      socket.emit(RematchCancelledEvent, { matchId: runner.matchId });
      return;
    }
    for (const participant of runner.players) {
      io.sockets.sockets.get(participant.socketId)?.leave(runner.matchRoom);
    }
    runner.destroy();
    crownRushMatches.delete(runner.matchId);
    // Rematches are always casual, even after a ranked match: ranked points
    // can only ever come from the weekly queue (anti-farming).
    createCrownRushMatch(
      { socketId: meConn.socketId, playerId: meConn.playerId, displayName: meConn.displayName },
      {
        socketId: otherConn.socketId,
        playerId: otherConn.playerId,
        displayName: otherConn.displayName,
      },
      {
        matchMode: MATCH_MODE_CASUAL,
        matchSource: MATCH_SOURCE_DIRECT_CHALLENGE,
        districts: [meConn.district, otherConn.district],
        startedAtMs: Date.now(),
      },
    );
  } else {
    socket.emit(RematchWaitingEvent, { matchId: runner.matchId });
  }
}

function getMatch(matchId: unknown): ActiveMatch | undefined {
  return typeof matchId === 'string' ? matches.get(matchId) : undefined;
}

function participantOf(match: ActiveMatch, socketId: string): MatchParticipant | undefined {
  return match.players.find((participant) => participant.socketId === socketId);
}

// ---------------------------------------------------------------------------
// Socket.IO wiring
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  console.log(`[socket] connected: ${socket.id}`);
  // Task 10: resolve the handshake session cookie to the canonical account
  // identity once per connection. Login/logout force a client reconnect, so
  // this is always fresh.
  setSocketAuth(
    socket,
    authenticateSocketHandshake(db, socket.handshake.headers.cookie, sessionDeps.pepper),
  );

  socket.on(ClientHelloEvent, (payload: ClientHelloPayload) => {
    console.log(`[socket] ${ClientHelloEvent} from ${socket.id}`, payload);
    const welcome: ServerWelcomePayload = { message: 'Connected to Kerala Battle' };
    socket.emit(ServerWelcomeEvent, welcome);
  });

  socket.on(PlayerJoinDistrictEvent, (payload) => {
    // Task 10: with AUTH_REQUIRED=true the session decides the canonical
    // identity. Client-sent playerId/displayName are ignored entirely, so a
    // logged-in browser can never impersonate another playerId during join.
    const gate = gateSocketAccount(db, socket, authConfig.authRequired);
    if (!gate.ok) {
      socket.emit(AuthRequiredEvent);
      console.warn(`[auth] rejected ${PlayerJoinDistrictEvent} from ${socket.id}: ${gate.reason}`);
      return;
    }
    let playerId: string;
    let displayName: string;
    let district: KeralaDistrict;
    if (gate.user) {
      const rawDistrict =
        typeof payload === 'object' && payload !== null
          ? (payload as { district?: unknown }).district
          : undefined;
      if (!isKeralaDistrict(rawDistrict)) {
        console.warn(`[socket] invalid ${PlayerJoinDistrictEvent} from ${socket.id}`);
        return;
      }
      playerId = gate.user.playerId;
      displayName = gate.user.displayName;
      district = rawDistrict;
      if (displayName === '') {
        // New Google account that hasn't completed onboarding (name +
        // district): the client gates this, but the server enforces it too.
        console.warn(`[auth] rejected ${PlayerJoinDistrictEvent}: profile incomplete`);
        return;
      }
      // The district choice is still the player's; persist it on the profile.
      if (district !== gate.user.district) {
        setUserDistrict(db, gate.user.id, district);
      }
    } else {
      if (!isValidJoinPayload(payload)) {
        console.warn(`[socket] invalid ${PlayerJoinDistrictEvent} from ${socket.id}`);
        return;
      }
      playerId = payload.playerId;
      displayName = payload.displayName.trim();
      district = payload.district;
    }
    const previous = connectedPlayers.get(socket.id);
    // A queued or in-match player cannot switch district mid-flow: cancel the
    // queue first, or finish/leave the match. The client disables the button,
    // but the server enforces it too.
    if (previous && previous.district !== district) {
      if (rankedMatchmaker.isQueued(socket.id)) {
        rankedMatchmaker.cancel(socket.id);
      }
      if (busyByPlayerId.has(previous.playerId)) {
        console.log(
          `[district] ${previous.displayName} tried to switch district mid-match; ignored`,
        );
        return;
      }
    }
    // A brand-new socket (or a district switch) gets a fresh spawn point.
    // A same-socket re-join of the same district keeps its position.
    const spawn =
      previous && previous.district === district ? { x: previous.x, y: previous.y } : randomSpawn();
    const next: ConnectedPlayer = {
      socketId: socket.id,
      playerId,
      displayName,
      district,
      x: spawn.x,
      y: spawn.y,
      inMatch: previous?.inMatch ?? false,
    };
    connectedPlayers.set(socket.id, next);
    // Persist the identity; a district switch updates the same row.
    try {
      upsertPlayer(db, next.playerId, next.displayName, next.district, Date.now());
    } catch (error) {
      console.error('[competition] upsertPlayer failed:', error);
    }

    if (previous && previous.district !== next.district) {
      socket.leave(districtRoom(previous.district));
      broadcastPopulation(previous.district);
      broadcastPlayers(previous.district);
    }
    socket.join(districtRoom(next.district));
    broadcastPopulation(next.district);
    broadcastPlayers(next.district);
    console.log(
      `[district] ${next.displayName} (${socket.id}) joined ${next.district} at ${spawn.x},${spawn.y}`,
    );
  });

  socket.on(PlayerMoveEvent, (payload) => {
    // Identity comes from the socket's registered player, never from the client.
    const player = connectedPlayers.get(socket.id);
    if (!player || player.inMatch || !isValidMovePayload(payload)) return;
    player.x = clampLobby(payload.x, LOBBY_WIDTH);
    player.y = clampLobby(payload.y, LOBBY_HEIGHT);
    const moved: PlayerMovedPayload = { playerId: player.playerId, x: player.x, y: player.y };
    socket.to(districtRoom(player.district)).emit(PlayerMovedEvent, moved);
  });

  // ------------------------- challenges -------------------------

  socket.on(ChallengeSendEvent, (payload) => {
    const challenger = connectedPlayers.get(socket.id);
    const targetPlayerId =
      typeof payload === 'object' && payload !== null
        ? (payload as { targetPlayerId?: unknown }).targetPlayerId
        : undefined;
    const gameType =
      typeof payload === 'object' && payload !== null
        ? (payload as { gameType?: unknown }).gameType
        : undefined;
    const fail = (reason: ChallengeFailedReason): void => {
      socket.emit(ChallengeFailedEvent, { reason });
    };
    if (!challenger || typeof targetPlayerId !== 'string') return;
    if (!isGameType(gameType)) return fail('invalid-game');
    // Task 10: banned/suspended accounts cannot challenge; logged-out sockets
    // are rejected when auth is required.
    if (!gateSocketAccount(db, socket, authConfig.authRequired).ok) {
      socket.emit(AuthRequiredEvent);
      return;
    }
    if (!socketRateLimitOk(`challenge:${challenger.playerId}`, RATE_LIMIT_RULES.challengeSend)) {
      return fail('challenge-unavailable');
    }
    const target = findPlayerById(targetPlayerId);
    if (!target) return fail('target-not-found');
    if (target.playerId === challenger.playerId) return fail('self-challenge');
    if (target.district !== challenger.district) return fail('different-district');
    // Task 10: a block in EITHER direction makes direct challenges
    // unavailable. The reason is generic so neither party learns who blocked
    // whom. Ranked queue matching is intentionally unaffected.
    if (isBlockedEitherWay(db, challenger.playerId, target.playerId)) {
      return fail('challenge-unavailable');
    }
    if (busyByPlayerId.has(challenger.playerId) || busyByPlayerId.has(target.playerId)) {
      return fail('busy');
    }
    if (challengeByChallenger.has(challenger.playerId) || challengeByTarget.has(target.playerId)) {
      return fail('already-pending');
    }
    // A direct challenge replaces queueing: the challenger chose a casual game.
    rankedMatchmaker.evictPlayer(challenger.playerId);
    const challengeId = randomUUID();
    const challenge: PendingChallenge = {
      challengeId,
      challengerSocketId: socket.id,
      challengerPlayerId: challenger.playerId,
      challengerName: challenger.displayName,
      targetSocketId: target.socketId,
      targetPlayerId: target.playerId,
      district: challenger.district,
      gameType,
      timer: setTimeout(() => expireChallenge(challengeId), CHALLENGE_EXPIRY_MS),
    };
    challenges.set(challengeId, challenge);
    challengeByChallenger.set(challenger.playerId, challengeId);
    challengeByTarget.set(target.playerId, challengeId);
    io.to(target.socketId).emit(ChallengeReceivedEvent, {
      challengeId,
      challenger: { playerId: challenger.playerId, displayName: challenger.displayName },
      gameType,
      // Direct challenges are always casual; the server decides the mode.
      matchMode: MATCH_MODE_CASUAL,
    });
    console.log(
      `[challenge] ${challengeId}: ${challenger.displayName} -> ${target.displayName} (${gameType})`,
    );
  });

  socket.on(ChallengeAcceptEvent, (payload) => {
    const challengeId = typeof payload?.challengeId === 'string' ? payload.challengeId : undefined;
    const challenge = challengeId ? challenges.get(challengeId) : undefined;
    if (!challenge || challenge.targetSocketId !== socket.id) return;
    removeChallenge(challengeId as string);
    const challenger = connectedPlayers.get(challenge.challengerSocketId);
    const target = connectedPlayers.get(challenge.targetSocketId);
    const fail = (reason: 'opponent-disconnected' | 'unavailable'): void => {
      socket.emit(ChallengeCancelledEvent, { challengeId: challenge.challengeId, reason });
    };
    if (!challenger || !target || challenger.district !== target.district) {
      return fail('opponent-disconnected');
    }
    if (busyByPlayerId.has(challenger.playerId) || busyByPlayerId.has(target.playerId)) {
      return fail('unavailable');
    }
    // Neither side may stay queued: the accepted challenge becomes their match.
    rankedMatchmaker.evictPlayer(challenger.playerId);
    rankedMatchmaker.evictPlayer(target.playerId);
    const challengerInfo = {
      socketId: challenger.socketId,
      playerId: challenger.playerId,
      displayName: challenger.displayName,
    };
    const targetInfo = {
      socketId: target.socketId,
      playerId: target.playerId,
      displayName: target.displayName,
    };
    // Direct challenges are always casual. The server decides the mode; the
    // client can never turn a direct challenge into a ranked game.
    const context: MatchContext = {
      matchMode: MATCH_MODE_CASUAL,
      matchSource: MATCH_SOURCE_DIRECT_CHALLENGE,
      districts: [challenger.district, challenger.district],
      startedAtMs: Date.now(),
    };
    // The challenge lifecycle is shared; only match creation is game-specific.
    if (challenge.gameType === GAME_TYPE_CROWN_RUSH) {
      createCrownRushMatch(challengerInfo, targetInfo, context);
    } else {
      createMatch(challengerInfo, targetInfo, context);
    }
  });

  socket.on(ChallengeDeclineEvent, (payload) => {
    const challengeId = typeof payload?.challengeId === 'string' ? payload.challengeId : undefined;
    const challenge = challengeId ? challenges.get(challengeId) : undefined;
    if (!challenge || challenge.targetSocketId !== socket.id) return;
    removeChallenge(challengeId as string);
    notifyChallengeCancelled(challenge, 'declined');
    console.log(`[challenge] ${challengeId} declined`);
  });

  socket.on(ChallengeWithdrawEvent, (payload) => {
    const challenger = connectedPlayers.get(socket.id);
    const targetPlayerId =
      typeof payload === 'object' && payload !== null
        ? (payload as { targetPlayerId?: unknown }).targetPlayerId
        : undefined;
    if (!challenger || typeof targetPlayerId !== 'string') return;
    const challengeId = challengeByChallenger.get(challenger.playerId);
    const challenge = challengeId ? challenges.get(challengeId) : undefined;
    if (!challenge || challenge.targetPlayerId !== targetPlayerId) return;
    removeChallenge(challengeId as string);
    notifyChallengeCancelled(challenge, 'withdrawn');
  });

  // ------------------------- weekly ranked queue -------------------------

  socket.on(RankedQueueJoinEvent, () => {
    // Task 10: banned/suspended accounts cannot queue; logged-out sockets are
    // rejected when auth is required. Status is read fresh from the DB so a
    // mid-session ban takes effect immediately.
    if (!gateSocketAccount(db, socket, authConfig.authRequired).ok) {
      socket.emit(AuthRequiredEvent);
      return;
    }
    const player = connectedPlayers.get(socket.id);
    const key = player ? `queue:${player.playerId}` : `queue-socket:${socket.id}`;
    if (!socketRateLimitOk(key, RATE_LIMIT_RULES.rankedQueueJoin)) return;
    // The payload carries nothing: game, week, district and identity are
    // all server-decided inside the matchmaker.
    rankedMatchmaker.join(socket.id);
  });

  socket.on(RankedQueueCancelEvent, () => {
    rankedMatchmaker.cancel(socket.id);
  });

  // ------------------------- district voice (LiveKit tokens) -------------------------

  socket.on(VoiceTokenEvent, (_payload, callback) => {
    // Identity and district come from the server's connected-player state,
    // never from the payload: a client cannot request another player's
    // identity or another district's voice room through this protocol.
    const player = connectedPlayers.get(socket.id);
    if (!player) {
      const response: VoiceTokenResponse = { ok: false, error: 'not-registered' };
      callback(response);
      return;
    }
    // Task 10: banned/suspended accounts cannot get voice tokens, and token
    // requests are rate-limited per player. The canonical identity comes
    // from the handshake session when auth is required.
    if (!gateSocketAccount(db, socket, authConfig.authRequired).ok) {
      const response: VoiceTokenResponse = { ok: false, error: 'not-registered' };
      callback(response);
      return;
    }
    if (!socketRateLimitOk(`voice:${player.playerId}`, RATE_LIMIT_RULES.voiceToken)) {
      const response: VoiceTokenResponse = { ok: false, error: 'rate-limited' };
      callback(response);
      return;
    }
    if (!voiceConfig) {
      const response: VoiceTokenResponse = { ok: false, error: 'voice-disabled' };
      callback(response);
      return;
    }
    createVoiceToken(voiceConfig, {
      playerId: player.playerId,
      displayName: player.displayName,
      district: player.district,
    })
      .then(({ token, url, roomName }) => {
        const response: VoiceTokenResponse = { ok: true, token, url, roomName };
        callback(response);
      })
      .catch((error) => {
        console.error('[voice] token issuance failed:', error);
        const response: VoiceTokenResponse = { ok: false, error: 'voice-disabled' };
        callback(response);
      });
  });

  // ------------------------- match play -------------------------

  socket.on(CrownRushInputEvent, (payload) => {
    // The runner validates the payload and identifies the player from the
    // socket; clients never submit positions or playerIds.
    const matchId =
      typeof payload === 'object' && payload !== null
        ? (payload as { matchId?: unknown }).matchId
        : undefined;
    if (typeof matchId !== 'string') return;
    crownRushMatches.get(matchId)?.handleInput(socket.id, payload);
  });

  socket.on(GameTapEvent, (payload) => {
    const match = getMatch(payload?.matchId);
    if (!match || match.status !== 'playing' || payload?.round !== match.round) return;
    const participant = participantOf(match, socket.id);
    if (!participant || match.taps.has(participant.playerId)) return;
    const elapsed = Date.now() - match.roundStartTime;
    if (elapsed < 0 || elapsed > ROUND_DURATION_MS + 1500) return;
    match.taps.set(participant.playerId, scoreForTap(elapsed, ROUND_CYCLE_MS));
    io.to(matchRoom(match.matchId)).emit(RoundTapEvent, {
      matchId: match.matchId,
      round: match.round,
      playerId: participant.playerId,
    });
    if (match.taps.size === match.players.length) {
      if (match.roundTimer) clearTimeout(match.roundTimer);
      finishRound(match.matchId);
    }
  });

  socket.on(GameRematchEvent, (payload) => {
    const resolved = resolveMatch(payload?.matchId);
    if (!resolved) return;
    if (resolved.kind === 'crownrush') return handleCrownRushRematch(socket, resolved.runner);
    const match = resolved.match;
    if (match.status !== 'finished') return;
    const me = participantOf(match, socket.id);
    if (!me || match.returnedToLobby.has(me.playerId)) return;
    match.rematchWants.add(me.playerId);
    const other = match.players.find((participant) => participant.playerId !== me.playerId);
    if (!other) return;
    if (match.rematchWants.has(other.playerId) && !match.returnedToLobby.has(other.playerId)) {
      const meConn = findPlayerById(me.playerId);
      const otherConn = findPlayerById(other.playerId);
      if (!meConn || !otherConn) {
        socket.emit(RematchCancelledEvent, { matchId: match.matchId });
        return;
      }
      for (const participant of match.players) {
        io.sockets.sockets.get(participant.socketId)?.leave(matchRoom(match.matchId));
      }
      matches.delete(match.matchId);
      // Rematches are always casual, even after a ranked match: ranked points
      // can only ever come from the weekly queue (anti-farming).
      createMatch(
        { socketId: meConn.socketId, playerId: meConn.playerId, displayName: meConn.displayName },
        {
          socketId: otherConn.socketId,
          playerId: otherConn.playerId,
          displayName: otherConn.displayName,
        },
        {
          matchMode: MATCH_MODE_CASUAL,
          matchSource: MATCH_SOURCE_DIRECT_CHALLENGE,
          districts: [meConn.district, otherConn.district],
          startedAtMs: Date.now(),
        },
      );
    } else {
      socket.emit(RematchWaitingEvent, { matchId: match.matchId });
    }
  });

  socket.on(GameRematchCancelEvent, (payload) => {
    const resolved = resolveMatch(payload?.matchId);
    if (!resolved) return;
    if (resolved.kind === 'crownrush') {
      const runner = resolved.runner;
      if (runner.status !== 'finished') return;
      const me = resolveParticipant(resolved, socket.id);
      if (me) runner.rematchWants.delete(me.playerId);
      return;
    }
    const match = resolved.match;
    if (match.status !== 'finished') return;
    const me = participantOf(match, socket.id);
    if (me) match.rematchWants.delete(me.playerId);
  });

  socket.on(GameReturnLobbyEvent, (payload) => {
    const player = connectedPlayers.get(socket.id);
    const resolved = resolveMatch(payload?.matchId);
    const participant = resolved ? resolveParticipant(resolved, socket.id) : undefined;
    if (resolved && participant) {
      const matchId = resolved.kind === 'precision' ? resolved.match.matchId : resolved.runner.matchId;
      const players = resolved.kind === 'precision' ? resolved.match.players : resolved.runner.players;
      const rematchWants =
        resolved.kind === 'precision' ? resolved.match.rematchWants : resolved.runner.rematchWants;
      const returnedToLobby =
        resolved.kind === 'precision'
          ? resolved.match.returnedToLobby
          : resolved.runner.returnedToLobby;
      returnedToLobby.add(participant.playerId);
      rematchWants.delete(participant.playerId);
      socket.leave(matchRoom(matchId));
      const other = players.find((p) => p.playerId !== participant.playerId);
      const otherSocket = other ? io.sockets.sockets.get(other.socketId) : undefined;
      if (other && rematchWants.has(other.playerId) && otherSocket) {
        otherSocket.emit(RematchCancelledEvent, { matchId });
      }
      if (returnedToLobby.size >= players.length) {
        if (resolved.kind === 'precision') {
          matches.delete(matchId);
        } else {
          resolved.runner.destroy();
          crownRushMatches.delete(matchId);
        }
      }
    }
    if (player) setBusy(player.playerId, null);
    else if (participant) busyByPlayerId.delete(participant.playerId);
  });

  // ------------------------- disconnect -------------------------

  socket.on('disconnect', (reason) => {
    const player = connectedPlayers.get(socket.id);

    // A queued player leaves the queue immediately: no ghost entries, no
    // ghost matches later. Pending match-found intros are aborted safely.
    rankedMatchmaker.handleDisconnect(socket.id);

    // Pending challenges involving this socket are cancelled.
    for (const [challengeId, challenge] of challenges) {
      if (challenge.challengerSocketId !== socket.id && challenge.targetSocketId !== socket.id) {
        continue;
      }
      removeChallenge(challengeId);
      const otherSocketId =
        challenge.challengerSocketId === socket.id
          ? challenge.targetSocketId
          : challenge.challengerSocketId;
      io.to(otherSocketId).emit(ChallengeCancelledEvent, {
        challengeId,
        reason: 'opponent-disconnected',
      });
    }

    // Matches involving this player are resolved safely.
    if (player) {
      const matchId = busyByPlayerId.get(player.playerId);
      busyByPlayerId.delete(player.playerId);
      const resolved = matchId ? resolveMatch(matchId) : undefined;
      if (resolved) {
        const other =
          resolved.kind === 'precision'
            ? resolved.match.players.find((p) => p.playerId !== player.playerId)
            : resolved.runner.players.find((p) => p.playerId !== player.playerId);
        const otherSocket = other ? io.sockets.sockets.get(other.socketId) : undefined;
        const isFinished =
          resolved.kind === 'precision'
            ? resolved.match.status === 'finished'
            : resolved.runner.status === 'finished';
        if (!isFinished) {
          // No ranked settlement for an incomplete/disconnected match.
          if (otherSocket) {
            const goneId =
              resolved.kind === 'precision' ? resolved.match.matchId : resolved.runner.matchId;
            otherSocket.emit(MatchOpponentDisconnectedEvent, { matchId: goneId });
          }
          if (resolved.kind === 'precision') {
            const match = resolved.match;
            if (match.roundTimer) clearTimeout(match.roundTimer);
            matches.delete(match.matchId);
            console.log(`[match] ${match.matchId} aborted: opponent disconnected`);
          } else {
            const runner = resolved.runner;
            runner.destroy();
            crownRushMatches.delete(runner.matchId);
            console.log(`[crownrush] ${runner.matchId} aborted: opponent disconnected`);
          }
        } else {
          const rematchWants =
            resolved.kind === 'precision'
              ? resolved.match.rematchWants
              : resolved.runner.rematchWants;
          const returnedToLobby =
            resolved.kind === 'precision'
              ? resolved.match.returnedToLobby
              : resolved.runner.returnedToLobby;
          const goneId =
            resolved.kind === 'precision' ? resolved.match.matchId : resolved.runner.matchId;
          returnedToLobby.add(player.playerId);
          rematchWants.delete(player.playerId);
          if (other && rematchWants.has(other.playerId) && otherSocket) {
            otherSocket.emit(RematchCancelledEvent, { matchId: goneId });
          }
          const playerCount =
            resolved.kind === 'precision' ? resolved.match.players.length : resolved.runner.players.length;
          if (returnedToLobby.size >= playerCount) {
            if (resolved.kind === 'precision') matches.delete(goneId);
            else {
              resolved.runner.destroy();
              crownRushMatches.delete(goneId);
            }
          }
        }
      }
    }

    connectedPlayers.delete(socket.id);
    if (player) {
      player.inMatch = false;
      broadcastPopulation(player.district);
      broadcastPlayers(player.district);
      console.log(`[district] ${player.displayName} left ${player.district}`);
    }
    console.log(`[socket] disconnected: ${socket.id} (${reason})`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Kerala Battle server listening on http://localhost:${PORT}`);
});

// Week-finalization recovery: finalize any ended but unfinalized weeks left
// behind by downtime. Correctness never depends on being awake at Monday
// 00:00: the current-competition endpoint and post-settlement hooks sweep too.
{
  const recovered = ensurePastWeeksFinalized(db, { activeRankedMatchCountForWeek });
  if (recovered.finalized.length > 0 || recovered.delayed.length > 0) {
    console.log(
      `[competition] startup recovery: finalized [${recovered.finalized.join(', ')}]` +
        (recovered.delayed.length > 0 ? ` delayed [${recovered.delayed.join(', ')}]` : ''),
    );
  }
}

// Periodic sweep (60s): catches week ends while the process stays up. Cheap:
// it only attempts work for ended, unfinalized weeks.
setInterval(() => {
  try {
    const swept = ensurePastWeeksFinalized(db, { activeRankedMatchCountForWeek });
    for (const weekId of swept.finalized) {
      const detail = getHistoryDetail(db, weekId);
      if (!detail) continue;
      io.emit(CompetitionWeekFinalizedEvent, {
        competitionWeekId: weekId,
        featuredGameType: detail.featuredGameType,
        weeklyMaster: detail.weeklyMaster,
        districtChampion: detail.districtChampion,
      });
    }
  } catch (error) {
    console.error('[competition] periodic finalization sweep failed:', error);
  }
}, 60_000);
