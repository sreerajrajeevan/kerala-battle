/** Authoritative per-player simulation state (server only). */
export interface SimPlayer {
  playerId: string;
  x: number;
  y: number;
  /** Last sanitized input vector (magnitude <= 1). */
  inputX: number;
  inputY: number;
  score: number;
}

export interface SimCrown {
  x: number;
  y: number;
  golden: boolean;
}

/**
 * Full authoritative Crown Rush simulation state.
 * Match phase (countdown/playing/suddenDeath/finished) is owned by the
 * runner, not the sim: the pure engine never reads it.
 */
export interface CrownRushSim {
  players: [SimPlayer, SimPlayer];
  crown: SimCrown | null;
  /** Ms remaining on the normal match clock (unused in sudden death). */
  timeRemainingMs: number;
  suddenDeath: boolean;
  captureSeq: number;
}
