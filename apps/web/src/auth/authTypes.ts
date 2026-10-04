import type { AuthPlayerInfo, KeralaDistrict } from '@kerala-battle/shared';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthContextValue {
  status: AuthStatus;
  player: AuthPlayerInfo | null;
  /** False when a new Google user still needs name + district. */
  profileComplete: boolean;
  authRequired: boolean;
  googleConfigured: boolean;
  /** The public Google OAuth client id for the GIS button (null when unset). */
  googleClientId: string | null;
  /** Sign in with a Google ID token; socketId binds the guest-profile claim. */
  signIn: (
    idToken: string,
    socketId?: string,
  ) => Promise<{
    ok: boolean;
    error?: string;
    player?: AuthPlayerInfo;
    profileComplete?: boolean;
  }>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Finish onboarding for a new Google user (initial setup, no cooldown). */
  completeOnboarding: (
    displayName: string,
    district: KeralaDistrict,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Rename an existing profile (7-day cooldown enforced server-side). */
  rename: (displayName: string) => Promise<{ ok: boolean; error?: string; retryAfterMs?: number }>;
  /** Permanently delete/anonymize the account. */
  deleteAccount: () => Promise<{ ok: boolean; error?: string }>;
}
