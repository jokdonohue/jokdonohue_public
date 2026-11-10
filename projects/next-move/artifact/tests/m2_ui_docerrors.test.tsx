import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFakeStore, createMemoryKv, type DocData } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { createTrainerModel } from '../components/model';
import { computeSnapshot } from '../components/snapshot';
import { buildProgress } from '../components/progress';
import { DocErrorLine } from '../components/HomePanels';

// D10: unreadable coach documents. Invented content only.
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';

async function model(seed: Record<string, DocData>, now?: () => number) {
  const store = createFakeStore({ seed });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'd1', events: null, debounceMs: 1 });
  const m = createTrainerModel({ store, sessions, deviceId: 'd1', readyTimeoutMs: 500, packRetryMs: 5, ...(now ? { now } : {}) });
  await tick(30);
  return { m, store, done: () => { m.dispose(); sessions.dispose(); } };
}

test('D10: plan, note, drill set, pack meta and pack chunk failures are skipped and listed; valid ones are not', async () => {
  const { m, done } = await model({
    'plan/current': { updatedAt: 1, author: 'claude', expires: '2100-01-01T00:00:00Z', focus: [{ theme: 'fork', weight: 3.5, reason: 'r' }], mix: { bank: 1, pack: 0, endgame: 0, agent: 0 } },
    'notes/ok': { text: 'fine', createdAt: 1 },
    'notes/long': { text: 'x'.repeat(601), createdAt: 1 },
    'drills/bad': { title: 't', reason: 'r', createdAt: 1, active: true, cards: [{ id: 'agent-bad-1', fen: FEN, moves: ['a1a8'], themes: ['fork'] }] },
    'pack/meta': { packVersion: 'v1', importedAt: 1, counts: {}, priors: {}, chunks: { cards: ['v1-cards-00'] } },
    'pack/v1-cards-00': { cards: [{ id: 'pack-1', fen: FEN, moves: ['a1a8'], themes: [] }] },
  });
  const v = m.get();
  assert.deepEqual(v.docErrors.map(e => e.path).sort(), ['drills/bad', 'notes/long', 'pack/v1-cards-00', 'plan/current']);
  assert.match(v.docErrors.find(e => e.path === 'plan/current')!.issue, /weight/);
  assert.ok(v.docErrors.every(e => e.issue.length <= 300 && e.at > 0));
  assert.equal(v.plan, null, 'skipped as today');
  assert.equal(v.notes.length, 1);
  done();
});

test('D10: at most 20, newest first; a fixed document drops off the list', async () => {
  let clock = 1000;
  const seed: Record<string, DocData> = {};
  for (let i = 0; i < 25; i++) seed[`notes/n${String(i).padStart(2, '0')}`] = { text: 'x'.repeat(700), createdAt: 1 };
  const { m, store, done } = await model(seed, () => clock++);
  assert.equal(m.get().docErrors.length, 20);
  const ats = m.get().docErrors.map(e => e.at);
  assert.deepEqual(ats, [...ats].sort((a, b) => b - a));
  for (let i = 0; i < 25; i++) await store.set(`notes/n${String(i).padStart(2, '0')}`, { text: 'fixed', createdAt: 1 });
  await tick(20);
  assert.equal(m.get().docErrors.length, 0);
  done();
});

test('D10: the quiet line and the snapshot field', () => {
  assert.equal(renderToStaticMarkup(<DocErrorLine count={0}/>), '');
  assert.match(renderToStaticMarkup(<DocErrorLine count={1}/>), /One item from your coach could not be read; the rest is working\./);
  assert.match(renderToStaticMarkup(<DocErrorLine count={3}/>), /3 items from your coach could not be read/);
  assert.doesNotMatch(renderToStaticMarkup(<DocErrorLine count={1}/>), /role="alert"/);
  const progress = buildProgress([], { rating: 1000, sessionLength: 10 }, t => t);
  const errs = Array.from({ length: 22 }, (_, i) => ({ path: `notes/n${i}`, issue: 'text: too long', at: 100 - i }));
  const snap = computeSnapshot({ attempts: [], progress, themesOf: t => t, priors: null, servableIds: [], packIds: [], session: null, deviceId: 'd1', now: 5, docErrors: errs });
  assert.equal(snap.docErrors?.length, 20);
  assert.deepEqual(snap.docErrors?.[0], { path: 'notes/n0', issue: 'text: too long', at: 100 });
  const none = computeSnapshot({ attempts: [], progress, themesOf: t => t, priors: null, servableIds: [], packIds: [], session: null, deviceId: 'd1', now: 5, docErrors: [] });
  assert.equal('docErrors' in none, false);
});

test('D10: `at` is when the page first saw the issue; another delivery of the collection does not reset it', async () => {
  let clock = 5000;
  const { m, store, done } = await model({ 'notes/bad': { text: 'x'.repeat(700), createdAt: 1 }, 'notes/ok': { text: 'fine', createdAt: 1 } }, () => clock++);
  const first = m.get().docErrors[0].at;
  clock += 1000;
  await store.set('notes/other', { text: 'new note', createdAt: 2 });
  await tick(20);
  assert.equal(m.get().docErrors.length, 1);
  assert.equal(m.get().docErrors[0].at, first);
  done();
});
