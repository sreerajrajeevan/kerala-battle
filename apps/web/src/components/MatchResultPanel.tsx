import { useEffect, useState, type CSSProperties } from 'react';
import {
  type DistrictsLeaderboardPayload,
  type KeralaDistrict,
  type MatchFinishedPayload,
  type MatchPlayerInfo,
  type PlayerProfile,
} from '@kerala-battle/shared';
import { districtHue } from '../lib/visual';

interface MatchResultPanelProps {
  gameLabel: string;
  finalResult: MatchFinishedPayload;
  players: [MatchPlayerInfo, MatchPlayerInfo];
  profile: PlayerProfile;
  serverUrl: string;
  winnerText: string;
  /** Extra suffix after each total (e.g. " 👑" for Crown Rush). */
  scoreSuffix?: string;
  onRematch: () => void;
  onReturnToLobby: () => void;
  onFindNextRanked: () => void;
}

async function fetchDistricts(serverUrl: string): Promise<DistrictsLeaderboardPayload | null> {
  try {
    const response = await fetch(`${serverUrl}/api/leaderboards/districts`);
    if (!response.ok) return null;
    return (await response.json()) as DistrictsLeaderboardPayload;
  } catch {
    return null;
  }
}

/**
 * Shared finished-match panel for both games. Ranked matches show the
 * server-computed settlement and the district's weekly rank; casual matches
 * show an explicit "no ranking points" note and never a +0 award line.
 */
export default function MatchResultPanel({
  gameLabel,
  finalResult,
  players,
  profile,
  serverUrl,
  winnerText,
  scoreSuffix = '',
  onRematch,
  onReturnToLobby,
  onFindNextRanked,
}: MatchResultPanelProps) {
  const ranked = finalResult.matchMode === 'ranked';
  const [districtRank, setDistrictRank] = useState<number | null>(null);

  const myIndex = players.findIndex((player) => player.playerId === profile.playerId);
  const myDistrict: KeralaDistrict =
    finalResult.districts[myIndex === 1 ? 1 : 0] ?? profile.district;

  useEffect(() => {
    if (!ranked) return;
    let cancelled = false;
    void fetchDistricts(serverUrl).then((data) => {
      if (cancelled || !data) return;
      setDistrictRank(
        data.districts.find((entry) => entry.district === myDistrict)?.rank ?? null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [ranked, serverUrl, myDistrict]);

  const settlement = finalResult.settlement?.[profile.playerId];

  return (
    <section className="pc-final">
      <h3>{gameLabel}</h3>
      <p className={ranked ? 'match-mode-badge ranked' : 'match-mode-badge casual'}>
        {ranked ? 'RANKED WEEKLY BATTLE' : 'CASUAL MATCH'}
      </p>
      {finalResult.totals.map((entry, index) => {
        const district = finalResult.districts[index] ?? myDistrict;
        return (
          <div
            key={entry.playerId}
            className={entry.playerId === profile.playerId ? 'pc-row me' : 'pc-row'}
          >
            <span>
              <span
                className="pc-district-tag"
                style={{ '--district-hue': districtHue(district) } as CSSProperties}
              >
                {district.toUpperCase()}
              </span>{' '}
              {entry.displayName}
            </span>
            <span>
              {entry.total}
              {scoreSuffix}
            </span>
          </div>
        );
      })}
      <div className="pc-winner">{winnerText}</div>

      {ranked && settlement && (
        <div className="pc-settlement">
          <div className="pc-award">+{settlement.personalPointsAwarded} Weekly Points</div>
          {settlement.districtPointsAwarded > 0 ? (
            <div className="pc-award">
              +{settlement.districtPointsAwarded} {settlement.district} Points
            </div>
          ) : (
            <div className="pc-award-dim">District daily contribution cap reached</div>
          )}
          {settlement.districtPointsAwarded > 0 &&
            settlement.districtPointsAwarded < settlement.personalPointsAwarded && (
              <div className="pc-award-dim">
                Daily district contribution: {settlement.dailyDistrictContribution}/
                {settlement.dailyDistrictContributionCap}
              </div>
            )}
          {districtRank !== null && (
            <div className="pc-award-dim">
              {myDistrict} Weekly Rank: #{districtRank}
            </div>
          )}
        </div>
      )}

      {!ranked && (
        <div className="pc-settlement">
          <div className="pc-award-dim">No weekly ranking points for casual matches.</div>
          <div className="pc-award-dim">Join the Weekly Battle to play ranked.</div>
        </div>
      )}

      <div className="pc-actions">
        <button type="button" className="primary-btn" onClick={onRematch}>
          {ranked ? 'Rematch (Casual)' : 'Rematch'}
        </button>
        {ranked && (
          <button type="button" className="primary-btn" onClick={onFindNextRanked}>
            Find Next Ranked Match
          </button>
        )}
        <button type="button" className="secondary-btn" onClick={onReturnToLobby}>
          Return to Lobby
        </button>
      </div>
    </section>
  );
}
