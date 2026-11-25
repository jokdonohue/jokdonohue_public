/**
 * M3 C-core stage (c) (brief 9.6, 9.1, 8.18, 8.6): grading a try through `gradeTry`, the board waiting for the
 * engine on own-game cards, the bank level in selection, the phone layout.
 *
 * The page has no DOM test renderer (a static render of the Trainer stops at "Loading"), so the Trainer's click paths
 * cannot run here. The decision is one exported function (`gradeCardTry`), the check behind it another
 * (`gradeAfterCheck`, driven here by a stub engine), and the wiring between them and the Trainer's state is pinned by
 * reading Trainer.tsx, as tests/b2_trainer.test.tsx, m3_trainer_a and m3_trainer_b do.
 *
 * Positions are textbook or invented, each checked with chess.js; the endgame drills are the page's own textbook
 * drills (data/technical_endgames.json). Engine results come from a stub engine. No owner game data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chess } from 'chess.js';
import {
  answerMovesFrom, attemptFor, createTryGate, drillGoalAt, gradeAfterCheck, gradeCardTry, HowToLook, LAYOUT_QUERIES, layoutNow, PracticeColumns, TRY_DEADLINE_MS, TrySlot,
  tryKey, tryViewOf, waitsForEngine, warmEngine, type GradedTry, type PracticeLayout, type PracticeParts, type TryView,
} from '../components/Trainer';
import type { TrainerItem } from '../components/pools';
import { bankLevel } from '../components/bankLevel';
import { selectPuzzle, type Progress as SchedulerProgress } from '../lib/scheduler.js';
import { sessionAttemptSchema } from '../src/contract/docs';
import { explainInput } from '../components/coachInput';
import type { TryCheck } from '../src/teach/tryMove';
import type { AnalysisEngine } from '../src/analysis/engine';
import { endgameDrills } from '../lib/endgames';
import { drillTeach } from '../lib/endgameTeach';
import { ARTIFACT_DIR } from './b3_paths';

const src = readFileSync(join(ARTIFACT_DIR, 'components/Trainer.tsx'), 'utf8');
/** Where a function declared in Trainer.tsx starts and ends (parameter list and body matched by bracket counting). */
function body(name: string): string {
  const m = new RegExp(`function ${name}\\(`).exec(src);
  assert.ok(m, `${name} found`);
  let i = m.index + m[0].length, depth = 1;
  for (; depth > 0; i++) depth += src[i] === '(' ? 1 : src[i] === ')' ? -1 : 0;
  i = src.indexOf('{', i);
  for (depth = 1, i++; depth > 0; i++) depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0;
  return src.slice(m.index, i);
}
function after(fen: string, uci: string) {
  const b = new Chess(fen);
  const m = b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return { fen: b.fen(), san: m.san };
}
const key4 = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
const check = (o: Partial<TryCheck> & Pick<TryCheck, 'tryUci' | 'trySan' | 'replyLine' | 'tryWin'>): TryCheck =>
  ({ bestWin: null, verdict: 'worse', depth: 12, ms: 5, ...o });

// ---------------------------------------------------------------- fixtures (invented)

/** His game (White): Re7 leaves the back rank; Black (the solver) plays Rd1+ Re1 Rxe1#. Better was h3. */
const BEFORE = '3r2k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';
const PUNISH_FEN = after(BEFORE, 'e1e7').fen;
const punishCard = (): TrainerItem => ({
  id: 'punish-t1', fen: PUNISH_FEN, moves: ['d8d1'], rating: 1000, themes: ['personal', 'opening'], gameUrl: '', source: 'pack', kind: 'punish',
  pack: { playedSan: 'Re7', playedUci: 'e1e7', sourceFen: BEFORE, pvUci: ['d8d1', 'e7e1', 'd1e1'], rowId: 't1', winAfter: 2, solverColor: 'b' },
});
/** Black's try 1...h6 against the card's 1...Rd1+, with a reply line 2.Kf1 Rd1+ 3.Re1. */
const TRY = { uci: 'h7h6', san: 'h6', reply: ['g1f1', 'd8d1', 'e7e1'] };
const tryCheck = (tryWin: number, bestWin: number, depth = 12) => check({ tryUci: TRY.uci, trySan: TRY.san, replyLine: TRY.reply, tryWin, bestWin, depth });
/** A mistake card from his games (White): Qxd8# wins; his game move Qd7 lets the rook take the queen. */
const MISTAKE_FEN = '3r2k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1';
const mistakeCard = (): TrainerItem => ({
  id: 'pack-m1', fen: MISTAKE_FEN, moves: ['d1d8'], rating: 1000, themes: ['personal'], gameUrl: '', source: 'pack', kind: 'mistake',
  pack: { playedSan: 'Qd7', playedUci: 'd1d7', pvUci: ['d1d8'], refutationPvUci: ['d8d7', 'h2h3'], winBefore: 99.6, winAfter: 0.4 },
});
/** The French after 1.e4 e6 2.d4 d5, as a Lichess puzzle: the line is 3.Nc3 Nf6 4.Bg5; his try 3.exd5. */
const FRENCH = 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6 0 3';
const frenchBank = (): TrainerItem => ({ id: 'bank-french', fen: FRENCH, moves: ['b1c3', 'g8f6', 'c1g5'], rating: 1400, themes: ['opening', 'advantage'], gameUrl: '', source: 'bank' });
const drill = (id: string): TrainerItem => {
  const d = endgameDrills.find(x => x.id === id);
  assert.ok(d, id);
  return { id: d!.id, fen: d!.fen, moves: [...d!.moves], rating: d!.rating, themes: [...d!.themes], gameUrl: '', source: 'endgame', title: d!.title };
};

/**
 * A stub engine: the score of each searched position (White's view) from `scores`, keyed by the position, a legal
 * first move as its line, after `delayMs`; or never (`hang`); or a failure. An abort rejects at once, as the worker
 * engine does.
 */
function stubEngine(scores: Record<string, { cp?: number; mate?: number }>, o: { depth?: number; delayMs?: number; hang?: boolean; fail?: boolean } = {}): AnalysisEngine & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls, dispose() {},
    analyse(fen, { signal }) {
      calls.push(fen);
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => { clearTimeout(timer); reject(new DOMException('Analysis stopped.', 'AbortError')); };
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
        if (o.fail) { reject(new Error('The engine failed.')); return; }
        if (o.hang) return;
        timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          const s = scores[key4(fen)] ?? { cp: 0 };
          const m = new Chess(fen).moves({ verbose: true })[0];
          resolve([{ multipv: 1, depth: o.depth ?? 12, score: { cp: s.cp ?? null, mate: s.mate ?? null }, pv: m ? [`${m.from}${m.to}${m.promotion ?? ''}`] : [] }]);
        }, o.delayMs ?? 1);
      });
    },
  };
}
/** Scores for the punish card: after 1...Rd1+ Black mates in two; after 1...h6 the given score (White's view). */
const punishScores = (afterTry: { cp?: number; mate?: number }) => ({ [key4(after(PUNISH_FEN, 'd8d1').fen)]: { mate: -2 }, [key4(after(PUNISH_FEN, TRY.uci).fen)]: afterTry });

test('fixtures are legal: every line replays with chess.js', () => {
  const lines: Array<[string, string[]]> = [[BEFORE, ['e1e7', 'd8d1', 'e7e1', 'd1e1']], [PUNISH_FEN, [TRY.uci, ...TRY.reply]], [MISTAKE_FEN, ['d1d7', 'd8d7', 'h2h3']], [FRENCH, ['b1c3', 'g8f6', 'c1g5']], [FRENCH, ['e4d5', 'e6d5']]];
  for (const [fen, line] of lines) { const b = new Chess(fen); for (const u of line) assert.doesNotThrow(() => b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }), `${u} from ${fen}`); }
});

// ---------------------------------------------------------------- own-game kinds: accept, soft, error, null (9.1)

test('near try (9.11.2 p, which replaced the 9.1 accept): a try the engine rates about as highly is a soft retry, never booked, with no numbers', () => {
  // Fix round 2: this test pinned 9.1's ACCEPT ("Also good. The engine rates h6 about as highly as the card's move, Rd1+.",
  // the card completed as correct). Brief 9.11.2 (p): one live depth-12 check never books another move as correct on his
  // games, punish cards or Claude's drills; the near try is SOFT, its viewer has no numbers and no figure.
  const card = punishCard();
  const g = gradeCardTry(card, card.fen, TRY.uci, 0, tryCheck(96.4, 99.6));
  assert.deepEqual([g.grade.action, g.grade.cls, g.grade.tryVerdict, g.grade.showNumbers], ['soft', 'also-good', 'strong', false]);
  assert.equal(g.grade.message, 'The quick engine check likes h6 too, but the analysis that picked this card found one clearly better move. Try again.');
  assert.equal(g.source, 'engine');
  assert.deepEqual(g.text, { line: [TRY.uci, ...TRY.reply], title: 'What could follow h6' }, 'the try first, then the engine reply line; no intro');
  assert.deepEqual([g.verdict, g.numbers], [undefined, undefined], 'no depth-12 pair anywhere, not even as the closing figure');
  assert.doesNotMatch(`${g.grade.message} ${g.text!.title}`, /Rd1|%/, 'never the answer, never a number');
  const view = tryViewOf(tryKey(card.id, 0, TRY.uci), card.fen, TRY.uci, answerMovesFrom(card, card.fen, 0), g)!;
  assert.equal(view.collapsed, true, 'one press away');
  assert.equal(view.check, g.check, 'the raw check stays on the view for the coach input (its note, FX4a)');
  // "close" (gap 5 or less, under 65) and a depth of 0 (a finished position) are soft too: nothing is ever accepted.
  for (const c of [tryCheck(30, 35), tryCheck(100, 100, 0), tryCheck(67, 63)]) assert.deepEqual([gradeCardTry(card, card.fen, TRY.uci, 0, c).grade.action, gradeCardTry(card, card.fen, TRY.uci, 0, c).grade.showNumbers], ['soft', false]);
  // The attempts the page still records: an unaided solve is correct and clean (no playedUci, only version-6 fields, L10).
  const attempt = attemptFor({ item: card, revealed: false, clean: true, hints: 0, startedAt: 1_000, now: 4_000 });
  assert.deepEqual(attempt, { puzzleId: 'punish-t1', themes: ['personal', 'opening'], correct: true, unassisted: true, hints: 0, revealed: false, durationMs: 3_000, at: 4_000, source: 'pack' });
  assert.deepEqual(sessionAttemptSchema.parse(attempt), attempt);
  const hinted = attemptFor({ item: card, revealed: false, clean: true, hints: 2, startedAt: 1_000, now: 4_000 });
  assert.deepEqual([hinted.correct, hinted.unassisted], [true, false], 'clean only with no hints');
  const afterError = attemptFor({ item: card, revealed: false, clean: false, hints: 0, startedAt: 1_000, now: 4_000, playedUci: 'g8f8' });
  assert.deepEqual([afterError.correct, afterError.unassisted, afterError.playedUci], [false, false, 'g8f8'], 'or no earlier error');
});

test('soft retry (strong): a winning try well below the best counts nothing, is not played, and its line waits one press away', () => {
  const card = punishCard();
  const g = gradeCardTry(card, card.fen, TRY.uci, 0, tryCheck(75.1, 99.6));
  assert.equal(g.grade.action, 'soft');
  assert.equal(g.grade.message, 'Good idea, but there is a stronger move: after h6 the engine gives you 75% to win, the best move keeps 100%. Try again.');
  assert.equal(g.grade.tryVerdict, 'strong');
  assert.equal(g.text!.title, 'What could follow h6', 'no failure claim');
  assert.equal(g.text!.intro, 'After h6 the engine gives Black 75% to win; the best move keeps 100%.');
  assert.doesNotMatch(`${g.grade.message} ${g.text!.intro}`, /Rd1/, 'nothing names the answer while he solves (8.2)');
  const view = tryViewOf(tryKey(card.id, 0, TRY.uci), card.fen, TRY.uci, answerMovesFrom(card, card.fen, 0), g)!;
  const html = renderToStaticMarkup(<TrySlot view={view} solving/>);
  assert.equal(html, '<div class="try-check"><button type="button" class="secondary line-viewer-toggle" aria-expanded="false">See the engine&#x27;s reply</button></div>');
  // 9.11.2 (r) 3: the numbers shown go along as the line's figure, the try's Win% for the solver.
  assert.deepEqual([view.verdict, view.numbers], [{ side: 'b', win: 75.1 }, { tryWin: 75, bestWin: 100 }]);
  // A shallow search that finds the try about as good: soft "could not finish", no numbers, verdict unchecked.
  const shallow = gradeCardTry(card, card.fen, TRY.uci, 0, tryCheck(96, 99, 9));
  assert.deepEqual([shallow.grade.action, shallow.grade.tryVerdict, shallow.grade.showNumbers], ['soft', 'unchecked', false]);
  assert.equal(shallow.grade.message, 'The engine could not finish checking h6. This card is after a different move. Try again.');
  assert.equal(shallow.text!.title, 'What could follow h6');
  assert.equal(shallow.text!.intro, undefined);
  // The coach can be asked about a soft try: its class reaches the explain input, never a failure claim (9.2).
  const input = explainInput(card, { fen: card.fen, uci: TRY.uci, index: 0 }, card.source, { check: g.check })!;
  assert.deepEqual([input.tryVerdict, input.tryWin, input.bestWin], ['strong', 75, 100]);
});

test('error: a try below 65 and more than 5 under the best counts one error; its line opens at once, with numbers but no answer', () => {
  const card = punishCard();
  for (const [tryWin, cls] of [[50, 'worse'], [13.7, 'losing']] as const) {
    const g = gradeCardTry(card, card.fen, TRY.uci, 0, tryCheck(tryWin, 99.6));
    assert.deepEqual([g.grade.action, g.grade.tryVerdict], ['error', cls]);
    assert.equal(g.grade.message, 'That lets your opponent off the hook.', 'punish card, the best move keeps 65% or more: the analysis shows it');
    assert.equal(g.text!.title, "Why h6 doesn't work");
    assert.match(g.text!.intro!, /^After h6 the engine gives Black \d+% to win; the best move keeps 100%\.$/);
    const view = tryViewOf(tryKey(card.id, 0, TRY.uci), card.fen, TRY.uci, answerMovesFrom(card, card.fen, 0), g)!;
    assert.equal(view.collapsed, undefined, 'open after a counted miss');
    const html = renderToStaticMarkup(<TrySlot view={view} solving/>);
    assert.match(html, /<h3 [^>]*class="line-viewer-title">Why h6 doesn&#x27;t work<\/h3>/);
    assert.doesNotMatch(html, /Rd1\+|Rxe1/, 'the reply line stops before the answer while he solves');
  }
  // A mistake card from his games and Claude's drills: the 8.1 copy (no "off the hook").
  const mistake = mistakeCard();
  const m = gradeCardTry(mistake, mistake.fen, 'd1d6', 0, check({ tryUci: 'd1d6', trySan: 'Qd6', replyLine: ['d8d6'], tryWin: 0.4, bestWin: 100 }));
  assert.equal(m.grade.message, 'That is not the move from the stored line.');
  const agent: TrainerItem = { ...mistake, id: 'agent-1', source: 'agent', kind: undefined, pack: undefined };
  assert.equal(gradeCardTry(agent, agent.fen, 'd1d6', 0, check({ tryUci: 'd1d6', trySan: 'Qd6', replyLine: ['d8d6'], tryWin: 0.4, bestWin: 100 })).grade.message, 'That is not the move this card is after.');
  // A check for another move is no analysis of this try.
  assert.equal(gradeCardTry(card, card.fen, 'g7g6', 0, tryCheck(96, 99)).grade.tryVerdict, 'unchecked');
});

test('null (no engine, a failure or the 6 s deadline): an error with the honest copy and the stored line where L4 allows one', async () => {
  assert.equal(TRY_DEADLINE_MS, 6000);
  const mistake = mistakeCard();
  const stored = gradeCardTry(mistake, mistake.fen, 'd1d7', 0, null);
  assert.deepEqual([stored.grade.action, stored.grade.tryVerdict, stored.grade.message], ['error', 'unchecked', 'That is not the move from the stored line.']);
  assert.equal(stored.source, 'stored');
  assert.deepEqual(stored.text, { line: ['d1d7', 'd8d7', 'h2h3'], title: "Why Qd7 doesn't work", intro: 'After Qd7 the engine gives White 0% to win; the best move keeps 100%.' });
  assert.equal(gradeCardTry(mistake, mistake.fen, 'd1d6', 0, null).text, null, 'another move has no stored line');
  // Through the check: an engine that never answers is cut at the deadline (30 ms here), and the null grade arrives.
  const card = punishCard();
  const gate = createTryGate();
  const late: GradedTry[] = [];
  const t0 = Date.now();
  await gradeAfterCheck(gate, stubEngine({}, { hang: true }), card, card.fen, TRY.uci, 0, g => late.push(g), 30);
  assert.ok(Date.now() - t0 < 2_000);
  assert.equal(late.length, 1);
  assert.deepEqual([late[0].grade.action, late[0].grade.tryVerdict, late[0].grade.message], ['error', 'unchecked', 'That is not the move from the stored line.']);
  assert.equal(late[0].check, undefined);
  // A failing engine, and no engine at all (no Web Worker): the same grade, at once for the latter.
  const failed: GradedTry[] = [];
  await gradeAfterCheck(gate, stubEngine({}, { fail: true }), card, card.fen, TRY.uci, 0, g => failed.push(g));
  assert.equal(failed[0].grade.tryVerdict, 'unchecked');
  const none: GradedTry[] = [];
  void gradeAfterCheck(gate, null, card, card.fen, TRY.uci, 0, g => none.push(g));
  assert.equal(none.length, 1, 'synchronous without an engine');
});

test('the check behind the grade: the stub engine answers, and the grade follows the scores (soft, error; 9.11.2 p: never accept)', async () => {
  const card = punishCard();
  // Fix round 2: the mate-in-five row (also good) pinned an accept; under 9.11.2 (p) it is a soft retry, 'strong' to the coach.
  const cases: Array<[{ cp?: number; mate?: number }, string, string]> = [[{ mate: -5 }, 'soft', 'strong'], [{ cp: -300 }, 'soft', 'strong'], [{ cp: 0 }, 'error', 'worse'], [{ cp: 500 }, 'error', 'losing']];
  for (const [score, action, verdict] of cases) {
    const got: GradedTry[] = [];
    const engine = stubEngine(punishScores(score));
    await gradeAfterCheck(createTryGate(), engine, card, card.fen, TRY.uci, 0, g => got.push(g));
    assert.equal(got.length, 1);
    assert.deepEqual([got[0].grade.action, got[0].grade.tryVerdict], [action, verdict], JSON.stringify(score));
    assert.equal(engine.calls.length, 2, 'the try and the answer, one search each');
    assert.equal(got[0].check?.tryUci, TRY.uci);
  }
  // A shallow worker result (depth 9) never accepts: soft "could not finish" or an error, without numbers.
  const shallow: GradedTry[] = [];
  await gradeAfterCheck(createTryGate(), stubEngine(punishScores({ mate: -5 }), { depth: 9 }), card, card.fen, TRY.uci, 0, g => shallow.push(g));
  assert.deepEqual([shallow[0].grade.action, shallow[0].grade.showNumbers], ['soft', false]);
});

test('a stale result is ignored: a new card (or a newer try, or a step change) stops the check, and nothing arrives', async () => {
  const card = punishCard();
  const gate = createTryGate();
  const dropped: GradedTry[] = [];
  const pending = gradeAfterCheck(gate, stubEngine(punishScores({ mate: -5 }), { delayMs: 20 }), card, card.fen, TRY.uci, 0, g => dropped.push(g));
  assert.equal(gate.pending(), true);
  gate.stop(); // what clearTry() does when a new card is shown, and dropPendingTry() on a step change or a reveal
  await pending;
  assert.deepEqual(dropped, [], 'the grade for the old card never lands on the new one');
  // A newer try on the same card: only its grade arrives.
  const first: GradedTry[] = [], second: GradedTry[] = [];
  const slow = stubEngine(punishScores({ cp: -300 }), { delayMs: 20 });
  const p1 = gradeAfterCheck(gate, slow, card, card.fen, TRY.uci, 0, g => first.push(g));
  const p2 = gradeAfterCheck(gate, slow, card, card.fen, 'g7g6', 0, g => second.push(g));
  await Promise.all([p1, p2]);
  assert.deepEqual(first, []);
  assert.equal(second.length, 1);
  // The Trainer checks the identity again when the grade lands (card, step and try, card not finished), and drops a
  // "Checking …" that is no longer its own, so the board can never stay locked.
  const settle = body('settleTry');
  assert.match(settle, /if \(!item \|\| complete \|\| recorded\.current \|\| tryKey\(item\.id, index, uci\) !== key\) \{\s*setTryView\(v => \(v\?\.key === key && v\.status === 'checking' \? null : v\)\);\s*return;\s*\}/);
  // FX2c (9.11.3 R2-1, the deadline path): the callback clears `warmed` on a grade with no result before it settles (it
  // read `g => settleLatest.current(key, fenBefore, uci, at, g)`); every grade still lands through `settleLatest`.
  assert.match(src, /void gradeAfterCheck\(tryGate, engine, item, fenBefore, uci, at, g => \{[^]*?settleLatest\.current\(key, fenBefore, uci, at, g\);\s*\}\);/);
  assert.match(src, /const settleLatest = useRef\(settleTry\);\s*settleLatest\.current = settleTry;/, 'a late grade sees the state on screen now');
  for (const fn of ['startPuzzle', 'startSafe', 'choose']) assert.match(body(fn), /clearTry\(\)/, `${fn} stops a running check`);
  assert.match(body('reveal'), /dropPendingTry\(\);/);
});

// ---------------------------------------------------------------- Lichess puzzles: the error at once, the background message

test('bank: the error counts at once with the honest copy; a deep check that likes the try changes only the message', () => {
  const bank = frenchBank();
  const now = gradeCardTry(bank, FRENCH, 'e4d5', 0, null);
  assert.deepEqual([now.grade.action, now.grade.message], ['error', 'That is not the move this card is after.']);
  const liked = gradeCardTry(bank, FRENCH, 'e4d5', 0, check({ tryUci: 'e4d5', trySan: 'exd5', replyLine: ['e6d5', 'b1c3'], tryWin: 55, bestWin: 58 }));
  assert.deepEqual([liked.grade.action, liked.grade.tryVerdict], ['error', 'close'], 'never accepted, never soft: Lichess puzzles have one solution');
  assert.equal(liked.grade.message, 'The engine likes exd5 too, but this puzzle is after a different idea.');
  assert.equal(liked.text!.title, 'What could follow exd5');
  assert.equal(liked.text!.intro, 'After exd5 the engine gives White 55% to win; the best move keeps 58%.');
  assert.equal(tryViewOf(tryKey(bank.id, 0, 'e4d5'), FRENCH, 'e4d5', answerMovesFrom(bank, FRENCH, 0), liked)!.collapsed, undefined, 'open: the error is counted');
  for (const c of [check({ tryUci: 'e4d5', trySan: 'exd5', replyLine: ['e6d5'], tryWin: 40, bestWin: 58 }), check({ tryUci: 'e4d5', trySan: 'exd5', replyLine: ['e6d5'], tryWin: 55, bestWin: 58, depth: 9 })]) {
    assert.equal(gradeCardTry(bank, FRENCH, 'e4d5', 0, c).grade.message, 'That is not the move this card is after.');
  }
  // Wiring: counted with the try, before the background check; the grade swaps the message only when it differs.
  const other = body('tryOther');
  assert.match(other, /if \(kind === 'bank'\) \{\s*countError\(uci\);\s*setWrong\(\{ fen: fenBefore, uci, index: at \}\);\s*setFeedback\(gradeCardTry\(item, fenBefore, uci, at, null\)\.grade\.message\);/);
  assert.match(other, /startTryCheck\(item, fenBefore, uci, at, false\);/, 'in the background: the board stays open');
  assert.match(body('settleTry'), /if \(teachKind\(item\) === 'bank'\) \{\s*if \(g\.grade\.message !== gradeCardTry\(item, fenBefore, uci, at, null\)\.grade\.message\) setFeedback\(g\.grade\.message\);\s*return;\s*\}/);
  assert.equal(waitsForEngine(bank), false);
});

// ---------------------------------------------------------------- endgame drills: the tablebase, never the engine

test('drills: the goal kept is a soft retry; the goal lost is an error; words only; the mate counted from the board shown', () => {
  // Goal lost: KPK, take the opposition, 1.e4? only draws (the tablebase line and its note open at once).
  const kpk = drill('tech-kpk-take-the-opposition');
  const e4 = gradeCardTry(kpk, kpk.fen, 'e3e4', 0, null);
  assert.deepEqual([e4.grade.action, e4.grade.cls, e4.grade.message, e4.source], ['error', 'goal-lost', 'This only draws.', 'tablebase']);
  assert.equal(e4.text!.title, "Why e4 doesn't work");
  // 9.10 (g, FX2): the verdict shows once, in the message line; the viewer's intro is the listed note alone.
  assert.match(e4.text!.intro!, /^(?!This only draws)\S/, 'the note alone in the viewer');
  assert.equal(tryViewOf(tryKey(kpk.id, 0, 'e3e4'), kpk.fen, 'e3e4', answerMovesFrom(kpk, kpk.fen, 0), e4)!.collapsed, undefined);
  // Goal kept: Lucena, 1.Kc7 also wins (not listed: no line, so the slot adds nothing to the message line).
  const lucena = drill('tech-lucena-rook-to-the-fourth');
  const kc7 = gradeCardTry(lucena, lucena.fen, 'b8c7', 0, null);
  assert.deepEqual([kc7.grade.action, kc7.grade.cls, kc7.grade.tryVerdict], ['soft', 'goal-kept', 'also-good']);
  assert.equal(kc7.grade.message, 'That also wins, but this drill practises a different move. Try again.');
  assert.deepEqual(kc7.text, { line: [], title: 'What could follow Kc7' });
  assert.equal(renderToStaticMarkup(<TrySlot view={tryViewOf(tryKey(lucena.id, 0, 'b8c7'), lucena.fen, 'b8c7', [], kc7)} solving/>), '');
  // A slower mate in a mate-in-N drill: soft, with the listed line one press away.
  const krk = drill('tech-krk-mate-in-two-king-step');
  const ra8 = gradeCardTry(krk, krk.fen, 'a7a8', 0, null);
  assert.deepEqual([ra8.grade.action, ra8.grade.message], ['soft', 'That also mates, but not in two. Try again.']);
  const ra8View = tryViewOf(tryKey(krk.id, 0, 'a7a8'), krk.fen, 'a7a8', answerMovesFrom(krk, krk.fen, 0), ra8)!;
  assert.equal(renderToStaticMarkup(<TrySlot view={ra8View} solving/>), '<div class="try-check"><button type="button" class="secondary line-viewer-toggle" aria-expanded="false">See the tablebase line</button></div>');
  // The mate is counted from the board shown: at step 2 of a mate in two, one move is left.
  assert.deepEqual([drillGoalAt(krk, 0), drillGoalAt(krk, 2)], [{ result: 'win', mateIn: 2 }, { result: 'win', mateIn: 1 }]);
  const kqk = drill('tech-kqk-mate-in-two-king-step');
  const step2 = drillTeach(kqk.id)!.steps.find(s => s.step === 2)!;
  assert.equal(gradeCardTry(kqk, step2.fen, 'e7f7', 2, null).grade.message, 'That also mates, but not in one. Try again.', 'Qf7+ Kh8 Qg7# is two moves from this board');
  // The coach hears the same class. coachInput.ts still grades with the drill's own N; the count from the board changes
  // only the words ("not in one"), never the action or the class (all 177 drill tries at every step agree).
  const coachStep2 = explainInput(kqk, { fen: step2.fen, uci: 'e7f7', index: 2 }, kqk.source)!;
  assert.equal(coachStep2.tryVerdict, gradeCardTry(kqk, step2.fen, 'e7f7', 2, null).grade.tryVerdict, 'the explain input carries the page\'s class at step 2');
  assert.deepEqual(drillGoalAt(kpk, 4), { result: 'win' });
  assert.deepEqual(drillGoalAt(drill('tech-rook-v-pawn-king-first'), 0), drillGoalAt(drill('tech-rook-v-pawn-king-first'), 2));
  for (const g of [e4, kc7, ra8]) assert.doesNotMatch(`${g.grade.message} ${g.text?.intro ?? ''}`, /%/, 'words, never a percentage');
  // Wiring: drills are graded at once and never start a check (no engine).
  assert.equal(waitsForEngine(kpk), false);
  // FX2c (9.11.3 R2-1): a running check is stopped through `stopCheck` (it was `tryGate.stop()`).
  assert.match(body('tryOther'), /if \(kind === 'endgame'\) \{ stopCheck\(\); settleTry\(key, fenBefore, uci, at, gradeCardTry\(item, fenBefore, uci, at, null\)\); return; \}/);
});

// ---------------------------------------------------------------- the Trainer's wiring (read from the source)

test('own-game wiring: "Checking …" at once, the board and the hint button wait, then a soft retry or an error (9.11.2 p: no accept)', () => {
  for (const item of [punishCard(), mistakeCard(), { ...mistakeCard(), source: 'personal' as const }, { ...frenchBank(), source: 'agent' as const }]) assert.equal(waitsForEngine(item), true, item.id);
  const other = body('tryOther');
  assert.match(other, /setWrong\(null\);[^]*setFeedback\(`Checking \$\{sanAt\(fenBefore, uci\)\}…`\);\s*startTryCheck\(item, fenBefore, uci, at, true\);/, 'nothing counts before the grade');
  assert.match(other, /const known = tryView\?\.status === 'done' && tryView\.key === key && tryView\.source === 'engine' \? tryView\.check \?\? null : null;/, 'the same try again reuses its finished check');
  assert.match(body('startTryCheck'), /\.\.\.\(blocking \? \{ blocking: true \} : \{\}\)/);
  assert.match(src, /const locked = !!active && tryView\?\.status === 'checking' && !!tryView\.blocking;/);
  assert.match(src, /disabled=\{complete \|\| locked\}/, 'the board waits');
  // FX2c (9.11.3 R6-2): "Checking …" still disables the hint button; the 2 s guard now uses aria-disabled (it read
  // `disabled={hintBtn.disabled || locked}`).
  assert.match(src, /disabled=\{locked\} aria-disabled=\{hintBtn\.disabled \|\| undefined\}/, 'a hint during the check would change the attempt the grade records');
  assert.match(body('showHint'), /if \(!active \|\| complete \|\| locked\) return;/);
  assert.match(body('play'), /if \(!active \|\| complete \|\| locked\) return;/);
  // Fix round 2 (9.11.2 p): the accept branch is gone. No grade plays the try or ends the card here; soft counts
  // nothing, an error counts one. (This test pinned the accept branch before.)
  const settle = body('settleTry');
  assert.doesNotMatch(settle, /'accept'/);
  assert.doesNotMatch(settle, /setFen|setIndex|setLastMove|finish\(/, 'the board and the card stay as they are');
  assert.match(settle, /setWrong\(\{ fen: fenBefore, uci, index: at \}\);\s*if \(g\.grade\.action === 'error'\) countError\(uci\);\s*setFeedback\(g\.grade\.message\);/);
  assert.equal([...src.matchAll(/(?<!function )countError\(/g)].length, 2, 'counted in two places: a bank try at once, an error grade (drills and own-game kinds)');
  assert.match(body('countError'), /setErrors\(n => n \+ 1\);\s*if \(!firstWrong\.current && UCI_MOVE\.test\(uci\)\) firstWrong\.current = uci;/);
  // The slot stays quiet while the board waits (the message line says it), and shows "Checking …" for a bank check.
  const waiting: TryView = { key: 'k', status: 'checking', trySan: 'h6', fenBefore: PUNISH_FEN, line: [], title: '', answers: answerMovesFrom(punishCard(), PUNISH_FEN, 0), blocking: true };
  assert.equal(renderToStaticMarkup(<TrySlot view={waiting} solving/>), '');
  assert.equal(renderToStaticMarkup(<TrySlot view={{ ...waiting, blocking: undefined }} solving/>), '<p class="try-check small" role="status">Checking h6…</p>');
});

test('warm-up: the first own-game card shown starts the engine once (depth 1); never at page load, never without a Worker', () => {
  assert.equal(typeof Worker, 'undefined');
  assert.doesNotThrow(() => warmEngine(PUNISH_FEN), 'no engine in node: nothing happens');
  assert.match(body('warmEngine'), /const engine = getSharedEngine\(\);\s*if \(engine\) void searchOnce\(engine, fen, \{ depth: 1 \}\)\.catch\(\(\) => undefined\);/);
  assert.match(body('startPuzzle'), /if \(!warmed\.current && waitsForEngine\(p\)\) \{ warmed\.current = true; warmEngine\(p\.fen\); \}/);
  assert.equal([...src.matchAll(/(?<!function )warmEngine\(/g)].length, 1, 'one call site');
});

// ---------------------------------------------------------------- the bank level (8.18)

test('bank level: selection aims Lichess puzzles at the level folded from his first tries; other cards keep the starting level', () => {
  // Invented bank: four clean first tries around 1000 move the level from 1000 to 1100.
  const ratings = new Map([['b1', 1000], ['b2', 1020], ['b3', 1060], ['b4', 1080]]);
  const attempts = ['b1', 'b2', 'b3', 'b4'].map((id, i) => ({ puzzleId: id, at: 100 + i, unassisted: true }));
  const level = bankLevel(attempts, id => ratings.get(id), 1000, new Set());
  assert.deepEqual(level, { level: 1100, counted: 4, held: 0 });
  const FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
  const pool: TrainerItem[] = [
    ...[1000, 1100, 1250].map(r => ({ id: `bank-${r}`, fen: FEN, moves: ['a1a8'], rating: r, themes: ['mateIn1'], gameUrl: '', source: 'bank' as const })),
    { id: 'pack-1100', fen: FEN, moves: ['a1a8'], rating: 1100, themes: ['mateIn1'], gameUrl: '', source: 'pack' },
  ];
  const progress: SchedulerProgress = { attempts: [], cards: {}, skills: {}, settings: { rating: 1000, sessionLength: 10 } };
  const targetOf = (p: TrainerItem) => (p.source === 'bank' ? level.level : undefined);
  const banks = pool.filter(p => p.source === 'bank');
  assert.equal(selectPuzzle(banks, progress, { targetOf })?.id, 'bank-1100', 'nearest the level');
  assert.equal(selectPuzzle(banks, progress)?.id, 'bank-1000', 'without it: nearest the starting level');
  assert.equal(selectPuzzle(pool.filter(p => p.source !== 'bank'), progress, { targetOf })?.id, 'pack-1100');
  // Wiring: the fold over the stored attempts (open "wrong" flags skipped), the level read by choose() through
  // latest.current, targetOf at both selectPuzzle call sites, and the Settings words.
  assert.match(src, /const level = useMemo\(\(\) => bankLevel\(view\.attempts, id => bankRating\.get\(id\), view\.settings\.rating, view\.flaggedWrong\), \[bankRating, view\.attempts, view\.settings\.rating, view\.flaggedWrong\]\);/);
  assert.match(src, /latest\.current = \{[^}]*bankTarget: level\.level \};/);
  const choose = body('choose');
  assert.match(choose, /const targetOf = \(p: TrainerItem\) => \(p\.source === 'bank' \? bankTarget : undefined\);/);
  assert.match(choose, /select: \(pool, p, o\) => selectPuzzle\(pool, p as unknown as SchedulerProgress, \{ \.\.\.o, targetOf \}\)/);
  assert.match(choose, /selectPuzzle\(pool, toSchedulerProgress\(withThemePriors\(prog, priors\)\), \{ theme: filter, now, excludeIds: [^}]*, targetOf \}\)/);
  assert.equal((choose.match(/selectPuzzle\(/g) ?? []).length, 2);
  assert.match(src, /<label htmlFor="difficulty">Starting level<\/label>/);
  assert.match(src, /\{`Bank puzzles now: about \$\{level\.level\}\.`\}/);
  assert.doesNotMatch(src, /Starting puzzle difficulty/);
});

// ---------------------------------------------------------------- the layout (8.6, A5)

const PART_NAMES = ['board', 'feedback', 'controls', 'ladder', 'advance', 'head', 'coach', 'solved', 'viewers', 'trySlot', 'foot'] as const;
/** Each part as a marker element, so the rendered markup shows where it went. */
const markers = Object.fromEntries(PART_NAMES.map(n => [n, <i data-part={n}/>])) as unknown as PracticeParts;
const placed = (html: string, column: 'board-column' | 'coach-panel') => {
  const open = html.indexOf(`class="${column}"`);
  const close = column === 'board-column' ? html.indexOf('class="coach-panel"') : html.length;
  return [...html.slice(open, close).matchAll(/data-part="([a-zA-Z]+)"/g)].map(m => m[1]);
};

test('layout: every part is rendered exactly once; phone puts the controls, the message and the hints under the board; mid the viewers', () => {
  const expect: Record<PracticeLayout, { board: string[]; panel: string[] }> = {
    // 9.10 (i, FX2): off the phone the hint and reveal buttons follow the message, before the hints shown.
    wide: { board: ['board', 'advance'], panel: ['head', 'feedback', 'controls', 'ladder', 'coach', 'solved', 'viewers', 'trySlot', 'foot'] },
    mid: { board: ['board', 'advance', 'viewers', 'trySlot'], panel: ['head', 'feedback', 'controls', 'ladder', 'coach', 'solved', 'foot'] },
    phone: { board: ['board', 'controls', 'feedback', 'ladder', 'advance'], panel: ['head', 'coach', 'solved', 'viewers', 'trySlot', 'foot'] },
  };
  for (const layout of ['wide', 'mid', 'phone'] as const) {
    const html = renderToStaticMarkup(<PracticeColumns layout={layout} parts={markers}/>);
    assert.match(html, /^<div class="practice-layout"><div class="board-column">/);
    for (const n of PART_NAMES) assert.equal((html.match(new RegExp(`data-part="${n}"`, 'g')) ?? []).length, 1, `${layout}: ${n} once`);
    assert.deepEqual(placed(html, 'board-column'), expect[layout].board, `${layout}: under the board, in this order`);
    assert.deepEqual(placed(html, 'coach-panel'), expect[layout].panel, `${layout}: in the coach panel, in this order`);
  }
  // The board column comes before the coach panel at every width (one column on a phone: board first).
  assert.ok(renderToStaticMarkup(<PracticeColumns layout="phone" parts={markers}/>).indexOf('board-column') < renderToStaticMarkup(<PracticeColumns layout="phone" parts={markers}/>).indexOf('coach-panel'));
  // The Ask Claude panel keeps its place in every layout (a moved panel would remount and cancel its request).
  const coachIndex = (layout: PracticeLayout) => placed(renderToStaticMarkup(<PracticeColumns layout={layout} parts={markers}/>), 'coach-panel').indexOf('coach');
  assert.ok(coachIndex('wide') >= 0 && coachIndex('mid') >= 0 && coachIndex('phone') >= 0);
  // The page renders it with the hook's layout and named parts; nothing else of the panel is left inline.
  assert.match(src, /const layout = usePracticeLayout\(\);/);
  assert.match(src, /: active && !dailyDone \? <PracticeColumns layout=\{layout\} parts=\{\{/);
  assert.equal((src.match(/className="coach-panel"/g) ?? []).length, 1);
  assert.equal((src.match(/className="board-column"/g) ?? []).length, 1);
});

test('layout: the breakpoints are the stylesheet\'s; without a window the wide layout (tests and server rendering)', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(layoutNow(), 'wide');
  assert.deepEqual(LAYOUT_QUERIES, { phone: '(max-width: 650px)', mid: '(min-width: 651px) and (max-width: 1000px)' });
  const css = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8');
  assert.match(css, /@media\(max-width:650px\)\{[^]*\.practice-layout\{grid-template-columns:1fr;gap:0\}/, 'one column up to 650 px');
  // A matchMedia stand-in: each width gives the layout the stylesheet shows there.
  const at = (width: number) => {
    const g = globalThis as { window?: unknown };
    const parse = (q: string) => (w: number) => [...q.matchAll(/\((min|max)-width: (\d+)px\)/g)].every(m => (m[1] === 'min' ? w >= Number(m[2]) : w <= Number(m[2])));
    g.window = { matchMedia: (q: string) => ({ matches: parse(q)(width) }) };
    try { return layoutNow(); } finally { delete g.window; }
  };
  assert.deepEqual([360, 390, 650, 651, 820, 1000, 1001, 1280].map(at), ['phone', 'phone', 'phone', 'mid', 'mid', 'mid', 'wide', 'wide']);
});

test('"How to look": on phones the three-step checklist is one press away; at other widths it stays open, as in v6', () => {
  const html = renderToStaticMarkup(<HowToLook/>);
  assert.match(html, /^<details class="how-to-look"><summary>How to look<\/summary><div class="thinking-steps">/);
  assert.doesNotMatch(html, /<details[^>]* open/, 'collapsed');
  for (const step of ['Look for checks, captures, and threats.', 'Test your candidate against their best reply.', 'Check what you leave unprotected.']) assert.ok(html.includes(step), step);
  // Wider screens keep version 6's open checklist, byte for byte (8.6 names the phone layout only).
  assert.equal(renderToStaticMarkup(<HowToLook collapsed={false}/>),
    '<div class="thinking-steps"><p><span>1</span>Look for checks, captures, and threats.</p><p><span>2</span>Test your candidate against their best reply.</p><p><span>3</span>Check what you leave unprotected.</p></div>');
  assert.equal((src.match(/className="thinking-steps"/g) ?? []).length, 1, 'only inside HowToLook');
  assert.match(src, /<p className="lead">[^\n]*<\/p>\n\s*<HowToLook collapsed=\{layout === 'phone'\}\/>/, 'right after the lead; a toggle on phones only');
});

test('stylesheet: the stage (c) block appends layout rules only: no colour, no token, no comma selector; touch targets 44 px', () => {
  const css = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8');
  const part = css.slice(css.indexOf('/* ---- Part 8: M3 trainer, stage (c)'));
  assert.ok(part.length > 100, 'Part 8 found at the end');
  const rules = [...part.replace(/\/\*[^]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.ok(rules.length >= 9);
  for (const [, sel, decl] of rules) {
    assert.doesNotMatch(sel, /,/, `no comma selector: ${sel.trim()}`);
    assert.doesNotMatch(decl, /#[0-9a-fA-F]{3,8}\b|rgba?\(|var\(|\bwhite\b|\bblack\b/, `no colour or token: ${sel.trim()}`);
    assert.doesNotMatch(sel.trim(), /\.text-button$/, 'no rule on a text-button (the toolbar cascade test owns those)');
  }
  assert.match(part, /\.board-help \.secondary\{min-height:44px\}/);
  assert.match(part, /\.how-to-look>summary\{min-height:44px;padding:12px 0\}/);
});
