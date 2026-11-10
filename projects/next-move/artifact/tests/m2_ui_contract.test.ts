import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSafeCardId, paths, parseSafeChunkId, prepareWrite, readDoc, safeCardDoc, safeShare, schemaForPath, MAX_DOC_ERRORS,
  type PlanDoc, type SafeChunkDoc, type SafeMetaDoc, type SnapshotDoc,
} from '../src/contract/docs';
import { HAVE_SEED, HAVE_SEED_M2, loadSeedDocs, SEED_DIR, SEED_M2_DIR } from './m2_ui_seed';
import * as v4 from './fixtures/v4_docs';

// Invented values only (rule 4): no real pack version, ids, games or rates.
const FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
const now = 1_794_300_000_000;
const VER = 'v20990101a';

export const safeCardSample = (n: number, kind: 'safe' | 'unsafe') => ({
  id: `judge-g${n}:${10 + n}`, kind, fen: FEN, moves: ['f1c4'], rating: 1000, themes: ['personal', 'safety', 'opening'],
  title: 'Safe or not? · Rapid · 2099-01-01 · move 3',
  question: { playedUci: 'f1c4', playedSan: 'Bc4', side: 'w' },
  reveal: {
    verdict: kind, playedSan: 'Bc4', winBefore: 50, winAfter: kind === 'safe' ? 49 : 20, explanation: kind === 'safe' ? 'Safe. Invented.' : 'Not safe. Invented.',
    bestUci: 'f1b5', bestSan: 'Bb5', bestLineSan: ['Bb5', 'a6'], replyLineUci: ['c6d4'], replyLineSan: ['Nd4'], gameUrl: 'https://example.invalid/game/1',
  },
});

test('D1 paths: safe/meta and safe/<ver>-NN', () => {
  assert.equal(paths.safeMeta(), 'safe/meta');
  assert.equal(paths.safeChunk(VER, 3), `safe/${VER}-03`);
  assert.equal(paths.safeChunkById(`${VER}-12`), `safe/${VER}-12`);
  assert.deepEqual(parseSafeChunkId(`${VER}-07`), { packVersion: VER, index: 7 });
  assert.equal(parseSafeChunkId('meta'), null);
  assert.equal(parseSafeChunkId('nonumber'), null);
});

test('D1 schemas: safe/meta and a safe chunk parse; kind is required and limited to safe|unsafe', () => {
  const meta = { packVersion: VER, chunks: [`${VER}-00`, `${VER}-01`], counts: { safeCards: 2, unsafeCards: 2 }, importedAt: '2099-01-01T00:00:00Z', extra: 1 };
  const m = readDoc<SafeMetaDoc>(paths.safeMeta(), meta);
  assert.ok(m);
  assert.equal((m as Record<string, unknown>).extra, 1, 'agent doc keeps unknown fields');
  const chunk = { packVersion: VER, cards: [safeCardSample(1, 'safe'), safeCardSample(2, 'unsafe')] };
  const c = readDoc<SafeChunkDoc>(paths.safeChunk(VER, 0), chunk);
  assert.ok(c);
  assert.equal(c!.cards[1].kind, 'unsafe');
  assert.equal((c!.cards[0].reveal as Record<string, unknown>).verdict, 'safe', 'reveal passes through');
  assert.equal(readDoc(paths.safeChunk(VER, 0), { cards: [{ ...safeCardSample(1, 'safe'), kind: 'punish' }] }), null);
  const { kind: _k, ...noKind } = safeCardSample(1, 'safe');
  assert.equal(readDoc(paths.safeChunk(VER, 0), { cards: [noKind] }), null);
  assert.equal(readDoc(paths.safeMeta(), { packVersion: VER, counts: {} }), null, 'chunks required');
  assert.ok(schemaForPath('safe/meta') !== schemaForPath(`safe/${VER}-00`));
});

test('D3 mix.safe: optional, outside the sum rule; safeShare applies default, off and cap', () => {
  const plan = { updatedAt: now, author: 'claude', expires: now + 1e9, focus: [], mix: { bank: 0.3, pack: 0.5, endgame: 0.1, agent: 0.1 } };
  assert.ok(readDoc<PlanDoc>(paths.plan(), plan));
  const withSafe = readDoc<PlanDoc>(paths.plan(), { ...plan, mix: { ...plan.mix, safe: 0.3 } });
  assert.equal(withSafe?.mix.safe, 0.3);
  assert.equal(readDoc(paths.plan(), { ...plan, mix: { ...plan.mix, safe: -0.1 } }), null);
  assert.equal(safeShare(undefined), 0.15);
  assert.equal(safeShare(0), 0);
  assert.equal(safeShare(0.3), 0.3);
  assert.equal(safeShare(0.9), 0.5);
});

test('D10 docErrors: optional on derived/snapshot, at most 20', () => {
  const snap = {
    computedAt: now, attemptsTotal: 0, approxBytes: 0, last7d: { attempts: 0, firstTryRate: null }, last30d: { attempts: 0, firstTryRate: null },
    themes: {}, weakest: [], due: { count: 0, overdue: 0, nextIds: [] }, sources: { bank: 0, pack: 0, endgame: 0, personal: 0, agent: 0 },
    packCoverage: { seen: 0, total: 0 }, lastSession: null,
  };
  assert.ok(prepareWrite(paths.snapshot(), snap));
  const errs = Array.from({ length: MAX_DOC_ERRORS }, (_, i) => ({ path: `drills/set${i}`, issue: 'cards.0.rating: Required', at: now + i }));
  const ok = prepareWrite<SnapshotDoc>(paths.snapshot(), { ...snap, docErrors: errs });
  assert.equal(ok.docErrors?.length, 20);
  assert.throws(() => prepareWrite(paths.snapshot(), { ...snap, docErrors: [...errs, errs[0]] }));
});

test('every seed/ document still parses (and seed_m2/ when present)', { skip: !HAVE_SEED }, () => {
  for (const dir of [SEED_DIR, ...(HAVE_SEED_M2 ? [SEED_M2_DIR] : [])]) {
    const docs = loadSeedDocs(dir);
    assert.ok(docs.length > 0);
    for (const d of docs) assert.ok(readDoc(d.path, d.data), `${d.path} parses`);
  }
});

test('version-4 contract (frozen fixture, D14) reads the M2 additions', () => {
  const plan = { updatedAt: now, author: 'claude', expires: now + 1e9, focus: [], mix: { bank: 0.3, pack: 0.5, endgame: 0.1, agent: 0.1, safe: 0.2 } };
  assert.ok(v4.readDoc(v4.paths.plan(), plan), 'v4 parses a plan with mix.safe');
  const snap = {
    computedAt: now, attemptsTotal: 0, approxBytes: 0, last7d: { attempts: 0, firstTryRate: null }, last30d: { attempts: 0, firstTryRate: null },
    themes: {}, weakest: [], due: { count: 0, overdue: 0, nextIds: [] }, sources: { bank: 0, pack: 0, endgame: 0, personal: 0, agent: 0 },
    packCoverage: { seen: 0, total: 0 }, lastSession: null, docErrors: [{ path: 'plan/current', issue: 'x', at: now }],
  };
  assert.ok(v4.readDoc('derived/snapshot', snap), 'v4 parses a snapshot with docErrors');
  // An M2 "Safe or not?" attempt as the M2 page records it: v4 parses the session doc.
  const session = { device: 'dabc123', startedAt: now, attempts: [
    { puzzleId: 'judge-g1:11', themes: ['personal', 'safety'], correct: true, unassisted: true, hints: 0, revealed: false, durationMs: 3000, at: now + 1, source: 'pack', verdict: 'unsafe' },
    { puzzleId: 'judge-g2:12', themes: ['personal', 'safety'], correct: false, unassisted: false, hints: 0, revealed: false, durationMs: 3000, at: now + 2, source: 'pack' },
  ] };
  const parsed = v4.readDoc<{ attempts: unknown[] }>('sessions/s-1-dabc123', session);
  assert.equal(parsed?.attempts.length, 2);
  // v4 has no `safe` collection: it never reads these documents.
  assert.equal(v4.readDoc('safe/meta', { packVersion: VER, chunks: [], counts: {} }), null);
});

test('cards in the current seed_m2 safe chunks parse as SafeCard (counts only)', { skip: !HAVE_SEED_M2 }, () => {
  const docs = loadSeedDocs(SEED_M2_DIR);
  const cards = docs
    .filter(d => /^(pack\/.+-safe-\d{2,}|safe\/(?!meta$).+)$/.test(d.path))
    .flatMap(d => (d.data.cards as unknown[]) ?? []);
  assert.ok(cards.length > 0, 'seed_m2 holds safe cards');
  let ok = 0;
  for (const c of cards) if (safeCardDoc.safeParse(c).success) ok++;
  assert.equal(ok, cards.length, `${cards.length - ok} of ${cards.length} safe cards fail safeCardDoc`);
  for (const c of cards as Array<{ id: string }>) assert.ok(isSafeCardId(c.id), 'safe card ids use the judge- prefix');
});
