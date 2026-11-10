import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeStore, createMemoryKv, type DocData } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { assemblePack, collectAttempts, createTrainerModel, drillProblem, settingsFrom, type TrainerModel } from '../components/model';
import type { SessionAttempt } from '../src/contract/docs';

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const START = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const attempt = (puzzleId: string, at: number, correct = true): SessionAttempt => ({ puzzleId, themes: ['fork'], correct, unassisted: correct, hints: 0, revealed: false, durationMs: 1000, at });
const card = (id: string, extra: DocData = {}) => ({ id, fen: START, moves: ['a1a8'], rating: 1000, themes: ['backRankMate'], ...extra });

function seed(): Record<string, DocData> {
  return {
    'settings/main': { rating: 1100, sessionLength: 12, dailyReviewCap: 15, updatedAt: 5, device: 'phone', lastIngest: '2026-11-09T00:00:00Z', chesscomUser: 'someone' },
    'sessions/s-1-phone': { device: 'phone', startedAt: 1, attempts: [attempt('a', 10), attempt('b', 20)] },
    'pack/meta': { packVersion: 'v1', importedAt: '2026-11-10T00:00:00Z', counts: { cards: 2 }, priors: { fork: 2 }, chunks: { cards: ['v1-cards-00'], special: [], punish: ['v1-punish-00'] }, profile: null },
    'pack/v1-cards-00': { cards: [card('pack-0000000000000001', { pack: { playedUci: 'g1f1' } }), card('pack-0000000000000002')] },
    'pack/v1-punish-00': { cards: [card('pack-0000000000000003')] },
    'plan/current': { updatedAt: 1, author: 'claude', expires: '2099-01-01T00:00:00Z', focus: [{ theme: 'fork', weight: 2, reason: 'most missed' }], mix: { bank: 0.5, pack: 0.5, endgame: 0, agent: 0 }, extraField: 'kept' },
    'notes/n1': { text: 'Welcome back.', createdAt: '2026-11-09T12:00:00Z', future: 'kept' },
    'feedback/f-1-phone': { at: 1, kind: 'wrong', itemId: 'pack-0000000000000002', source: 'pack', themes: ['fork'], fen: START, sessionId: 's-1-phone', status: 'open' },
    'drills/set1': { title: 'Back rank', reason: 'test', createdAt: 1, active: true, note: 'kept', cards: [
      { id: 'agent-set1-1', fen: START, moves: ['a1a8'], themes: ['backRankMate'], rating: 900 },
      { id: 'agent-set1-2', fen: START, moves: ['a1h8'], themes: ['backRankMate'], rating: 900 },
    ] },
    'personal/import-00': { puzzles: [{ id: 'personal-x', fen: START, moves: ['a1a8'], rating: 1000, themes: ['personal'] }] },
  };
}

async function setup(extra: Record<string, DocData> = {}) {
  const store = createFakeStore({ seed: { ...seed(), ...extra } });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'laptop', events: null, debounceMs: 1 });
  const model = createTrainerModel({ store, sessions, deviceId: 'laptop', readyTimeoutMs: 1000 });
  await tick(20);
  const done = () => { model.dispose(); sessions.dispose(); };
  return { store, sessions, model, done };
}

test('model: loads settings, history, pack, plan, notes, open feedback, drills and personal positions', async () => {
  const { model, done } = await setup();
  try {
    const v = model.get();
    assert.equal(v.ready, true);
    assert.equal(v.settings.rating, 1100);
    assert.equal(v.settings.dailyReviewCap, 15);
    assert.equal(v.settings.dailyNewCap, 10, 'default new cap');
    assert.deepEqual(v.attempts.map(a => a.puzzleId), ['a', 'b']);
    assert.equal(v.pack?.version, 'v1');
    assert.deepEqual(v.pack?.cards.map(c => c.id), ['pack-0000000000000001', 'pack-0000000000000002']);
    assert.deepEqual(v.pack?.punish.map(c => [c.id, c.kind]), [['pack-0000000000000003', 'punish']]);
    assert.equal((v.pack?.cards[0] as { pack?: { playedUci?: string } }).pack?.playedUci, 'g1f1', 'detail passes through');
    assert.equal(v.plan?.focus[0].theme, 'fork');
    assert.deepEqual(v.notes.map(n => [n.id, n.read]), [['n1', false]]);
    assert.ok(v.flaggedWrong.has('pack-0000000000000002'));
    assert.deepEqual(v.drills[0].cards.map(c => c.id), ['agent-set1-1']);
    assert.equal(v.drills[0].rejected[0].id, 'agent-set1-2');
    assert.deepEqual(v.personal.map(p => p.id), ['personal-x']);
  } finally { done(); }
});

test('model: invalid drill lines are written back to drills.rejected with update, keeping agent fields', async () => {
  const { store, done } = await setup();
  try {
    await tick(20);
    const doc = store.dump()['drills/set1'] as { rejected?: { id: string }[]; note?: string; cards: unknown[] };
    assert.deepEqual(doc.rejected?.map(r => r.id), ['agent-set1-2']);
    assert.equal(doc.note, 'kept');
    assert.equal(doc.cards.length, 2, 'cards untouched');
  } finally { done(); }
});

test('model: a recorded attempt shows at once and is not doubled when the session document arrives', async () => {
  const { model, store, sessions, done } = await setup();
  try {
    assert.equal(model.record({ ...attempt('c', 30), source: 'bank' }), true);
    assert.deepEqual(model.get().attempts.map(a => a.puzzleId), ['a', 'b', 'c']);
    await sessions.flush();
    await tick(20);
    assert.deepEqual(model.get().attempts.map(a => a.puzzleId), ['a', 'b', 'c']);
    const docs = Object.entries(store.dump()).filter(([p]) => p.startsWith('sessions/s-') && p.endsWith('-laptop'));
    assert.equal(docs.length, 1);
    assert.equal(model.record({ ...attempt('d', 40), unassisted: false }), false, 'inconsistent attempt refused');
  } finally { done(); }
});

test('model: feedback "wrong" is written for Claude and the item is flagged before the echo', async () => {
  const { model, store, done } = await setup();
  try {
    const ok = model.sendFeedback({ kind: 'wrong', item: { id: '00abc', source: 'bank', themes: ['fork'], fen: START }, playedUci: 'a1a7' });
    assert.ok(model.get().flaggedWrong.has('00abc'));
    assert.equal(await ok, true);
    const docs = Object.entries(store.dump()).filter(([p]) => p.startsWith('feedback/') && p.endsWith('-laptop'));
    assert.equal(docs.length, 1);
    const body = docs[0][1] as Record<string, unknown>;
    assert.equal(body.status, 'open'); assert.equal(body.kind, 'wrong'); assert.equal(body.itemId, '00abc'); assert.equal(body.playedUci, 'a1a7');
    // Two quick taps never collide on the same document id.
    await Promise.all([model.sendFeedback({ kind: 'more', item: { id: 'x', source: 'bank', themes: ['fork'], fen: START } }), model.sendFeedback({ kind: 'too-easy', item: { id: 'x', source: 'bank', themes: ['fork'], fen: START } })]);
    assert.equal(Object.keys(store.dump()).filter(p => p.startsWith('feedback/') && p.endsWith('-laptop')).length, 3);
    // Claude closes the original flag: the item is served again.
    await store.update('feedback/f-1-phone', { status: 'done', reply: 'Fixed.' });
    await tick(20);
    assert.equal(model.get().flaggedWrong.has('pack-0000000000000002'), false);
  } finally { done(); }
});

test('model: marking a note read sets only readAt and keeps agent fields', async () => {
  const { model, store, done } = await setup();
  try {
    await model.markNoteRead('n1');
    assert.equal(model.get().notes[0].read, true);
    const note = store.dump()['notes/n1'] as Record<string, unknown>;
    assert.equal(typeof note.readAt, 'number'); assert.equal(note.future, 'kept'); assert.equal(note.text, 'Welcome back.');
  } finally { done(); }
});

test('model: settings save validates and keeps the caps; bad values are refused', async () => {
  const { model, store, done } = await setup();
  try {
    assert.equal(await model.saveSettings({ dailyNewCap: 5 }), true);
    const s = store.dump()['settings/main'] as Record<string, unknown>;
    assert.equal(s.dailyNewCap, 5); assert.equal(s.dailyReviewCap, 15); assert.equal(s.device, 'laptop');
    assert.equal(s.lastIngest, '2026-11-09T00:00:00Z', 'fields the page does not edit survive');
    assert.equal(s.chesscomUser, 'someone'); assert.equal(s.sessionLength, 12);
    assert.equal(await model.saveSettings({ rating: 5 }), false);
    assert.notEqual(model.get().error, '');
  } finally { done(); }
});

test('model: a new pack version swaps in whole; a missing chunk keeps the previous pack', async () => {
  const { model, store, done } = await setup();
  try {
    await store.set('pack/v2-cards-00', { cards: [card('pack-00000000000000aa')] });
    await store.set('pack/meta', { packVersion: 'v2', importedAt: 2, counts: {}, priors: {}, chunks: { cards: ['v2-cards-00'], special: [] } });
    await tick(20);
    assert.deepEqual(model.get().pack?.cards.map(c => c.id), ['pack-00000000000000aa']);
    assert.deepEqual(model.get().pack?.punish, []);
    await store.set('pack/meta', { packVersion: 'v3', importedAt: 3, counts: {}, priors: {}, chunks: { cards: ['v3-cards-00'], special: [] } });
    await tick(20);
    assert.equal(model.get().pack?.version, 'v2', 'incomplete v3 is not shown');
    assert.match(model.get().error, /personal pack/);
  } finally { done(); }
});

test('model: an empty database is ready with defaults and no pack', async () => {
  const store = createFakeStore();
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'd1', events: null });
  const model = createTrainerModel({ store, sessions, deviceId: 'd1' });
  try {
    await tick(20);
    const v = model.get();
    assert.equal(v.ready, true); assert.equal(v.pack, null); assert.equal(v.plan, null);
    assert.equal(v.settings.rating, 1000); assert.equal(v.settings.dailyReviewCap, 20); assert.equal(v.settings.dailyNewCap, 10);
  } finally { model.dispose(); sessions.dispose(); }
});

test('model: a local-only store is not ready until history, plan and feedback have arrived', async () => {
  const store = createFakeStore({ connection: 'local-only', latencyMs: 5, seed: seed() });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'd1', events: null });
  const model = createTrainerModel({ store, sessions, deviceId: 'd1' });
  try {
    assert.equal(model.get().ready, false, 'not ready at creation');
    while (!model.get().ready) await tick(5);
    const v = model.get();
    assert.equal(v.attempts.length, 2); assert.ok(v.plan); assert.ok(v.flaggedWrong.has('pack-0000000000000002')); assert.equal(v.settings.rating, 1100);
  } finally { model.dispose(); sessions.dispose(); }
});

test('model: an invalid attempt is refused with a message', async () => {
  const { model, done } = await setup();
  try {
    assert.equal(model.record({ ...attempt('z', 50), hints: -1 }), false);
    assert.match(model.get().error, /could not be saved/);
  } finally { done(); }
});

test('model: an offline store still becomes ready after the load timer', async () => {
  const store = createFakeStore({ connection: 'connecting' });
  store.setOffline(true);
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'd1', events: null });
  let model: TrainerModel | null = null;
  try {
    model = createTrainerModel({ store, sessions, deviceId: 'd1', readyTimeoutMs: 15 });
    await tick(5);
    assert.equal(model.get().ready, false);
    await tick(30);
    assert.equal(model.get().ready, true);
  } finally { model?.dispose(); sessions.dispose(); }
});

test('helpers: collectAttempts dedupes by puzzleId:at; settingsFrom falls back; drillProblem; assemblePack', () => {
  const a = attempt('a', 1), b = attempt('b', 2);
  assert.deepEqual(collectAttempts([{ device: 'x', startedAt: 0, attempts: [b, a] }], [a, attempt('c', 0)]).map(x => x.puzzleId), ['c', 'a', 'b']);
  assert.equal(settingsFrom({ rating: 'high' }).rating, 1000);
  assert.equal(drillProblem({ fen: START, moves: ['a1a8'] }), null);
  assert.match(drillProblem({ fen: 'not a fen', moves: ['a1a8'] }) ?? '', /FEN/);
  const meta = { packVersion: 'v', importedAt: 1, counts: {}, priors: {}, chunks: { cards: ['v-cards-00'], special: [] } };
  assert.equal(assemblePack(meta, [null]), null);
  assert.equal(assemblePack(meta, [{ id: 'v-cards-00', data: { cards: 'nope' } }]), null);
});
