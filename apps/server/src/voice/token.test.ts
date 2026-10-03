/**
 * Unit tests for district voice token issuance.
 * Covers: room-name generation for every district, unknown-district refusal,
 * token claims (identity, room grant, metadata), and env config loading.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { KERALA_DISTRICTS, type KeralaDistrict } from '@kerala-battle/shared';
import { createVoiceToken, loadVoiceConfig, voiceRoomName, type VoiceConfig } from './token.js';

const DUMMY_CONFIG: VoiceConfig = {
  url: 'wss://dummy.livekit.example',
  apiKey: 'dummy-key',
  apiSecret: 'dummy-secret-that-is-long-enough-for-hmac',
};

/** Decodes the JWT payload without verifying (tests use dummy secrets). */
function decodePayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  assert.equal(parts.length, 3, 'token must be a JWT');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

test('voice room names are predictable per district', () => {
  assert.equal(voiceRoomName('Kannur'), 'kerala-battle-district-kannur');
  assert.equal(voiceRoomName('Kozhikode'), 'kerala-battle-district-kozhikode');
  assert.equal(voiceRoomName('Thiruvananthapuram'), 'kerala-battle-district-thiruvananthapuram');
});

test('every Kerala district gets a distinct room name', () => {
  const names = new Set(KERALA_DISTRICTS.map(voiceRoomName));
  assert.equal(names.size, KERALA_DISTRICTS.length);
  for (const name of names) {
    assert.match(name, /^kerala-battle-district-[a-z]+$/);
  }
});

test('voice room naming refuses unknown districts', () => {
  assert.throws(() => voiceRoomName('Atlantis' as KeralaDistrict), /unknown district/);
});

test('token identity is the server-known playerId', async () => {
  const { token } = await createVoiceToken(DUMMY_CONFIG, {
    playerId: 'player-123',
    displayName: 'Sree',
    district: 'Kannur',
  });
  const payload = decodePayload(token);
  assert.equal(payload.sub, 'player-123');
});

test('token grants join for exactly the player district room', async () => {
  const { token, roomName, url } = await createVoiceToken(DUMMY_CONFIG, {
    playerId: 'player-123',
    displayName: 'Sree',
    district: 'Kannur',
  });
  assert.equal(roomName, 'kerala-battle-district-kannur');
  assert.equal(url, DUMMY_CONFIG.url);
  const payload = decodePayload(token);
  const video = payload.video as Record<string, unknown>;
  assert.equal(video.roomJoin, true);
  assert.equal(video.room, 'kerala-battle-district-kannur');
  assert.equal(video.canPublish, true);
  assert.equal(video.canSubscribe, true);
});

test('token metadata carries playerId, displayName and district, no secrets', async () => {
  const { token } = await createVoiceToken(DUMMY_CONFIG, {
    playerId: 'player-123',
    displayName: 'Sree',
    district: 'Kozhikode',
  });
  const payload = decodePayload(token);
  const metadata = JSON.parse(payload.metadata as string) as Record<string, unknown>;
  assert.equal(metadata.playerId, 'player-123');
  assert.equal(metadata.displayName, 'Sree');
  assert.equal(metadata.district, 'Kozhikode');
  assert.ok(!JSON.stringify(metadata).includes('dummy-secret'), 'metadata must not leak the secret');
  assert.ok(!(payload as Record<string, unknown>).apiSecret, 'payload must not contain the secret');
});

test('different districts get different room grants', async () => {
  const kannur = await createVoiceToken(DUMMY_CONFIG, {
    playerId: 'p1',
    displayName: 'Sree',
    district: 'Kannur',
  });
  const kozhikode = await createVoiceToken(DUMMY_CONFIG, {
    playerId: 'p2',
    displayName: 'Rahul',
    district: 'Kozhikode',
  });
  assert.notEqual(kannur.roomName, kozhikode.roomName);
  const kannurRoom = (decodePayload(kannur.token).video as Record<string, unknown>).room;
  const kozhikodeRoom = (decodePayload(kozhikode.token).video as Record<string, unknown>).room;
  assert.equal(kannurRoom, 'kerala-battle-district-kannur');
  assert.equal(kozhikodeRoom, 'kerala-battle-district-kozhikode');
});

test('loadVoiceConfig returns null when any credential is missing', () => {
  assert.equal(loadVoiceConfig({}), null);
  assert.equal(
    loadVoiceConfig({ LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'k' } as NodeJS.ProcessEnv),
    null,
  );
  assert.equal(
    loadVoiceConfig({ LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' } as NodeJS.ProcessEnv),
    null,
  );
});

test('loadVoiceConfig returns config when all credentials are present', () => {
  const config = loadVoiceConfig({
    LIVEKIT_URL: 'wss://live.example',
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'secret',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(config, { url: 'wss://live.example', apiKey: 'key', apiSecret: 'secret' });
});

test('loadVoiceConfig trims whitespace-only values to disabled', () => {
  assert.equal(
    loadVoiceConfig({
      LIVEKIT_URL: '  ',
      LIVEKIT_API_KEY: 'key',
      LIVEKIT_API_SECRET: 'secret',
    } as NodeJS.ProcessEnv),
    null,
  );
});
