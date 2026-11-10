/** Review 2 P0-1: answers made while the database is unavailable must survive until the database confirms them. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeStore, createMemoryKv, type KvStore } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const attempt = (at: number, puzzleId = 'p1') => ({ puzzleId, themes: ['fork'], correct: true, unassisted: true, hints: 0, revealed: false, durationMs: 1000, at, source: 'bank' as const });
/** As main.tsx builds it when `claude.use("db")` resolves null. */
const localOnly = () => createFakeStore({ connection: 'local-only' });
const opts = { debounceMs: 60_000, retryMs: 60_000, events: null };
async function countDb(store: ReturnType<typeof createFakeStore>) {
  return (await store.query<{ attempts: unknown[] }>({ collection: 'sessions' })).reduce((n, d) => n + d.data.attempts.length, 0);
}
async function load(store: ReturnType<typeof createFakeStore>, kv: KvStore, now: number) {
  return createSessionWriter({ store, kv, deviceId: 'dphone1', now: () => now, ...opts });
}

test('P0-1: offline load with answers, then a normal load: the database receives them all', async () => {
  const kv = createMemoryKv();
  const offline = await load(localOnly(), kv, 1_000);
  offline.record(attempt(1_001, 'a'));
  offline.record(attempt(1_002, 'b'));
  await offline.flush().catch(() => undefined);
  assert.equal(offline.unconfirmed().length, 2, 'nothing is confirmed by a local-only store');
  offline.dispose();
  await tick();
  const db = createFakeStore();
  const online = await load(db, kv, 50_000);
  await online.flush();
  assert.equal(await countDb(db), 2);
  assert.equal(online.unconfirmed().length, 0);
  online.dispose();
});

test('P0-1: two offline loads in a row keep every answer, then one normal load uploads both', async () => {
  const kv = createMemoryKv();
  const first = await load(localOnly(), kv, 1_000);
  first.record(attempt(1_001, 'a'));
  await first.flush().catch(() => undefined);
  first.dispose();
  await tick();
  const secondStore = localOnly();
  const second = await load(secondStore, kv, 2_000_000);
  await tick();
  assert.equal(second.localSessions().length, 1, 'the first offline session is still on the device');
  second.record(attempt(2_000_001, 'b'));
  await second.flush().catch(() => undefined);
  assert.equal(await countDb(secondStore), 2, 'the local-only view shows both sessions');
  second.dispose();
  await tick();
  const db = createFakeStore();
  const online = await load(db, kv, 9_000_000);
  await online.flush();
  assert.equal(await countDb(db), 2);
  online.dispose();
});

test('P0-1: a normal load whose flush fails keeps the answers for the next load', async () => {
  const kv = createMemoryKv();
  const offline = await load(localOnly(), kv, 1_000);
  offline.record(attempt(1_001, 'a'));
  offline.dispose();
  await tick();
  const db = createFakeStore();
  db.setOffline(true);
  const failing = await load(db, kv, 50_000);
  await failing.flush().catch(() => undefined);
  assert.equal(failing.unconfirmed().length, 1);
  failing.dispose();
  await tick();
  db.setOffline(false);
  const retry = await load(db, kv, 90_000);
  await retry.flush();
  assert.equal(await countDb(db), 1);
  retry.dispose();
});

test('P0-1: the same answer present in the database and in the queue is stored once', async () => {
  const kv = createMemoryKv();
  const db = createFakeStore();
  const a = await load(db, kv, 1_000);
  a.record(attempt(1_001, 'a'));
  await a.flush();
  const id = a.sessionId;
  // Simulate a confirmation that never reached the queue (tab closed between the write and the bookkeeping).
  const raw = kv.data.get(`session:${id}`) as { writtenRev: number; confirmed: number };
  kv.data.set(`session:${id}`, { ...raw, writtenRev: 0, confirmed: 0 });
  a.dispose();
  await tick();
  const b = await load(db, kv, 2_000);
  await b.flush();
  b.record(attempt(1_001, 'a'));
  await b.flush();
  assert.equal(await countDb(db), 1);
  assert.deepEqual((await db.query({ collection: 'sessions' })).map(d => d.id), [id]);
  b.dispose();
});

test('P2-2: a second tab on the same device leaves the first tab\'s queued session alone (Web Locks)', async () => {
  assert.ok((globalThis as { navigator?: { locks?: unknown } }).navigator?.locks, 'this Node provides navigator.locks');
  const kv = createMemoryKv();
  const db = createFakeStore();
  db.setOffline(true);
  const tabA = await load(db, kv, 1_000);
  tabA.record(attempt(1_001, 'a1'));
  await tabA.flush().catch(() => undefined);
  await tick();
  const tabB = await load(db, kv, 1_500);
  assert.equal(tabB.localSessions().length, 0, 'tab B does not adopt tab A\'s entry');
  tabB.record(attempt(1_501, 'b1'));
  tabA.record(attempt(1_002, 'a2'));
  db.setOffline(false);
  await tabA.flush();
  await tabB.flush();
  await tabB.flush();
  const docs = await db.query<{ attempts: Array<{ puzzleId: string }> }>({ collection: 'sessions' });
  const byId = Object.fromEntries(docs.map(d => [d.id, d.data.attempts.map(a => a.puzzleId)]));
  assert.deepEqual(byId[tabA.sessionId], ['a1', 'a2'], 'tab A\'s newer copy is not rolled back');
  assert.deepEqual(byId[tabB.sessionId], ['b1']);
  tabA.dispose(); tabB.dispose();
  await tick();
  const tabC = await load(db, kv, 2_000);
  assert.equal(tabC.unconfirmed().length, 3, 'a new tab adopts what is left, unconfirmed until its own read-back');
  await tabC.flush();
  assert.equal(tabC.unconfirmed().length, 0, 'the read-back confirms all three');
  tabC.dispose();
});

test('U5: a write that never settles times out, sends nothing more to that document, and loses nothing', async () => {
  const fake = createFakeStore();
  let sets = 0;
  const hung = { ...fake, set: () => { sets++; return new Promise<void>(() => {}); } };
  const kv = createMemoryKv();
  const writer = await createSessionWriter({ store: hung, kv, deviceId: 'dhang01', now: () => 1, debounceMs: 60_000, retryMs: 60_000, writeTimeoutMs: 20, events: null });
  writer.record(attempt(2));
  await assert.rejects(writer.flush(), (e: unknown) => (e as { code?: string }).code === 'timeout');
  await assert.rejects(writer.flush(), (e: unknown) => (e as { code?: string }).code === 'timeout', 'a later flush is not blocked forever: it reports timeout');
  assert.equal(sets, 1, 'no second set while the first is outstanding');
  assert.equal(writer.unconfirmed().length, 1);
  writer.dispose();
  await tick();
  const next = await createSessionWriter({ store: fake, kv, deviceId: 'dhang01', now: () => 5, debounceMs: 60_000, events: null });
  await next.flush();
  assert.equal(next.saveState(), 'saved');
  assert.equal((await fake.query({ collection: 'sessions' })).length, 1);
  next.dispose();
});

test('persistent reflects the KvStore', async () => {
  const kv = { ...createMemoryKv(), persistent: false };
  const writer = await createSessionWriter({ store: createFakeStore(), kv, deviceId: dev(), events: null });
  assert.equal(writer.persistent, false);
  const ok = await createSessionWriter({ store: createFakeStore(), kv: createMemoryKv(), deviceId: dev(), events: null });
  assert.equal(ok.persistent, true);
  writer.dispose(); ok.dispose();
});
function dev() { return 'd' + Math.random().toString(36).slice(2, 10); }
