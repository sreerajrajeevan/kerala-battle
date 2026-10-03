import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  ClientHelloEvent,
  DistrictPopulationEvent,
  MatchStartedEvent,
  PlayerJoinDistrictEvent,
  ServerWelcomeEvent,
  type ClientHelloPayload,
  type ClientToServerEvents,
  type DistrictPopulationPayload,
  type KeralaDistrict,
  type MatchStartedPayload,
  type PlayerJoinDistrictPayload,
  type PlayerProfile,
  type ServerToClientEvents,
  type ServerWelcomePayload,
} from '@kerala-battle/shared';
import Lobby from './components/Lobby';
import MatchView, { type ActiveMatchInfo } from './components/MatchView';
import Onboarding from './components/Onboarding';
import { loadProfile, saveProfile } from './lib/profile';
import './App.css';

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001';
const IS_DEV = import.meta.env.DEV;

type DistrictSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type { DistrictSocket };

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
  const [activeMatch, setActiveMatch] = useState<ActiveMatchInfo | null>(null);

  const socketRef = useRef<DistrictSocket | null>(null);
  const [socket, setSocket] = useState<DistrictSocket | null>(null);
  const profileRef = useRef<PlayerProfile | null>(profile);
  profileRef.current = profile;

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
      setActiveMatch({
        matchId: payload.matchId,
        players: payload.players,
        totalRounds: payload.totalRounds,
        startsAt: payload.startsAt,
        // Rough server clock offset for countdown/marker synchronization.
        clockOffset: payload.serverNow - Date.now(),
      });
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on(ServerWelcomeEvent, handleWelcome);
    socket.on(DistrictPopulationEvent, handlePopulation);
    socket.on(MatchStartedEvent, handleMatchStarted);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off(ServerWelcomeEvent, handleWelcome);
      socket.off(DistrictPopulationEvent, handlePopulation);
      socket.off(MatchStartedEvent, handleMatchStarted);
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
    // playerId stays the same; only the district changes.
    const next: PlayerProfile = { ...current, district };
    saveProfile(next);
    setProfile(next);
    socketRef.current?.emit(PlayerJoinDistrictEvent, joinDistrictPayload(next));
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
        socket={socket}
        socketId={socketId}
        isDev={IS_DEV}
        matchActive={activeMatch !== null}
      />
      {activeMatch && (
        <MatchView
          key={activeMatch.matchId}
          socket={socket}
          profile={profile}
          match={activeMatch}
          onExit={() => setActiveMatch(null)}
        />
      )}
    </>
  );
}
