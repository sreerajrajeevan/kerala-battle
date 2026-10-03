import type { KeralaDistrict } from '@kerala-battle/shared';
import { useVoice } from './voiceContext';

interface VoiceControlsProps {
  district: KeralaDistrict;
}

function joinLabel(district: KeralaDistrict, rejoin: boolean): string {
  return rejoin ? 'REJOIN VOICE' : `JOIN ${district.toUpperCase()} VOICE`;
}

/**
 * Compact voice controls for the district lobby. The microphone is strictly
 * opt-in: nothing here requests permission or connects until JOIN VOICE is
 * tapped. Positioned away from the movement joystick.
 */
export default function VoiceControls({ district }: VoiceControlsProps) {
  const voice = useVoice();

  if (voice.voiceAvailable === false) {
    return <p className="voice-note">Voice temporarily unavailable</p>;
  }
  if (voice.voiceAvailable === null) {
    return null;
  }

  if (voice.status === 'joining') {
    return (
      <div className="voice-panel" aria-live="polite">
        <p className="voice-note">Joining voice…</p>
      </div>
    );
  }

  if (voice.status === 'error') {
    return (
      <div className="voice-panel" role="alert">
        <p className="voice-error">{voice.error ?? 'Voice unavailable.'}</p>
        <button type="button" className="secondary-btn" onClick={voice.join}>
          Try again
        </button>
      </div>
    );
  }

  if (voice.status === 'connected') {
    return (
      <div className="voice-panel" aria-live="polite">
        <div className="voice-controls-row">
          <button
            type="button"
            className={voice.micMuted ? 'secondary-btn' : 'primary-btn'}
            onClick={voice.toggleMic}
            aria-pressed={!voice.micMuted}
          >
            {voice.micMuted ? '🔇 Mic Muted' : '🎙️ Mic On'}
          </button>
          <button
            type="button"
            className={voice.voiceEnabled ? 'secondary-btn' : 'primary-btn'}
            onClick={voice.toggleVoice}
            aria-pressed={voice.voiceEnabled}
          >
            {voice.voiceEnabled ? '🔊 Voice On' : '🔈 Voice Off'}
          </button>
          <button type="button" className="secondary-btn" onClick={() => voice.leave('user')}>
            Leave Voice
          </button>
        </div>
        <p className="voice-nearby">
          VOICE NEARBY — {voice.nearbyVoiceCount}{' '}
          {voice.nearbyVoiceCount === 1 ? 'person' : 'people'} within hearing range
        </p>
        <p className="voice-note">Voice is live and not recorded.</p>
      </div>
    );
  }

  // Idle: opt-in entry point, with a contextual rejoin hint.
  const reason = voice.lastLeaveReason;
  const rejoin = reason === 'match' || reason === 'socket-disconnect';
  return (
    <div className="voice-panel">
      {reason === 'district-change' && (
        <p className="voice-note">Voice disconnected because you changed district.</p>
      )}
      {reason === 'match' && <p className="voice-note">Voice left for your match.</p>}
      {reason === 'socket-disconnect' && <p className="voice-note">Voice disconnected.</p>}
      <button type="button" className="primary-btn" onClick={voice.join}>
        {joinLabel(district, rejoin)}
      </button>
      <p className="voice-note">Voice is live and not recorded.</p>
    </div>
  );
}
