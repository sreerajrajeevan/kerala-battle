import { useEffect, useState } from 'react';
import {
  CompetitionWeekFinalizedEvent,
  type CurrentCompetitionPayload,
  type PreviousChampionInfo,
} from '@kerala-battle/shared';
import type { DistrictSocket } from '../App';

/**
 * The most recently finalized week's champions, for the lobby's "last week"
 * banner, the Weekly Master avatar badge, and the defending-district badge.
 * Server-authoritative: clients never decide who the master is. Refetches
 * when a week gets finalized while the app is open.
 */
export function usePreviousChampion(
  serverUrl: string,
  socket: DistrictSocket | null,
): PreviousChampionInfo | null {
  const [previous, setPrevious] = useState<PreviousChampionInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`${serverUrl}/api/competition/current`, { credentials: 'include' });
        if (!response.ok) return;
        const data = (await response.json()) as CurrentCompetitionPayload;
        if (!cancelled) setPrevious(data.previousChampion);
      } catch {
        // Leave the previous value; the lobby works fine without the banner.
      }
    };
    void load();
    const handleFinalized = (): void => {
      void load();
    };
    socket?.on(CompetitionWeekFinalizedEvent, handleFinalized);
    return () => {
      cancelled = true;
      socket?.off(CompetitionWeekFinalizedEvent, handleFinalized);
    };
  }, [serverUrl, socket]);

  return previous;
}
