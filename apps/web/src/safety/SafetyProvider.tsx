import { useCallback, useEffect, useState } from 'react';
import type { BlockEntry, CreateReportRequest } from '@kerala-battle/shared';
import { SafetyContext } from './safetyContext';
import type { SafetyContextValue } from './safetyTypes';

interface SafetyProviderProps {
  serverUrl: string;
  /** Only fetch when the viewer is authenticated. */
  enabled: boolean;
  children: React.ReactNode;
}

export function SafetyProvider({ serverUrl, enabled, children }: SafetyProviderProps) {
  const [blockedList, setBlockedList] = useState<BlockEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) {
      setBlockedList([]);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`${serverUrl}/api/blocks`, { credentials: 'include' });
      if (response.ok) {
        const body = (await response.json()) as { blocks?: BlockEntry[] };
        setBlockedList(Array.isArray(body.blocks) ? body.blocks : []);
      }
    } catch {
      // Keep the previous list on network failure.
    } finally {
      setLoading(false);
    }
  }, [serverUrl, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const blockPlayer = useCallback(
    async (playerId: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const response = await fetch(`${serverUrl}/api/blocks`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blockedPlayerId: playerId }),
        });
        if (!response.ok) {
          if (response.status === 409) {
            await refresh();
            return { ok: true };
          }
          return { ok: false, error: 'Could not block player' };
        }
        await refresh();
        return { ok: true };
      } catch {
        return { ok: false, error: 'Could not reach the server' };
      }
    },
    [serverUrl, refresh],
  );

  const unblockPlayer = useCallback(
    async (playerId: string): Promise<void> => {
      try {
        await fetch(`${serverUrl}/api/blocks/${encodeURIComponent(playerId)}`, {
          method: 'DELETE',
          credentials: 'include',
        });
      } catch {
        // Best effort.
      }
      await refresh();
    },
    [serverUrl, refresh],
  );

  const reportPlayer = useCallback(
    async (
      input: Omit<CreateReportRequest, 'reportedPlayerId'> & { reportedPlayerId: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const response = await fetch(`${serverUrl}/api/reports`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          return { ok: false, error: body.error ?? 'Could not submit report' };
        }
        return { ok: true };
      } catch {
        return { ok: false, error: 'Could not reach the server' };
      }
    },
    [serverUrl],
  );

  const blockedIds = new Set(blockedList.map((entry) => entry.playerId));
  const value: SafetyContextValue = {
    blockedIds,
    blockedList,
    loading,
    blockPlayer,
    unblockPlayer,
    reportPlayer,
    refresh,
  };
  return <SafetyContext.Provider value={value}>{children}</SafetyContext.Provider>;
}
