import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StockfishEngine, moverLoss, parseInfo, scoreToCp, analyzeGame } from '../lib/chess-engine';
import { parsePgn } from '../lib/pgn';

test('UCI cp and mate scores become white POV, including mate zero', () => {
  assert.equal(parseInfo('info depth 12 score cp 125 pv e2e4 e7e5', 'w')?.score.cp, 125);
  assert.equal(parseInfo('info depth 12 score cp 125 pv e7e5', 'b')?.score.cp, -125);
  assert.equal(parseInfo('info depth 12 score mate 3 pv e7e5', 'b')?.score.mate, -3);
  assert.equal(parseInfo('info depth 12 score mate -2 pv e7e5', 'b')?.score.mate, 2);
  assert.ok(scoreToCp(parseInfo('info depth 1 score mate 0', 'w')!.score) < -9000);
  assert.ok(scoreToCp(parseInfo('info depth 1 score mate 0', 'b')!.score) > 9000);
  assert.equal(parseInfo('info depth 12 score cp 125 lowerbound pv e2e4', 'w'), null);
});
test('loss is mover-relative and improvements never count as mistakes', () => {
  assert.equal(moverLoss({cp: 100, mate: null}, {cp: -100, mate: null}, 'w'), 200);
  assert.equal(moverLoss({cp: -100, mate: null}, {cp: 100, mate: null}, 'b'), 200);
  assert.equal(moverLoss({cp: 0, mate: null}, {cp: 100, mate: null}, 'w'), 0);
});

class FakeWorker extends EventTarget {
  commands: string[] = [];
  terminated = false;
  send(line: string) { queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data: line}))); }
  postMessage(command: string) {
    this.commands.push(command);
    if (command === 'uci') this.send('uciok');
    if (command === 'isready') this.send('readyok');
    if (command.startsWith('go ')) { this.send('info depth 11 score cp 28 pv e2e4 e7e5'); this.send('bestmove e2e4'); }
  }
  terminate() { this.terminated = true; }
}
test('worker handshakes and reports achieved depth/PV before bestmove', async () => {
  const worker = new FakeWorker();
  const engine = new StockfishEngine(() => worker);
  const result = await engine.evaluate(new (await import('chess.js')).Chess().fen());
  assert.equal(result.depth, 11);
  assert.equal(result.bestMove, 'e2e4');
  assert.deepEqual(result.pv, ['e2e4', 'e7e5']);
  assert.ok(worker.commands.includes('setoption name Hash value 16'));
  engine.terminate();
  assert.ok(worker.terminated);
});
test('pre-aborted evaluation rejects and actual checkmate needs no worker', async () => {
  const controller = new AbortController(); controller.abort();
  const engine = new StockfishEngine(() => { throw new Error('No worker needed'); });
  await assert.rejects(engine.evaluate('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1', {signal: controller.signal}), {name:'AbortError'});
  const terminal = await engine.evaluate('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1');
  assert.equal(terminal.score.mated, 'b');
  assert.equal(terminal.bestMove, null);
});
test('cancellation during initialization terminates the worker promptly', async () => {
  const worker = new FakeWorker();
  worker.postMessage = () => {}; // Simulate a worker still downloading/compiling WASM.
  const engine = new StockfishEngine(() => worker);
  const controller = new AbortController();
  const pending = engine.init(controller.signal);
  controller.abort();
  await assert.rejects(pending, {name:'AbortError'});
  assert.ok(worker.terminated);
});
test('cancellation during search rejects and prevents stale bestmove reuse', async () => {
  const worker = new FakeWorker();
  const original = worker.postMessage.bind(worker);
  worker.postMessage = command => { if (!command.startsWith('go ')) original(command); };
  const engine = new StockfishEngine(() => worker);
  await engine.init();
  const controller = new AbortController();
  const pending = engine.evaluate(new (await import('chess.js')).Chess().fen(), {signal: controller.signal});
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, {name:'AbortError'});
  assert.ok(worker.terminated);
});
test('worker startup errors reject instead of hanging until timeout', async () => {
  const worker = new FakeWorker();
  worker.postMessage = () => {};
  const engine = new StockfishEngine(() => worker);
  const pending = engine.init();
  worker.dispatchEvent(new Event('error'));
  await assert.rejects(pending, /could not load/i);
  assert.ok(worker.terminated);
});
test('game analysis exposes bounded coverage and progress', async () => {
  const worker = new FakeWorker();
  const engine = new StockfishEngine(() => worker);
  const [game] = parsePgn('1.e4 e5 2.Nf3 Nc6 1-0');
  let progress = 0;
  const result = await analyzeGame(game, 'w', p => { progress = p.completed; }, undefined, {maxMoves: 1, engine});
  assert.equal(result.partial, true);
  assert.equal(result.totalMoves, 2);
  assert.equal(result.analyzedMoves, 1);
  assert.equal(progress, 1);
  assert.equal(result.mistakes.length, 0);
  assert.ok(worker.terminated);
});
