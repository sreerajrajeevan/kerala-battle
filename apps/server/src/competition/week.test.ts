/**
 * Unit tests for Asia/Kolkata competition week/day helpers.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCompetitionDay, getCompetitionWeek } from './week.js';

test('week id and boundaries for a Saturday in October 2026', () => {
  // 2026-10-03 12:00 UTC == 17:30 IST on Saturday.
  const week = getCompetitionWeek(Date.UTC(2026, 9, 3, 12, 0, 0));
  assert.equal(week.id, '2026-W40');
  assert.equal(week.startsAt, '2026-09-28T00:00:00.000+05:30');
  assert.equal(week.endsAt, '2026-10-04T23:59:59.999+05:30');
});

test('Sunday 23:59 IST and Monday 00:00 IST fall in different weeks', () => {
  // 2026-10-04 18:29:59 UTC == 23:59:59 IST on Sunday.
  const sunday = getCompetitionWeek(Date.UTC(2026, 9, 4, 18, 29, 59));
  assert.equal(sunday.id, '2026-W40');
  // 2026-10-04 18:30:00 UTC == 00:00:00 IST on Monday.
  const monday = getCompetitionWeek(Date.UTC(2026, 9, 4, 18, 30, 0));
  assert.equal(monday.id, '2026-W41');
  assert.equal(monday.startsAt, '2026-10-05T00:00:00.000+05:30');
  assert.equal(monday.endsAt, '2026-10-11T23:59:59.999+05:30');
});

test('week is deterministic within the same Monday-Sunday span', () => {
  const a = getCompetitionWeek(Date.UTC(2026, 8, 28, 0, 0, 1)); // Mon 05:30 IST
  const b = getCompetitionWeek(Date.UTC(2026, 9, 4, 18, 29, 59)); // Sun 23:59 IST
  assert.equal(a.id, b.id);
  assert.equal(a.startsAt, b.startsAt);
  assert.equal(a.endsAt, b.endsAt);
});

test('year boundary: 2026-01-01 (Thursday) is in week 2026-W01 starting Dec 29 2025', () => {
  const week = getCompetitionWeek(Date.UTC(2026, 0, 1, 6, 30, 0)); // 12:00 IST
  assert.equal(week.id, '2026-W01');
  assert.equal(week.startsAt, '2025-12-29T00:00:00.000+05:30');
  assert.equal(week.endsAt, '2026-01-04T23:59:59.999+05:30');
});

test('competition day flips at IST midnight, not UTC midnight', () => {
  // 2026-10-04 18:29:59 UTC == 23:59:59 IST on Oct 4.
  const before = getCompetitionDay(Date.UTC(2026, 9, 4, 18, 29, 59));
  assert.equal(before.id, '2026-10-04');
  assert.equal(before.startsAt, '2026-10-04T00:00:00.000+05:30');
  assert.equal(before.endsAt, '2026-10-04T23:59:59.999+05:30');
  // 2026-10-04 18:30:00 UTC == 00:00:00 IST on Oct 5.
  const after = getCompetitionDay(Date.UTC(2026, 9, 4, 18, 30, 0));
  assert.equal(after.id, '2026-10-05');
  assert.equal(after.startsAt, '2026-10-05T00:00:00.000+05:30');
});

test('UTC midnight is still the previous IST day', () => {
  // 2026-10-04 00:00:00 UTC == 05:30 IST on Oct 4.
  const day = getCompetitionDay(Date.UTC(2026, 9, 4, 0, 0, 0));
  assert.equal(day.id, '2026-10-04');
});
