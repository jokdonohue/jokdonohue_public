/**
 * Version 7.2: the board look (`components/boardTheme.ts`, parts 4b and 14 of the stylesheet, the model's `board`
 * and `saveBoard`, the switch). Invented data only. Version 7.3 reworked how a change is written and followed after the
 * review of 7.2: those cases are in `tests/m73_board.test.tsx`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { BOARD_THEMES, DEFAULT_BOARD_THEME, UI_PREFS_PATH, boardFromPrefs, boardThemeFrom, isBoardTheme, prefsBody } from '../components/boardTheme';
import { BOARD_CACHE_KEY, cacheBoardTheme, cachedBoardTheme } from '../src/store/boardCache';
import { createTrainerModel } from '../components/model';
import { BoardLook } from '../components/Trainer';
import { COLLECTIONS, schemaForPath } from '../src/contract/docs';
import { createFakeStore, createMemoryKv, type DocData } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { ARTIFACT_DIR } from './b3_paths';

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const css = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tokensIn = (body: string) => new Map([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)].map(m => [m[1], m[2].trim()]));

async function setup(seed: Record<string, DocData> = {}) {
  const store = createFakeStore({ seed });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'laptop', events: null as never });
  const model = createTrainerModel({ store, sessions, deviceId: 'laptop', readyTimeoutMs: 2000, now: (() => { let t = 1_795_000_000_000; return () => (t += 1000); })() });
  const stop = model.subscribe(() => {});
  await tick(30);
  return { store, model, done: () => { stop(); model.dispose(); } };
}

test('three boards; green is the default; an unknown or missing name gives the default', () => {
  assert.deepEqual(BOARD_THEMES.map(t => t.id), ['green', 'blue', 'brown']);
  assert.equal(DEFAULT_BOARD_THEME, 'green');
  for (const t of BOARD_THEMES) { assert.ok(isBoardTheme(t.id)); assert.equal(boardThemeFrom(t.id), t.id); assert.match(t.label, /^[A-Z][a-z]+$/); }
  for (const bad of [undefined, null, '', 'Green', 'purple', 3, {}, ['green']]) { assert.equal(isBoardTheme(bad), false); assert.equal(boardThemeFrom(bad), 'green'); }
});

test('prefs/ui is read tolerantly: only a board this version knows is taken', () => {
  assert.equal(boardFromPrefs({ board: 'blue', updatedAt: 1, device: 'd' }), 'blue');
  assert.equal(boardFromPrefs({ board: 'brown', somethingNew: true }), 'brown');
  for (const bad of [undefined, null, 'blue', 7, [], {}, { board: 'neon' }, { board: 5 }, { Board: 'blue' }]) assert.equal(boardFromPrefs(bad), null);
  assert.deepEqual(prefsBody('brown', 42, 'phone'), { board: 'brown', updatedAt: 42, device: 'phone' });
});

test('the browser cache never throws and takes only known boards', () => {
  const data = new Map<string, string>();
  const ok = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
  assert.equal(cachedBoardTheme(ok), null);
  cacheBoardTheme('blue', ok);
  assert.equal(data.get(BOARD_CACHE_KEY), 'blue');
  assert.equal(cachedBoardTheme(ok), 'blue');
  data.set(BOARD_CACHE_KEY, 'neon');
  assert.equal(cachedBoardTheme(ok), null);
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(cachedBoardTheme(blocked), null);
  assert.doesNotThrow(() => cacheBoardTheme('brown', blocked));
  assert.equal(cachedBoardTheme(null), null);
  assert.doesNotThrow(() => cacheBoardTheme('brown', null));
});

test('prefs is a collection of its own: outside the contract list, with no contract schema', () => {
  assert.ok(!(Object.values(COLLECTIONS) as string[]).includes('prefs'));
  assert.equal(schemaForPath(UI_PREFS_PATH), null);
  assert.equal(UI_PREFS_PATH, 'prefs/ui');
});

test('the model: green with an empty database, and nothing is written until he changes the board', async () => {
  const { store, model, done } = await setup();
  try {
    assert.equal(model.get().board, 'green');
    assert.equal(await model.saveSettings({ rating: 1200 }), true);
    await tick(20);
    assert.equal(store.writeCounts.get(UI_PREFS_PATH) ?? 0, 0, 'a settings save does not touch prefs/ui');
    assert.equal((store.dump()['settings/main'] as DocData).board, undefined, 'the board is not a settings field');
  } finally { done(); }
});

test('the model: a stored board is shown; an unknown stored name leaves the default', async () => {
  const a = await setup({ [UI_PREFS_PATH]: { board: 'blue', updatedAt: 5, device: 'phone' } });
  try { assert.equal(a.model.get().board, 'blue'); assert.equal(a.store.writeCounts.get(UI_PREFS_PATH) ?? 0, 0); } finally { a.done(); }
  const b = await setup({ [UI_PREFS_PATH]: { board: 'neon', updatedAt: 5, device: 'phone' } });
  try { assert.equal(b.model.get().board, 'green'); } finally { b.done(); }
  const c = await setup({ [UI_PREFS_PATH]: { colour: 'blue' } });
  try { assert.equal(c.model.get().board, 'green'); } finally { c.done(); }
});

test('the model: a change shows at once, is stored as { board, updatedAt, device }, and reaches another page on the same database', async () => {
  const { store, model, done } = await setup();
  try {
    let seen = 0;
    const stop = model.subscribe(() => { seen++; });
    const saving = model.saveBoard('brown');
    assert.equal(model.get().board, 'brown', 'the board changes before the write returns');
    assert.ok(seen >= 1);
    assert.equal(await saving, true);
    const stored = store.dump()[UI_PREFS_PATH] as DocData;
    assert.deepEqual(Object.keys(stored).sort(), ['board', 'device', 'updatedAt']);
    assert.equal(stored.board, 'brown');
    assert.equal(stored.device, 'laptop');
    assert.equal(typeof stored.updatedAt, 'number');
    assert.equal(store.writeCounts.get(UI_PREFS_PATH), 1);
    // A second page (another device) over the same documents picks it up through its subscription.
    const sessions2 = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'phone', events: null as never });
    // Its clock runs behind the first page's (7.3: no clock decides which choice is applied; review P2-4).
    let behind = 1_000_000_000_000;
    const other = createTrainerModel({ store, sessions: sessions2, deviceId: 'phone', readyTimeoutMs: 2000, now: () => (behind += 1000) });
    const stop2 = other.subscribe(() => {});
    await tick(30);
    assert.equal(other.get().board, 'brown');
    assert.equal(await other.saveBoard('blue'), true);
    await tick(30);
    assert.equal(model.get().board, 'blue', 'a later change on the other device arrives here');
    stop(); stop2(); other.dispose();
  } finally { done(); }
});

test('the model: a failed write keeps the board changed here and says so; an older stored choice does not undo a change made on this page', async () => {
  const { store, model, done } = await setup({ [UI_PREFS_PATH]: { board: 'blue', updatedAt: 5, device: 'phone' } });
  try {
    assert.equal(model.get().board, 'blue');
    store.failNextWrites(1, 'unavailable');
    assert.equal(await model.saveBoard('brown'), false);
    assert.equal(model.get().board, 'brown', 'the choice holds on this page');
    assert.equal((store.dump()[UI_PREFS_PATH] as DocData).board, 'blue', 'the database still has the old choice');
    // The old document is delivered again (a reconnect): it says nothing new, so it is not applied.
    // Version 7.3: this used to write `{ device: 'phone-again' }` to force the delivery. A document that has CHANGED
    // since the last delivery is now a later write by someone, and the database is followed again
    // (`tests/m73_board.test.tsx`, S3); a reconnect delivers the same document, as here.
    await store.update(UI_PREFS_PATH, { board: 'blue', updatedAt: 5, device: 'phone' });
    await tick(30);
    assert.equal(model.get().board, 'brown');
    assert.equal(model.get().boardUnsaved, true, '7.3: and the view says it is unsaved');
  } finally { done(); }
});

test('the stylesheet: green by default with the Chess.com green board\'s two colours; blue is the earlier board value for value; every look redefines every board token', () => {
  const bare = new Map<string, string>();
  for (const m of css.matchAll(/(?:^|\})\s*:root\s*\{([^{}]*)\}/g)) for (const [k, v] of tokensIn(m[1])) if (k.startsWith('--board-')) { assert.ok(!bare.has(k), `${k} is defined once on bare :root`); bare.set(k, v); }
  assert.equal(bare.get('--board-light'), '#eeeed2');
  assert.equal(bare.get('--board-dark'), '#769656');
  // 7.3 added `--board-hint-edge` (the dark edge under the hint ring; on Blue it equals the ring, so Blue is unchanged).
  const names = ['--board-arrow', '--board-coord-on-dark', '--board-coord-on-light', '--board-dark', '--board-dot', '--board-edge', '--board-hint', '--board-hint-edge', '--board-last-dark', '--board-last-light', '--board-light', '--board-selected-dark', '--board-selected-light'];
  assert.deepEqual([...bare.keys()].sort(), names);
  const looks = new Map([...css.matchAll(/\.app-shell\[data-board="([a-z]+)"\]\s*\{([^{}]*)\}/g)].map(m => [m[1], tokensIn(m[2])]));
  assert.deepEqual([...looks.keys()].sort(), BOARD_THEMES.map(t => t.id).filter(id => id !== DEFAULT_BOARD_THEME).sort(), 'one block per board other than the default');
  for (const [name, t] of looks) assert.deepEqual([...t.keys()].sort(), names, name);
  // The board of versions 4 to 7.1 (`styles/app.css` before 7.2), so "Blue" is exactly what he had.
  assert.deepEqual(Object.fromEntries(looks.get('blue')!), {
    '--board-light': '#e4edf2', '--board-dark': '#6087a6', '--board-last-light': '#c2d9ad', '--board-last-dark': '#8bb1a1', '--board-selected-light': '#d7bb55', '--board-selected-dark': '#d7bb55',
    '--board-hint': '#dfac36', '--board-hint-edge': '#dfac36', '--board-coord-on-light': '#4e7088', '--board-coord-on-dark': '#f6faff', '--board-edge': '#68899f', '--board-dot': '#173b5260', '--board-arrow': '#6b1d1d',
  });
  // Every board colour on the board itself comes from a token: no square, mark or arrow rule keeps a literal of the old board.
  const blueBlock = /\.app-shell\[data-board="blue"\]\s*\{([^{}]*)\}/.exec(css)![1];
  for (const literal of ['#e4edf2', '#6087a6', '#c2d9ad', '#8bb1a1', '#d7bb55', '#dfac36', '#68899f', '#173b5260']) {
    assert.ok(blueBlock.includes(literal));
    assert.equal(css.split(literal).length, blueBlock.split(literal).length, `${literal} appears only in the blue block`);
  }
  for (const used of names) assert.match(css, new RegExp(`var\\(${used}\\)`), `${used} is used`);
});

test('the wrapper carries the board and the root keeps data-theme for the page; the switch lists the three boards', () => {
  const trainer = readFileSync(join(ARTIFACT_DIR, 'components/Trainer.tsx'), 'utf8');
  assert.match(trainer, /className="app-shell" data-board=\{view\.board\}/);
  assert.equal((trainer.match(/<BoardLook /g) ?? []).length, 2, 'under the board and in "Shape your practice"');
  assert.doesNotMatch(css, /\[data-theme="(green|blue|brown)"\]/, 'data-theme is never a board name');
  for (const where of ['practice', 'settings'] as const) {
    const html = renderToStaticMarkup(<BoardLook where={where} value="brown" onChange={async () => true} />);
    assert.match(html, new RegExp(`<label for="board-look-${where}">`));
    assert.deepEqual([...html.matchAll(/<option value="([a-z]+)"( selected="")?>([A-Za-z]+)<\/option>/g)].map(m => [m[1], !!m[2], m[3]]), [['green', false, 'Green'], ['blue', false, 'Blue'], ['brown', true, 'Brown']]);
    assert.doesNotMatch(html, /role="status"/, 'no message until a save fails');
  }
});
