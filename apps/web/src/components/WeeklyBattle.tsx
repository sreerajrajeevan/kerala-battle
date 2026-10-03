import { useEffect, useState, type CSSProperties } from 'react';
import {
  CompetitionUpdatedEvent,
  CompetitionWeekFinalizedEvent,
  GAME_DEFINITIONS,
  type CurrentCompetitionPayload,
  type DistrictsLeaderboardPayload,
  type GameType,
  type PlayerProfile,
  type RankedQueueMatchedPayload,
  type RankedQueueStatusPayload,
} from '@kerala-battle/shared';
import { districtHue } from '../lib/visual';
import type { DistrictSocket } from '../App';

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return (await response.json()) as T;
}

/** "2d 14h" style countdown from the server-provided week end timestamp. */
function formatCountdown(endsAt: string, nowMs: number): string {
  const ms = new Date(endsAt).getTime() - nowMs;
  if (Number.isNaN(ms) || ms <= 0) return 'ending…';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${totalMinutes % 60}m`;
  return `${totalMinutes % 60}m`;
}

interface WeeklyBattleCtaProps {
  serverUrl: string;
  profile: PlayerProfile;
  socket: DistrictSocket | null;
  onJoin: () => void;
}

/**
 * Prominent lobby card for the weekly ranked battle: this week's featured
 * game, the player's district rank, and the queue entry button.
 */
export function WeeklyBattleCta({ serverUrl, profile, socket, onJoin }: WeeklyBattleCtaProps) {
  const [competition, setCompetition] = useState<CurrentCompetitionPayload | null>(null);
  const [districtRank, setDistrictRank] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [current, districts] = await Promise.all([
          fetchJson<CurrentCompetitionPayload>(`${serverUrl}/api/competition/current`),
          fetchJson<DistrictsLeaderboardPayload>(`${serverUrl}/api/leaderboards/districts`),
        ]);
        if (cancelled) return;
        setCompetition(current);
        setDistrictRank(
          districts.districts.find((entry) => entry.district === profile.district)?.rank ?? null,
        );
      } catch {
        if (!cancelled) setCompetition(null);
      }
    };
    void load();
    // A settled ranked match anywhere refreshes the rank without a reload.
    const handleUpdated = (): void => {
      void load();
    };
    // A finalized week refreshes the previous-champion banner.
    const handleFinalized = (): void => {
      void load();
    };
    socket?.on(CompetitionUpdatedEvent, handleUpdated);
    socket?.on(CompetitionWeekFinalizedEvent, handleFinalized);
    return () => {
      cancelled = true;
      socket?.off(CompetitionUpdatedEvent, handleUpdated);
      socket?.off(CompetitionWeekFinalizedEvent, handleFinalized);
    };
  }, [serverUrl, profile.district, socket]);

  if (!competition) return null;
  const gameType: GameType = competition.featuredGame.gameType;
  const prev = competition.previousChampion;

  return (
    <section
      className="weekly-cta"
      style={{ '--district-hue': districtHue(profile.district) } as CSSProperties}
      aria-label="Weekly ranked battle"
    >
      <p className="weekly-kicker">🔥 THIS WEEK</p>
      <h2 className="weekly-game">{GAME_DEFINITIONS[gameType].label.toUpperCase()}</h2>
      <p className="weekly-sub">
        {profile.district} is currently {districtRank ? `#${districtRank}` : 'unranked'}
        <span className="weekly-ends"> · ends in {formatCountdown(competition.week.endsAt, Date.now())}</span>
      </p>
      <button type="button" className="primary-btn weekly-join" onClick={onJoin}>
        Join Ranked Battle
      </button>
      {prev && (prev.weeklyMaster || prev.districtChampion) && (
        <p className="weekly-prev">
          <span className="weekly-prev-kicker">LAST WEEK</span>
          {prev.weeklyMaster && (
            <span className="weekly-prev-line">
              👑 {prev.weeklyMaster.displayName} — Weekly Master
            </span>
          )}
          {prev.districtChampion && (
            <span className="weekly-prev-line">
              🏆 {prev.districtChampion.district} — District Champion
            </span>
          )}
        </p>
      )}
    </section>
  );
}

function formatElapsed(joinedAt: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - joinedAt) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

interface QueueOverlayProps {
  status: RankedQueueStatusPayload | null;
  matched: RankedQueueMatchedPayload | null;
  profile: PlayerProfile;
  onCancel: () => void;
}

/**
 * Searching UI and the short "match found" presentation. The match itself
 * starts through the normal game flow afterwards.
 */
export function QueueOverlay({ status, matched, profile, onCancel }: QueueOverlayProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!status || status.status !== 'searching') return;
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [status]);

  if (matched) {
    return (
      <div className="card-overlay">
        <section className="queue-panel" role="status" aria-label="Match found">
          <p className="queue-kicker">MATCH FOUND</p>
          <div className="queue-vs">
            <div
              className="queue-side"
              style={{ '--district-hue': districtHue(matched.myDistrict) } as CSSProperties}
            >
              <span className="queue-district">{matched.myDistrict.toUpperCase()}</span>
              <span className="queue-name">{profile.displayName}</span>
            </div>
            <em className="queue-vs-em">VS</em>
            <div
              className="queue-side"
              style={{ '--district-hue': districtHue(matched.opponent.district) } as CSSProperties}
            >
              <span className="queue-district">{matched.opponent.district.toUpperCase()}</span>
              <span className="queue-name">{matched.opponent.displayName}</span>
            </div>
          </div>
          <p className="queue-game">{GAME_DEFINITIONS[matched.gameType].label.toUpperCase()}</p>
          <p className="queue-ranked">RANKED WEEKLY BATTLE</p>
        </section>
      </div>
    );
  }

  if (!status || status.status !== 'searching') return null;
  const gameType = status.featuredGameType;

  return (
    <div className="card-overlay">
      <section className="queue-panel" role="status" aria-label="Searching for opponent">
        <p className="queue-kicker pulse">SEARCHING FOR AN OPPONENT…</p>
        {gameType && <p className="queue-game">{GAME_DEFINITIONS[gameType].label.toUpperCase()}</p>}
        <p className="queue-sub">
          Representing: <strong>{profile.district.toUpperCase()}</strong>
        </p>
        <p className="queue-sub">Looking for another Kerala district</p>
        {typeof status.queueSize === 'number' && (
          <p className="queue-sub">Players searching: {status.queueSize}</p>
        )}
        {typeof status.joinedAt === 'number' && (
          <p className="queue-timer">{formatElapsed(status.joinedAt, nowMs)}</p>
        )}
        <button type="button" className="secondary-btn" onClick={onCancel}>
          Cancel
        </button>
      </section>
    </div>
  );
}
