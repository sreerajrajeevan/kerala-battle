import { useEffect, useRef, useState, type PointerEvent } from 'react';
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
  LOBBY_HEIGHT,
  LOBBY_WIDTH,
  PlayerJoinDistrictEvent,
  PlayerMoveEvent,
  PlayerMovedEvent,
  type ChallengeCancelledReason,
  type ChallengeFailedReason,
  type DistrictPlayersPayload,
  type LobbyPlayer,
  type PlayerJoinDistrictPayload,
  type PlayerMovedPayload,
  type PlayerProfile,
} from '@kerala-battle/shared';
import { avatarColor } from '../lib/visual';
import type { DistrictSocket } from '../App';
import PlayerCard from './PlayerCard';
import { IncomingChallengeModal, OutgoingChallengeModal, Toast } from './ChallengeUI';

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

export default function LobbyArena({ socket, profile, connected, matchActive, isDev }: LobbyArenaProps) {
  const [roster, setRoster] = useState<LobbyPlayer[]>([]);
  const [fps, setFps] = useState(0);
  const [selected, setSelected] = useState<LobbyPlayer | null>(null);
  const [outgoing, setOutgoing] = useState<{ targetPlayerId: string; targetName: string } | null>(
    null,
  );
  const [incoming, setIncoming] = useState<{ challengeId: string; challengerName: string } | null>(
    null,
  );
  const [toast, setToast] = useState<string | null>(null);

  const positionsRef = useRef(new Map<string, TrackedPlayer>());
  const nodesRef = useRef(new Map<string, HTMLDivElement>());
  const keysRef = useRef(new Set<'up' | 'down' | 'left' | 'right'>());
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

    const handleChallengeReceived = (payload: {
      challengeId: string;
      challenger: { playerId: string; displayName: string };
    }) => {
      setSelected(null);
      setIncoming({
        challengeId: payload.challengeId,
        challengerName: payload.challenger.displayName,
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

  // Virtual joystick (pointer events cover touch + mouse).
  const joyBaseRef = useRef<HTMLDivElement>(null);
  const joyKnobRef = useRef<HTMLDivElement>(null);
  const joyPointerRef = useRef<{ active: boolean; id: number }>({ active: false, id: -1 });

  const updateJoystick = (event: PointerEvent<HTMLDivElement>) => {
    const base = joyBaseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    const radius = rect.width / 2;
    let dx = (event.clientX - (rect.left + radius)) / radius;
    let dy = (event.clientY - (rect.top + radius)) / radius;
    const magnitude = Math.hypot(dx, dy);
    if (magnitude > 1) {
      dx /= magnitude;
      dy /= magnitude;
    }
    joyRef.current = { x: dx, y: dy };
    if (joyKnobRef.current) {
      joyKnobRef.current.style.transform =
        `translate(${dx * radius * 0.55}px, ${dy * radius * 0.55}px)`;
    }
  };

  const handleJoyDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    joyPointerRef.current = { active: true, id: event.pointerId };
    updateJoystick(event);
  };

  const handleJoyMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!joyPointerRef.current.active || event.pointerId !== joyPointerRef.current.id) return;
    updateJoystick(event);
  };

  const handleJoyEnd = () => {
    joyPointerRef.current = { active: false, id: -1 };
    joyRef.current = { x: 0, y: 0 };
    if (joyKnobRef.current) joyKnobRef.current.style.transform = 'translate(0px, 0px)';
  };

  const handleAvatarClick = (player: LobbyPlayer): void => {
    if (player.playerId === profileRef.current.playerId || matchActiveRef.current) return;
    setSelected(player);
  };

  const handleChallengePlayer = (): void => {
    const target = selected;
    const socket = socketRef.current;
    if (!target || !socket) return;
    socket.emit(ChallengeSendEvent, { targetPlayerId: target.playerId });
    setOutgoing({ targetPlayerId: target.playerId, targetName: target.displayName });
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
    <div className="arena" data-testid="arena">
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
          onAccept={handleAcceptChallenge}
          onDecline={handleDeclineChallenge}
        />
      )}

      {outgoing && (
        <OutgoingChallengeModal targetName={outgoing.targetName} onWithdraw={handleWithdrawChallenge} />
      )}

      {toast && <Toast message={toast} />}

      <div
        className="joystick"
        ref={joyBaseRef}
        role="group"
        aria-label="Movement joystick"
        onPointerDown={handleJoyDown}
        onPointerMove={handleJoyMove}
        onPointerUp={handleJoyEnd}
        onPointerCancel={handleJoyEnd}
      >
        <div className="joystick-knob" ref={joyKnobRef} />
      </div>

      {isDev && (
        <div className="arena-debug">
          FPS {fps} · Players {roster.length}
        </div>
      )}
    </div>
  );
}
