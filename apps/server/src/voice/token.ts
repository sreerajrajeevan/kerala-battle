import { AccessToken } from 'livekit-server-sdk';
import { KERALA_DISTRICTS, type KeralaDistrict, type VoiceParticipantMetadata } from '@kerala-battle/shared';

/**
 * LiveKit configuration, read from the environment. The API secret never
 * leaves the server: browsers only ever receive short-lived join tokens.
 */
export interface VoiceConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * Reads LiveKit config from the environment. Returns null when any value is
 * missing, in which case the server runs in the disabled voice state: token
 * requests are rejected with 'voice-disabled' and every other feature keeps
 * working.
 */
export function loadVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig | null {
  const url = env.LIVEKIT_URL?.trim();
  const apiKey = env.LIVEKIT_API_KEY?.trim();
  const apiSecret = env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

/**
 * Predictable per-district LiveKit room name, e.g. "kerala-battle-district-kannur".
 * The caller must pass the server-known district of the player; the room is
 * never taken from client input.
 */
export function voiceRoomName(district: KeralaDistrict): string {
  if (!KERALA_DISTRICTS.includes(district)) {
    throw new Error(`[voice] refusing to name a room for unknown district: ${String(district)}`);
  }
  return `kerala-battle-district-${district.toLowerCase()}`;
}

export interface VoiceTokenSubject {
  playerId: string;
  displayName: string;
  district: KeralaDistrict;
}

export interface VoiceTokenResult {
  token: string;
  url: string;
  roomName: string;
}

/**
 * Issues a LiveKit join token for the player's CURRENT district room.
 * Participant identity is the player's server-known playerId; metadata
 * carries display name + district for the UI. Grants are scoped to exactly
 * this one room (publish + subscribe, audio only by client convention).
 */
export async function createVoiceToken(
  config: VoiceConfig,
  subject: VoiceTokenSubject,
): Promise<VoiceTokenResult> {
  const roomName = voiceRoomName(subject.district);
  const metadata: VoiceParticipantMetadata = {
    playerId: subject.playerId,
    displayName: subject.displayName,
    district: subject.district,
  };
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: subject.playerId,
    name: subject.displayName,
    metadata: JSON.stringify(metadata),
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });
  const jwt = await token.toJwt();
  return { token: jwt, url: config.url, roomName };
}
