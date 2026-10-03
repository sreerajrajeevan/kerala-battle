import { useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  GameRematchCancelEvent,
  GameRematchEvent,
  GameReturnLobbyEvent,
  GameTapEvent,
  MatchFinishedEvent,
  MatchOpponentDisconnectedEvent,
  RematchCancelledEvent,
  RematchWaitingEvent,
  RoundResultEvent,
  RoundStartedEvent,
  RoundTapEvent,
  type MatchFinishedPayload,
  type MatchPlayerInfo,
  type PlayerProfile,
  type RoundResultPayload,
  type RoundStartedPayload,
} from '@kerala-battle/shared';
import type { DistrictSocket } from '../App';

export interface ActiveMatchInfo {
  matchId: string;
  players: [MatchPlayerInfo, MatchPlayerInfo];
  totalRounds: number;
  startsAt: number;
  clockOffset: number;
}

interface MatchViewProps {
  socket: DistrictSocket | null;
  profile: PlayerProfile;
  match: ActiveMatchInfo;
  onExit: () => void;
}

type Phase =
  | 'intro'
  | 'playing'
  | 'roundResult'
  | 'finished'
  | 'opponentGone'
  | 'rematchWaiting'
  | 'connectionLost';

/** Triangle wave: 0 -> 1 -> 0 across one cycle, matching the server's scoring. */
function markerPosition(elapsedMs: number, cycleMs: number): number {
  const phase = (elapsedMs % cycleMs) / cycleMs;
  return phase < 0.5 ? phase * 2 : 2 - phase * 2;
}

export default function MatchView({ socket, profile, match, onExit }: MatchViewProps) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [countdown, setCountdown] = useState(3);
  const [roundInfo, setRoundInfo] = useState<RoundStartedPayload | null>(null);
  const [tapped, setTapped] = useState(false);
  const [opponentTapped, setOpponentTapped] = useState(false);
  const [lastResult, setLastResult] = useState<RoundResultPayload | null>(null);
  const [finalResult, setFinalResult] = useState<MatchFinishedPayload | null>(null);

  const markerRef = useRef<HTMLDivElement>(null);
  const tappedRef = useRef(false);
  const offsetRef = useRef(match.clockOffset);
  const matchRef = useRef(match);
  matchRef.current = match;
  const profileRef = useRef(profile);
  profileRef.current = profile;

  const opponent =
    match.players.find((player) => player.playerId !== profile.playerId) ?? match.players[0];

  useEffect(() => {
    if (!socket) return;
    const myId = profileRef.current.playerId;
    const matchId = matchRef.current.matchId;
    const forThisMatch = (payload: { matchId: string }): boolean => payload.matchId === matchId;

    const handleRoundStarted = (payload: RoundStartedPayload) => {
      if (!forThisMatch(payload)) return;
      tappedRef.current = false;
      setTapped(false);
      setOpponentTapped(false);
      setRoundInfo(payload);
      setPhase('playing');
    };
    const handleRoundTap = (payload: { matchId: string; playerId: string }) => {
      if (!forThisMatch(payload)) return;
      if (payload.playerId !== myId) setOpponentTapped(true);
    };
    const handleRoundResult = (payload: RoundResultPayload) => {
      if (!forThisMatch(payload)) return;
      setLastResult(payload);
      setPhase('roundResult');
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
    // If our own socket drops mid-match, the server aborts the match, so the
    // game cannot continue. Offer a way back to the lobby.
    const handleDisconnect = (): void => {
      setPhase('connectionLost');
    };

    socket.on(RoundStartedEvent, handleRoundStarted);
    socket.on(RoundTapEvent, handleRoundTap);
    socket.on(RoundResultEvent, handleRoundResult);
    socket.on(MatchFinishedEvent, handleFinished);
    socket.on(MatchOpponentDisconnectedEvent, handleOpponentGone);
    socket.on(RematchWaitingEvent, handleRematchWaiting);
    socket.on(RematchCancelledEvent, handleRematchCancelled);
    socket.on('disconnect', handleDisconnect);
    return () => {
      socket.off(RoundStartedEvent, handleRoundStarted);
      socket.off(RoundTapEvent, handleRoundTap);
      socket.off(RoundResultEvent, handleRoundResult);
      socket.off(MatchFinishedEvent, handleFinished);
      socket.off(MatchOpponentDisconnectedEvent, handleOpponentGone);
      socket.off(RematchWaitingEvent, handleRematchWaiting);
      socket.off(RematchCancelledEvent, handleRematchCancelled);
      socket.off('disconnect', handleDisconnect);
    };
  }, [socket, match.matchId]);

  // Synchronized pre-match countdown from the server's start timestamp.
  useEffect(() => {
    const startsAt = matchRef.current.startsAt;
    const tick = (): void => {
      const remaining = startsAt - (Date.now() + offsetRef.current);
      setCountdown(remaining > 0 ? Math.ceil(remaining / 1000) : 0);
    };
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, []);

  // Local marker animation, driven by the server's round timestamps.
  useEffect(() => {
    if (phase !== 'playing' || !roundInfo) return;
    let raf = 0;
    const frame = (): void => {
      const elapsed = Date.now() + offsetRef.current - roundInfo.roundStartTime;
      const clamped = Math.min(Math.max(elapsed, 0), roundInfo.roundDurationMs);
      const position = markerPosition(clamped, roundInfo.cycleDurationMs);
      if (markerRef.current) markerRef.current.style.left = `${position * 100}%`;
      if (elapsed < roundInfo.roundDurationMs) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [phase, roundInfo]);

  const handleTap = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (phase !== 'playing' || tappedRef.current || !roundInfo || !socket) return;
    tappedRef.current = true;
    setTapped(true);
    // The server calculates the score from its own receive time; the client
    // never sends or decides a score.
    socket.emit(GameTapEvent, { matchId: matchRef.current.matchId, round: roundInfo.round });
  };

  const handleRematch = (): void => {
    socket?.emit(GameRematchEvent, { matchId: matchRef.current.matchId });
    setPhase('rematchWaiting');
  };

  const handleCancelRematch = (): void => {
    socket?.emit(GameRematchCancelEvent, { matchId: matchRef.current.matchId });
    setPhase('finished');
  };

  const handleReturnToLobby = (): void => {
    socket?.emit(GameReturnLobbyEvent, { matchId: matchRef.current.matchId });
    onExit();
  };

  const winnerText = (): string => {
    if (!finalResult) return '';
    if (finalResult.winnerPlayerId === null) return 'DRAW';
    return finalResult.winnerPlayerId === profile.playerId
      ? '🏆 YOU WIN!'
      : `🏆 ${opponent.displayName.toUpperCase()} WINS`;
  };

  return (
    <div className="match-overlay">
      {phase === 'intro' && (
        <section className="pc-intro">
          <h2>Precision Clash</h2>
          <div className="pc-vs">
            <span>{profile.displayName}</span>
            <em>VS</em>
            <span>{opponent.displayName}</span>
          </div>
          <div className="pc-countdown">{countdown > 0 ? countdown : 'GO!'}</div>
        </section>
      )}

      {(phase === 'playing' || phase === 'roundResult') && roundInfo && (
        <section className="pc-game">
          <p className="pc-round">
            ROUND {roundInfo.round} / {match.totalRounds}
          </p>
          {phase === 'playing' ? (
            <>
              <div
                className="pc-tapzone"
                onPointerDown={handleTap}
                role="button"
                aria-label="Tap to stop the marker"
              >
                <div className="pc-bar">
                  <div className="pc-center" />
                  <div className="pc-marker" ref={markerRef} />
                </div>
                <p className="pc-hint">
                  {tapped
                    ? opponentTapped
                      ? `${opponent.displayName} tapped ✓`
                      : `Waiting for ${opponent.displayName}…`
                    : 'Tap anywhere to stop the marker at the center!'}
                </p>
              </div>
            </>
          ) : (
            lastResult && (
              <div className="pc-scores">
                <h3>ROUND {lastResult.round}</h3>
                {lastResult.results.map((entry) => (
                  <div
                    key={entry.playerId}
                    className={entry.playerId === profile.playerId ? 'pc-row me' : 'pc-row'}
                  >
                    <span>{entry.displayName}</span>
                    <span>
                      {entry.score} · {entry.label}
                    </span>
                  </div>
                ))}
              </div>
            )
          )}
        </section>
      )}

      {phase === 'finished' && finalResult && (
        <section className="pc-final">
          <h3>FINAL</h3>
          {finalResult.totals.map((entry) => (
            <div
              key={entry.playerId}
              className={entry.playerId === profile.playerId ? 'pc-row me' : 'pc-row'}
            >
              <span>{entry.displayName}</span>
              <span>{entry.total}</span>
            </div>
          ))}
          <div className="pc-winner">{winnerText()}</div>
          <div className="pc-actions">
            <button type="button" className="primary-btn" onClick={handleRematch}>
              Rematch
            </button>
            <button type="button" className="secondary-btn" onClick={handleReturnToLobby}>
              Return to Lobby
            </button>
          </div>
        </section>
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
