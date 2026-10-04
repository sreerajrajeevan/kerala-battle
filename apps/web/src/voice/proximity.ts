import {
  VOICE_FULL_VOLUME_DISTANCE,
  VOICE_MAX_HEARING_DISTANCE,
  VOICE_VOLUME_SMOOTHING,
} from '@kerala-battle/shared';

export interface Point {
  x: number;
  y: number;
}

/**
 * Distance between two lobby positions in world units. Invalid coordinates
 * are treated as infinitely far away (silent), never as nearby.
 */
export function distanceBetween(a: Point, b: Point): number {
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Linear proximity fade for one remote participant's playback volume:
 *   distance <= FULL_VOLUME_DISTANCE -> 1
 *   distance >= MAX_HEARING_DISTANCE  -> 0
 *   between                            -> linear interpolation
 * Invalid distances are silent (0), never loud.
 */
export function volumeForDistance(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  const clamped = Math.max(0, distance);
  if (clamped <= VOICE_FULL_VOLUME_DISTANCE) return 1;
  if (clamped >= VOICE_MAX_HEARING_DISTANCE) return 0;
  return (
    1 -
    (clamped - VOICE_FULL_VOLUME_DISTANCE) /
      (VOICE_MAX_HEARING_DISTANCE - VOICE_FULL_VOLUME_DISTANCE)
  );
}

/**
 * Final per-participant volume after local overrides. A local mute of the
 * participant (or the "voice off" deafen switch) always wins over distance.
 */
export function effectiveRemoteVolume(options: {
  distanceVolume: number;
  locallyMuted: boolean;
  voiceEnabled: boolean;
  /** Persistent block: always silent for the blocker, regardless of proximity. */
  blocked?: boolean;
}): number {
  if (options.blocked || options.locallyMuted || !options.voiceEnabled) return 0;
  return Math.min(1, Math.max(0, options.distanceVolume));
}

/**
 * Smoothly moves the current applied volume toward the target (basic lerp).
 * Snaps when close enough so the interval can stop calling setVolume.
 */
export function lerpVolume(
  current: number,
  target: number,
  factor: number = VOICE_VOLUME_SMOOTHING,
): number {
  const clampedCurrent = Math.min(1, Math.max(0, current));
  const clampedTarget = Math.min(1, Math.max(0, target));
  const next = clampedCurrent + (clampedTarget - clampedCurrent) * factor;
  if (Math.abs(next - clampedTarget) < 0.005) return clampedTarget;
  return next;
}
