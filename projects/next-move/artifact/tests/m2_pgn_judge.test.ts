import test from 'node:test';
import assert from 'node:assert/strict';
import * as J from '../src/analysis/judge';
import * as P from '../src/importers/packDocs';

const cp = (n: number) => ({ cp: n, mate: null });

test('the card thresholds equal the producer constants mirrored in packDocs', () => {
  assert.equal(J.UNIQUE_GAP, P.UNIQUE_GAP);
  assert.equal(J.DECIDED_LO, P.DECIDED_LO);
  assert.equal(J.DECIDED_HI, P.DECIDED_HI);
  for (const c of [-2000, -1000, -300, -30, 0, 45, 700, 1000, 5000]) {
    assert.ok(Math.abs(J.winFor(cp(c), 'w', 'w') - P.lineWin({ cp: c })) < 1e-9, `win% parity at ${c}`);
  }
  assert.equal(J.winFor({ cp: null, mate: 3 }, 'w', 'w'), P.lineWin({ mate: 3 }));
  assert.equal(J.winFor({ cp: null, mate: -2 }, 'w', 'w'), P.lineWin({ mate: -2 }));
});

test('severity: 5, 10 and 15 points of winning chances, clamped at 1000, both colours', () => {
  // Find cp values giving drops just under and over each threshold from a level start.
  const dropTo = (points: number) => { let c = 0; while (50 - J.winFor(cp(c), 'w', 'w') < points) c -= 1; return c; };
  for (const [points, label] of [[5, 'inaccuracy'], [10, 'mistake'], [15, 'blunder']] as const) {
    const c = dropTo(points);
    assert.equal(J.judge(cp(0), cp(c), 'w'), label, `white ${label}`);
    assert.notEqual(J.judge(cp(0), cp(c + 2), 'w'), label, `white just under ${label}`);
    // The same drop for Black: White's point of view flips sign.
    assert.equal(J.judge(cp(0), cp(-c), 'b'), label, `black ${label}`);
  }
  assert.equal(J.judge(cp(0), cp(5), 'b'), null, 'a small change is no judgement');
  assert.equal(J.judge(cp(5000), cp(1000), 'w'), null, 'both above the ceiling: no drop');
  assert.equal(J.judge(cp(-300), cp(-300), 'b'), null, 'black improving from his side is not a mistake');
});

test('mate branches follow the classifier: mate created, mate lost, and checkmate on the board', () => {
  assert.equal(J.judge(cp(0), { cp: null, mate: 1 }, 'b'), 'blunder', 'black allows mate');
  assert.equal(J.judge(cp(-800), { cp: null, mate: -3 }, 'w'), 'mistake', 'already much worse');
  assert.equal(J.judge(cp(-1200), { cp: null, mate: -3 }, 'w'), 'inaccuracy');
  assert.equal(J.judge({ cp: null, mate: 2 }, cp(100), 'w'), 'blunder', 'a won mate thrown away');
  assert.equal(J.judge({ cp: null, mate: -2 }, cp(-800), 'b'), 'mistake', 'black loses his mate (White pov -2 = Black mates)');
  assert.equal(J.judge({ cp: null, mate: 3 }, { cp: null, mate: 2 }, 'w'), null, 'mate kept');
  assert.equal(J.judge(cp(0), { cp: null, mate: 0, mated: 'b' }, 'w'), null, 'he gives checkmate');
});

test('card rule: mistakes only, a clear single best move, and a position that was still open for him', () => {
  assert.equal(J.cardRule('inaccuracy', cp(0), cp(-500), 'w').why, 'not-a-mistake');
  assert.equal(J.cardRule('mistake', cp(0), null, 'w').why, 'one-line');
  assert.equal(J.cardRule('mistake', cp(0), cp(-20), 'w').why, 'not-unique');
  const ok = J.cardRule('blunder', cp(0), cp(-200), 'w');
  assert.equal(ok.why, 'card');
  assert.ok(ok.gap! >= 10);
  // Black: White's point of view +200 is -200 for him.
  assert.equal(J.cardRule('blunder', cp(0), cp(200), 'b').why, 'card');
  assert.equal(J.cardRule('blunder', cp(0), cp(-200), 'b').why, 'not-unique', 'second line better for black is no gap');
  assert.equal(J.cardRule('blunder', cp(900), cp(100), 'w').why, 'decided', 'already winning by far');
  assert.equal(J.cardRule('blunder', cp(-1000), cp(-3000), 'w').why, 'not-unique', 'clamped: both lost');
  // Producer rule (lead decision): a forced mate for him is a card when the second-best move is 10 points worse.
  assert.equal(J.cardRule('blunder', { cp: null, mate: 2 }, cp(0), 'w').why, 'card');
  assert.equal(J.cardRule('blunder', { cp: null, mate: -2 }, cp(0), 'b').why, 'card', 'Black mates: White pov -2');
  assert.equal(J.cardRule('blunder', { cp: null, mate: 2 }, { cp: null, mate: 4 }, 'w').why, 'not-unique', 'a slower mate is as good');
  assert.equal(J.cardRule('blunder', { cp: null, mate: 2 }, cp(900), 'w').why, 'not-unique', 'still winning by far anyway');
  assert.equal(J.cardRule('mistake', { cp: null, mate: -3 }, { cp: null, mate: -1 }, 'w').why, 'not-unique');
  assert.equal(J.cardRule('mistake', { cp: null, mate: -3 }, cp(-2000), 'w').why, 'not-unique', 'mated either way: no gap');
});
