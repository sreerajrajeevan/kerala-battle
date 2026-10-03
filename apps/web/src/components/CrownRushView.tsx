import { useEffect, useRef, useState } from 'react';
import {
  CROWN_RUSH_ARENA_HEIGHT,
  CROWN_RUSH_ARENA_WIDTH,
  CROWN_RUSH_MOVE_SPEED,
  CROWN_RUSH_PLAYER_RADIUS,
  CROWN_RUSH_SPAWN_A,
  CROWN_RUSH_SPAWN_B,
  CrownRushInputEvent,
  CrownRushStateEvent,
  GameRematchCancelEvent,
  GameRematchEvent,
  GameReturnLobbyEvent,
  MatchFinishedEvent,
  MatchOpponentDisconnectedEvent,
  RematchCancelledEvent,
  RematchWaitingEvent,
  type CrownRushStatePayload,
  type KeralaDistrict,
  type MatchFinishedPayload,
  type MatchMode,
  type MatchPlayerInfo,
  type PlayerProfile,
} from '@kerala-battle/shared';
import type { DistrictSocket } from '../App';
import VirtualJoystick from './VirtualJoystick';
import MatchResultPanel from './MatchResultPanel';
import { avatarColor } from '../lib/visual';

export interface CrownRushMatchInfo {
  matchId: string;
  players: [MatchPlayerInfo, MatchPlayerInfo];
  startsAt: number;
  clockOffset: number;
  matchMode: MatchMode;
  districts: [KeralaDistrict, KeralaDistrict];
  competitionWeekId?: string;
}

interface CrownRushViewProps {
  socket: DistrictSocket | null;
  profile: PlayerProfile;
  match: CrownRushMatchInfo;
  serverUrl: string;
  onExit: () => void;
  onFindNextRanked: (matchId: string) => void;
}

type Phase =
  | 'countdown'
  | 'playing'
  | 'finished'
  | 'opponentGone'
  | 'rematchWaiting'
  | 'connectionLost';

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

const INPUT_SEND_MS = 66; // ~15 input updates/sec while moving
const RECONCILE_SNAP = 150; // snap local prediction beyond this drift
const REMOTE_TELEPORT = 300;

interface HudState {
  timeRemainingMs: number;
  suddenDeath: boolean;
  scores: [number, number];
  crown: { x: number; y: number; golden: boolean } | null;
  captureText: string | null;
}

interface Tracked {
  x: number;
  y: number;
  tx: number;
  ty: number;
}

function clampArena(value: number, max: number): number {
  return Math.min(Math.max(value, CROWN_RUSH_PLAYER_RADIUS), max - CROWN_RUSH_PLAYER_RADIUS);
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export default function CrownRushView({
  socket,
  profile,
  match,
  serverUrl,
  onExit,
  onFindNextRanked,
}: CrownRushViewProps) {
  const [phase, setPhase] = useState<Phase>('countdown');
  const [countdown, setCountdown] = useState(3);
  const [hud, setHud] = useState<HudState>({
    timeRemainingMs: 45_000,
    suddenDeath: false,
    scores: [0, 0],
    crown: null,
    captureText: null,
  });
  const [finalResult, setFinalResult] = useState<MatchFinishedPayload | null>(null);

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const matchRef = useRef(match);
  matchRef.current = match;
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const socketRef = useRef(socket);
  socketRef.current = socket;

  const keysRef = useRef(new Set<'up' | 'down' | 'left' | 'right'>());
  const joyRef = useRef({ x: 0, y: 0 });
  const seqRef = useRef(0);
  const lastSentRef = useRef(0);
  const captureSeqRef = useRef(0);
  const toastTimerRef = useRef(0);

  const localId = profile.playerId;
  const isPlayerA = match.players[0].playerId === localId;
  const spawn = isPlayerA ? CROWN_RUSH_SPAWN_A : CROWN_RUSH_SPAWN_B;
  const remoteSpawn = isPlayerA ? CROWN_RUSH_SPAWN_B : CROWN_RUSH_SPAWN_A;
  const opponent =
    match.players.find((player) => player.playerId !== localId) ?? match.players[1];

  const trackedRef = useRef(
    new Map<string, Tracked>([
      [localId, { x: spawn.x, y: spawn.y, tx: spawn.x, ty: spawn.y }],
      [opponent.playerId, { x: remoteSpawn.x, y: remoteSpawn.y, tx: remoteSpawn.x, ty: remoteSpawn.y }],
    ]),
  );
  const nodesRef = useRef(new Map<string, HTMLDivElement>());

  const positionNode = (playerId: string, x: number, y: number) => {
    const el = nodesRef.current.get(playerId);
    if (!el) return;
    el.style.left = `${(x / CROWN_RUSH_ARENA_WIDTH) * 100}%`;
    el.style.top = `${(y / CROWN_RUSH_ARENA_HEIGHT) * 100}%`;
  };

  // Socket listeners: authoritative snapshots, finish, disconnect, rematch.
  useEffect(() => {
    if (!socket) return;
    const myId = profileRef.current.playerId;
    const matchId = matchRef.current.matchId;
    const forThisMatch = (payload: { matchId: string }): boolean => payload.matchId === matchId;

    const handleState = (payload: CrownRushStatePayload) => {
      if (!forThisMatch(payload)) return;
      for (const entry of payload.players) {
        const tracked = trackedRef.current.get(entry.playerId);
        if (tracked) {
          tracked.tx = entry.x;
          tracked.ty = entry.y;
        }
      }
      const scores: [number, number] = [payload.players[0]?.score ?? 0, payload.players[1]?.score ?? 0];
      let captureText: string | null = null;
      if (payload.lastCapture && payload.lastCapture.captureSeq !== captureSeqRef.current) {
        captureSeqRef.current = payload.lastCapture.captureSeq;
        captureText =
          payload.lastCapture.playerId === myId
            ? 'YOU +1 👑'
            : `${payload.lastCapture.displayName.toUpperCase()} +1 👑`;
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = window.setTimeout(
          () => setHud((prev) => ({ ...prev, captureText: null })),
          1400,
        );
      }
      setHud((prev) => ({
        timeRemainingMs: payload.timeRemainingMs,
        suddenDeath: payload.suddenDeath,
        scores,
        crown: payload.crown,
        captureText: captureText ?? prev.captureText,
      }));
      if (payload.status === 'playing' || payload.status === 'suddenDeath') {
        if (phaseRef.current === 'countdown') setPhase('playing');
      }
    };
    const handleFinished = (payload: MatchFinishedPayload) => {
      if (!forThisMatch(payload)) return;
      setFinalResult(payload);
      setPhase('finished');
    };
    const handleOpponentGone = (payload: { matchId: string }) => {
      if (!forThisMatch(payload)) return;
      setPhase('opponentGone');
    };
    const handleRematchWaiting = (payload: { matchId: string }) => {
      if (!forThisMatch(payload)) return;
      setPhase('rematchWaiting');
    };
    const handleRematchCancelled = (payload: { matchId: string }) => {
      if (!forThisMatch(payload)) return;
      setPhase('finished');
    };
    const handleDisconnect = (): void => {
      setPhase('connectionLost');
    };

    socket.on(CrownRushStateEvent, handleState);
    socket.on(MatchFinishedEvent, handleFinished);
    socket.on(MatchOpponentDisconnectedEvent, handleOpponentGone);
    socket.on(RematchWaitingEvent, handleRematchWaiting);
    socket.on(RematchCancelledEvent, handleRematchCancelled);
    socket.on('disconnect', handleDisconnect);
    return () => {
      socket.off(CrownRushStateEvent, handleState);
      socket.off(MatchFinishedEvent, handleFinished);
      socket.off(MatchOpponentDisconnectedEvent, handleOpponentGone);
      socket.off(RematchWaitingEvent, handleRematchWaiting);
      socket.off(RematchCancelledEvent, handleRematchCancelled);
      socket.off('disconnect', handleDisconnect);
    };
  }, [socket, match.matchId]);

  // Server-synchronized 3-2-1-GO countdown.
  useEffect(() => {
    const startsAt = matchRef.current.startsAt;
    const offset = matchRef.current.clockOffset;
    const tick = (): void => {
      const remaining = startsAt - (Date.now() + offset);
      setCountdown(remaining > 0 ? Math.ceil(remaining / 1000) : 0);
      if (remaining <= 0 && phaseRef.current === 'countdown') setPhase('playing');
    };
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, []);

  // Keyboard input.
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

  // Main loop: client prediction for the local player, interpolation for the
  // remote player, and input submission (~15 Hz). Positions are written
  // straight to the DOM; React only rerenders HUD data at snapshot rate.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      const playing = phaseRef.current === 'playing';
      const local = trackedRef.current.get(localId);

      if (playing && local) {
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
        let nx = 0;
        let ny = 0;
        if (magnitude > 0.05) {
          nx = vx / Math.max(1, magnitude);
          ny = vy / Math.max(1, magnitude);
          local.x = clampArena(local.x + nx * CROWN_RUSH_MOVE_SPEED * dt, CROWN_RUSH_ARENA_WIDTH);
          local.y = clampArena(local.y + ny * CROWN_RUSH_MOVE_SPEED * dt, CROWN_RUSH_ARENA_HEIGHT);
        }

        // Reconcile prediction toward the authoritative position: gentle
        // correction for small drift, hard snap for large divergence.
        const drift = Math.hypot(local.x - local.tx, local.y - local.ty);
        if (drift > RECONCILE_SNAP) {
          local.x = local.tx;
          local.y = local.ty;
        } else if (drift > 0.5) {
          const k = Math.min(1, dt * 10);
          local.x += (local.tx - local.x) * k;
          local.y += (local.ty - local.y) * k;
        }
        positionNode(localId, local.x, local.y);

        const sock = socketRef.current;
        if (sock && sock.connected && now - lastSentRef.current >= INPUT_SEND_MS) {
          lastSentRef.current = now;
          seqRef.current += 1;
          sock.emit(CrownRushInputEvent, {
            matchId: matchRef.current.matchId,
            xAxis: Math.round(nx * 1000) / 1000,
            yAxis: Math.round(ny * 1000) / 1000,
            sequence: seqRef.current,
          });
        }
      }

      // Interpolate the remote player toward its latest snapshot.
      for (const [id, tracked] of trackedRef.current) {
        if (id === localId) continue;
        const dx = tracked.tx - tracked.x;
        const dy = tracked.ty - tracked.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 0.5) {
          if (distance > REMOTE_TELEPORT) {
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

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [localId]);

  const handleRematch = (): void => {
    socketRef.current?.emit(GameRematchEvent, { matchId: matchRef.current.matchId });
    setPhase('rematchWaiting');
  };

  const handleCancelRematch = (): void => {
    socketRef.current?.emit(GameRematchCancelEvent, { matchId: matchRef.current.matchId });
    setPhase('finished');
  };

  const handleReturnToLobby = (): void => {
    socketRef.current?.emit(GameReturnLobbyEvent, { matchId: matchRef.current.matchId });
    onExit();
  };

  const handleFindNextRanked = (): void => {
    onFindNextRanked(matchRef.current.matchId);
  };

  const myScore = isPlayerA ? hud.scores[0] : hud.scores[1];
  const oppScore = isPlayerA ? hud.scores[1] : hud.scores[0];

  const winnerText = (): string => {
    if (!finalResult) return '';
    if (finalResult.winnerPlayerId === null) return 'DRAW';
    return finalResult.winnerPlayerId === profile.playerId
      ? '👑 YOU WIN!'
      : `👑 ${opponent.displayName.toUpperCase()} WINS`;
  };

  return (
    <div className="match-overlay">
      {(phase === 'countdown' || phase === 'playing') && (
        <section className="cr-game">
          <header className="cr-scoreboard">
            <div className="cr-side me">
              <span className="cr-name">{profile.displayName}</span>
              <span className="cr-score">{myScore}</span>
            </div>
            <div className="cr-center">
              <span className={hud.suddenDeath ? 'cr-timer sudden' : 'cr-timer'}>
                {hud.suddenDeath ? 'SUDDEN DEATH' : formatClock(hud.timeRemainingMs)}
              </span>
              <span className="cr-firstto">FIRST TO 7</span>
            </div>
            <div className="cr-side">
              <span className="cr-name">{opponent.displayName}</span>
              <span className="cr-score">{oppScore}</span>
            </div>
          </header>
          <p
            className={
              match.matchMode === 'ranked' ? 'match-mode-badge ranked' : 'match-mode-badge casual'
            }
          >
            {match.matchMode === 'ranked'
              ? `RANKED · ${match.districts[0].toUpperCase()} vs ${match.districts[1].toUpperCase()}`
              : 'CASUAL MATCH'}
          </p>

          <div className="cr-arena" data-testid="crown-rush-arena">
            {hud.crown && (
              <div
                className={hud.crown.golden ? 'cr-crown golden' : 'cr-crown'}
                style={{
                  left: `${(hud.crown.x / CROWN_RUSH_ARENA_WIDTH) * 100}%`,
                  top: `${(hud.crown.y / CROWN_RUSH_ARENA_HEIGHT) * 100}%`,
                }}
                aria-label={hud.crown.golden ? 'Golden crown' : 'Crown'}
              >
                👑
              </div>
            )}
            {match.players.map((player) => {
              const isLocal = player.playerId === localId;
              const tracked = trackedRef.current.get(player.playerId);
              const startX = tracked ? tracked.x : isLocal ? spawn.x : remoteSpawn.x;
              const startY = tracked ? tracked.y : isLocal ? spawn.y : remoteSpawn.y;
              return (
                <div
                  key={player.playerId}
                  className={isLocal ? 'cr-player local' : 'cr-player'}
                  style={{
                    left: `${(startX / CROWN_RUSH_ARENA_WIDTH) * 100}%`,
                    top: `${(startY / CROWN_RUSH_ARENA_HEIGHT) * 100}%`,
                  }}
                  ref={(el) => {
                    if (el) nodesRef.current.set(player.playerId, el);
                    else nodesRef.current.delete(player.playerId);
                  }}
                >
                  <span className="cr-player-name">{player.displayName}</span>
                  <span
                    className="cr-player-dot"
                    style={{ background: avatarColor(player.playerId) }}
                  />
                </div>
              );
            })}
            {phase === 'countdown' && (
              <div className="cr-countdown">{countdown > 0 ? countdown : 'GO!'}</div>
            )}
            {hud.captureText && <div className="cr-toast">{hud.captureText}</div>}
          </div>

          <VirtualJoystick
            onMove={(x, y) => {
              joyRef.current = { x, y };
            }}
          />
        </section>
      )}

      {phase === 'finished' && finalResult && (
        <MatchResultPanel
          gameLabel="Crown Rush"
          finalResult={finalResult}
          players={match.players}
          profile={profile}
          serverUrl={serverUrl}
          winnerText={winnerText()}
          scoreSuffix=" 👑"
          onRematch={handleRematch}
          onReturnToLobby={handleReturnToLobby}
          onFindNextRanked={handleFindNextRanked}
        />
      )}

      {phase === 'rematchWaiting' && (
        <section className="pc-waiting">
          <h3>Waiting for opponent…</h3>
          <button type="button" className="secondary-btn" onClick={handleCancelRematch}>
            Cancel
          </button>
        </section>
      )}

      {phase === 'opponentGone' && (
        <section className="pc-waiting">
          <h3>Opponent disconnected</h3>
          <button type="button" className="primary-btn" onClick={handleReturnToLobby}>
            Return to Lobby
          </button>
        </section>
      )}

      {phase === 'connectionLost' && (
        <section className="pc-waiting">
          <h3>Connection lost</h3>
          <p className="challenge-sub">The match cannot continue without a connection.</p>
          <button type="button" className="primary-btn" onClick={handleReturnToLobby}>
            Return to Lobby
          </button>
        </section>
      )}
    </div>
  );
}
