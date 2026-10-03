import { GAME_DEFINITIONS, type GameType, type MatchMode } from '@kerala-battle/shared';

interface IncomingChallengeModalProps {
  challengerName: string;
  gameType: GameType;
  matchMode: MatchMode;
  onAccept: () => void;
  onDecline: () => void;
}

export function IncomingChallengeModal({
  challengerName,
  gameType,
  matchMode,
  onAccept,
  onDecline,
}: IncomingChallengeModalProps) {
  return (
    <div className="card-overlay">
      <section className="challenge-modal" role="dialog" aria-label="Incoming challenge">
        <h3>{challengerName} challenged you!</h3>
        <p className="challenge-game">{GAME_DEFINITIONS[gameType].label.toUpperCase()}</p>
        <p className="challenge-mode">
          {matchMode === 'ranked' ? 'RANKED MATCH' : 'CASUAL MATCH'}
        </p>
        <p className="challenge-sub">{GAME_DEFINITIONS[gameType].tagline}</p>
        <div className="challenge-actions">
          <button type="button" className="primary-btn" onClick={onAccept}>
            Accept
          </button>
          <button type="button" className="secondary-btn" onClick={onDecline}>
            Decline
          </button>
        </div>
      </section>
    </div>
  );
}

interface OutgoingChallengeModalProps {
  targetName: string;
  gameType: GameType;
  onWithdraw: () => void;
}

export function OutgoingChallengeModal({
  targetName,
  gameType,
  onWithdraw,
}: OutgoingChallengeModalProps) {
  return (
    <div className="card-overlay">
      <section className="challenge-modal" role="dialog" aria-label="Outgoing challenge">
        <h3>Challenging {targetName}…</h3>
        <p className="challenge-sub">
          {GAME_DEFINITIONS[gameType].label} · Waiting for a response
        </p>
        <button type="button" className="secondary-btn" onClick={onWithdraw}>
          Cancel
        </button>
      </section>
    </div>
  );
}

export function Toast({ message }: { message: string }) {
  return (
    <div className="toast" role="status">
      {message}
    </div>
  );
}
