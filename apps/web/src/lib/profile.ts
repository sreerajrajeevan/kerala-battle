import {
  KERALA_DISTRICTS,
  type KeralaDistrict,
  type PlayerProfile,
} from '@kerala-battle/shared';

const STORAGE_KEY = 'kerala-battle:profile:v1';

function generatePlayerId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Display names: 2-20 chars, Unicode letters, numbers and spaces. */
export function isValidDisplayName(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 2 && trimmed.length <= 20 && /^[\p{L}0-9 ]+$/u.test(trimmed)
  );
}

export function createProfile(displayName: string, district: KeralaDistrict): PlayerProfile {
  return { playerId: generatePlayerId(), displayName: displayName.trim(), district };
}

function isKeralaDistrict(value: unknown): value is KeralaDistrict {
  return typeof value === 'string' && (KERALA_DISTRICTS as readonly string[]).includes(value);
}

function isValidProfile(value: unknown): value is PlayerProfile {
  if (typeof value !== 'object' || value === null) return false;
  const { playerId, displayName, district } = value as Record<string, unknown>;
  return (
    typeof playerId === 'string' &&
    playerId.length > 0 &&
    typeof displayName === 'string' &&
    isValidDisplayName(displayName) &&
    isKeralaDistrict(district)
  );
}

/** Load the saved guest profile, or null on first visit / corrupt data. */
export function loadProfile(): PlayerProfile | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidProfile(parsed)) return null;
    return {
      playerId: parsed.playerId,
      displayName: parsed.displayName.trim(),
      district: parsed.district,
    };
  } catch {
    return null;
  }
}

export function saveProfile(profile: PlayerProfile): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
}
