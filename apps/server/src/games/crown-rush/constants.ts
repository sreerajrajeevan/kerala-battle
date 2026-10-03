/**
 * Crown Rush simulation constants that only the server loop needs.
 * Gameplay constants (speed, arena, radii, scoring) live in @kerala-battle/shared
 * because the client needs them for prediction and rendering.
 */

/** Simulation ticks per second. */
export const CROWN_RUSH_TICK_HZ = 30;
/** Authoritative state broadcasts per second. */
export const CROWN_RUSH_SNAPSHOT_HZ = 12;
