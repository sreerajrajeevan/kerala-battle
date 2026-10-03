import { useCallback, useEffect, useState } from 'react';
import type {
  CompetitionHistoryPayload,
  HistoricalWeekDetail,
  HistoricalWeekSummary,
} from '@kerala-battle/shared';

interface HistoryViewProps {
  serverUrl: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return (await response.json()) as T;
}

/** "2026-W40" -> "WEEK 40". */
function weekLabel(weekId: string): string {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(weekId);
  return match ? `WEEK ${Number.parseInt(match[2] as string, 10)}` : weekId;
}

function ChampionLines({ week }: { week: HistoricalWeekSummary }) {
  return (
    <>
      {week.weeklyMaster ? (
        <p className="hist-champ">
          👑 {week.weeklyMaster.displayName}
          <span className="hist-champ-sub">
            {week.weeklyMaster.district} · {week.weeklyMaster.points} pts
          </span>
        </p>
      ) : (
        <p className="hist-champ hist-champ-none">👑 No qualifying player</p>
      )}
      {week.districtChampion ? (
        <p className="hist-champ">
          🏆 {week.districtChampion.district}
          <span className="hist-champ-sub">{week.districtChampion.points} pts</span>
        </p>
      ) : (
        <p className="hist-champ hist-champ-none">🏆 No qualifying district</p>
      )}
    </>
  );
}

/**
 * Hall of Fame: recent finalized weeks with their crowned champions, plus a
 * per-week detail view. Everything shown comes from immutable snapshots —
 * never from the live leaderboards.
 */
export default function HistoryView({ serverUrl }: HistoryViewProps) {
  const [weeks, setWeeks] = useState<HistoricalWeekSummary[] | null>(null);
  const [detail, setDetail] = useState<HistoricalWeekDetail | null>(null);
  const [detailWeekId, setDetailWeekId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const data = await fetchJson<CompetitionHistoryPayload>(
        `${serverUrl}/api/competition/history?limit=12`,
      );
      setWeeks(data.weeks);
      setError(null);
    } catch {
      setError('Could not load history. Check your connection and try again.');
    }
  }, [serverUrl]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openWeek = useCallback(
    async (weekId: string) => {
      setDetailWeekId(weekId);
      setDetail(null);
      setError(null);
      try {
        const data = await fetchJson<HistoricalWeekDetail>(
          `${serverUrl}/api/competition/history/${encodeURIComponent(weekId)}`,
        );
        setDetail(data);
      } catch {
        setError('Could not load that week. Please try again.');
      }
    },
    [serverUrl],
  );

  if (detailWeekId) {
    return (
      <div className="hist-detail">
        <button type="button" className="secondary-btn" onClick={() => setDetailWeekId(null)}>
          ← All weeks
        </button>
        {error && <p className="comp-error">{error}</p>}
        {!detail && !error && <p className="comp-empty">Loading…</p>}
        {detail && (
          <>
            <h3 className="hist-title">{weekLabel(detail.competitionWeekId)} RESULTS</h3>
            <p className="hist-game">Featured game: {detail.featuredGameLabel}</p>
            <section className="hist-section">
              <h4>Weekly Master</h4>
              <ChampionLines week={detail} />
            </section>
            <section className="hist-section">
              <h4>Districts</h4>
              <ol className="comp-list">
                {detail.districts.map((entry) => (
                  <li key={entry.district} className="comp-row">
                    <span className="comp-rank">{entry.rank}</span>
                    <span className="comp-name">{entry.district}</span>
                    <span className="comp-meta">
                      {entry.activePlayers} players · {entry.wins} wins
                    </span>
                    <span className="comp-points">{entry.points}</span>
                  </li>
                ))}
              </ol>
            </section>
            <section className="hist-section">
              <h4>Players</h4>
              {detail.players.length === 0 ? (
                <p className="comp-empty">No ranked matches that week.</p>
              ) : (
                <ol className="comp-list">
                  {detail.players.map((entry) => (
                    <li key={entry.playerId} className="comp-row">
                      <span className="comp-rank">{entry.rank}</span>
                      <span className="comp-name">{entry.displayName}</span>
                      <span className="comp-meta">
                        {entry.district} · {entry.wins}W {entry.draws}D {entry.losses}L
                      </span>
                      <span className="comp-points">{entry.points}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="hist-list">
      {error && <p className="comp-error">{error}</p>}
      {weeks === null && !error && <p className="comp-empty">Loading…</p>}
      {weeks && weeks.length === 0 && (
        <p className="comp-empty">
          No finalized weeks yet. Champions are crowned when the first week ends.
        </p>
      )}
      {weeks?.map((week) => (
        <article key={week.competitionWeekId} className="hist-card">
          <header className="hist-card-header">
            <h4>{weekLabel(week.competitionWeekId)}</h4>
            <span className="hist-card-game">{week.featuredGameLabel}</span>
          </header>
          <ChampionLines week={week} />
          <button
            type="button"
            className="secondary-btn hist-view-btn"
            onClick={() => void openWeek(week.competitionWeekId)}
          >
            View results
          </button>
        </article>
      ))}
    </div>
  );
}
