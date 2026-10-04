import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AuthConfigPayload,
  AuthMePayload,
  AuthPlayerInfo,
  GoogleLoginResponse,
  KeralaDistrict,
} from '@kerala-battle/shared';
import { AuthContext } from './authContext';
import type { AuthContextValue, AuthStatus } from './authTypes';

interface AuthProviderProps {
  serverUrl: string;
  children: React.ReactNode;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function AuthProvider({ serverUrl, children }: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [player, setPlayer] = useState<AuthPlayerInfo | null>(null);
  const [profileComplete, setProfileComplete] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
  const stateRef = useRef({ status, player });
  stateRef.current = { status, player };

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const configRes = await fetch(`${serverUrl}/api/auth/config`, {
        credentials: 'include',
      });
      if (configRes.ok) {
        const config = (await configRes.json()) as AuthConfigPayload;
        setAuthRequired(config.authRequired);
        setGoogleConfigured(config.googleConfigured);
        setGoogleClientId(config.googleClientId);
      }
      const meRes = await fetch(`${serverUrl}/api/auth/me`, { credentials: 'include' });
      if (!meRes.ok) {
        setStatus('anonymous');
        setPlayer(null);
        return;
      }
      const me = (await meRes.json()) as AuthMePayload;
      if (me.authenticated && me.player) {
        setStatus('authenticated');
        setPlayer(me.player);
        setProfileComplete(me.profileComplete ?? true);
      } else {
        setStatus('anonymous');
        setPlayer(null);
      }
    } catch {
      // Server unreachable: stay anonymous; the socket layer shows its own
      // reconnecting state.
      setStatus('anonymous');
      setPlayer(null);
    }
  }, [serverUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(
    async (
      idToken: string,
      socketId?: string,
    ): Promise<{
      ok: boolean;
      error?: string;
      player?: AuthPlayerInfo;
      profileComplete?: boolean;
    }> => {
      try {
        const response = await fetch(`${serverUrl}/api/auth/google`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken, socketId }),
        });
        const body = await readJson(response);
        if (!response.ok) {
          const error = typeof body.error === 'string' ? body.error : 'Sign-in failed';
          return { ok: false, error };
        }
        const payload = body as unknown as GoogleLoginResponse;
        setStatus('authenticated');
        setPlayer(payload.player);
        setProfileComplete(payload.profileComplete);
        return { ok: true, player: payload.player, profileComplete: payload.profileComplete };
      } catch {
        return { ok: false, error: 'Could not reach the server' };
      }
    },
    [serverUrl],
  );

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await fetch(`${serverUrl}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Best effort; the session cookie is cleared below regardless.
    }
    setStatus('anonymous');
    setPlayer(null);
    setProfileComplete(true);
  }, [serverUrl]);

  const completeOnboarding = useCallback(
    async (
      displayName: string,
      district: KeralaDistrict,
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const response = await fetch(`${serverUrl}/api/auth/profile`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName, district }),
        });
        const body = await readJson(response);
        if (!response.ok) {
          const error = typeof body.error === 'string' ? body.error : 'Could not save profile';
          return { ok: false, error };
        }
        const next = body.player as AuthPlayerInfo | undefined;
        if (next) {
          setPlayer(next);
          setProfileComplete(next.displayName !== '' && next.district !== null);
        } else {
          await refresh();
        }
        return { ok: true };
      } catch {
        return { ok: false, error: 'Could not reach the server' };
      }
    },
    [serverUrl, refresh],
  );

  const rename = useCallback(
    async (displayName: string): Promise<{ ok: boolean; error?: string; retryAfterMs?: number }> => {
      try {
        const response = await fetch(`${serverUrl}/api/auth/profile`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName }),
        });
        const body = await readJson(response);
        if (!response.ok) {
          const error = typeof body.error === 'string' ? body.error : 'Could not rename';
          const retryAfterMs = typeof body.retryAfterMs === 'number' ? body.retryAfterMs : undefined;
          return { ok: false, error, retryAfterMs };
        }
        const next = body.player as AuthPlayerInfo | undefined;
        if (next) setPlayer(next);
        return { ok: true };
      } catch {
        return { ok: false, error: 'Could not reach the server' };
      }
    },
    [serverUrl],
  );

  const deleteAccount = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const response = await fetch(`${serverUrl}/api/auth/account`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const body = await readJson(response);
      if (!response.ok) {
        const error = typeof body.error === 'string' ? body.error : 'Could not delete account';
        return { ok: false, error };
      }
      setStatus('anonymous');
      setPlayer(null);
      setProfileComplete(true);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not reach the server' };
    }
  }, [serverUrl]);

  const value: AuthContextValue = {
    status,
    player,
    profileComplete,
    authRequired,
    googleConfigured,
    googleClientId,
    signIn,
    signOut,
    refresh,
    completeOnboarding,
    rename,
    deleteAccount,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
