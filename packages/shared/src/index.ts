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

/**
 * Task 11: emitted to all sockets when the server begins graceful shutdown.
 * Clients should show a "restarting" notice; Socket.IO reconnects on its own.
 */
export const ServerShutdownEvent = 'server:shutdown' as const;

/** Payload the server sends with {@link ServerShutdownEvent}. */
export interface ServerShutdownPayload {
  message: string;
}

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
// Game types (multi-game support)
// ---------------------------------------------------------------------------

/** Precision Clash 1v1 game-type identifier. */
export const GAME_TYPE_PRECISION_CLASH = 'precision-clash' as const;
/** Crown Rush 1v1 game-type identifier. */
export const GAME_TYPE_CROWN_RUSH = 'crown-rush' as const;

/** All supported ranked game types. Use the constants; never hard-code game strings. */
export type GameType = typeof GAME_TYPE_PRECISION_CLASH | typeof GAME_TYPE_CROWN_RUSH;

export function isGameType(value: unknown): value is GameType {
  return value === GAME_TYPE_PRECISION_CLASH || value === GAME_TYPE_CROWN_RUSH;
}

/** Small game registry: display metadata per game type. */
export const GAME_DEFINITIONS: Record<GameType, { label: string; tagline: string }> = {
  [GAME_TYPE_PRECISION_CLASH]: { label: 'Precision Clash', tagline: 'Precision Clash · 3 rounds' },
  [GAME_TYPE_CROWN_RUSH]: { label: 'Crown Rush', tagline: 'Crown Rush · first to 7 crowns' },
};

// ---------------------------------------------------------------------------
// Match mode + source (ranked weekly queue vs casual direct challenges)
// ---------------------------------------------------------------------------

/** Casual match: direct player challenge. Awards no ranking points. */
export const MATCH_MODE_CASUAL = 'casual' as const;
/** Ranked match: originated from the weekly battle queue. Settles into rankings. */
export const MATCH_MODE_RANKED = 'ranked' as const;

/** How a match was created. The server decides this authoritatively. */
export type MatchMode = typeof MATCH_MODE_CASUAL | typeof MATCH_MODE_RANKED;

/** Match created from a direct player-to-player challenge. */
export const MATCH_SOURCE_DIRECT_CHALLENGE = 'direct-challenge' as const;
/** Match created from the weekly ranked battle queue. */
export const MATCH_SOURCE_WEEKLY_QUEUE = 'weekly-queue' as const;

/** Where a match came from. The server decides this authoritatively. */
export type MatchSource = typeof MATCH_SOURCE_DIRECT_CHALLENGE | typeof MATCH_SOURCE_WEEKLY_QUEUE;

export function isMatchMode(value: unknown): value is MatchMode {
  return value === MATCH_MODE_CASUAL || value === MATCH_MODE_RANKED;
}

export function isMatchSource(value: unknown): value is MatchSource {
  return value === MATCH_SOURCE_DIRECT_CHALLENGE || value === MATCH_SOURCE_WEEKLY_QUEUE;
}

/**
 * Server-authoritative context for one match. Direct challenges are always
 * casual; only the weekly queue produces ranked matches. The client never
 * decides the mode.
 */
export interface MatchContext {
  matchMode: MatchMode;
  matchSource: MatchSource;
  /**
   * Ranked matches only: the competition week (by server match-start time)
   * the result settles into. Snapshotted at start so a week boundary
   * mid-match cannot move the result.
   */
  competitionWeekId?: string;
  /** District each player represents, aligned with the players array order. */
  districts: [KeralaDistrict, KeralaDistrict];
  /** Unix ms when the server started the match. */
  startedAtMs: number;
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
  gameType: GameType;
}

export interface ChallengeReceivedPayload {
  challengeId: string;
  challenger: {
    playerId: string;
    displayName: string;
  };
  gameType: GameType;
  /** Direct challenges are always casual. */
  matchMode: MatchMode;
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
  | 'already-pending'
  | 'invalid-game'
  /** A block exists in either direction; intentionally generic (no leak). */
  | 'challenge-unavailable';

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
  gameType: GameType;
  /** Server-authoritative: direct challenges are always casual. */
  matchMode: MatchMode;
  matchSource: MatchSource;
  players: [MatchPlayerInfo, MatchPlayerInfo];
  /** District each player represents, aligned with the players array order. */
  districts: [KeralaDistrict, KeralaDistrict];
  /** Ranked matches: the competition week (by server match-start time). */
  competitionWeekId?: string;
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
  gameType: GameType;
  /** Server-authoritative: direct challenges are always casual. */
  matchMode: MatchMode;
  matchSource: MatchSource;
  totals: MatchTotalEntry[];
  /** Null on a draw. */
  winnerPlayerId: string | null;
  /** District each player represented, aligned with the players/totals order. */
  districts: [KeralaDistrict, KeralaDistrict];
  /** Ranked matches: the competition week (by server match-start time). */
  competitionWeekId?: string;
  /**
   * Server-computed ranking awards, keyed by playerId. Present only when the
   * server settled this match into the persistent competition (ranked only).
   */
  settlement?: MatchSettlementMap;
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
// Persistent competition (weekly personal + district rankings)
// ---------------------------------------------------------------------------

/** IANA timezone for all competition-day and weekly-boundary calculations. */
export const COMPETITION_TIMEZONE = 'Asia/Kolkata' as const;

/** Personal weekly points for a win (before the completion bonus). */
export const COMPETITION_POINTS_WIN = 10;
/** Personal weekly points for a draw (before the completion bonus). */
export const COMPETITION_POINTS_DRAW = 6;
/** Personal weekly points for a loss (before the completion bonus). */
export const COMPETITION_POINTS_LOSS = 3;
/** Bonus awarded for completing a legitimate match (all rounds played). */
export const COMPETITION_POINTS_COMPLETION_BONUS = 2;
/** Maximum district points a single player can contribute per competition day. */
export const COMPETITION_DAILY_DISTRICT_CAP = 50;

/**
 * Server broadcasts this to all clients after settling a completed match.
 * The payload is intentionally tiny; clients refetch leaderboard data.
 */
export const CompetitionUpdatedEvent = 'competition:updated' as const;

export interface CompetitionUpdatedPayload {
  competitionWeekId: string;
}

/**
 * Server broadcasts this when a competition week becomes finalized (champions
 * crowned, history snapshotted). Lightweight: clients refetch history data.
 */
export const CompetitionWeekFinalizedEvent = 'competition:week-finalized' as const;

export interface WeeklyMasterSummary {
  playerId: string;
  displayName: string;
  district: KeralaDistrict;
  points: number;
  wins: number;
  matchesPlayed: number;
}

export interface DistrictChampionSummary {
  district: KeralaDistrict;
  points: number;
  wins: number;
  activePlayers: number;
}

export interface WeekFinalizedPayload {
  competitionWeekId: string;
  featuredGameType: GameType;
  weeklyMaster: WeeklyMasterSummary | null;
  districtChampion: DistrictChampionSummary | null;
}

/** One player's immutable snapshot row for a finalized week. */
export interface HistoricalPlayerResult {
  rank: number;
  playerId: string;
  /** Display name as snapshotted at finalization (renames don't rewrite history). */
  displayName: string;
  /** District the player represented during that week (not their current one). */
  district: KeralaDistrict;
  points: number;
  wins: number;
  losses: number;
  draws: number;
  matchesPlayed: number;
}

/** One district's immutable snapshot row for a finalized week. */
export interface HistoricalDistrictResult {
  rank: number;
  district: KeralaDistrict;
  points: number;
  wins: number;
  activePlayers: number;
  pointsPerActivePlayer: number;
}

/** A finalized week: champions + metadata, without the full standings. */
export interface HistoricalWeekSummary {
  competitionWeekId: string;
  featuredGameType: GameType;
  featuredGameLabel: string;
  startsAt: string;
  endsAt: string;
  /** Unix ms when the week was finalized. */
  finalizedAt: number;
  weeklyMaster: WeeklyMasterSummary | null;
  districtChampion: DistrictChampionSummary | null;
}

/** A finalized week with its complete snapshotted standings. */
export interface HistoricalWeekDetail extends HistoricalWeekSummary {
  players: HistoricalPlayerResult[];
  districts: HistoricalDistrictResult[];
}

export interface CompetitionHistoryPayload {
  weeks: HistoricalWeekSummary[];
}

/** The most recently finalized week before the current one, if any. */
export interface PreviousChampionInfo {
  weekId: string;
  weeklyMaster: WeeklyMasterSummary | null;
  districtChampion: DistrictChampionSummary | null;
}

/** One competition week: stable ID plus exact Asia/Kolkata boundaries. */
export interface CompetitionWeekInfo {
  /** Stable ID, e.g. "2026-W40". */
  id: string;
  /** Monday 00:00:00 IST, ISO 8601 with +05:30 offset. */
  startsAt: string;
  /** Sunday 23:59:59.999 IST, ISO 8601 with +05:30 offset. */
  endsAt: string;
}

/**
 * Server-computed awards for one player from one settled match.
 * The client never calculates these; it only displays them.
 */
export interface PlayerSettlement {
  /** Weekly personal points earned for this match (result + completion bonus). */
  personalPointsAwarded: number;
  /** District points actually credited after applying the daily cap. */
  districtPointsAwarded: number;
  /** Player's total weekly personal points after this match. */
  weeklyPersonalPoints: number;
  /** District contribution the player has used today, after this match. */
  dailyDistrictContribution: number;
  /** The daily district contribution cap in effect. */
  dailyDistrictContributionCap: number;
  /** District that received the district points (attribution at match time). */
  district: KeralaDistrict;
}

/** Settlement results for a finished match, keyed by playerId. */
export type MatchSettlementMap = Record<string, PlayerSettlement>;

export interface PlayerLeaderboardEntry {
  rank: number;
  playerId: string;
  displayName: string;
  district: KeralaDistrict;
  points: number;
  wins: number;
  matchesPlayed: number;
}

/** The requesting player's own weekly stats; null when they have no ranked matches. */
export interface MyWeeklyStats {
  rank: number;
  points: number;
  wins: number;
  losses: number;
  draws: number;
  matchesPlayed: number;
  /** 0..1 */
  winRate: number;
  district: KeralaDistrict;
  dailyDistrictContribution: number;
  dailyDistrictContributionCap: number;
}

export interface PlayersLeaderboardPayload {
  week: CompetitionWeekInfo;
  players: PlayerLeaderboardEntry[];
  me: MyWeeklyStats | null;
}

export interface DistrictLeaderboardEntry {
  rank: number;
  district: KeralaDistrict;
  /** Sum of capped district contributions for the week. */
  points: number;
  /** Players with at least one completed match this week. */
  activePlayers: number;
  wins: number;
  /** Informational only; ranking stays on total points. */
  pointsPerActivePlayer: number;
}

export interface DistrictsLeaderboardPayload {
  week: CompetitionWeekInfo;
  districts: DistrictLeaderboardEntry[];
}

// ---------------------------------------------------------------------------
// Crown Rush (second 1v1 game)
// ---------------------------------------------------------------------------

/** Crown Rush uses the same logical coordinate space as the district lobby. */
export const CROWN_RUSH_ARENA_WIDTH = LOBBY_WIDTH;
export const CROWN_RUSH_ARENA_HEIGHT = LOBBY_HEIGHT;
/** Player collision radius (world units). */
export const CROWN_RUSH_PLAYER_RADIUS = 24;
/** Crown pickup radius (world units). */
export const CROWN_RUSH_CROWN_RADIUS = 20;
/** Capture when the player center is within player radius + crown radius. */
export const CROWN_RUSH_CAPTURE_DISTANCE = CROWN_RUSH_PLAYER_RADIUS + CROWN_RUSH_CROWN_RADIUS;
/** Authoritative movement speed (world units per second). */
export const CROWN_RUSH_MOVE_SPEED = 260;
/** First player to this many crowns wins immediately. */
export const CROWN_RUSH_WIN_SCORE = 7;
/** Normal match duration. */
export const CROWN_RUSH_DURATION_MS = 45000;
/** Sudden-death failsafe: relocate the golden crown instead of declaring a draw. */
export const CROWN_RUSH_SUDDEN_DEATH_FAILSAFE_MS = 30000;
/** Delay before a new crown spawns after a capture. */
export const CROWN_RUSH_RESPAWN_DELAY_MS = 500;
/** Crown spawn padding from arena edges. */
export const CROWN_RUSH_SPAWN_PADDING = 80;
/** Minimum crown distance from each player at spawn. */
export const CROWN_RUSH_MIN_SPAWN_DISTANCE = 150;
/** Fixed starting positions (opposite sides, never overlapping). */
export const CROWN_RUSH_SPAWN_A = { x: 180, y: 350 } as const;
export const CROWN_RUSH_SPAWN_B = { x: 820, y: 350 } as const;

/** Client submits movement input (never positions). */
export const CrownRushInputEvent = 'crown-rush:input' as const;
/** Server broadcasts authoritative snapshots (~12 Hz). */
export const CrownRushStateEvent = 'crown-rush:state' as const;
/** Server starts a Crown Rush match for both players. */
export const CrownRushStartedEvent = 'crown-rush:started' as const;

export type CrownRushStatus = 'countdown' | 'playing' | 'suddenDeath' | 'finished';

export interface CrownRushInputPayload {
  matchId: string;
  /** -1..1 (clamped + normalized server-side). */
  xAxis: number;
  /** -1..1 (clamped + normalized server-side). */
  yAxis: number;
  /** Client sequence number (for debugging; not trusted). */
  sequence: number;
}

export interface CrownRushPlayerState {
  playerId: string;
  displayName: string;
  x: number;
  y: number;
  score: number;
}

export interface CrownRushStatePayload {
  matchId: string;
  /** Server timestamp (ms) when the snapshot was taken. */
  serverTime: number;
  status: CrownRushStatus;
  /** Ms left on the match clock (0 during sudden death). */
  timeRemainingMs: number;
  suddenDeath: boolean;
  players: CrownRushPlayerState[];
  crown: { x: number; y: number; golden: boolean } | null;
  /** Most recent capture (clients show a toast when captureSeq changes). */
  lastCapture: { playerId: string; displayName: string; captureSeq: number } | null;
}

export interface CrownRushStartedPayload {
  matchId: string;
  gameType: GameType;
  /** Server-authoritative: direct challenges are always casual. */
  matchMode: MatchMode;
  matchSource: MatchSource;
  players: [MatchPlayerInfo, MatchPlayerInfo];
  /** District each player represents, aligned with the players array order. */
  districts: [KeralaDistrict, KeralaDistrict];
  /** Ranked matches: the competition week (by server match-start time). */
  competitionWeekId?: string;
  /** Server timestamp (ms) when movement begins (3-2-1-GO). */
  startsAt: number;
  /** Server timestamp (ms) when this message was sent (for clock offset). */
  serverNow: number;
}

// ---------------------------------------------------------------------------
// Weekly battle queue (ranked cross-district matchmaking)
// ---------------------------------------------------------------------------

/** Client asks to join the weekly ranked battle queue. No game choice: the server decides. */
export const RankedQueueJoinEvent = 'ranked-queue:join' as const;
/** Client leaves the weekly ranked battle queue. */
export const RankedQueueCancelEvent = 'ranked-queue:cancel' as const;
/** Server reports queue state changes (searching / cancelled / week changed). */
export const RankedQueueStatusEvent = 'ranked-queue:status' as const;
/** Server tells a player a cross-district opponent was found. */
export const RankedQueueMatchedEvent = 'ranked-queue:matched' as const;
/** Server tells a player their queue request was rejected. */
export const RankedQueueErrorEvent = 'ranked-queue:error' as const;

/** Payload for {@link RankedQueueJoinEvent}. Intentionally empty: every
 * matchmaking input (game, week, district, identity) is server-controlled. */
export type RankedQueueJoinPayload = Record<string, never>;

/** Payload for {@link RankedQueueCancelEvent}. */
export type RankedQueueCancelPayload = Record<string, never>;

export type RankedQueueStatusKind = 'searching' | 'cancelled' | 'week-changed';

export interface RankedQueueStatusPayload {
  status: RankedQueueStatusKind;
  /** Unix ms when the player entered the queue (searching only). */
  joinedAt?: number;
  /** This week's featured game (searching only). */
  featuredGameType?: GameType;
  /** This week's competition ID (searching only). */
  competitionWeekId?: string;
  /** Live number of players currently searching (never fabricated). */
  queueSize?: number;
}

export interface RankedQueueOpponentSummary {
  playerId: string;
  displayName: string;
  district: KeralaDistrict;
}

export interface RankedQueueMatchedPayload {
  /** Client-side correlation id for the pending ranked match. */
  matchId: string;
  gameType: GameType;
  competitionWeekId: string;
  myDistrict: KeralaDistrict;
  opponent: RankedQueueOpponentSummary;
}

export type RankedQueueErrorReason =
  | 'already-queued'
  | 'in-match'
  | 'challenge-pending'
  | 'not-registered'
  | 'unavailable'
  | 'week-unavailable';

export interface RankedQueueErrorPayload {
  reason: RankedQueueErrorReason;
}

// ---------------------------------------------------------------------------
// Current competition (week + featured game)
// ---------------------------------------------------------------------------

export interface FeaturedGameInfo {
  gameType: GameType;
  label: string;
}

export interface CurrentCompetitionPayload {
  week: CompetitionWeekInfo;
  featuredGame: FeaturedGameInfo;
  /** Most recently finalized week before the current one; null when none. */
  previousChampion: PreviousChampionInfo | null;
}

// ---------------------------------------------------------------------------
// District voice chat (LiveKit proximity voice, lobby only)
// ---------------------------------------------------------------------------

/**
 * Proximity voice tuning, defined once and shared. Distances are in the same
 * world units as the Task 3 lobby (1000 x 700). The fade curve is linear:
 * full volume at or below FULL_VOLUME_DISTANCE, silence at or above
 * MAX_HEARING_DISTANCE, linear interpolation between.
 */
export const VOICE_FULL_VOLUME_DISTANCE = 120;
export const VOICE_MAX_HEARING_DISTANCE = 320;

/** How often (ms) remote participant volumes are recomputed from positions. */
export const VOICE_VOLUME_UPDATE_INTERVAL_MS = 125;

/**
 * Lerp factor applied per volume update when fading toward the target volume.
 * Keeps transitions smooth instead of snapping 1 -> 0.
 */
export const VOICE_VOLUME_SMOOTHING = 0.35;

/** Minimum applied-volume delta before LiveKit's setVolume is called again. */
export const VOICE_VOLUME_APPLY_THRESHOLD = 0.02;

/**
 * Client asks the server for a LiveKit token for their CURRENT district.
 * Identity comes from the socket itself, so the payload is intentionally
 * empty: the client cannot request another district's room.
 */
export const VoiceTokenEvent = 'voice:token' as const;

/** Payload for {@link VoiceTokenEvent}. Intentionally empty. */
export type VoiceTokenRequestPayload = Record<string, never>;

export type VoiceTokenErrorReason = 'not-registered' | 'voice-disabled' | 'rate-limited';

export type VoiceTokenResponse =
  | { ok: true; token: string; url: string; roomName: string }
  | { ok: false; error: VoiceTokenErrorReason };

/** Participant metadata the server embeds in each voice token (no secrets). */
export interface VoiceParticipantMetadata {
  playerId: string;
  displayName: string;
  district: KeralaDistrict;
}

/** Local voice connection lifecycle state shown in the lobby UI. */
export type VoiceConnectionStatus = 'idle' | 'joining' | 'connected' | 'error';

/**
 * Why the local player last left voice. Drives the rejoin hint shown in the
 * lobby ("Voice disconnected because you changed district.", etc.).
 */
export type VoiceLeaveReason = 'user' | 'match' | 'district-change' | 'socket-disconnect';

// ---------------------------------------------------------------------------
// Authentication (Task 10: Google sign-in, server sessions, stable playerId)
// ---------------------------------------------------------------------------

/** Server tells a socket its game registration was rejected: sign-in required. */
export const AuthRequiredEvent = 'auth:required' as const;

/** Public account identity returned by the auth API. Never includes Google
 * subject, email, session identifiers, or moderation internals. */
export interface AuthPlayerInfo {
  playerId: string;
  displayName: string;
  /** Null until the player completes onboarding (name + district). */
  district: KeralaDistrict | null;
}

/** Payload for GET /api/auth/me. */
export interface AuthMePayload {
  authenticated: boolean;
  player: AuthPlayerInfo | null;
  /** True when the account was created by this login. */
  isNewAccount?: boolean;
  /** True when name/district still need to be chosen. */
  profileComplete?: boolean;
}

/** Payload for GET /api/auth/config. Public; contains no secrets. */
export interface AuthConfigPayload {
  /** Whether GOOGLE_CLIENT_ID is configured (Google button usable). */
  googleConfigured: boolean;
  /** The Google OAuth client id for the GIS button (public by design). */
  googleClientId: string | null;
  /** Whether AUTH_REQUIRED=true (guests cannot play). */
  authRequired: boolean;
}

/** Payload the client sends with POST /api/auth/google. */
export interface GoogleLoginRequest {
  /** Google ID token (JWT) from Google Identity Services. */
  idToken: string;
  /**
   * The client's current Socket.IO socket id. The server uses it ONLY to
   * look up the already-registered guest identity on that socket and claim
   * it when safe. The client can never choose the claimed playerId itself.
   */
  socketId?: string;
}

/** Payload the server returns from POST /api/auth/google. */
export interface GoogleLoginResponse {
  authenticated: boolean;
  player: AuthPlayerInfo;
  isNewAccount: boolean;
  profileComplete: boolean;
}

// ---------------------------------------------------------------------------
// Safety (Task 10: persistent blocking + player reporting)
// ---------------------------------------------------------------------------

/** Report reasons shown in the Report dialog. */
export const REPORT_REASONS = [
  'harassment',
  'voice-abuse',
  'inappropriate-name',
  'cheating',
  'spam',
  'other',
] as const;

/** One of the report reasons. */
export type ReportReason = (typeof REPORT_REASONS)[number];

export function isReportReason(value: unknown): value is ReportReason {
  return (
    typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value)
  );
}

/** Human labels for the report reasons. */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  harassment: 'Harassment',
  'voice-abuse': 'Voice abuse',
  'inappropriate-name': 'Inappropriate name/profile',
  cheating: 'Cheating',
  spam: 'Spam',
  other: 'Other',
};

/** Trusted report context kinds. Free-form client metadata is never trusted. */
export const REPORT_CONTEXT_TYPES = [
  'district-lobby',
  'casual-match',
  'ranked-match',
  'voice',
] as const;

export type ReportContextType = (typeof REPORT_CONTEXT_TYPES)[number];

export function isReportContextType(value: unknown): value is ReportContextType {
  return (
    typeof value === 'string' && (REPORT_CONTEXT_TYPES as readonly string[]).includes(value)
  );
}

/** One blocked player, as returned by GET /api/blocks. */
export interface BlockEntry {
  playerId: string;
  displayName: string;
  createdAt: number;
}

/** Payload the client sends with POST /api/reports. */
export interface CreateReportRequest {
  reportedPlayerId: string;
  reason: ReportReason;
  /** Optional, max 500 chars. Treated as untrusted text. */
  description?: string;
  contextType?: ReportContextType;
  /** Server-known match id for match contexts; otherwise untrusted/opaque. */
  contextId?: string;
}

/** Payload the server returns from POST /api/reports. */
export interface CreateReportResponse {
  ok: boolean;
  reportId: string;
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
  [CrownRushInputEvent]: (payload: CrownRushInputPayload) => void;
  [RankedQueueJoinEvent]: (payload: RankedQueueJoinPayload) => void;
  [RankedQueueCancelEvent]: (payload: RankedQueueCancelPayload) => void;
  [VoiceTokenEvent]: (
    payload: VoiceTokenRequestPayload,
    callback: (response: VoiceTokenResponse) => void,
  ) => void;
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
  [CompetitionUpdatedEvent]: (payload: CompetitionUpdatedPayload) => void;
  [CompetitionWeekFinalizedEvent]: (payload: WeekFinalizedPayload) => void;
  [CrownRushStartedEvent]: (payload: CrownRushStartedPayload) => void;
  [CrownRushStateEvent]: (payload: CrownRushStatePayload) => void;
  [RankedQueueStatusEvent]: (payload: RankedQueueStatusPayload) => void;
  [RankedQueueMatchedEvent]: (payload: RankedQueueMatchedPayload) => void;
  [RankedQueueErrorEvent]: (payload: RankedQueueErrorPayload) => void;
  [AuthRequiredEvent]: () => void;
  [ServerShutdownEvent]: (payload: ServerShutdownPayload) => void;
}
