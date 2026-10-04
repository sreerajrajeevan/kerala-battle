/**
 * Lightweight in-memory rate limiter (Task 10).
 *
 * Fixed-window counters keyed by an arbitrary string (IP, playerId, socket).
 * Single-server prototype: the interface is deliberately narrow so a Redis
 * backend can replace it later without touching call sites.
 *
 * Movement packets and other hot game loops are NEVER passed through this;
 * only abuse-prone entry points (auth, voice tokens, reports, challenges,
 * queue joins, renames) are limited.
 */

export interface RateLimitRule {
  /** Window length in ms. */
  windowMs: number;
  /** Max allowed hits per window. */
  max: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Ms until the window resets (present when rejected). */
  retryAfterMs?: number;
}

interface WindowState {
  windowStart: number;
  count: number;
}

/** Injectable clock for tests. */
export type Clock = () => number;

export class RateLimiter {
  private readonly windows = new Map<string, WindowState>();
  private readonly clock: Clock;

  constructor(clock: Clock = Date.now) {
    this.clock = clock;
  }

  check(key: string, rule: RateLimitRule): RateLimitResult {
    const now = this.clock();
    const state = this.windows.get(key);
    if (!state || now - state.windowStart >= rule.windowMs) {
      this.windows.set(key, { windowStart: now, count: 1 });
      return { ok: true };
    }
    if (state.count < rule.max) {
      state.count += 1;
      return { ok: true };
    }
    return { ok: false, retryAfterMs: state.windowStart + rule.windowMs - now };
  }

  /** Number of tracked keys (for tests/debugging). */
  size(): number {
    return this.windows.size;
  }
}

/** Shared rule set so limits stay consistent across HTTP + socket paths. */
export const RATE_LIMIT_RULES = {
  /** Google sign-in attempts, per IP. */
  authAttempts: { windowMs: 60_000, max: 10 },
  /** LiveKit token requests, per player. */
  voiceToken: { windowMs: 60_000, max: 10 },
  /** Reports, per reporter. */
  reports: { windowMs: 3_600_000, max: 10 },
  /** Direct challenge sends, per player. */
  challengeSend: { windowMs: 60_000, max: 20 },
  /** Ranked queue joins, per player. */
  rankedQueueJoin: { windowMs: 60_000, max: 10 },
  /** Profile rename API calls, per player (cooldown is the real guard). */
  profileRename: { windowMs: 60_000, max: 5 },
  /** Block/unblock actions, per player. */
  blocks: { windowMs: 60_000, max: 20 },
} satisfies Record<string, RateLimitRule>;
