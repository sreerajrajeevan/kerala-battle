/**
 * Crown Rush match runner: owns the server-authoritative simulation loop for
 * one 1v1 match. Clients submit input vectors; the server integrates movement,
 * decides captures, runs the clock, and broadcasts snapshots.
 *
 * Every timer/interval is tracked and cleared on finish or destroy, so no
 * match ever leaks a game loop.
 */
import type { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import {
  CROWN_RUSH_DURATION_MS,
  CROWN_RUSH_RESPAWN_DELAY_MS,
  CROWN_RUSH_SUDDEN_DEATH_FAILSAFE_MS,
  CrownRushStateEvent,
  GAME_TYPE_CROWN_RUSH,
  MATCH_MODE_CASUAL,
  MATCH_SOURCE_DIRECT_CHALLENGE,
  type ClientToServerEvents,
  type CrownRushStatePayload,
  type CrownRushStatus,
  type KeralaDistrict,
  type MatchContext,
  type ServerToClientEvents,
} from '@kerala-battle/shared';
import { CROWN_RUSH_SNAPSHOT_HZ, CROWN_RUSH_TICK_HZ } from './constants.js';
import {
  applyCapture,
  checkCapture,
  createSim,
  decideTimeUp,
  isValidInputPayload,
  sanitizeInput,
  spawnCrown,
  stepPlayers,
  tickClock,
} from './engine.js';
import type { CrownRushSim } from './types.js';

export interface CrownRushParticipant {
  socketId: string;
  playerId: string;
  displayName: string;
}

export interface CrownRushFinishResult {
  winnerPlayerId: string | null;
  scores: [number, number];
}

export interface CrownRushRunnerOptions {
  tickHz?: number;
  snapshotHz?: number;
  /** Normal match duration (default 45s). Injectable for tests. */
  durationMs?: number;
  /** Crown respawn delay after a capture (default 500ms). */
  respawnDelayMs?: number;
  /** Sudden-death golden-crown relocation failsafe (default 30s). */
  suddenDeathFailsafeMs?: number;
  onFinish: (result: CrownRushFinishResult) => void;
  /**
   * Server-authoritative match context (mode/source/week/districts).
   * Defaults to a casual direct challenge between the runner's district.
   */
  matchContext?: MatchContext;
}

type IoServer = Server<ClientToServerEvents, ServerToClientEvents>;

export class CrownRushRunner {
  readonly matchId: string = randomUUID();
  readonly gameType = GAME_TYPE_CROWN_RUSH;
  readonly players: [CrownRushParticipant, CrownRushParticipant];
  readonly district: KeralaDistrict;
  /** Server-authoritative match context (ranked vs casual). */
  readonly matchContext: MatchContext;
  /** Authoritative simulation state. Public for tests; the loop owns it. */
  readonly sim: CrownRushSim;
  status: CrownRushStatus = 'countdown';
  readonly rematchWants = new Set<string>();
  readonly returnedToLobby = new Set<string>();

  private readonly io: IoServer;
  private readonly onFinish: (result: CrownRushFinishResult) => void;
  private readonly tickHz: number;
  private readonly snapshotHz: number;
  private readonly durationMs: number;
  private readonly respawnDelayMs: number;
  private readonly suddenDeathFailsafeMs: number;
  private readonly timers = new Set<NodeJS.Timeout>();
  private lastTickAt = 0;
  private lastCapture: { playerId: string; displayName: string } | null = null;
  private finished = false;

  constructor(
    io: IoServer,
    district: KeralaDistrict,
    players: [CrownRushParticipant, CrownRushParticipant],
    options: CrownRushRunnerOptions,
  ) {
    this.io = io;
    this.district = district;
    this.players = players;
    this.onFinish = options.onFinish;
    this.matchContext = options.matchContext ?? {
      matchMode: MATCH_MODE_CASUAL,
      matchSource: MATCH_SOURCE_DIRECT_CHALLENGE,
      districts: [district, district],
      startedAtMs: Date.now(),
    };
    this.tickHz = options.tickHz ?? CROWN_RUSH_TICK_HZ;
    this.snapshotHz = options.snapshotHz ?? CROWN_RUSH_SNAPSHOT_HZ;
    this.durationMs = options.durationMs ?? CROWN_RUSH_DURATION_MS;
    this.respawnDelayMs = options.respawnDelayMs ?? CROWN_RUSH_RESPAWN_DELAY_MS;
    this.suddenDeathFailsafeMs = options.suddenDeathFailsafeMs ?? CROWN_RUSH_SUDDEN_DEATH_FAILSAFE_MS;
    this.sim = createSim(players[0].playerId, players[1].playerId);
    this.sim.timeRemainingMs = this.durationMs;
  }

  get matchRoom(): string {
    return `match:${this.matchId}`;
  }

  /** Number of live timers/intervals. Must be 0 after finish/destroy. */
  get pendingTimers(): number {
    return this.timers.size;
  }

  private later(ms: number, fn: () => void): void {
    const timer: NodeJS.Timeout = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private every(ms: number, fn: () => void): void {
    const timer = setInterval(fn, ms);
    this.timers.add(timer);
  }

  private clearTimers(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.clear();
  }

  /** Begin the 3-2-1-GO countdown; gameplay starts when it elapses. */
  beginCountdown(countdownMs: number): void {
    this.later(countdownMs, () => this.startPlay());
  }

  private startPlay(): void {
    if (this.finished) return;
    this.status = 'playing';
    this.sim.crown = spawnCrown(this.sim.players, false, null);
    this.lastTickAt = Date.now();
    this.every(1000 / this.tickHz, () => this.tick());
    this.every(1000 / this.snapshotHz, () => this.broadcastState());
    this.broadcastState();
  }

  /**
   * One authoritative simulation step. Public so tests can drive the loop
   * with an explicit dt instead of waiting on real timers.
   */
  tickForTest(dtMs: number): void {
    this.tick(dtMs);
  }

  private tick(dtOverride?: number): void {
    if (this.finished) return;
    const now = Date.now();
    const dtMs = dtOverride ?? now - this.lastTickAt;
    this.lastTickAt = now;

    if (this.status === 'playing' || this.status === 'suddenDeath') {
      stepPlayers(this.sim, dtMs);
      const capturer = checkCapture(this.sim);
      if (capturer !== null) this.handleCapture(capturer);
      if (!this.sim.suddenDeath && this.status === 'playing') {
        if (tickClock(this.sim, dtMs) === 'timeUp') this.onTimeUp();
      }
    }
  }

  /**
   * Handle client movement input. The player is identified from the socket —
   * the payload must never carry a playerId. Invalid input is ignored;
   * extreme values are clamped. Input before GO or after finish is ignored.
   */
  handleInput(socketId: string, payload: unknown): void {
    if (this.finished) return;
    if (this.status !== 'playing' && this.status !== 'suddenDeath') return;
    const index =
      this.players[0].socketId === socketId ? 0 : this.players[1].socketId === socketId ? 1 : -1;
    if (index !== 0 && index !== 1) return;
    if (!isValidInputPayload(payload)) return;
    const { x, y } = sanitizeInput(payload.xAxis, payload.yAxis);
    this.sim.players[index].inputX = x;
    this.sim.players[index].inputY = y;
  }

  private handleCapture(index: 0 | 1): void {
    const previousCrown = this.sim.crown ? { x: this.sim.crown.x, y: this.sim.crown.y } : null;
    const { winner } = applyCapture(this.sim, index);
    const player = this.players[index];
    this.lastCapture = { playerId: player.playerId, displayName: player.displayName };
    if (winner !== null) {
      this.finish(this.players[winner].playerId);
      return;
    }
    // Brief respawn delay; players keep moving meanwhile.
    this.later(this.respawnDelayMs, () => {
      if (this.finished || this.sim.crown) return;
      if (this.status !== 'playing' && this.status !== 'suddenDeath') return;
      this.sim.crown = spawnCrown(this.sim.players, this.sim.suddenDeath, previousCrown);
      this.broadcastState();
    });
  }

  private onTimeUp(): void {
    if (this.finished) return;
    const decision = decideTimeUp(this.sim);
    if (decision === 'suddenDeath') this.enterSuddenDeath();
    else this.finish(this.players[decision].playerId);
  }

  private enterSuddenDeath(): void {
    this.status = 'suddenDeath';
    this.sim.suddenDeath = true;
    this.sim.timeRemainingMs = 0;
    this.sim.crown = spawnCrown(this.sim.players, true, null);
    this.armFailsafe();
    this.broadcastState();
  }

  private armFailsafe(): void {
    this.later(this.suddenDeathFailsafeMs, () => {
      if (this.finished || this.status !== 'suddenDeath') return;
      // Relocate the golden crown instead of declaring a draw.
      const avoid = this.sim.crown ? { x: this.sim.crown.x, y: this.sim.crown.y } : null;
      this.sim.crown = spawnCrown(this.sim.players, true, avoid);
      this.armFailsafe();
      this.broadcastState();
    });
  }

  private finish(winnerPlayerId: string | null): void {
    if (this.finished) return;
    this.finished = true;
    this.status = 'finished';
    this.clearTimers();
    this.broadcastState();
    this.onFinish({
      winnerPlayerId,
      scores: [this.sim.players[0].score, this.sim.players[1].score],
    });
  }

  /**
   * Abort the match without settlement (disconnect / cleanup path).
   * Idempotent and safe to call on an already-finished match.
   */
  destroy(): void {
    this.finished = true;
    this.status = 'finished';
    this.clearTimers();
  }

  private broadcastState(): void {
    const names = [this.players[0].displayName, this.players[1].displayName];
    const payload: CrownRushStatePayload = {
      matchId: this.matchId,
      serverTime: Date.now(),
      status: this.status,
      timeRemainingMs: Math.max(0, Math.round(this.sim.timeRemainingMs)),
      suddenDeath: this.sim.suddenDeath,
      players: this.sim.players.map((player, i) => ({
        playerId: player.playerId,
        displayName: names[i] ?? player.playerId,
        x: Math.round(player.x),
        y: Math.round(player.y),
        score: player.score,
      })),
      crown: this.sim.crown
        ? { x: this.sim.crown.x, y: this.sim.crown.y, golden: this.sim.crown.golden }
        : null,
      lastCapture: this.lastCapture
        ? { ...this.lastCapture, captureSeq: this.sim.captureSeq }
        : null,
    };
    this.io.to(this.matchRoom).emit(CrownRushStateEvent, payload);
  }
}
