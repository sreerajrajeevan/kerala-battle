import {
  GAME_DEFINITIONS,
  GAME_TYPE_CROWN_RUSH,
  GAME_TYPE_PRECISION_CLASH,
  type GameType,
  type KeralaDistrict,
  type LobbyPlayer,
} from '@kerala-battle/shared';
import { useVoice } from '../voice/voiceContext';

interface PlayerCardProps {
  player: LobbyPlayer;
  district: KeralaDistrict;
  onChallenge: (gameType: GameType) => void;
  onClose: () => void;
}

export default function PlayerCard({ player, district, onChallenge, onClose }: PlayerCardProps) {
  const voice = useVoice();
  // "Both are voice-connected": local player is in district voice AND the
  // target is a participant in the same district voice room.
  const bothInVoice =
    voice.status === 'connected' && voice.voiceParticipantIds.has(player.playerId);
  const locallyMuted = voice.locallyMutedIds.has(player.playerId);

  return (
    <div className="card-overlay" onClick={onClose}>
      <section className="player-card" onClick={(event) => event.stopPropagation()}>
        <h3>Challenge {player.displayName}</h3>
        <p className="player-card-district">{district}</p>
        {bothInVoice && <p className="player-card-voice">🎙 Voice nearby</p>}
        {player.inMatch ? (
          <p className="player-card-busy">{player.displayName} is currently in a match</p>
        ) : (
          <div className="player-card-games">
            <button
              type="button"
              className="primary-btn"
              onClick={() => onChallenge(GAME_TYPE_PRECISION_CLASH)}
            >
              {GAME_DEFINITIONS[GAME_TYPE_PRECISION_CLASH].label} — Casual
            </button>
            <button
              type="button"
              className="primary-btn"
              onClick={() => onChallenge(GAME_TYPE_CROWN_RUSH)}
            >
              {GAME_DEFINITIONS[GAME_TYPE_CROWN_RUSH].label} — Casual
            </button>
          </div>
        )}
        {bothInVoice && (
          <button
            type="button"
            className="secondary-btn"
            onClick={() => voice.toggleLocalMute(player.playerId)}
          >
            {locallyMuted ? `Unmute ${player.displayName}` : `Mute ${player.displayName}`}
          </button>
        )}
        <button type="button" className="secondary-btn" onClick={onClose}>
          Close
        </button>
      </section>
    </div>
  );
}
