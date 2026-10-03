interface IncomingChallengeModalProps {
  challengerName: string;
  onAccept: () => void;
  onDecline: () => void;
}

export function IncomingChallengeModal({
  challengerName,
  onAccept,
  onDecline,
}: IncomingChallengeModalProps) {
  return (
    <div className="card-overlay">
      <section className="challenge-modal" role="dialog" aria-label="Incoming challenge">
        <h3>{challengerName} challenged you!</h3>
        <p className="challenge-sub">Precision Clash · 3 rounds</p>
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
  onWithdraw: () => void;
}

export function OutgoingChallengeModal({ targetName, onWithdraw }: OutgoingChallengeModalProps) {
  return (
    <div className="card-overlay">
      <section className="challenge-modal" role="dialog" aria-label="Outgoing challenge">
        <h3>Challenging {targetName}…</h3>
        <p className="challenge-sub">Waiting for a response</p>
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
