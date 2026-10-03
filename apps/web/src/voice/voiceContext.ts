import { createContext, useContext } from 'react';
import type {
  VoiceConnectionStatus,
  VoiceLeaveReason,
} from '@kerala-battle/shared';

/** Imperative handle App uses to force-leave voice on match/district changes. */
export interface VoiceController {
  leave: (reason: VoiceLeaveReason) => void;
  isConnected: () => boolean;
}

export interface VoiceContextValue {
  status: VoiceConnectionStatus;
  /** Null while the server capability check is in flight. */
  voiceAvailable: boolean | null;
  micMuted: boolean;
  /** False = "voice off": the local player hears nobody (deafen). */
  voiceEnabled: boolean;
  error: string | null;
  lastLeaveReason: VoiceLeaveReason | null;
  join: () => void;
  leave: (reason?: VoiceLeaveReason) => void;
  toggleMic: () => void;
  toggleVoice: () => void;
  toggleLocalMute: (playerId: string) => void;
  /** playerIds of remote LiveKit participants in this district room. */
  voiceParticipantIds: Set<string>;
  /** playerIds currently speaking (LiveKit active-speaker state). */
  speakingIds: Set<string>;
  /** playerIds whose microphone is currently muted. */
  remoteMicMutedIds: Set<string>;
  locallyMutedIds: Set<string>;
  /** Voice participants within hearing range of the local player. */
  nearbyVoiceCount: number;
}

export const VoiceContext = createContext<VoiceContextValue | null>(null);

export function useVoice(): VoiceContextValue {
  const value = useContext(VoiceContext);
  if (!value) throw new Error('useVoice must be used inside a VoiceProvider');
  return value;
}
