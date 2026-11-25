import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeStore, createMemoryKv, StoreError, type DocData, type FakeStore, type Store, type StoreDoc } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { createTrainerModel, loadTeach, type TrainerModel } from '../components/model';
import { buildPools, isPunish } from '../components/pools';
import { readTeachMeta, TEACH_META_PATH } from '../src/contract/teachDocs';

// Version 7.1 (brief m31, 4.2): loading `teach/meta` in the model. Invented cards only.

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const FEN = '6k1/5pp1/7p/n7/8/8/5PPP/3R2K1 w - - 0 1';
const card = (id: string, extra: DocData = {}) => ({ id, fen: FEN, moves: ['d1d5'], rating: 1000, themes: ['quiet'], ...extra });
const punish = (id: string, solverWin: number) => card(id, { kind: 'punish', pack: { winAfter: 100 - solverWin } });
const threat = (id: string, extra: DocData = {}) => ({ id, a: 'd1d5', t: ['d5a5'], k: 'capture', sq: 'a5', r: 'undefended', pre: false, ...extra });
const teachDoc = (extra: DocData = {}): DocData => ({
  v: 1, teachVersion: 't20261114-0000aaaa', packVersion: 'v1', at: 1_794_000_000_000,
  cards: [threat('pack-1'), threat('punish-1')],
  held: [{ id: 'punish-2', a: 'd1d5', why: 'not-unique', alt: 'd1d4' }, { id: 'punish-3', a: 'd1d5', why: 'not-held' }],
  ...extra,
});

function seed(): Record<string, DocData> {
  return {
    'settings/main': { rating: 1100, sessionLength: 12, updatedAt: 5, device: 'phone' },
    'pack/meta': { packVersion: 'v1', importedAt: '2026-11-10T00:00:00Z', counts: { cards: 2 }, priors: {}, chunks: { cards: ['v1-cards-00'], special: [], punish: ['v1-punish-00'] }, profile: null },
    'pack/v1-cards-00': { cards: [card('pack-1'), card('pack-2')] },
    'pack/v1-punish-00': { cards: [punish('punish-1', 80), punish('punish-2', 75), punish('punish-3', 90), punish('punish-edge', 60)] },
    'plan/current': { updatedAt: 1, author: 'claude', expires: '2099-01-01T00:00:00Z', focus: [], mix: { bank: 0.5, pack: 0.5, endgame: 0, agent: 0 } },
  };
}

interface Setup { store: FakeStore; model: TrainerModel; done: () => void }
async function setup(extra: Record<string, DocData> = {}, wrap: (s: FakeStore) => Store = s => s, options: { readyTimeoutMs?: number } = {}): Promise<Setup> {
  const store = createFakeStore({ seed: { ...seed(), ...extra } });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'laptop', events: null, debounceMs: 1 });
  const model = createTrainerModel({ store: wrap(store), sessions, deviceId: 'laptop', readyTimeoutMs: options.readyTimeoutMs ?? 2000 });
  await tick(20);
  return { store, model, done: () => { model.dispose(); sessions.dispose(); } };
}
const poolsOf = (model: TrainerModel) => { const v = model.get(); return buildPools({ bank: [], endgames: [], pack: v.pack, personal: v.personal, drills: v.drills, teach: v.teach }); };
const teachErrors = (model: TrainerModel) => model.get().docErrors.filter(e => e.path.startsWith('teach/'));

test('teach model: the document loads into the view and the pools join it', async () => {
  const { model, done } = await setup({ [TEACH_META_PATH]: teachDoc() });
  try {
    const v = model.get();
    assert.equal(v.ready, true);
    assert.equal(v.error, '');
    assert.deepEqual(v.docErrors, []);
    assert.equal(v.teach?.teachVersion, 't20261114-0000aaaa');
    assert.deepEqual([...v.teach!.byId.keys()], ['pack-1', 'punish-1']);
    assert.deepEqual([...v.teach!.held.keys()], ['punish-2', 'punish-3']);
    assert.deepEqual(Object.keys(v.teach!).sort(), ['byId', 'held', 'teachVersion']);
    const p = poolsOf(model);
    assert.deepEqual(p.byId.get('pack-1')?.teach, threat('pack-1'));
    assert.deepEqual(p.byId.get('punish-1')?.teach, threat('punish-1'));
    assert.deepEqual(p.notUnique.map(x => x.id), ['punish-2']);
    assert.deepEqual(p.notHeld.map(x => x.id), ['punish-3']);
    assert.deepEqual(p.own.filter(isPunish).map(x => x.id), ['punish-1']);
    assert.deepEqual(p.punishClasses, { punish: 3, 'small-edge': 1, 'missed-win': 0 });
  } finally { done(); }
});

test('teach model: absent, unreadable, a later format or stale: the pools are version 7\'s', async () => {
  const without = await setup();
  const v7 = poolsOf(without.model);
  assert.equal(without.model.get().teach, null);
  assert.equal(without.model.get().ready, true);
  assert.deepEqual(without.model.get().docErrors, []);
  without.done();
  assert.deepEqual(v7.own.filter(isPunish).map(x => x.id), ['punish-1', 'punish-2', 'punish-3']);

  const states: Array<[string, DocData, boolean, number]> = [
    // name, the stored document, is `view.teach` loaded, docError lines under teach/
    ['unreadable: cards is not a list', teachDoc({ cards: 'nope' }), false, 1],
    ['unreadable: no teachVersion', teachDoc({ teachVersion: undefined as never }), false, 1],
    ['unreadable: v is text', teachDoc({ v: '1' }), false, 1],
    ['a later format', teachDoc({ v: 2 }), false, 0],
    ['a later format with another shape', { v: 3, lessons: { a: 1 } }, false, 0],
    ['stale: every entry is for another answer', teachDoc({ cards: [threat('pack-1', { a: 'd1d4' })], held: [{ id: 'punish-2', a: 'd1d4', why: 'not-unique', alt: 'd1d5' }] }), true, 0],
    ['about cards the pack does not hold', teachDoc({ cards: [threat('pack-9')], held: [{ id: 'punish-9', a: 'd1d5', why: 'not-held' }] }), true, 0],
    ['empty', teachDoc({ cards: [], held: [] }), true, 0],
  ];
  for (const [name, data, loaded, errors] of states) {
    const { model, done } = await setup({ [TEACH_META_PATH]: data });
    try {
      const v = model.get();
      assert.equal(v.ready, true, name);
      assert.equal(v.error, '', `${name}: no banner`);
      assert.equal(v.teach !== null, loaded, name);
      assert.equal(teachErrors(model).length, errors, name);
      assert.equal(v.docErrors.length, errors, `${name}: no other document is blamed`);
      if (errors) { assert.equal(v.docErrors[0].path, TEACH_META_PATH); assert.ok(v.docErrors[0].issue.length > 0 && v.docErrors[0].issue.length <= 300); }
      assert.deepEqual(poolsOf(model), v7, name);
    } finally { done(); }
  }
});

test('teach model: a malformed entry is skipped and counted; the rest of the document is used', async () => {
  const data = teachDoc({ cards: [threat('pack-1'), threat('pack-2', { t: [] }), { id: 'punish-1' }], held: [{ id: 'punish-2', a: 'd1d5', why: 'not-unique', alt: 'd1d4' }, { id: 'punish-3', a: 'not a move', why: 'not-held' }] });
  const { model, done } = await setup({ [TEACH_META_PATH]: data });
  try {
    const v = model.get();
    assert.equal(v.ready, true);
    assert.deepEqual([...v.teach!.byId.keys()], ['pack-1']);
    assert.deepEqual([...v.teach!.held.keys()], ['punish-2']);
    assert.equal(v.docErrors.length, 1, 'one line for the document');
    assert.equal(v.docErrors[0].path, TEACH_META_PATH);
    assert.match(v.docErrors[0].issue, /^3 entries skipped: cards\.1/);
    assert.ok(!/pack-|punish-|d1d5/.test(v.docErrors[0].issue), 'no card id and no move in the issue');
    const p = poolsOf(model);
    assert.deepEqual(p.notUnique.map(x => x.id), ['punish-2']);
    assert.deepEqual(p.notHeld, [], 'the card of the skipped row stays graded');
    assert.deepEqual(p.own.filter(isPunish).map(x => x.id), ['punish-1', 'punish-3']);
    assert.equal(readTeachMeta(data).skipped, 3);
  } finally { done(); }
});

/** A store whose `teach/meta` subscription is driven by the test; every other call goes to the fake store. */
function held(store: FakeStore) {
  const hook: { next?: (doc: StoreDoc | null) => void; error?: (e: StoreError) => void; subscribed: number; unsubscribed: number } = { subscribed: 0, unsubscribed: 0 };
  const wrapped: Store = {
    ...store,
    subscribe(path: string, next: (doc: StoreDoc | null, meta: { fromCache: boolean; hasPendingWrites: boolean }) => void, error?: (e: StoreError) => void) {
      if (path !== TEACH_META_PATH) return store.subscribe(path, next as never, error);
      hook.subscribed++;
      hook.next = doc => next(doc, { fromCache: false, hasPendingWrites: false });
      hook.error = error;
      return () => { hook.unsubscribed++; };
    },
  } as Store;
  return { wrapped, hook };
}

test('teach model: ready waits for the first delivery of the document, present or absent', async () => {
  for (const present of [true, false]) {
    let hook!: ReturnType<typeof held>['hook'];
    const { model, done } = await setup({}, s => { const h = held(s); hook = h.hook; return h.wrapped; });
    try {
      // Everything else has arrived; the page still waits, so that held cards are known before the first card.
      assert.equal(model.get().ready, false);
      assert.ok(model.get().pack, 'the pack is loaded');
      assert.equal(model.get().teach, null);
      assert.equal(hook.subscribed, 1);
      hook.next!(present ? { path: TEACH_META_PATH, id: 'meta', data: teachDoc() } : null);
      assert.equal(model.get().ready, true);
      assert.equal(model.get().teach !== null, present);
      assert.deepEqual(model.get().docErrors, []);
    } finally { done(); }
  }
});

test('teach model: an erroring subscription does not block ready, shows no banner and no error line', async () => {
  let hook!: ReturnType<typeof held>['hook'];
  const { model, done } = await setup({ [TEACH_META_PATH]: teachDoc() }, s => { const h = held(s); hook = h.hook; return h.wrapped; });
  try {
    assert.equal(model.get().ready, false);
    hook.error!(new StoreError('not_granted', 'The collection cannot be read.'));
    const v = model.get();
    assert.equal(v.ready, true);
    assert.equal(v.teach, null);
    assert.equal(v.error, '', 'no banner');
    assert.deepEqual(v.docErrors, []);
    assert.deepEqual(poolsOf(model).own.filter(isPunish).map(x => x.id), ['punish-1', 'punish-2', 'punish-3'], 'as version 7');
  } finally { done(); }
  // An error after a good delivery keeps what was read: the pools do not flip back in the middle of a session.
  const again = await setup({}, s => { const h = held(s); hook = h.hook; return h.wrapped; });
  try {
    hook.next!({ path: TEACH_META_PATH, id: 'meta', data: teachDoc() });
    const loaded = again.model.get().teach;
    assert.ok(loaded);
    hook.error!(new StoreError('unavailable', 'Lost the connection.'));
    assert.equal(again.model.get().teach, loaded);
    assert.equal(again.model.get().error, '');
    assert.equal(again.model.get().ready, true);
  } finally { again.done(); }
});

test('teach model: a store that throws on the subscription itself does not stop the page', async () => {
  // The first read in a collection outside the contract's list: a store that refuses the path outright is an error
  // like any other. The page starts, is ready, and behaves as version 7.
  const refusing = (store: FakeStore): Store => ({
    ...store,
    subscribe(path: string, next: (doc: StoreDoc | null, meta: { fromCache: boolean; hasPendingWrites: boolean }) => void, error?: (e: StoreError) => void) {
      if (path === TEACH_META_PATH) throw new TypeError(`Invalid db path: ${path}`);
      return store.subscribe(path, next as never, error);
    },
  } as Store);
  const { model, done } = await setup({ [TEACH_META_PATH]: teachDoc() }, refusing);
  try {
    const v = model.get();
    assert.equal(v.ready, true);
    assert.equal(v.teach, null);
    assert.equal(v.error, '', 'no banner');
    assert.deepEqual(v.docErrors, []);
    assert.ok(v.pack, 'everything else loaded');
    assert.deepEqual(poolsOf(model).own.filter(isPunish).map(x => x.id), ['punish-1', 'punish-2', 'punish-3'], 'as version 7');
  } finally { done(); }
});

test('teach model: a silent subscription is freed by the load timer, as every other one is', async () => {
  const { model, done } = await setup({}, s => held(s).wrapped, { readyTimeoutMs: 60 });
  try {
    assert.equal(model.get().ready, false);
    await tick(90);
    assert.equal(model.get().ready, true);
    assert.equal(model.get().teach, null);
  } finally { done(); }
});

test('teach model: the loaded object is the same until the stored document changes', async () => {
  let hook!: ReturnType<typeof held>['hook'];
  const { model, store, done } = await setup({}, s => { const h = held(s); hook = h.hook; return h.wrapped; });
  try {
    const deliver = (data: DocData | null) => hook.next!(data ? { path: TEACH_META_PATH, id: 'meta', data } : null);
    deliver(teachDoc());
    const first = model.get().teach;
    assert.ok(first);
    // Other documents change and the view is rebuilt: the same object, so a memo on it does not rerun.
    await store.set('notes/n1', { text: 'Hello.', createdAt: 1 });
    await tick(20);
    assert.equal(model.get().notes.length, 1);
    assert.equal(model.get().teach, first);
    // The same body delivered again (a cached copy, then the server's): still the same object.
    deliver(JSON.parse(JSON.stringify(teachDoc())));
    assert.equal(model.get().teach, first);
    // A changed body, even under the same version name, is loaded anew.
    deliver(teachDoc({ held: [] }));
    const second = model.get().teach;
    assert.notEqual(second, first);
    assert.equal(second!.held.size, 0);
    // Unreadable: null and one line; readable again: the line goes.
    deliver(teachDoc({ cards: 5 }));
    assert.equal(model.get().teach, null);
    assert.equal(teachErrors(model).length, 1);
    deliver(teachDoc());
    assert.ok(model.get().teach);
    assert.deepEqual(model.get().docErrors, []);
    // Deleted: null, no line.
    deliver(null);
    assert.equal(model.get().teach, null);
    assert.deepEqual(model.get().docErrors, []);
  } finally { done(); }
  assert.deepEqual([hook.subscribed, hook.unsubscribed], [1, 1], 'one subscription, closed on dispose');
});

test('teach model: a document written while the page is open arrives through the subscription', async () => {
  const { model, store, done } = await setup();
  try {
    assert.equal(model.get().teach, null);
    await store.set(TEACH_META_PATH, teachDoc());
    await tick(20);
    assert.equal(model.get().teach?.held.size, 2);
    assert.deepEqual(poolsOf(model).notUnique.map(x => x.id), ['punish-2']);
    await store.delete(TEACH_META_PATH);
    await tick(20);
    assert.equal(model.get().teach, null);
    assert.deepEqual(poolsOf(model).notUnique, []);
  } finally { done(); }
});

test('teach model: one read under teach/ and no write there, whatever the page does', async () => {
  const reads: string[] = [];
  const counting = (s: FakeStore): Store => ({
    ...s,
    get: (path: string) => { reads.push(`get ${path}`); return s.get(path); },
    query: (spec: { collection: string }) => { reads.push(`query ${spec.collection}`); return s.query(spec as never); },
    subscribe: (path: string, next: never, error?: never) => { reads.push(`subscribe ${path}`); return s.subscribe(path, next, error); },
    subscribeQuery: (spec: { collection: string }, next: never, error?: never) => { reads.push(`subscribeQuery ${spec.collection}`); return s.subscribeQuery(spec as never, next, error); },
  } as Store);
  for (const withDoc of [false, true]) {
    reads.length = 0;
    const { model, store, done } = await setup(withDoc ? { [TEACH_META_PATH]: teachDoc() } : {}, counting);
    try {
      assert.equal(model.get().ready, true);
      // The page's own writes: an answer, settings, feedback.
      model.record({ puzzleId: 'pack-1', themes: ['quiet'], correct: true, unassisted: true, hints: 0, revealed: false, durationMs: 900, at: 10 });
      assert.equal(await model.saveSettings({ rating: 1150 }), true);
      assert.equal(await model.sendFeedback({ kind: 'comment', item: { id: 'pack-1', source: 'pack', themes: ['quiet'], fen: FEN }, text: 'A note.' }), true);
      await tick(30);
      const underTeach = reads.filter(r => / teach(\/|$)/.test(r));
      assert.deepEqual(underTeach, [`subscribe ${TEACH_META_PATH}`], 'exactly one read: the subscription to the one document');
      assert.ok(!reads.some(r => r === 'query teach' || r === 'subscribeQuery teach'), 'the collection is never listed');
      const written = [...store.writeCounts.keys()];
      assert.ok(written.length >= 2, 'the page did write its own documents');
      assert.ok(!written.some(p => p.startsWith('teach/')), `wrote ${written.filter(p => p.startsWith('teach/'))}`);
      assert.deepEqual(Object.keys(store.dump()).filter(p => p.startsWith('teach/')), withDoc ? [TEACH_META_PATH] : []);
      if (withDoc) assert.deepEqual(store.dump()[TEACH_META_PATH], teachDoc(), 'the stored document is untouched');
    } finally { done(); }
  }
});

test('loadTeach: maps by card id from a read; null unless the document was read', () => {
  assert.equal(loadTeach(readTeachMeta(null)), null);
  assert.equal(loadTeach(readTeachMeta({ v: 2 })), null);
  assert.equal(loadTeach(readTeachMeta({ v: 1 })), null);
  const t = loadTeach(readTeachMeta(teachDoc()))!;
  assert.deepEqual(t.byId.get('punish-1'), threat('punish-1'));
  assert.deepEqual(t.held.get('punish-3'), { id: 'punish-3', a: 'd1d5', why: 'not-held' });
  assert.equal(t.byId.get('punish-2'), undefined);
});
