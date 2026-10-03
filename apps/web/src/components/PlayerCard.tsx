import type { KeralaDistrict, LobbyPlayer } from '@kerala-battle/shared';

interface PlayerCardProps {
  player: LobbyPlayer;
  district: KeralaDistrict;
  onChallenge: () => void;
  onClose: () => void;
}

export default function PlayerCard({ player, district, onChallenge, onClose }: PlayerCardProps) {
  return (
    <div className="card-overlay" onClick={onClose}>
      <section className="player-card" onClick={(event) => event.stopPropagation()}>
        <h3>{player.displayName}</h3>
        <p className="player-card-district">{district}</p>
        {player.inMatch ? (
          <p className="player-card-busy">{player.displayName} is currently in a match</p>
        ) : (
          <button type="button" className="primary-btn" onClick={onChallenge}>
            Challenge
          </button>
        )}
        <button type="button" className="secondary-btn" onClick={onClose}>
          Close
        </button>
      </section>
    </div>
  );
}
