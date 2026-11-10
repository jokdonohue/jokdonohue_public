import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDocPath, assertDocSize, DocTooLargeError, MAX_DOC_BYTES, packChunkIds, parsePackChunkId, paths, prepareWrite, readDoc,
  schemaForPath, toMs, attemptKey,
} from '../src/contract/docs';
import { createFakeStore, mergeDoc, StoreError } from '../src/contract/store';

const FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
const attempt = (at: number, puzzleId = 'p1', correct = true) => ({ puzzleId, themes: ['fork'], correct, unassisted: correct, hints: 0, revealed: false, durationMs: 4000, at, source: 'bank' as const });
const now = 1_794_300_000_000;

const samples: Record<string, Record<string, unknown>> = {
  [paths.schema()]: { schemaVersion: 1, createdAt: now },
  [paths.settings()]: { rating: 1000, sessionLength: 10, chesscomUser: 'someone', updatedAt: now, device: 'dabc123' },
  [paths.session(now, 'dabc123')]: { device: 'dabc123', startedAt: now, attempts: [attempt(now + 1), { ...attempt(now + 2, 'pack-0123456789abcdef', false), playedUci: 'e2e4', coached: true }] },
  [paths.importSession('1a2b3c4d', 0)]: { device: 'import', startedAt: 0, attempts: [], importedFrom: 'site-backup' },
  [paths.snapshot()]: {
    computedAt: now, attemptsTotal: 2, approxBytes: 900, last7d: { attempts: 2, firstTryRate: 0.5 }, last30d: { attempts: 2, firstTryRate: 0.5 },
    themes: { fork: { attempts: 2, successes: 1, rate: 0.5, lastAttempt: now, prior: 1.4 } },
    weakest: [{ theme: 'fork', rate: 0.5, attempts: 2, prior: 1.4, why: 'low rate' }], due: { count: 1, overdue: 0, nextIds: ['p1'] },
    sources: { bank: 1, pack: 1, endgame: 0, personal: 0, agent: 0 }, packCoverage: { seen: 1, total: 900 },
    lastSession: { id: 's-1-dabc123', attempts: 2, firstTryRate: 0.5, endedAt: null }, today: { date: '2026-11-10', reviews: 1, new: 1 },
  },
  [paths.game('game-1a2b3c4d')]: { pgn: '1. e4 e5 *', headers: { White: 'A', Black: 'B' }, userColor: 'w', importedAt: now, mistakes: [{ ply: 3, fen: FEN, playedUci: 'f1c4', bestUci: 'f1b5', pvUci: ['f1b5'], cpBefore: 30, cpAfter: -120 }] },
  [paths.personal('game-1a2b3c4d')]: { gameId: 'game-1a2b3c4d', puzzles: [{ id: 'personal-x', fen: FEN, moves: ['f1b5'], rating: 1000, themes: ['personal'], gameUrl: '' }] },
  [paths.personalImport(0)]: { puzzles: [] },
  [paths.feedback(now, 'dabc123')]: { at: now, kind: 'wrong', itemId: 'p1', source: 'bank', themes: ['fork'], fen: FEN, sessionId: 's-1-dabc123', status: 'open' },
  [paths.explanation('pack-0123456789abcdef', 'e2e4')]: { text: 'Because...', at: now, grounded: true, inputsHash: 'h1' },
  [paths.summary('2026-08')]: { month: '2026-08', attempts: [attempt(now)] },
  [paths.packMeta()]: { packVersion: 'v20261110a', importedAt: '2026-11-10T05:00:00Z', counts: { cards: 2 }, profile: { schemaVersion: 1 }, priors: { fork: 1.4 }, chunks: { cards: ['v20261110a-cards-00'], special: [], punish: ['v20261110a-punish-00'] } },
  [paths.packChunk('v20261110a', 'cards', 0)]: { packVersion: 'v20261110a', part: 'cards', cards: [{ id: 'pack-0123456789abcdef', fen: FEN, moves: ['f1b5'], rating: 1000, themes: ['fork'], title: 't', explanation: 'e', gameUrl: 'https://www.chess.com/game/live/1', pack: { sets: ['mistake'] } }] },
  [paths.packChunk('v20261110a', 'punish', 0)]: { cards: [{ id: 'pack-g1:12', kind: 'punish', fen: FEN, moves: ['f1b5'], rating: 1000, themes: ['punish'] }] },
  [paths.plan()]: { updatedAt: now, author: 'claude', expires: '2026-11-17T00:00:00Z', focus: [{ theme: 'fork', weight: 2, reason: 'missed forks' }], mix: { bank: 0.3, pack: 0.5, endgame: 0.1, agent: 0.1 } },
  [paths.drills('set1')]: { title: 'Forks', reason: 'r', createdAt: now, active: true, cards: [{ id: 'agent-set1-1', fen: FEN, moves: ['f1b5'], themes: ['fork'], rating: 1000 }] },
  [paths.note('n1')]: { text: 'Hello', createdAt: now },
  [paths.transferHistory()]: { points: [{ at: now, games: 40, window: '30d', blundersPer100: 5.5, ci95: [4.2, 6.9], convNotWonPct: 25, convCi95: [18, 33], onTimeShare: 0.5 }] },
  [paths.ingestState()]: { lastArchive: '2026/11', lastGameEnd: now, gamesProcessed: 1234, packVersion: 'v20261110a', at: now },
  [paths.openingAccidents()]: { groups: [{ opening: 'Example Opening', color: 'w', games: 20, earlyBlunderRate: 0.42, cardIds: ['pack-0123456789abcdef'] }] },
};

test('every section 2 document round-trips through its schema', () => {
  for (const [path, body] of Object.entries(samples)) {
    const schema = schemaForPath(path);
    assert.ok(schema, `schema for ${path}`);
    const parsed = schema.parse(body);
    assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(parsed))), parsed, `stable round trip ${path}`);
    assert.deepEqual(readDoc(path, JSON.parse(JSON.stringify(body))), parsed, `readDoc ${path}`);
  }
});

test('agent-written documents keep unknown fields; page-written documents strip them', () => {
  const plan = readDoc<Record<string, unknown>>(paths.plan(), { ...samples[paths.plan()], futureField: 1 });
  assert.equal(plan?.futureField, 1);
  const card = readDoc<{ cards: Array<Record<string, unknown>> }>(paths.packChunk('v20261110a', 'cards', 0), samples[paths.packChunk('v20261110a', 'cards', 0)]);
  assert.deepEqual(card?.cards[0].pack, { sets: ['mistake'] });
  const settings = prepareWrite<Record<string, unknown>>(paths.settings(), { ...samples[paths.settings()], junk: true });
  assert.equal('junk' in settings, false);
});

test('readDoc is tolerant and prepareWrite is strict', () => {
  assert.equal(readDoc(paths.plan(), { focus: 'bad' }), null);
  assert.equal(readDoc(paths.plan(), { ...samples[paths.plan()], mix: { bank: 0.5, pack: 0.5, endgame: 0.5, agent: 0 } }), null, 'mix must sum to 1');
  assert.equal(readDoc('unknown/doc', {}), null);
  assert.equal(readDoc('bad path', {}), null);
  assert.throws(() => prepareWrite(paths.feedback(now, 'd1'), { ...samples[paths.feedback(now, 'dabc123')], kind: 'nope' }));
  assert.throws(() => prepareWrite(paths.session(now, 'd1'), { device: 'd1', startedAt: now, attempts: [{ ...attempt(now), unassisted: false }] }), 'unassisted invariant');
});

test('documents over 180 KiB are refused, at the limit accepted', () => {
  const body = (n: number) => ({ s: 'x'.repeat(n) });
  const overhead = JSON.stringify(body(0)).length;
  assert.equal(assertDocSize(body(MAX_DOC_BYTES - overhead)), MAX_DOC_BYTES);
  assert.throws(() => assertDocSize(body(MAX_DOC_BYTES - overhead + 1)), DocTooLargeError);
  assert.throws(() => assertDocSize({ s: 'é'.repeat(MAX_DOC_BYTES / 2) }), DocTooLargeError, 'measured in UTF-8 bytes');
  const big = { device: 'd1', startedAt: now, attempts: Array.from({ length: 600 }, (_, i) => ({ ...attempt(now + i), themes: Array(30).fill('a'.repeat(200)) })) };
  assert.throws(() => prepareWrite(paths.session(now, 'd1'), big), DocTooLargeError);
});

test('fake store refuses oversized writes without storing them', async () => {
  const store = createFakeStore();
  await assert.rejects(store.set('notes/n1', { s: 'x'.repeat(MAX_DOC_BYTES) }), (e: unknown) => e instanceof StoreError && e.code === 'doc_too_large');
  assert.equal(await store.get('notes/n1'), null);
  await store.set('notes/n2', { a: 1 });
  await assert.rejects(store.update('notes/n2', { s: 'x'.repeat(MAX_DOC_BYTES) }), (e: unknown) => e instanceof StoreError && e.code === 'doc_too_large');
  assert.deepEqual((await store.get('notes/n2'))?.data, { a: 1 });
});

test('path helpers enforce the db grammar', () => {
  assert.equal(paths.session(now, 'dabc123'), `sessions/s-${now}-dabc123`);
  assert.equal(paths.packChunk('v1', 'safe', 3), 'pack/v1-safe-03');
  assert.deepEqual(parsePackChunkId('v20261110a-cards-07'), { packVersion: 'v20261110a', part: 'cards', index: 7 });
  assert.equal(paths.explanation('pack-g1:12', 'e7e8q'), 'explanations/pack-g1:12__e7e8q');
  assert.equal(paths.explanation('a/b c', ''), 'explanations/a_b_c__none');
  assert.throws(() => assertDocPath('sessions'), TypeError);
  assert.throws(() => assertDocPath('sessions/a b'), TypeError);
  assert.throws(() => assertDocPath('a/b/c/' + 'x'.repeat(201)), TypeError);
  assert.throws(() => paths.session(now, 'bad/id'), TypeError);
  const meta = readDoc<Parameters<typeof packChunkIds>[0]>(paths.packMeta(), samples[paths.packMeta()]);
  assert.deepEqual(packChunkIds(meta!), ['v20261110a-cards-00', 'v20261110a-punish-00']);
  assert.equal(toMs('2026-11-10T00:00:00Z'), Date.UTC(2026, 10, 10));
  assert.equal(toMs(5), 5);
  assert.equal(attemptKey({ puzzleId: 'p', at: 3 }), 'p:3');
});

test('fake store: set replaces, update merges and requires the doc, last write wins', async () => {
  const store = createFakeStore();
  await assert.rejects(store.update('settings/main', { rating: 1100 }), (e: unknown) => e instanceof StoreError && e.code === 'invalid_argument');
  await store.set('settings/main', { rating: 1000, nested: { a: 1, b: 2 }, list: [1, 2] });
  await store.update('settings/main', { nested: { b: 3 }, list: [9] });
  assert.deepEqual((await store.get('settings/main'))?.data, { rating: 1000, nested: { a: 1, b: 3 }, list: [9] });
  await store.set('settings/main', { rating: 1200 });
  assert.deepEqual((await store.get('settings/main'))?.data, { rating: 1200 }, 'set is a full replace');
  // Two devices write concurrently: the later write wins, nothing merges.
  await Promise.all([store.set('settings/main', { rating: 1350, device: 'a' }), store.set('settings/main', { rating: 1400, device: 'b' })]);
  assert.deepEqual((await store.get('settings/main'))?.data, { rating: 1400, device: 'b' });
  const doc = await store.get('settings/main');
  assert.ok(Object.isFrozen(doc!.data));
  await store.delete('settings/main');
  await store.delete('settings/main');
  assert.equal(await store.get('settings/main'), null);
  assert.deepEqual(mergeDoc({ a: { b: [1] } }, { a: { b: [2], c: 1 } }), { a: { b: [2], c: 1 } });
});

test('fake store queries: where, orderBy, limit, id order by default, direct children only', async () => {
  const store = createFakeStore({ seed: {
    'feedback/f-3-d': { at: 3, status: 'open' }, 'feedback/f-1-d': { at: 1, status: 'done' }, 'feedback/f-2-d': { at: 2, status: 'open' },
    'feedback/f-2-d/sub/x': { at: 9, status: 'open' }, 'notes/n1': { status: 'open' },
  } });
  assert.deepEqual((await store.query({ collection: 'feedback' })).map(d => d.id), ['f-1-d', 'f-2-d', 'f-3-d']);
  assert.deepEqual((await store.query({ collection: 'feedback', where: [['status', '==', 'open']], orderBy: { field: 'at', dir: 'desc' }, limit: 1 })).map(d => d.id), ['f-3-d']);
  await assert.rejects(store.query({ collection: 'feedback', limit: 0 }), StoreError);
  assert.throws(() => store.subscribeQuery({ collection: 'feedback/f-1-d' }, () => {}), TypeError);
});

test('fake store subscriptions deliver async, on change, and stop after unsubscribe', async () => {
  const store = createFakeStore();
  const seen: Array<unknown> = [];
  let sync = true;
  const off = store.subscribe('notes/n1', doc => { assert.equal(sync, false); seen.push(doc?.data ?? null); });
  sync = false;
  const lists: number[] = [];
  const offQ = store.subscribeQuery({ collection: 'notes' }, docs => lists.push(docs.length));
  await new Promise(r => setTimeout(r, 5));
  await store.set('notes/n1', { text: 'a' });
  await new Promise(r => setTimeout(r, 5));
  off(); offQ();
  await store.set('notes/n1', { text: 'b' });
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(seen, [null, { text: 'a' }]);
  assert.deepEqual(lists, [0, 1]);
});

test('fake store offline and injected failures reject without writing', async () => {
  const store = createFakeStore();
  store.setOffline(true);
  await assert.rejects(store.set('notes/n1', { a: 1 }), (e: unknown) => e instanceof StoreError && e.code === 'unavailable');
  store.setOffline(false);
  store.failNextWrites(1, 'quota_exceeded');
  await assert.rejects(store.set('notes/n1', { a: 1 }), (e: unknown) => e instanceof StoreError && e.code === 'quota_exceeded');
  await store.set('notes/n1', { a: 2 });
  assert.equal(store.writeCounts.get('notes/n1'), 1);
});

