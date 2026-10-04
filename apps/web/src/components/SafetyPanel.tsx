import { useSafety } from '../safety/safetyContext';

/**
 * Safety panel (Task 10): the player's persistent block list with Unblock,
 * plus a short note about reporting. Reports themselves are not listed (no
 * social activity feed); they go to the game operator.
 */

interface SafetyPanelProps {
  onClose: () => void;
}

export default function SafetyPanel({ onClose }: SafetyPanelProps) {
  const safety = useSafety();

  return (
    <>
      <h3>Safety</h3>
      <p className="muted-note">Reports are reviewed by the game operator.</p>
      <h4 className="safety-subtitle">Blocked players ({safety.blockedList.length})</h4>
      {safety.loading && <p className="muted-note">Loading…</p>}
      {!safety.loading && safety.blockedList.length === 0 && (
        <p className="muted-note">No blocked players.</p>
      )}
      <ul className="block-list">
        {safety.blockedList.map((entry) => (
          <li key={entry.playerId} className="block-list-item">
            <span>{entry.displayName || 'Player'}</span>
            <button
              type="button"
              className="secondary-btn small-btn"
              onClick={() => void safety.unblockPlayer(entry.playerId)}
            >
              Unblock
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="secondary-btn" onClick={onClose}>
        Back
      </button>
    </>
  );
}
