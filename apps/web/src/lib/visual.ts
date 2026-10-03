import { KERALA_DISTRICTS, type KeralaDistrict } from '@kerala-battle/shared';

/** Deterministic avatar color from a player ID (stable across renders). */
export function avatarColor(playerId: string): string {
  let hash = 0;
  for (let i = 0; i < playerId.length; i++) {
    hash = (hash * 31 + playerId.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360}, 65%, 52%)`;
}

/** Subtle deterministic accent hue per district. */
export function districtHue(district: KeralaDistrict): number {
  return (KERALA_DISTRICTS.indexOf(district) * 47) % 360;
}
