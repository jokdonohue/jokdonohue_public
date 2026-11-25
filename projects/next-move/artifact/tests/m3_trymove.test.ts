/**
 * M3 A4: the live check of a wrong try (`src/teach/tryMove.ts`, brief L4/L12).
 * Positions are textbook patterns written for these tests (forks, back-rank mates, stalemate traps), each with a
 * colour-swapped twin so both solver colours are checked. A scripted stub stands in for the engine; four tests
 * drive the real worker driver (`createWorkerEngine`) with a fake UCI worker whose scores are in the side-to-move
 * view, as Stockfish prints them. Scripted scores and lines come from the bundled Stockfish 19 lite at depth 12 on the
 * White-to-move positions (run 2026-11-12, see logs/m3_A4.md). Each Black twin uses the mirrored score, and the
 * mirrored line except the fork twin, which keeps the engine's own line. Values marked "scripted" are made up for the
 * case under test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import type { EngineScore } from '../lib/chess-engine';
import { createWorkerEngine, isAbort, type AnalysisEngine } from '../src/analysis/engine';
import {
  checkTry, getSharedEngine, isTimeout, searchOnce, solverWin, tryVerdict,
  REPLY_PLIES, START_ALLOWANCE_MS, TRY_DEPTH, TRY_MAX_MS,
} from '../src/teach/tryMove';

// Level material; the knight on b5 forks with Nc7+ (king e8, rook a8). Twin: the knight on b4 forks with Nc2+.
const FORK_W = 'r3k2r/pp3ppp/3p1n2/1N6/8/8/PPP2PPP/R3K2R w KQkq - 0 1';
const FORK_B = 'r3k2r/ppp2ppp/8/8/1n6/3P1N2/PP3PPP/R3K2R b KQkq - 0 1';
// Back rank: Ra8 mates (twin: Ra1 mates).
const RANK_W = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const RANK_B = 'r5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1';
// King and queen against king: Qg7 mates, Qg6 is stalemate (twin: Qg2 mates, Qg3 is stalemate).
const STALE_W = '7k/8/5K2/8/8/8/6Q1/8 w - - 0 1';
const STALE_B = '8/6q1/8/8/8/5k2/8/7K b - - 0 1';
// Qxd8 is mate; Qd7 hangs the queen to the rook (twin: Qxd1 mate, Qd2 hangs).
const HANG_W = '3r2k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1';
const HANG_B = '3q2k1/5ppp/8/8/8/8/5PPP/3R2K1 b - - 0 1';
// h3 makes room for the king; Ra7 allows Re1 mate (twin: h6, Ra2 allows Re8 mate).
const BACK_W = '4r1k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const BACK_B = 'r5k1/5ppp/8/8/8/8/5PPP/4R1K1 b - - 0 1';
// A pawn on the seventh: a8=Q against a8=N (king and knight against king cannot mate).
const PROMO_W = '8/P7/8/8/8/8/8/k6K w - - 0 1';

const key = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
function after(fen: string, uci: string): string {
  const c = new Chess(fen);
  c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return c.fen();
}
const cp = (n: number): EngineScore => ({ cp: n, mate: null });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Scripted { pv: string[]; score: EngineScore; depth?: number }
interface StubOptions { delayMs?: number; hang?: boolean; ignoreAbort?: boolean; fail?: Error }
interface Stub extends AnalysisEngine {
  calls: Array<{ fen: string; depth: number; multiPv: number; signal?: AbortSignal }>;
  overlaps: number;
}
/** Scripted engine keyed by the first four FEN fields; scores in White's view (the driver's convention). Refuses overlapping searches like the worker driver. */
function stub(script: Record<string, Scripted>, o: StubOptions = {}): Stub {
  let running = 0;
  const s: Stub = {
    calls: [], overlaps: 0,
    async analyse(fen, { depth, multiPv, signal }) {
      if (running) { s.overlaps++; throw new Error('The engine is already busy.'); }
      running++;
      s.calls.push({ fen, depth, multiPv, signal });
      try {
        await new Promise<void>((resolve, reject) => {
          if (o.hang && o.ignoreAbort) return;
          const timer = o.hang ? undefined : setTimeout(resolve, o.delayMs ?? 0);
          if (!o.ignoreAbort) signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Analysis stopped.', 'AbortError')); }, { once: true });
        });
        if (o.fail) throw o.fail;
        const line = script[key(fen)];
        if (!line) throw new Error(`no script for ${fen}`);
        return [{ multipv: 1, depth: line.depth ?? depth, score: line.score, pv: line.pv }];
      } finally { running--; }
    },
    dispose() {},
  };
  return s;
}

/** Fork twins: a quiet try (a3 / a6) against the fork. `tryDepth` (scripted) overrides the reached depth of the try search. */
const FORK_A3 = ['e8d7', 'e1c1', 'd6d5', 'd1d3', 'a7a6', 'b5c3', 'd7c6'];
const FORK_A6 = ['e1d2', 'e8c8', 'd3d4', 'd8d6', 'h1e1', 'd6b6', 'e1c1'];
const forkScript = (tryDepth?: number): Record<string, Scripted> => ({
  [key(after(FORK_W, 'a2a3'))]: { pv: FORK_A3, score: cp(76), depth: tryDepth },
  [key(after(FORK_W, 'b5c7'))]: { pv: ['e8d7', 'c7a8', 'h8e8', 'e1f1', 'e8a8', 'f2f3'], score: cp(428) },
  [key(after(FORK_B, 'a7a6'))]: { pv: FORK_A6, score: cp(-76), depth: tryDepth },
  [key(after(FORK_B, 'b4c2'))]: { pv: ['e1d2', 'c2a1', 'h1e1', 'e8f8', 'd3d4'], score: cp(-428) },
});

test('Win% from an engine score: White\'s view in, the solver\'s view out; a mate is 100 or 0', () => {
  assert.equal(solverWin(cp(0), 'w', 'b'), 50);
  assert.equal(solverWin(cp(0), 'b', 'w'), 50);
  assert.equal(solverWin(cp(100), 'w', 'b'), 59.1);
  assert.equal(solverWin(cp(100), 'b', 'w'), 40.9);
  assert.equal(solverWin(cp(-150), 'w', 'b'), 36.5);
  assert.equal(solverWin(cp(-150), 'b', 'w'), 63.5);
  assert.equal(solverWin(cp(230), 'w', 'b'), 70);
  assert.equal(solverWin(cp(1300), 'w', 'b'), 97.5, 'centipawns are ceiled at 1000 as everywhere in the app (values.ts)');
  assert.equal(solverWin(cp(-1300), 'w', 'b'), 2.5);
  assert.equal(solverWin({ cp: null, mate: 3 }, 'w', 'b'), 100, 'White mates');
  assert.equal(solverWin({ cp: null, mate: 3 }, 'b', 'w'), 0);
  assert.equal(solverWin({ cp: null, mate: -2 }, 'w', 'b'), 0, 'Black mates');
  assert.equal(solverWin({ cp: null, mate: -2 }, 'b', 'w'), 100);
  assert.equal(solverWin({ cp: null, mate: 0, mated: 'b' }, 'w', 'b'), 100, 'the searched position is mate: `mated` decides');
  assert.equal(solverWin({ cp: null, mate: 0, mated: 'w' }, 'b', 'w'), 100);
  assert.equal(solverWin({ cp: null, mate: 0, mated: 'w' }, 'w', 'w'), 0);
  assert.equal(solverWin({ cp: null, mate: -0 }, 'w', 'b'), 100, 'mate 0 without `mated`: the side to move is mated');
  assert.equal(solverWin({ cp: null, mate: 0 }, 'b', 'b'), 0);
  assert.throws(() => solverWin({ cp: null, mate: null }, 'w', 'b'), /no score/);
  for (const n of [-900, -230, -17, 0, 42, 230, 900]) {
    assert.equal(Math.round((solverWin(cp(n), 'w', 'b') + solverWin(cp(n), 'b', 'w')) * 10), 1000, `both sides add up to 100 at ${n} cp`);
  }
});

test('verdict thresholds (L4): also-good >= max(65, best - 5), losing < 35, worse between', () => {
  assert.equal(tryVerdict(65, null), 'also-good', 'no answer to compare: the flat 65 bar');
  assert.equal(tryVerdict(64.9, null), 'worse');
  assert.equal(tryVerdict(35, null), 'worse');
  assert.equal(tryVerdict(34.9, null), 'losing');
  assert.equal(tryVerdict(91, 96), 'also-good');
  assert.equal(tryVerdict(90.9, 96), 'worse');
  assert.equal(tryVerdict(65.3, 70.3), 'also-good', 'one-decimal arithmetic: 70.3 - 5 = 65.3');
  assert.equal(tryVerdict(65.2, 70.3), 'worse');
  assert.equal(tryVerdict(65, 60), 'also-good', 'the floor applies when the answer scores lower');
  assert.equal(tryVerdict(64, 60), 'worse', 'under 65 is never also-good, even when it beats the answer (logged for C)');
  assert.equal(tryVerdict(53.1, 52.2), 'worse', 'real case: after 1.e4 e5 2.Qh5 Nc6 3.Bc4, Qe7 scored 53.1 and g6 52.2 at depth 12 (logged for C)');
  assert.equal(tryVerdict(100, 100), 'also-good');
  assert.equal(tryVerdict(0, 100), 'losing');
});

test('a quiet try against a fork: both positions searched, the reply line cut to 6 plies (White solver)', async () => {
  const engine = stub(forkScript());
  const r = await checkTry(engine, FORK_W, 'a2a3', 'b5c7');
  assert.equal(r.tryUci, 'a2a3');
  assert.equal(r.trySan, 'a3');
  assert.deepEqual(r.replyLine, FORK_A3.slice(0, 6));
  assert.equal(r.replyLine.length, REPLY_PLIES);
  assert.equal(r.tryWin, 57);
  assert.equal(r.bestWin, 82.9);
  assert.equal(r.verdict, 'worse');
  assert.equal(r.depth, 12);
  assert.ok(Number.isInteger(r.ms) && r.ms >= 0);
  assert.deepEqual(engine.calls.map(c => [key(c.fen), c.depth, c.multiPv]), [
    [key(after(FORK_W, 'a2a3')), TRY_DEPTH, 1],
    [key(after(FORK_W, 'b5c7')), TRY_DEPTH, 1],
  ]);
});

test('the same check with Black to move gives the same numbers (scores stay in White\'s view)', async () => {
  const engine = stub(forkScript());
  const r = await checkTry(engine, FORK_B, 'a7a6', 'b4c2');
  assert.equal(r.trySan, 'a6');
  assert.deepEqual(r.replyLine, FORK_A6.slice(0, 6));
  assert.equal(r.tryWin, 57);
  assert.equal(r.bestWin, 82.9);
  assert.equal(r.verdict, 'worse');
});

test('a try that mates needs no search; the answer is still searched for comparison', async () => {
  for (const [fen, tryUci, answerUci, answerScore, reply] of [
    [RANK_W, 'a1a8', 'a1a7', cp(630), ['h7h6', 'a7a1', 'f7f5', 'a1a8', 'g8h7', 'g2g3', 'h6h5']],
    [RANK_B, 'a8a1', 'a8a2', cp(-630), ['h2h3', 'a2a8', 'f2f4', 'a8a1', 'g1h2', 'g7g6', 'h3h4']],
  ] as const) {
    const engine = stub({ [key(after(fen, answerUci))]: { pv: [...reply], score: answerScore } });
    const r = await checkTry(engine, fen, tryUci, answerUci);
    assert.equal(r.trySan, tryUci === 'a1a8' ? 'Ra8#' : 'Ra1#');
    assert.deepEqual(r.replyLine, []);
    assert.equal(r.tryWin, 100);
    assert.equal(r.bestWin, 91);
    assert.equal(r.verdict, 'also-good');
    assert.equal(r.depth, 12, 'the exact mate does not lower the depth');
    assert.deepEqual(engine.calls.map(c => key(c.fen)), [key(after(fen, answerUci))], 'only the answer position is searched');
  }
});

test('stalemate try against a mating answer: scored 50 and 100 with no engine call', async () => {
  for (const [fen, tryUci, answerUci, san] of [[STALE_W, 'g2g6', 'g2g7', 'Qg6'], [STALE_B, 'g7g3', 'g7g2', 'Qg3']] as const) {
    const engine = stub({});
    const r = await checkTry(engine, fen, tryUci, answerUci);
    assert.deepEqual({ ...r, ms: 0 }, { tryUci, trySan: san, replyLine: [], tryWin: 50, bestWin: 100, verdict: 'worse', depth: 0, ms: 0 });
    assert.equal(engine.calls.length, 0);
  }
});

test('a try that hangs the queen is losing; the mating answer is scored 100 without a search', async () => {
  for (const [fen, tryUci, answerUci, pv, score] of [
    [HANG_W, 'd1d7', 'd1d8', ['d8d7', 'f2f3', 'd7d8', 'f3f4', 'g8f8', 'f4f5', 'g7g6'], cp(-632)],
    [HANG_B, 'd8d2', 'd8d1', ['d1d2', 'f7f6', 'd2d1', 'f6f5', 'g1f1', 'f5f4', 'g2g3'], cp(632)],
  ] as const) {
    const engine = stub({ [key(after(fen, tryUci))]: { pv: [...pv], score } });
    const r = await checkTry(engine, fen, tryUci, answerUci);
    assert.deepEqual(r.replyLine, pv.slice(0, 6));
    assert.equal(r.tryWin, 8.9);
    assert.equal(r.bestWin, 100);
    assert.equal(r.verdict, 'losing');
    assert.equal(engine.calls.length, 1);
  }
});

test('a try that allows mate scores 0 for either solver', async () => {
  for (const [fen, tryUci, answerUci, mateLine, mate, level] of [
    [BACK_W, 'a1a7', 'h2h3', ['e8e1'], -1, cp(-9)],
    [BACK_B, 'a8a2', 'h7h6', ['e1e8'], 1, cp(9)],
  ] as const) {
    const engine = stub({
      [key(after(fen, tryUci))]: { pv: [...mateLine], score: { cp: null, mate } },
      [key(after(fen, answerUci))]: { pv: [tryUci === 'a1a7' ? 'g7g6' : 'g2g3'], score: level },
    });
    const r = await checkTry(engine, fen, tryUci, answerUci);
    assert.deepEqual(r.replyLine, mateLine);
    assert.equal(r.tryWin, 0);
    assert.equal(r.bestWin, 49.2);
    assert.equal(r.verdict, 'losing');
  }
});

test('no answer given: one search, bestWin null and the flat 65 bar', async () => {
  const engine = stub(forkScript());
  const good = await checkTry(engine, FORK_W, 'b5c7', null);
  assert.deepEqual([good.bestWin, good.tryWin, good.verdict], [null, 82.9, 'also-good']);
  const quiet = await checkTry(engine, FORK_W, 'a2a3', null);
  assert.deepEqual([quiet.bestWin, quiet.tryWin, quiet.verdict], [null, 57, 'worse']);
  assert.equal(engine.calls.length, 2);
});

test('the answer itself as the try: one search, the same Win% for both', async () => {
  const engine = stub(forkScript());
  const r = await checkTry(engine, FORK_W, 'b5c7', 'b5c7');
  assert.equal(r.trySan, 'Nc7+');
  assert.equal(r.tryWin, 82.9);
  assert.equal(r.bestWin, 82.9);
  assert.equal(r.verdict, 'also-good');
  assert.equal(engine.calls.length, 1);
});

test('promotions need the piece letter; an underpromotion to a lone knight is a draw without a search', async () => {
  const engine = stub({ [key(after(PROMO_W, 'a7a8q'))]: { pv: ['a1b2', 'a8a4', 'b2c3', 'h1g2', 'c3b2', 'a4c4'], score: cp(601) } });
  await assert.rejects(checkTry(engine, PROMO_W, 'a7a8', 'a7a8q'), /not a legal move/);
  const r = await checkTry(engine, PROMO_W, 'a7a8n', 'a7a8q');
  assert.equal(r.trySan, 'a8=N');
  assert.equal(r.tryWin, 50, 'king and knight against king: insufficient material');
  assert.deepEqual(r.replyLine, []);
  assert.equal(r.bestWin, 90.1, 'depth 12 sees a large edge after a8=Q, not yet a mate');
  assert.equal(r.verdict, 'worse');
  assert.deepEqual(engine.calls.map(c => key(c.fen)), [key(after(PROMO_W, 'a7a8q'))]);
});

test('illegal input rejects before any search, as an ordinary error', async () => {
  const engine = stub(forkScript());
  for (const [tryUci, answerUci] of [['e2e4', 'b5c7'], ['zz', 'b5c7'], ['a2a3', 'b5b6'], ['A2A3', null]] as const) {
    await assert.rejects(checkTry(engine, FORK_W, tryUci, answerUci), (e: unknown) => e instanceof Error && /not a legal move/.test(e.message) && !isAbort(e));
  }
  await assert.rejects(checkTry(engine, 'not a fen', 'a2a3', null), (e: unknown) => !isAbort(e));
  assert.equal(engine.calls.length, 0);
});

test('the engine line is replayed: cut at the first illegal ply; no legal reply at all rejects', async () => {
  // Scripted lines: b8b1 is illegal (no piece on b8), e2e4 is not a Black move.
  const cut = stub({ [key(after(FORK_W, 'a2a3'))]: { pv: ['e8d7', 'e1c1', 'b8b1', 'a7a6'], score: cp(76) }, [key(after(FORK_W, 'b5c7'))]: { pv: ['e8d7'], score: cp(428) } });
  assert.deepEqual((await checkTry(cut, FORK_W, 'a2a3', 'b5c7')).replyLine, ['e8d7', 'e1c1']);
  for (const pv of [['e2e4'], []]) {
    const bad = stub({ [key(after(FORK_W, 'a2a3'))]: { pv, score: cp(76) } });
    await assert.rejects(checkTry(bad, FORK_W, 'a2a3', 'b5c7'), /no legal reply/);
    assert.equal(bad.calls.length, 1, 'the answer search is not started');
  }
});

test('depth: the shallower of the two searches; options reach the engine', async () => {
  const engine = stub(forkScript(9));
  const r = await checkTry(engine, FORK_W, 'a2a3', 'b5c7');
  assert.equal(r.depth, 9);
  const deep = stub(forkScript());
  const r8 = await checkTry(deep, FORK_W, 'a2a3', 'b5c7', { depth: 8 });
  assert.deepEqual(deep.calls.map(c => c.depth), [8, 8]);
  assert.equal(r8.depth, 8);
});

test('an engine failure rejects with the engine\'s error, not an abort or a timeout', async () => {
  const engine = stub(forkScript(), { fail: new Error('The chess engine stopped unexpectedly.') });
  await assert.rejects(checkTry(engine, FORK_W, 'a2a3', 'b5c7'), (e: unknown) => e instanceof Error && /stopped unexpectedly/.test(e.message) && !isAbort(e) && !isTimeout(e));
});

test('abort before the call and during a search rejects with AbortError and stops the engine', async () => {
  const pre = new AbortController();
  pre.abort();
  const idle = stub(forkScript());
  await assert.rejects(checkTry(idle, FORK_W, 'a2a3', 'b5c7', { signal: pre.signal }), (e: unknown) => isAbort(e));
  assert.equal(idle.calls.length, 0);

  const engine = stub(forkScript(), { hang: true });
  const ctrl = new AbortController();
  const pending = checkTry(engine, FORK_W, 'a2a3', 'b5c7', { signal: ctrl.signal });
  await sleep(20);
  assert.equal(engine.calls.length, 1);
  ctrl.abort();
  await assert.rejects(pending, (e: unknown) => isAbort(e));
  assert.equal(engine.calls[0].signal?.aborted, true, 'the engine was told to stop');
  assert.equal(engine.calls.length, 1, 'no answer search after the abort');
});

test('the backstop abandons a search that never answers and rejects with a TimeoutError', async () => {
  for (const o of [{ hang: true, ignoreAbort: true }, { hang: true }]) {
    const engine = stub(forkScript(), o);
    const t0 = performance.now();
    await assert.rejects(checkTry(engine, FORK_W, 'a2a3', 'b5c7', { backstopMs: 40 }), (e: unknown) => isTimeout(e) && !isAbort(e));
    assert.ok(performance.now() - t0 < 1500, 'gave up at the backstop');
    assert.equal(engine.calls[0].signal?.aborted, true, 'the engine was told to stop');
  }
  assert.ok(TRY_MAX_MS + START_ALLOWANCE_MS > 20_000, 'the default backstop leaves room for the worker\'s 20 s start-up limit');
});

test('searches on one engine run one at a time; a check waiting its turn can be aborted at once', async () => {
  const engine = stub(forkScript(), { delayMs: 15 });
  const [a, b] = await Promise.all([checkTry(engine, FORK_W, 'a2a3', 'b5c7'), checkTry(engine, FORK_B, 'a7a6', 'b4c2')]);
  assert.equal(engine.overlaps, 0, 'the stub never saw two searches at once');
  assert.deepEqual([a.tryWin, a.bestWin, b.tryWin, b.bestWin], [57, 82.9, 57, 82.9]);
  assert.equal(engine.calls.length, 4);

  const slow = stub(forkScript(), { delayMs: 200 });
  const first = checkTry(slow, FORK_W, 'a2a3', 'b5c7');
  const ctrl = new AbortController();
  const second = checkTry(slow, FORK_B, 'a7a6', 'b4c2', { signal: ctrl.signal });
  await sleep(10);
  const t0 = performance.now();
  ctrl.abort();
  await assert.rejects(second, (e: unknown) => isAbort(e));
  assert.ok(performance.now() - t0 < 150, 'rejected without waiting for the running search');
  await first;
  assert.deepEqual(slow.calls.map(c => key(c.fen)), [key(after(FORK_W, 'a2a3')), key(after(FORK_W, 'b5c7'))], 'the aborted check never reached the engine');
});

test('searchOnce: a finished position needs no engine; others report line, score and depth', async () => {
  const engine = stub(forkScript());
  const mate = await searchOnce(engine, after(RANK_W, 'a1a8'));
  assert.deepEqual({ ...mate, ms: 0 }, { line: [], score: { cp: null, mate: 0, mated: 'b' }, depth: 0, terminal: true, ms: 0 });
  const r = await searchOnce(engine, after(FORK_W, 'a2a3'));
  assert.deepEqual([r.line[0], r.score.cp, r.depth, r.terminal], ['e8d7', 76, 12, false]);
  assert.equal(engine.calls.length, 1);
});

// ---- the real worker driver with a fake UCI worker ----

/** Raw replies in the side-to-move view, like Stockfish. `go` answers after `goDelayMs`; `stop` answers with `onStop`. */
function fakeWorker(onGo: (fen: string) => string[] | null, o: { goDelayMs?: number; onStop?: (fen: string) => string[]; seenGo?: () => void } = {}) {
  const listeners = new Set<(e: Event) => void>();
  const sent: string[] = [];
  let fen = '', terminated = 0, gen = 0;
  const emit = (data: string, delay = 0) => {
    const g = gen;
    setTimeout(() => { if (g === gen) for (const l of [...listeners]) l({ data } as unknown as Event); }, delay);
  };
  const worker = {
    postMessage(msg: string) {
      sent.push(msg);
      if (msg === 'uci') emit('id name Fake\nuciok');
      else if (msg === 'isready') emit('readyok');
      else if (msg.startsWith('position fen ')) fen = msg.slice(13);
      else if (msg.startsWith('go ')) { o.seenGo?.(); const lines = onGo(fen); if (lines) emit(lines.join('\n'), o.goDelayMs ?? 0); }
      else if (msg === 'stop' && o.onStop) emit(o.onStop(fen).join('\n'));
    },
    terminate() { terminated++; gen++; },
    addEventListener(t: string, l: (e: Event) => void) { if (t === 'message') listeners.add(l); },
    removeEventListener(t: string, l: (e: Event) => void) { if (t === 'message') listeners.delete(l); },
  };
  return { worker, sent, terminated: () => terminated };
}
/** Raw engine output per position (side to move's view): mirrored twins print the same numbers. Depth-11 line scripted. */
const RAW: Record<string, string[]> = {
  [key(after(FORK_W, 'a2a3'))]: ['info depth 11 seldepth 14 multipv 1 score cp -70 nodes 1 pv e8d7 e1c1', `info depth 12 seldepth 16 multipv 1 score cp -76 nodes 1 pv ${FORK_A3.join(' ')}`, 'bestmove e8d7 ponder e1c1'],
  [key(after(FORK_W, 'b5c7'))]: ['info depth 12 seldepth 15 multipv 1 score cp -428 nodes 1 pv e8d7 c7a8 h8e8', 'bestmove e8d7'],
  [key(after(FORK_B, 'a7a6'))]: [`info depth 12 seldepth 16 multipv 1 score cp -76 nodes 1 pv ${FORK_A6.join(' ')}`, 'bestmove e1d2'],
  [key(after(FORK_B, 'b4c2'))]: ['info depth 12 seldepth 15 multipv 1 score cp -428 nodes 1 pv e1d2 c2a1 h1e1', 'bestmove e1d2'],
  [key(after(BACK_W, 'a1a7'))]: ['info depth 12 seldepth 2 multipv 1 score mate 1 nodes 1 pv e8e1', 'bestmove e8e1'],
  [key(after(BACK_W, 'h2h3'))]: ['info depth 12 seldepth 14 multipv 1 score cp 9 nodes 1 pv g7g6', 'bestmove g7g6'],
  [key(after(BACK_B, 'a8a2'))]: ['info depth 12 seldepth 2 multipv 1 score mate 1 nodes 1 pv e1e8', 'bestmove e1e8'],
  [key(after(BACK_B, 'h7h6'))]: ['info depth 12 seldepth 14 multipv 1 score cp 9 nodes 1 pv g2g3', 'bestmove g2g3'],
};

test('real driver: raw side-to-move scores give the same Win% for White and Black solvers', async () => {
  const f = fakeWorker(fen => RAW[key(fen)] ?? null);
  const engine = createWorkerEngine({ workerFactory: () => f.worker });
  const w = await checkTry(engine, FORK_W, 'a2a3', 'b5c7');
  const b = await checkTry(engine, FORK_B, 'a7a6', 'b4c2');
  assert.deepEqual([w.tryWin, w.bestWin, w.verdict, w.depth], [57, 82.9, 'worse', 12]);
  assert.deepEqual([b.tryWin, b.bestWin, b.verdict, b.depth], [57, 82.9, 'worse', 12]);
  assert.deepEqual(w.replyLine, FORK_A3.slice(0, 6));
  assert.deepEqual(b.replyLine, FORK_A6.slice(0, 6));
  const mw = await checkTry(engine, BACK_W, 'a1a7', 'h2h3');
  const mb = await checkTry(engine, BACK_B, 'a8a2', 'h7h6');
  assert.deepEqual([mw.tryWin, mw.bestWin, mw.verdict, mw.replyLine], [0, 49.2, 'losing', ['e8e1']]);
  assert.deepEqual([mb.tryWin, mb.bestWin, mb.verdict, mb.replyLine], [0, 49.2, 'losing', ['e1e8']]);
  assert.ok(f.sent.includes('setoption name MultiPV value 1') && f.sent.includes('go depth 12'));
  engine.dispose();
});

test('real driver: a search stopped by the in-worker cap keeps its deepest line and reports that depth', async () => {
  // The worker stays silent until `stop`, then reports a shallower line (depths 7 and 8 scripted).
  const f = fakeWorker(() => null, {
    onStop: fen => key(fen) === key(after(FORK_W, 'a2a3'))
      ? ['info depth 7 seldepth 9 multipv 1 score cp -76 nodes 1 pv e8d7 e1c1', 'bestmove e8d7']
      : ['info depth 8 seldepth 9 multipv 1 score cp -428 nodes 1 pv e8d7 c7a8', 'bestmove e8d7'],
  });
  const engine = createWorkerEngine({ workerFactory: () => f.worker, maxSearchMs: 30 });
  const r = await checkTry(engine, FORK_W, 'a2a3', 'b5c7');
  assert.equal(f.sent.filter(m => m === 'stop').length, 2);
  assert.deepEqual([r.depth, r.tryWin, r.bestWin, r.replyLine], [7, 57, 82.9, ['e8d7', 'e1c1']]);
  engine.dispose();
});

test('real driver: abort, then a new check in the same tick waits for the worker instead of failing as busy', async () => {
  let goSeen: () => void = () => {};
  const firstGo = new Promise<void>(r => { goSeen = r; });
  const f = fakeWorker(fen => RAW[key(fen)] ?? null, { goDelayMs: 30, seenGo: () => goSeen() });
  const engine = createWorkerEngine({ workerFactory: () => f.worker });
  const ctrl = new AbortController();
  const first = checkTry(engine, FORK_W, 'a2a3', 'b5c7', { signal: ctrl.signal });
  await firstGo;
  ctrl.abort();
  const second = checkTry(engine, FORK_W, 'a2a3', 'b5c7');
  await assert.rejects(first, (e: unknown) => isAbort(e));
  const r = await second;
  assert.deepEqual([r.tryWin, r.bestWin], [57, 82.9]);
  assert.equal(f.terminated(), 1, 'the abort ended the worker');
  assert.equal(f.sent.filter(m => m === 'uci').length, 2, 'the next check started a fresh worker');
  // Control: without the queue the driver refuses an overlapping search.
  const running = engine.analyse(after(FORK_W, 'a2a3'), { depth: 12, multiPv: 1 });
  await assert.rejects(engine.analyse(after(FORK_W, 'b5c7'), { depth: 12, multiPv: 1 }), /busy/);
  await running;
  engine.dispose();
});

test('getSharedEngine: null without Web Workers; otherwise one lazy engine whose worker stops a search at 1500 ms', async () => {
  assert.equal(getSharedEngine(), null, 'Node has no Worker');
  const g = globalThis as unknown as { Worker?: unknown };
  const urls: string[] = [];
  // Silent until `stop`; the depth-9 reply is scripted.
  g.Worker = class {
    private f = fakeWorker(() => null, { onStop: () => ['info depth 9 seldepth 11 multipv 1 score cp -76 nodes 1 pv e8d7 e1c1', 'bestmove e8d7'] });
    constructor(url: string) { urls.push(url); }
    postMessage(m: string) { this.f.worker.postMessage(m); }
    terminate() { this.f.worker.terminate(); }
    addEventListener(t: string, l: (e: Event) => void) { this.f.worker.addEventListener(t, l); }
    removeEventListener(t: string, l: (e: Event) => void) { this.f.worker.removeEventListener(t, l); }
  };
  try {
    const engine = getSharedEngine();
    assert.ok(engine);
    assert.equal(getSharedEngine(), engine, 'one engine per page');
    assert.equal(urls.length, 0, 'no worker before the first search');
    const t0 = performance.now();
    const r = await searchOnce(engine, after(FORK_W, 'a2a3'));
    const ms = performance.now() - t0;
    assert.deepEqual(urls, ['stockfish-19-lite-single.js']);
    assert.equal(r.depth, 9);
    assert.ok(ms >= TRY_MAX_MS - 50 && ms < TRY_MAX_MS + 2000, `stopped by the ${TRY_MAX_MS} ms cap (${Math.round(ms)} ms)`);
    engine.dispose();
  } finally {
    delete g.Worker;
  }
  assert.equal(getSharedEngine(), null);
});
