/**
 * Unit tests for the in-memory rate limiter.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, RATE_LIMIT_RULES } from './limiter.js';

test('allows hits up to the max, then rejects', () => {
  const now = 1_000_000;
  const limiter = new RateLimiter(() => now);
  const rule = { windowMs: 60_000, max: 3 };
  assert.equal(limiter.check('k', rule).ok, true);
  assert.equal(limiter.check('k', rule).ok, true);
  assert.equal(limiter.check('k', rule).ok, true);
  const rejected = limiter.check('k', rule);
  assert.equal(rejected.ok, false);
  assert.ok((rejected.retryAfterMs ?? 0) > 0);
});

test('window resets after it elapses', () => {
  let now = 1_000_000;
  const limiter = new RateLimiter(() => now);
  const rule = { windowMs: 60_000, max: 1 };
  assert.equal(limiter.check('k', rule).ok, true);
  assert.equal(limiter.check('k', rule).ok, false);
  now += 60_001;
  assert.equal(limiter.check('k', rule).ok, true);
});

test('keys are independent', () => {
  const now = 1_000_000;
  const limiter = new RateLimiter(() => now);
  const rule = { windowMs: 60_000, max: 1 };
  assert.equal(limiter.check('a', rule).ok, true);
  assert.equal(limiter.check('a', rule).ok, false);
  assert.equal(limiter.check('b', rule).ok, true);
});

test('shared rule set covers every abuse-prone surface', () => {
  for (const name of [
    'authAttempts',
    'voiceToken',
    'reports',
    'challengeSend',
    'rankedQueueJoin',
    'profileRename',
    'blocks',
  ] as const) {
    const rule = RATE_LIMIT_RULES[name];
    assert.ok(rule.windowMs > 0, `${name} window`);
    assert.ok(rule.max > 0, `${name} max`);
  }
  // Reports: 10 per hour per reporter.
  assert.equal(RATE_LIMIT_RULES.reports.max, 10);
  assert.equal(RATE_LIMIT_RULES.reports.windowMs, 3_600_000);
});
