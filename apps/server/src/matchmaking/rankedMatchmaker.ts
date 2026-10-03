/**
 * Weekly ranked battle matchmaker.
 *
 * Owns the queue lifecycle: join validation, cross-district pairing, the
 * short "match found" presentation window, and cleanup on cancel /
 * disconnect / week rollover. Match creation itself is injected, so this
 * module never duplicates game logic.
 *
 * Security: the client supplies nothing but the join/cancel intent. Game,
 * week, district, identity, mode, and source are all server-decided.
 */

import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import {
  MATCH_MODE_RANKED,
  MATCH_SOURCE_WEEKLY_QUEUE,
  RankedQueueErrorEvent,
  RankedQueueMatchedEvent,
  RankedQueueStatusEvent,
  type ClientToServerEvents,
  type KeralaDistrict,
  type MatchContext,
  type RankedQueueErrorReason,
  type RankedQueueMatchedPayload,
  type RankedQueueStatusPayload,
  type ServerToClientEvents,
} from '@kerala-battle/shared';
import type { CompetitionWeekConfig } from '../competition/featuredGame.js';
import { RankedQueue, type QueuedPlayer } from './rankedQueue.js';

/** How long the "MATCH FOUND" presentation shows before the match starts. */
export const RANKED_MATCH_INTRO_MS = 1500;

type IoServer = Server<ClientToServerEvents, ServerToClientEvents>;

export interface RankedPlayerInfo {
  socketId: string;
  playerId: string;
  displayName: string;
  district: KeralaDistrict;
}

export interface RankedMatchmakerDeps {
  io: IoServer;
  queue: RankedQueue;
  /** Live player lookup by socket id. */
  getPlayer(socketId: string): RankedPlayerInfo | undefined;
  /** True while the player is inside any match. */
  isBusy(playerId: string): boolean;
  /** True while the player has a pending incoming/outgoing challenge. */
  hasPendingChallenge(playerId: string): boolean;
  /** Current week config; creates the week row on first encounter. */
  getWeekConfig(nowMs: number): CompetitionWeekConfig;
  /** Starts the featured game for a paired couple. */
  startRankedMatch(a: RankedPlayerInfo, b: RankedPlayerInfo, week: CompetitionWeekConfig): void;
  /** Override the intro presentation delay (tests). */
  introDelayMs?: number;
}

interface PendingIntro {
  introId: string;
  a: QueuedPlayer;
  b: QueuedPlayer;
  week: CompetitionWeekConfig;
  timer: NodeJS.Timeout;
}

/** Build the server-authoritative ranked match context for a paired couple. */
export function rankedMatchContext(
  a: Pick<QueuedPlayer, 'district'>,
  b: Pick<QueuedPlayer, 'district'>,
  week: CompetitionWeekConfig,
  startedAtMs: number,
): MatchContext {
  return {
    matchMode: MATCH_MODE_RANKED,
    matchSource: MATCH_SOURCE_WEEKLY_QUEUE,
    competitionWeekId: week.competitionWeekId,
    districts: [a.district, b.district],
    startedAtMs,
  };
}

export class RankedMatchmaker {
  private readonly deps: RankedMatchmakerDeps;
  private readonly pendings = new Map<string, PendingIntro>();

  constructor(deps: RankedMatchmakerDeps) {
    this.deps = deps;
  }

  private get io(): IoServer {
    return this.deps.io;
  }

  private emitStatus(socketId: string, payload: RankedQueueStatusPayload): void {
    this.io.to(socketId).emit(RankedQueueStatusEvent, payload);
  }

  private emitError(socketId: string, reason: RankedQueueErrorReason): void {
    this.io.to(socketId).emit(RankedQueueErrorEvent, { reason });
  }

  /** True while the socket is queued or inside a pending match-found intro. */
  isQueued(socketId: string): boolean {
    if (this.deps.queue.hasSocket(socketId)) return true;
    for (const pending of this.pendings.values()) {
      if (pending.a.socketId === socketId || pending.b.socketId === socketId) return true;
    }
    return false;
  }

  join(socketId: string): void {
    const player = this.deps.getPlayer(socketId);
    if (!player) {
      this.emitError(socketId, 'not-registered');
      return;
    }
    let week: CompetitionWeekConfig;
    try {
      week = this.deps.getWeekConfig(Date.now());
    } catch {
      this.emitError(socketId, 'week-unavailable');
      return;
    }

    // Week rollover: entries queued last week can never start now.
    for (const stale of this.deps.queue.sweepStaleWeek(week.competitionWeekId)) {
      this.emitStatus(stale.socketId, { status: 'week-changed' });
    }

    if (this.deps.isBusy(player.playerId)) {
      this.emitError(socketId, 'in-match');
      return;
    }
    if (this.deps.hasPendingChallenge(player.playerId)) {
      this.emitError(socketId, 'challenge-pending');
      return;
    }
    if (this.deps.queue.hasPlayer(player.playerId) || this.deps.queue.hasSocket(socketId)) {
      // Duplicate joins (including raw-socket spam) never create extra entries.
      this.emitError(socketId, 'already-queued');
      return;
    }

    const entry: QueuedPlayer = {
      ...player,
      joinedAt: Date.now(),
      competitionWeekId: week.competitionWeekId,
      featuredGameType: week.featuredGameType,
    };
    const partner = this.deps.queue.pairOrEnqueue(entry);
    if (!partner) {
      this.emitStatus(socketId, {
        status: 'searching',
        joinedAt: entry.joinedAt,
        featuredGameType: week.featuredGameType,
        competitionWeekId: week.competitionWeekId,
        queueSize: this.deps.queue.size(),
      });
      return;
    }

    // Paired: short presentation, then the featured game starts. Either side
    // vanishing during the intro aborts the match instead of ghost-starting.
    const introId = randomUUID();
    const matchedFor = (
      me: QueuedPlayer,
      other: QueuedPlayer,
    ): RankedQueueMatchedPayload => ({
      matchId: introId,
      gameType: week.featuredGameType,
      competitionWeekId: week.competitionWeekId,
      myDistrict: me.district,
      opponent: {
        playerId: other.playerId,
        displayName: other.displayName,
        district: other.district,
      },
    });
    this.io.to(entry.socketId).emit(RankedQueueMatchedEvent, matchedFor(entry, partner));
    this.io.to(partner.socketId).emit(RankedQueueMatchedEvent, matchedFor(partner, entry));

    const delay = this.deps.introDelayMs ?? RANKED_MATCH_INTRO_MS;
    const timer = setTimeout(() => this.beginMatch(introId), delay);
    this.pendings.set(introId, { introId, a: entry, b: partner, week, timer });
  }

  /** Cancel a pending intro; the surviving side (if any) is told to re-queue. */
  private abortIntro(introId: string, goneSocketId?: string): void {
    const pending = this.pendings.get(introId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendings.delete(introId);
    const survivor =
      pending.a.socketId === goneSocketId ? pending.b : pending.b.socketId === goneSocketId ? pending.a : undefined;
    if (survivor) {
      this.emitStatus(survivor.socketId, { status: 'cancelled' });
    }
  }

  private beginMatch(introId: string): void {
    const pending = this.pendings.get(introId);
    if (!pending) return;
    this.pendings.delete(introId);

    const aLive = this.deps.getPlayer(pending.a.socketId);
    const bLive = this.deps.getPlayer(pending.b.socketId);
    if (!aLive || !bLive) {
      // One side vanished during the intro: no ghost match.
      const survivor = aLive ?? bLive;
      if (survivor) this.emitStatus(survivor.socketId, { status: 'cancelled' });
      return;
    }
    if (this.deps.isBusy(aLive.playerId) || this.deps.isBusy(bLive.playerId)) {
      this.emitStatus(aLive.socketId, { status: 'cancelled' });
      this.emitStatus(bLive.socketId, { status: 'cancelled' });
      return;
    }
    let week: CompetitionWeekConfig;
    try {
      week = this.deps.getWeekConfig(Date.now());
    } catch {
      this.emitStatus(aLive.socketId, { status: 'week-changed' });
      this.emitStatus(bLive.socketId, { status: 'week-changed' });
      return;
    }
    if (
      week.competitionWeekId !== pending.week.competitionWeekId ||
      week.featuredGameType !== pending.week.featuredGameType
    ) {
      // The week rolled over (or the featured game was overridden) mid-intro:
      // never start last week's game after the new week begins.
      this.emitStatus(aLive.socketId, { status: 'week-changed' });
      this.emitStatus(bLive.socketId, { status: 'week-changed' });
      return;
    }
    this.deps.startRankedMatch(aLive, bLive, week);
  }

  cancel(socketId: string): void {
    const removed = this.deps.queue.removeBySocket(socketId);
    for (const [introId, pending] of [...this.pendings]) {
      if (pending.a.socketId === socketId || pending.b.socketId === socketId) {
        this.abortIntro(introId, socketId);
      }
    }
    if (removed) {
      this.emitStatus(socketId, { status: 'cancelled' });
    }
  }

  /** Socket is gone: drop its queue entry and abort any pending intro. */
  handleDisconnect(socketId: string): void {
    this.deps.queue.removeBySocket(socketId);
    for (const [introId, pending] of [...this.pendings]) {
      if (pending.a.socketId === socketId || pending.b.socketId === socketId) {
        this.abortIntro(introId, socketId);
      }
    }
  }

  /**
   * A player became busy through another flow (e.g. accepted a direct
   * challenge): they must not stay queued or ghost-pair later.
   */
  evictPlayer(playerId: string): void {
    const removed = this.deps.queue.removeByPlayerId(playerId);
    if (removed) this.emitStatus(removed.socketId, { status: 'cancelled' });
    for (const [introId, pending] of [...this.pendings]) {
      if (pending.a.playerId === playerId || pending.b.playerId === playerId) {
        const goneSocketId =
          pending.a.playerId === playerId ? pending.a.socketId : pending.b.socketId;
        this.abortIntro(introId, goneSocketId);
      }
    }
  }

  /** Pending intro count (tests). */
  pendingCount(): number {
    return this.pendings.size;
  }
}
