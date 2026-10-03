/**
 * Shared types and realtime event definitions for Kerala Battle.
 * Defined exactly once here; the web client and the server both import
 * from here instead of duplicating them.
 */

// ---------------------------------------------------------------------------
// Hello/welcome handshake
// ---------------------------------------------------------------------------

/** Event the client emits right after the Socket.IO connection is established. */
export const ClientHelloEvent = 'client:hello' as const;

/** Event the server emits back to acknowledge the client's hello. */
export const ServerWelcomeEvent = 'server:welcome' as const;

/** Payload the client sends with {@link ClientHelloEvent}. */
export interface ClientHelloPayload {
  /** Unix timestamp (ms) when the client sent the hello. */
  timestamp: number;
}

/** Payload the server sends back with {@link ServerWelcomeEvent}. */
export interface ServerWelcomePayload {
  message: string;
}

// ---------------------------------------------------------------------------
// Guest player identity + Kerala districts
// ---------------------------------------------------------------------------

/** Kerala's 14 districts. */
export const KERALA_DISTRICTS = [
  'Thiruvananthapuram',
  'Kollam',
  'Pathanamthitta',
  'Alappuzha',
  'Kottayam',
  'Idukki',
  'Ernakulam',
  'Thrissur',
  'Palakkad',
  'Malappuram',
  'Kozhikode',
  'Wayanad',
  'Kannur',
  'Kasaragod',
] as const;

/** One of Kerala's 14 districts. */
export type KeralaDistrict = (typeof KERALA_DISTRICTS)[number];

/** Guest player profile persisted in the browser's localStorage. */
export interface PlayerProfile {
  playerId: string;
  displayName: string;
  district: KeralaDistrict;
}

// ---------------------------------------------------------------------------
// District room events
// ---------------------------------------------------------------------------

/** Event the client emits to join (or switch to) a district room. */
export const PlayerJoinDistrictEvent = 'player:join-district' as const;

/** Event the server broadcasts with the current online count of a district. */
export const DistrictPopulationEvent = 'district:population' as const;

/** Payload the client sends with {@link PlayerJoinDistrictEvent}. */
export interface PlayerJoinDistrictPayload {
  playerId: string;
  displayName: string;
  district: KeralaDistrict;
}

/** Payload the server broadcasts with {@link DistrictPopulationEvent}. */
export interface DistrictPopulationPayload {
  district: KeralaDistrict;
  onlineCount: number;
}

// ---------------------------------------------------------------------------
// District social lobby: shared 2D space + movement
// ---------------------------------------------------------------------------

/** Logical lobby width in world coordinates (resolution-independent). */
export const LOBBY_WIDTH = 1000;

/** Logical lobby height in world coordinates (resolution-independent). */
export const LOBBY_HEIGHT = 700;

/** Minimum distance from the lobby edge for spawn positions. */
export const LOBBY_SPAWN_PADDING = 80;

/** Event the client emits to move within the lobby (throttled). */
export const PlayerMoveEvent = 'player:move' as const;

/** Event the server broadcasts when a player moves (to others in the room). */
export const PlayerMovedEvent = 'player:moved' as const;

/** Event the server emits with the full player snapshot of a district room. */
export const DistrictPlayersEvent = 'district:players' as const;

/** One player as seen inside a district lobby. Never includes socket IDs. */
export interface LobbyPlayer {
  playerId: string;
  displayName: string;
  x: number;
  y: number;
  /** True while the player is inside a Precision Clash match. */
  inMatch: boolean;
}

/** Payload the client sends with {@link PlayerMoveEvent}. */
export interface PlayerMovePayload {
  x: number;
  y: number;
}

/** Payload the server broadcasts with {@link PlayerMovedEvent}. */
export interface PlayerMovedPayload {
  playerId: string;
  x: number;
  y: number;
}

/** Payload the server emits with {@link DistrictPlayersEvent}. */
export interface DistrictPlayersPayload {
  district: KeralaDistrict;
  players: LobbyPlayer[];
}

// ---------------------------------------------------------------------------
// Challenge lifecycle
// ---------------------------------------------------------------------------

/** Client asks to challenge another player (challenger identity comes from the socket). */
export const ChallengeSendEvent = 'challenge:send' as const;
/** Server notifies the target of an incoming challenge. */
export const ChallengeReceivedEvent = 'challenge:received' as const;
/** Target accepts a challenge. */
export const ChallengeAcceptEvent = 'challenge:accept' as const;
/** Target declines a challenge. */
export const ChallengeDeclineEvent = 'challenge:decline' as const;
/** Challenger withdraws a pending challenge. */
export const ChallengeWithdrawEvent = 'challenge:withdraw' as const;
/** Server notifies both sides that a challenge will not proceed. */
export const ChallengeCancelledEvent = 'challenge:cancelled' as const;
/** Server notifies both sides that a challenge timed out. */
export const ChallengeExpiredEvent = 'challenge:expired' as const;
/** Server tells the challenger their challenge request was invalid. */
export const ChallengeFailedEvent = 'challenge:failed' as const;

export interface ChallengeSendPayload {
  targetPlayerId: string;
}

export interface ChallengeReceivedPayload {
  challengeId: string;
  challenger: {
    playerId: string;
    displayName: string;
  };
}

export interface ChallengeAcceptPayload {
  challengeId: string;
}

export interface ChallengeDeclinePayload {
  challengeId: string;
}

export interface ChallengeWithdrawPayload {
  targetPlayerId: string;
}

export type ChallengeCancelledReason =
  | 'declined'
  | 'withdrawn'
  | 'opponent-disconnected'
  | 'unavailable';

export interface ChallengeCancelledPayload {
  challengeId: string;
  reason: ChallengeCancelledReason;
}

export interface ChallengeExpiredPayload {
  challengeId: string;
}

export type ChallengeFailedReason =
  | 'target-not-found'
  | 'different-district'
  | 'self-challenge'
  | 'busy'
  | 'already-pending';

export interface ChallengeFailedPayload {
  reason: ChallengeFailedReason;
}

// ---------------------------------------------------------------------------
// Precision Clash match
// ---------------------------------------------------------------------------

/** Number of rounds per match. */
export const MATCH_TOTAL_ROUNDS = 3;
/** Synchronized pre-match countdown. */
export const MATCH_COUNTDOWN_MS = 3000;
/** Max time per round before a non-tapper scores 0. */
export const ROUND_DURATION_MS = 5000;
/** Marker oscillation period (left -> right -> left). */
export const ROUND_CYCLE_MS = 1600;
/** Pause between rounds. */
export const ROUND_PAUSE_MS = 2000;
/** Challenge auto-expiry. */
export const CHALLENGE_EXPIRY_MS = 15000;

/** Server starts a match for both players. */
export const MatchStartedEvent = 'match:started' as const;
/** Server starts a round (authoritative timestamps for marker sync). */
export const RoundStartedEvent = 'round:started' as const;
/** Server tells the room that a player tapped (no score revealed). */
export const RoundTapEvent = 'round:tap' as const;
/** Server reveals a round's scores once both players finished. */
export const RoundResultEvent = 'round:result' as const;
/** Server announces final totals and the winner. */
export const MatchFinishedEvent = 'match:finished' as const;
/** Server tells the remaining player their opponent disconnected. */
export const MatchOpponentDisconnectedEvent = 'match:opponent-disconnected' as const;
/** Client taps to stop the marker (server calculates the score). */
export const GameTapEvent = 'game:tap' as const;
/** Client requests an immediate rematch. */
export const GameRematchEvent = 'game:rematch' as const;
/** Client cancels a pending rematch request. */
export const GameRematchCancelEvent = 'game:rematch-cancel' as const;
/** Client leaves the match and returns to the lobby. */
export const GameReturnLobbyEvent = 'game:return-lobby' as const;
/** Server tells a player their rematch request is registered. */
export const RematchWaitingEvent = 'rematch:waiting' as const;
/** Server tells a waiting player the rematch will not happen. */
export const RematchCancelledEvent = 'rematch:cancelled' as const;

export interface MatchPlayerInfo {
  playerId: string;
  displayName: string;
}

export interface MatchStartedPayload {
  matchId: string;
  players: [MatchPlayerInfo, MatchPlayerInfo];
  totalRounds: number;
  /** Server timestamp (ms) when round 1 begins. */
  startsAt: number;
  /** Server timestamp (ms) when this message was sent (for clock offset). */
  serverNow: number;
}

export interface RoundStartedPayload {
  matchId: string;
  round: number;
  totalRounds: number;
  /** Server timestamp (ms) when the round began. */
  roundStartTime: number;
  cycleDurationMs: number;
  roundDurationMs: number;
}

export interface RoundTapPayload {
  matchId: string;
  round: number;
  playerId: string;
}

export interface RoundScoreEntry {
  playerId: string;
  displayName: string;
  score: number;
  label: string;
}

export interface RoundResultPayload {
  matchId: string;
  round: number;
  results: RoundScoreEntry[];
}

export interface MatchTotalEntry {
  playerId: string;
  displayName: string;
  total: number;
}

export interface MatchFinishedPayload {
  matchId: string;
  totals: MatchTotalEntry[];
  /** Null on a draw. */
  winnerPlayerId: string | null;
}

export interface MatchOpponentDisconnectedPayload {
  matchId: string;
}

export interface GameTapPayload {
  matchId: string;
  round: number;
}

export interface GameRematchPayload {
  matchId: string;
}

export interface GameRematchCancelPayload {
  matchId: string;
}

export interface GameReturnLobbyPayload {
  matchId: string;
}

export interface RematchWaitingPayload {
  matchId: string;
}

export interface RematchCancelledPayload {
  matchId: string;
}

// ---------------------------------------------------------------------------
// Typed Socket.IO event maps (no `any`)
// ---------------------------------------------------------------------------

/** Events the client may emit. */
export interface ClientToServerEvents {
  [ClientHelloEvent]: (payload: ClientHelloPayload) => void;
  [PlayerJoinDistrictEvent]: (payload: PlayerJoinDistrictPayload) => void;
  [PlayerMoveEvent]: (payload: PlayerMovePayload) => void;
  [ChallengeSendEvent]: (payload: ChallengeSendPayload) => void;
  [ChallengeAcceptEvent]: (payload: ChallengeAcceptPayload) => void;
  [ChallengeDeclineEvent]: (payload: ChallengeDeclinePayload) => void;
  [ChallengeWithdrawEvent]: (payload: ChallengeWithdrawPayload) => void;
  [GameTapEvent]: (payload: GameTapPayload) => void;
  [GameRematchEvent]: (payload: GameRematchPayload) => void;
  [GameRematchCancelEvent]: (payload: GameRematchCancelPayload) => void;
  [GameReturnLobbyEvent]: (payload: GameReturnLobbyPayload) => void;
}

/** Events the server may emit. */
export interface ServerToClientEvents {
  [ServerWelcomeEvent]: (payload: ServerWelcomePayload) => void;
  [DistrictPopulationEvent]: (payload: DistrictPopulationPayload) => void;
  [DistrictPlayersEvent]: (payload: DistrictPlayersPayload) => void;
  [PlayerMovedEvent]: (payload: PlayerMovedPayload) => void;
  [ChallengeReceivedEvent]: (payload: ChallengeReceivedPayload) => void;
  [ChallengeCancelledEvent]: (payload: ChallengeCancelledPayload) => void;
  [ChallengeExpiredEvent]: (payload: ChallengeExpiredPayload) => void;
  [ChallengeFailedEvent]: (payload: ChallengeFailedPayload) => void;
  [MatchStartedEvent]: (payload: MatchStartedPayload) => void;
  [RoundStartedEvent]: (payload: RoundStartedPayload) => void;
  [RoundTapEvent]: (payload: RoundTapPayload) => void;
  [RoundResultEvent]: (payload: RoundResultPayload) => void;
  [MatchFinishedEvent]: (payload: MatchFinishedPayload) => void;
  [MatchOpponentDisconnectedEvent]: (payload: MatchOpponentDisconnectedPayload) => void;
  [RematchWaitingEvent]: (payload: RematchWaitingPayload) => void;
  [RematchCancelledEvent]: (payload: RematchCancelledPayload) => void;
}
