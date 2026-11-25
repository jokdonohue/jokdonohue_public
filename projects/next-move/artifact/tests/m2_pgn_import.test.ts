import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeStore, type FakeStore, type Store, type StoreDoc } from '../src/contract/store';
import { docBytes, MAX_DOC_BYTES, paths, prepareWrite, readDoc, type GameDoc, type PersonalDoc } from '../src/contract/docs';
import { readGames, prepareGames, runImport, detectSide, cleanNames, MAX_GAMES, ANALYSIS_DEPTH, ImportWriteError } from '../src/analysis/importer';
import { cardIdOf, chesscomGameId, positionKey, ANALYSIS_HEADER } from '../src/analysis/docs';
import { isAbort } from '../src/analysis/engine';
import * as v4 from './fixtures/v4_docs';
import { stubEngine, fenBefore, A_MOVES, A_SCRIPT, B_MOVES, B_SCRIPT, GAME_A, GAME_B } from './m2_pgn_stub';

const NAMES = ['Alex Example'];
const T = 1_762_000_000_000;
const SCRIPT = { ...A_SCRIPT, ...B_SCRIPT };
const pageDocs = (dump: Record<string, unknown>) => Object.keys(dump).filter(p => /^(games|personal)\//.test(p)).sort();

async function importText(text: string, store = createFakeStore(), extra: Partial<Parameters<typeof runImport>[0]> = {}) {
  const read = readGames(text);
  assert.ok(read.ok, read.ok ? '' : read.message);
  const prepared = await prepareGames(read.games, NAMES, store);
  const engine = stubEngine(SCRIPT);
  const summary = await runImport({ prepared, engine, store, now: () => T, ...extra });
  return { store, prepared, summary, engine };
}

test('two games: his side is found by name, his clear mistakes become cards, documents pass the contract', async () => {
  const { store, prepared, summary, engine } = await importText(`${GAME_A}\n${GAME_B}`);
  assert.deepEqual(prepared.map(p => p.side), ['b', 'w'], 'Black in game A, White in game B (name match ignores case)');
  assert.equal(summary.games, 2);
  assert.equal(summary.positions, 2);
  assert.equal(engine.disposed, 1, 'the engine is released');
  // Only his moves were analysed, at the named depth, two lines before each move.
  assert.ok(engine.calls.every(c => c.depth === ANALYSIS_DEPTH));
  const searched = new Set(engine.calls.filter(c => c.multiPv === 2).map(c => c.fen));
  const his = new Set([
    ...[2, 4, 6].map(p => fenBefore(A_MOVES, p)),
    ...B_MOVES.map((_m, i) => i + 1).filter(p => p % 2 === 1).map(p => fenBefore(B_MOVES, p)),
  ]);
  assert.deepEqual([...searched].sort(), [...his].sort(), 'exactly the positions before his moves, two lines each');

  const dump = store.dump();
  assert.deepEqual(pageDocs(dump), ['games/111222333', `games/${prepared[1].gameId}`, 'personal/111222333', `personal/${prepared[1].gameId}`].sort());
  for (const path of pageDocs(dump)) {
    assert.deepEqual(prepareWrite(path, dump[path]), dump[path], `${path}: nothing stripped by the strict schema`);
  }
  const a = dump['personal/111222333'] as PersonalDoc;
  assert.equal(a.puzzles.length, 1);
  const card = a.puzzles[0];
  assert.equal(card.id, 'pack-111222333:6', 'the producer id scheme: pack-<chess.com game number>:<half-move>');
  assert.equal(card.fen, fenBefore(A_MOVES, 6));
  assert.deepEqual(card.moves, ['g7g6']);
  assert.equal(card.gameUrl, 'https://www.chess.com/game/live/111222333');
  assert.match(card.title!, /2026-11-01 · move 3 \(checked in this page\)/);
  assert.match(card.explanation!, /You played Nf6\. The engine preferred g6, and it was clearly best at depth 12 \(checked in this page\)\./);
  assert.ok(card.themes.includes('personal'));
  const gA = dump['games/111222333'] as GameDoc;
  assert.equal(gA.userColor, 'b');
  assert.equal(gA.importedAt, T);
  assert.deepEqual(gA.mistakes.map(m => [m.ply, m.playedUci, m.bestUci, m.cpBefore, m.cpAfter]), [[6, 'g8f6', 'g7g6', 0, null]]);
  assert.deepEqual(gA.mistakes[0].refutationPvUci, ['h5f7']);
  assert.match(gA.headers[ANALYSIS_HEADER], /depth 12/);
  const b = dump[`personal/${prepared[1].gameId}`] as PersonalDoc;
  assert.equal(b.puzzles[0].id, `page-${prepared[1].gameId}:7`, 'no chess.com link: a namespace the producer never issues');
  assert.equal(b.puzzles[0].gameUrl, undefined);
  const gB = dump[`games/${prepared[1].gameId}`] as GameDoc;
  assert.deepEqual(gB.mistakes.map(m => [m.ply, m.cpBefore, m.cpAfter]), [[7, 30, -300]], 'centipawns from his side');
});

test('re-import is idempotent: finished games are skipped and nothing is rewritten', async () => {
  const first = await importText(GAME_A);
  const before = JSON.stringify(first.store.dump());
  const writes = [...first.store.writeCounts.entries()];
  const second = await importText(GAME_A, first.store);
  assert.ok(second.prepared[0].already);
  assert.equal(second.summary.games, 0);
  assert.equal(second.summary.skippedAlready, 1);
  assert.equal(second.engine.calls.length, 0, 'no engine work for a finished game');
  assert.equal(JSON.stringify(second.store.dump()), before);
  assert.deepEqual([...second.store.writeCounts.entries()], writes);
  // The same game in a fresh database gives byte-identical documents (deterministic for a fixed clock).
  const again = await importText(GAME_A);
  assert.equal(JSON.stringify(again.store.dump()), before);
  // The same game twice in one paste is analysed once.
  const twice = await importText(`${GAME_A}\n${GAME_A}`);
  assert.equal(twice.summary.games, 1);
});

test('a stop mid-way leaves nothing behind', async () => {
  const store = createFakeStore();
  const read = readGames(`${GAME_A}\n${GAME_B}`);
  assert.ok(read.ok);
  const prepared = await prepareGames(read.games, NAMES, store);
  const ctrl = new AbortController();
  const engine = stubEngine(SCRIPT, n => { if (n === 5) ctrl.abort(); });
  const phases: string[] = [];
  await assert.rejects(runImport({ prepared, engine, store, signal: ctrl.signal, onProgress: p => phases.push(p.phase) }), (e: unknown) => isAbort(e));
  assert.deepEqual(Object.keys(store.dump()), [], 'no document written');
  assert.equal(store.writeCounts.size, 0);
  assert.ok(!phases.includes('saving'));
  assert.equal(engine.disposed, 1);
});

test('a failed write reports how far it got; the unfinished game is redone next time', async () => {
  const store = createFakeStore();
  const read = readGames(`${GAME_A}\n${GAME_B}`);
  assert.ok(read.ok);
  const prepared = await prepareGames(read.games, NAMES, store);
  store.failNextWrites(1);
  await assert.rejects(runImport({ prepared, engine: stubEngine(SCRIPT), store, now: () => T }), (e: unknown) => e instanceof ImportWriteError && e.savedGames === 0 && /Try again/.test(e.message));
  assert.ok(!('games/111222333' in store.dump()), 'no finished-game marker for the failed game');
  const retry = await importText(`${GAME_A}\n${GAME_B}`, store);
  assert.equal(retry.summary.games, 2);
});

test('broken or oversized input is refused with a plain sentence and nothing is saved', async () => {
  const cases = ['', '1. e4 e5 2. Nf9 1-0', '[Event "x"]\n1. e4 {unclosed', '1. e4 e5', 'hello world'];
  for (const text of cases) {
    const r = readGames(text);
    assert.equal(r.ok, false, text);
    if (!r.ok) {
      assert.match(r.message, /^[A-Z].*\.$/s, 'one plain sentence or two');
      assert.doesNotMatch(r.message, /undefined|Error|SAN|FEN|\bply\b/);
    }
  }
  const eleven = Array.from({ length: MAX_GAMES + 1 }, () => GAME_A).join('\n');
  const r = readGames(eleven);
  assert.ok(!r.ok && /at most 10/.test(r.message));
  const many = Array.from({ length: 21 }, () => GAME_A).join('\n');
  const r2 = readGames(many);
  assert.ok(!r2.ok && /at most 10/.test(r2.message));
});

test('side detection: names in settings, case-insensitive; no match or both sides means ask', async () => {
  const h = { White: 'Alex Example', Black: 'Someone Else' };
  assert.equal(detectSide(h, ['  alex example ']), 'w');
  assert.equal(detectSide(h, ['Nobody']), null);
  assert.equal(detectSide(h, []), null);
  assert.equal(detectSide(h, ['Alex Example', 'Someone Else']), null, 'both players are his names: ask');
  assert.equal(detectSide({ White: 'Alex Example', Black: 'Alex Example' }, ['Alex Example']), null);
  assert.deepEqual(cleanNames([' A ', 'a', '', 'B'.repeat(80)]), ['A', 'B'.repeat(60)]);
  // No match: the import refuses to run until he says which side he played, then uses his choice.
  const store = createFakeStore();
  const read = readGames(GAME_A);
  assert.ok(read.ok);
  const prepared = await prepareGames(read.games, [], store);
  assert.equal(prepared[0].side, null);
  await assert.rejects(runImport({ prepared, engine: stubEngine(SCRIPT), store }), /Choose which side/);
  const done = await runImport({ prepared, sides: { [prepared[0].gameId]: 'b' }, engine: stubEngine(SCRIPT), store, now: () => T });
  assert.equal(done.positions, 1);
});

test('a position already in his practice is not made twice', async () => {
  const known = [{ id: 'pack-999:12', fen: fenBefore(A_MOVES, 6) }];
  const { summary, store } = await importText(GAME_A, createFakeStore(), { knownCards: known });
  assert.equal(summary.positions, 0);
  assert.equal(summary.skippedKnown, 1);
  assert.ok(!('personal/111222333' in store.dump()), 'no empty personal document');
  assert.equal((store.dump()['games/111222333'] as GameDoc).mistakes.length, 1, 'the mistake is still recorded on the game');
});

test('the size guard: a game too large to save is skipped before any engine work', async () => {
  const huge = GAME_B.replace('1. e4', `{${'€'.repeat(70_000)}} 1. e4`);
  const store = createFakeStore();
  const read = readGames(huge);
  assert.ok(read.ok);
  const prepared = await prepareGames(read.games, NAMES, store);
  assert.match(prepared[0].problem ?? '', /too large to save \(over 180 KB\)/);
  const engine = stubEngine(SCRIPT);
  const summary = await runImport({ prepared, engine, store });
  assert.equal(summary.games, 0);
  assert.equal(summary.skippedProblem, 1);
  assert.equal(engine.calls.length, 0);
  assert.deepEqual(Object.keys(store.dump()), []);
});

test('ids: chess.com game number from Link or Site; anything else stays out of the pack namespace', () => {
  assert.equal(chesscomGameId({ Link: 'https://www.chess.com/game/live/123456789' }), '123456789');
  assert.equal(chesscomGameId({ Site: 'https://www.chess.com/game/daily/42?tab=review' }), '42');
  assert.equal(chesscomGameId({ Site: 'Chess.com' }), null);
  assert.equal(chesscomGameId({ Link: 'https://example.org/game/live/1' }), null);
  assert.equal(cardIdOf('123', 7), 'pack-123:7');
  assert.equal(cardIdOf('game-1a2b3c4d', 7), 'page-game-1a2b3c4d:7');
  assert.equal(positionKey('8/8/8/8/8/8/8/K6k w - - 3 40'), '8/8/8/8/8/8/8/K6k w - -');
  assert.ok(paths.game('123'));
  assert.equal(readDoc('personal/x', { puzzles: [] }) !== null, true);
});

test('a search stopped short of the depth is not judged: no mistake, no card', async () => {
  const shallow = Object.fromEntries(Object.entries(A_SCRIPT).map(([k, lines]) => [k, lines.map(l => ({ ...l, depth: 3 }))]));
  const store = createFakeStore();
  const read = readGames(GAME_A);
  assert.ok(read.ok);
  const prepared = await prepareGames(read.games, NAMES, store);
  const summary = await runImport({ prepared, engine: stubEngine(shallow), store, now: () => T });
  assert.equal(summary.positions, 0);
  assert.equal((store.dump()['games/111222333'] as GameDoc).mistakes.length, 0);
});

test('a game that only goes over the size limit with its engine lines is skipped alone', async () => {
  const withComment = (n: number) => GAME_A.replace('1. e4', `{${'€'.repeat(n)}} 1. e4`);
  const parsed = (n: number) => { const r = readGames(withComment(n)); assert.ok(r.ok); return r.games[0]; };
  const g0 = parsed(0);
  const base = docBytes({ pgn: g0.pgn, headers: g0.headers, importedAt: 0, mistakes: [] }) + 2; // the braces
  const n = Math.floor((MAX_DOC_BYTES - 100 - base) / 3);
  const store = createFakeStore();
  const read = readGames(`${withComment(n)}\n${GAME_B}`);
  assert.ok(read.ok);
  const prepared = await prepareGames(read.games, NAMES, store);
  assert.equal(prepared[0].problem, undefined, 'passes the pre-check without engine lines');
  const summary = await runImport({ prepared, engine: stubEngine(SCRIPT), store, now: () => T });
  assert.equal(summary.games, 1, 'the other game is still saved');
  assert.equal(summary.skippedProblem, 1);
  assert.ok(!('games/111222333' in store.dump()));
  assert.ok(`games/${prepared[1].gameId}` in store.dump());
});

// D14: the frozen version-4 contract (`tests/fixtures/v4_docs.ts`, made by chess-m2-ui). Never skipped.
test('a version-4 page reads the documents unchanged (D14: the frozen version-4 contract)', async () => {
  const { store } = await importText(`${GAME_A}\n${GAME_B}`);
  const dump = store.dump();
  const written = pageDocs(dump);
  assert.equal(written.length, 4);
  // Version 4 does not know the M2 marker `origin` and strips it on read; everything else reads unchanged.
  const withoutOrigin = (d: unknown) => JSON.parse(JSON.stringify(d, (k, v) => (k === 'origin' ? undefined : v)));
  for (const path of written) {
    assert.deepEqual(v4.prepareWrite(path, dump[path]), withoutOrigin(dump[path]), `${path} under the frozen version-4 schema`);
    assert.deepEqual(v4.readDoc(path, dump[path]), withoutOrigin(dump[path]));
  }
  const cards = written.filter(p => p.startsWith('personal/')).flatMap(p => (dump[p] as PersonalDoc).puzzles);
  assert.ok(cards.length === 2 && cards.every(c => c.origin === 'page'), 'every page-made card carries origin: page');
  // Practice on these cards is recorded with source `personal` (pools.ts), one of the version-4 values.
  assert.ok((v4.ATTEMPT_SOURCES as readonly string[]).includes('personal'));
});

/** A fake store whose reads pass through `f` (to fake cached, pending or altered views). */
const wrapGet = (s: FakeStore, f: (d: StoreDoc | null, path: string) => StoreDoc | null): FakeStore =>
  ({ ...s, get: (async (path: string) => f(await s.get(path), path)) as Store['get'] });

test('read-back: a game counts as saved only when a fresh read returns what was written', async () => {
  const read = readGames(`${GAME_A}\n${GAME_B}`);
  assert.ok(read.ok);
  // A store whose `set` resolves but stores nothing.
  const base = createFakeStore();
  const prepared = await prepareGames(read.games, NAMES, base);
  const forgetful = { ...base, set: async () => undefined };
  await assert.rejects(runImport({ prepared, engine: stubEngine(SCRIPT), store: forgetful, now: () => T, readBackDelaysMs: [1] }),
    (e: unknown) => e instanceof ImportWriteError && e.savedGames === 0 && /^Saved 0 of 2 games .*Try again/.test(e.message));
  // A store that only ever offers a cached view: never confirmed, so not counted.
  const s2 = createFakeStore();
  const cached = wrapGet(s2, d => d && { ...d, meta: { fromCache: true, hasPendingWrites: false } });
  await assert.rejects(runImport({ prepared, engine: stubEngine(SCRIPT), store: cached, now: () => T, readBackDelaysMs: [1, 1] }), ImportWriteError);
  // A store whose first read is a pending view and the next one fresh: confirmed after one wait.
  const s3 = createFakeStore();
  const seen = new Map<string, number>();
  const pendingOnce = wrapGet(s3, (d, path) => {
    const n = (seen.get(path) ?? 0) + 1; seen.set(path, n);
    return d && n === 1 ? { ...d, meta: { fromCache: false, hasPendingWrites: true } } : d;
  });
  const ok = await runImport({ prepared, engine: stubEngine(SCRIPT), store: pendingOnce, now: () => T, readBackDelaysMs: [1] });
  assert.equal(ok.games, 2);
  // A fresh read that differs fails at once.
  const s4 = createFakeStore();
  const altered = wrapGet(s4, d => d && { ...d, data: { ...d.data, importedAt: 1 } });
  await assert.rejects(runImport({ prepared, engine: stubEngine(SCRIPT), store: altered, now: () => T, readBackDelaysMs: [] }), ImportWriteError);
});

test('review R-1: personal/<id> is confirmed before games/<id> is written; a retry redoes the game', async () => {
  // (a) `set` on personal/* resolves but stores nothing: the import fails and the game is NOT marked finished.
  const base = createFakeStore();
  const lossy: FakeStore = { ...base, set: (async (path: string, data: Record<string, unknown>) => (path.startsWith('personal/') ? undefined : base.set(path, data))) as Store['set'] };
  const read = readGames(GAME_A);
  assert.ok(read.ok);
  const prepared = await prepareGames(read.games, NAMES, lossy);
  await assert.rejects(runImport({ prepared, engine: stubEngine(SCRIPT), store: lossy, now: () => T, readBackDelaysMs: [1] }),
    (e: unknown) => e instanceof ImportWriteError && e.savedGames === 0);
  assert.deepEqual(Object.keys(base.dump()), [], 'no games/<id>: nothing marks the game finished');
  const retry = await importText(GAME_A, base);
  assert.equal(retry.prepared[0].already, false);
  assert.equal(retry.summary.games, 1);
  assert.deepEqual(Object.keys(base.dump()).sort(), ['games/111222333', 'personal/111222333']);

  // (b) games/<id> fails after personal/<id> landed: the retry rewrites both, with no duplicate card.
  const s2 = createFakeStore();
  let failedOnce = false;
  const gameFails: FakeStore = { ...s2, set: (async (path: string, data: Record<string, unknown>) => {
    if (path.startsWith('games/') && !failedOnce) { failedOnce = true; throw new Error('connection lost'); }
    return s2.set(path, data);
  }) as Store['set'] };
  const p2 = await prepareGames(read.games, NAMES, gameFails);
  await assert.rejects(runImport({ prepared: p2, engine: stubEngine(SCRIPT), store: gameFails, now: () => T, readBackDelaysMs: [1] }), ImportWriteError);
  const firstPersonal = JSON.stringify(s2.dump()['personal/111222333']);
  assert.ok(firstPersonal && !('games/111222333' in s2.dump()));
  const again = await importText(GAME_A, gameFails);
  assert.equal(again.summary.games, 1);
  const personal = s2.dump()['personal/111222333'] as PersonalDoc;
  assert.equal(JSON.stringify(personal), firstPersonal, 'rewritten under the same id with the same content');
  assert.deepEqual(personal.puzzles.map(p => p.id), ['pack-111222333:6'], 'one card, not two');
  assert.equal(s2.writeCounts.get('personal/111222333'), 2);
  assert.ok('games/111222333' in s2.dump());
});

test('read-back is a subset check: extra fields from the database are fine; a changed or missing written field fails', async () => {
  const read = readGames(`${GAME_A}\n${GAME_B}`);
  assert.ok(read.ok);
  const run = async (f: (d: StoreDoc | null, path: string) => StoreDoc | null) => {
    const s = createFakeStore();
    const store = wrapGet(s, f);
    const prepared = await prepareGames(read.games, NAMES, store);
    return runImport({ prepared, engine: stubEngine(SCRIPT), store, now: () => T, readBackDelaysMs: [1] });
  };
  // The database adds a field of its own: the import succeeds.
  const ok = await run(d => d && { ...d, data: { ...d.data, _serverStamp: 12345 } });
  assert.equal(ok.games, 2);
  // A written field comes back changed: the import fails.
  await assert.rejects(run(d => d && (d.path.startsWith('personal/') ? { ...d, data: { ...d.data, gameId: 'other' } } : d)), ImportWriteError);
  // A written field is missing: the import fails.
  await assert.rejects(run(d => { if (!d || !d.path.startsWith('games/')) return d; const { mistakes: _m, ...rest } = d.data as Record<string, unknown>; return { ...d, data: rest }; }), ImportWriteError);
  // A nested written value that differs fails too (deep-equal inside a field).
  await assert.rejects(run(d => d && (d.path.startsWith('games/') ? { ...d, data: { ...d.data, headers: { ...(d.data.headers as object), White: 'x' } } } : d)), ImportWriteError);
});
