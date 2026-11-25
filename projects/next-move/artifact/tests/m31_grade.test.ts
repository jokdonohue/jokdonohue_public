/**
 * Version 7.1 (brief m31 4.6), writer W2, item F3: on a punish card whose best move keeps 65% or more, a counted miss
 * that itself still keeps 55% or more (both rounded) reads "That keeps only a small edge. There is a clearly stronger
 * move." and no longer "That lets your opponent off the hook." Only the message changes: the class, the action (a
 * counted miss), the intro, the numbers and `tryVerdict` are what version 7 gave. Nothing else in grade.ts changes.
 * Numbers are fixture inputs; no position is involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWin, gradeTry, KEEPS_EDGE_FROM, WIN_FLOOR, type EngineKind, type Grade, type GradeInput } from '../src/teach/grade';
import type { TryCheck } from '../src/teach/tryMove';

const TRY = 'Nf3', ANSWER = 'Qxh7#';
const SMALL = 'That keeps only a small edge. There is a clearly stronger move.';
const HOOK = 'That lets your opponent off the hook.';
const STORED = 'That is not the move from the stored line.';
const NOT_THIS = 'That is not the move this card is after.';
const check = (tryWin: number, bestWin: number, depth = 12): TryCheck =>
  ({ tryUci: 'g1f3', trySan: TRY, replyLine: ['d7d5'], tryWin, bestWin, verdict: 'losing', depth, ms: 40 });
const grade = (kind: EngineKind, c: TryCheck, engineScan?: boolean): Grade =>
  gradeTry({ kind, trySan: TRY, answerSan: ANSWER, solver: 'w', check: c, ...(engineScan === undefined ? {} : { engineScan }) } as GradeInput);
const solving = (t: number, b: number) => `After ${TRY} the engine gives White ${t}% to win; the best move keeps ${b}%.`;
/** Version 7's message for a trusted worse or losing try (grade.ts:205 before F3), for the comparison below. */
const v7Message = (kind: EngineKind, b: number) => (kind === 'punish' && b >= 65 ? HOOK : kind === 'pack' || kind === 'punish' ? STORED : NOT_THIS);

test('F3: a punish miss that still keeps 55 or more is a small edge, not "off the hook"; every other field is unchanged', () => {
  assert.equal(KEEPS_EDGE_FROM, 55);
  assert.deepEqual(grade('punish', check(64, 70)),
    { action: 'error', cls: 'worse', message: SMALL, intro: solving(64, 70), tryVerdict: 'worse', showNumbers: true, tryWin: 64, bestWin: 70 });
  assert.deepEqual(grade('punish', check(55, 90)),
    { action: 'error', cls: 'worse', message: SMALL, intro: solving(55, 90), tryVerdict: 'worse', showNumbers: true, tryWin: 55, bestWin: 90 });
  // Under 55 the miss let the opponent off the hook, as before.
  assert.deepEqual(grade('punish', check(54, 90)),
    { action: 'error', cls: 'worse', message: HOOK, intro: solving(54, 90), tryVerdict: 'worse', showNumbers: true, tryWin: 54, bestWin: 90 });
  assert.equal(grade('punish', check(50, 90)).message, HOOK);
  assert.equal(grade('punish', check(10, 90)).message, HOOK);
});

test('F3: both numbers are read rounded, as the page prints them', () => {
  const msg = (t: number, b: number, kind: EngineKind = 'punish', depth = 12) => grade(kind, check(t, b, depth)).message;
  assert.equal(msg(54.5, 90), SMALL);   // prints 55
  assert.equal(msg(54.49, 90), HOOK);   // prints 54
  assert.equal(msg(64.4, 75), SMALL);   // prints 64: still a miss (worse), with a small edge kept
  assert.equal(msg(59, 64.5), SMALL);   // the best move prints 65
  assert.equal(msg(58, 64.4), STORED);  // the best move prints 64: no claim about the hook or the edge
  assert.equal(msg(40, 64.4), STORED);
  // 60 against 65 is within 5 points: a near try, not a miss.
  assert.equal(grade('punish', check(60, 65)).action, 'soft');
  assert.equal(grade('punish', check(59, 65)).message, SMALL);
});

test('F3: only punish cards, only a trusted check, only a miss', () => {
  for (const kind of ['pack', 'agent', 'bank'] as const) assert.equal(grade(kind, check(60, 90)).message, v7Message(kind, 90), kind);
  // Depth under 10: no claim at all, as before.
  assert.deepEqual(grade('punish', check(60, 90, 9)), { action: 'error', cls: 'worse', message: STORED, tryVerdict: 'unchecked', showNumbers: false });
  // Depth 0 (both positions already finished) is trusted.
  assert.equal(grade('punish', check(60, 90, 0)).message, SMALL);
  // A try at 65 or more is "strong" (a soft retry with its own words), never this message.
  const strong = grade('punish', check(70, 90));
  assert.equal(strong.action, 'soft');
  assert.notEqual(strong.message, SMALL);
  // A short-scan card changes only the near-try words; the miss reads the same.
  assert.deepEqual(grade('punish', check(60, 90), true), grade('punish', check(60, 90)));
  // No check at all.
  assert.equal(gradeTry({ kind: 'punish', trySan: TRY, answerSan: ANSWER, solver: 'w', check: null }).message, STORED);
});

test('F3 copy: plain words, no figure, no move named, no praise', () => {
  assert.ok(SMALL.endsWith('.') && !/[!—\d%]/.test(SMALL));
  assert.ok(!SMALL.includes(TRY) && !SMALL.includes('Qxh7'));
  assert.doesNotMatch(SMALL, /\b(great|amazing|excellent|brilliant|well done|nice|superb|perfect|good)\b/i);
  // The intro beside it still gives the two figures, and never the answer.
  const g = grade('punish', check(60, 90));
  assert.equal(g.intro, solving(60, 90));
  assert.ok(!`${g.message} ${g.intro}`.includes('Qxh7'));
});

test('F3 over a grid: the message differs from version 7 exactly inside the band, and nothing else differs', () => {
  const wins = [0, 10.4, 34.4, 34.5, 35, 49.9, 50, 54.4, 54.5, 55, 59.5, 60, 64.4, 64.5, 64.6, 65, 69.6, 70, 75.4, 80, 90, 97.5, 100];
  let rows = 0, inBand = 0;
  for (const kind of ['bank', 'pack', 'punish', 'agent'] as const) {
    for (const scan of [undefined, false, true]) {
      for (const depth of [0, 1, 9, 10, 12, 20]) {
        for (const tw of wins) {
          for (const bw of wins) {
            const where = `${kind} scan ${scan} depth ${depth} ${tw}/${bw}`;
            const g = grade(kind, check(tw, bw, depth), scan);
            const cls = classifyWin(tw, bw)!;
            const t = Math.round(tw), b = Math.round(bw);
            const sure = depth === 0 || depth >= 10;
            const near = cls === 'also-good' || cls === 'close';
            const miss = sure && !near && cls !== 'strong';
            const band = kind === 'punish' && miss && b >= WIN_FLOOR && t >= KEEPS_EDGE_FROM;
            rows++;
            // The action, class and verdict are version 7's rules, untouched by F3.
            const action = kind === 'bank' ? 'error' : !sure ? (near ? 'soft' : 'error') : near || cls === 'strong' ? 'soft' : 'error';
            assert.equal(g.action, action, where);
            assert.equal(g.cls, cls, where);
            assert.equal(g.tryVerdict, !sure ? 'unchecked' : near && kind !== 'bank' ? 'strong' : cls, where);
            assert.equal(g.message === SMALL, band, where);
            if (band) {
              inBand++;
              assert.equal(cls, 'worse', where);
              assert.ok(t >= 55 && t <= 64 && b >= 65, where);
              // Everything but the message is what a miss carried in version 7.
              assert.deepEqual({ ...g, message: HOOK }, { action: 'error', cls: 'worse', message: HOOK, intro: solving(t, b), tryVerdict: 'worse', showNumbers: true, tryWin: t, bestWin: b }, where);
            } else if (miss && kind !== 'bank') {
              assert.equal(g.message, v7Message(kind, b), where);
            }
            if (g.message === HOOK) assert.ok(kind === 'punish' && t < KEEPS_EDGE_FROM && b >= WIN_FLOOR, `${where}: "off the hook" only for a try under 55`);
          }
        }
      }
    }
  }
  assert.equal(rows, 4 * 3 * 6 * wins.length * wins.length);
  assert.ok(inBand > 0, String(inBand));
});
