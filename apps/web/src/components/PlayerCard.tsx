import { useState } from 'react';
import {
  GAME_DEFINITIONS,
  GAME_TYPE_CROWN_RUSH,
  GAME_TYPE_PRECISION_CLASH,
  type GameType,
  type KeralaDistrict,
  type LobbyPlayer,
} from '@kerala-battle/shared';
import { useVoice } from '../voice/voiceContext';
import { useAuth } from '../auth/authContext';
import { useSafety } from '../safety/safetyContext';
import ReportDialog from './ReportDialog';

interface PlayerCardProps {
  player: LobbyPlayer;
  district: KeralaDistrict;
  onChallenge: (gameType: GameType) => void;
  onClose: () => void;
}

export default function PlayerCard({ player, district, onChallenge, onClose }: PlayerCardProps) {
  const voice = useVoice();
  const auth = useAuth();
  const safety = useSafety();
  const [reporting, setReporting] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);

  const signedIn = auth.status === 'authenticated';
  const isBlocked = safety.blockedIds.has(player.playerId);
  // "Both are voice-connected": local player is in district voice AND the
  // target is a participant in the same district voice room.
  const bothInVoice =
    voice.status === 'connected' && voice.voiceParticipantIds.has(player.playerId);
  const locallyMuted = voice.locallyMutedIds.has(player.playerId);

  const toggleBlock = async (): Promise<void> => {
    setBlockBusy(true);
    setBlockError(null);
    if (isBlocked) {
      await safety.unblockPlayer(player.playerId);
    } else {
      const result = await safety.blockPlayer(player.playerId);
      if (!result.ok) setBlockError(result.error ?? 'Could not block player.');
    }
    setBlockBusy(false);
  };

  return (
    <div className="card-overlay" onClick={onClose}>
      <section className="player-card" onClick={(event) => event.stopPropagation()}>
        <h3>Challenge {player.displayName}</h3>
        <p className="player-card-district">{district}</p>
        {isBlocked && <p className="player-card-blocked">Blocked</p>}
        {bothInVoice && <p className="player-card-voice">🎙 Voice nearby</p>}
        {player.inMatch ? (
          <p className="player-card-busy">{player.displayName} is currently in a match</p>
        ) : (
          !isBlocked && (
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
          )
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
        {signedIn && (
          <>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => void toggleBlock()}
              disabled={blockBusy}
            >
              {isBlocked ? `Unblock ${player.displayName}` : `Block ${player.displayName}`}
            </button>
            <button type="button" className="secondary-btn" onClick={() => setReporting(true)}>
              Report {player.displayName}
            </button>
          </>
        )}
        {blockError && (
          <p className="auth-error" role="alert">
            {blockError}
          </p>
        )}
        <button type="button" className="secondary-btn" onClick={onClose}>
          Close
        </button>
      </section>
      {reporting && (
        <ReportDialog
          reportedName={player.displayName}
          reportedPlayerId={player.playerId}
          contextType="district-lobby"
          onClose={() => setReporting(false)}
        />
      )}
    </div>
  );
}
