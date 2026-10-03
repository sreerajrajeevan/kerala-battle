/**
 * Unit tests for the proximity-voice volume math.
 * Covers: zone boundaries, mid-fade values, beyond-max silence, invalid
 * positions, local-mute override, and volume smoothing.
 * Run with: npm run test --workspace=@kerala-battle/web
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_FULL_VOLUME_DISTANCE,
  VOICE_MAX_HEARING_DISTANCE,
} from '@kerala-battle/shared';
import {
  distanceBetween,
  effectiveRemoteVolume,
  lerpVolume,
  volumeForDistance,
} from './proximity.js';

describe('volumeForDistance', () => {
  it('distance 0 -> volume 1', () => {
    assert.equal(volumeForDistance(0), 1);
  });

  it('FULL_VOLUME boundary -> 1', () => {
    assert.equal(volumeForDistance(VOICE_FULL_VOLUME_DISTANCE), 1);
    assert.equal(volumeForDistance(VOICE_FULL_VOLUME_DISTANCE - 0.001), 1);
  });

  it('middle of the fade -> strictly between 0 and 1', () => {
    const middle = (VOICE_FULL_VOLUME_DISTANCE + VOICE_MAX_HEARING_DISTANCE) / 2;
    const volume = volumeForDistance(middle);
    assert.ok(volume > 0 && volume < 1, `expected (0,1), got ${volume}`);
    assert.equal(volume, 0.5);
  });

  it('fade is monotonic decreasing with distance', () => {
    let previous = 1;
    for (let d = VOICE_FULL_VOLUME_DISTANCE; d <= VOICE_MAX_HEARING_DISTANCE; d += 10) {
      const volume = volumeForDistance(d);
      assert.ok(volume <= previous, `volume rose at distance ${d}`);
      previous = volume;
    }
  });

  it('MAX_HEARING boundary -> 0', () => {
    assert.equal(volumeForDistance(VOICE_MAX_HEARING_DISTANCE), 0);
  });

  it('beyond max -> 0', () => {
    assert.equal(volumeForDistance(VOICE_MAX_HEARING_DISTANCE + 1), 0);
    assert.equal(volumeForDistance(100000), 0);
  });

  it('invalid distances are silent, never loud', () => {
    assert.equal(volumeForDistance(Number.NaN), 0);
    assert.equal(volumeForDistance(Number.POSITIVE_INFINITY), 0);
    assert.equal(volumeForDistance(Number.NEGATIVE_INFINITY), 0);
  });
});

describe('distanceBetween', () => {
  it('computes euclidean distance', () => {
    assert.equal(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
    assert.equal(distanceBetween({ x: 100, y: 100 }, { x: 100, y: 100 }), 0);
  });

  it('invalid positions are infinitely far (silent)', () => {
    assert.equal(
      distanceBetween({ x: Number.NaN, y: 0 }, { x: 0, y: 0 }),
      Number.POSITIVE_INFINITY,
    );
    assert.equal(
      volumeForDistance(distanceBetween({ x: 0, y: Number.NaN }, { x: 0, y: 0 })),
      0,
    );
  });
});

describe('effectiveRemoteVolume', () => {
  it('local mute overrides distance volume to 0', () => {
    assert.equal(
      effectiveRemoteVolume({ distanceVolume: 1, locallyMuted: true, voiceEnabled: true }),
      0,
    );
  });

  it('voice-off (deafen) overrides distance volume to 0', () => {
    assert.equal(
      effectiveRemoteVolume({ distanceVolume: 1, locallyMuted: false, voiceEnabled: false }),
      0,
    );
  });

  it('passes distance volume through when audible', () => {
    assert.equal(
      effectiveRemoteVolume({ distanceVolume: 0.4, locallyMuted: false, voiceEnabled: true }),
      0.4,
    );
  });
});

describe('lerpVolume', () => {
  it('moves toward the target without jumping', () => {
    const next = lerpVolume(1, 0);
    assert.ok(next < 1 && next > 0, `expected smooth step, got ${next}`);
  });

  it('converges to the target', () => {
    let current = 1;
    for (let i = 0; i < 200; i++) current = lerpVolume(current, 0);
    assert.equal(current, 0);
  });

  it('stays at the target once reached', () => {
    assert.equal(lerpVolume(0.5, 0.5), 0.5);
    assert.equal(lerpVolume(0, 0), 0);
  });

  it('clamps out-of-range inputs', () => {
    assert.ok(lerpVolume(-5, 2) >= 0 && lerpVolume(-5, 2) <= 1);
  });
});
