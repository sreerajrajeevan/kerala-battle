/**
 * Unit tests for the ranked battle queue and matchmaker.
 * Covers: cross-district pairing, same-district non-pairing, FIFO-compatible
 * pairing, duplicate join protection, cancel/disconnect cleanup, stale-week
 * sweeping, busy/challenge guards, and eviction on challenge accept.
 * Run with: npm run test --workspace=@kerala-battle/server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'socket.io';
import {
  GAME_TYPE_CROWN_RUSH,
  type ClientToServerEvents,
  type GameType,
  type KeralaDistrict,
  type ServerToClientEvents,
} from '@kerala-battle/shared';
import { RankedQueue, type QueuedPlayer } from './rankedQueue.js';
import {
  RankedMatchmaker,
  rankedMatchContext,
  type RankedMatchmakerDeps,
  type RankedPlayerInfo,
} from './rankedMatchmaker.js';
import type { CompetitionWeekConfig } from '../competition/featuredGame.js';

type IoServer = Server<ClientToServerEvents, ServerToClientEvents>;

function queued(
  playerId: string,
  district: KeralaDistrict,
  weekId = '2026-W40',
  socketId?: string,
): QueuedPlayer {
  return {
    socketId: socketId ?? `socket-${playerId}`,
    playerId,
    displayName: `Name-${playerId}`,
    district,
    joinedAt: Date.now(),
    competitionWeekId: weekId,
    featuredGameType: GAME_TYPE_CROWN_RUSH,
  };
}

test('pairOrEnqueue pairs the newcomer with the earliest different-district entry', () => {
  const queue = new RankedQueue();
  const a = queued('a', 'Kannur');
  const b = queued('b', 'Kannur');
  assert.equal(queue.pairOrEnqueue(a), undefined);
  assert.equal(queue.pairOrEnqueue(b), undefined);
  assert.equal(queue.size(), 2);

  const c = queued('c', 'Kozhikode');
  const partner = queue.pairOrEnqueue(c);
  assert.equal(partner?.playerId, 'a'); // earliest compatible, not b
  assert.equal(queue.size(), 1); // only b remains
  assert.deepEqual(
    queue.list().map((entry) => entry.playerId),
    ['b'],
  );
});

test('same-district players are never paired', () => {
  const queue = new RankedQueue();
  assert.equal(queue.pairOrEnqueue(queued('a', 'Kannur')), undefined);
  assert.equal(queue.pairOrEnqueue(queued('b', 'Kannur')), undefined);
  assert.equal(queue.size(), 2);
});

test('removeBySocket / removeByPlayerId drop exactly one entry', () => {
  const queue = new RankedQueue();
  queue.pairOrEnqueue(queued('a', 'Kannur'));
  queue.pairOrEnqueue(queued('b', 'Kannur', '2026-W40', 'socket-b'));
  assert.equal(queue.removeBySocket('socket-b')?.playerId, 'b');
  assert.equal(queue.size(), 1);
  assert.equal(queue.removeByPlayerId('a')?.playerId, 'a');
  assert.equal(queue.size(), 0);
  assert.equal(queue.removeBySocket('missing'), undefined);
});

test('sweepStaleWeek removes only older-week entries', () => {
  const queue = new RankedQueue();
  queue.pairOrEnqueue(queued('old', 'Kannur', '2026-W39'));
  queue.pairOrEnqueue(queued('new', 'Kannur', '2026-W40'));
  const stale = queue.sweepStaleWeek('2026-W40');
  assert.deepEqual(
    stale.map((entry) => entry.playerId),
    ['old'],
  );
  assert.deepEqual(
    queue.list().map((entry) => entry.playerId),
    ['new'],
  );
});

test('rankedMatchContext builds the server-authoritative ranked context', () => {
  const week: CompetitionWeekConfig = {
    competitionWeekId: '2026-W40',
    featuredGameType: GAME_TYPE_CROWN_RUSH,
    startsAt: '2026-09-28T00:00:00.000+05:30',
    endsAt: '2026-10-04T23:59:59.999+05:30',
  };
  const context = rankedMatchContext(
    { district: 'Kannur' },
    { district: 'Kozhikode' },
    week,
    123456789,
  );
  assert.equal(context.matchMode, 'ranked');
  assert.equal(context.matchSource, 'weekly-queue');
  assert.equal(context.competitionWeekId, '2026-W40');
  assert.deepEqual(context.districts, ['Kannur', 'Kozhikode']);
  assert.equal(context.startedAtMs, 123456789);
});

// ---------------------------------------------------------------------------
// Matchmaker with stubbed socket.io + player state
// ---------------------------------------------------------------------------

interface Emitted {
  socketId: string;
  event: string;
  payload: unknown;
}

function makeHarness() {
  const emitted: Emitted[] = [];
  const io = {
    to: (socketId: string) => ({
      emit: (event: string, payload: unknown) => {
        emitted.push({ socketId, event, payload });
      },
    }),
  } as unknown as IoServer;
  const players = new Map<string, RankedPlayerInfo>();
  const busy = new Set<string>();
  const challenged = new Set<string>();
  const queue = new RankedQueue();
  let week: CompetitionWeekConfig = {
    competitionWeekId: '2026-W40',
    featuredGameType: GAME_TYPE_CROWN_RUSH,
    startsAt: '',
    endsAt: '',
  };
  const started: Array<{ a: RankedPlayerInfo; b: RankedPlayerInfo; week: CompetitionWeekConfig }> =
    [];
  const deps: RankedMatchmakerDeps = {
    io,
    queue,
    getPlayer: (socketId) => players.get(socketId),
    isBusy: (playerId) => busy.has(playerId),
    hasPendingChallenge: (playerId) => challenged.has(playerId),
    getWeekConfig: () => week,
    startRankedMatch: (a, b, w) => {
      started.push({ a, b, week: w });
    },
    introDelayMs: 0,
  };
  const matchmaker = new RankedMatchmaker(deps);
  const register = (playerId: string, district: KeralaDistrict): string => {
    const socketId = `socket-${playerId}`;
    players.set(socketId, { socketId, playerId, displayName: `Name-${playerId}`, district });
    return socketId;
  };
  const eventsFor = (socketId: string, event: string): unknown[] =>
    emitted.filter((e) => e.socketId === socketId && e.event === event).map((e) => e.payload);
  return { emitted, players, busy, challenged, queue, matchmaker, started, register, eventsFor,
    setWeek: (next: CompetitionWeekConfig) => { week = next; } };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

test('duplicate joins never create extra queue entries', () => {
  const h = makeHarness();
  const socketId = h.register('sree', 'Kannur');
  h.matchmaker.join(socketId);
  h.matchmaker.join(socketId);
  h.matchmaker.join(socketId);
  assert.equal(h.queue.size(), 1);
  const errors = h.eventsFor(socketId, 'ranked-queue:error') as Array<{ reason: string }>;
  assert.equal(errors.length, 2);
  assert.ok(errors.every((e) => e.reason === 'already-queued'));
});

test('cross-district join pairs and starts the featured game', async () => {
  const h = makeHarness();
  const sree = h.register('sree', 'Kannur');
  const rahul = h.register('rahul', 'Kozhikode');
  h.matchmaker.join(sree);
  assert.equal(h.queue.size(), 1);
  h.matchmaker.join(rahul);
  assert.equal(h.queue.size(), 0);

  const sreeMatched = h.eventsFor(sree, 'ranked-queue:matched');
  const rahulMatched = h.eventsFor(rahul, 'ranked-queue:matched');
  assert.equal(sreeMatched.length, 1);
  assert.equal(rahulMatched.length, 1);
  const payload = sreeMatched[0] as { gameType: GameType; opponent: { district: KeralaDistrict }; myDistrict: KeralaDistrict };
  assert.equal(payload.gameType, GAME_TYPE_CROWN_RUSH);
  assert.equal(payload.opponent.district, 'Kozhikode');
  assert.equal(payload.myDistrict, 'Kannur');

  await tick(); // intro delay (0ms in tests)
  assert.equal(h.started.length, 1);
  // The newcomer (rahul) is passed as `a`, the earlier partner (sree) as `b`.
  assert.equal(h.started[0]?.a.playerId, 'rahul');
  assert.equal(h.started[0]?.b.playerId, 'sree');
});

test('same-district players keep waiting; third player pairs FIFO', async () => {
  const h = makeHarness();
  const sree = h.register('sree', 'Kannur');
  const anu = h.register('anu', 'Kannur');
  const rahul = h.register('rahul', 'Kozhikode');
  h.matchmaker.join(sree);
  h.matchmaker.join(anu);
  assert.equal(h.queue.size(), 2);
  assert.equal(h.started.length, 0);

  h.matchmaker.join(rahul);
  await tick();
  assert.equal(h.started.length, 1);
  // FIFO: the earliest Kannur player (sree) pairs with rahul; the newcomer
  // (rahul) is passed as `a`, the earlier partner (sree) as `b`.
  assert.equal(h.started[0]?.a.playerId, 'rahul');
  assert.equal(h.started[0]?.b.playerId, 'sree');
  assert.deepEqual(
    h.queue.list().map((entry) => entry.playerId),
    ['anu'],
  );
  const searching = h.eventsFor(anu, 'ranked-queue:status') as Array<{ status: string }>;
  assert.ok(searching.some((s) => s.status === 'searching'));
});

test('searching status carries the featured game, week and live queue size', () => {
  const h = makeHarness();
  const socketId = h.register('sree', 'Kannur');
  h.matchmaker.join(socketId);
  const statuses = h.eventsFor(socketId, 'ranked-queue:status') as Array<{
    status: string;
    featuredGameType: GameType;
    competitionWeekId: string;
    queueSize: number;
  }>;
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]?.status, 'searching');
  assert.equal(statuses[0]?.featuredGameType, GAME_TYPE_CROWN_RUSH);
  assert.equal(statuses[0]?.competitionWeekId, '2026-W40');
  assert.equal(statuses[0]?.queueSize, 1);
});

test('cancel removes the entry immediately', () => {
  const h = makeHarness();
  const socketId = h.register('sree', 'Kannur');
  h.matchmaker.join(socketId);
  assert.equal(h.queue.size(), 1);
  h.matchmaker.cancel(socketId);
  assert.equal(h.queue.size(), 0);
  const statuses = h.eventsFor(socketId, 'ranked-queue:status') as Array<{ status: string }>;
  assert.ok(statuses.some((s) => s.status === 'cancelled'));
});

test('disconnect removes the queue entry: no ghost match later', async () => {
  const h = makeHarness();
  const sree = h.register('sree', 'Kannur');
  const rahul = h.register('rahul', 'Kozhikode');
  h.matchmaker.join(sree);
  h.matchmaker.handleDisconnect(sree);
  assert.equal(h.queue.size(), 0);
  h.matchmaker.join(rahul);
  await tick();
  assert.equal(h.started.length, 0); // rahul keeps searching alone
  assert.equal(h.queue.size(), 1);
});

test('busy players and challenge-pending players are rejected', () => {
  const h = makeHarness();
  const busySocket = h.register('busy', 'Kannur');
  const challengedSocket = h.register('challenged', 'Kannur');
  const ghostSocket = 'socket-ghost';
  h.busy.add('busy');
  h.challenged.add('challenged');

  h.matchmaker.join(busySocket);
  h.matchmaker.join(challengedSocket);
  h.matchmaker.join(ghostSocket);
  assert.equal(h.queue.size(), 0);

  const reasons = (socketId: string): string[] =>
    (h.eventsFor(socketId, 'ranked-queue:error') as Array<{ reason: string }>).map((e) => e.reason);
  assert.deepEqual(reasons(busySocket), ['in-match']);
  assert.deepEqual(reasons(challengedSocket), ['challenge-pending']);
  assert.deepEqual(reasons(ghostSocket), ['not-registered']);
});

test('week rollover sweeps stale entries and notifies them', () => {
  const h = makeHarness();
  const sree = h.register('sree', 'Kannur');
  h.matchmaker.join(sree);
  assert.equal(h.queue.size(), 1);

  h.setWeek({
    competitionWeekId: '2026-W41',
    featuredGameType: 'precision-clash' as GameType,
    startsAt: '',
    endsAt: '',
  });
  const rahul = h.register('rahul', 'Kozhikode');
  h.matchmaker.join(rahul);

  const sreeStatuses = h.eventsFor(sree, 'ranked-queue:status') as Array<{ status: string }>;
  assert.ok(sreeStatuses.some((s) => s.status === 'week-changed'));
  // rahul searches alone in the new week; no cross-week pairing happened.
  assert.equal(h.queue.size(), 1);
  assert.equal(h.queue.list()[0]?.playerId, 'rahul');
  assert.equal(h.queue.list()[0]?.competitionWeekId, '2026-W41');
});

test('evictPlayer drops queue entries and aborts pending intros', async () => {
  const h = makeHarness();
  const sree = h.register('sree', 'Kannur');
  h.matchmaker.join(sree);
  h.matchmaker.evictPlayer('sree');
  assert.equal(h.queue.size(), 0);
  const statuses = h.eventsFor(sree, 'ranked-queue:status') as Array<{ status: string }>;
  assert.ok(statuses.some((s) => s.status === 'cancelled'));

  // Pending intro aborted when one side is evicted mid-intro.
  const harness2 = makeHarness();
  const a = harness2.register('a', 'Kannur');
  const b = harness2.register('b', 'Kozhikode');
  harness2.matchmaker.join(a);
  harness2.matchmaker.join(b);
  assert.equal(harness2.matchmaker.pendingCount(), 1);
  harness2.matchmaker.evictPlayer('a');
  await tick();
  assert.equal(harness2.started.length, 0);
  const bStatuses = harness2.eventsFor(b, 'ranked-queue:status') as Array<{ status: string }>;
  assert.ok(bStatuses.some((s) => s.status === 'cancelled'));
});

test('vanished player during intro aborts the match instead of ghost-starting', async () => {
  const h = makeHarness();
  const a = h.register('a', 'Kannur');
  const b = h.register('b', 'Kozhikode');
  h.matchmaker.join(a);
  h.matchmaker.join(b);
  h.players.delete(a); // a's socket is gone before the intro elapses
  await tick();
  assert.equal(h.started.length, 0);
  const bStatuses = h.eventsFor(b, 'ranked-queue:status') as Array<{ status: string }>;
  assert.ok(bStatuses.some((s) => s.status === 'cancelled'));
});
