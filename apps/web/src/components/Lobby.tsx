import type { CSSProperties } from 'react';
import type { KeralaDistrict, PlayerProfile } from '@kerala-battle/shared';
import DistrictGrid from './DistrictGrid';
import LobbyArena from './LobbyArena';
import { WeeklyBattleCta } from './WeeklyBattle';
import AccountMenu from './AccountMenu';
import { districtHue } from '../lib/visual';
import { usePreviousChampion } from '../lib/competition';
import type { DistrictSocket } from '../App';
import type { VoiceController } from '../voice/voiceContext';

interface LobbyProps {
  profile: PlayerProfile;
  connected: boolean;
  onlineCount: number;
  changingDistrict: boolean;
  onStartChangeDistrict: () => void;
  onCancelChangeDistrict: () => void;
  onSelectDistrict: (district: KeralaDistrict) => void;
  onOpenCompetition: () => void;
  onJoinWeeklyBattle: () => void;
  onSignOut: () => void;
  socket: DistrictSocket | null;
  socketId: string | null;
  isDev: boolean;
  matchActive: boolean;
  serverUrl: string;
  voiceControllerRef: { current: VoiceController | null };
}

export default function Lobby({
  profile,
  connected,
  onlineCount,
  changingDistrict,
  onStartChangeDistrict,
  onCancelChangeDistrict,
  onSelectDistrict,
  onOpenCompetition,
  onJoinWeeklyBattle,
  onSignOut,
  socket,
  socketId,
  isDev,
  matchActive,
  serverUrl,
  voiceControllerRef,
}: LobbyProps) {
  const previousChampion = usePreviousChampion(serverUrl, socket);
  const isDefendingDistrict =
    previousChampion?.districtChampion?.district === profile.district;

  return (
    <main className="page lobby-page">
      <header
        className="lobby-header"
        style={{ '--district-hue': districtHue(profile.district) } as CSSProperties}
      >
        <div className="lobby-title">
          <h1>Kerala Battle</h1>
          <p className="hub-title">
            {profile.district} District Hub · {onlineCount} online
          </p>
          {isDefendingDistrict && (
            <p className="hub-defending">🏆 Defending District Champion</p>
          )}
        </div>
        <p className="status">
          <span className={connected ? 'status-ok' : 'status-bad'}>
            {connected ? 'Connected' : 'Reconnecting…'}
          </span>
        </p>
      </header>

      <LobbyArena
        socket={socket}
        profile={profile}
        connected={connected}
        matchActive={matchActive}
        isDev={isDev}
        serverUrl={serverUrl}
        voiceControllerRef={voiceControllerRef}
      />

      <WeeklyBattleCta
        serverUrl={serverUrl}
        profile={profile}
        socket={socket}
        onJoin={onJoinWeeklyBattle}
      />

      {changingDistrict && (
        <div className="change-overlay">
          <section className="change-panel">
            <h3>Change district</h3>
            <DistrictGrid selected={profile.district} onSelect={onSelectDistrict} />
            <button type="button" className="secondary-btn" onClick={onCancelChangeDistrict}>
              Cancel
            </button>
          </section>
        </div>
      )}

      <footer className="lobby-footer">
        <span className="player-line">{profile.displayName}</span>
        <AccountMenu onSignOut={onSignOut} />
        <button type="button" className="secondary-btn" onClick={onOpenCompetition}>
          🏆 Competition
        </button>
        <button type="button" className="secondary-btn" onClick={onStartChangeDistrict}>
          Change District
        </button>
      </footer>

      {isDev && (
        <p className="debug">
          Socket ID: {socketId ?? '—'} · Player ID: {profile.playerId}
        </p>
      )}
    </main>
  );
}
