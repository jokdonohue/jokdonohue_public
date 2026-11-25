/**
 * M3 fix round 2, stage 1, writer FX2b (brief 9.11.2), the Trainer side:
 * - (p) no live engine check books another move as correct on his games, punish cards or Claude's drills: a near try is a
 *   soft retry without numbers, the page has no accept branch, a short engine scan gets the agent words, and the coach
 *   input carries FX4a's note;
 * - (q) leaving a card while "Checking …" books the try as a miss (version 6), on every leave path;
 * - (r) 3 and 4: every viewer gets the page's figure for its line as listed, and never "No material changes hands.";
 *   (r) 5: the answer viewer on a card from his games opens with the stored numbers, once;
 * - (s) "Answers to your notes" shows its heading and count only while the card on the board is unsolved;
 * - (t) the answer is found in a try line by move identity, and while he solves the try viewer leaves out every sentence
 *   that describes it (`omit`).
 *
 * As in m3_trainer_a, b, c and m3_fix1_trainer: the page has no DOM test renderer (a static render of the Trainer stops at
 * "Loading"), so the Trainer is covered through its exported pieces, and the wiring is pinned by reading Trainer.tsx. The
 * click paths themselves are run in a real browser (logs/m3_FX2b.md).
 *
 * Positions are textbook or invented, each checked with chess.js; engine results are invented TryCheck values. No owner
 * game data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chess } from 'chess.js';
import {
  answerMovesFrom, AnswersArea, answerViewerVerdict, attemptFor, cutBeforeAnswer, gradeCardTry, pendingMissOf, SolvedViewers, solvingTryLine,
  storedNumbersIntro, TrySlot, tryKey, tryViewerOptions, tryViewOf, type TryView,
} from '../components/Trainer';
import { lineNarration } from '../components/LineViewer';
import { AnswersPanel, type AnsweredNote } from '../components/HomePanels';
import type { TrainerItem } from '../components/pools';
import { createTrainerModel } from '../components/model';
import { explainInput } from '../components/coachInput';
import { readDoc, sessionAttemptSchema, type FeedbackDoc, type SessionDoc } from '../src/contract/docs';
import { createFakeStore, createMemoryKv } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { NO_CHANGE_SENTENCE } from '../src/teach/narrate';
import type { TryCheck } from '../src/teach/tryMove';
import { endgameDrills } from '../lib/endgames';
import { ARTIFACT_DIR } from './b3_paths';

const src = readFileSync(join(ARTIFACT_DIR, 'components/Trainer.tsx'), 'utf8');
const css = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const tick = (ms: number) => new Promise(r => setTimeout(r, ms));
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
/** SAN of each move of `line` from `fen` (throws on an illegal move). */
const sans = (fen: string, line: readonly string[]) => { const b = new Chess(fen); return line.map(u => b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); };
const check = (o: Partial<TryCheck> & Pick<TryCheck, 'tryUci' | 'trySan' | 'replyLine' | 'tryWin'>): TryCheck =>
  ({ bestWin: null, verdict: 'worse', depth: 12, ms: 5, ...o });
/** The viewer's caption at each step and its summary, as the try viewer reads the line while he solves (or after). */
const told = (view: Pick<TryView, 'fenBefore' | 'answers' | 'verdict'>, line: readonly string[], solving: boolean) => {
  const n = lineNarration(view.fenBefore, line, undefined, tryViewerOptions(view, solving));
  return { captions: n.plies.map(p => p.text), summary: n.summary };
};

// ---------------------------------------------------------------- fixtures (invented or textbook)

/** His game (White): Re7 leaves the back rank; Black (the solver) plays Rd1+ Re1 Rxe1#. Better was h3. */
const BEFORE = '3r2k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';
const PUNISH_FEN = after(BEFORE, 'e1e7').fen;
const punishCard = (): TrainerItem => ({
  id: 'punish-t1', fen: PUNISH_FEN, moves: ['d8d1'], rating: 1000, themes: ['personal', 'opening'], gameUrl: '', source: 'pack', kind: 'punish',
  pack: { playedSan: 'Re7', playedUci: 'e1e7', sourceFen: BEFORE, pvUci: ['d8d1', 'e7e1', 'd1e1'], rowId: 't1', winAfter: 2, solverColor: 'b' },
});
const siblingCard = (): TrainerItem => ({
  id: 'pack-t1', fen: BEFORE, moves: ['h2h3'], rating: 1000, themes: ['personal'], gameUrl: '', source: 'pack', kind: 'mistake',
  pack: { playedSan: 'Re7', playedUci: 'e1e7', pvUci: ['h2h3', 'd8d1', 'e1d1'], winBefore: 70, winAfter: 2 },
});
/** Black's try 1...h6 against the card's 1...Rd1+, with a reply line 2.Kf1 Rd1+ 3.Re1. */
const TRY = { uci: 'h7h6', san: 'h6', reply: ['g1f1', 'd8d1', 'e7e1'] };
const tryCheck = (tryWin: number, bestWin: number, depth = 12) => check({ tryUci: TRY.uci, trySan: TRY.san, replyLine: TRY.reply, tryWin, bestWin, depth });
/** A mistake card from his games (White to move): Qxd8# wins; his game move Qd7 lets the rook take the queen. */
const MISTAKE_FEN = '3r2k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1';
const mistakeCard = (o: Record<string, unknown> = {}): TrainerItem => ({
  id: 'pack-m1', fen: MISTAKE_FEN, moves: ['d1d8'], rating: 1000, themes: ['personal'], gameUrl: '', source: 'pack', kind: 'mistake',
  pack: { playedSan: 'Qd7', playedUci: 'd1d7', pvUci: ['d1d8'], refutationPvUci: ['d8d7', 'h2h3'], winBefore: 99.6, winAfter: 0.4, ...o },
});
/** A position from his games that a short engine scan supplied (source 'personal'): Nd5 Nxd5 Rxd5. */
const TRADE_FEN = '4k3/8/5n2/8/8/2N5/8/3RK3 w - - 0 1';
const scanCard = (): TrainerItem => ({ id: 'personal-scan1', fen: TRADE_FEN, moves: ['c3d5', 'f6d5', 'd1d5'], rating: 1000, themes: ['personal', 'middlegame'], gameUrl: '', source: 'personal' });
const agentCard = (): TrainerItem => ({ id: 'agent-1', fen: MISTAKE_FEN, moves: ['d1d8'], rating: 900, themes: ['mateIn1'], gameUrl: '', source: 'agent', title: 'Back rank' });
/** The French after 1.e4 e6 2.d4 d5, as a Lichess puzzle: 3.Nc3 Nf6 4.Bg5. */
const FRENCH = 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6 0 3';
const frenchBank = (themes = ['opening', 'advantage']): TrainerItem => ({ id: 'bank-french', fen: FRENCH, moves: ['b1c3', 'g8f6', 'c1g5'], rating: 1400, themes, gameUrl: '', source: 'bank' });
const drill = (id: string): TrainerItem => {
  const d = endgameDrills.find(x => x.id === id);
  assert.ok(d, id);
  return { id: d!.id, fen: d!.fen, moves: [...d!.moves], rating: d!.rating, themes: [...d!.themes], gameUrl: '', source: 'endgame' };
};
/** R4-2's two invented positions (White to move): the answer Ne5 (knight f3-e5), and the answer Nxg5 (knight f3-g5). */
const R42_A = '6k1/8/4p3/8/8/5N2/7P/6K1 w - - 0 1';
const R42_B = '6k1/3p4/8/6b1/8/5N2/7P/6K1 w - - 0 1';
/** Invented: White's back rank with luft for Black (h6). The card's move is Rd8+ (the rook d1-d8). */
const LUFT = 'r5k1/5pp1/7p/8/8/8/5PPP/3R2K1 w - - 0 1';
/** Invented: White's bishop b2 can take the rook on h8 (no check). */
const BISHOP = '7r/8/8/8/8/8/1B6/K6k w - - 0 1';
/** Invented: a pawn on e7 that promotes; two white knights that can both reach g3. */
const PROMO = '7k/4P3/8/8/8/8/6PP/6K1 w - - 0 1';
const KNIGHTS = '6k1/8/8/8/8/8/4N1PP/5NK1 w - - 0 1';

test('fixtures are legal', () => {
  assert.deepEqual(sans(PUNISH_FEN, ['d8d1', 'e7e1', 'd1e1']), ['Rd1+', 'Re1', 'Rxe1#']);
  assert.deepEqual(sans(PUNISH_FEN, [TRY.uci, ...TRY.reply]), ['h6', 'Kf1', 'Rd1+', 'Re1']);
  assert.deepEqual(sans(MISTAKE_FEN, ['d1d8']), ['Qxd8#']);
  assert.deepEqual(sans(MISTAKE_FEN, ['d1d7', 'd8d7', 'h2h3']), ['Qd7', 'Rxd7', 'h3']);
  assert.deepEqual(sans(TRADE_FEN, ['c3d5', 'f6d5', 'd1d5']), ['Nd5', 'Nxd5', 'Rxd5']);
  assert.deepEqual(sans(FRENCH, ['b1c3', 'g8f6', 'c1g5']), ['Nc3', 'Nf6', 'Bg5']);
  assert.deepEqual(sans(R42_A, ['f3e5']), ['Ne5']);
  assert.deepEqual(sans(R42_A, ['h2h3', 'e6e5', 'f3e5']), ['h3', 'e5', 'Nxe5']);
  assert.deepEqual(sans(R42_B, ['f3g5']), ['Nxg5']);
  assert.deepEqual(sans(R42_B, ['g1f1', 'd7d6']), ['Kf1', 'd6']);
  assert.deepEqual(sans(LUFT, ['d1d8']), ['Rd8+']);
  assert.deepEqual(sans(LUFT, ['h2h3', 'a8d8', 'd1d8', 'g8h7']), ['h3', 'Rd8', 'Rxd8+', 'Kh7']);
  assert.deepEqual(sans(BISHOP, ['b2h8', 'h1g2']), ['Bxh8', 'Kg2']);
  assert.deepEqual(sans(PROMO, ['e7e8q']), ['e8=Q+']);
  assert.deepEqual(sans(PROMO, ['h2h3', 'h8g7', 'e7e8n']), ['h3', 'Kg7', 'e8=N+']);
  assert.deepEqual(sans(KNIGHTS, ['e2g3']), ['Neg3']);
});

// ---------------------------------------------------------------- (p) never booked

test('(p) a near try on his games, punish cards and Claude\'s drills is a soft retry: never booked, no numbers, titled "What could follow"', () => {
  const card = punishCard();
  for (const [tryWin, bestWin, depth] of [[96.4, 99.6, 12], [30, 35, 12], [67, 63, 12], [100, 100, 0], [64.6, 69.6, 10]] as const) {
    const g = gradeCardTry(card, card.fen, TRY.uci, 0, tryCheck(tryWin, bestWin, depth));
    const where = `${tryWin}/${bestWin} at depth ${depth}`;
    assert.deepEqual([g.grade.action, g.grade.tryVerdict, g.grade.showNumbers], ['soft', 'strong', false], where);
    assert.equal(g.grade.message, 'The quick engine check likes h6 too, but the analysis that picked this card found one clearly better move. Try again.', where);
    assert.deepEqual(g.text, { line: [TRY.uci, ...TRY.reply], title: 'What could follow h6' }, `${where}: no intro`);
    assert.deepEqual([g.verdict, g.numbers], [undefined, undefined], `${where}: no figure`);
    const view = tryViewOf(tryKey(card.id, 0, TRY.uci), card.fen, TRY.uci, answerMovesFrom(card, card.fen, 0), g)!;
    assert.equal(view.collapsed, true, 'one press away');
    assert.equal(tryViewerOptions(view, true).verdict, null, 'the viewer gets no figure');
  }
  // A mistake card from his games and Claude's drills: the same rule, with their words.
  const mistake = mistakeCard();
  const qd6 = check({ tryUci: 'd1d6', trySan: 'Qd6', replyLine: ['d8d6'], tryWin: 98, bestWin: 100 });
  assert.equal(gradeCardTry(mistake, mistake.fen, 'd1d6', 0, qd6).grade.message, 'The quick engine check likes Qd6 too, but the analysis that picked this card found one clearly better move. Try again.');
  const agent = agentCard();
  const ga = gradeCardTry(agent, agent.fen, 'd1d6', 0, qd6);
  assert.deepEqual([ga.grade.action, ga.grade.message], ['soft', 'The engine likes Qd6 too, but this card is after a different move. Try again.']);
  // A short engine scan was not picked by that analysis: the page passes `engineScan`, so it gets the agent words.
  const scan = scanCard();
  const rd2 = check({ tryUci: 'd1d2', trySan: 'Rd2', replyLine: ['e8e7'], tryWin: 60, bestWin: 62 });
  assert.deepEqual([gradeCardTry(scan, scan.fen, 'd1d2', 0, rd2).grade.action, gradeCardTry(scan, scan.fen, 'd1d2', 0, rd2).grade.message],
    ['soft', 'The engine likes Rd2 too, but this card is after a different move. Try again.']);
  assert.match(body('gradeCardTry'), /gradeTry\(\{ kind, trySan, answerSan, solver, tryUci, check: usable, \.\.\.\(isEngineScanCard\(item\) \? \{ engineScan: true \} : \{\}\) \}\)/);
  // A Lichess puzzle is unchanged: the error counts at once, the numbers show, and the try's figure goes to its viewer.
  const bank = frenchBank();
  const liked = gradeCardTry(bank, FRENCH, 'e4d5', 0, check({ tryUci: 'e4d5', trySan: 'exd5', replyLine: ['e6d5', 'b1c3'], tryWin: 55, bestWin: 58 }));
  assert.deepEqual([liked.grade.action, liked.grade.showNumbers, liked.text!.intro], ['error', true, 'After exd5 the engine gives White 55% to win; the best move keeps 58%.']);
  assert.deepEqual([liked.verdict, liked.numbers], [{ side: 'w', win: 55 }, { tryWin: 55, bestWin: 58 }]);
});

test('(p) the page has no accept branch: a grade never plays the try or ends the card; the coach input carries FX4a\'s note', () => {
  const settle = body('settleTry');
  assert.doesNotMatch(settle, /accept'/, 'no accept branch');
  assert.doesNotMatch(settle, /setFen|setIndex|setLastMove|finish\(/);
  assert.match(settle, /setWrong\(\{ fen: fenBefore, uci, index: at \}\);\s*if \(g\.grade\.action === 'error'\) countError\(uci\);\s*setFeedback\(g\.grade\.message\);/);
  assert.doesNotMatch(body('gradeCardTry'), /'accept'/, 'no accept intro either');
  // Another mate is still accepted before any grading (9.1); that is the only way a try other than the card's ends it.
  assert.match(body('play'), /const alternateMate = board\.isCheckmate\(\);\s*if \(uci !== active\.moves\[index\] && !alternateMate\) \{/);
  // The explain input the page builds for a soft near try (the view's own check, same card, step and try).
  const card = punishCard();
  const g = gradeCardTry(card, card.fen, TRY.uci, 0, tryCheck(96.4, 99.6));
  const view = tryViewOf(tryKey(card.id, 0, TRY.uci), card.fen, TRY.uci, answerMovesFrom(card, card.fen, 0), g)!;
  const input = explainInput(card, { fen: card.fen, uci: TRY.uci, index: 0 }, card.source, { check: view.check })!;
  assert.deepEqual([input.tryVerdict, input.tryWin, input.bestWin], ['strong', undefined, undefined]);
  assert.equal(input.tryCheckNote, "A quick engine check in this page rated h6 close to the card's move, but the analysis that picked this card found one clearly better move.");
  assert.match(src, /tryView\?\.status === 'done' && tryView\.source === 'engine' && tryView\.key === tryKey\(active\.id, wrong\.index, wrong\.uci\) \? tryView\.check \?\? null : null;/, 'the finished check of this very try');
});

// ---------------------------------------------------------------- (q) leaving during "Checking …"

test('(q) leaving while the board waits for a check books the try as a miss, as version 6 did; a finished grade books nothing', async () => {
  const card = punishCard();
  const checking: TryView = { key: tryKey(card.id, 0, TRY.uci), status: 'checking', trySan: 'h6', fenBefore: card.fen, line: [], title: '', answers: answerMovesFrom(card, card.fen, 0), blocking: true };
  assert.equal(pendingMissOf(checking), 'h7h6');
  assert.equal(pendingMissOf({ ...checking, blocking: undefined }), null, "a Lichess puzzle's background check: its error is already counted");
  assert.equal(pendingMissOf({ ...checking, status: 'done' }), null, 'a finished soft retry books nothing (stage c decision 5)');
  assert.equal(pendingMissOf({ ...checking, key: 'punish-t1|0|' }), null, 'never a field the schema would refuse');
  assert.equal(pendingMissOf(null), null);
  // Every leave path books it before it stops the check: Another position, the focus select, "Next position", "Keep
  // practising" and a focus chosen on another tab (practiseTheme) go through choose(); a new card through startPuzzle() or
  // startSafe(). A tab switch alone (goTab) leaves the card on the board, and its check runs on. While the check runs the
  // board, the hint button and a new try are locked (`locked`); Reveal is not, and keeps the try (below).
  for (const fn of ['choose', 'startPuzzle', 'startSafe']) {
    const b = body(fn);
    assert.ok(b.indexOf('bookPendingMiss();') > 0, `${fn} books a pending try`);
    assert.ok(b.indexOf('bookPendingMiss();') < b.indexOf('clearTry()'), `${fn}: before the check is stopped`);
    assert.ok(b.indexOf('bookPendingMiss();') < b.indexOf('if (active && !recorded.current && (errors > 0 || hints > 0)) finish(false, false);'), `${fn}: before the old leave record`);
  }
  for (const label of ['Another position', 'Keep practising', 'Next position']) assert.ok(src.includes(label), label);
  assert.match(src, /<button className="text-button" onClick=\{\(\) => choose\(\)\}><RefreshCw size=\{16\}\/>Another position<\/button>/);
  assert.match(src, /<select id="theme" [^\n]*choose\('all', 'today'\); \} else \{ setMode\('free'\); setTheme\(t\); choose\(t, 'free'\); \} \}\}>/);
  assert.match(src, /<button className="primary wide" onClick=\{\(\) => choose\(\)\}>/);
  const book = body('bookPendingMiss');
  assert.match(book, /const uci = active && !recorded\.current && tryView\?\.key\.startsWith\(tryKey\(active\.id, index, ''\)\) \? pendingMissOf\(tryView\) : null;/, 'only this card and step, only once');
  assert.match(book, /if \(!firstWrong\.current\) firstWrong\.current = uci;\s*finish\(false, false\);/, 'his first wrong move stays first; a rehearsal stays unrecorded (finish)');
  // A reveal during the check keeps the try as his first wrong move too (the record was already not correct).
  const reveal = body('reveal');
  assert.match(reveal, /const pending = active && tryView\?\.key\.startsWith\(tryKey\(active\.id, index, ''\)\) \? pendingMissOf\(tryView\) : null;\s*if \(pending && !firstWrong\.current\) firstWrong\.current = pending;\s*dropPendingTry\(\);/);
  // The record: correct false, the try as playedUci, version-6 fields only; through the real model and session writer.
  const booked = attemptFor({ item: card, revealed: false, clean: false, hints: 0, startedAt: 1_000, now: 2_500, playedUci: 'h7h6' });
  assert.deepEqual(booked, { puzzleId: 'punish-t1', themes: ['personal', 'opening'], correct: false, unassisted: false, hints: 0, revealed: false, durationMs: 1_500, at: 2_500, source: 'pack', playedUci: 'h7h6' });
  assert.deepEqual(sessionAttemptSchema.parse(booked), booked);
  const store = createFakeStore();
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'd1', events: null, debounceMs: 1 });
  const model = createTrainerModel({ store, sessions, deviceId: 'd1' });
  try {
    assert.equal(model.record(booked), true);
    await sessions.flush();
    await tick(10);
    const dump = store.dump();
    const path = Object.keys(dump).find(p => p.startsWith('sessions/'))!;
    const doc = readDoc<SessionDoc>(path, dump[path]);
    assert.ok(doc, 'a version-6 session document');
    assert.deepEqual(doc!.attempts, [booked]);
  } finally { model.dispose(); sessions.dispose(); }
});

// ---------------------------------------------------------------- (r) the figure for each viewer, the closing sentence

test('(r) 3: the try viewer\'s figure is the try\'s Win% for the solver when the page shows numbers; the stored line its stored figure; else none', () => {
  const card = punishCard();
  const worse = gradeCardTry(card, card.fen, TRY.uci, 0, tryCheck(13.7, 99.6));
  assert.deepEqual([worse.verdict, worse.numbers], [{ side: 'b', win: 13.7 }, { tryWin: 14, bestWin: 100 }]);
  const strong = gradeCardTry(card, card.fen, TRY.uci, 0, tryCheck(75.1, 99.6));
  assert.deepEqual(strong.verdict, { side: 'b', win: 75.1 });
  assert.equal(gradeCardTry(card, card.fen, TRY.uci, 0, tryCheck(50, 99.6, 9)).verdict, undefined, 'a search too shallow to trust shows no number');
  assert.equal(gradeCardTry(card, card.fen, TRY.uci, 0, null).verdict, undefined, 'no check, no stored line on a punish card');
  // L4's stored line (his game move at a mistake card's first step): the stored figure, pack.winAfter, for him.
  const mistake = mistakeCard();
  const stored = gradeCardTry(mistake, mistake.fen, 'd1d7', 0, null);
  assert.deepEqual([stored.source, stored.verdict, stored.numbers], ['stored', { side: 'w', win: 0.4 }, { tryWin: 0, bestWin: 100 }]);
  // A drill: words only, never a figure.
  const kpk = drill('tech-kpk-take-the-opposition');
  assert.equal(gradeCardTry(kpk, kpk.fen, 'e3e4', 0, null).verdict, undefined);
  // The view keeps it, and the slot passes it with `omit` while he solves and never the no-change sentence. FXR2b1 (brief
  // 9.11.8): `omit` is the whole list of moves still to find (this card has one), no longer the first move alone.
  const view = tryViewOf(tryKey(card.id, 0, TRY.uci), card.fen, TRY.uci, answerMovesFrom(card, card.fen, 0), worse)!;
  assert.deepEqual(tryViewerOptions(view, true), { verdict: { side: 'b', win: 13.7 }, omit: [{ from: 'd8', to: 'd1', piece: 'r', san: 'Rd1+' }], noChangeSentence: false });
  assert.deepEqual(tryViewerOptions(view, false), { verdict: { side: 'b', win: 13.7 }, omit: null, noChangeSentence: false }, 'complete: nothing left out');
  // FX2c (9.11.3 R6-3): the viewer also opens on the try (`initialStep={1}` before the narrator options).
  // Version 7.3: a drill's note is rendered above the viewer (`note`); the viewer's own props are as before.
  assert.match(body('TrySlot'), /const \{ verdict, omit \} = tryViewerOptions\(view, solving\);\n(?:\s*\/\/[^\n]*\n)*\s*const note = view\.source === 'tablebase' && view\.intro \? view\.intro : '';\s*return <div className="try-check">\{note && <p className="try-note small">\{note\}<\/p>\}<LineViewer key=\{view\.key\} [^\n]*\n\s*initialStep=\{1\} verdict=\{verdict\} omit=\{omit\} noChangeSentence=\{false\} \{\.\.\.closed\}\/><\/div>;/);
  // R3-3's shape, invented: the try wins a rook, the engine gives the solver 6%. The closing sentence says both.
  const rook: TryView = { key: 'k', status: 'done', trySan: 'Bxh8', fenBefore: BISHOP, line: ['b2h8', 'h1g2'], title: "Why Bxh8 doesn't work", answers: answerMovesFrom({ moves: ['a1b1'] }, BISHOP, 0), verdict: { side: 'w', win: 6 }, source: 'engine' };
  assert.equal(told(rook, rook.line, true).summary, 'White is a rook up at the end of this line, but the engine gives Black 94% to win.');
  assert.equal(lineNarration(BISHOP, rook.line).summary, 'White wins a rook.', 'without the figure it would claim the win');
});

test('(r) 3: the answer viewer\'s figure: a check at this step with numbers, else the stored figure, else a Lichess win; drills and Claude\'s drills none', () => {
  const mistake = mistakeCard();
  assert.deepEqual(answerViewerVerdict(mistake), { side: 'w', win: 99.6 }, 'his game: pack.winBefore');
  assert.deepEqual(answerViewerVerdict(punishCard()), { side: 'b', win: 98 }, 'punish: solverWinAfter, 100 - winAfter');
  assert.deepEqual(answerViewerVerdict(frenchBank()), { side: 'w', winning: true }, 'a Lichess solution wins for the solver');
  assert.equal(answerViewerVerdict(frenchBank(['equality', 'opening'])), null, 'except an equality puzzle');
  assert.equal(answerViewerVerdict(drill('tech-kpk-take-the-opposition')), null);
  assert.equal(answerViewerVerdict(agentCard()), null);
  assert.equal(answerViewerVerdict(scanCard()), null, 'a short scan has no stored figure');
  // A finished check of a try at the card's own position whose numbers the page showed: its figure for the answer.
  const card = punishCard();
  const atStart = (c: TryCheck, at = 0) => tryViewOf(tryKey(card.id, at, TRY.uci), card.fen, TRY.uci, answerMovesFrom(card, card.fen, 0), gradeCardTry(card, card.fen, TRY.uci, 0, c));
  // Version 7.1 (brief m31 4.6, E1): a card that stores a figure for its answer keeps it (it was the live 91.3 before
  // 7.1, a second figure beside the stored one); the live figure is used only where no figure is stored.
  assert.deepEqual(answerViewerVerdict(card, atStart(tryCheck(40, 91.3))), { side: 'b', win: 98 });
  const unstored: TrainerItem = { ...card, pack: { ...card.pack, winAfter: undefined } };
  const liveOnly = tryViewOf(tryKey(unstored.id, 0, TRY.uci), unstored.fen, TRY.uci, answerMovesFrom(unstored, unstored.fen, 0), gradeCardTry(unstored, unstored.fen, TRY.uci, 0, tryCheck(40, 91.3)));
  assert.deepEqual(answerViewerVerdict(unstored, liveOnly), { side: 'b', win: 91.3 }, 'no stored figure: the check at this step');
  assert.deepEqual(answerViewerVerdict(card, atStart(tryCheck(96.4, 99.6))), { side: 'b', win: 98 }, '(p): no numbers shown, so the stored figure');
  assert.deepEqual(answerViewerVerdict(card, atStart(tryCheck(40, 91.3), 2)), { side: 'b', win: 98 }, 'a check at another step is about another position');
  assert.deepEqual(answerViewerVerdict(card, { ...atStart(tryCheck(40, 91.3))!, key: tryKey('punish-other', 0, TRY.uci) }), { side: 'b', win: 98 }, 'another card');
  // SolvedViewers passes it to the answer viewer; neither viewer keeps the no-change sentence. FX2c (9.11.3, (r) 3 added
  // 08:09): the game line now gets the sibling card's stored figure for his side (`gameLineVerdict`, values in
  // tests/m3_fix2b_trainer.test.tsx); it got none before.
  const solved = body('SolvedViewers');
  assert.match(solved, /intro=\{storedNumbersIntro\(item, latest\)\} verdict=\{answerViewerVerdict\(item, latest\)\} noChangeSentence=\{false\}/);
  assert.match(solved, /title="What you could have played in the game" [^\n]*\n\s*verdict=\{gameLineVerdict\(item, sibling\)\} noChangeSentence=\{false\} defaultOpen=\{assisted\}/);
});

test('(r) 4: no viewer closes on "No material changes hands."; the narrator keeps it for lessons and coach inputs', () => {
  const quiet = '7k/8/8/8/8/8/6PP/6K1 w - - 0 1';
  const view: TryView = { key: 'k', status: 'done', trySan: 'h3', fenBefore: quiet, line: ['h2h3', 'h8g8'], title: 'What could follow h3', answers: [], source: 'engine' };
  for (const solving of [true, false]) assert.equal(told(view, view.line, solving).summary, '', `solving ${solving}`);
  assert.equal(lineNarration(quiet, view.line, undefined, { noChangeSentence: true }).summary, NO_CHANGE_SENTENCE);
  const viewers = [...src.matchAll(/<LineViewer [^>]*?\/>/gs)].map(m => m[0]);
  // Version 7.1 (brief m31 4.3 row V and 4.4): two more, the threat viewer and the viewer of his game move. It was 3.
  assert.equal(viewers.length, 5, 'the try viewer, the answer viewer, the threat viewer, the game line and the game-move viewer');
  for (const v of viewers) assert.match(v, /noChangeSentence=\{false\}/);
});

test('(r) 5: the answer viewer on a card from his games opens with the stored numbers, once', () => {
  const mistake = mistakeCard();
  const intro = 'After Qxd8# the engine gives you 100% to win; your game move Qd7 left 0%.';
  assert.equal(storedNumbersIntro(mistake), intro);
  const open = renderToStaticMarkup(<SolvedViewers item={mistake} assisted/>);
  assert.ok(open.includes(`<p class="line-viewer-caption" aria-live="polite">${esc(intro)}</p>`), 'the first caption, before any move');
  // Left out when the try viewer on the page shows figures for his game move: from the stored line, or from the engine.
  // FX2c (9.11.3, the 08:09 addition): with any numbers, not only the same rounded pair.
  const key = tryKey(mistake.id, 0, 'd1d7');
  const stored = tryViewOf(key, mistake.fen, 'd1d7', answerMovesFrom(mistake, mistake.fen, 0), gradeCardTry(mistake, mistake.fen, 'd1d7', 0, null))!;
  assert.equal(stored.intro, 'After Qd7 the engine gives White 0% to win; the best move keeps 100%.', 'the same pair in the try viewer');
  assert.equal(storedNumbersIntro(mistake, stored), undefined);
  assert.doesNotMatch(renderToStaticMarkup(<SolvedViewers item={mistake} assisted latest={stored}/>), /your game move/);
  const engineSame = tryViewOf(key, mistake.fen, 'd1d7', [], gradeCardTry(mistake, mistake.fen, 'd1d7', 0, check({ tryUci: 'd1d7', trySan: 'Qd7', replyLine: ['d8d7'], tryWin: 0.2, bestWin: 99.8 })))!;
  assert.equal(storedNumbersIntro(mistake, engineSame), undefined);
  const engineOther = tryViewOf(key, mistake.fen, 'd1d7', [], gradeCardTry(mistake, mistake.fen, 'd1d7', 0, check({ tryUci: 'd1d7', trySan: 'Qd7', replyLine: ['d8d7'], tryWin: 3, bestWin: 99.8 })))!;
  assert.equal(storedNumbersIntro(mistake, engineOther), undefined, 'another pair: one figure for his game move on the page (it was both before)');
  const otherTry = tryViewOf(tryKey(mistake.id, 0, 'd1d6'), mistake.fen, 'd1d6', [], gradeCardTry(mistake, mistake.fen, 'd1d6', 0, check({ tryUci: 'd1d6', trySan: 'Qd6', replyLine: ['d8d6'], tryWin: 0.4, bestWin: 99.6 })))!;
  assert.equal(storedNumbersIntro(mistake, otherTry), intro, 'another try is not his game move');
  // Only his own game's mistake cards with both figures and a game move other than the answer.
  for (const item of [punishCard(), scanCard(), frenchBank(), drill('tech-kpk-take-the-opposition'), agentCard(), mistakeCard({ winBefore: undefined }), mistakeCard({ playedUci: 'd1d8' })]) {
    assert.equal(storedNumbersIntro(item), undefined, item.id);
  }
  assert.doesNotMatch(renderToStaticMarkup(<SolvedViewers item={punishCard()} sibling={siblingCard()} assisted/>), /your game move/);
  assert.match(src, /viewers: complete \? <SolvedViewers item=\{active\} sibling=\{sibling\} assisted=\{assisted\} onOpen=\{cancelAdvance\} latest=\{tryView\}\/> : null,/);
});

// ---------------------------------------------------------------- (s) answers to his notes while he solves

const note = (id: string, itemId: string, at: number, reply: string | undefined): AnsweredNote =>
  ({ id, doc: { at, kind: 'comment', itemId, source: 'endgame', themes: [], fen: FRENCH, sessionId: 's', text: 'invented note', status: reply ? 'done' : 'open', ...(reply ? { reply } : {}) } as FeedbackDoc });
/** The button elements in a React element tree (function components are not entered). */
function buttons(node: ReactNode): ReactElement<{ onClick?: () => void; children?: ReactNode }>[] {
  if (!isValidElement(node)) return Array.isArray(node) ? node.flatMap(buttons) : [];
  const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  return [...(el.type === 'button' ? [el] : []), ...buttons(el.props.children)];
}

test('(s) while the card on the board is unsolved, "Answers to your notes" shows its heading and count only, until he asks', () => {
  const titleOf = () => 'Take the opposition';
  const items = [note('f1', 'tech-kpk-take-the-opposition', 2_000, 'Invented reply naming Ke4.'), note('f2', 'bank-french', 1_000, 'Invented reply naming Nc3.'), note('f3', 'x', 3_000, undefined)];
  const held = renderToStaticMarkup(<AnswersArea items={items} titleOf={titleOf} solving onShow={() => {}}/>);
  assert.equal(held, '<section class="surface plan-notes answers-panel answers-held" aria-label="Answers to your notes"><div class="notes"><h2>Answers to your notes</h2>'
    + '<p class="small">2 answers. Shown when you finish this position.</p><button type="button" class="secondary">Show them now</button></div></section>');
  assert.doesNotMatch(held, /Invented reply|Ke4|Nc3|invented note/, 'no reply, no note, no card title while he solves');
  assert.match(renderToStaticMarkup(<AnswersArea items={items.slice(0, 1)} titleOf={titleOf} solving onShow={() => {}}/>), /<p class="small">1 answer\. Shown when you finish this position\.<\/p>/);
  // The count is what the full panel lists (at most 10).
  const many = Array.from({ length: 12 }, (_, i) => note(`m${i}`, 'x', i + 1, 'Invented.'));
  assert.match(renderToStaticMarkup(<AnswersArea items={many} titleOf={titleOf} solving onShow={() => {}}/>), />10 answers\. Shown when you finish this position\.</);
  // Complete (or after "Show them now"): the panel as built, in full. No answers: nothing.
  assert.equal(renderToStaticMarkup(<AnswersArea items={items} titleOf={titleOf} solving={false} onShow={() => {}}/>), renderToStaticMarkup(<AnswersPanel items={items} titleOf={titleOf}/>));
  assert.equal(renderToStaticMarkup(<AnswersArea items={[items[2]]} titleOf={titleOf} solving onShow={() => {}}/>), '');
  // Pressing the button is his request (8.2): it calls onShow.
  let asked = 0;
  const tree = AnswersArea({ items, titleOf, solving: true, onShow: () => { asked++; } });
  const [show] = buttons(tree);
  assert.ok(show, 'the button');
  show.props.onClick!();
  assert.equal(asked, 1);
  // Wiring: right after the plan and notes (the chip "N notes from Claude" scrolls to #from-claude, directly above), held
  // back while the card on the board (a position or a "Safe or not?" question) is unsolved and he has not asked; asked
  // again on every new card. CardAnswer stays in the complete panel.
  assert.match(src, /<PlanAndNotes id="from-claude" [^\n]*\/>\n\s*<AnswersArea items=\{view\.answeredFeedback\} titleOf=\{titleOf\} solving=\{boardUnsolved && !notesAsked\} onShow=\{showNotesNow\}\/>/);
  assert.match(src, /onNotes=\{\(\) => document\.getElementById\('from-claude'\)\?\.scrollIntoView\(\{ block: 'start' \}\)\}/, 'the chip only scrolls: it shows nothing by itself');
  assert.match(src, /const boardUnsolved = !dailyDone && \(\(!!active && !complete\) \|\| \(!!safeQ && !safeAns\)\);/);
  assert.match(src, /function showNotesNow\(\) \{ notesFocus\.current = true; setNotesAsked\(true\); \}/);
  assert.match(body('startPuzzle'), /setNotesAsked\(false\);/);
  assert.match(body('startSafe'), /setNotesAsked\(false\);/);
  assert.equal((src.match(/setNotesAsked\(true\)/g) ?? []).length, 1, 'only his press opens it early');
  assert.ok(src.indexOf('<CardAnswer items={cardAnswers}/>') > src.indexOf('solved: complete ? <>'), 'CardAnswer as built');
  // Stylesheet: an append-only block with layout rules only (D12: no colour, no token, no comma selector).
  const at = css.indexOf('/* ---- Part 10: M3 fix round 2 (FX2b');
  assert.ok(at > css.indexOf('/* ---- Part 9: M3 fix pass (FX2'), 'Part 10 after Part 9');
  // FX2c appends Part 11 after it (tests/m3_fix2b_trainer.test.tsx); Part 10 itself is unchanged, read up to there.
  const next = css.indexOf('/* ---- Part 11', at);
  const rules = [...css.slice(at, next === -1 ? undefined : next).replace(/\/\*[^]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.equal(rules.length, 2);
  for (const [, sel, decl] of rules) {
    assert.doesNotMatch(sel, /,/, `no comma selector: ${sel.trim()}`);
    assert.doesNotMatch(decl, /#[0-9a-fA-F]{3,8}\b|rgba?\(|var\(|\bwhite\b|\bblack\b/, `no colour or token: ${sel.trim()}`);
  }
  assert.match(css, /\.answers-held \.secondary\{min-height:44px\}/, 'a 44 px touch target');
});

// ---------------------------------------------------------------- (t) the answer inside a try line

test('(t) 1: the answer is found by move identity: the same piece from the same square to the same square, whatever its SAN', () => {
  // The answers still to find, each with its SAN at its own step.
  assert.deepEqual(answerMovesFrom(frenchBank(), FRENCH, 0), [{ from: 'b1', to: 'c3', piece: 'n', san: 'Nc3' }, { from: 'c1', to: 'g5', piece: 'b', san: 'Bg5' }]);
  assert.deepEqual(answerMovesFrom(frenchBank(), after(after(FRENCH, 'b1c3').fen, 'g8f6').fen, 2), [{ from: 'c1', to: 'g5', piece: 'b', san: 'Bg5' }]);
  assert.deepEqual(answerMovesFrom({ moves: ['e7e8q'] }, PROMO, 0), [{ from: 'e7', to: 'e8', piece: 'p', promotion: 'q', san: 'e8=Q+' }]);
  assert.deepEqual(answerMovesFrom({ moves: ['a1a2'] }, PROMO, 0), [], 'a move that does not replay ends the list');
  // R4-2's first repro: the answer Ne5 played later as Nxe5 (fix 1 showed it, by SAN text). Cut before it.
  const a = answerMovesFrom({ moves: ['f3e5'] }, R42_A, 0);
  assert.deepEqual(cutBeforeAnswer(R42_A, ['h2h3', 'e6e5', 'f3e5'], a, tryViewerOptions({ answers: a }, true)), ['h2h3', 'e6e5']);
  // The cut reads the line as the viewer does: without `omit` the caption of ...e5 would describe Nxe5, so it would stop
  // after the try.
  assert.deepEqual(cutBeforeAnswer(R42_A, ['h2h3', 'e6e5', 'f3e5'], a), ['h2h3']);
  // Disambiguated SAN (Neg3) and a promotion to the same piece are the answer; another new piece is another move.
  assert.deepEqual(cutBeforeAnswer(KNIGHTS, ['h2h3', 'g8h8', 'e2g3'], answerMovesFrom({ moves: ['e2g3'] }, KNIGHTS, 0)), ['h2h3', 'g8h8']);
  const q = answerMovesFrom({ moves: ['e7e8q'] }, PROMO, 0);
  assert.deepEqual(cutBeforeAnswer(PROMO, ['h2h3', 'h8g7', 'e7e8q'], q), ['h2h3', 'h8g7']);
  assert.deepEqual(cutBeforeAnswer(PROMO, ['h2h3', 'h8g7', 'e7e8n'], q), ['h2h3', 'h8g7', 'e7e8n'], 'e8=N+ is not e8=Q+');
  // Another piece of his reaching the answer's square with another SAN is not the answer (the knight from f1 to g3).
  assert.deepEqual(cutBeforeAnswer(KNIGHTS, ['h2h3', 'g8h8', 'f1g3'], answerMovesFrom({ moves: ['e2g3'] }, KNIGHTS, 0)), ['h2h3', 'g8h8', 'f1g3']);
  // An opponent's move printed with the answer's SAN (Black's ...Rd8, the answer White's Rd8+) is not the answer; White's
  // Rxd8+ (the rook from d1 to d8) is.
  const luft = answerMovesFrom({ moves: ['d1d8'] }, LUFT, 0);
  assert.deepEqual(cutBeforeAnswer(LUFT, ['h2h3', 'a8d8', 'd1d8', 'g8h7'], luft, tryViewerOptions({ answers: luft }, true)), ['h2h3', 'a8d8']);
  // The 8.2 guard kept from fix 1: a later move of his side printed with an answer's own SAN, though another piece, stops
  // the line, and so does a sentence printing it (textbook KQK: the answer Qe7-g7#; the try line 1.Qf7+ Kh8 2.Qg7#).
  const KQK = '6k1/4Q3/5K2/8/8/8/8/8 w - - 0 1';
  assert.deepEqual(sans(KQK, ['e7g7']), ['Qg7#']);
  assert.deepEqual(sans(KQK, ['e7f7', 'g8h8', 'f7g7']), ['Qf7+', 'Kh8', 'Qg7#']);
  const qg7 = answerMovesFrom({ moves: ['e7g7'] }, KQK, 0);
  assert.deepEqual(cutBeforeAnswer(KQK, ['e7f7', 'g8h8', 'f7g7'], qg7, tryViewerOptions({ answers: qg7 }, true)), ['e7f7']);
  // Wiring: the views carry the answers by identity; the slot reads the cut as the viewer reads the line.
  assert.match(body('startTryCheck'), /answers: answerMovesFrom\(item, fenBefore, at\)/);
  assert.match(body('settleTry'), /setTryView\(tryViewOf\(key, fenBefore, uci, answerMovesFrom\(item, fenBefore, at\), g\)\);/);
  assert.match(body('solvingTryLine'), /cutBeforeAnswer\(view\.fenBefore, view\.line, view\.answers, tryViewerOptions\(view, true\)\)/);
});

test('(t) 2: while he solves, the try viewer leaves out every sentence that describes the answer; complete, they are back', () => {
  // R4-2's second repro: after h3 d6 the caption read "d6 lets the knight on f3 take the bishop on g5." (the answer Nxg5).
  const b = answerMovesFrom({ moves: ['f3g5'] }, R42_B, 0);
  const view: TryView = { key: 'k', status: 'done', trySan: 'h3', fenBefore: R42_B, line: ['h2h3', 'd7d6'], title: 'What could follow h3', answers: b, source: 'engine' };
  assert.deepEqual(solvingTryLine(view), ['h2h3', 'd7d6'], 'nothing to cut: the clause is left out instead');
  assert.deepEqual(told(view, view.line, true), { captions: ['h3 pushes the pawn to h3.', 'd6 pushes the pawn to d6.'], summary: 'So far in this line no material changes hands.' });
  assert.deepEqual(told(view, view.line, false), {
    captions: ['h3 pushes the pawn to h3.', 'd6 lets the knight on f3 take the bishop on g5.'],
    summary: 'So far in this line no material changes hands, but the knight on f3 can take the bishop on g5.',
  });
  // The first repro once cut: no sentence describes Nxe5 either.
  const a = answerMovesFrom({ moves: ['f3e5'] }, R42_A, 0);
  const va: TryView = { ...view, fenBefore: R42_A, line: ['h2h3', 'e6e5', 'f3e5'], answers: a };
  const shownA = solvingTryLine(va);
  assert.deepEqual(told(va, shownA, true), { captions: ['h3 pushes the pawn to h3.', 'e5 pushes the pawn to e5.'], summary: 'So far in this line no material changes hands.' });
  // His side's capture of Black's rook (the answer, the rook from d1 to d8) is left out of the caption and the summary.
  const luft = answerMovesFrom({ moves: ['d1d8'] }, LUFT, 0);
  const vl: TryView = { ...view, fenBefore: LUFT, line: ['h2h3', 'a8d8', 'd1d8', 'g8h7'], answers: luft };
  assert.deepEqual(told(vl, solvingTryLine(vl), true), { captions: ['h3 pushes the pawn to h3.', 'Rd8 attacks the undefended rook on d1.'], summary: 'So far in this line no material changes hands.' });
  // FXR2b1 (brief 9.11.8): a later answer described in a caption is left out by `omit` too (every move still to find,
  // not only the one at this step), so the cut no longer has to stop before it. Here the card is h3 d6 Nxg5 and the try
  // 1.Kf1?: after 1...d6 the caption described Nxg5, and before 9.11.8 the line was cut to the try alone.
  const later = answerMovesFrom({ moves: ['h2h3', 'd7d6', 'f3g5'] }, R42_B, 0);
  assert.deepEqual(later.map(m => m.san), ['h3', 'Nxg5']);
  const vk: TryView = { ...view, trySan: 'Kf1', line: ['g1f1', 'd7d6'], answers: later };
  assert.deepEqual(tryViewerOptions(vk, true).omit, later, 'every move still to find');
  assert.deepEqual(told(vk, vk.line, true), { captions: ['Kf1 moves the king to f1.', 'd6 pushes the pawn to d6.'], summary: 'So far in this line no material changes hands.' });
  assert.match(told(vk, vk.line, false).captions[1], /lets the knight on f3 take the bishop on g5/, 'complete: the clause is back');
  assert.deepEqual(cutBeforeAnswer(R42_B, vk.line, later, tryViewerOptions(vk, true)), ['g1f1', 'd7d6']);
  assert.deepEqual(solvingTryLine(vk), ['g1f1', 'd7d6']);
  // A try alone still shows no viewer (9.10 n): textbook KQK, the answer Qe7-g7#, the try line 1.Qf7+ Kh8 2.Qg7#. The
  // 8.2 guard cuts before 2.Qg7#, and the summary after 1...Kh8, "… White can mate in one: Qg7#.", prints the answer's
  // SAN (that mate is the queen from f7, another move by identity, so `omit` keeps it), which cuts the reply too.
  const KQK = '6k1/4Q3/5K2/8/8/8/8/8 w - - 0 1';
  const vq: TryView = { ...view, trySan: 'Qf7+', fenBefore: KQK, line: ['e7f7', 'g8h8', 'f7g7'], answers: answerMovesFrom({ moves: ['e7g7'] }, KQK, 0) };
  assert.deepEqual(solvingTryLine(vq), []);
  assert.equal(renderToStaticMarkup(<TrySlot view={{ ...vq, intro: 'Invented words.' }} solving/>), '<p class="try-check small">Invented words.</p>');
  // The open viewer while he solves: the moves shown stop before the answer; once complete, the whole line. FX2c (FX1c's
  // R4-4 and 9.11.3 R6-3): the viewer opens on the try and lists the moves up to the step on the board, then "…", so the
  // markup lists the try alone (it listed the whole cut line, and the whole line, before); the lines it steps through:
  const labels = (html: string) => [...html.matchAll(/class="line-viewer-move"[^>]*aria-label="([^"]+)"/g)].map(m => m[1]);
  for (const solving of [true, false]) {
    const html = renderToStaticMarkup(<TrySlot view={va} solving={solving}/>);
    assert.deepEqual(labels(html), ['1. h3']);
    assert.match(html, /<li class="line-viewer-more"/);
    assert.doesNotMatch(html, /Nxe5/);
  }
  assert.deepEqual(solvingTryLine(va), ['h2h3', 'e6e5'], 'while he solves: the try and the reply, never the answer');
  assert.deepEqual(va.line, ['h2h3', 'e6e5', 'f3e5'], 'complete: the whole line');
  assert.match(body('TrySlot'), /solving \? solvingTryLine\(view\) : view\.line/);
});
