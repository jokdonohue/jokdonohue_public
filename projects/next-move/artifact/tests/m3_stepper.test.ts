/** M3 A1: line viewer steps (start, after each ply, arrow preview) and index clamping. Textbook positions only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { narrateLine } from '../src/teach/narrate';
import { buildSteps, clampStep, type LineStep } from '../src/teach/stepper';

const START = new Chess().fen();
const ITALIAN = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'];

test('steps: start position first, then the position after each ply, each previewing the next move', () => {
  const narrated = narrateLine(START, ITALIAN);
  const steps = buildSteps(START, ITALIAN, narrated);
  assert.equal(steps.length, ITALIAN.length + 1);
  assert.deepEqual(steps[0], { ply: 0, fen: START, nextUci: 'e2e4' });
  const replay = new Chess();
  ITALIAN.forEach((uci, i) => {
    const m = replay.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
    const s = steps[i + 1];
    assert.equal(s.ply, i + 1);
    assert.equal(s.fen, replay.fen());
    assert.equal(s.uci, uci);
    assert.equal(s.san, m.san);
    assert.equal(s.text, narrated.plies[i].text);
    assert.equal(s.fen, narrated.plies[i].fenAfter);
    assert.equal(s.nextUci, ITALIAN[i + 1]);
  });
  assert.equal(steps[ITALIAN.length].nextUci, undefined, 'the last step has no preview');
  assert.equal(steps[1].text, 'e4 pushes the pawn to e4.');
  assert.equal(steps[5].text, 'Bc4 moves the bishop to c4.');
});

test('captions are narrated here when none are given, or when the given narration is for another line', () => {
  const own = buildSteps(START, ['e2e4', 'e7e5']);
  assert.deepEqual(own.map(s => s.text), [undefined, 'e4 pushes the pawn to e4.', 'e5 pushes the pawn to e5.']);
  const wrong = buildSteps(START, ['e2e4'], narrateLine(START, ['d2d4']));
  assert.equal(wrong[1].text, 'e4 pushes the pawn to e4.');
  // Same move from another position (where it reads differently) does not lend its caption.
  const elsewhere = narrateLine('4k3/8/8/3p4/8/8/4P3/4K3 w - - 0 1', ['e2e4']);
  assert.notEqual(elsewhere.plies[0].text, 'e4 pushes the pawn to e4.');
  assert.equal(buildSteps(START, ['e2e4'], elsewhere)[1].text, 'e4 pushes the pawn to e4.');
});

test('the replay stops before an illegal ply: every step is real and every arrow legal', () => {
  const steps = buildSteps(START, ['e2e4', 'e7e5', 'e4e5', 'g1f3']);
  assert.equal(steps.length, 3);
  assert.equal(steps[1].nextUci, 'e7e5');
  assert.equal(steps[2].nextUci, undefined, 'the illegal e4e5 is never drawn as an arrow');
  assert.deepEqual(buildSteps(START, ['zz']), [{ ply: 0, fen: START }]);
  assert.deepEqual(buildSteps(START, []), [{ ply: 0, fen: START }]);
  assert.deepEqual(buildSteps(START, undefined as unknown as string[]), [{ ply: 0, fen: START }]);
  assert.deepEqual(buildSteps('not a fen', ['e2e4']), []);
});

test('moves are normalized: castling as the king move, promotions with their letter', () => {
  const castle = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
  const steps = buildSteps(castle, ['e1h1', 'e8c8']);
  assert.equal(steps[0].nextUci, 'e1g1');
  assert.deepEqual([steps[1].uci, steps[1].san, steps[2].uci, steps[2].san], ['e1g1', 'O-O', 'e8c8', 'O-O-O']);
  assert.equal(steps[1].text, 'O-O castles kingside.');
  const promo = buildSteps('7k/4P3/8/8/8/8/8/K7 w - - 0 1', ['E7E8Q']);
  assert.deepEqual([promo[0].nextUci, promo[1].san, promo[1].text], ['e7e8q', 'e8=Q+', 'e8=Q+ promotes with check.']);
});

test('clampStep keeps an index inside the steps', () => {
  const steps: LineStep[] = buildSteps(START, ITALIAN);
  const last = steps.length - 1;
  assert.equal(clampStep(0, steps), 0);
  assert.equal(clampStep(3, steps), 3);
  assert.equal(clampStep(-1, steps), 0);
  assert.equal(clampStep(last + 4, steps), last);
  assert.equal(clampStep(2.7, steps), 2);
  assert.equal(clampStep(Number.NaN, steps), 0);
  assert.equal(clampStep(Number.POSITIVE_INFINITY, steps), last, 'End');
  assert.equal(clampStep(Number.NEGATIVE_INFINITY, steps), 0, 'Start');
  assert.equal(clampStep(5, []), 0);
  assert.equal(clampStep(5, [{ ply: 0, fen: START }]), 0);
});
