import { useCallback, useEffect, useState } from 'react';
import {
  CompetitionUpdatedEvent,
  GAME_DEFINITIONS,
  type CompetitionUpdatedPayload,
  type CurrentCompetitionPayload,
  type DistrictsLeaderboardPayload,
  type PlayersLeaderboardPayload,
  type PlayerProfile,
} from '@kerala-battle/shared';
import type { DistrictSocket } from '../App';
import HistoryView from './HistoryView';

interface CompetitionViewProps {
  socket: DistrictSocket | null;
  profile: PlayerProfile;
  serverUrl: string;
  onClose: () => void;
  onJoinWeeklyBattle: () => void;
}

type Tab = 'districts' | 'players' | 'history';

/** "2d 14h" style countdown from the server-provided week end timestamp. */
function formatCountdown(endsAt: string, nowMs: number): string {
  const ms = new Date(endsAt).getTime() - nowMs;
  if (Number.isNaN(ms) || ms <= 0) return 'ending…';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return (await response.json()) as T;
}

export default function CompetitionView({
  socket,
  profile,
  serverUrl,
  onClose,
  onJoinWeeklyBattle,
}: CompetitionViewProps) {
  const [tab, setTab] = useState<Tab>('districts');
  const [playersData, setPlayersData] = useState<PlayersLeaderboardPayload | null>(null);
  const [districtsData, setDistrictsData] = useState<DistrictsLeaderboardPayload | null>(null);
  const [current, setCurrent] = useState<CurrentCompetitionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const [players, districts, competition] = await Promise.all([
        fetchJson<PlayersLeaderboardPayload>(
          `${serverUrl}/api/leaderboards/players?limit=50&playerId=${encodeURIComponent(profile.playerId)}`,
        ),
        fetchJson<DistrictsLeaderboardPayload>(`${serverUrl}/api/leaderboards/districts`),
        fetchJson<CurrentCompetitionPayload>(`${serverUrl}/api/competition/current`),
      ]);
      setPlayersData(players);
      setDistrictsData(districts);
      setCurrent(competition);
      setError(null);
    } catch {
      setError('Could not load standings. Check your connection and try again.');
    }
  }, [serverUrl, profile.playerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live standings: a settled match anywhere pings us to refetch.
  useEffect(() => {
    if (!socket) return;
    const handleUpdated = (_payload: CompetitionUpdatedPayload) => {
      void refresh();
    };
    socket.on(CompetitionUpdatedEvent, handleUpdated);
    return () => {
      socket.off(CompetitionUpdatedEvent, handleUpdated);
    };
  }, [socket, refresh]);

  // Tick the "Ends in" countdown.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const week = districtsData?.week ?? playersData?.week ?? null;
  const me = playersData?.me ?? null;

  return (
    <div className="comp-overlay" role="dialog" aria-label="Weekly competition standings">
      <section className="comp-panel">
        <header className="comp-header">
          <h2>🏆 Kerala Weekly Battle</h2>
          <button type="button" className="secondary-btn" onClick={onClose}>
            Close
          </button>
        </header>

        {week && <p className="comp-countdown">Ends in: {formatCountdown(week.endsAt, nowMs)}</p>}

        {current && (
          <section className="comp-featured">
            <p className="comp-featured-kicker">THIS WEEK</p>
            <p className="comp-featured-game">
              👑 {GAME_DEFINITIONS[current.featuredGame.gameType].label.toUpperCase()}
            </p>
            <button type="button" className="primary-btn" onClick={onJoinWeeklyBattle}>
              Join Weekly Battle
            </button>
          </section>
        )}

        <section className="comp-me">
          <h3>Your week</h3>
          {me ? (
            <div className="comp-me-grid">
              <div>
                <span className="comp-me-label">Rank</span>
                <span className="comp-me-value">#{me.rank}</span>
              </div>
              <div>
                <span className="comp-me-label">Points</span>
                <span className="comp-me-value">{me.points}</span>
              </div>
              <div>
                <span className="comp-me-label">Wins</span>
                <span className="comp-me-value">{me.wins}</span>
              </div>
              <div>
                <span className="comp-me-label">Matches</span>
                <span className="comp-me-value">{me.matchesPlayed}</span>
              </div>
              <div className="comp-me-wide">
                <span className="comp-me-label">District contribution</span>
                <span className="comp-me-value">
                  {me.dailyDistrictContribution}/{me.dailyDistrictContributionCap} today
                </span>
              </div>
            </div>
          ) : (
            <p className="comp-empty">No ranked matches yet. Join the Weekly Battle to start earning points.</p>
          )}
        </section>

        <nav className="comp-tabs">
          <button
            type="button"
            className={tab === 'districts' ? 'comp-tab active' : 'comp-tab'}
            onClick={() => setTab('districts')}
          >
            Districts
          </button>
          <button
            type="button"
            className={tab === 'players' ? 'comp-tab active' : 'comp-tab'}
            onClick={() => setTab('players')}
          >
            Players
          </button>
          <button
            type="button"
            className={tab === 'history' ? 'comp-tab active' : 'comp-tab'}
            onClick={() => setTab('history')}
          >
            History
          </button>
        </nav>

        {error && <p className="comp-error">{error}</p>}

        {tab === 'history' && <HistoryView serverUrl={serverUrl} />}

        {tab === 'districts' && districtsData && (
          <ol className="comp-list">
            {districtsData.districts.map((entry) => (
              <li
                key={entry.district}
                className={entry.district === profile.district ? 'comp-row mine' : 'comp-row'}
              >
                <span className="comp-rank">{entry.rank}</span>
                <span className="comp-name">{entry.district}</span>
                <span className="comp-meta">
                  {entry.activePlayers} players ·{' '}
                  {entry.activePlayers > 0 ? entry.pointsPerActivePlayer.toFixed(1) : '0.0'}/player
                </span>
                <span className="comp-points">{entry.points}</span>
              </li>
            ))}
          </ol>
        )}

        {tab === 'players' && playersData && (
          <ol className="comp-list">
            {playersData.players.map((entry) => (
              <li
                key={entry.playerId}
                className={entry.playerId === profile.playerId ? 'comp-row mine' : 'comp-row'}
              >
                <span className="comp-rank">{entry.rank}</span>
                <span className="comp-name">{entry.displayName}</span>
                <span className="comp-meta">{entry.district}</span>
                <span className="comp-points">{entry.points}</span>
              </li>
            ))}
            {playersData.players.length === 0 && (
              <p className="comp-empty">No ranked matches this week yet.</p>
            )}
          </ol>
        )}
      </section>
    </div>
  );
}
