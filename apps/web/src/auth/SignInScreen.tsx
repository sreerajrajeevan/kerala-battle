import { useState } from 'react';
import GoogleSignInButton from './GoogleSignInButton';

/**
 * Unauthenticated landing (Task 10). Deliberately simple: no marketing page,
 * just the game promise and the Google button.
 */

interface SignInScreenProps {
  googleConfigured: boolean;
  googleClientId: string | null;
  authRequired: boolean;
  onSignIn: (idToken: string) => Promise<{ ok: boolean; error?: string }>;
}

export default function SignInScreen({
  googleConfigured,
  googleClientId,
  authRequired,
  onSignIn,
}: SignInScreenProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCredential = async (idToken: string): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await onSignIn(idToken);
    setBusy(false);
    if (!result.ok) setError(result.error ?? 'Sign-in failed');
  };

  return (
    <main className="page signin-page">
      <section className="signin-card">
        <h1>Kerala Battle</h1>
        <p className="signin-tagline">Compete for your district.</p>
        <p className="signin-tagline">Meet players.</p>
        <p className="signin-tagline">Become Weekly Master.</p>
        <div className="signin-action">
          {!googleConfigured ? (
            <p className="auth-error">
              Google sign-in is not configured.
              {authRequired
                ? ' The server requires sign-in to play.'
                : ' Ask the operator to set GOOGLE_CLIENT_ID.'}
            </p>
          ) : !googleClientId ? (
            <p className="auth-error">
              The server reports Google sign-in as configured, but did not provide a client id.
            </p>
          ) : (
            <GoogleSignInButton
              clientId={googleClientId}
              onCredential={(token) => void handleCredential(token)}
              onError={setError}
              disabled={busy}
            />
          )}
        </div>
        {busy && <p className="signin-status">Signing you in…</p>}
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        <p className="signin-note">
          Signing in links your game profile to your Google account. Your email is never shown to
          other players.
        </p>
      </section>
    </main>
  );
}
