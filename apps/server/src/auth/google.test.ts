/**
 * Unit tests for Google ID-token verification wiring.
 * The production verifier delegates signature/issuer/audience/expiry checks
 * to google-auth-library; here we prove the wiring (audience plumbing,
 * claim mapping, error mapping) with a stubbed OAuth2Client, plus the fake
 * verifier contract used by every other test.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeIdTokenVerifier,
  GoogleIdTokenVerifier,
  GoogleTokenError,
} from './google.js';
import { loadAuthConfig } from './config.js';

test('fake verifier returns registered claims and rejects unknown tokens', async () => {
  const fake = new FakeIdTokenVerifier();
  fake.allow('good-token', { sub: 'sub-1', email: 'a@b.c', emailVerified: true });
  const claims = await fake.verify('good-token');
  assert.equal(claims.sub, 'sub-1');
  assert.equal(claims.emailVerified, true);
  await assert.rejects(() => fake.verify('unknown-token'), GoogleTokenError);
});

test('production verifier passes the configured audience and maps claims', async () => {
  let seenAudience: unknown;
  const stubClient = {
    verifyIdToken: async (options: { idToken: string; audience: string }) => {
      seenAudience = options.audience;
      return {
        getPayload: () => ({
          sub: 'google-sub-9',
          email: 'sree@example.com',
          email_verified: true,
          aud: options.audience,
          iss: 'https://accounts.google.com',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      };
    },
  };
  const verifier = new GoogleIdTokenVerifier('test-client-id.apps.googleusercontent.com', stubClient as never);
  const claims = await verifier.verify('any-token');
  assert.equal(seenAudience, 'test-client-id.apps.googleusercontent.com');
  assert.equal(claims.sub, 'google-sub-9');
  assert.equal(claims.email, 'sree@example.com');
  assert.equal(claims.emailVerified, true);
});

test('production verifier maps library failures to GoogleTokenError', async () => {
  const failingClient = {
    verifyIdToken: async () => {
      throw new Error('Token used too late');
    },
  };
  const verifier = new GoogleIdTokenVerifier('aud', failingClient as never);
  await assert.rejects(() => verifier.verify('expired-token'), GoogleTokenError);
});

test('production verifier rejects malformed input without network', async () => {
  let called = false;
  const stubClient = {
    verifyIdToken: async () => {
      called = true;
      throw new Error('should not be called');
    },
  };
  const verifier = new GoogleIdTokenVerifier('aud', stubClient as never);
  await assert.rejects(() => verifier.verify(''), GoogleTokenError);
  await assert.rejects(() => verifier.verify('x'.repeat(9000)), GoogleTokenError);
  assert.equal(called, false);
});

test('production verifier rejects tokens with no subject', async () => {
  const stubClient = {
    verifyIdToken: async () => ({ getPayload: () => ({ email: 'a@b.c' }) }),
  };
  const verifier = new GoogleIdTokenVerifier('aud', stubClient as never);
  await assert.rejects(() => verifier.verify('no-sub'), GoogleTokenError);
});

test('auth config loads from the environment', () => {
  const config = loadAuthConfig({
    GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
    SESSION_COOKIE_SECRET: 's3cret',
    AUTH_REQUIRED: 'true',
    NODE_ENV: 'production',
  } as NodeJS.ProcessEnv);
  assert.equal(config.googleClientId, 'cid.apps.googleusercontent.com');
  assert.equal(config.sessionCookieSecret, 's3cret');
  assert.equal(config.authRequired, true);
  assert.equal(config.isProduction, true);

  const dev = loadAuthConfig({} as NodeJS.ProcessEnv);
  assert.equal(dev.googleClientId, null);
  assert.equal(dev.authRequired, false);
  assert.ok(dev.sessionCookieSecret.length > 0, 'dev pepper fallback');
});
