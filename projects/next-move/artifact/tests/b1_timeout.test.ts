/**
 * Review 2 re-check F1/S10 and F2: a timed-out write is "unknown", never a loss.
 * Invariant under test everywhere: an answer leaves the device only after the database
 * acknowledged a write containing it (or a read-back shows it), and `saveState() === 'saved'` only
 * when every recorded answer is in the database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryKv, createFakeStore, type KvStore } from '../src/contract/store';
import { createDbStore } from '../src/store/dbStore';
import { createSessionWriter } from '../src/store/sessionWriter';
import type { PlatformDb, PlatformDocRef } from '../src/store/runtime';

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const attempt = (at: number, puzzleId: string) => ({ puzzleId, themes: ['fork'], correct: true, unassisted: true, hints: 0, revealed: false, durationMs: 1000, at, source: 'bank' as const });

type Plan = 'ok' | { failAfter: number; code: string } | { landAfter: number } | 'never';
/** A platform db whose `set` calls follow a queue of plans; everything else succeeds at once. */
function scriptedDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const plans: Plan[] = [];
  let sets = 0;
  const doc = (path: string): PlatformDocRef => ({
    id: path.split('/').pop()!, path,
    get: async () => ({ id: path.split('/').pop()!, exists: docs.has(path), data: () => docs.get(path), metadata: { fromCache: false, hasPendingWrites: false } }),
    set: (d: Record<string, unknown>) => {
      sets++;
      const body = JSON.parse(JSON.stringify(d));
      const plan = plans.shift() ?? 'ok';
      if (plan === 'ok') return Promise.resolve().then(() => { docs.set(path, body); });
      if (plan === 'never') return new Promise<void>(() => {});
      if ('failAfter' in plan) return new Promise<void>((_, reject) => setTimeout(() => reject({ code: plan.code, message: 'dropped' }), plan.failAfter));
      return new Promise<void>(resolve => setTimeout(() => { docs.set(path, body); resolve(); }, plan.landAfter));
    },
    update: async () => { throw { code: 'invalid_argument', message: 'unused' }; },
    delete: async () => { docs.delete(path); },
    onSnapshot: () => () => {},
  });
  const db = { doc, collection: () => { throw new Error('unused'); } } as unknown as PlatformDb;
  const stored = () => [...docs.values()].flatMap(d => (d.attempts as Array<{ puzzleId: string }>).map(a => a.puzzleId)).sort();
  return { db, docs, plans, stored, sets: () => sets };
}

/** Wire a writer to a scripted db, and check the "Saved" invariant on every state change. */
let deviceSeq = 0;
/** Each test gets its own device id, so a test that fails before dispose() cannot hold another test's Web Lock. */
async function setup(kv: KvStore = createMemoryKv(), s = scriptedDb(), now = () => 1_000, deviceId = `dto${String(++deviceSeq).padStart(4, '0')}`) {
  const store = createDbStore(s.db, { timeoutMs: 50, retryDelayMs: [1, 2] });
  const recorded = new Set<string>();
  const violations: string[] = [];
  const writer = await createSessionWriter({ store, kv, deviceId, now, debounceMs: 60_000, retryMs: 60_000, writeTimeoutMs: 20, events: null });
  writer.onSaveState(state => {
    if (state !== 'saved') return;
    const have = new Set(s.stored());
    for (const id of recorded) if (!have.has(id)) violations.push(`"saved" while ${id} is not in the database`);
  });
  const record = (at: number, id: string) => { recorded.add(id); writer.record(attempt(at, id)); };
  return { s, store, writer, record, violations, kv };
}

test('F1 exact: a write that times out and then fails is not re-sent over a newer write; nothing is lost', async () => {
  const { s, writer, record, violations } = await setup();
  s.plans.push({ failAfter: 50, code: 'unavailable' });
  record(1_001, 'p1');
  await assert.rejects(writer.flush(), (e: unknown) => (e as { code?: string }).code === 'timeout');
  assert.equal(writer.unconfirmed().length, 1, 'a timeout confirms nothing');
  record(1_002, 'p2');
  await writer.flush().catch(() => undefined); // must not start a second write while the first is out
  await tick(100);
  await writer.flush();
  await tick(20);
  assert.deepEqual(s.stored(), ['p1', 'p2']);
  assert.equal(writer.unconfirmed().length, 0);
  assert.equal(writer.saveState(), 'saved');
  assert.deepEqual(violations, []);
  writer.dispose();
});

test('timeout, then the first write lands: it counts as confirmed and is not written twice', async () => {
  const { s, writer, record, violations } = await setup();
  s.plans.push({ landAfter: 50 });
  record(1_001, 'p1');
  await assert.rejects(writer.flush());
  await tick(80);
  assert.equal(writer.unconfirmed().length, 0, 'the late acknowledgement confirms p1');
  await writer.flush();
  assert.equal(s.sets(), 1);
  assert.deepEqual(s.stored(), ['p1']);
  assert.equal(writer.saveState(), 'saved');
  assert.deepEqual(violations, []);
  writer.dispose();
});

test('timeout, an answer during the outage, then the first write lands: the newer body follows it', async () => {
  const { s, writer, record, violations } = await setup();
  s.plans.push({ landAfter: 50 });
  record(1_001, 'p1');
  await assert.rejects(writer.flush());
  record(1_002, 'p2');
  await writer.flush().catch(() => undefined);
  assert.equal(s.sets(), 1, 'no second write while the first is outstanding');
  await tick(80);
  await writer.flush();
  assert.deepEqual(s.stored(), ['p1', 'p2']);
  assert.equal(writer.saveState(), 'saved');
  assert.deepEqual(violations, []);
  writer.dispose();
});

test('timeout, then the first write never lands (fails twice): the answers are re-sent and stored once', async () => {
  const { s, writer, record, violations } = await setup();
  s.plans.push({ failAfter: 40, code: 'unavailable' }, { failAfter: 0, code: 'unavailable' }); // the adapter retries once
  record(1_001, 'p1');
  await assert.rejects(writer.flush());
  await tick(80); // the failure settles the outstanding write, and the queue is re-sent at once
  await writer.flush();
  assert.deepEqual(s.stored(), ['p1']);
  assert.equal(s.sets(), 3, 'first write, the adapter\'s single retry, then one re-send');
  assert.equal(writer.unconfirmed().length, 0);
  assert.equal(writer.saveState(), 'saved');
  assert.deepEqual(violations, []);
  writer.dispose();
});

test('timeout during the last write before the page closes: the next load uploads the answers', async () => {
  const kv = createMemoryKv();
  const first = await setup(kv);
  first.s.plans.push('never');
  first.record(1_001, 'p1');
  first.record(1_002, 'p2');
  await assert.rejects(first.writer.flush());
  first.writer.dispose();
  await tick();
  const second = await setup(kv, scriptedDb(), () => 5_000);
  await second.writer.flush();
  assert.deepEqual(second.s.stored(), ['p1', 'p2']);
  assert.equal(second.writer.saveState(), 'saved');
  second.writer.dispose();
});

test('repeated timeouts: no extra writes pile up, "Saved" never shows, every answer survives a reload', async () => {
  const kv = createMemoryKv();
  const first = await setup(kv);
  first.s.plans.push('never');
  for (let i = 0; i < 3; i++) {
    first.record(1_001 + i, `p${i}`);
    await assert.rejects(first.writer.flush());
    assert.notEqual(first.writer.saveState(), 'saved');
  }
  assert.equal(first.s.sets(), 1);
  assert.equal(first.writer.unconfirmed().length, 3);
  first.writer.dispose();
  await tick();
  const second = await setup(kv, scriptedDb(), () => 9_000);
  await second.writer.flush();
  assert.deepEqual(second.s.stored(), ['p0', 'p1', 'p2']);
  assert.deepEqual(second.violations, []);
  second.writer.dispose();
});

test('read-back: an acknowledged session later found missing from the database is re-sent, not pruned', async () => {
  const kv = createMemoryKv();
  const first = await setup(kv);
  first.record(1_001, 'p1');
  await first.writer.flush();
  first.writer.dispose();
  await tick();
  // A stale write from the closed page lands after the confirmation and rolls the document back.
  for (const [k, v] of first.s.docs) first.s.docs.set(k, { ...v, attempts: [] });
  const nextDay = await setup(kv, first.s, () => 1_000 + 2 * 86_400_000);
  await nextDay.writer.flush();
  await tick();
  assert.deepEqual(first.s.stored(), ['p1']);
  assert.equal(kv instanceof Object && (await kv.keys('session:')).length, 0, 'pruned only after the read-back shows it stored');
  nextDay.writer.dispose();
});

test('F2 fallback without Web Locks: a second tab neither adopts nor continues a live tab\'s session', async () => {
  const kv = createMemoryKv();
  const store = createFakeStore();
  store.setOffline(true);
  let clock = 1_000;
  const opts = { store, kv, now: () => clock, debounceMs: 60_000, retryMs: 60_000, events: null, locks: null, heartbeatMs: 10_000 };
  const tabA = await createSessionWriter({ ...opts, deviceId: 'dtab001' });
  tabA.record(attempt(1_001, 'p1'));
  await tabA.flush().catch(() => undefined);
  clock = 6_000; // 5 s later: tab A is alive
  const tabB = await createSessionWriter({ ...opts, deviceId: 'dtab001' });
  assert.equal(tabB.localSessions().length, 0, 'B leaves A\'s entry alone');
  tabB.record(attempt(6_001, 'p3'));
  tabA.record(attempt(6_002, 'p2'));
  store.setOffline(false);
  await tabA.flush();
  await tabB.flush();
  const docs = await store.query<{ attempts: Array<{ puzzleId: string }> }>({ collection: 'sessions' });
  assert.equal(docs.length, 2, 'two documents, one per tab');
  assert.deepEqual(docs.flatMap(d => d.data.attempts.map(a => a.puzzleId)).sort(), ['p1', 'p2', 'p3']);
  tabA.dispose(); tabB.dispose();
  // A tab that died with a queue is adopted once its heartbeat is 30 s old.
  const kv2 = createMemoryKv();
  const store2 = createFakeStore();
  store2.setOffline(true);
  clock = 100_000;
  const dead = await createSessionWriter({ ...opts, store: store2, kv: kv2, deviceId: 'dtab002' });
  dead.record(attempt(100_001, 'q1'));
  await dead.flush().catch(() => undefined);
  dead.dispose();
  store2.setOffline(false);
  clock = 115_000;
  const early = await createSessionWriter({ ...opts, store: store2, kv: kv2, deviceId: 'dtab002' });
  assert.equal(early.unconfirmed().length, 0, 'not adopted while the heartbeat is fresh');
  early.dispose();
  clock = 140_000;
  const later = await createSessionWriter({ ...opts, store: store2, kv: kv2, deviceId: 'dtab002' });
  await later.flush();
  assert.deepEqual((await store2.query<{ attempts: Array<{ puzzleId: string }> }>({ collection: 'sessions' })).flatMap(d => d.data.attempts.map(a => a.puzzleId)), ['q1']);
  later.dispose();
});

test('a late duplicate of an OLDER version landing after a confirmed newer write is repaired by the next write (merge by answer id)', async () => {
  const { s, writer, record, violations } = await setup();
  record(1_001, 'p1');
  await writer.flush();
  const [path] = [...s.docs.keys()];
  const older = JSON.parse(JSON.stringify(s.docs.get(path)));
  record(1_002, 'p2');
  await writer.flush();
  assert.deepEqual(s.stored(), ['p1', 'p2']);
  s.docs.set(path, older); // the platform delivers a stale copy of the first write late
  assert.deepEqual(s.stored(), ['p1']);
  record(1_003, 'p3');
  await writer.flush();
  assert.deepEqual(s.stored(), ['p1', 'p2', 'p3'], 'today\'s record keeps every answer on the device and re-sends the union');
  assert.deepEqual(violations, []);
  writer.dispose();
});

test('the next load reads today\'s record back and restores answers a stale write removed', async () => {
  const kv = createMemoryKv();
  const first = await setup(kv);
  first.record(1_001, 'p1');
  first.record(1_002, 'p2');
  await first.writer.flush();
  first.writer.dispose();
  await tick();
  const [path] = [...first.s.docs.keys()];
  first.s.docs.set(path, { ...first.s.docs.get(path), attempts: (first.s.docs.get(path)!.attempts as unknown[]).slice(0, 1) });
  const again = await setup(kv, first.s, () => 2_000);
  assert.equal(again.writer.unconfirmed().length, 2, 'nothing counts as confirmed until this load reads it back');
  await again.writer.flush();
  assert.deepEqual(first.s.stored(), ['p1', 'p2']);
  assert.equal(again.writer.saveState(), 'saved');
  again.writer.dispose();
});

test('a write never drops answers already stored in the record (union with the read-back)', async () => {
  const s = scriptedDb();
  const kv = createMemoryKv();
  const w = await setup(kv, s);
  w.record(1_001, 'p1');
  await w.writer.flush();
  const [path] = [...s.docs.keys()];
  // An answer stored in this record that the device no longer holds (another copy of this load wrote it).
  const extra = { ...attempt(1_000, 'p0') };
  s.docs.set(path, { ...s.docs.get(path), attempts: [extra, ...(s.docs.get(path)!.attempts as unknown[])] });
  w.record(1_002, 'p2');
  await w.writer.flush();
  assert.deepEqual(s.stored(), ['p0', 'p1', 'p2']);
  w.writer.dispose();
});

test('IndexedDB refusing the queue reports device-full and persistent=false', async () => {
  const base = createMemoryKv();
  let refuse = false;
  const kv = { ...base, set: async (k: string, v: unknown) => { if (refuse) throw new Error('QuotaExceededError'); return base.set(k, v); } };
  const fake = createFakeStore();
  fake.setOffline(true);
  const states: string[] = [];
  const writer = await createSessionWriter({ store: fake, kv, deviceId: 'dfull01', now: () => 1, debounceMs: 60_000, retryMs: 60_000, events: null });
  writer.onSaveState(st => states.push(st));
  assert.equal(writer.persistent, true);
  refuse = true;
  writer.record(attempt(2, 'p1'));
  await tick(10);
  assert.equal(writer.saveState(), 'device-full');
  assert.equal(writer.persistent, false);
  assert.ok(states.includes('device-full'));
  writer.dispose();
});

test('salvage after an invalid answer does not store an already-stored answer a second time', async () => {
  const s = scriptedDb();
  const kv = createMemoryKv();
  const w = await setup(kv, s);
  w.record(1_001, 'p1');
  await w.writer.flush();
  const id = w.writer.sessionId;
  w.writer.dispose();
  await tick();
  // The queue copy gains an invalid answer next to the stored one and a new valid one.
  const raw = kv.data.get(`session:${id}`) as { doc: { attempts: unknown[] }; rev: number };
  raw.doc.attempts.push({ ...attempt(1_002, 'bad'), puzzleId: '' }, attempt(1_003, 'p2'));
  raw.rev += 2;
  kv.data.set(`session:${id}`, raw);
  const again = await setup(kv, s, () => 2_000);
  await again.writer.flush().catch(() => undefined);
  await tick(20);
  await again.writer.flush().catch(() => undefined);
  const all = s.stored();
  assert.deepEqual([...new Set(all)].sort(), ['p1', 'p2']);
  assert.equal(all.length, 2, 'p1 is stored once');
  assert.equal(again.writer.saveState(), 'set-aside');
  again.writer.dispose();
});

test('re-check 2: a read served from cache (or with a pending write) never confirms an answer', async () => {
  // A client that serves its own rejected write back from cache, as db.d.ts allows for unconfirmed views.
  const server = new Map<string, Record<string, unknown>>();
  const cache = new Map<string, Record<string, unknown>>();
  let accept = false;
  const doc = (path: string): PlatformDocRef => ({
    id: path.split('/').pop()!, path,
    get: async () => {
      const fromServer = accept && server.has(path);
      const body = fromServer ? server.get(path) : cache.get(path);
      return { id: path.split('/').pop()!, exists: !!body, data: () => body, metadata: { fromCache: !fromServer, hasPendingWrites: !fromServer && cache.has(path) } };
    },
    set: async (d: Record<string, unknown>) => {
      const body = JSON.parse(JSON.stringify(d));
      cache.set(path, body);
      if (!accept) throw { code: 'unavailable', message: 'offline' };
      server.set(path, body);
    },
    update: async () => { throw { code: 'invalid_argument', message: 'unused' }; },
    delete: async () => { server.delete(path); cache.delete(path); },
    onSnapshot: () => () => {},
  });
  const db = { doc, collection: () => { throw new Error('unused'); } } as unknown as PlatformDb;
  const store = createDbStore(db, { timeoutMs: 50, retryDelayMs: [1, 2] });
  const writer = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'dcache01', now: () => 1, debounceMs: 60_000, retryMs: 60_000, writeTimeoutMs: 1_000, events: null });
  const states: string[] = [];
  writer.onSaveState(st => states.push(st));
  writer.record(attempt(2, 'p1'));
  await writer.flush().catch(() => undefined);
  await writer.flush().catch(() => undefined); // its pre-read now sees the cached copy of the rejected write
  assert.equal(writer.unconfirmed().length, 1, 'the cached copy confirmed nothing');
  assert.ok(!states.includes('saved'));
  assert.equal(server.size, 0);
  accept = true;
  await writer.flush();
  assert.equal(writer.unconfirmed().length, 0);
  assert.equal(writer.saveState(), 'saved');
  assert.equal(server.size, 1);
  writer.dispose();
});

test('re-check 2: without Web Locks, a reload within 30 s of closing does not say "saved" while the closed tab\'s answers wait', async () => {
  const kv = createMemoryKv();
  const store = createFakeStore();
  let clock = 1_000;
  const opts = { store, kv, now: () => clock, debounceMs: 60_000, retryMs: 60_000, events: null, locks: null, heartbeatMs: 10_000 };
  store.setOffline(true);
  const closed = await createSessionWriter({ ...opts, deviceId: 'dre0001' });
  closed.record(attempt(1_001, 'p1'));
  await closed.flush().catch(() => undefined);
  closed.dispose(); // the tab closes with p1 unconfirmed
  store.setOffline(false);
  clock = 6_000; // reload 5 s later: the closed tab's heartbeat still looks fresh
  const reload = await createSessionWriter({ ...opts, deviceId: 'dre0001' });
  const states: string[] = [];
  reload.onSaveState(st => states.push(st));
  reload.record(attempt(6_001, 'p2'));
  await reload.flush();
  assert.equal(reload.saveState(), 'pending', 'p1 is still waiting on this device');
  assert.ok(!states.includes('saved'));
  clock = 45_000; // the old heartbeat is now stale
  await reload.flush();
  const stored = (await store.query<{ attempts: Array<{ puzzleId: string }> }>({ collection: 'sessions' })).flatMap(d => d.data.attempts.map(a => a.puzzleId)).sort();
  assert.deepEqual(stored, ['p1', 'p2']);
  assert.equal(reload.saveState(), 'saved');
  reload.dispose();
});
