import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import {
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
  DistrictPlayersEvent,
  DistrictPopulationEvent,
  GameRematchCancelEvent,
  GameRematchEvent,
  GameReturnLobbyEvent,
  GameTapEvent,
  KERALA_DISTRICTS,
  LOBBY_HEIGHT,
  LOBBY_SPAWN_PADDING,
  LOBBY_WIDTH,
  MATCH_COUNTDOWN_MS,
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
  RematchCancelledEvent,
  RematchWaitingEvent,
  RoundResultEvent,
  RoundStartedEvent,
  RoundTapEvent,
  ServerWelcomeEvent,
  type ChallengeCancelledReason,
  type ChallengeFailedReason,
  type ClientHelloPayload,
  type ClientToServerEvents,
  type DistrictPlayersPayload,
  type KeralaDistrict,
  type LobbyPlayer,
  type MatchFinishedPayload,
  type MatchStartedPayload,
  type PlayerJoinDistrictPayload,
  type PlayerMovePayload,
  type PlayerMovedPayload,
  type RoundResultPayload,
  type RoundScoreEntry,
  type ServerToClientEvents,
  type ServerWelcomePayload,
} from '@kerala-battle/shared';

dotenv.config();

const PORT = Number(process.env.PORT) || 3001;
const WEB_URL = process.env.WEB_URL || 'http://localhost:5173';

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
app.use(cors({ origin: WEB_URL }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: WEB_URL },
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
  district: KeralaDistrict;
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

function createMatch(a: MatchParticipant, b: MatchParticipant, district: KeralaDistrict): void {
  const matchId = randomUUID();
  const match: ActiveMatch = {
    matchId,
    district,
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
    players: [
      { playerId: a.playerId, displayName: a.displayName },
      { playerId: b.playerId, displayName: b.displayName },
    ],
    totalRounds: MATCH_TOTAL_ROUNDS,
    startsAt: serverNow + MATCH_COUNTDOWN_MS,
    serverNow,
  };
  io.to(matchRoom(matchId)).emit(MatchStartedEvent, payload);
  console.log(`[match] ${matchId} created: ${a.displayName} vs ${b.displayName}`);
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
  const payload: MatchFinishedPayload = { matchId, totals, winnerPlayerId };
  io.to(matchRoom(matchId)).emit(MatchFinishedEvent, payload);
  console.log(
    `[match] ${matchId} finished: ${totals.map((t) => `${t.displayName}=${t.total}`).join(', ')}`,
  );
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

  socket.on(ClientHelloEvent, (payload: ClientHelloPayload) => {
    console.log(`[socket] ${ClientHelloEvent} from ${socket.id}`, payload);
    const welcome: ServerWelcomePayload = { message: 'Connected to Kerala Battle' };
    socket.emit(ServerWelcomeEvent, welcome);
  });

  socket.on(PlayerJoinDistrictEvent, (payload) => {
    if (!isValidJoinPayload(payload)) {
      console.warn(`[socket] invalid ${PlayerJoinDistrictEvent} from ${socket.id}`);
      return;
    }
    const previous = connectedPlayers.get(socket.id);
    // A brand-new socket (or a district switch) gets a fresh spawn point.
    // A same-socket re-join of the same district keeps its position.
    const spawn =
      previous && previous.district === payload.district
        ? { x: previous.x, y: previous.y }
        : randomSpawn();
    const next: ConnectedPlayer = {
      socketId: socket.id,
      playerId: payload.playerId,
      displayName: payload.displayName.trim(),
      district: payload.district,
      x: spawn.x,
      y: spawn.y,
      inMatch: previous?.inMatch ?? false,
    };
    connectedPlayers.set(socket.id, next);

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
    const fail = (reason: ChallengeFailedReason): void => {
      socket.emit(ChallengeFailedEvent, { reason });
    };
    if (!challenger || typeof targetPlayerId !== 'string') return;
    const target = findPlayerById(targetPlayerId);
    if (!target) return fail('target-not-found');
    if (target.playerId === challenger.playerId) return fail('self-challenge');
    if (target.district !== challenger.district) return fail('different-district');
    if (busyByPlayerId.has(challenger.playerId) || busyByPlayerId.has(target.playerId)) {
      return fail('busy');
    }
    if (challengeByChallenger.has(challenger.playerId) || challengeByTarget.has(target.playerId)) {
      return fail('already-pending');
    }
    const challengeId = randomUUID();
    const challenge: PendingChallenge = {
      challengeId,
      challengerSocketId: socket.id,
      challengerPlayerId: challenger.playerId,
      challengerName: challenger.displayName,
      targetSocketId: target.socketId,
      targetPlayerId: target.playerId,
      district: challenger.district,
      timer: setTimeout(() => expireChallenge(challengeId), CHALLENGE_EXPIRY_MS),
    };
    challenges.set(challengeId, challenge);
    challengeByChallenger.set(challenger.playerId, challengeId);
    challengeByTarget.set(target.playerId, challengeId);
    io.to(target.socketId).emit(ChallengeReceivedEvent, {
      challengeId,
      challenger: { playerId: challenger.playerId, displayName: challenger.displayName },
    });
    console.log(`[challenge] ${challengeId}: ${challenger.displayName} -> ${target.displayName}`);
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
    createMatch(
      {
        socketId: challenger.socketId,
        playerId: challenger.playerId,
        displayName: challenger.displayName,
      },
      { socketId: target.socketId, playerId: target.playerId, displayName: target.displayName },
      challenger.district,
    );
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

  // ------------------------- match play -------------------------

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
    const match = getMatch(payload?.matchId);
    if (!match || match.status !== 'finished') return;
    const me = participantOf(match, socket.id);
    if (!me || match.returnedToLobby.has(me.playerId)) return;
    match.rematchWants.add(me.playerId);
    const other = match.players.find((participant) => participant.playerId !== me.playerId);
    if (!other) return;
    if (match.rematchWants.has(other.playerId) && !match.returnedToLobby.has(other.playerId)) {
      const meConn = findPlayerById(me.playerId);
      const otherConn = findPlayerById(other.playerId);
      if (!meConn || !otherConn || meConn.district !== otherConn.district) {
        socket.emit(RematchCancelledEvent, { matchId: match.matchId });
        return;
      }
      for (const participant of match.players) {
        io.sockets.sockets.get(participant.socketId)?.leave(matchRoom(match.matchId));
      }
      matches.delete(match.matchId);
      createMatch(
        { socketId: meConn.socketId, playerId: meConn.playerId, displayName: meConn.displayName },
        {
          socketId: otherConn.socketId,
          playerId: otherConn.playerId,
          displayName: otherConn.displayName,
        },
        meConn.district,
      );
    } else {
      socket.emit(RematchWaitingEvent, { matchId: match.matchId });
    }
  });

  socket.on(GameRematchCancelEvent, (payload) => {
    const match = getMatch(payload?.matchId);
    if (!match || match.status !== 'finished') return;
    const me = participantOf(match, socket.id);
    if (me) match.rematchWants.delete(me.playerId);
  });

  socket.on(GameReturnLobbyEvent, (payload) => {
    const player = connectedPlayers.get(socket.id);
    const match = getMatch(payload?.matchId);
    const participant = match ? participantOf(match, socket.id) : undefined;
    if (match && participant) {
      match.returnedToLobby.add(participant.playerId);
      match.rematchWants.delete(participant.playerId);
      socket.leave(matchRoom(match.matchId));
      const other = match.players.find((p) => p.playerId !== participant.playerId);
      const otherSocket = other ? io.sockets.sockets.get(other.socketId) : undefined;
      if (other && match.rematchWants.has(other.playerId) && otherSocket) {
        otherSocket.emit(RematchCancelledEvent, { matchId: match.matchId });
      }
      if (match.returnedToLobby.size >= match.players.length) {
        matches.delete(match.matchId);
      }
    }
    if (player) setBusy(player.playerId, null);
    else if (participant) busyByPlayerId.delete(participant.playerId);
  });

  // ------------------------- disconnect -------------------------

  socket.on('disconnect', (reason) => {
    const player = connectedPlayers.get(socket.id);

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
      const match = matchId ? matches.get(matchId) : undefined;
      if (match) {
        const other = match.players.find((p) => p.playerId !== player.playerId);
        const otherSocket = other ? io.sockets.sockets.get(other.socketId) : undefined;
        if (match.status !== 'finished') {
          if (otherSocket) {
            otherSocket.emit(MatchOpponentDisconnectedEvent, { matchId: match.matchId });
          }
          if (match.roundTimer) clearTimeout(match.roundTimer);
          matches.delete(match.matchId);
          console.log(`[match] ${match.matchId} aborted: opponent disconnected`);
        } else {
          match.returnedToLobby.add(player.playerId);
          match.rematchWants.delete(player.playerId);
          if (other && match.rematchWants.has(other.playerId) && otherSocket) {
            otherSocket.emit(RematchCancelledEvent, { matchId: match.matchId });
          }
          if (match.returnedToLobby.size >= match.players.length) {
            matches.delete(match.matchId);
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
