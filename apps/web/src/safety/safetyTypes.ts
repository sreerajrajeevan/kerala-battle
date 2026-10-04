import type { BlockEntry, CreateReportRequest } from '@kerala-battle/shared';

/**
 * Safety state (Task 10): the current player's persistent block list plus
 * block/report actions. Voice and challenge UI read blockedIds to silence
 * and shield without ever learning who blocked whom.
 */
export interface SafetyContextValue {
  /** playerIds this player has blocked. */
  blockedIds: Set<string>;
  blockedList: BlockEntry[];
  loading: boolean;
  blockPlayer: (playerId: string) => Promise<{ ok: boolean; error?: string }>;
  unblockPlayer: (playerId: string) => Promise<void>;
  reportPlayer: (
    input: Omit<CreateReportRequest, 'reportedPlayerId'> & { reportedPlayerId: string },
  ) => Promise<{ ok: boolean; error?: string }>;
  refresh: () => Promise<void>;
}
