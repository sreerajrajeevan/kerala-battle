/**
 * HTTP integration tests for the auth + safety routes (Task 10).
 * Boots the real Express routers on an ephemeral port with a fake Google
 * verifier; no network, no real credentials. Covers: config, login,
 * guest-profile claim (+ double-claim rejection), session cookie auth,
 * logout, rename cooldown, CSRF origin rejection, unconfigured Google,
 * account deletion, blocks, and reports.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { AddressInfo } from 'node:net';
import { runMigrations } from '../competition/db.js';
import { loadAuthConfig, type AuthConfig } from './config.js';
import { FakeIdTokenVerifier } from './google.js';
import { buildAuthRouter, type AuthRouteDeps } from './routes.js';
import { buildSafetyRouter } from '../moderation/routes.js';
import { RateLimiter } from '../rate-limit/limiter.js';
import { SESSION_COOKIE_NAME, type SessionDeps } from './sessions.js';
import { getUserBySubject } from './users.js';

const PEPPER = 'integration-test-pepper';

interface TestServer {
  db: DatabaseSync;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestServer(options?: {
  googleConfigured?: boolean;
  guests?: Map<string, { playerId: string; displayName: string; district: 'Kannur' }>;
}): Promise<TestServer> {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const config: AuthConfig = loadAuthConfig({} as NodeJS.ProcessEnv);
  config.googleClientId = options?.googleConfigured === false ? null : 'test-client-id';
  const verifier = new FakeIdTokenVerifier();
  verifier.allow('token-sree', { sub: 'google-sree', email: 'sree@example.com', emailVerified: true });
  verifier.allow('token-rahul', { sub: 'google-rahul', email: 'rahul@example.com', emailVerified: true });
  const sessionDeps: SessionDeps = { pepper: PEPPER, secureCookies: false };
  const guests = options?.guests ?? new Map();
  const deps: AuthRouteDeps = {
    db,
    config,
    verifier,
    limiter: new RateLimiter(),
    sessionDeps,
    allowedOrigins: ['http://localhost:5173'],
    getGuestForSocket: (socketId: string) => guests.get(socketId) ?? null,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/auth', buildAuthRouter(deps));
  app.use(
    '/api',
    buildSafetyRouter({ db, limiter: new RateLimiter(), pepper: PEPPER, allowedOrigins: ['http://localhost:5173'] }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/** Minimal cookie jar for the session cookie. */
class Jar {
  private cookies = new Map<string, string>();
  get header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  store(setCookie: string | null): void {
    if (!setCookie) return;
    const pair = setCookie.split(';')[0];
    const index = pair.indexOf('=');
    if (index < 0) return;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name === SESSION_COOKIE_NAME) {
      if (value === '' || /Max-Age=0/.test(setCookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

async function api(
  srv: TestServer,
  jar: Jar,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown>; setCookie: string | null }> {
  const response = await fetch(`${srv.baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(jar.header ? { Cookie: jar.header } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  jar.store(setCookie);
  let json: Record<string, unknown> = {};
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON responses (not expected here).
  }
  return { status: response.status, json, setCookie };
}

test('config reports Google + auth-required flags', async () => {
  const srv = await startTestServer();
  try {
    const jar = new Jar();
    const { status, json } = await api(srv, jar, 'GET', '/api/auth/config');
    assert.equal(status, 200);
    assert.equal(json.googleConfigured, true);
    assert.equal(json.googleClientId, 'test-client-id');
    assert.equal(json.authRequired, false);
  } finally {
    await srv.close();
  }
});

test('unknown Google token is rejected; missing Google config gives 503', async () => {
  const srv = await startTestServer();
  try {
    const jar = new Jar();
    const bad = await api(srv, jar, 'POST', '/api/auth/google', { idToken: 'nope' });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error, 'invalid Google credential');
  } finally {
    await srv.close();
  }
  const unconfigured = await startTestServer({ googleConfigured: false });
  try {
    const jar = new Jar();
    const res = await api(unconfigured, jar, 'POST', '/api/auth/google', { idToken: 'token-sree' });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'Google sign-in is not configured');
    const config = await api(unconfigured, jar, 'GET', '/api/auth/config');
    assert.equal(config.json.googleConfigured, false);
  } finally {
    await unconfigured.close();
  }
});

test('login creates an account, sets a session cookie, and /me works', async () => {
  const srv = await startTestServer();
  try {
    const jar = new Jar();
    const login = await api(srv, jar, 'POST', '/api/auth/google', { idToken: 'token-sree' });
    assert.equal(login.status, 200);
    assert.equal(login.json.authenticated, true);
    assert.equal(login.json.isNewAccount, true);
    const player = login.json.player as { playerId: string };
    assert.ok(player.playerId.length > 0);
    assert.ok(login.setCookie?.includes(`${SESSION_COOKIE_NAME}=`));
    assert.ok(login.setCookie?.includes('HttpOnly'));

    // /me without a cookie is anonymous...
    const anon = await api(srv, new Jar(), 'GET', '/api/auth/me');
    assert.equal(anon.json.authenticated, false);
    // ...and with the cookie is authenticated.
    const me = await api(srv, jar, 'GET', '/api/auth/me');
    assert.equal(me.json.authenticated, true);
    assert.equal((me.json.player as { playerId: string }).playerId, player.playerId);
    // No internals leak.
    assert.equal((me.json.player as Record<string, unknown>).googleSubject, undefined);

    // Second login with the same Google subject returns the SAME account.
    const jar2 = new Jar();
    const again = await api(srv, jar2, 'POST', '/api/auth/google', { idToken: 'token-sree' });
    assert.equal(again.json.isNewAccount, false);
    assert.equal((again.json.player as { playerId: string }).playerId, player.playerId);
    const count = srv.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    assert.equal(count.n, 1);
  } finally {
    await srv.close();
  }
});

test('guest claim links the Google account to the socket guest playerId', async () => {
  const guests = new Map([
    ['socket-1', { playerId: 'guest-abc', displayName: 'Sree', district: 'Kannur' as const }],
  ]);
  const srv = await startTestServer({ guests });
  try {
    const jar = new Jar();
    const login = await api(srv, jar, 'POST', '/api/auth/google', {
      idToken: 'token-sree',
      socketId: 'socket-1',
    });
    assert.equal(login.status, 200);
    const player = login.json.player as { playerId: string; displayName: string; district: string };
    assert.equal(player.playerId, 'guest-abc');
    assert.equal(player.displayName, 'Sree');
    assert.equal(player.district, 'Kannur');
    assert.equal(login.json.profileComplete, true);

    // A second Google account cannot steal the claimed playerId.
    const jar2 = new Jar();
    const steal = await api(srv, jar2, 'POST', '/api/auth/google', {
      idToken: 'token-rahul',
      socketId: 'socket-1',
    });
    assert.equal(steal.status, 200);
    const player2 = steal.json.player as { playerId: string };
    assert.notEqual(player2.playerId, 'guest-abc');
    assert.equal(getUserBySubject(srv.db, 'google-sree')?.playerId, 'guest-abc');
  } finally {
    await srv.close();
  }
});

test('banned accounts cannot sign in', async () => {
  const srv = await startTestServer();
  try {
    const jar = new Jar();
    await api(srv, jar, 'POST', '/api/auth/google', { idToken: 'token-rahul' });
    const { setAccountStatus } = await import('./users.js');
    const rahul = await api(srv, jar, 'GET', '/api/auth/me');
    const rahulId = (rahul.json.player as { playerId: string }).playerId;
    setAccountStatus(srv.db, rahulId, 'banned');
    const jar2 = new Jar();
    const relogin = await api(srv, jar2, 'POST', '/api/auth/google', { idToken: 'token-rahul' });
    assert.equal(relogin.status, 403);
    assert.equal(relogin.json.error, 'This account is unavailable.');
  } finally {
    await srv.close();
  }
});

test('logout revokes the session and clears the cookie', async () => {
  const srv = await startTestServer();
  try {
    const jar = new Jar();
    await api(srv, jar, 'POST', '/api/auth/google', { idToken: 'token-sree' });
    const before = await api(srv, jar, 'GET', '/api/auth/me');
    assert.equal(before.json.authenticated, true);
    const logout = await api(srv, jar, 'POST', '/api/auth/logout', {});
    assert.equal(logout.status, 200);
    const after = await api(srv, jar, 'GET', '/api/auth/me');
    assert.equal(after.json.authenticated, false);
    const sessions = srv.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL').get() as {
      n: number;
    };
    assert.equal(sessions.n, 0);
  } finally {
    await srv.close();
  }
});

test('rename works once, then the 7-day cooldown rejects', async () => {
  const srv = await startTestServer();
  try {
    const jar = new Jar();
    await api(srv, jar, 'POST', '/api/auth/google', { idToken: 'token-sree' });
    // Initial setup (empty name) is free.
    const setup = await api(srv, jar, 'PATCH', '/api/auth/profile', { displayName: 'Sree' });
    assert.equal(setup.status, 200);
    // First real rename.
    const rename = await api(srv, jar, 'PATCH', '/api/auth/profile', { displayName: 'SreeK' });
    assert.equal(rename.status, 200);
    // Immediate second rename: cooldown.
    const tooSoon = await api(srv, jar, 'PATCH', '/api/auth/profile', { displayName: 'SreeKK' });
    assert.equal(tooSoon.status, 429);
    assert.ok((tooSoon.json.retryAfterMs as number) > 0);
    // Invalid name.
    const bad = await api(srv, jar, 'PATCH', '/api/auth/profile', { displayName: 'x' });
    assert.equal(bad.status, 400);
  } finally {
    await srv.close();
  }
});

test('cross-origin state-changing requests are rejected', async () => {
  const srv = await startTestServer();
  try {
    const jar = new Jar();
    const res = await api(
      srv,
      jar,
      'POST',
      '/api/auth/google',
      { idToken: 'token-sree' },
      { Origin: 'https://evil.example' },
    );
    assert.equal(res.status, 403);
    // Same-origin requests pass.
    const ok = await api(
      srv,
      jar,
      'POST',
      '/api/auth/google',
      { idToken: 'token-sree' },
      { Origin: 'http://localhost:5173' },
    );
    assert.equal(ok.status, 200);
  } finally {
    await srv.close();
  }
});

test('account deletion anonymizes and ends sessions', async () => {
  const srv = await startTestServer();
  try {
    const jar = new Jar();
    const login = await api(srv, jar, 'POST', '/api/auth/google', { idToken: 'token-sree' });
    const playerId = (login.json.player as { playerId: string }).playerId;
    const deleted = await api(srv, jar, 'DELETE', '/api/auth/account');
    assert.equal(deleted.status, 200);
    const me = await api(srv, jar, 'GET', '/api/auth/me');
    assert.equal(me.json.authenticated, false);
    const row = srv.db.prepare('SELECT * FROM users WHERE player_id = ?').get(playerId) as {
      google_subject: string | null;
      display_name: string;
      deleted_at: number | null;
    };
    assert.equal(row.google_subject, null);
    assert.equal(row.display_name, 'Deleted Player');
    assert.ok(row.deleted_at !== null);
  } finally {
    await srv.close();
  }
});

test('blocks: create, list, unblock (session identity only)', async () => {
  const srv = await startTestServer();
  try {
    const sree = new Jar();
    const rahul = new Jar();
    await api(srv, sree, 'POST', '/api/auth/google', { idToken: 'token-sree' });
    const rahulLogin = await api(srv, rahul, 'POST', '/api/auth/google', { idToken: 'token-rahul' });
    const rahulId = (rahulLogin.json.player as { playerId: string }).playerId;

    // Unauthenticated block attempt fails.
    const anon = await api(srv, new Jar(), 'POST', '/api/blocks', { blockedPlayerId: rahulId });
    assert.equal(anon.status, 401);

    const blocked = await api(srv, sree, 'POST', '/api/blocks', { blockedPlayerId: rahulId });
    assert.equal(blocked.status, 201);
    const dup = await api(srv, sree, 'POST', '/api/blocks', { blockedPlayerId: rahulId });
    assert.equal(dup.status, 409);

    const list = await api(srv, sree, 'GET', '/api/blocks');
    assert.equal(list.status, 200);
    const blocks = list.json.blocks as Array<{ playerId: string }>;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].playerId, rahulId);

    const unblocked = await api(srv, sree, 'DELETE', `/api/blocks/${rahulId}`);
    assert.equal(unblocked.status, 200);
    const empty = await api(srv, sree, 'GET', '/api/blocks');
    assert.equal((empty.json.blocks as unknown[]).length, 0);
  } finally {
    await srv.close();
  }
});

test('reports: valid, self-report rejected, rate limit enforced', async () => {
  const srv = await startTestServer();
  try {
    const sree = new Jar();
    const rahul = new Jar();
    await api(srv, sree, 'POST', '/api/auth/google', { idToken: 'token-sree' });
    const rahulLogin = await api(srv, rahul, 'POST', '/api/auth/google', { idToken: 'token-rahul' });
    const rahulId = (rahulLogin.json.player as { playerId: string }).playerId;

    const good = await api(srv, sree, 'POST', '/api/reports', {
      reportedPlayerId: rahulId,
      reason: 'spam',
      contextType: 'district-lobby',
    });
    assert.equal(good.status, 201);
    assert.ok((good.json as { reportId: string }).reportId);

    const sreeId = (
      (await api(srv, sree, 'GET', '/api/auth/me')).json.player as { playerId: string }
    ).playerId;
    const self = await api(srv, sree, 'POST', '/api/reports', {
      reportedPlayerId: sreeId,
      reason: 'spam',
    });
    assert.equal(self.status, 400);

    const badReason = await api(srv, sree, 'POST', '/api/reports', {
      reportedPlayerId: rahulId,
      reason: 'nope',
    });
    assert.equal(badReason.status, 400);
  } finally {
    await srv.close();
  }
});
