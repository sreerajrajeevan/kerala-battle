import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Room, RoomEvent, Track, type RemoteAudioTrack, type RemoteParticipant } from 'livekit-client';
import {
  VOICE_MAX_HEARING_DISTANCE,
  VOICE_VOLUME_APPLY_THRESHOLD,
  VOICE_VOLUME_UPDATE_INTERVAL_MS,
  VoiceTokenEvent,
  type KeralaDistrict,
  type VoiceConnectionStatus,
  type VoiceLeaveReason,
} from '@kerala-battle/shared';
import {
  distanceBetween,
  effectiveRemoteVolume,
  lerpVolume,
  volumeForDistance,
  type Point,
} from './proximity';
import { VoiceContext, type VoiceContextValue, type VoiceController } from './voiceContext';
import { useSafety } from '../safety/safetyContext';
import type { DistrictSocket } from '../App';

/** Position snapshot the provider pulls from the lobby at each volume tick. */
export interface VoicePositionSnapshot {
  local: Point | null;
  /** playerId -> lobby position for every other tracked player. */
  remotes: Map<string, Point>;
}

interface VoiceProviderProps {
  socket: DistrictSocket | null;
  district: KeralaDistrict;
  serverUrl: string;
  getPositions: () => VoicePositionSnapshot;
  controllerRef: { current: VoiceController | null };
  children: ReactNode;
}

function micAudioTrackOf(participant: RemoteParticipant): RemoteAudioTrack | undefined {
  const publication = participant.getTrackPublication(Track.Source.Microphone);
  const track = publication?.audioTrack;
  return track && 'setVolume' in track ? (track as RemoteAudioTrack) : undefined;
}

function requestVoiceToken(
  socket: DistrictSocket,
): Promise<{ token: string; url: string; roomName: string }> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('voice-token-timeout')), 10000);
    try {
      socket.emit(VoiceTokenEvent, {}, (response) => {
        window.clearTimeout(timer);
        if (response.ok) {
          resolve({ token: response.token, url: response.url, roomName: response.roomName });
        } else {
          reject(new Error(response.error));
        }
      });
    } catch (error) {
      window.clearTimeout(timer);
      reject(error instanceof Error ? error : new Error('voice-token-failed'));
    }
  });
}

function tokenErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'voice-disabled') return 'Voice temporarily unavailable';
  if (code === 'not-registered') return 'Please rejoin your district and try again.';
  if (code === 'voice-token-timeout') return 'Voice request timed out. Please try again.';
  return 'Voice temporarily unavailable';
}

function microphoneErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission was denied. You can still move, challenge and play without voice.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found on this device.';
  }
  return 'Could not start the microphone. You can still play without voice.';
}

export default function VoiceProvider({
  socket,
  district,
  serverUrl,
  getPositions,
  controllerRef,
  children,
}: VoiceProviderProps) {
  const [status, setStatus] = useState<VoiceConnectionStatus>('idle');
  const [voiceAvailable, setVoiceAvailable] = useState<boolean | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLeaveReason, setLastLeaveReason] = useState<VoiceLeaveReason | null>(null);
  const [voiceParticipantIds, setVoiceParticipantIds] = useState<Set<string>>(new Set());
  const [speakingIds, setSpeakingIds] = useState<Set<string>>(new Set());
  const [remoteMicMutedIds, setRemoteMicMutedIds] = useState<Set<string>>(new Set());
  const [locallyMutedIds, setLocallyMutedIds] = useState<Set<string>>(new Set());
  const [nearbyVoiceCount, setNearbyVoiceCount] = useState(0);

  const roomRef = useRef<Room | null>(null);
  const statusRef = useRef<VoiceConnectionStatus>('idle');
  // Persistent blocks silence audio in the volume loop. Synced via ref so the
  // 8Hz loop never re-subscribes; blocking takes effect on the next tick.
  const { blockedIds } = useSafety();
  const micMutedRef = useRef(false);
  const voiceEnabledRef = useRef(true);
  const locallyMutedRef = useRef<Set<string>>(new Set());
  const socketRef = useRef(socket);
  socketRef.current = socket;
  const getPositionsRef = useRef(getPositions);
  getPositionsRef.current = getPositions;
  const districtRef = useRef(district);
  const volumeTimerRef = useRef(0);
  /** Smoothed per-participant volume (lerp state), keyed by playerId. */
  const currentVolumesRef = useRef(new Map<string, number>());
  /** Last volume actually applied via setVolume, keyed by playerId. */
  const appliedVolumesRef = useRef(new Map<string, number>());
  /** Persistent blocks: silenced in the 8Hz loop regardless of proximity. */
  const blockedIdsRef = useRef<Set<string>>(new Set());
  // Sync every render; the loop reads the ref so it never re-subscribes.
  blockedIdsRef.current = blockedIds;
  const nearbyCountRef = useRef(0);
  const remoteMicMutedKeyRef = useRef('');
  const participantIdsKeyRef = useRef('');

  const setStatusBoth = (next: VoiceConnectionStatus): void => {
    statusRef.current = next;
    setStatus(next);
  };

  const stopVolumeLoop = (): void => {
    window.clearInterval(volumeTimerRef.current);
    volumeTimerRef.current = 0;
  };

  const refreshParticipantSets = useCallback((room: Room) => {
    const ids = new Set<string>();
    const micMuted = new Set<string>();
    for (const participant of room.remoteParticipants.values()) {
      ids.add(participant.identity);
      if (!participant.isMicrophoneEnabled) micMuted.add(participant.identity);
      if (!currentVolumesRef.current.has(participant.identity)) {
        currentVolumesRef.current.set(participant.identity, 1);
      }
    }
    // Only publish new Set identities when membership actually changed: this
    // runs inside the 8Hz volume loop and must not rerender the lobby.
    const idsKey = [...ids].sort().join(',');
    if (idsKey !== participantIdsKeyRef.current) {
      participantIdsKeyRef.current = idsKey;
      setVoiceParticipantIds(ids);
    }
    const micKey = [...micMuted].sort().join(',');
    if (micKey !== remoteMicMutedKeyRef.current) {
      remoteMicMutedKeyRef.current = micKey;
      setRemoteMicMutedIds(micMuted);
    }
  }, []);

  const leave = useCallback(
    (reason: VoiceLeaveReason = 'user') => {
      stopVolumeLoop();
      const room = roomRef.current;
      roomRef.current = null;
      if (room) {
        room.removeAllListeners();
        void room.disconnect().catch(() => undefined);
      }
      currentVolumesRef.current.clear();
      appliedVolumesRef.current.clear();
      nearbyCountRef.current = 0;
      remoteMicMutedKeyRef.current = '';
      participantIdsKeyRef.current = '';
      setVoiceParticipantIds(new Set());
      setSpeakingIds(new Set());
      setRemoteMicMutedIds(new Set());
      setNearbyVoiceCount(0);
      micMutedRef.current = false;
      setMicMuted(false);
      voiceEnabledRef.current = true;
      setVoiceEnabled(true);
      setLastLeaveReason(reason);
      setError(null);
      setStatusBoth('idle');
    },
    [],
  );

  const leaveRef = useRef(leave);
  leaveRef.current = leave;

  const startVolumeLoop = useCallback(() => {
    stopVolumeLoop();
    volumeTimerRef.current = window.setInterval(() => {
      const room = roomRef.current;
      if (!room) return;
      const snapshot = getPositionsRef.current();
      const local = snapshot.local;
      let nearby = 0;
      for (const participant of room.remoteParticipants.values()) {
        const pid = participant.identity;
        const pos = snapshot.remotes.get(pid);
        // A participant with no lobby position is treated as out of range.
        const distance = local && pos ? distanceBetween(local, pos) : Number.POSITIVE_INFINITY;
        if (distance <= VOICE_MAX_HEARING_DISTANCE) nearby += 1;
        const target = effectiveRemoteVolume({
          distanceVolume: volumeForDistance(distance),
          locallyMuted: locallyMutedRef.current.has(pid),
          voiceEnabled: voiceEnabledRef.current,
          // Persistent block: always silent for the blocker, even mid-call.
          blocked: blockedIdsRef.current.has(pid),
        });
        const track = micAudioTrackOf(participant);
        if (!track) continue;
        const current = currentVolumesRef.current.get(pid) ?? 1;
        const next = lerpVolume(current, target);
        currentVolumesRef.current.set(pid, next);
        const lastApplied = appliedVolumesRef.current.get(pid);
        if (lastApplied === undefined || Math.abs(next - lastApplied) >= VOICE_VOLUME_APPLY_THRESHOLD) {
          track.setVolume(next);
          appliedVolumesRef.current.set(pid, next);
        }
      }
      if (nearby !== nearbyCountRef.current) {
        nearbyCountRef.current = nearby;
        setNearbyVoiceCount(nearby);
      }
      refreshParticipantSets(room);
    }, VOICE_VOLUME_UPDATE_INTERVAL_MS);
  }, [refreshParticipantSets]);

  const attachRoomListeners = useCallback(
    (room: Room) => {
      room.on(RoomEvent.ParticipantConnected, () => refreshParticipantSets(room));
      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        currentVolumesRef.current.delete(participant.identity);
        appliedVolumesRef.current.delete(participant.identity);
        setSpeakingIds((prev) => {
          if (!prev.has(participant.identity)) return prev;
          const next = new Set(prev);
          next.delete(participant.identity);
          return next;
        });
        refreshParticipantSets(room);
      });
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        setSpeakingIds(new Set(speakers.map((speaker) => speaker.identity)));
      });
      room.on(RoomEvent.Disconnected, () => {
        // The room dropped under us; treat like a socket drop: stay out and
        // let the player rejoin deliberately.
        leaveRef.current('socket-disconnect');
      });
    },
    [refreshParticipantSets],
  );

  const join = useCallback(() => {
    // Guard against duplicate Room objects from repeated JOIN VOICE taps.
    if (statusRef.current === 'joining' || statusRef.current === 'connected') return;
    if (roomRef.current) return;
    const socket = socketRef.current;
    if (!socket || !socket.connected) {
      setError('Not connected yet. Please wait a moment and try again.');
      setStatusBoth('error');
      return;
    }
    setStatusBoth('joining');
    setError(null);
    setLastLeaveReason(null);

    requestVoiceToken(socket)
      .then(async ({ token, url }) => {
        const room = new Room({
          audioCaptureDefaults: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        roomRef.current = room;
        attachRoomListeners(room);
        try {
          await room.connect(url, token);
          // Explicit user gesture (the JOIN VOICE tap) unlocks autoplay; this
          // is a no-op where playback is already allowed.
          await room.startAudio();
          // Microphone is opt-in: permission is requested only here, never on page load.
          await room.localParticipant.setMicrophoneEnabled(true);
        } catch (error) {
          room.removeAllListeners();
          roomRef.current = null;
          void room.disconnect().catch(() => undefined);
          setStatusBoth('error');
          setError(microphoneErrorMessage(error));
          return;
        }
        refreshParticipantSets(room);
        startVolumeLoop();
        setStatusBoth('connected');
      })
      .catch((error: unknown) => {
        roomRef.current = null;
        setStatusBoth('error');
        setError(tokenErrorMessage(error));
      });
  }, [attachRoomListeners, refreshParticipantSets, startVolumeLoop]);

  const toggleMic = useCallback(() => {
    const room = roomRef.current;
    if (!room || statusRef.current !== 'connected') return;
    const nextMuted = !micMutedRef.current;
    // setMicrophoneEnabled(false) mutes the published track; true re-enables it.
    room
      .localParticipant.setMicrophoneEnabled(!nextMuted)
      .then(() => {
        micMutedRef.current = nextMuted;
        setMicMuted(nextMuted);
      })
      .catch(() => {
        setError('Could not change the microphone state.');
      });
  }, []);

  const toggleVoice = useCallback(() => {
    const next = !voiceEnabledRef.current;
    voiceEnabledRef.current = next;
    setVoiceEnabled(next);
  }, []);

  const toggleLocalMute = useCallback((targetPlayerId: string) => {
    const next = new Set(locallyMutedRef.current);
    if (next.has(targetPlayerId)) next.delete(targetPlayerId);
    else next.add(targetPlayerId);
    locallyMutedRef.current = next;
    setLocallyMutedIds(next);
  }, []);

  // Publish the imperative controller for App-level transitions.
  useEffect(() => {
    controllerRef.current = {
      leave: (reason) => leaveRef.current(reason),
      isConnected: () => roomRef.current !== null,
    };
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef, leave]);

  // Server capability check: hide voice UI when LiveKit is not configured.
  useEffect(() => {
    let cancelled = false;
    fetch(`${serverUrl}/api/voice/status`, { credentials: 'include' })
      .then((response) => response.json())
      .then((data: unknown) => {
        if (!cancelled) setVoiceAvailable((data as { enabled?: boolean })?.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setVoiceAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  // Socket.IO is authoritative for presence: a socket drop must not leave
  // voice connected under a stale district. Never auto-rejoin the mic.
  useEffect(() => {
    if (!socket) return;
    const handleSocketDisconnect = () => {
      if (roomRef.current) leaveRef.current('socket-disconnect');
    };
    socket.on('disconnect', handleSocketDisconnect);
    return () => {
      socket.off('disconnect', handleSocketDisconnect);
    };
  }, [socket]);

  // Belt and braces: if the district prop changes while somehow still
  // connected (App normally leaves first), drop the old district's room.
  useEffect(() => {
    if (districtRef.current !== district && roomRef.current) {
      leaveRef.current('district-change');
    }
    districtRef.current = district;
  }, [district]);

  // Full cleanup on unmount.
  useEffect(() => {
    return () => {
      stopVolumeLoop();
      const room = roomRef.current;
      roomRef.current = null;
      if (room) {
        room.removeAllListeners();
        void room.disconnect().catch(() => undefined);
      }
    };
  }, []);

  const value = useMemo<VoiceContextValue>(
    () => ({
      status,
      voiceAvailable,
      micMuted,
      voiceEnabled,
      error,
      lastLeaveReason,
      join,
      leave,
      toggleMic,
      toggleVoice,
      toggleLocalMute,
      voiceParticipantIds,
      speakingIds,
      remoteMicMutedIds,
      locallyMutedIds,
      nearbyVoiceCount,
    }),
    [
      status,
      voiceAvailable,
      micMuted,
      voiceEnabled,
      error,
      lastLeaveReason,
      join,
      leave,
      toggleMic,
      toggleVoice,
      toggleLocalMute,
      voiceParticipantIds,
      speakingIds,
      remoteMicMutedIds,
      locallyMutedIds,
      nearbyVoiceCount,
    ],
  );

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}
