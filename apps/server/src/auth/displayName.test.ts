/**
 * Unit tests for server-side display-name validation and rename cooldown.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDisplayName,
  renameAllowed,
  DISPLAY_NAME_COOLDOWN_MS,
} from './displayName.js';

test('accepts normal names', () => {
  assert.equal(checkDisplayName('Sree').ok, true);
  assert.equal(checkDisplayName('Sree').normalized, 'Sree');
  assert.equal(checkDisplayName('Ammu 123').ok, true);
});

test('trims and normalizes', () => {
  const result = checkDisplayName('  Sree  ');
  assert.equal(result.ok, true);
  assert.equal(result.normalized, 'Sree');
});

test('rejects too-short and empty names', () => {
  assert.equal(checkDisplayName('A').ok, false);
  assert.equal(checkDisplayName('').ok, false);
  assert.equal(checkDisplayName('   ').ok, false);
});

test('rejects invisible-only names', () => {
  // Zero-width space / joiners alone must not pass.
  const zwsp = String.fromCharCode(0x200b);
  const zwnjZwj = String.fromCharCode(0x200c) + String.fromCharCode(0x200d);
  assert.equal(checkDisplayName(zwsp).ok, false);
  assert.equal(checkDisplayName(zwnjZwj).ok, false);
});

test('allows names with joiners inside visible text', () => {
  // Sanity: a visible name stays valid even with format characters inside
  // (relevant for scripts like Malayalam that use ZWJ/ZWNJ).
  const zwj = String.fromCharCode(0x200d);
  const result = checkDisplayName(`Sree${zwj}`);
  assert.equal(result.ok, true);
});

test('rejects control characters and overlong names', () => {
  assert.equal(checkDisplayName('Sree\x00').ok, false);
  // Interior control characters survive trim and are rejected.
  assert.equal(checkDisplayName('Sr\nee').ok, false);
  assert.equal(checkDisplayName('a'.repeat(21)).ok, false);
  assert.equal(checkDisplayName('a'.repeat(20)).ok, true);
});

test('rejects non-string input', () => {
  assert.equal(checkDisplayName(null).ok, false);
  assert.equal(checkDisplayName(42).ok, false);
});

test('initial setup never counts as a rename', () => {
  const gate = renameAllowed(null, Date.now());
  assert.equal(gate.allowed, true);
  assert.equal(gate.retryAfterMs, 0);
});

test('rename allowed after the 7-day cooldown', () => {
  const now = Date.now();
  const justChanged = renameAllowed(now, now);
  assert.equal(justChanged.allowed, false);
  assert.ok(justChanged.retryAfterMs > 0);
  assert.ok(justChanged.retryAfterMs <= DISPLAY_NAME_COOLDOWN_MS);

  const longAgo = renameAllowed(now - DISPLAY_NAME_COOLDOWN_MS - 1000, now);
  assert.equal(longAgo.allowed, true);
});
