/**
 * M3 fix round 2, writer FX4a (brief 9.11.2 (p), review finding R3-1): a live depth-12 check never books another
 * move as correct.
 * - `gradeTry`: on pack, punish and agent cards a trusted also-good or close try is a SOFT retry, never ACCEPT, with
 *   the (p) copy, `tryVerdict` 'strong', no numbers and no intro. Untrusted near (SOFT "could not finish"), strong
 *   (SOFT), worse and losing (ERROR) and bank (always ERROR) are unchanged. `engineScan` (a position from a short
 *   engine scan) selects the agent words.
 * - The explain input for that try carries no depth-12 pair as figures, only the plain note `tryCheckNote`; the
 *   prompt states the note, leaves the pair out, and its instruction starts from the note.
 * Engine rows use hand-made checks (Nf3 tried where Bc4 is the answer). Coach rows use textbook positions (after
 * 1.e4 e5, and after 1.e4 e5 2.Nf3 Nc6 3.Ng5) with invented numbers. No position comes from the owner's games.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { classifyWin, gradeTry, type EngineKind, type Grade, type GradeInput } from '../src/teach/grade';
import type { TryCheck } from '../src/teach/tryMove';
import { explainInput, staticExplanation, type CoachCard } from '../components/coachInput';
import { buildExplainPrompt, groundCheck, inputsHash } from '../src/coach/index';
import { coachLabel, EXPLAIN_NEUTRAL_LABEL } from '../components/CoachPanel';
import type { CoachClient, CoachExplainInput } from '../src/contract/coach';

const TRY = 'Nf3', ANSWER = 'Bc4';
const QUICK = 'The quick engine check likes Nf3 too, but the analysis that picked this card found one clearly better move. Try again.';
const AGENT = 'The engine likes Nf3 too, but this card is after a different move. Try again.';
const SHALLOW = 'The engine could not finish checking Nf3. This card is after a different move. Try again.';
const STORED = 'That is not the move from the stored line.';
const NOT_THIS = 'That is not the move this card is after.';
const HOOK = 'That lets your opponent off the hook.';
/** Version 7.1 (brief m31 4.6, F3): a counted punish miss that itself still keeps 55% or more. */
const SMALL_EDGE = 'That keeps only a small edge. There is a clearly stronger move.';
const BANK_LIKES = 'The engine likes Nf3 too, but this puzzle is after a different idea.';
const strongCopy = (t: number, b: number) => `Good idea, but there is a stronger move: after Nf3 the engine gives you ${t}% to win, the best move keeps ${b}%. Try again.`;
const solving = (t: number, b: number) => `After Nf3 the engine gives White ${t}% to win; the best move keeps ${b}%.`;

/** A check as `checkTry` returns it; `verdict` is deliberately wrong, `gradeTry` must never read it. */
const check = (tryWin: number, bestWin: number, depth = 12): TryCheck =>
  ({ tryUci: 'g1f3', trySan: TRY, replyLine: ['b8c6', 'd2d4'], tryWin, bestWin, verdict: 'losing', depth, ms: 40 });
const grade = (kind: EngineKind, c: TryCheck | null, engineScan?: boolean): Grade =>
  gradeTry({ kind, trySan: TRY, answerSan: ANSWER, solver: 'w', check: c, ...(engineScan === undefined ? {} : { engineScan }) });
const nums = (t: number, b: number) => ({ showNumbers: true, tryWin: t, bestWin: b });
const nearSoft = (cls: 'also-good' | 'close', message: string): Grade => ({ action: 'soft', cls, message, tryVerdict: 'strong', showNumbers: false });

// ---------------------------------------------------------------- gradeTry: the (p) rows, word for word

test('(p) gradeTry: a trusted also-good or close try on pack, punish and agent cards is SOFT with the (p) copy, never ACCEPT', () => {
  const rows: Array<[string, Grade, Grade]> = [
    ['pack, also-good 70/72', grade('pack', check(70, 72)), nearSoft('also-good', QUICK)],
    ['punish, close 60/62', grade('punish', check(60, 62)), nearSoft('close', QUICK)],
    ['agent, also-good 70/72', grade('agent', check(70, 72)), nearSoft('also-good', AGENT)],
    ['agent, close 60/62', grade('agent', check(60, 62)), nearSoft('close', AGENT)],
    // One reproduced case had the try above the card's move on the page's numbers: still SOFT, and no pair shown.
    ['pack, the try above the answer, 67/63', grade('pack', check(67, 63)), nearSoft('also-good', QUICK)],
    ['punish, the try above the answer, 79/77', grade('punish', check(78.6, 77.2)), nearSoft('also-good', QUICK)],
    // Close under 65 (both moves below the winning line), and the try above the answer under 65.
    ['pack, close under 65, 40/45', grade('pack', check(40, 45)), nearSoft('close', QUICK)],
    ['punish, close under 65 with the try above, 53/52', grade('punish', check(53.1, 52.2)), nearSoft('close', QUICK)],
    // The 65 line and the gap of 5 (classes from rounded numbers).
    ['pack, also-good at 65, 65/70', grade('pack', check(64.6, 69.6)), nearSoft('also-good', QUICK)],
    ['agent, close at 64, 64/66', grade('agent', check(64, 66)), nearSoft('close', AGENT)],
    // Depth 0 (both positions already finished) is trusted: the whole accept branch becomes SOFT.
    ['pack, depth 0, two stalemates 50/50', grade('pack', check(50, 50, 0)), nearSoft('close', QUICK)],
    ['punish, depth 10, also-good 96/100', grade('punish', check(96.4, 99.6, 10)), nearSoft('also-good', QUICK)],
  ];
  for (const [name, got, want] of rows) assert.deepEqual(got, want, name);
});

test('(p) gradeTry: unchanged classes and kinds (untrusted near, strong, worse, losing, bank, no check)', () => {
  const rows: Array<[string, Grade, Grade]> = [
    ['pack, depth 9, also-good', grade('pack', check(70, 72, 9)), { action: 'soft', cls: 'also-good', message: SHALLOW, tryVerdict: 'unchecked', showNumbers: false }],
    ['agent, depth 9, close', grade('agent', check(60, 62, 9)), { action: 'soft', cls: 'close', message: SHALLOW, tryVerdict: 'unchecked', showNumbers: false }],
    ['punish, depth 9, strong', grade('punish', check(70, 90, 9)), { action: 'error', cls: 'strong', message: STORED, tryVerdict: 'unchecked', showNumbers: false }],
    ['pack, strong 70/90', grade('pack', check(70, 90)), { action: 'soft', cls: 'strong', message: strongCopy(70, 90), intro: solving(70, 90), tryVerdict: 'strong', ...nums(70, 90) }],
    ['agent, strong at 65, 65/71', grade('agent', check(65, 71)), { action: 'soft', cls: 'strong', message: strongCopy(65, 71), intro: solving(65, 71), tryVerdict: 'strong', ...nums(65, 71) }],
    ['pack, worse 50/90', grade('pack', check(50, 90)), { action: 'error', cls: 'worse', message: STORED, intro: solving(50, 90), tryVerdict: 'worse', ...nums(50, 90) }],
    // m31 F3: this row read "off the hook" in version 7. A try at 64 still keeps an edge; only the message differs.
    ['punish, worse 64/70 (gap 6 under 65)', grade('punish', check(64, 70)), { action: 'error', cls: 'worse', message: SMALL_EDGE, intro: solving(64, 70), tryVerdict: 'worse', ...nums(64, 70) }],
    ['punish, worse 50/90', grade('punish', check(50, 90)), { action: 'error', cls: 'worse', message: HOOK, intro: solving(50, 90), tryVerdict: 'worse', ...nums(50, 90) }],
    ['agent, losing 10/90', grade('agent', check(10, 90)), { action: 'error', cls: 'losing', message: NOT_THIS, intro: solving(10, 90), tryVerdict: 'losing', ...nums(10, 90) }],
    ['punish, losing 34/50', grade('punish', check(34, 50)), { action: 'error', cls: 'losing', message: STORED, intro: solving(34, 50), tryVerdict: 'losing', ...nums(34, 50) }],
    ['bank, also-good 70/72', grade('bank', check(70, 72)), { action: 'error', cls: 'also-good', message: BANK_LIKES, intro: solving(70, 72), tryVerdict: 'also-good', ...nums(70, 72) }],
    ['bank, close 60/62', grade('bank', check(60, 62)), { action: 'error', cls: 'close', message: BANK_LIKES, intro: solving(60, 62), tryVerdict: 'close', ...nums(60, 62) }],
    ['bank, depth 9, also-good', grade('bank', check(70, 72, 9)), { action: 'error', cls: 'also-good', message: NOT_THIS, tryVerdict: 'unchecked', showNumbers: false }],
    ['bank, strong 70/90', grade('bank', check(70, 90)), { action: 'error', cls: 'strong', message: NOT_THIS, intro: solving(70, 90), tryVerdict: 'strong', ...nums(70, 90) }],
    ['pack, no check', grade('pack', null), { action: 'error', cls: 'unchecked', message: STORED, tryVerdict: 'unchecked', showNumbers: false }],
    ['agent, no check', grade('agent', null), { action: 'error', cls: 'unchecked', message: NOT_THIS, tryVerdict: 'unchecked', showNumbers: false }],
  ];
  for (const [name, got, want] of rows) assert.deepEqual(got, want, name);
});

test('(p) gradeTry: engineScan (a position from a short engine scan) gets the agent words for a near try, and nothing else changes', () => {
  assert.deepEqual(grade('pack', check(70, 72), true), nearSoft('also-good', AGENT));
  assert.deepEqual(grade('punish', check(60, 62), true), nearSoft('close', AGENT));
  assert.deepEqual(grade('pack', check(70, 72), false), nearSoft('also-good', QUICK), 'false is the default');
  for (const c of [check(70, 72, 9), check(70, 90), check(50, 90), check(10, 90)]) {
    for (const kind of ['pack', 'punish', 'agent', 'bank'] as const) assert.deepEqual(grade(kind, c, true), grade(kind, c), `${kind} ${c.tryWin}/${c.bestWin} d${c.depth}`);
  }
  assert.deepEqual(grade('bank', check(70, 72), true), grade('bank', check(70, 72)), 'bank is unchanged');
});

test('(p) gradeTry, every class x trusted or not x pack, punish, agent, bank: the matrix of 9.11.2', () => {
  const pairs: Array<[number, number]> = [[70, 72], [67, 63], [60, 62], [40, 45], [70, 90], [65, 71], [50, 90], [64, 70], [10, 90], [34, 50]];
  const seen = new Set<string>();
  for (const kind of ['pack', 'punish', 'agent', 'bank'] as const) {
    for (const depth of [9, 10, 12, 0]) {
      for (const [t, b] of pairs) {
        const where = `${kind} d${depth} ${t}/${b}`;
        const g = grade(kind, check(t, b, depth));
        const cls = classifyWin(t, b)!;
        const sure = depth === 0 || depth >= 10;
        const near = cls === 'also-good' || cls === 'close';
        seen.add(`${cls} ${sure}`);
        const plain = kind === 'agent' || kind === 'bank' ? NOT_THIS : STORED;
        let want: Grade;
        if (kind === 'bank') {
          want = sure ? { action: 'error', cls, message: near ? BANK_LIKES : NOT_THIS, intro: solving(t, b), tryVerdict: cls, ...nums(t, b) }
            : { action: 'error', cls, message: NOT_THIS, tryVerdict: 'unchecked', showNumbers: false };
        } else if (!sure) {
          want = near ? { action: 'soft', cls, message: SHALLOW, tryVerdict: 'unchecked', showNumbers: false } : { action: 'error', cls, message: plain, tryVerdict: 'unchecked', showNumbers: false };
        } else if (near) {
          want = nearSoft(cls, kind === 'agent' ? AGENT : QUICK);
        } else if (cls === 'strong') {
          want = { action: 'soft', cls, message: strongCopy(t, b), intro: solving(t, b), tryVerdict: 'strong', ...nums(t, b) };
        } else {
          // m31 F3: on a punish card whose best move keeps 65 or more, a miss at 55 or more reads "small edge" (the pair 64/70).
          want = { action: 'error', cls, message: kind === 'punish' && b >= 65 ? (t >= 55 ? SMALL_EDGE : HOOK) : plain, intro: solving(t, b), tryVerdict: cls, ...nums(t, b) };
        }
        assert.deepEqual(g, want, where);
      }
    }
  }
  // Every class, trusted and untrusted, was covered.
  for (const cls of ['also-good', 'close', 'strong', 'worse', 'losing']) for (const sure of [true, false]) assert.ok(seen.has(`${cls} ${sure}`), `${cls} ${sure}`);
});

test('(p) invariant: no engine kind, depth or pair of whole numbers is ever accepted, and the answer is never named', () => {
  let n = 0;
  for (const kind of ['pack', 'punish', 'agent', 'bank'] as const) {
    for (const engineScan of [undefined, true]) {
      for (const depth of [0, 9, 12]) {
        for (let t = 0; t <= 100; t++) {
          for (let b = 0; b <= 100; b++) {
            const g = grade(kind, check(t, b, depth), engineScan);
            if (g.action === 'accept') assert.fail(`${kind} d${depth} ${t}/${b}: accepted`);
            const text = `${g.message} ${g.intro ?? ''}`;
            if (/\bBc4\b/.test(text)) assert.fail(`${kind} d${depth} ${t}/${b}: names the answer`);
            if (g.action === 'soft' && g.tryVerdict === 'strong' && (g.cls === 'also-good' || g.cls === 'close')) {
              // The (p) SOFT: no numbers anywhere.
              if (g.showNumbers || g.intro !== undefined || g.tryWin !== undefined || g.bestWin !== undefined || text.includes('%')) assert.fail(`${kind} d${depth} ${t}/${b}: numbers on the (p) SOFT`);
            }
            n++;
          }
        }
      }
    }
  }
  assert.equal(n, 4 * 2 * 3 * 101 * 101);
  // Endgame drills never accept either (their SOFT and ERROR rows are in tests/m3_grade.test.ts).
  const drill: GradeInput = { kind: 'endgame', trySan: 'Kd3', answerSan: 'Ke3', solver: 'w', teach: { result: 'win', goal: { result: 'win' } } };
  assert.equal(gradeTry(drill).action, 'soft');
});

// ---------------------------------------------------------------- the coach input for the (p) case

/** After 1.e4 e5, White to move: Nf3 and Bc4 are both legal. */
const E4E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
/** After 1.e4 e5 2.Nf3 Nc6, White to move (a punish card's `pack.sourceFen`), and after 3.Ng5, Black to move. */
const GAME_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
const PUNISH_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p1N1/4P3/8/PPPP1PPP/RNBQKB1R b KQkq - 3 3';

test('fixtures are legal: the lines and tries below are played by chess.js from their positions', () => {
  const play = (fen: string, line: string[]) => { const b = new Chess(fen); for (const u of line) b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); return b; };
  for (const line of [['f1c4', 'g8f6', 'd2d3'], ['g1f3', 'b8c6', 'd2d4'], ['d2d4', 'e5d4', 'd1d4']]) assert.doesNotThrow(() => play(E4E5, line), line.join(' '));
  assert.equal(play(GAME_FEN, ['f3g5']).fen(), PUNISH_FEN, '3.Ng5 reaches the punish position');
  for (const line of [['d8g5', 'd2d4', 'g5g6'], ['h7h6', 'g5f3']]) assert.doesNotThrow(() => play(PUNISH_FEN, line), line.join(' '));
});
/** A pack card (invented figures): the card's move Bc4; his game move d4, with a stored reply line and figures. */
const packCard = (): CoachCard => ({
  id: 'pack-fx4a-0000000001', fen: E4E5, moves: ['f1c4', 'g8f6'], themes: ['opening'],
  pack: { pvUci: ['f1c4', 'g8f6', 'd2d3'], playedUci: 'd2d4', playedSan: 'd4', refutationPvUci: ['e5d4', 'd1d4'], winBefore: 60, winAfter: 48, timeClass: 'rapid', date: '2026-01-01' },
});
const tryNf3 = { fen: E4E5, uci: 'g1f3', index: 0 };
const NOTE_PACK = "A quick engine check in this page rated Nf3 close to the card's move, but the analysis that picked this card found one clearly better move.";
const NOTE_AGENT = "A quick engine check in this page rated Nf3 close to the card's move, but this card is after a different move.";
const NOTE_TASK = 'Say in plain words what the note on Nf3 says. Then compare the two lines: say what Bc4 does that Nf3 does not. Do not say that Nf3 fails or loses, and do not say that it is as good as Bc4.';
/** Claims the (p) instruction never makes. */
const CLAIMS = ['keeps a good game', 'is still a good move', 'is about as good as', 'is nearly as good as', 'what goes wrong', 'Winning chances'];
const at = (prompt: string, s: string) => { const i = prompt.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };

test('(p) explain input: the soft near try carries tryVerdict strong, no depth-12 pair, and the plain note', () => {
  const card = packCard();
  // 66 against 64: the try above the card's move on the page's numbers (also-good).
  const input = explainInput(card, tryNf3, 'pack', { check: check(66, 64) })!;
  assert.ok(input);
  assert.deepEqual([input.tryVerdict, input.tryWin, input.bestWin, 'tryWin' in input, 'bestWin' in input], ['strong', undefined, undefined, false, false]);
  assert.equal(input.tryCheckNote, NOTE_PACK);
  assert.deepEqual([input.tryLineSan, input.trySource], [['Nf3', 'Nc6', 'd4'], 'engine'], 'the quick check line stays (the try viewer shows it too)');
  // Not his game move: no stored figures or reply line.
  assert.deepEqual([input.winBefore, input.winAfter, input.refutationSan], [undefined, undefined, []]);
  assert.deepEqual([input.step, input.spoilersAllowed], [0, true]);
  // Close (60 against 62) gets the same note; the coach label is the neutral one.
  const close = explainInput(card, tryNf3, 'pack', { check: check(60, 62) })!;
  assert.deepEqual([close.tryVerdict, close.tryWin, close.bestWin, close.tryCheckNote], ['strong', undefined, undefined, NOTE_PACK]);
  const coach: CoachClient = { availability: async () => 'granted', ask: async () => { throw new Error('not called'); }, limits: () => ({ remainingToday: 20, cooldownUntil: 0 }) };
  assert.equal(coachLabel(coach, 'granted', input.tryVerdict), EXPLAIN_NEUTRAL_LABEL);
  // Same try and check, same input and hash; the note is part of the hash.
  assert.equal(inputsHash(input), inputsHash(explainInput(card, tryNf3, 'pack', { check: check(66, 64) })!));
  const { tryCheckNote: _note, ...withoutNote } = input;
  assert.notEqual(inputsHash(input), inputsHash(withoutNote));
});

test('(p) explain input: the note on punish, agent and engine-scan cards; none on bank cards or for the other classes', () => {
  // Punish: after 1.e4 e5 2.Nf3 Nc6 3.Ng5, Black to move; the card's move Qxg5; the try h6 (invented numbers).
  const punish: CoachCard = { id: 'punish-fx4a-1', fen: PUNISH_FEN, moves: ['d8g5'], themes: ['punish'], kind: 'punish', pack: { pvUci: ['d8g5', 'd2d4', 'g5g6'], sourceFen: GAME_FEN, playedUci: 'f3g5', playedSan: 'Ng5', solverColor: 'b' } };
  const h6: TryCheck = { tryUci: 'h7h6', trySan: 'h6', replyLine: ['g5f3'], tryWin: 80, bestWin: 84, verdict: 'losing', depth: 12, ms: 40 };
  const p = explainInput(punish, { fen: PUNISH_FEN, uci: 'h7h6', index: 0 }, 'pack', { check: h6 })!;
  assert.deepEqual([p.tryVerdict, p.tryWin, p.bestWin, p.tryLineSan], ['strong', undefined, undefined, ['h6', 'Nf3']]);
  assert.equal(p.tryCheckNote, "A quick engine check in this page rated h6 close to the card's move, but the analysis that picked this card found one clearly better move.");
  // Claude's drills and positions from a short engine scan: the note claims nothing about an analysis that picked them.
  const agent = explainInput({ id: 'agent-fx4a-1', fen: E4E5, moves: ['f1c4'], themes: ['opening'], title: 'Develop a piece' }, tryNf3, 'agent', { check: check(70, 72) })!;
  assert.deepEqual([agent.tryVerdict, agent.tryWin, agent.tryCheckNote], ['strong', undefined, NOTE_AGENT]);
  const personal = explainInput({ id: 'personal-fx4a-1', fen: E4E5, moves: ['f1c4'], themes: ['personal'] }, tryNf3, 'personal', { check: check(70, 72) })!;
  assert.deepEqual([personal.tryVerdict, personal.tryWin, personal.tryCheckNote], ['strong', undefined, NOTE_AGENT]);
  // Bank: the error is counted and the numbers stay (unchanged); no note.
  const bank = explainInput({ id: '00fx4', fen: E4E5, moves: ['f1c4', 'g8f6'], themes: ['opening'] }, tryNf3, 'bank', { check: check(70, 72) })!;
  assert.deepEqual([bank.tryVerdict, bank.tryWin, bank.bestWin, bank.tryCheckNote], ['also-good', 70, 72, undefined]);
  // Pack, the other classes: unchanged, never a note.
  const card = packCard();
  const shallow = explainInput(card, tryNf3, 'pack', { check: check(70, 72, 9) })!;
  assert.deepEqual([shallow.tryVerdict, shallow.tryWin, shallow.bestWin, shallow.trySource, shallow.tryCheckNote], ['unchecked', undefined, undefined, 'engine', undefined]);
  for (const [t, b, cls] of [[70, 90, 'strong'], [50, 90, 'worse'], [10, 90, 'losing']] as const) {
    const i = explainInput(card, tryNf3, 'pack', { check: check(t, b) })!;
    assert.deepEqual([i.tryVerdict, i.tryWin, i.bestWin, i.tryCheckNote], [cls, t, b, undefined], `${t}/${b}`);
  }
  // No check: no note.
  assert.equal(explainInput(card, tryNf3, 'pack')!.tryCheckNote, undefined);
});

test('(p) explain prompt: the note replaces the numbers and the instruction starts from it', () => {
  const input = explainInput(packCard(), tryNf3, 'pack', { check: check(66, 64) })!;
  const built = buildExplainPrompt(input);
  const p = built.prompt;
  const line = at(p, "Line after the learner's try (engine line, searched in this page): Nf3 Nc6 d4.");
  const note = at(p, `Note on the learner's try: ${NOTE_PACK}`);
  assert.ok(line < note && note < at(p, 'Themes: opening.'), 'the note sits where the numbers were: after the try line, before the themes');
  at(p, NOTE_TASK);
  assert.ok(!p.includes('%'), 'no Win% at all');
  for (const x of [66, 64, 2]) assert.ok(!built.numbers.includes(x), `${x} is not citable`);
  for (const c of CLAIMS) assert.ok(!p.includes(c), `no "${c}"`);
  // Grounding: an answer that follows the note passes; a figure for the pair is flagged.
  const ok = groundCheck('A quick check rated Nf3 close to Bc4, but the analysis that picked this card found Bc4 clearly better. After Bc4 Nf6 the bishop on c4 points at f7.', built, 'explain');
  assert.deepEqual(ok, { grounded: true, misses: [] });
  assert.deepEqual(groundCheck('Nf3 scores 66% and Bc4 64%.', built, 'explain').grounded, false);
});

// FX4b (brief 9.11.3, R5-5) changed this test. It pinned FX4a's decision 8: the stored drop (60, 48, 12) and the stored
// reply line stayed beside the note. R5-5 leaves the stored figures and the reply line out whenever the try has a finished
// live check, the (p) case included, so the note stands alone and the static panel shows no stored numbers either.
test('(p) explain prompt: his own game move as the try with a finished check: the note alone, no stored drop and no live pair (R5-5)', () => {
  const card = packCard();
  const d4: TryCheck = { tryUci: 'd2d4', trySan: 'd4', replyLine: ['e5d4', 'd1d4'], tryWin: 58, bestWin: 61, verdict: 'losing', depth: 12, ms: 40 };
  const input = explainInput(card, { fen: E4E5, uci: 'd2d4', index: 0 }, 'pack', { check: d4 })!;
  assert.deepEqual([input.tryVerdict, input.tryWin, input.bestWin, input.winBefore, input.winAfter, input.refutationSan], ['strong', undefined, undefined, undefined, undefined, []]);
  assert.deepEqual([input.trySource, input.tryLineSan], ['engine', ['d4', 'exd4', 'Qxd4']], 'the live line stays');
  assert.equal(input.tryCheckNote, "A quick engine check in this page rated d4 close to the card's move, but the analysis that picked this card found one clearly better move.");
  const built = buildExplainPrompt(input);
  assert.ok(!built.prompt.includes('Stored winning chances'), 'no stored drop beside the note');
  at(built.prompt, `Note on the learner's try: ${input.tryCheckNote}`);
  at(built.prompt, 'Say in plain words what the note on d4 says. Then compare the two lines: say what Bc4 does that d4 does not.');
  for (const x of [58, 61, 3, 60, 48, 12]) assert.ok(!built.numbers.includes(x), `${x} is not citable`);
  assert.ok(!built.prompt.includes('%'));
  for (const c of CLAIMS.filter(c => c !== 'Winning chances')) assert.ok(!built.prompt.includes(c), `no "${c}"`);
  // The static panel (no model) reads the same input: no stored numbers and no stored reply line.
  assert.deepEqual(staticExplanation(input), { playedSan: 'd4', bestLineSan: input.bestLineSan, refutationSan: [], numbers: null });
  // Without a finished check (no check, or depth 9) the stored figures and reply line stay, as before.
  for (const c of [null, { ...d4, depth: 9 }]) {
    const stored = explainInput(card, { fen: E4E5, uci: 'd2d4', index: 0 }, 'pack', { check: c })!;
    assert.deepEqual([stored.winBefore, stored.winAfter, stored.refutationSan, stored.tryCheckNote], [60, 48, ['exd4', 'Qxd4'], undefined]);
    assert.equal(staticExplanation(stored).numbers, 'Stored win chance for you: 60% before, 48% after.');
  }
});

test('(p) explain prompt: while solving, the note keeps the answer out; with other classes or on a drill the note is ignored', () => {
  const input = explainInput(packCard(), tryNf3, 'pack', { check: check(66, 64) })!;
  // While solving (spoilersAllowed false): the note never names the answer, and the instruction does not either.
  const solvingPrompt = buildExplainPrompt({ ...input, spoilersAllowed: false }).prompt;
  at(solvingPrompt, `Note on the learner's try: ${NOTE_PACK}`);
  at(solvingPrompt, "Say in plain words what the note on Nf3 says. Then say what the line after Nf3 shows, if one is given. Do not say that Nf3 fails or loses, and do not say that it is as good as the card's answer.");
  assert.ok(!/\bBc4\b/.test(solvingPrompt), 'the answer is not named while solving');
  // also-good and close from the page use the note the same way.
  for (const v of ['also-good', 'close'] as const) at(buildExplainPrompt({ ...input, tryVerdict: v }).prompt, NOTE_TASK);
  // A note that came with numbers: the numbers are left out.
  const withPair = buildExplainPrompt({ ...input, tryWin: 66, bestWin: 64 });
  assert.ok(!withPair.prompt.includes('%') && !withPair.numbers.includes(66) && !withPair.numbers.includes(64));
  at(withPair.prompt, NOTE_TASK);
  // Worse or losing: the note is ignored, the class decides as before (numbers and the fault wording).
  const worse = buildExplainPrompt({ ...input, tryVerdict: 'worse', tryWin: 50, bestWin: 90 }).prompt;
  assert.ok(!worse.includes('Note on the learner'));
  at(worse, 'First say what goes wrong after Nf3, naming the reply Nc6.');
  at(worse, '90% after Bc4, 50% after Nf3, a difference of 40 points.');
  assert.ok(!buildExplainPrompt({ ...input, tryVerdict: 'losing' }).prompt.includes('Note on the learner'));
  // Unchecked: ignored, neutral as before.
  const unchecked = buildExplainPrompt({ ...input, tryVerdict: 'unchecked' }).prompt;
  assert.ok(!unchecked.includes('Note on the learner'));
  at(unchecked, 'Say how Nf3 and Bc4 differ, using only these lines. Do not claim that Nf3 fails or loses.');
  // No class from the page: ignored (the class is derived from the numbers as before).
  const { tryVerdict: _v, ...noVerdict } = input;
  const derived = buildExplainPrompt({ ...noVerdict, tryWin: 70, bestWin: 72 }).prompt;
  assert.ok(!derived.includes('Note on the learner'));
  at(derived, 'By these numbers Nf3 is about as good as Bc4.');
  // An endgame drill never uses the engine: the note is ignored there.
  const drill = buildExplainPrompt({ ...input, source: 'endgame', answerSource: 'tablebase' }).prompt;
  assert.ok(!drill.includes('Note on the learner') && !drill.includes('what the note'));
  // An empty note is no note: the strong wording of the page's check (no numbers) as before.
  const blank = buildExplainPrompt({ ...input, tryCheckNote: '   ' }).prompt;
  assert.ok(!blank.includes('Note on the learner'));
  at(blank, "By the page's check Nf3 keeps a good game, but Bc4 is stronger.");
  // A long note is cut at 400 characters, never an error.
  const long = buildExplainPrompt({ ...input, tryCheckNote: `${NOTE_PACK} ${'x'.repeat(600)}` }).prompt;
  const noteLine = long.split('\n').find(l => l.startsWith("Note on the learner's try: "))!;
  assert.ok(noteLine.length <= "Note on the learner's try: ".length + 401);
});

test('(p) the shapes R3-1 reproduced, with invented numbers: a try near or above the answer at depth 12: never booked', () => {
  // R3 and its skeptic reproduced accepts on own-game cards from one depth-12 search (their cards and numbers stay
  // in the PRIVATE review logs). The same shapes with invented numbers, on both own-game kinds: a gap of about 5,
  // the try above the answer, the try at the 65 line.
  for (const kind of ['pack', 'punish'] as const) {
    for (const [t, b] of [[76.2, 80.9], [67.4, 62.1], [66.2, 70.6], [79.3, 77.4], [65.2, 69.8], [80.4, 81.7]] as const) {
      const g = grade(kind, check(t, b));
      assert.deepEqual([g.action, g.tryVerdict, g.showNumbers, g.message], ['soft', 'strong', false, QUICK], `${kind} ${t}/${b}`);
    }
  }
});
