/**
 * M3 builder G: grading a wrong try (`src/teach/grade.ts`, brief section 9.1).
 * Engine rows use hand-made `TryCheck` objects: only the numbers, the depth and two textbook moves matter (Nf3 tried
 * where Bc4 is the answer); no position is involved. Endgame rows use invented teach results and the repository's
 * textbook drills through `lib/endgameTeach.ts` (tablebase data, no engine). The copy is pinned word for word.
 * Fix round 2 (FX4a, brief 9.11.2 (p)): a trusted also-good or close try on pack, punish and agent cards is a SOFT
 * retry with the (p) copy, `tryVerdict` 'strong' and no numbers; the rows that pinned 9.1's ACCEPT now pin that.
 * The full (p) matrix is in tests/m3_fix2a_grade.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { endgameDrills } from '../lib/endgames';
import { drillTeach, positionKey, teachDrillIds, teachTry, type TeachResult, type TeachTry } from '../lib/endgameTeach';
import { tryVerdict as l4Verdict, type TryCheck } from '../src/teach/tryMove';
import {
  classifyWin, endgameGoal, gradeTry, CLOSE_GAP, LOSING_BELOW, TRUSTED_DEPTH, WIN_FLOOR,
  type DrillGoal, type EngineKind, type Grade, type GradeInput, type TeachGrade,
} from '../src/teach/grade';
import { ARTIFACT_DIR } from './b3_paths';

const TRY = 'Nf3', ANSWER = 'Bc4';
const STORED = 'That is not the move from the stored line.';
const NOT_THIS = 'That is not the move this card is after.';
const HOOK = 'That lets your opponent off the hook.';
const SHALLOW = 'The engine could not finish checking Nf3. This card is after a different move. Try again.';
/** Brief 9.11.2 (p), pack and punish: a trusted also-good or close try (it replaced 9.1's "Also good." accept). */
const QUICK_LIKES = 'The quick engine check likes Nf3 too, but the analysis that picked this card found one clearly better move. Try again.';
/** Brief 9.11.2 (p), agent cards. */
const AGENT_LIKES = 'The engine likes Nf3 too, but this card is after a different move. Try again.';
const LIKES = 'The engine likes Nf3 too, but this puzzle is after a different idea.';
const ALSO_WINS = 'That also wins, but this drill practises a different move. Try again.';
const ALSO_HOLDS = 'That also holds the draw, but this drill practises a different move. Try again.';
const ONLY_DRAWS = 'This only draws.';
const LOSES = 'This loses.';
const strongCopy = (t: number, b: number) => `Good idea, but there is a stronger move: after Nf3 the engine gives you ${t}% to win, the best move keeps ${b}%. Try again.`;
const solving = (t: number, b: number, side = 'White') => `After Nf3 the engine gives ${side} ${t}% to win; the best move keeps ${b}%.`;

/** A check as `checkTry` returns it. `verdict` is deliberately 'losing' on every row: `gradeTry` must never read it. */
function check(tryWin: number, bestWin: number | null, depth = 12, extra: Partial<TryCheck> = {}): TryCheck {
  return { tryUci: 'g1f3', trySan: TRY, replyLine: ['d7d5', 'e2e3'], tryWin, bestWin, verdict: 'losing', depth, ms: 40, ...extra };
}
const engine = (kind: EngineKind, c: TryCheck | null, solver: 'w' | 'b' = 'w', tryUci?: string): GradeInput =>
  ({ kind, trySan: TRY, answerSan: ANSWER, solver, check: c, ...(tryUci === undefined ? {} : { tryUci }) });
const unchecked = (message: string): Grade => ({ action: 'error', cls: 'unchecked', message, tryVerdict: 'unchecked', showNumbers: false });
const numbers = (t: number, b: number) => ({ showNumbers: true, tryWin: t, bestWin: b });

/** True when `text` names `san` as a whole move token (check and mate signs ignored). Independent of grade.ts. */
function namesSan(text: string, san: string): boolean {
  const core = san.replace(/[+#]+$/, '');
  return text.split(/[\s,.;:()!?]+/).some(token => token.replace(/[+#]+$/, '') === core);
}
const PRAISE = /\b(great|amazing|excellent|brilliant|well done|nice|superb|perfect)\b/i;
function assertCopy(g: Grade, where: string) {
  for (const text of [g.message, g.intro].filter((x): x is string => x !== undefined)) {
    assert.ok(text.trim().length > 0 && text.endsWith('.'), `${where}: "${text}" is one or more full sentences`);
    assert.ok(!/[!—]/.test(text), `${where}: no exclamation mark or em dash in "${text}"`);
    assert.ok(!PRAISE.test(text), `${where}: no praise word in "${text}"`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Classes from rounded numbers

test('the five classes cover every pair of whole numbers exactly once, as 9.1 defines them', () => {
  assert.deepEqual([WIN_FLOOR, CLOSE_GAP, LOSING_BELOW, TRUSTED_DEPTH], [65, 5, 35, 10]);
  for (let t = 0; t <= 100; t++) {
    for (let b = 0; b <= 100; b++) {
      const gap = b - t;
      const alsoGood = t >= Math.max(65, b - 5);
      const holds: Record<string, boolean> = {
        'also-good': alsoGood,
        close: !alsoGood && gap <= 5,
        strong: t >= 65 && gap > 5,
        worse: t >= 35 && t < 65 && gap > 5,
        losing: t < 35 && gap > 5,
      };
      const names = Object.keys(holds).filter(k => holds[k]);
      assert.equal(names.length, 1, `${t}/${b} matches ${names.join(', ') || 'nothing'}`);
      assert.equal(classifyWin(t, b), names[0], `${t}/${b}`);
    }
  }
});

test('classifyWin rounds both numbers to whole numbers first (64.6 becomes 65; half rounds up)', () => {
  const rows: Array<[number, number, string]> = [
    [64.6, 65.4, 'also-good'], // brief 9.1: both round to 65
    [64.6, 75, 'strong'],      // unrounded 64.6 would be under 65: worse
    [64.4, 75, 'worse'],
    [64.5, 70, 'also-good'],   // half rounds up: 65 against 70
    [69.6, 75.4, 'also-good'], // 70 against 75, gap 5 (unrounded gap 5.8)
    [69.4, 75.5, 'strong'],    // 69 against 76, gap 7
    [34.5, 50, 'worse'],       // 35
    [34.4, 50, 'losing'],      // 34
    [39.6, 45.4, 'close'],     // 40 against 45
    [39.4, 45.5, 'worse'],     // 39 against 46
  ];
  for (const [t, b, cls] of rows) assert.equal(classifyWin(t, b), cls, `${t}/${b}`);
  // Any decimals: the same class as their rounded values.
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 100; };
  for (let i = 0; i < 2000; i++) {
    const t = rand(), b = rand();
    assert.equal(classifyWin(t, b), classifyWin(Math.round(t), Math.round(b)), `${t}/${b}`);
  }
});

test('classifyWin gives null without two finite numbers', () => {
  assert.equal(classifyWin(70, null), null);
  assert.equal(classifyWin(Number.NaN, 70), null);
  assert.equal(classifyWin(70, Number.POSITIVE_INFINITY), null);
});

// ---------------------------------------------------------------------------------------------------------------
// Own-game kinds: pack, punish, agent

const OWN: EngineKind[] = ['pack', 'punish', 'agent'];
const plain = (kind: EngineKind) => (kind === 'pack' || kind === 'punish' ? STORED : NOT_THIS);
/** 9.11.2 (p): the SOFT grade of a trusted also-good or close try: the class is kept, the coach gets 'strong'. */
const nearSoft = (kind: EngineKind, cls: 'also-good' | 'close'): Grade =>
  ({ action: 'soft', cls, message: kind === 'agent' ? AGENT_LIKES : QUICK_LIKES, tryVerdict: 'strong', showNumbers: false });

interface Row { name: string; c: TryCheck | null; want: (kind: EngineKind) => Grade }
const OWN_ROWS: Row[] = [
  { name: 'no check (engine missing, failed, aborted or late)', c: null, want: k => unchecked(plain(k)) },
  { name: 'depth 9, also-good', c: check(70, 72, 9), want: () => ({ action: 'soft', cls: 'also-good', message: SHALLOW, tryVerdict: 'unchecked', showNumbers: false }) },
  { name: 'depth 9, close', c: check(60, 62, 9), want: () => ({ action: 'soft', cls: 'close', message: SHALLOW, tryVerdict: 'unchecked', showNumbers: false }) },
  { name: 'depth 9, strong', c: check(70, 90, 9), want: k => ({ action: 'error', cls: 'strong', message: plain(k), tryVerdict: 'unchecked', showNumbers: false }) },
  { name: 'depth 9, worse', c: check(50, 90, 9), want: k => ({ action: 'error', cls: 'worse', message: plain(k), tryVerdict: 'unchecked', showNumbers: false }) },
  { name: 'depth 9, losing', c: check(10, 90, 9), want: k => ({ action: 'error', cls: 'losing', message: plain(k), tryVerdict: 'unchecked', showNumbers: false }) },
  // 9.11.2 (p): these two rows were ACCEPT ("Also good.") under 9.1.
  { name: 'depth 10, also-good', c: check(70, 72, 10), want: k => nearSoft(k, 'also-good') },
  { name: 'depth 10, close', c: check(60, 62, 10), want: k => nearSoft(k, 'close') },
  { name: 'depth 10, strong', c: check(70, 90, 10), want: () => ({ action: 'soft', cls: 'strong', message: strongCopy(70, 90), intro: solving(70, 90), tryVerdict: 'strong', ...numbers(70, 90) }) },
  { name: 'depth 10, worse', c: check(50, 90, 10), want: k => ({ action: 'error', cls: 'worse', message: k === 'punish' ? HOOK : plain(k), intro: solving(50, 90), tryVerdict: 'worse', ...numbers(50, 90) }) },
  { name: 'depth 10, losing', c: check(10, 90, 10), want: k => ({ action: 'error', cls: 'losing', message: k === 'punish' ? HOOK : plain(k), intro: solving(10, 90), tryVerdict: 'losing', ...numbers(10, 90) }) },
  { name: 'depth 12 (the page default), also-good with decimals', c: check(81.7, 84.2, 12), want: k => nearSoft(k, 'also-good') },
  { name: 'depth 0, exact: a stalemate try against a mating answer', c: check(50, 100, 0), want: k => ({ action: 'error', cls: 'worse', message: k === 'punish' ? HOOK : plain(k), intro: solving(50, 100), tryVerdict: 'worse', ...numbers(50, 100) }) },
  // Depth 0 is trusted, and 9.11.2 (p) covers the whole accept branch: two stalemates are SOFT too (was ACCEPT).
  { name: 'depth 0, exact: two stalemates', c: check(50, 50, 0), want: k => nearSoft(k, 'close') },
];

for (const kind of OWN) {
  test(`${kind}: one row per case`, () => {
    for (const row of OWN_ROWS) {
      const g = gradeTry(engine(kind, row.c));
      assert.deepEqual(g, row.want(kind), `${kind}, ${row.name}`);
      assertCopy(g, `${kind}, ${row.name}`);
    }
  });
}

test('boundaries for own-game cards: tryWin 64/65, gap 5/6, 34/35, depth 9/10', () => {
  const g = (t: number, b: number, depth = 12) => gradeTry(engine('pack', check(t, b, depth)));
  // 9.11.2 (p): a near try is SOFT like a strong one, so the verdict sent to the coach is part of the pair.
  const pair = (x: Grade) => [x.cls, x.action, x.tryVerdict];
  // tryWin 64 / 65, gap under 6 (both were ACCEPT under 9.1)
  assert.deepEqual(pair(g(64, 66)), ['close', 'soft', 'strong']);
  assert.deepEqual(pair(g(65, 66)), ['also-good', 'soft', 'strong']);
  // tryWin 64 / 65, gap over 5
  assert.deepEqual(pair(g(64, 75)), ['worse', 'error', 'worse']);
  assert.deepEqual(pair(g(65, 75)), ['strong', 'soft', 'strong']);
  // gap 5 / 6, above and below 65
  assert.deepEqual(pair(g(70, 75)), ['also-good', 'soft', 'strong']);
  assert.deepEqual(pair(g(70, 76)), ['strong', 'soft', 'strong']);
  assert.deepEqual(pair(g(40, 45)), ['close', 'soft', 'strong']);
  assert.deepEqual(pair(g(40, 46)), ['worse', 'error', 'worse']);
  // tryWin 34 / 35 with a gap over 5
  assert.deepEqual(pair(g(34, 50)), ['losing', 'error', 'losing']);
  assert.deepEqual(pair(g(35, 50)), ['worse', 'error', 'worse']);
  // depth 9 / 10
  assert.deepEqual(pair(g(70, 72, 9)), ['also-good', 'soft', 'unchecked']);
  assert.deepEqual(pair(g(70, 72, 10)), ['also-good', 'soft', 'strong']);
  assert.deepEqual(pair(g(70, 90, 9)), ['strong', 'error', 'unchecked']);
  assert.deepEqual(pair(g(70, 90, 10)), ['strong', 'soft', 'strong']);
  // The try scored above the answer but under 65: close, a soft retry (A4 open issue 1: 53 against 52; was ACCEPT).
  assert.deepEqual(pair(g(53.1, 52.2)), ['close', 'soft', 'strong']);
  // The near copy differs from the strong copy, and only the strong copy has numbers.
  assert.equal(g(70, 75).message, QUICK_LIKES);
  assert.equal(g(70, 75).showNumbers, false);
  assert.equal(g(70, 76).showNumbers, true);
});

test('rounding changes the action, and check.verdict (tenths, three classes) is never read', () => {
  // 64.6 against 75: 65/75 strong, a soft retry (unrounded it would be worse, an error).
  assert.deepEqual(gradeTry(engine('pack', check(64.6, 75))), {
    action: 'soft', cls: 'strong', message: strongCopy(65, 75), intro: solving(65, 75), tryVerdict: 'strong', ...numbers(65, 75),
  });
  assert.equal(gradeTry(engine('pack', check(64.4, 75))).action, 'error');
  // 69.6 against 75.4: 70/75, gap 5, also-good: the near SOFT without numbers (unrounded gap 5.8 would be strong, a
  // SOFT with numbers). Was ACCEPT under 9.1; 9.11.2 (p) makes both SOFT, so the class and the copy tell them apart.
  assert.deepEqual(gradeTry(engine('agent', check(69.6, 75.4))), nearSoft('agent', 'also-good'));
  // tryMove's L4 verdict says worse for 64.6/69.6; the rounded 9.1 class says also-good, and that decides.
  assert.equal(l4Verdict(64.6, 69.6), 'worse');
  const g = gradeTry(engine('punish', check(64.6, 69.6, 12, { verdict: l4Verdict(64.6, 69.6) })));
  assert.deepEqual([g.cls, g.action, g.tryVerdict, g.showNumbers], ['also-good', 'soft', 'strong', false]);
  for (const verdict of ['also-good', 'worse', 'losing'] as const) {
    assert.deepEqual(gradeTry(engine('pack', check(50, 90, 12, { verdict }))), gradeTry(engine('pack', check(50, 90, 12))));
    assert.deepEqual(gradeTry(engine('bank', check(70, 72, 12, { verdict }))), gradeTry(engine('bank', check(70, 72, 12))));
  }
});

test('punish: "off the hook" only when the best move keeps 65% or more (8.1: the analysis must show it)', () => {
  const msg = (kind: EngineKind, t: number, b: number) => gradeTry(engine(kind, check(t, b))).message;
  assert.equal(msg('punish', 40, 65), HOOK);
  assert.equal(msg('punish', 40, 64), STORED);
  assert.equal(msg('punish', 40, 64.6), HOOK); // rounds to 65
  assert.equal(msg('punish', 40, 64.4), STORED);
  assert.equal(msg('punish', 20, 60), STORED); // losing, but the best move only keeps 60
  assert.equal(msg('punish', 0, 100), HOOK);
  assert.equal(msg('pack', 0, 100), STORED);
  assert.equal(msg('agent', 0, 100), NOT_THIS);
  // Untrusted depth never makes the claim.
  assert.equal(gradeTry(engine('punish', check(0, 100, 9))).message, STORED);
});

test('Black to move: the intro names Black', () => {
  assert.equal(gradeTry(engine('pack', check(30, 95), 'b')).intro, solving(30, 95, 'Black'));
  // The punish row was a 70/71 accept intro; 9.11.2 (p) drops that intro, so a strong punish try carries the check.
  assert.equal(gradeTry(engine('punish', check(70, 90), 'b')).intro, solving(70, 90, 'Black'));
  assert.equal(gradeTry(engine('punish', check(70, 71), 'b')).intro, undefined);
  assert.equal(gradeTry(engine('bank', check(70, 71), 'b')).intro, solving(70, 71, 'Black'));
});

test('a check for another try, or without two numbers, counts as no analysis', () => {
  // Same move, case and spaces ignored: the check is used (the near SOFT of 9.11.2 p; was ACCEPT under 9.1).
  assert.deepEqual(gradeTry(engine('pack', check(70, 72), 'w', ' G1F3 ')), nearSoft('pack', 'also-good'));
  assert.deepEqual(gradeTry(engine('pack', check(70, 72), 'w', 'b1c3')), unchecked(STORED));
  assert.deepEqual(gradeTry(engine('bank', check(70, 72), 'w', 'b1c3')), unchecked(NOT_THIS));
  for (const c of [check(70, null), check(Number.NaN, 72), check(70, Number.POSITIVE_INFINITY)]) {
    assert.deepEqual(gradeTry(engine('agent', c)), unchecked(NOT_THIS));
    assert.deepEqual(gradeTry(engine('punish', c)), unchecked(STORED));
  }
  // A depth that is not a number is not trusted.
  assert.deepEqual(gradeTry(engine('pack', check(70, 72, Number.NaN))), { action: 'soft', cls: 'also-good', message: SHALLOW, tryVerdict: 'unchecked', showNumbers: false });
});

// ---------------------------------------------------------------------------------------------------------------
// Bank puzzles: always an error (counted at once); the background check only changes the words

const BANK_ROWS: Row[] = [
  { name: 'no check', c: null, want: () => unchecked(NOT_THIS) },
  { name: 'depth 9, also-good', c: check(70, 72, 9), want: () => ({ action: 'error', cls: 'also-good', message: NOT_THIS, tryVerdict: 'unchecked', showNumbers: false }) },
  { name: 'depth 9, close', c: check(60, 62, 9), want: () => ({ action: 'error', cls: 'close', message: NOT_THIS, tryVerdict: 'unchecked', showNumbers: false }) },
  { name: 'depth 9, worse', c: check(50, 90, 9), want: () => ({ action: 'error', cls: 'worse', message: NOT_THIS, tryVerdict: 'unchecked', showNumbers: false }) },
  { name: 'depth 10, also-good', c: check(70, 72, 10), want: () => ({ action: 'error', cls: 'also-good', message: LIKES, intro: solving(70, 72), tryVerdict: 'also-good', ...numbers(70, 72) }) },
  { name: 'depth 10, close', c: check(60, 62, 10), want: () => ({ action: 'error', cls: 'close', message: LIKES, intro: solving(60, 62), tryVerdict: 'close', ...numbers(60, 62) }) },
  { name: 'depth 10, strong', c: check(70, 90, 10), want: () => ({ action: 'error', cls: 'strong', message: NOT_THIS, intro: solving(70, 90), tryVerdict: 'strong', ...numbers(70, 90) }) },
  { name: 'depth 10, worse', c: check(50, 90, 10), want: () => ({ action: 'error', cls: 'worse', message: NOT_THIS, intro: solving(50, 90), tryVerdict: 'worse', ...numbers(50, 90) }) },
  { name: 'depth 10, losing', c: check(10, 90, 10), want: () => ({ action: 'error', cls: 'losing', message: NOT_THIS, intro: solving(10, 90), tryVerdict: 'losing', ...numbers(10, 90) }) },
  { name: 'depth 0, exact: a stalemate try against a mating answer', c: check(50, 100, 0), want: () => ({ action: 'error', cls: 'worse', message: NOT_THIS, intro: solving(50, 100), tryVerdict: 'worse', ...numbers(50, 100) }) },
  { name: 'rounding: 64.6 against 69.6 is also-good', c: check(64.6, 69.6, 12), want: () => ({ action: 'error', cls: 'also-good', message: LIKES, intro: solving(65, 70), tryVerdict: 'also-good', ...numbers(65, 70) }) },
];

test('bank: one row per case; never accepted, never soft', () => {
  for (const row of BANK_ROWS) {
    const g = gradeTry(engine('bank', row.c));
    assert.deepEqual(g, row.want('bank'), `bank, ${row.name}`);
    assertCopy(g, `bank, ${row.name}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Engine kinds over a grid

test('engine grades: invariants over a grid of numbers, depths, kinds and sides', () => {
  const wins = [0, 10.4, 34.4, 34.5, 35, 49.9, 50, 59.5, 64.4, 64.5, 64.6, 65, 69.6, 70, 75.4, 80, 90, 97.5, 100];
  let rows = 0;
  for (const kind of ['bank', ...OWN] as EngineKind[]) {
    for (const solver of ['w', 'b'] as const) {
      for (const depth of [0, 1, 9, 10, 12, 20]) {
        for (const t of wins) {
          for (const b of wins) {
            const where = `${kind} ${solver} depth ${depth} ${t}/${b}`;
            const g = gradeTry(engine(kind, check(t, b, depth), solver));
            const cls = classifyWin(t, b)!;
            const sure = depth === 0 || depth >= 10;
            const near = cls === 'also-good' || cls === 'close';
            // 9.11.2 (p): a trusted near try on an own-game kind is SOFT, 'strong' for the coach, with no numbers.
            const nearOwn = sure && near && kind !== 'bank';
            const shown = sure && !nearOwn;
            assert.equal(g.cls, cls, where);
            assert.equal(g.tryVerdict, !sure ? 'unchecked' : nearOwn ? 'strong' : cls, where);
            assert.equal(g.showNumbers, shown, where);
            assert.equal(g.intro !== undefined, shown, where);
            assert.deepEqual([g.tryWin, g.bestWin], shown ? [Math.round(t), Math.round(b)] : [undefined, undefined], where);
            assert.equal('tryWin' in g, shown, where);
            const text = `${g.message} ${g.intro ?? ''}`;
            if (!shown) assert.ok(!text.includes('%'), where);
            const action = kind === 'bank' ? 'error'
              : !sure ? (near ? 'soft' : 'error')
              : near || cls === 'strong' ? 'soft' : 'error';
            assert.equal(g.action, action, where);
            // Never ACCEPT since 9.11.2 (p), so the answer is never named.
            assert.notEqual(g.action, 'accept', where);
            assert.ok(!namesSan(text, ANSWER), `${where}: the answer is not named`);
            if (g.intro !== undefined) assert.ok(g.intro.startsWith(`After ${TRY} `), where);
            assertCopy(g, where);
            rows++;
          }
        }
      }
    }
  }
  assert.equal(rows, 4 * 2 * 6 * 19 * 19);
});

test('gradeTry is pure: frozen input, same output twice', () => {
  const c = Object.freeze(check(70, 90, 12, { replyLine: Object.freeze(['d7d5']) as string[] }));
  const input = Object.freeze(engine('punish', c));
  assert.deepEqual(gradeTry(input), gradeTry(input));
  const tl = Object.freeze<TeachTry>({ uci: 'e2d3', san: 'Kd3', result: 'draw', lineUci: Object.freeze(['e8d7']) as string[], note: 'Kd3 lets the other king in, and the game is a draw.' });
  const drill = Object.freeze<GradeInput>({ kind: 'endgame', trySan: 'Kd3', answerSan: 'Ke3', solver: 'w', teach: Object.freeze({ result: 'draw' as const, tryLine: tl, goal: Object.freeze({ result: 'win' as const }) }) });
  assert.deepEqual(gradeTry(drill), gradeTry(drill));
});

test('input shape: a drill takes no engine check and an engine card takes no teach data (checked by tsc)', () => {
  // @ts-expect-error an endgame drill is never graded from the engine
  const a: GradeInput = { kind: 'endgame', trySan: 'Kd3', answerSan: 'Ke3', solver: 'w', teach: null, check: null };
  // @ts-expect-error a bank, pack, punish or agent card takes `check` (or null), not teach data
  const b: GradeInput = { kind: 'bank', trySan: TRY, answerSan: ANSWER, solver: 'w', check: null, teach: { result: 'win', goal: { result: 'win' } } };
  // At run time the kind decides: no numbers on a drill; the generic copy on a bank card without a check.
  assert.deepEqual(gradeTry(a), unchecked(NOT_THIS));
  assert.deepEqual(gradeTry(b), unchecked(NOT_THIS));
});

// ---------------------------------------------------------------------------------------------------------------
// Endgame drills: tablebase words, never a percentage

const NOTE = 'Kd3 lets the other king in, and the game is a draw.'; // invented
const tryLine = (result: TeachResult, note = NOTE, uci = 'e2d3'): TeachTry => ({ uci, san: 'Kd3', result, lineUci: ['e8d7'], note });
const drillInput = (teach: TeachGrade | null, answerSan = 'Ke3', tryUci?: string): GradeInput =>
  ({ kind: 'endgame', trySan: 'Kd3', answerSan, solver: 'w', teach, ...(tryUci === undefined ? {} : { tryUci }) });
const WIN: DrillGoal = { result: 'win' }, DRAW: DrillGoal = { result: 'draw' }, MATE2: DrillGoal = { result: 'win', mateIn: 2 };

test('endgame: one row per case (goal kept, slower mate, goal lost, no result)', () => {
  const rows: Array<[string, TeachGrade | null, Grade]> = [
    ['win drill, the try also wins, not listed', { result: 'win', goal: WIN },
      { action: 'soft', cls: 'goal-kept', message: ALSO_WINS, tryVerdict: 'also-good', showNumbers: false }],
    ['win drill, the try also wins, listed', { result: 'win', tryLine: tryLine('win', 'Kd3 still wins, but more slowly.'), goal: WIN },
      { action: 'soft', cls: 'goal-kept', message: ALSO_WINS, intro: 'Kd3 still wins, but more slowly.', tryVerdict: 'also-good', showNumbers: false }],
    ['draw drill, the try also holds', { result: 'draw', tryLine: tryLine('draw'), goal: DRAW },
      { action: 'soft', cls: 'goal-kept', message: ALSO_HOLDS, intro: NOTE, tryVerdict: 'also-good', showNumbers: false }],
    ['draw drill, the try even wins (copy follows the goal)', { result: 'win', goal: DRAW },
      { action: 'soft', cls: 'goal-kept', message: ALSO_HOLDS, tryVerdict: 'also-good', showNumbers: false }],
    ['mate in two, a slower mate', { result: 'win', tryLine: tryLine('win', 'Kd3 still wins, and the mate takes one move longer.'), goal: MATE2 },
      { action: 'soft', cls: 'slower-mate', message: 'That also mates, but not in two. Try again.', intro: 'Kd3 still wins, and the mate takes one move longer.', tryVerdict: 'strong', showNumbers: false }],
    ['mate in three, a slower mate', { result: 'win', goal: { result: 'win', mateIn: 3 } },
      { action: 'soft', cls: 'slower-mate', message: 'That also mates, but not in three. Try again.', tryVerdict: 'strong', showNumbers: false }],
    ['mate in 12 (digits past ten)', { result: 'win', goal: { result: 'win', mateIn: 12 } },
      { action: 'soft', cls: 'slower-mate', message: 'That also mates, but not in 12. Try again.', tryVerdict: 'strong', showNumbers: false }],
    ['win drill, the try only draws', { result: 'draw', tryLine: tryLine('draw'), goal: WIN },
      { action: 'error', cls: 'goal-lost', message: ONLY_DRAWS, intro: NOTE, tryVerdict: 'worse', showNumbers: false }],
    ['mate drill, the try only draws (a stalemate)', { result: 'draw', goal: MATE2 },
      { action: 'error', cls: 'goal-lost', message: ONLY_DRAWS, tryVerdict: 'worse', showNumbers: false }],
    ['win drill, the try loses', { result: 'loss', goal: WIN },
      { action: 'error', cls: 'goal-lost', message: LOSES, tryVerdict: 'losing', showNumbers: false }],
    ['draw drill, the try loses', { result: 'loss', tryLine: tryLine('loss', 'Kd3 walks away from the pawn: White wins.'), goal: DRAW },
      { action: 'error', cls: 'goal-lost', message: LOSES, intro: 'Kd3 walks away from the pawn: White wins.', tryVerdict: 'losing', showNumbers: false }],
    ['no result for the move', { result: null, goal: WIN }, unchecked(NOT_THIS)],
    ['no teach data', null, unchecked(NOT_THIS)],
  ];
  for (const [name, teach, want] of rows) {
    const g = gradeTry(drillInput(teach));
    assert.deepEqual(g, want, name);
    assertCopy(g, name);
    assert.ok(!`${g.message} ${g.intro ?? ''}`.includes('%'), `${name}: words only`);
  }
});

test('endgame: a note that names the answer, or a listed try for another move, is not used as the intro', () => {
  const naming = gradeTry(drillInput({ result: 'draw', tryLine: tryLine('draw', 'After Kd3 Kd7 2.Ke3+ the game is a draw.'), goal: WIN }));
  assert.deepEqual(naming, { action: 'error', cls: 'goal-lost', message: ONLY_DRAWS, tryVerdict: 'worse', showNumbers: false });
  const checkSign = gradeTry(drillInput({ result: 'draw', tryLine: tryLine('draw', 'Kd3 Kd7 Ke3# is not possible here.'), goal: WIN }, 'Ke3+'));
  assert.equal(checkSign.intro, undefined);
  // A different move that merely contains the answer's letters is not the answer.
  assert.equal(gradeTry(drillInput({ result: 'draw', tryLine: tryLine('draw', 'Kd3 and later Re4 is a draw.'), goal: WIN }, 'e4')).intro, 'Kd3 and later Re4 is a draw.');
  assert.equal(gradeTry(drillInput({ result: 'draw', tryLine: tryLine('draw', 'Kd3 and later O-O-O is a draw.'), goal: WIN }, 'O-O')).intro, 'Kd3 and later O-O-O is a draw.');
  assert.equal(gradeTry(drillInput({ result: 'draw', tryLine: tryLine('draw', 'Kd3 and later 2.e4 is a draw.'), goal: WIN }, 'e4')).intro, undefined);
  // tryUci given: the listed try must be the same move.
  assert.equal(gradeTry(drillInput({ result: 'draw', tryLine: tryLine('draw'), goal: WIN }, 'Ke3', 'e2d3')).intro, NOTE);
  assert.equal(gradeTry(drillInput({ result: 'draw', tryLine: tryLine('draw'), goal: WIN }, 'Ke3', 'e2f3')).intro, undefined);
  // A mate count that is not a positive whole number is a plain win goal.
  for (const mateIn of [0, -1, 2.5, Number.NaN]) {
    assert.equal(gradeTry(drillInput({ result: 'win', goal: { result: 'win', mateIn } })).message, ALSO_WINS, String(mateIn));
  }
});

test('endgameGoal reads the drill themes: planb holds the draw, mateInN asks for mate in N', () => {
  assert.deepEqual(endgameGoal(['endgame-tech', 'pawnEndgame', 'planb']), { result: 'draw' });
  assert.deepEqual(endgameGoal(['endgame-tech', 'mate', 'mateIn2']), { result: 'win', mateIn: 2 });
  assert.deepEqual(endgameGoal(['endgame-tech', 'rookEndgame']), { result: 'win' });
  assert.deepEqual(endgameGoal(['mateIn0', 'mateInX', 'mate']), { result: 'win' });
  const counts: Record<string, number> = {};
  for (const d of endgameDrills) {
    const g = endgameGoal(d.themes);
    const k = g.result === 'draw' ? 'draw' : g.mateIn ? `mate${g.mateIn}` : 'win';
    counts[k] = (counts[k] ?? 0) + 1;
  }
  assert.deepEqual(counts, { draw: 13, win: 9, mate2: 3, mate3: 1 });
});

// ---------------------------------------------------------------------------------------------------------------
// Endgame drills: the real tablebase data

const drillById = new Map(endgameDrills.map(d => [d.id, d]));
const playSan = (fen: string, uci: string) => new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
function realInput(id: string, step: number, uci: string): GradeInput {
  const drill = drillById.get(id)!;
  const s = drillTeach(id)!.steps.find(x => x.step === step)!;
  return {
    kind: 'endgame', trySan: playSan(s.fen, uci).san, answerSan: playSan(s.fen, drill.moves[step]).san, solver: new Chess(s.fen).turn(),
    tryUci: uci, teach: { ...teachTry(id, s.fen, uci), goal: endgameGoal(drill.themes) },
  };
}

test('endgame: real drills (Codex acceptance cases, a loss, a stalemate, an unknown position)', () => {
  // Lucena, Kc7 first: the tablebase still wins, so a soft retry, not "this only draws".
  assert.deepEqual(gradeTry(realInput('tech-lucena-rook-to-the-fourth', 0, 'b8c7')),
    { action: 'soft', cls: 'goal-kept', message: ALSO_WINS, tryVerdict: 'also-good', showNumbers: false });
  // King and pawn against king: e4 only draws (Kd6 holds).
  assert.deepEqual(gradeTry(realInput('tech-kpk-take-the-opposition', 0, 'e3e4')), {
    action: 'error', cls: 'goal-lost', message: ONLY_DRAWS, tryVerdict: 'worse', showNumbers: false,
    intro: 'After e4, Black takes the opposition with Kd6, the only move that holds, and the game is a draw.',
  });
  // Mate in two: Ra8+ still mates, one move later.
  assert.deepEqual(gradeTry(realInput('tech-krk-mate-in-two-king-step', 0, 'a7a8')), {
    action: 'soft', cls: 'slower-mate', message: 'That also mates, but not in two. Try again.', tryVerdict: 'strong', showNumbers: false,
    intro: 'Ra8+ still wins, but the king steps out to h7, and the mate takes one move longer.',
  });
  // Hold-the-draw drill: Kc4 misses the square and loses.
  assert.deepEqual(gradeTry(realInput('tech-rule-of-the-square', 0, 'c3c4')), {
    action: 'error', cls: 'goal-lost', message: LOSES, tryVerdict: 'losing', showNumbers: false,
    intro: 'Kc4 does not step into the square of the pawn (d4 to h8), so the h-pawn runs and promotes on h8: White wins.',
  });
  // Queen mate: Qf7 is stalemate, a draw.
  const kqk = drillTeach('tech-kqk-mate-in-two-king-step')!.steps[0];
  const qf7 = kqk.tries.find(t => t.san === 'Qf7')!;
  assert.deepEqual(gradeTry(realInput('tech-kqk-mate-in-two-king-step', 0, qf7.uci)),
    { action: 'error', cls: 'goal-lost', message: ONLY_DRAWS, intro: qf7.note, tryVerdict: 'worse', showNumbers: false });
  // A position the drill does not have: no result, generic copy.
  const nowhere = '8/8/8/8/8/8/8/K6k w - - 0 1';
  assert.deepEqual(gradeTry({ kind: 'endgame', trySan: 'Ka2', answerSan: 'Kb2', solver: 'w', teach: { ...teachTry('tech-kpk-take-the-opposition', nowhere, 'a1a2'), goal: WIN } }), unchecked(NOT_THIS));
  assert.deepEqual(gradeTry({ kind: 'endgame', trySan: 'Ka2', answerSan: 'Kb2', solver: 'w', teach: { ...teachTry('tech-no-such-drill', nowhere, 'a1a2'), goal: WIN } }), unchecked(NOT_THIS));
});

test('endgame: every legal non-answer move of every drill step is graded in words, and the answer is never named', () => {
  let graded = 0, listed = 0, matesSkipped = 0;
  const guarded: string[] = [];
  const counts: Record<string, number> = {};
  for (const id of teachDrillIds()) {
    const drill = drillById.get(id)!;
    const goal = endgameGoal(drill.themes);
    for (const s of drillTeach(id)!.steps) {
      const answerUci = drill.moves[s.step];
      const answerSan = playSan(s.fen, answerUci).san;
      for (const uci of Object.keys(s.results)) {
        if (uci === answerUci) continue;
        const move = playSan(s.fen, uci);
        // The Trainer accepts any mating move before grading.
        if (move.san.endsWith('#')) { matesSkipped++; continue; }
        const g = gradeTry(realInput(id, s.step, uci));
        const where = `${id} step ${s.step} ${move.san}`;
        const result = s.results[uci];
        const kept = result === 'win' || (result === 'draw' && goal.result === 'draw');
        assert.equal(g.action, kept ? 'soft' : 'error', where);
        assert.equal(g.cls, kept ? (goal.mateIn ? 'slower-mate' : 'goal-kept') : 'goal-lost', where);
        assert.equal(g.showNumbers, false, where);
        assert.ok(!('tryWin' in g) && !('bestWin' in g), where);
        const text = `${g.message} ${g.intro ?? ''}`;
        assert.ok(!text.includes('%'), `${where}: words only`);
        assert.ok(!namesSan(text, answerSan), `${where}: names the answer ${answerSan}`);
        assertCopy(g, where);
        const tryEntry = s.tries.find(x => x.uci === uci);
        if (tryEntry) {
          listed++;
          if (g.intro === undefined) guarded.push(`${id}@${s.step}:${tryEntry.san}`);
          else assert.equal(g.intro, tryEntry.note, where);
        } else assert.equal(g.intro, undefined, where);
        counts[g.cls] = (counts[g.cls] ?? 0) + 1;
        graded++;
      }
    }
  }
  assert.equal(listed, 177, 'every listed try is graded');
  assert.equal(matesSkipped, 0, 'no drill step has a second mating move');
  // The two notes that mention the step's answer as a later move of their line (reported in logs/m3_G.md).
  assert.deepEqual(guarded.sort(), ['tech-kpkp-triangulation@4:Kb4', 'tech-wrong-bishop-corner@0:Kd7']);
  // Codex's count: 197 non-answer moves keep the goal, 32 of them outside the mate drills.
  assert.equal((counts['goal-kept'] ?? 0) + (counts['slower-mate'] ?? 0), 197);
  assert.equal(counts['goal-kept'], 32);
  assert.ok(graded > 197);
});

const CACHE = process.env.NEXT_MOVE_TB_CACHE || join(ARTIFACT_DIR, '../reviews/claude/data/verification/tbcache.json');
test('mate drills: every other winning move mates more slowly, so "not in N" is true (tablebase cache)',
  { skip: existsSync(CACHE) ? false : `tablebase cache not found at ${CACHE}` }, () => {
    const cache = JSON.parse(readFileSync(CACHE, 'utf8')) as Record<string, { moves: Array<{ uci: string; dtm: number | null; checkmate: boolean }> }>;
    let checked = 0;
    for (const id of teachDrillIds()) {
      const drill = drillById.get(id)!;
      if (!endgameGoal(drill.themes).mateIn) continue;
      for (const s of drillTeach(id)!.steps) {
        const entry = cache[positionKey(s.fen)];
        assert.ok(entry, `${id} step ${s.step} is in the cache`);
        const answer = entry.moves.find(m => m.uci === drill.moves[s.step])!;
        for (const m of entry.moves) {
          if (m.uci === answer.uci || s.results[m.uci] !== 'win') continue;
          assert.equal(m.checkmate, false, `${id} step ${s.step} ${m.uci} is not a second mate`);
          if (!answer.checkmate) assert.ok(Math.abs(m.dtm ?? 0) > Math.abs(answer.dtm ?? 0), `${id} step ${s.step} ${m.uci} mates more slowly`);
          checked++;
        }
      }
    }
    assert.equal(checked, 165);
  });
