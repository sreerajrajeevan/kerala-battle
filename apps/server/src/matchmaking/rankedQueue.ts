/**
 * In-memory ranked battle queue.
 *
 * Pure data structure: arrival-ordered entries, earliest-compatible pairing,
 * duplicate protection, and stale-week sweeping. All socket/clock side
 * effects live in the matchmaker that drives this queue.
 */

import type { GameType, KeralaDistrict } from '@kerala-battle/shared';

export interface QueuedPlayer {
  socketId: string;
  playerId: string;
  displayName: string;
  district: KeralaDistrict;
  joinedAt: number;
  /** Competition week this entry belongs to; entries from an older week are stale. */
  competitionWeekId: string;
  /** Featured game snapshotted when the player joined. */
  featuredGameType: GameType;
}

export class RankedQueue {
  private entries: QueuedPlayer[] = [];

  size(): number {
    return this.entries.length;
  }

  hasPlayer(playerId: string): boolean {
    return this.entries.some((entry) => entry.playerId === playerId);
  }

  hasSocket(socketId: string): boolean {
    return this.entries.some((entry) => entry.socketId === socketId);
  }

  /**
   * Earliest queued player from a district different than the newcomer's.
   * Same-district players are never paired: the district competition must
   * genuinely represent inter-district matches.
   */
  findPartner(newcomer: Pick<QueuedPlayer, 'district'>): QueuedPlayer | undefined {
    return this.entries.find((entry) => entry.district !== newcomer.district);
  }

  /**
   * Atomically pairs the newcomer with the earliest compatible partner.
   * Returns the partner (both leave the queue), or undefined when nobody
   * compatible is waiting — in which case the newcomer is enqueued.
   * Callers must check hasPlayer/hasSocket first; this never duplicates.
   */
  pairOrEnqueue(newcomer: QueuedPlayer): QueuedPlayer | undefined {
    const partner = this.findPartner(newcomer);
    if (!partner) {
      this.entries.push(newcomer);
      return undefined;
    }
    this.entries = this.entries.filter((entry) => entry !== partner);
    return partner;
  }

  /** Remove a queue entry by socket. Returns the removed entry, if any. */
  removeBySocket(socketId: string): QueuedPlayer | undefined {
    const entry = this.entries.find((candidate) => candidate.socketId === socketId);
    if (entry) this.entries = this.entries.filter((candidate) => candidate !== entry);
    return entry;
  }

  /** Remove a queue entry by player. Returns the removed entry, if any. */
  removeByPlayerId(playerId: string): QueuedPlayer | undefined {
    const entry = this.entries.find((candidate) => candidate.playerId === playerId);
    if (entry) this.entries = this.entries.filter((candidate) => candidate !== entry);
    return entry;
  }

  /**
   * Drop entries queued under an older competition week. Returns the removed
   * entries so the caller can notify their sockets.
   */
  sweepStaleWeek(currentWeekId: string): QueuedPlayer[] {
    const stale = this.entries.filter((entry) => entry.competitionWeekId !== currentWeekId);
    if (stale.length > 0) {
      this.entries = this.entries.filter((entry) => entry.competitionWeekId === currentWeekId);
    }
    return stale;
  }

  /** Snapshot for tests/debugging. */
  list(): readonly QueuedPlayer[] {
    return [...this.entries];
  }
}
