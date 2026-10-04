/**
 * Task 10 authentication configuration, read from the environment.
 *
 * - GOOGLE_CLIENT_ID: Google OAuth client id (audience for ID-token
 *   verification, and the web client's GIS button). When missing, Google
 *   sign-in is disabled and /api/auth/google answers 503 with a clear
 *   "Google sign-in is not configured" message.
 * - SESSION_COOKIE_SECRET: pepper mixed into the session-token hash. Never
 *   committed; missing value falls back to a dev-only constant with a loud
 *   warning (sessions stay functional, but the pepper is not secret).
 * - AUTH_REQUIRED: "true" gates all game registration behind a valid
 *   session. Development/tests use "false" (or unset) and keep the guest
 *   flow. Production MUST set it to "true".
 */

export interface AuthConfig {
  googleClientId: string | null;
  sessionCookieSecret: string;
  /** True only when AUTH_REQUIRED is exactly "true". */
  authRequired: boolean;
  /** True in production builds (NODE_ENV=production). */
  isProduction: boolean;
}

const DEV_PEPPER = 'kerala-battle-dev-pepper-NOT-FOR-PRODUCTION';

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim() || null;
  const sessionCookieSecret = env.SESSION_COOKIE_SECRET?.trim() || '';
  const authRequired = env.AUTH_REQUIRED === 'true';
  const isProduction = env.NODE_ENV === 'production';
  if (!sessionCookieSecret && !isProduction) {
    console.warn(
      '[auth] SESSION_COOKIE_SECRET not set: using an insecure dev pepper. ' +
        'Set a real secret before any production use.',
    );
  }
  return {
    googleClientId,
    sessionCookieSecret: sessionCookieSecret || DEV_PEPPER,
    authRequired,
    isProduction,
  };
}

/** Warn loudly when a production build would run with auth disabled. */
export function warnIfAuthDisabledInProduction(config: AuthConfig): void {
  if (config.isProduction && !config.authRequired) {
    console.error(
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' +
        '[auth] PRODUCTION BUILD WITH AUTH_REQUIRED != "true": guests can play\n' +
        'without Google sign-in. Set AUTH_REQUIRED=true unless this is\n' +
        'intentional.\n' +
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
    );
  }
}
