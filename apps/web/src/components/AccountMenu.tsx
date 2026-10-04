import { useState } from 'react';
import { useAuth } from '../auth/authContext';
import { isValidDisplayName } from '../lib/profile';
import SafetyPanel from './SafetyPanel';

/**
 * Small account menu in the lobby footer (Task 10).
 *
 * Shows the signed-in name + district, with Edit Profile (rename, 7-day
 * cooldown), Safety (blocked list), Sign Out, and Delete Account. Guest mode
 * hides the menu entirely.
 */

interface AccountMenuProps {
  /** Tear down the local session after sign-out / deletion. */
  onSignOut: () => void;
}

export default function AccountMenu({ onSignOut }: AccountMenuProps) {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (auth.status !== 'authenticated' || !auth.player) return null;
  const player = auth.player;

  const startEdit = (): void => {
    setName(player.displayName);
    setError(null);
    setEditing(true);
  };

  const submitRename = async (): Promise<void> => {
    if (!isValidDisplayName(name)) {
      setError('Name must be 2–20 letters, numbers or spaces.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await auth.rename(name.trim());
    setBusy(false);
    if (!result.ok) {
      if (result.retryAfterMs) {
        const days = Math.ceil(result.retryAfterMs / 86_400_000);
        setError(`You can change your name again in about ${days} day${days === 1 ? '' : 's'}.`);
      } else {
        setError(result.error ?? 'Could not change name.');
      }
      return;
    }
    setEditing(false);
    setOpen(false);
  };

  const handleSignOut = async (): Promise<void> => {
    setBusy(true);
    await auth.signOut();
    setBusy(false);
    setOpen(false);
    onSignOut();
  };

  const handleDelete = async (): Promise<void> => {
    setBusy(true);
    const result = await auth.deleteAccount();
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'Could not delete account.');
      return;
    }
    setConfirmingDelete(false);
    setOpen(false);
    onSignOut();
  };

  return (
    <div className="account-menu-wrap">
      <button type="button" className="secondary-btn" onClick={() => setOpen((v) => !v)}>
        👤 {player.displayName}
      </button>
      {open && (
        <div className="card-overlay" onClick={() => setOpen(false)}>
          <section className="player-card account-menu" onClick={(e) => e.stopPropagation()}>
            <h3>{player.displayName}</h3>
            <p className="player-card-district">{player.district ?? 'No district yet'}</p>
            {!editing && !safetyOpen && !confirmingDelete && (
              <>
                <button type="button" className="secondary-btn" onClick={startEdit}>
                  Edit Profile
                </button>
                <button type="button" className="secondary-btn" onClick={() => setSafetyOpen(true)}>
                  Safety
                </button>
                <button type="button" className="secondary-btn" onClick={() => void handleSignOut()} disabled={busy}>
                  Sign Out
                </button>
                <button
                  type="button"
                  className="secondary-btn danger-btn"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete Account
                </button>
              </>
            )}
            {editing && (
              <>
                <label className="field-label">
                  Display name
                  <input
                    className="text-input"
                    value={name}
                    maxLength={20}
                    onChange={(e) => setName(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <p className="muted-note">One name change per 7 days.</p>
                {error && (
                  <p className="auth-error" role="alert">
                    {error}
                  </p>
                )}
                <button type="button" className="primary-btn" onClick={() => void submitRename()} disabled={busy}>
                  Save
                </button>
                <button type="button" className="secondary-btn" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </>
            )}
            {safetyOpen && (
              <SafetyPanel onClose={() => setSafetyOpen(false)} />
            )}
            {confirmingDelete && (
              <>
                <p className="danger-text">
                  Delete your account? Your Google link is removed, your profile becomes
                  “Deleted Player”, and your sessions end. Match history and Hall of Fame
                  records stay as they are.
                </p>
                {error && (
                  <p className="auth-error" role="alert">
                    {error}
                  </p>
                )}
                <button
                  type="button"
                  className="primary-btn danger-btn"
                  onClick={() => void handleDelete()}
                  disabled={busy}
                >
                  Yes, delete my account
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </button>
              </>
            )}
            {!editing && !safetyOpen && !confirmingDelete && (
              <button type="button" className="secondary-btn" onClick={() => setOpen(false)}>
                Close
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
