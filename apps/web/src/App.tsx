import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  ClientHelloEvent,
  CrownRushStartedEvent,
  DistrictPopulationEvent,
  GAME_TYPE_CROWN_RUSH,
  GAME_TYPE_PRECISION_CLASH,
  GameReturnLobbyEvent,
  MatchStartedEvent,
  PlayerJoinDistrictEvent,
  RankedQueueCancelEvent,
  RankedQueueJoinEvent,
  RankedQueueMatchedEvent,
  RankedQueueStatusEvent,
  ServerWelcomeEvent,
  type ClientHelloPayload,
  type ClientToServerEvents,
  type CrownRushStartedPayload,
  type DistrictPopulationPayload,
  type KeralaDistrict,
  type MatchStartedPayload,
  type PlayerJoinDistrictPayload,
  type PlayerProfile,
  type RankedQueueMatchedPayload,
  type RankedQueueStatusPayload,
  type ServerToClientEvents,
  type ServerWelcomePayload,
} from '@kerala-battle/shared';
import Lobby from './components/Lobby';
import CompetitionView from './components/CompetitionView';
import MatchView, { type ActiveMatchInfo } from './components/MatchView';
import CrownRushView, { type CrownRushMatchInfo } from './components/CrownRushView';
import { QueueOverlay } from './components/WeeklyBattle';
import Onboarding from './components/Onboarding';
import { loadProfile, saveProfile } from './lib/profile';
import type { VoiceController } from './voice/voiceContext';
import './App.css';

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001';
const IS_DEV = import.meta.env.DEV;

type DistrictSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type { DistrictSocket };

/** Whichever game the local player is currently inside (at most one). */
type ActiveGame =
  | { gameType: typeof GAME_TYPE_PRECISION_CLASH; match: ActiveMatchInfo }
  | { gameType: typeof GAME_TYPE_CROWN_RUSH; match: CrownRushMatchInfo };

function joinDistrictPayload(profile: PlayerProfile): PlayerJoinDistrictPayload {
  return {
    playerId: profile.playerId,
    displayName: profile.displayName,
    district: profile.district,
  };
}

export default function App() {
  const [profile, setProfile] = useState<PlayerProfile | null>(() => loadProfile());
  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState<string | null>(null);
  const [populations, setPopulations] = useState<Partial<Record<KeralaDistrict, number>>>({});
  const [changingDistrict, setChangingDistrict] = useState(false);
  const [activeGame, setActiveGame] = useState<ActiveGame | null>(null);
  const [competitionOpen, setCompetitionOpen] = useState(false);
  const [queueStatus, setQueueStatus] = useState<RankedQueueStatusPayload | null>(null);
  const [queueMatched, setQueueMatched] = useState<RankedQueueMatchedPayload | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);

  const socketRef = useRef<DistrictSocket | null>(null);
  const [socket, setSocket] = useState<DistrictSocket | null>(null);
  const profileRef = useRef<PlayerProfile | null>(profile);
  profileRef.current = profile;
  // Tracks the match-found presentation so a watchdog can rescue a stuck one.
  const matchedRef = useRef<string | null>(null);
  // Imperative voice handle, published by the lobby's VoiceProvider. Used to
  // force-leave district voice before matches and on district changes.
  const voiceControllerRef = useRef<VoiceController | null>(null);
  const leaveVoice = (reason: 'match' | 'district-change'): void => {
    voiceControllerRef.current?.leave(reason);
  };

  useEffect(() => {
    const socket: DistrictSocket = io(SERVER_URL);
    socketRef.current = socket;
    // Publish via state so child components can attach listeners as soon as
    // the socket exists. (Child effects run before this parent effect, so a
    // ref alone would still be null when children mount on first render.)
    setSocket(socket);

    const handleConnect = () => {
      setConnected(true);
      setSocketId(socket.id ?? null);
      const hello: ClientHelloPayload = { timestamp: Date.now() };
      socket.emit(ClientHelloEvent, hello);
      // (Re)join the saved district on every connect, including reconnects.
      const saved = profileRef.current;
      if (saved) {
        socket.emit(PlayerJoinDistrictEvent, joinDistrictPayload(saved));
      }
    };

    const handleDisconnect = () => {
      setConnected(false);
      setSocketId(null);
    };

    const handleWelcome = (payload: ServerWelcomePayload) => {
      console.log(payload.message);
    };

    const handlePopulation = (payload: DistrictPopulationPayload) => {
      setPopulations((prev) => ({ ...prev, [payload.district]: payload.onlineCount }));
    };

    const handleMatchStarted = (payload: MatchStartedPayload) => {
      matchedRef.current = null;
      setQueueMatched(null);
      setQueueStatus(null);
      // District voice must not continue invisibly during a match.
      leaveVoice('match');
      setActiveGame({
        gameType: GAME_TYPE_PRECISION_CLASH,
        match: {
          matchId: payload.matchId,
          players: payload.players,
          totalRounds: payload.totalRounds,
          startsAt: payload.startsAt,
          // Rough server clock offset for countdown/marker synchronization.
          clockOffset: payload.serverNow - Date.now(),
          matchMode: payload.matchMode,
          districts: payload.districts,
          competitionWeekId: payload.competitionWeekId,
        },
      });
    };

    const handleCrownRushStarted = (payload: CrownRushStartedPayload) => {
      matchedRef.current = null;
      setQueueMatched(null);
      setQueueStatus(null);
      // District voice must not continue invisibly during a match.
      leaveVoice('match');
      setActiveGame({
        gameType: GAME_TYPE_CROWN_RUSH,
        match: {
          matchId: payload.matchId,
          players: payload.players,
          startsAt: payload.startsAt,
          clockOffset: payload.serverNow - Date.now(),
          matchMode: payload.matchMode,
          districts: payload.districts,
          competitionWeekId: payload.competitionWeekId,
        },
      });
    };

    const handleQueueStatus = (payload: RankedQueueStatusPayload) => {
      if (payload.status === 'searching') {
        setQueueMatched(null);
        setQueueStatus(payload);
      } else {
        // Cancelled (or the week rolled over): back to the lobby.
        matchedRef.current = null;
        setQueueStatus(null);
        setQueueMatched(null);
        if (payload.status === 'week-changed') {
          setQueueNotice('Weekly game changed. Please join the new weekly battle.');
        }
      }
    };

    const handleQueueMatched = (payload: RankedQueueMatchedPayload) => {
      setQueueStatus(null);
      setQueueMatched(payload);
      matchedRef.current = payload.matchId;
      // MATCH FOUND: disconnect district voice now; the ranked match starts
      // ~1.5s later and must never share the mic with the district room.
      leaveVoice('match');
      // Watchdog: if the match never starts, don't strand the player.
      window.setTimeout(() => {
        if (matchedRef.current === payload.matchId) {
          matchedRef.current = null;
          setQueueMatched(null);
          setQueueNotice("Match didn't start. Please try again.");
        }
      }, 12000);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on(ServerWelcomeEvent, handleWelcome);
    socket.on(DistrictPopulationEvent, handlePopulation);
    socket.on(MatchStartedEvent, handleMatchStarted);
    socket.on(CrownRushStartedEvent, handleCrownRushStarted);
    socket.on(RankedQueueStatusEvent, handleQueueStatus);
    socket.on(RankedQueueMatchedEvent, handleQueueMatched);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off(ServerWelcomeEvent, handleWelcome);
      socket.off(DistrictPopulationEvent, handlePopulation);
      socket.off(MatchStartedEvent, handleMatchStarted);
      socket.off(CrownRushStartedEvent, handleCrownRushStarted);
      socket.off(RankedQueueStatusEvent, handleQueueStatus);
      socket.off(RankedQueueMatchedEvent, handleQueueMatched);
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const handleOnboarded = (next: PlayerProfile) => {
    saveProfile(next);
    setProfile(next);
    const socket = socketRef.current;
    if (socket && socket.connected) {
      socket.emit(PlayerJoinDistrictEvent, joinDistrictPayload(next));
    }
    // If the socket is not connected yet, the 'connect' handler joins using
    // the saved profile via profileRef.
  };

  const handleSelectDistrict = (district: KeralaDistrict) => {
    const current = profileRef.current;
    if (!current) return;
    setChangingDistrict(false);
    if (district === current.district) return;
    // Leave district voice BEFORE switching: the mic must never broadcast
    // into the old district's room, and rejoining is an explicit tap.
    leaveVoice('district-change');
    // playerId stays the same; only the district changes.
    const next: PlayerProfile = { ...current, district };
    saveProfile(next);
    setProfile(next);
    socketRef.current?.emit(PlayerJoinDistrictEvent, joinDistrictPayload(next));
  };

  // Auto-dismiss queue notices after a few seconds.
  useEffect(() => {
    if (!queueNotice) return;
    const id = window.setTimeout(() => setQueueNotice(null), 5000);
    return () => window.clearTimeout(id);
  }, [queueNotice]);

  const handleJoinWeeklyBattle = (): void => {
    setCompetitionOpen(false);
    setQueueNotice(null);
    socketRef.current?.emit(RankedQueueJoinEvent, {});
  };

  const handleCancelQueue = (): void => {
    socketRef.current?.emit(RankedQueueCancelEvent, {});
    matchedRef.current = null;
    setQueueStatus(null);
    setQueueMatched(null);
  };

  const handleFindNextRanked = (matchId: string): void => {
    // Clean up the finished match, then re-enter the weekly queue. This never
    // rematches the same opponent: ranked matches only come from the queue.
    socketRef.current?.emit(GameReturnLobbyEvent, { matchId });
    setActiveGame(null);
    socketRef.current?.emit(RankedQueueJoinEvent, {});
  };

  if (!profile) {
    return <Onboarding onComplete={handleOnboarded} />;
  }

  return (
    <>
      <Lobby
        profile={profile}
        connected={connected}
        onlineCount={populations[profile.district] ?? 0}
        changingDistrict={changingDistrict}
        onStartChangeDistrict={() => setChangingDistrict(true)}
        onCancelChangeDistrict={() => setChangingDistrict(false)}
        onSelectDistrict={handleSelectDistrict}
        onOpenCompetition={() => setCompetitionOpen(true)}
        onJoinWeeklyBattle={handleJoinWeeklyBattle}
        socket={socket}
        socketId={socketId}
        isDev={IS_DEV}
        matchActive={activeGame !== null}
        serverUrl={SERVER_URL}
        voiceControllerRef={voiceControllerRef}
      />
      {competitionOpen && (
        <CompetitionView
          socket={socket}
          profile={profile}
          serverUrl={SERVER_URL}
          onClose={() => setCompetitionOpen(false)}
          onJoinWeeklyBattle={handleJoinWeeklyBattle}
        />
      )}
      {(queueStatus || queueMatched) && !activeGame && (
        <QueueOverlay
          status={queueStatus}
          matched={queueMatched}
          profile={profile}
          onCancel={handleCancelQueue}
        />
      )}
      {queueNotice && (
        <div className="toast queue-notice" role="status">
          {queueNotice}
        </div>
      )}
      {activeGame && activeGame.gameType === GAME_TYPE_PRECISION_CLASH && (
        <MatchView
          key={activeGame.match.matchId}
          socket={socket}
          profile={profile}
          match={activeGame.match}
          serverUrl={SERVER_URL}
          onExit={() => setActiveGame(null)}
          onFindNextRanked={handleFindNextRanked}
        />
      )}
      {activeGame && activeGame.gameType === GAME_TYPE_CROWN_RUSH && (
        <CrownRushView
          key={activeGame.match.matchId}
          socket={socket}
          profile={profile}
          match={activeGame.match}
          serverUrl={SERVER_URL}
          onExit={() => setActiveGame(null)}
          onFindNextRanked={handleFindNextRanked}
        />
      )}
    </>
  );
}
