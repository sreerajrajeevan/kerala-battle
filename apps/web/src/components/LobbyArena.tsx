import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChallengeAcceptEvent,
  ChallengeCancelledEvent,
  ChallengeDeclineEvent,
  ChallengeExpiredEvent,
  ChallengeFailedEvent,
  ChallengeReceivedEvent,
  ChallengeSendEvent,
  ChallengeWithdrawEvent,
  DistrictPlayersEvent,
  GAME_TYPE_PRECISION_CLASH,
  LOBBY_HEIGHT,
  LOBBY_WIDTH,
  PlayerJoinDistrictEvent,
  PlayerMoveEvent,
  PlayerMovedEvent,
  isGameType,
  type ChallengeCancelledReason,
  type ChallengeFailedReason,
  type ChallengeReceivedPayload,
  type DistrictPlayersPayload,
  type GameType,
  type LobbyPlayer,
  type MatchMode,
  type PlayerJoinDistrictPayload,
  type PlayerMovedPayload,
  type PlayerProfile,
} from '@kerala-battle/shared';
import { avatarColor } from '../lib/visual';
import { usePreviousChampion } from '../lib/competition';
import type { DistrictSocket } from '../App';
import PlayerCard from './PlayerCard';
import VirtualJoystick from './VirtualJoystick';
import { IncomingChallengeModal, OutgoingChallengeModal, Toast } from './ChallengeUI';
import VoiceProvider from '../voice/VoiceProvider';
import { useVoice, type VoiceController } from '../voice/voiceContext';
import VoiceControls from '../voice/VoiceControls';

const MOVE_SPEED = 260; // world units per second
const SEND_INTERVAL_MS = 66; // ~15 movement updates per second while moving
const RECONCILE_DISTANCE = 100; // snap local position if server disagrees by this much
const TELEPORT_DISTANCE = 300; // snap remote players beyond this (rejoins, not lag)

interface TrackedPlayer {
  x: number;
  y: number;
  tx: number;
  ty: number;
}

interface LobbyArenaProps {
  socket: DistrictSocket | null;
  profile: PlayerProfile;
  connected: boolean;
  /** True while the local player is inside a match overlay. */
  matchActive: boolean;
  isDev: boolean;
  serverUrl: string;
  /** Lets App force-leave voice on match start / district change. */
  voiceControllerRef: { current: VoiceController | null };
}

const KEY_DIRECTIONS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

function clampLobby(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

function joinDistrictPayload(profile: PlayerProfile): PlayerJoinDistrictPayload {
  return {
    playerId: profile.playerId,
    displayName: profile.displayName,
    district: profile.district,
  };
}

/**
 * Subtle voice indicator rendered under each avatar. Shows the local mic
 * state for the local player, and speaking/muted state for remote players
 * who are in the district voice room.
 */
function VoiceAvatarBadge({ playerId, isLocal }: { playerId: string; isLocal: boolean }) {
  const voice = useVoice();
  if (voice.status !== 'connected') return null;
  if (isLocal) {
    return (
      <span className="voice-badge" title={voice.micMuted ? 'Microphone muted' : 'Microphone on'}>
        {voice.micMuted ? '🔇' : '🎙️'}
      </span>
    );
  }
  if (!voice.voiceParticipantIds.has(playerId)) return null;
  if (voice.locallyMutedIds.has(playerId)) {
    return (
      <span className="voice-badge" title="Muted by you (only you)">
        🔇
      </span>
    );
  }
  if (voice.speakingIds.has(playerId)) {
    return (
      <span className="voice-badge voice-speaking" title="Speaking">
        🎙️✨
      </span>
    );
  }
  if (voice.remoteMicMutedIds.has(playerId)) {
    return (
      <span className="voice-badge" title="Microphone muted">
        🔇
      </span>
    );
  }
  return (
    <span className="voice-badge" title="In voice chat">
      🎙️
    </span>
  );
}

export default function LobbyArena({
  socket,
  profile,
  connected,
  matchActive,
  isDev,
  serverUrl,
  voiceControllerRef,
}: LobbyArenaProps) {
  const [roster, setRoster] = useState<LobbyPlayer[]>([]);
  const [fps, setFps] = useState(0);
  const [selected, setSelected] = useState<LobbyPlayer | null>(null);
  const [outgoing, setOutgoing] = useState<{
    targetPlayerId: string;
    targetName: string;
    gameType: GameType;
  } | null>(null);
  const [incoming, setIncoming] = useState<{
    challengeId: string;
    challengerName: string;
    gameType: GameType;
    matchMode: MatchMode;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const positionsRef = useRef(new Map<string, TrackedPlayer>());
  const nodesRef = useRef(new Map<string, HTMLDivElement>());
  const keysRef = useRef(new Set<'up' | 'down' | 'left' | 'right'>());
  // Virtual joystick vector (shared component writes into this ref).
  const joyRef = useRef({ x: 0, y: 0 });
  const dirtyRef = useRef(false);
  const lastSentRef = useRef(0);
  const framesRef = useRef(0);
  const fpsAtRef = useRef(performance.now());
  const toastTimerRef = useRef(0);

  const profileRef = useRef(profile);
  profileRef.current = profile;
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const socketRef = useRef(socket);
  socketRef.current = socket;
  const matchActiveRef = useRef(matchActive);
  matchActiveRef.current = matchActive;

  // Last week's Weekly Master, server-authoritative: their avatar wears the
  // crown for the whole following week.
  const previousChampion = usePreviousChampion(serverUrl, socket);
  const masterPlayerId = previousChampion?.weeklyMaster?.playerId ?? null;
  // Voice proximity reads the existing server-authoritative lobby positions:
  // no second location system. Pulled by the voice provider ~8x/sec.
  const getVoicePositions = useCallback(() => {    const localId = profileRef.current.playerId;
    const local = positionsRef.current.get(localId);
    const remotes = new Map<string, { x: number; y: number }>();
    for (const [id, tracked] of positionsRef.current) {
      if (id !== localId) remotes.set(id, { x: tracked.x, y: tracked.y });
    }
    return {
      local: local ? { x: local.x, y: local.y } : null,
      remotes,
    };
  }, []);

  const showToast = (message: string): void => {
    setToast(message);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3500);
  };

  const cancelledMessage = (reason: ChallengeCancelledReason): string => {
    switch (reason) {
      case 'declined':
        return 'Challenge declined';
      case 'withdrawn':
        return 'Challenge withdrawn';
      case 'opponent-disconnected':
        return 'Opponent disconnected';
      case 'unavailable':
        return 'Player is no longer available';
    }
  };

  const failedMessage = (reason: ChallengeFailedReason): string => {
    switch (reason) {
      case 'target-not-found':
        return 'That player is no longer here';
      case 'different-district':
        return 'You can only challenge players in your district';
      case 'self-challenge':
        return 'You cannot challenge yourself';
      case 'busy':
        return 'That player is currently in a match';
      case 'already-pending':
        return 'A challenge is already pending';
      case 'invalid-game':
        return 'Please pick a game to play';
    }
  };

  const positionNode = (playerId: string, x: number, y: number) => {
    const el = nodesRef.current.get(playerId);
    if (!el) return;
    el.style.left = `${(x / LOBBY_WIDTH) * 100}%`;
    el.style.top = `${(y / LOBBY_HEIGHT) * 100}%`;
    el.dataset.x = String(Math.round(x));
    el.dataset.y = String(Math.round(y));
  };

  // Socket listeners: snapshots + remote movement targets.
  // Runs when the socket becomes available (it is created in the parent
  // effect, which runs after this child's first render).
  useEffect(() => {
    if (!socket) return;

    const handlePlayers = (payload: DistrictPlayersPayload) => {
      const current = profileRef.current;
      if (!current || payload.district !== current.district) return;
      setRoster(payload.players);
      const seen = new Set<string>();
      for (const player of payload.players) {
        seen.add(player.playerId);
        const tracked = positionsRef.current.get(player.playerId);
        if (tracked) {
          tracked.tx = player.x;
          tracked.ty = player.y;
          if (player.playerId === current.playerId) {
            // Reconcile local prediction with the server's authoritative position.
            const drift = Math.hypot(tracked.x - player.x, tracked.y - player.y);
            if (drift > RECONCILE_DISTANCE) {
              tracked.x = player.x;
              tracked.y = player.y;
              positionNode(player.playerId, player.x, player.y);
            }
          }
        } else {
          positionsRef.current.set(player.playerId, {
            x: player.x,
            y: player.y,
            tx: player.x,
            ty: player.y,
          });
        }
      }
      for (const id of [...positionsRef.current.keys()]) {
        if (!seen.has(id)) positionsRef.current.delete(id);
      }
    };

    const handleMoved = (payload: PlayerMovedPayload) => {
      if (payload.playerId === profileRef.current?.playerId) return;
      const tracked = positionsRef.current.get(payload.playerId);
      if (tracked) {
        tracked.tx = payload.x;
        tracked.ty = payload.y;
      }
    };

    socket.on(DistrictPlayersEvent, handlePlayers);
    socket.on(PlayerMovedEvent, handleMoved);

    const handleChallengeReceived = (payload: ChallengeReceivedPayload) => {
      setSelected(null);
      setIncoming({
        challengeId: payload.challengeId,
        challengerName: payload.challenger.displayName,
        gameType: isGameType(payload.gameType) ? payload.gameType : GAME_TYPE_PRECISION_CLASH,
        matchMode: payload.matchMode,
      });
    };
    const handleChallengeCancelled = (payload: {
      challengeId: string;
      reason: ChallengeCancelledReason;
    }) => {
      setIncoming(null);
      setOutgoing(null);
      showToast(cancelledMessage(payload.reason));
    };
    const handleChallengeExpired = () => {
      setIncoming(null);
      setOutgoing(null);
      showToast('Challenge expired');
    };
    const handleChallengeFailed = (payload: { reason: ChallengeFailedReason }) => {
      setOutgoing(null);
      showToast(failedMessage(payload.reason));
    };

    socket.on(ChallengeReceivedEvent, handleChallengeReceived);
    socket.on(ChallengeCancelledEvent, handleChallengeCancelled);
    socket.on(ChallengeExpiredEvent, handleChallengeExpired);
    socket.on(ChallengeFailedEvent, handleChallengeFailed);
    // If the socket connected (and joined) before these listeners attached,
    // re-join to receive a fresh snapshot. Idempotent server-side.
    if (socket.connected && profileRef.current) {
      socket.emit(PlayerJoinDistrictEvent, joinDistrictPayload(profileRef.current));
    }
    return () => {
      socket.off(DistrictPlayersEvent, handlePlayers);
      socket.off(PlayerMovedEvent, handleMoved);
      socket.off(ChallengeReceivedEvent, handleChallengeReceived);
      socket.off(ChallengeCancelledEvent, handleChallengeCancelled);
      socket.off(ChallengeExpiredEvent, handleChallengeExpired);
      socket.off(ChallengeFailedEvent, handleChallengeFailed);
    };
  }, [socket]);

  // Entering a match clears any pending challenge UI.
  useEffect(() => {
    if (matchActive) {
      setSelected(null);
      setOutgoing(null);
      setIncoming(null);
    }
  }, [matchActive]);

  // Keyboard movement.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = KEY_DIRECTIONS[event.code];
      if (!direction) return;
      event.preventDefault();
      keysRef.current.add(direction);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const direction = KEY_DIRECTIONS[event.code];
      if (direction) keysRef.current.delete(direction);
    };
    const onBlur = () => keysRef.current.clear();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Main loop: local movement (client-side prediction) + remote interpolation.
  // Positions live in refs and are written straight to the DOM so React never
  // rerenders at animation frequency.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      const localId = profileRef.current?.playerId;
      const local = localId ? positionsRef.current.get(localId) : undefined;

      // Lobby movement is disabled while the local player is inside a match.
      if (local && localId && connectedRef.current && !matchActiveRef.current) {
        let vx = 0;
        let vy = 0;
        const keys = keysRef.current;
        if (keys.has('up')) vy -= 1;
        if (keys.has('down')) vy += 1;
        if (keys.has('left')) vx -= 1;
        if (keys.has('right')) vx += 1;
        vx += joyRef.current.x;
        vy += joyRef.current.y;

        const magnitude = Math.hypot(vx, vy);
        if (magnitude > 0.05) {
          // Normalize so diagonal movement is not faster than straight movement.
          const nx = vx / Math.max(1, magnitude);
          const ny = vy / Math.max(1, magnitude);
          const newX = clampLobby(local.x + nx * MOVE_SPEED * dt, LOBBY_WIDTH);
          const newY = clampLobby(local.y + ny * MOVE_SPEED * dt, LOBBY_HEIGHT);
          if (newX !== local.x || newY !== local.y) {
            local.x = newX;
            local.y = newY;
            local.tx = newX;
            local.ty = newY;
            positionNode(localId, newX, newY);
            dirtyRef.current = true;
          }
        }

        const socket = socketRef.current;
        if (
          dirtyRef.current &&
          socket &&
          socket.connected &&
          now - lastSentRef.current >= SEND_INTERVAL_MS
        ) {
          lastSentRef.current = now;
          dirtyRef.current = false;
          socket.emit(PlayerMoveEvent, { x: Math.round(local.x), y: Math.round(local.y) });
        }
      }

      // Interpolate remote players toward their latest known targets.
      for (const [id, tracked] of positionsRef.current) {
        if (id === localId) continue;
        const dx = tracked.tx - tracked.x;
        const dy = tracked.ty - tracked.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 0.5) {
          if (distance > TELEPORT_DISTANCE) {
            tracked.x = tracked.tx;
            tracked.y = tracked.ty;
          } else {
            const step = Math.min(1, dt * 12);
            tracked.x += dx * step;
            tracked.y += dy * step;
          }
          positionNode(id, tracked.x, tracked.y);
        }
      }

      if (isDev) {
        framesRef.current += 1;
        if (now - fpsAtRef.current >= 1000) {
          setFps(framesRef.current);
          framesRef.current = 0;
          fpsAtRef.current = now;
        }
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [isDev]);

  const handleAvatarClick = (player: LobbyPlayer): void => {
    if (player.playerId === profileRef.current.playerId || matchActiveRef.current) return;
    setSelected(player);
  };

  const handleChallengePlayer = (gameType: GameType): void => {
    const target = selected;
    const socket = socketRef.current;
    if (!target || !socket) return;
    socket.emit(ChallengeSendEvent, { targetPlayerId: target.playerId, gameType });
    setOutgoing({ targetPlayerId: target.playerId, targetName: target.displayName, gameType });
    setSelected(null);
  };

  const handleWithdrawChallenge = (): void => {
    const pending = outgoing;
    const socket = socketRef.current;
    if (pending && socket) {
      socket.emit(ChallengeWithdrawEvent, { targetPlayerId: pending.targetPlayerId });
    }
    setOutgoing(null);
  };

  const handleAcceptChallenge = (): void => {
    const pending = incoming;
    const socket = socketRef.current;
    if (pending && socket) {
      socket.emit(ChallengeAcceptEvent, { challengeId: pending.challengeId });
    }
    setIncoming(null);
  };

  const handleDeclineChallenge = (): void => {
    const pending = incoming;
    const socket = socketRef.current;
    if (pending && socket) {
      socket.emit(ChallengeDeclineEvent, { challengeId: pending.challengeId });
    }
    setIncoming(null);
  };

  return (
    <VoiceProvider
      socket={socket}
      district={profile.district}
      serverUrl={serverUrl}
      getPositions={getVoicePositions}
      controllerRef={voiceControllerRef}
    >
      <div className="arena" data-testid="arena">
        <VoiceControls district={profile.district} />
        {roster.map((player) => {
          const isLocal = player.playerId === profile.playerId;
          const tracked = positionsRef.current.get(player.playerId);
          const startX = tracked ? tracked.x : player.x;
          const startY = tracked ? tracked.y : player.y;
          return (
            <div
              key={player.playerId}
              data-player-id={player.playerId}
              data-x={Math.round(startX)}
              data-y={Math.round(startY)}
              className={isLocal ? 'avatar local' : 'avatar'}
              style={{
                left: `${(startX / LOBBY_WIDTH) * 100}%`,
                top: `${(startY / LOBBY_HEIGHT) * 100}%`,
              }}
              ref={(el) => {
                if (el) nodesRef.current.set(player.playerId, el);
                else nodesRef.current.delete(player.playerId);
              }}
              onClick={() => handleAvatarClick(player)}
            >
              <span className="avatar-name">{player.displayName}</span>
              <span className="avatar-dot" style={{ background: avatarColor(player.playerId) }} />
              <VoiceAvatarBadge playerId={player.playerId} isLocal={isLocal} />
              {masterPlayerId === player.playerId && (
                <span className="avatar-badge master-badge" title="Last week's Weekly Master">
                  👑 MASTER
                </span>
              )}
              {player.inMatch && <span className="avatar-badge">IN MATCH</span>}
            </div>
          );
        })}

      {!connected && <div className="reconnect-overlay">Reconnecting…</div>}

      {selected && (
        <PlayerCard
          player={selected}
          district={profile.district}
          onChallenge={handleChallengePlayer}
          onClose={() => setSelected(null)}
        />
      )}

      {incoming && (
        <IncomingChallengeModal
          challengerName={incoming.challengerName}
          gameType={incoming.gameType}
          matchMode={incoming.matchMode}
          onAccept={handleAcceptChallenge}
          onDecline={handleDeclineChallenge}
        />
      )}

      {outgoing && (
        <OutgoingChallengeModal
          targetName={outgoing.targetName}
          gameType={outgoing.gameType}
          onWithdraw={handleWithdrawChallenge}
        />
      )}

      {toast && <Toast message={toast} />}

      <VirtualJoystick
        onMove={(x, y) => {
          joyRef.current = { x, y };
        }}
      />

      {isDev && (
        <div className="arena-debug">
          FPS {fps} · Players {roster.length}
        </div>
      )}
      </div>
    </VoiceProvider>
  );
}
