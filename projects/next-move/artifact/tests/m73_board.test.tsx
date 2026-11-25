/**
 * Version 7.3: the board setting after the review of 7.2 (its points P2-1 to P2-5 and P2-8) and after the reviewer's
 * probes of 7.3 itself (S1 to S5: two devices at once, a change before the first delivery, an unsaved choice the page
 * stopped flagging, a refused choice kept by the browser, a retry that failed in silence). The scenarios are the
 * reviewer's own, turned from "what the page did" into "what the page must do". Invented data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTrainerModel } from '../components/model';
import { BOARD_NOT_SAVED, BOARD_SAVE_AGAIN, BOARD_SAVING, BoardLook } from '../components/Trainer';
import { UI_PREFS_PATH } from '../components/boardTheme';
import { BOARD_CACHE_KEY } from '../src/store/boardCache';
import { createFakeStore, createMemoryKv, type DocData, type Store } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { createDbStore } from '../src/store/dbStore';
import type { PlatformDb } from '../src/store/runtime';
import { ARTIFACT_DIR } from './b3_paths';

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const clock = (start: number, step = 1000) => { let t = start; return () => (t += step); };

async function page(store: Store, deviceId: string, now: () => number) {
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId, events: null as never });
  const model = createTrainerModel({ store, sessions, deviceId, readyTimeoutMs: 2000, now });
  const firstBoard = model.get().board;
  const stop = model.subscribe(() => {});
  return { model, firstBoard, close: () => { stop(); model.dispose(); } };
}
/** What the view says about the board: the look, whether it is an unsaved choice, whether a write is out. */
const boardOf = (p: { model: { get(): { board: string; boardUnsaved: boolean; boardSaving: boolean } } }) => { const v = p.model.get(); return [v.board, v.boardUnsaved, v.boardSaving]; };
/** A browser storage for the test, as the board cache finds it. */
function installStorage() {
  const data = new Map<string, string>();
  const ls = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, String(v)); }, removeItem: (k: string) => { data.delete(k); } };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });
  return { data, restore: () => { delete (globalThis as { localStorage?: unknown }).localStorage; } };
}
/** A store whose write acknowledgements come back `ackMs` after the write has landed and been delivered. */
function slowAcks(inner: Store, ackMs: number): Store {
  return { ...inner, async set(p, d) { await inner.set(p, d); await tick(ackMs); }, async update(p, d) { await inner.update(p, d); await tick(ackMs); } } as Store;
}
/** A store that opens the `prefs/ui` subscription `delayMs` late, or refuses it outright. */
function latePrefs(inner: Store, delayMs: number, refuse = false): Store {
  return {
    ...inner,
    subscribe(path: string, next: never, err?: never) {
      if (path !== UI_PREFS_PATH) return inner.subscribe(path, next, err);
      if (refuse) throw new Error('subscription refused');
      let unsub = () => {};
      const t = setTimeout(() => { unsub = inner.subscribe(path, next, err); }, delayMs);
      return () => { clearTimeout(t); unsub(); };
    },
  } as Store;
}

/**
 * A minimal platform `db` (the shape `src/store/runtime.ts` types), so the page's REAL adapter runs. `failSets` makes
 * the next N `set` calls on one path (optionally only for one board) reject; `log` records every write that reached it.
 */
function platformDb(seed: Record<string, DocData> = {}) {
  const docs = new Map<string, DocData>(Object.entries(seed).map(([k, v]) => [k, structuredClone(v)]));
  const listeners = new Map<string, Set<(s: unknown) => void>>();
  const fail = new Map<string, { n: number; board?: string; code: string }>();
  const meta = { fromCache: false, hasPendingWrites: false };
  const snap = (path: string) => { const d = docs.get(path); return { id: path.slice(path.lastIndexOf('/') + 1), exists: !!d, data: () => (d ? structuredClone(d) : undefined), metadata: meta }; };
  const notify = (path: string) => { for (const fn of listeners.get(path) ?? []) setTimeout(() => fn(snap(path)), 0); };
  const log: string[] = [];
  const refuse = (path: string, verb: string, data: DocData) => {
    const rule = fail.get(path);
    if (!rule || rule.n <= 0 || (rule.board && rule.board !== data.board)) return;
    rule.n--; log.push(`FAIL ${verb} ${String(data.board ?? '')}`);
    throw { code: rule.code, message: 'injected' };
  };
  const doc = (path: string) => ({
    id: path.slice(path.lastIndexOf('/') + 1), path,
    async get() { return snap(path); },
    async set(data: DocData) { await tick(1); refuse(path, 'set', data); docs.set(path, structuredClone(data)); log.push(`set ${String(data.board ?? '')}`); notify(path); },
    async update(data: DocData) {
      await tick(1);
      const old = docs.get(path);
      if (!old) throw { code: 'invalid_argument', message: 'missing' };
      refuse(path, 'update', data);
      docs.set(path, { ...old, ...structuredClone(data) }); log.push(`update ${String(data.board ?? '')}`); notify(path);
    },
    async delete() { docs.delete(path); notify(path); },
    onSnapshot(next: (s: unknown) => void) { const set = listeners.get(path) ?? new Set(); listeners.set(path, set); set.add(next); setTimeout(() => next(snap(path)), 0); return () => { set.delete(next); }; },
  });
  const empty = { docs: [], size: 0, empty: true, metadata: meta };
  const collection = (path: string) => {
    const q = { path, where: () => q, orderBy: () => q, limit: () => q, async get() { return empty; }, onSnapshot(next: (s: unknown) => void) { const t = setTimeout(() => next(empty), 0); return () => clearTimeout(t); }, doc: (id?: string) => doc(`${path}/${id ?? 'x'}`) };
    return q;
  };
  return {
    db: { doc, collection } as unknown as PlatformDb, docs, log,
    failWrites: (path: string, n: number, opts: { board?: string; code?: string } = {}) => fail.set(path, { n, board: opts.board, code: opts.code ?? 'unavailable' }),
  };
}

test('P2-4: no clock is compared: a later change on a device whose clock runs behind still reaches a page that changed the board itself', async () => {
  const store = createFakeStore();
  const laptop = await page(store, 'laptop', clock(2_000_000_000_000)); // 1000 s ahead of the phone
  const phone = await page(store, 'phone', clock(1_999_999_000_000));
  await tick(30);
  try {
    assert.equal(await laptop.model.saveBoard('blue'), true);
    await tick(30);
    assert.equal(phone.model.get().board, 'blue');
    assert.equal(await phone.model.saveBoard('brown'), true);
    await tick(30);
    assert.equal(laptop.model.get().board, 'brown', 'the laptop follows the database once its own change is saved');
    // And the other way round, with the clocks unchanged.
    assert.equal(await laptop.model.saveBoard('green'), true);
    await tick(30);
    assert.equal(phone.model.get().board, 'green');
  } finally { laptop.close(); phone.close(); }
});

test('P2-3: board writes go one at a time, so a retried earlier write cannot land after a later one; the database ends on the last choice', async () => {
  const plat = platformDb();
  const store = createDbStore(plat.db, { retryDelayMs: [60, 60], timeoutMs: 5000 });
  const p = await page(store, 'laptop', clock(1_700_000_000_000));
  await tick(30);
  try {
    plat.failWrites(UI_PREFS_PATH, 1); // the first attempt of the first write fails; the adapter retries it after 60 ms
    const first = p.model.saveBoard('blue');
    await tick(5);
    const second = p.model.saveBoard('brown');
    assert.equal(p.model.get().board, 'brown', 'the page shows the last choice at once');
    assert.equal(await second, true);
    assert.equal(await first, true);
    await tick(40);
    assert.deepEqual(plat.log, ['FAIL set blue', 'set blue', 'update brown'], 'blue is retried and lands first; brown is written after it');
    assert.equal(plat.docs.get(UI_PREFS_PATH)!.board, 'brown');
    assert.equal(p.model.get().board, 'brown');
    const other = await page(createDbStore(plat.db), 'phone', clock(1_700_000_500_000));
    await tick(30);
    assert.equal(other.model.get().board, 'brown', 'another device sees the last choice');
    other.close();
  } finally { p.close(); }
});

test('P2-2: two quick changes, the first refused: both calls resolve with the last choice\'s result, and the board on show is the one stored', async () => {
  const plat = platformDb();
  const store = createDbStore(plat.db, { retryDelayMs: [60, 60], timeoutMs: 5000 });
  const p = await page(store, 'laptop', clock(1_700_000_000_000));
  await tick(30);
  try {
    plat.failWrites(UI_PREFS_PATH, 2, { board: 'blue' }); // both attempts of the blue write fail; brown is untouched
    const order: string[] = [];
    const first = p.model.saveBoard('blue').then(ok => { order.push(`first ${ok}`); });
    await tick(5);
    const second = p.model.saveBoard('brown').then(ok => { order.push(`second ${ok}`); });
    await Promise.all([first, second]);
    assert.deepEqual(order.sort(), ['first true', 'second true'], 'no late "not saved" for a board that was saved');
    assert.equal(plat.docs.get(UI_PREFS_PATH)!.board, 'brown');
    assert.equal(p.model.get().board, 'brown');
  } finally { p.close(); }
});

test('S3 and S5: a refused change stands on this page and is flagged as unsaved; a refused retry is seen going out; a later write by another device is followed', async () => {
  const store = createFakeStore({ seed: { [UI_PREFS_PATH]: { board: 'blue', updatedAt: 5, device: 'phone' } } });
  const p = await page(store, 'laptop', clock(1_700_000_000_000));
  await tick(30);
  try {
    assert.deepEqual(boardOf(p), ['blue', false, false]);
    store.failNextWrites(1, 'unavailable');
    const refused = p.model.saveBoard('brown');
    assert.deepEqual(boardOf(p), ['brown', false, true], 'the board changes at once, and a write is out');
    assert.equal(await refused, false);
    assert.deepEqual(boardOf(p), ['brown', true, false], 'refused: the choice stands and the view says it is unsaved');
    assert.equal((store.dump()[UI_PREFS_PATH] as DocData).board, 'blue', 'the database keeps the earlier choice');
    assert.equal(store.writeCounts.get(UI_PREFS_PATH) ?? 0, 0, 'nothing is sent again by itself');
    // The same document delivered again says nothing new: the choice and its flag stay.
    await store.update(UI_PREFS_PATH, { board: 'blue', updatedAt: 5, device: 'phone' });
    await tick(30);
    assert.deepEqual(boardOf(p), ['brown', true, false]);
    // A retry that is refused again: the view shows the write going out ("Saving…" on the retry), then unsaved again.
    store.failNextWrites(1, 'unavailable');
    const seen: string[] = [];
    const stop = p.model.subscribe(() => { seen.push(boardOf(p).join(' ')); });
    assert.equal(await p.model.saveBoard('brown'), false);
    stop();
    assert.deepEqual(seen, ['brown true true', 'brown true false']);
    // Another device changes the board. That is a later write: the database is followed again and the flag goes.
    await store.update(UI_PREFS_PATH, { board: 'green', updatedAt: 1, device: 'phone' });
    await tick(30);
    assert.deepEqual(boardOf(p), ['green', false, false], 'whatever that device\'s clock says');
    assert.equal((store.dump()[UI_PREFS_PATH] as DocData).board, 'green');
  } finally { p.close(); }
});

test('S5: a retry that goes through clears the flag; the board that was refused is then the stored one', async () => {
  const store = createFakeStore({ seed: { [UI_PREFS_PATH]: { board: 'green', updatedAt: 5, device: 'phone' } } });
  const p = await page(store, 'laptop', clock(1_700_000_000_000));
  await tick(30);
  try {
    store.failNextWrites(1, 'unavailable');
    assert.equal(await p.model.saveBoard('brown'), false);
    assert.deepEqual(boardOf(p), ['brown', true, false]);
    assert.equal(await p.model.saveBoard('brown'), true, 'the retry is the same choice again');
    assert.deepEqual(boardOf(p), ['brown', false, false]);
    assert.equal((store.dump()[UI_PREFS_PATH] as DocData).board, 'brown');
  } finally { p.close(); }
});

test('S3: this page\'s own write that landed although it was reported as refused clears the flag when the database shows it', async () => {
  const store = createFakeStore({ seed: { [UI_PREFS_PATH]: { board: 'green', updatedAt: 5, device: 'phone' } } });
  const p = await page(store, 'laptop', clock(1_700_000_000_000));
  await tick(30);
  try {
    store.failNextWrites(1, 'unavailable');
    assert.equal(await p.model.saveBoard('brown'), false);
    // The write turns up in the database after all (a lost acknowledgement): same board, written as this device.
    await store.update(UI_PREFS_PATH, { board: 'brown', updatedAt: 1_700_000_001_000, device: 'laptop' });
    await tick(30);
    assert.deepEqual(boardOf(p), ['brown', false, false]);
  } finally { p.close(); }
});

test('S1: two devices change the board at almost the same moment: both end on the later write', async () => {
  const store = createFakeStore();
  const laptop = await page(slowAcks(store, 80), 'laptop', clock(1_700_000_000_000));
  const phone = await page(store, 'phone', clock(1_700_000_000_000));
  await tick(30);
  try {
    const a = laptop.model.saveBoard('blue');                  // lands at once, acknowledged 80 ms later
    await tick(20);
    assert.equal(await phone.model.saveBoard('brown'), true);  // lands after the laptop's write: the last choice
    assert.equal(await a, true);
    await tick(60);
    assert.equal((store.dump()[UI_PREFS_PATH] as DocData).board, 'brown', 'the database holds the last choice');
    assert.deepEqual(boardOf(phone), ['brown', false, false]);
    assert.deepEqual(boardOf(laptop), ['brown', false, false], 'the laptop reads the database once its own write is acknowledged');
  } finally { laptop.close(); phone.close(); }
});

test('S1: the read after a saved change trusts only the database: a cached copy older than the write, or a failed read, changes nothing', async () => {
  const stale = { path: UI_PREFS_PATH, id: 'ui', data: { board: 'green', updatedAt: 5, device: 'phone' }, meta: { fromCache: true, hasPendingWrites: false } };
  for (const [name, get] of [['a cached copy', async () => stale], ['a failed read', async () => { throw new Error('offline'); }]] as const) {
    const inner = createFakeStore({ seed: { [UI_PREFS_PATH]: { board: 'green', updatedAt: 5, device: 'phone' } } });
    const store = { ...inner, get: (path: string) => (path === UI_PREFS_PATH ? get() : inner.get(path)) } as Store;
    const p = await page(store, 'laptop', clock(1_700_000_000_000));
    await tick(30);
    try {
      assert.equal(await p.model.saveBoard('brown'), true, name);
      await tick(30);
      assert.deepEqual(boardOf(p), ['brown', false, false], name);
      assert.equal((inner.dump()[UI_PREFS_PATH] as DocData).board, 'brown', name);
    } finally { p.close(); }
  }
});

test('D-4: a read that lags behind this page\'s own write does not bring the old board back', async () => {
  // The write's own delivery arrives before its acknowledgement, so the listener does not apply it; then the one read
  // made after the acknowledgement still returns the document as it was before the write (its fields in another
  // order). That is no later word: the page keeps the board it has just saved.
  const inner = createFakeStore({ seed: { [UI_PREFS_PATH]: { board: 'green', updatedAt: 5, device: 'phone' } } });
  const lagging = { path: UI_PREFS_PATH, id: 'ui', data: { device: 'phone', updatedAt: 5, board: 'green' }, meta: { fromCache: false, hasPendingWrites: false } };
  const slow = slowAcks(inner, 60);
  const store = { ...slow, get: (path: string) => (path === UI_PREFS_PATH ? Promise.resolve(lagging) : slow.get(path)) } as Store;
  const p = await page(store, 'laptop', clock(1_700_000_000_000));
  await tick(30);
  try {
    assert.deepEqual(boardOf(p), ['green', false, false]);
    assert.equal(await p.model.saveBoard('brown'), true);
    await tick(80);
    assert.deepEqual(boardOf(p), ['brown', false, false], 'the saved board stays on show');
    assert.equal((inner.dump()[UI_PREFS_PATH] as DocData).board, 'brown');
  } finally { p.close(); }
});

test('S2: a change made before the first prefs/ui delivery, or with the subscription refused, is merged: no field is wiped', async () => {
  for (const [name, wrap] of [['late delivery', (st: Store) => latePrefs(st, 150)], ['subscription refused', (st: Store) => latePrefs(st, 0, true)]] as const) {
    const store = createFakeStore({ seed: { [UI_PREFS_PATH]: { board: 'blue', updatedAt: 5, device: 'phone', pieces: 'alpha' } } });
    const p = await page(wrap(store), 'laptop', clock(1_700_000_000_000));
    try {
      await tick(20); // the rest of the page has loaded; prefs/ui has not been delivered
      assert.equal(await p.model.saveBoard('brown'), true, name);
      const doc = store.dump()[UI_PREFS_PATH] as DocData;
      assert.deepEqual([doc.board, doc.device, doc.pieces], ['brown', 'laptop', 'alpha'], name);
    } finally { p.close(); }
  }
  // With no document there at all, the merge is refused as "missing" and the document is created, three fields.
  const empty = createFakeStore();
  const q = await page(latePrefs(empty, 150), 'laptop', clock(1_700_000_000_000));
  try {
    await tick(20);
    assert.equal(await q.model.saveBoard('brown'), true);
    assert.deepEqual(Object.keys(empty.dump()[UI_PREFS_PATH]).sort(), ['board', 'device', 'updatedAt']);
  } finally { q.close(); }
});

test('S4: this browser remembers a board only once the database has taken it, so a refused choice does not come back on the next load', async () => {
  const st = installStorage();
  try {
    const store = createFakeStore();
    const p1 = await page(store, 'laptop', clock(1_700_000_000_000));
    await tick(30);
    store.failNextWrites(1, 'unavailable');
    assert.equal(await p1.model.saveBoard('brown'), false);
    assert.equal(st.data.get(BOARD_CACHE_KEY), undefined, 'a refused choice is not cached');
    p1.close();
    const p2 = await page(store, 'laptop', clock(1_700_000_100_000));
    await tick(30);
    assert.deepEqual([p2.firstBoard, ...boardOf(p2)], ['green', 'green', false, false], '"changed on this page only" was true');
    // A choice the database takes is cached, and is the first paint of the next load.
    assert.equal(await p2.model.saveBoard('blue'), true);
    assert.equal(st.data.get(BOARD_CACHE_KEY), 'blue');
    p2.close();
    const p3 = await page(store, 'laptop', clock(1_700_000_200_000));
    assert.equal(p3.firstBoard, 'blue');
    // A refused change on top of it leaves the cache on the saved board.
    await tick(30);
    store.failNextWrites(1, 'unavailable');
    assert.equal(await p3.model.saveBoard('brown'), false);
    assert.equal(st.data.get(BOARD_CACHE_KEY), 'blue');
    // A board another device stored is cached when it arrives.
    await store.update(UI_PREFS_PATH, { board: 'green', updatedAt: 9, device: 'phone' });
    await tick(30);
    assert.equal(st.data.get(BOARD_CACHE_KEY), 'green');
    p3.close();
  } finally { st.restore(); }
});

test('P2-5: a change is merged into prefs/ui, so a field another version keeps there survives; the first change creates exactly the three fields', async () => {
  const seeded = createFakeStore({ seed: { [UI_PREFS_PATH]: { board: 'blue', updatedAt: 5, device: 'phone', pieces: 'alpha', sound: false } } });
  const p = await page(seeded, 'laptop', clock(1_700_000_000_000));
  await tick(30);
  try {
    assert.equal(await p.model.saveBoard('brown'), true);
    const doc = seeded.dump()[UI_PREFS_PATH] as DocData;
    assert.deepEqual(Object.keys(doc).sort(), ['board', 'device', 'pieces', 'sound', 'updatedAt']);
    assert.deepEqual([doc.board, doc.device, doc.pieces, doc.sound], ['brown', 'laptop', 'alpha', false]);
  } finally { p.close(); }
  const empty = createFakeStore();
  const q = await page(empty, 'laptop', clock(1_700_000_000_000));
  await tick(30);
  try {
    assert.equal(await q.model.saveBoard('brown'), true);
    assert.deepEqual(Object.keys(empty.dump()[UI_PREFS_PATH]).sort(), ['board', 'device', 'updatedAt']);
    assert.equal(await q.model.saveBoard('blue'), true);
    assert.equal((empty.dump()[UI_PREFS_PATH] as DocData).board, 'blue');
  } finally { q.close(); }
});

test('P2-5: a document deleted since the last delivery is created again, and the page does not turn read-only for it', async () => {
  const plat = platformDb({ [UI_PREFS_PATH]: { board: 'blue', updatedAt: 5, device: 'phone' } });
  const store = createDbStore(plat.db, { retryDelayMs: [20, 20], timeoutMs: 5000 });
  const p = await page(store, 'laptop', clock(1_700_000_000_000));
  await tick(30);
  try {
    assert.equal(p.model.get().board, 'blue');
    plat.docs.delete(UI_PREFS_PATH); // gone, and no delivery has told this page yet
    assert.equal(await p.model.saveBoard('brown'), true);
    assert.deepEqual(plat.log, ['set brown']);
    assert.equal(plat.docs.get(UI_PREFS_PATH)!.board, 'brown');
    assert.notEqual(store.connection(), 'read-only');
  } finally { p.close(); }
});

test('P2-5: a merge the database refuses for another reason is not turned into a whole-document write', async () => {
  const plat = platformDb({ [UI_PREFS_PATH]: { board: 'blue', updatedAt: 5, device: 'phone', pieces: 'alpha' } });
  const store = createDbStore(plat.db, { retryDelayMs: [20, 20], timeoutMs: 5000 });
  const p = await page(store, 'laptop', clock(1_700_000_000_000));
  await tick(30);
  try {
    plat.failWrites(UI_PREFS_PATH, 2); // both attempts of the merge fail as "unavailable"
    assert.equal(await p.model.saveBoard('brown'), false);
    assert.deepEqual(plat.log, ['FAIL update brown', 'FAIL update brown'], 'no set followed');
    assert.equal(plat.docs.get(UI_PREFS_PATH)!.pieces, 'alpha');
    assert.equal(p.model.get().board, 'brown', 'the choice holds on this page');
  } finally { p.close(); }
});

test('P2-1, P2-2 and S3: the not-saved line is shown only while the board on show is unsaved, on a row of its own, with its retry', () => {
  assert.match(BOARD_NOT_SAVED, /on this page only/);
  assert.doesNotMatch(BOARD_NOT_SAVED, /device/, 'no promise about this device: the next load follows the database');
  // A select does not fire again for the option it already shows, so the line never asks him to "choose it again":
  // it carries a retry of its own (seen working in the browser run, where a write is made to fail once).
  assert.doesNotMatch(BOARD_NOT_SAVED, /again/i);
  assert.deepEqual([BOARD_SAVE_AGAIN, BOARD_SAVING], ['Try saving again', 'Saving…']);
  const saved = renderToStaticMarkup(<BoardLook value="green" onChange={async () => true} where="practice"/>);
  assert.match(saved, /^<div class="board-look"><label for="board-look-practice">Board<\/label><select id="board-look-practice">.*<\/select><\/div>$/, 'the switch is label and control only');
  // Unsaved: the line follows the switch (it is not inside it), with the retry.
  const unsaved = renderToStaticMarkup(<BoardLook value="brown" unsaved onChange={async () => false} where="practice"/>);
  assert.ok(unsaved.endsWith(`</select></div><p class="small board-look-note" role="status">${BOARD_NOT_SAVED} <button type="button" class="text-button">${BOARD_SAVE_AGAIN}</button></p>`), unsaved.slice(-220));
  // While a write is out the retry says so and takes no second press; it keeps its place, and so the focus.
  const retrying = renderToStaticMarkup(<BoardLook value="brown" unsaved saving onChange={async () => false} where="settings"/>);
  assert.ok(retrying.endsWith(`<p class="small board-look-note" role="status">${BOARD_NOT_SAVED} <button type="button" class="text-button" aria-disabled="true">${BOARD_SAVING}</button></p>`), retrying.slice(-220));
  // An ordinary change being written, with nothing unsaved, shows no line.
  assert.doesNotMatch(renderToStaticMarkup(<BoardLook value="brown" saving onChange={async () => true} where="practice"/>), /board-look-note/);
  // The page gives both switches the model's two flags, so they say the same and the line survives a change of tab.
  const trainerSrc = readFileSync(join(ARTIFACT_DIR, 'components/Trainer.tsx'), 'utf8');
  for (const where of ['practice', 'settings']) assert.ok(trainerSrc.includes(`<BoardLook where="${where}" value={view.board} unsaved={view.boardUnsaved} saving={view.boardSaving} onChange={b => model.saveBoard(b)}/>`), where);
  const css = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8');
  assert.match(css, /\.practice-toolbar>\.board-look-note\{flex-basis:100%\}/, 'the note is a row of its own in the toolbar');
  assert.match(css, /\.practice-toolbar \.board-look select\{min-width:110px\}/, 'the control keeps a readable width');
});

test('P2-8: the logo link has a name where its words are hidden', () => {
  const trainer = readFileSync(join(ARTIFACT_DIR, 'components/Trainer.tsx'), 'utf8');
  assert.match(trainer, /<a className="brand" href="#" aria-label="Next Move"/);
});

test('P2-9 (a): part 14 of the stylesheet is layout only: no colour, no token, no comma selector', () => {
  const css = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8');
  const at = css.indexOf('/* ---- Part 14');
  assert.ok(at > 0);
  const part = css.slice(at).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(part, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|var\(|\bwhite\b|\bblack\b|currentColor/i);
  for (const [, sel] of part.matchAll(/([^{}]+)\{[^{}]*\}/g)) assert.doesNotMatch(sel.replace(/@media[^{]*/, ''), /,/, `comma selector: ${sel.trim()}`);
  assert.doesNotMatch(part, /\.text-button\s*\{/);
});
