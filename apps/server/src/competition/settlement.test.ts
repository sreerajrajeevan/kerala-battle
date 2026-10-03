/**
 * Unit tests for pure competition scoring helpers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPETITION_DAILY_DISTRICT_CAP,
  COMPETITION_POINTS_COMPLETION_BONUS,
  COMPETITION_POINTS_DRAW,
  COMPETITION_POINTS_LOSS,
  COMPETITION_POINTS_WIN,
} from '@kerala-battle/shared';
import { districtAwardFor, personalPointsFor } from './settlement.js';

test('win/draw/loss personal points include the completion bonus', () => {
  assert.equal(personalPointsFor('win'), COMPETITION_POINTS_WIN + COMPETITION_POINTS_COMPLETION_BONUS);
  assert.equal(personalPointsFor('draw'), COMPETITION_POINTS_DRAW + COMPETITION_POINTS_COMPLETION_BONUS);
  assert.equal(personalPointsFor('loss'), COMPETITION_POINTS_LOSS + COMPETITION_POINTS_COMPLETION_BONUS);
});

test('personal points match the spec totals: 12 / 8 / 5', () => {
  assert.equal(personalPointsFor('win'), 12);
  assert.equal(personalPointsFor('draw'), 8);
  assert.equal(personalPointsFor('loss'), 5);
});

test('district award is uncapped when nothing is used yet', () => {
  assert.equal(districtAwardFor(12, 0), 12);
  assert.equal(districtAwardFor(5, 0), 5);
});

test('district award is partial when the cap is nearly reached', () => {
  assert.equal(districtAwardFor(12, 47), 3);
  assert.equal(districtAwardFor(5, 48), 2);
});

test('district award is zero when the cap is already reached', () => {
  assert.equal(districtAwardFor(12, COMPETITION_DAILY_DISTRICT_CAP), 0);
  assert.equal(districtAwardFor(12, COMPETITION_DAILY_DISTRICT_CAP + 10), 0);
});

test('district award never goes negative', () => {
  assert.equal(districtAwardFor(0, 0), 0);
  assert.equal(districtAwardFor(12, -5), 12);
});
