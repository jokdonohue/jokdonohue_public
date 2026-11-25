import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeStore, createMemoryKv, type DocData } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { createTrainerModel, settingsFrom } from '../components/model';
import { buildPools, positionKey } from '../components/pools';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_DIR } from './b3_paths';
import type { LoadedPack } from '../components/model';

// Cross-stream requests from chess-m2-pgn (R-PGN-1, R-PGN-2). Invented values only.
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const START = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';

test('R-PGN-1: settings keep myNames; saving myNames keeps fields this page does not edit', async () => {
  assert.deepEqual(settingsFrom({ rating: 1000, sessionLength: 10, updatedAt: 1, device: 'd1', myNames: ['Player One', 'p1'] }).myNames, ['Player One', 'p1']);
  assert.equal(settingsFrom({ rating: 1000, sessionLength: 10, updatedAt: 1, device: 'd1' }).myNames, undefined);
  const store = createFakeStore({ seed: { 'settings/main': { rating: 1100, sessionLength: 12, updatedAt: 5, device: 'phone', lastIngest: '2099-01-01T00:00:00Z', chesscomUser: 'someone' } } });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'laptop', events: null, debounceMs: 1 });
  const model = createTrainerModel({ store, sessions, deviceId: 'laptop', readyTimeoutMs: 1000 });
  await tick(20);
  assert.equal(await model.saveSettings({ myNames: ['Player One'] }), true);
  const saved = (await store.get('settings/main'))!.data as DocData;
  assert.deepEqual(saved.myNames, ['Player One']);
  assert.equal(saved.lastIngest, '2099-01-01T00:00:00Z');
  assert.equal(saved.chesscomUser, 'someone');
  assert.deepEqual(model.get().settings.myNames, ['Player One']);
  model.dispose(); sessions.dispose();
});

test('R-PGN-2: a pack card supersedes a page-made personal card with the same id', () => {
  const id = 'pack-g100:21';
  const pack = { version: 'v1', meta: {} as LoadedPack['meta'], cards: [{ id, fen: START, moves: ['a1a8'], rating: 1000, themes: ['fork'] }], punish: [], study: [], punishStudy: [] } as unknown as LoadedPack;
  const pools = buildPools({ bank: [], endgames: [], pack, personal: [{ id, fen: START, moves: ['a1a8'], rating: 1000, themes: ['personal'] }], drills: [] });
  assert.equal(pools.byId.get(id)?.source, 'pack');
  assert.equal(pools.own.filter(p => p.id === id).length, 1);
});

test('R-PGN-4: a page-made personal position already covered by a pack card (any id) is not practised twice', () => {
  const pack = { version: 'v1', meta: {} as LoadedPack['meta'], cards: [{ id: 'pack-g200:31', fen: START, moves: ['a1a8'], rating: 1000, themes: ['fork'] }], punish: [], study: [], punishStudy: [] } as unknown as LoadedPack;
  const pools = buildPools({ bank: [], endgames: [], pack, personal: [
    { id: 'pack-g100:21', fen: START.replace(/ 0 1$/, ' 4 9'), moves: ['a1a8'], rating: 1000, themes: ['personal'], origin: 'page' as const },
    { id: 'personal-other', fen: '8/8/8/8/8/8/8/K6k w - - 0 1', moves: ['a1a2'], rating: 1000, themes: ['personal'] },
  ], drills: [] });
  assert.deepEqual(pools.own.map(p => p.id).sort(), ['pack-g200:31', 'personal-other']);
  assert.equal(positionKey('a b c d 5 6'), 'a b c d');
});

test('R-PGN-3: PgnImport is a static import, mounted on My games only after he opens it', () => {
  const src = readFileSync(join(ARTIFACT_DIR, 'components/Trainer.tsx'), 'utf8');
  assert.match(src, /^import PgnImport from '\.\/pgn\/PgnImport';$/m);
  assert.doesNotMatch(src, /\bimport\(/, 'no dynamic import: the strict build stays one classic script');
  assert.match(src, /\{pgnOpen && <div className="page pgn-mount" hidden=\{tab !== 'games'\}><PgnImport /, 'stays mounted on other tabs, so a running check is not stopped');
});

// Fix pass P2-2, from the reviewer's reproduction (reviews/claude/logs/m2_review_tmp/r_dedupe.test.ts).
test('P2-2: a Site-backup personal position sharing a pack position stays in the pools, with its own id', () => {
  const FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
  const site = { id: 'site-legacy-1', fen: FEN, moves: ['f1c4'], rating: 1000, themes: ['personal'] };
  const pack = { version: 'v', meta: {} as never, cards: [{ id: 'pack-1:5', fen: FEN.replace(' 2 3', ' 4 5'), moves: ['f1c4'], rating: 1000, themes: ['personal'] }], punish: [], study: [], punishStudy: [] };
  const pools = buildPools({ bank: [], endgames: [], pack: pack as never, personal: [site], drills: [] });
  assert.equal(pools.byId.has('site-legacy-1'), true, 'kept, as in version 4');
  assert.equal(pools.byId.has('pack-1:5'), true);
  const pageMade = buildPools({ bank: [], endgames: [], pack: pack as never, personal: [{ ...site, id: 'pack-9:3', origin: 'page' as const }], drills: [] });
  assert.equal(pageMade.byId.has('pack-9:3'), false, 'a page-made copy still gives way');
});
