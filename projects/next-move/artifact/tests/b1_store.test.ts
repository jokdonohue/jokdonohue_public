import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DOC_BYTES } from '../src/contract/docs';
import { createFakeStore, createMemoryKv, StoreError, type ConnectionState } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { createDbStore } from '../src/store/dbStore';
import { getDeviceId, DEVICE_KEY } from '../src/store/device';
import { useCapability, type PlatformDb, type PlatformDocRef, type PlatformDocSnapshot } from '../src/store/runtime';
import { openIdbKv } from '../src/store/idbKv';

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const attempt = (at: number, puzzleId = 'p1') => ({ puzzleId, themes: ['fork'], correct: true, unassisted: true, hints: 0, revealed: false, durationMs: 1000, at, source: 'bank' as const });

test('offline queue: survives a failed write, flushes once when back, no duplicates', async () => {
  const store = createFakeStore();
  const kv = createMemoryKv();
  let clock = 1_000;
  const writer = await createSessionWriter({ store, kv, deviceId: 'dtest01', now: () => clock, debounceMs: 10_000, retryMs: 60_000 });
  store.setOffline(true);
  writer.record(attempt(1_001));
  writer.record(attempt(1_001)); // duplicate key puzzleId:at
  writer.record(attempt(1_002, 'p2'));
  assert.equal(writer.unconfirmed().length, 2);
  assert.equal(writer.saveState(), 'pending');
  await assert.rejects(writer.flush(), (e: unknown) => e instanceof StoreError && e.code === 'unavailable');
  assert.equal(writer.saveState(), 'retrying');
  assert.equal(writer.unconfirmed().length, 2, 'still queued after the failure');
  await tick();
  assert.equal([...kv.data.keys()].length, 1, 'persisted locally');

  store.setOffline(false);
  await writer.flush();
  await writer.flush(); // nothing new: no second write
  const path = `sessions/${writer.sessionId}`;
  assert.equal(store.writeCounts.get(path), 1);
  const doc = (await store.get<{ attempts: Array<{ puzzleId: string }> }>(path))!.data;
  assert.deepEqual(doc.attempts.map(a => a.puzzleId), ['p1', 'p2']);
  assert.equal(writer.unconfirmed().length, 0);
  assert.equal(writer.saveState(), 'saved');
  writer.record(attempt(1_001)); // a repeat after confirmation is still dropped
  assert.equal(writer.unconfirmed().length, 0);
  writer.dispose();
});

test('offline queue: a reload flushes the queued session from the KvStore exactly once', async () => {
  const store = createFakeStore();
  const kv = createMemoryKv();
  store.setOffline(true);
  const first = await createSessionWriter({ store, kv, deviceId: 'dtest02', now: () => 5_000, debounceMs: 10_000, retryMs: 60_000 });
  first.record(attempt(5_001));
  await first.flush().catch(() => undefined);
  first.dispose();
  await tick();
  store.setOffline(false);
  const second = await createSessionWriter({ store, kv, deviceId: 'dtest02', now: () => 5_000 + 2 * 86_400_000, debounceMs: 10_000, retryMs: 60_000 });
  await second.flush();
  const docs = await store.query({ collection: 'sessions' });
  assert.equal(docs.length, 1);
  assert.equal(store.writeCounts.get(docs[0].path), 1);
  assert.equal((docs[0].data.attempts as unknown[]).length, 1);
  assert.equal(kv.data.size, 0, 'a confirmed session from an earlier day leaves the queue');
  second.dispose();
});

test('session writer: debounce writes once after a burst, end() stamps endedAt, rollover at 600', async () => {
  const store = createFakeStore();
  let clock = 10_000;
  const writer = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'dtest03', now: () => clock, debounceMs: 20 });
  for (let i = 0; i < 5; i++) writer.record(attempt(10_000 + i, `b${i}`));
  await tick(60);
  const first = `sessions/${writer.sessionId}`;
  assert.equal(store.writeCounts.get(first), 1, 'one write for the burst');
  clock = 20_000;
  await writer.end();
  assert.equal((await store.get<{ endedAt: number }>(first))!.data.endedAt, 20_000);
  writer.record(attempt(30_000, 'c0'));
  assert.notEqual(`sessions/${writer.sessionId}`, first, 'a new session after end()');
  for (let i = 1; i < 601; i++) writer.record(attempt(30_000 + i, `c${i}`));
  await writer.flush();
  const docs = await store.query<{ attempts: unknown[]; endedAt?: number }>({ collection: 'sessions', orderBy: { field: 'startedAt' } });
  assert.deepEqual(docs.map(d => d.data.attempts.length), [5, 600, 1]);
  assert.ok(docs[1].data.endedAt !== undefined);
  assert.throws(() => writer.record({ ...attempt(1, 'x'), unassisted: false }), TypeError);
  writer.dispose();
});

test('session writer: a permanent failure is reported and not retried in a loop', async () => {
  const store = createFakeStore();
  const writer = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'dtest04', now: () => 1, debounceMs: 10_000, retryMs: 5 });
  const states: string[] = [];
  writer.onSaveState(s => states.push(s));
  store.failNextWrites(1, 'quota_exceeded');
  writer.record(attempt(2));
  await assert.rejects(writer.flush(), (e: unknown) => e instanceof StoreError && e.code === 'quota_exceeded');
  await tick(30);
  assert.equal([...store.writeCounts.values()].length, 0, 'no automatic retry');
  assert.deepEqual(states, ['pending', 'error']);
  await writer.flush();
  assert.equal(writer.saveState(), 'saved');
  writer.dispose();
});

/** A minimal PlatformDb over a Map, with fault injection, to exercise the adapter. */
function mockDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const faults: string[] = [];
  let calls = 0;
  const snap = (path: string, fromCache = false): PlatformDocSnapshot => ({ id: path.split('/').pop()!, exists: docs.has(path), data: () => docs.get(path), metadata: { fromCache, hasPendingWrites: false } });
  const run = async <T>(fn: () => T): Promise<T> => { calls++; const f = faults.shift(); if (f) throw { code: f, message: f }; return fn(); };
  const doc = (path: string): PlatformDocRef => ({
    id: path.split('/').pop()!, path,
    get: () => run(() => snap(path)),
    set: d => run(() => { docs.set(path, d); }),
    update: d => run(() => { if (!docs.has(path)) throw { code: 'invalid_argument', message: 'missing' }; docs.set(path, { ...docs.get(path), ...d }); }),
    delete: () => run(() => { docs.delete(path); }),
    onSnapshot: (next) => { setTimeout(() => next(snap(path, true)), 0); setTimeout(() => next(snap(path)), 2); return () => {}; },
  });
  const db = { doc, collection: () => { throw new Error('unused'); } } as unknown as PlatformDb;
  return { db, docs, faults, calls: () => calls };
}

test('db adapter: semantics, single retry on unavailable, size check before the platform', async () => {
  const m = mockDb();
  const store = createDbStore(m.db, { timeoutMs: 1000, retryDelayMs: [1, 2] });
  assert.equal(store.connection(), 'connecting');
  assert.equal(await store.get('notes/n1'), null);
  assert.equal(store.connection(), 'live');
  m.faults.push('unavailable');
  await store.set('notes/n1', { a: 1 });
  assert.deepEqual(m.docs.get('notes/n1'), { a: 1 });
  m.faults.push('unavailable', 'unavailable');
  await assert.rejects(store.set('notes/n1', { a: 2 }), (e: unknown) => e instanceof StoreError && e.code === 'unavailable');
  const before = m.calls();
  await assert.rejects(store.set('notes/n2', { s: 'x'.repeat(MAX_DOC_BYTES) }), (e: unknown) => e instanceof StoreError && e.code === 'doc_too_large');
  assert.equal(m.calls(), before, 'oversized body never reaches the platform');
  await assert.rejects(store.update('notes/missing', { a: 1 }), (e: unknown) => e instanceof StoreError && e.code === 'invalid_argument');
  assert.notEqual(store.connection(), 'read-only', 'update on a missing doc is not a write ban');
  assert.throws(() => store.subscribe('notes', () => {}), TypeError);
});

test('db adapter: connection states for timer, quota, write ban and revocation', async () => {
  const m = mockDb();
  const store = createDbStore(m.db, { timeoutMs: 10, retryDelayMs: [1, 2] });
  const seen: ConnectionState[] = [];
  store.onConnection(s => seen.push(s));
  await tick(30);
  assert.equal(store.connection(), 'stale', 'load timer fired with no answer');
  const docs: unknown[] = [];
  store.subscribe('notes/n1', d => docs.push(d));
  await tick(10);
  assert.equal(store.connection(), 'live', 'first confirmed snapshot');
  assert.equal(docs.length, 2);
  m.faults.push('quota_exceeded');
  await assert.rejects(store.set('notes/n1', { a: 1 }));
  assert.equal(store.connection(), 'full');
  await store.set('notes/n1', { a: 1 });
  assert.equal(store.connection(), 'live');
  m.faults.push('invalid_argument');
  await assert.rejects(store.set('notes/n1', { a: 1 }));
  assert.equal(store.connection(), 'read-only');
  m.faults.push('revoked');
  await assert.rejects(store.get('notes/n1'));
  assert.equal(store.connection(), 'revoked');
  await store.get('notes/n1');
  assert.equal(store.connection(), 'revoked', 'revoked is terminal');
  await tick(5);
  assert.deepEqual(seen, ['stale', 'live', 'full', 'live', 'read-only', 'revoked']);
});

test('runtime and device helpers degrade without the platform', async () => {
  assert.equal(await useCapability('db', {}), null);
  assert.equal(await useCapability('db', { claude: { use: async () => { throw new Error('x'); } } }), null);
  assert.equal(await useCapability<string>('db', { claude: { use: async () => 'ns' } }), 'ns');
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  const id = getDeviceId(storage);
  assert.match(id, /^d[a-z0-9]{6,24}$/);
  assert.equal(getDeviceId(storage), id);
  assert.equal(mem.get(DEVICE_KEY), id);
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.match(getDeviceId(broken), /^d[a-z0-9]{6,24}$/);
  const kv = await openIdbKv('x', undefined);
  assert.equal(kv.persistent, false);
});

test('session writer: a written session from an earlier day is pruned at load; today\'s is continued', async () => {
  const store = createFakeStore();
  const kv = createMemoryKv();
  const first = await createSessionWriter({ store, kv, deviceId: 'dtest05', now: () => 1_000, debounceMs: 10_000 });
  first.record(attempt(1_001));
  await first.flush();
  const firstId = first.sessionId;
  first.dispose();
  await tick();
  assert.equal(kv.data.size, 1, 'current session kept while the tab is open');
  const sameDay = await createSessionWriter({ store, kv, deviceId: 'dtest05', now: () => 2_000, debounceMs: 10_000 });
  assert.equal(sameDay.sessionId, firstId, 'a later load the same day continues the same document');
  sameDay.record(attempt(2_001, 'p2'));
  await sameDay.flush();
  assert.equal((await store.query({ collection: 'sessions' })).length, 1);
  assert.equal(((await store.get<{ attempts: unknown[] }>(`sessions/${firstId}`))!.data.attempts).length, 2);
  sameDay.dispose();
  await tick();
  const nextDay = await createSessionWriter({ store, kv, deviceId: 'dtest05', now: () => 2_000 + 2 * 86_400_000, debounceMs: 10_000 });
  await nextDay.flush(); // read-back of yesterday's session, then it leaves the queue
  await tick();
  assert.equal(kv.data.size, 0);
  assert.equal(nextDay.saveState(), 'saved');
  assert.notEqual(nextDay.sessionId, firstId);
  nextDay.dispose();
});

test('session writer: an unwritable queued session is set aside and does not block the others', async () => {
  const store = createFakeStore();
  const kv = createMemoryKv();
  const bad = { id: 's-1-dtest06', doc: { device: 'dtest06', startedAt: 1, attempts: [{ ...attempt(2), puzzleId: '' }] }, confirmed: 0, endConfirmed: false, rev: 1, writtenRev: 0 };
  await kv.set('session:s-1-dtest06', bad);
  const writer = await createSessionWriter({ store, kv, deviceId: 'dtest06', now: () => 10, debounceMs: 10_000, retryMs: 60_000 });
  writer.record(attempt(11, 'good'));
  await writer.flush().catch(() => undefined);
  await writer.flush();
  await tick();
  const docs = await store.query<{ attempts: Array<{ puzzleId: string }> }>({ collection: 'sessions' });
  assert.deepEqual(docs.map(d => d.id), [writer.sessionId], 'only the salvaged session is written');
  assert.deepEqual(docs[0].data.attempts.map(a => a.puzzleId), ['good'], 'the good answer recorded into the reused session survives');
  assert.ok(kv.data.has('bad-session:s-1-dtest06'));
  assert.equal(kv.data.has('session:s-1-dtest06'), false);
  assert.equal(writer.saveState(), 'set-aside', 'never "saved" while an answer was set aside unsaved');
  writer.dispose();
});

test('db adapter sends plain JSON; fake update merges overlapping writes', async () => {
  const m = mockDb();
  const store = createDbStore(m.db, { timeoutMs: 1000, retryDelayMs: [1, 2] });
  await store.set('notes/n1', { a: 1, gone: undefined });
  assert.deepEqual(Object.keys(m.docs.get('notes/n1')!), ['a']);
  const fake = createFakeStore({ latencyMs: 2 });
  await fake.set('settings/main', { a: 0 });
  await Promise.all([fake.update('settings/main', { b: 1 }), fake.update('settings/main', { c: 2 })]);
  assert.deepEqual((await fake.get('settings/main'))!.data, { a: 0, b: 1, c: 2 });
});
