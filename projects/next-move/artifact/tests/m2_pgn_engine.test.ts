import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerEngine, finalLines, parseLine, ENGINE_WORKER_URL, isAbort } from '../src/analysis/engine';

/** A fake UCI worker: answers `uci`/`isready`, and replies to `go` with the scripted lines. */
function fakeWorker(reply: (fen: string) => string[], opts: { silentGo?: boolean } = {}) {
  const listeners = new Set<(e: Event) => void>();
  const sent: string[] = [];
  let fen = '';
  let terminated = 0;
  const emit = (data: string) => setTimeout(() => { for (const l of [...listeners]) l({ data } as unknown as Event); }, 0);
  const worker = {
    postMessage(msg: string) {
      sent.push(msg);
      if (msg === 'uci') emit('id name Fake\nuciok');
      else if (msg === 'isready') emit('readyok');
      else if (msg.startsWith('position fen ')) fen = msg.slice(13);
      else if (msg.startsWith('go ') && !opts.silentGo) emit(reply(fen).join('\n'));
      else if (msg === 'stop') emit(`info depth 3 multipv 1 score cp 11 pv e2e4\nbestmove e2e4`);
    },
    terminate() { terminated++; },
    addEventListener(t: string, l: (e: Event) => void) { if (t === 'message') listeners.add(l); },
    removeEventListener(t: string, l: (e: Event) => void) { if (t === 'message') listeners.delete(l); },
  };
  return { worker, sent, terminated: () => terminated };
}
const START = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

test('reads both MultiPV lines from the final depth, with scores turned to White\'s point of view', async () => {
  const f = fakeWorker(() => [
    'info depth 11 seldepth 14 multipv 1 score cp 40 nodes 1 pv e7e5 g1f3',
    'info depth 11 seldepth 14 multipv 2 score cp 10 nodes 1 pv c7c5',
    'info depth 12 seldepth 15 multipv 1 score cp 35 lowerbound nodes 1 pv e7e5',
    'info depth 12 seldepth 15 multipv 1 score cp 30 nodes 1 pv e7e5 g1f3 b8c6',
    'info depth 12 seldepth 15 multipv 2 score cp -5 nodes 1 pv c7c5 g1f3',
    'bestmove e7e5 ponder g1f3',
  ]);
  const engine = createWorkerEngine({ workerFactory: () => f.worker });
  const lines = await engine.analyse(START, { depth: 12, multiPv: 2 });
  assert.deepEqual(lines.map(l => [l.multipv, l.depth, l.score.cp, l.pv[0]]), [[1, 12, -30, 'e7e5'], [2, 12, 5, 'c7c5']]);
  assert.ok(f.sent.includes('setoption name MultiPV value 2'));
  assert.ok(f.sent.includes('go depth 12'), 'a fixed depth, no movetime cap');
  assert.ok(!f.sent.some(m => /movetime/.test(m)));
  const single = await engine.analyse(START, { depth: 12, multiPv: 1 });
  assert.equal(single.length, 1, 'MultiPV 1 keeps one line');
  assert.ok(f.sent.includes('setoption name MultiPV value 1'));
  engine.dispose();
  assert.equal(f.terminated(), 1);
  assert.equal(ENGINE_WORKER_URL, 'stockfish-19-lite-single.js', 'relative URL, as the self-test uses');
});

test('finished positions need no search; a stop rejects as an abort and ends the worker', async () => {
  const f = fakeWorker(() => [], { silentGo: true });
  const engine = createWorkerEngine({ workerFactory: () => f.worker });
  const mated = await engine.analyse('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', { depth: 12, multiPv: 2 });
  assert.deepEqual(mated[0].score, { cp: null, mate: 0, mated: 'w' });
  assert.equal(f.sent.length, 0, 'no worker started for a finished position');
  const ctrl = new AbortController();
  const pending = engine.analyse(START, { depth: 12, multiPv: 2, signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(pending, (e: unknown) => isAbort(e));
  assert.equal(f.terminated(), 1);
});

test('the watchdog stops a long search and keeps the deepest lines it has', async () => {
  const f = fakeWorker(() => [], { silentGo: true });
  const engine = createWorkerEngine({ workerFactory: () => f.worker, maxSearchMs: 30 });
  const lines = await engine.analyse(START.replace(' b ', ' w '), { depth: 12, multiPv: 2 });
  assert.ok(f.sent.includes('stop'));
  assert.equal(lines[0].depth, 3, 'the reached depth is reported, not the requested one');
});

test('line parsing: multipv index, bounds skipped, and the latest report per line', () => {
  assert.equal(parseLine('info depth 5 multipv 2 score cp 12 pv d2d4', 'w')!.multipv, 2);
  assert.equal(parseLine('info depth 5 score cp 12 pv d2d4', 'w')!.multipv, 1);
  assert.equal(parseLine('info depth 5 multipv 1 score cp 12 upperbound pv d2d4', 'w'), null);
  assert.equal(parseLine('info depth 5 multipv 1 score mate 2 pv d1h5', 'b')!.score.mate, -2);
  const a = { multipv: 1, depth: 4, score: { cp: 1, mate: null }, pv: ['a'] };
  const b = { multipv: 2, depth: 4, score: { cp: 0, mate: null }, pv: ['b'] };
  const c = { ...a, depth: 5 };
  assert.deepEqual(finalLines([a, b, c, { ...b, multipv: 3 }], 2), [c, b]);
});
