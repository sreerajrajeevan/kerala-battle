/**
 * Google ID-token verification (Task 10).
 *
 * The browser obtains an ID token from Google Identity Services; the server
 * NEVER trusts email/name sent separately. Verification checks the token
 * signature, issuer, audience, and expiry through Google's official library.
 *
 * Production uses {@link GoogleIdTokenVerifier}; tests inject
 * {@link FakeIdTokenVerifier} returning controlled claims. There is no
 * insecure production bypass.
 */

import { OAuth2Client, type TokenPayload } from 'google-auth-library';

/** The claims Kerala Battle trusts from a verified Google ID token. */
export interface GoogleIdClaims {
  /** Google's stable subject: the permanent external identity. */
  sub: string;
  email: string;
  emailVerified: boolean;
}

/** Thrown when an ID token cannot be trusted. */
export class GoogleTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleTokenError';
  }
}

/** Verifies a Google ID token and returns the trusted claims. */
export interface IdTokenVerifier {
  verify(idToken: string): Promise<GoogleIdClaims>;
}

function claimsFromPayload(payload: TokenPayload | undefined): GoogleIdClaims {
  const sub = payload?.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new GoogleTokenError('verified token has no subject');
  }
  const email = payload?.email;
  return {
    sub,
    email: typeof email === 'string' ? email : '',
    emailVerified: payload?.email_verified === true,
  };
}

/**
 * Production verifier. google-auth-library checks the JWT signature against
 * Google's public certs, the issuer (accounts.google.com /
 * https://accounts.google.com), the audience (our client id), and expiry.
 */
export class GoogleIdTokenVerifier implements IdTokenVerifier {
  private readonly client: OAuth2Client;
  private readonly audience: string;

  constructor(audience: string, client?: OAuth2Client) {
    this.audience = audience;
    this.client = client ?? new OAuth2Client();
  }

  async verify(idToken: string): Promise<GoogleIdClaims> {
    if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > 8192) {
      throw new GoogleTokenError('malformed id token');
    }
    let ticket;
    try {
      // The library verifies signature, issuer, audience and expiry.
      ticket = await this.client.verifyIdToken({ idToken, audience: this.audience });
    } catch (error) {
      throw new GoogleTokenError(
        `id token verification failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    return claimsFromPayload(ticket.getPayload());
  }
}

/**
 * Test-only verifier: returns pre-registered claims per token string, or
 * throws GoogleTokenError for unknown tokens. Never used in production.
 */
export class FakeIdTokenVerifier implements IdTokenVerifier {
  private readonly grants = new Map<string, GoogleIdClaims>();

  /** Register a token string that verifies to the given claims. */
  allow(token: string, claims: GoogleIdClaims): void {
    this.grants.set(token, claims);
  }

  async verify(idToken: string): Promise<GoogleIdClaims> {
    const claims = this.grants.get(idToken);
    if (!claims) throw new GoogleTokenError('fake verifier: unknown token');
    return { ...claims };
  }
}
