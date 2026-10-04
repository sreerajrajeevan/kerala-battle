import { useEffect, useRef, useState } from 'react';

/**
 * Google Identity Services "Sign in with Google" button (Task 10).
 *
 * Loads the GIS script on demand and renders the official button. The
 * credential (ID token JWT) is handed to the caller, which POSTs it to the
 * server for verification; the token is never stored.
 */

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential?: string }) => void;
          }) => void;
          renderButton: (
            element: HTMLElement,
            options: { theme?: string; size?: string; width?: number },
          ) => void;
        };
      };
    };
  }
}

let scriptPromise: Promise<void> | null = null;

function loadGisScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('failed to load Google sign-in'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

interface GoogleSignInButtonProps {
  clientId: string;
  onCredential: (idToken: string) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}

export default function GoogleSignInButton({
  clientId,
  onCredential,
  onError,
  disabled,
}: GoogleSignInButtonProps) {
  const buttonRef = useRef<HTMLDivElement>(null);
  const [scriptFailed, setScriptFailed] = useState(false);
  const callbackRef = useRef(onCredential);
  callbackRef.current = onCredential;
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    loadGisScript()
      .then(() => {
        if (cancelled || !buttonRef.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (response.credential) callbackRef.current(response.credential);
            else errorRef.current('Google sign-in returned no credential');
          },
        });
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: 'outline',
          size: 'large',
          width: 280,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setScriptFailed(true);
          errorRef.current('Could not load Google sign-in');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  if (scriptFailed) {
    return <p className="auth-error">Could not load Google sign-in. Check your connection.</p>;
  }
  return (
    <div
      ref={buttonRef}
      className="google-signin-button"
      aria-hidden={disabled ? true : undefined}
      style={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
    />
  );
}
