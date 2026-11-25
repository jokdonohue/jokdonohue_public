/**
 * M3 fix round 2, stage 2, writer FX2c (brief 9.11.3), the Trainer side:
 * - R1-2: a note from the page points at his latest try, set on every try (a try still being checked, another mate);
 * - R2-1: a check stopped while it runs, or ended by its own deadline or a failure, lets the next own-game card warm the
 *   engine again;
 * - R2-2: a try graded with no result keeps that grade for the rest of the card visit;
 * - R4-3: no move on after a clean solve while Claude's answer to his note shows on the card;
 * - R4-6 (drill part): after a drill the stored explanation shows, without "The idea";
 * - R6-2: the hint button keeps the focus during the 2 s guard (aria-disabled, presses ignored);
 * - R6-3: a try viewer opens on his try (initial step 1);
 * - 9.10 (h) extended: on a phone every finished try sits one press away under the message line; wider widths unchanged;
 * - narrationNames reads a line with the viewer's own narrator options (FX2b did it; verified here);
 * - (r) 3 gaps: the game-line viewer and the small-edge viewer get their figures; (r) 5: the stored-numbers intro is left
 *   out whenever the try viewer shows figures for his game move.
 *
 * As in the other trainer tests: the page has no DOM test renderer (a static render of the Trainer stops at "Loading"), so
 * the Trainer is covered through its exported pieces, and the wiring is pinned by reading Trainer.tsx and PunishStudy.tsx.
 * The click paths (the focus during the guard, the toggle under the message, the step a try viewer opens on) are run in
 * a real browser (logs/m3_FX2c.md).
 *
 * Positions are textbook, invented (each checked with chess.js) or the page's own textbook drills; engine results are
 * invented TryCheck values. No owner game data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chess } from 'chess.js';
import {
  advancesAfterCleanSolve, answerMovesFrom, checkTryWithin, feedbackPosition, gameLineOf, gameLineVerdict, gradeCardTry, hintButton, movesOnAfterCleanSolve, PracticeColumns,
  SolvedNotes, SolvedViewers, solvedTextsOf, storedNumbersIntro, tryCollapsedOnPhone, tryKey, TrySlot, tryToggleLabel, tryViewOf, type PracticeLayout,
  type PracticeParts, type TryView,
} from '../components/Trainer';
import LineViewer, { lineNarration } from '../components/LineViewer';
import type { AnsweredNote } from '../components/HomePanels';
import { buildPools, type TrainerItem } from '../components/pools';
import type { FeedbackDoc } from '../src/contract/docs';
import { solverWinAfter } from '../src/teach/punish';
import type { TryCheck } from '../src/teach/tryMove';
import type { AnalysisEngine } from '../src/analysis/engine';
import { endgameDrills } from '../lib/endgames';
import { drillTeach } from '../lib/endgameTeach';
import { ARTIFACT_DIR } from './b3_paths';

const src = readFileSync(join(ARTIFACT_DIR, 'components/Trainer.tsx'), 'utf8');
const study = readFileSync(join(ARTIFACT_DIR, 'components/PunishStudy.tsx'), 'utf8');
const css = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const count = (text: string, s: string) => text.split(s).length - 1;
/** Where a function declared in Trainer.tsx starts and ends (parameter list and body matched by bracket counting). */
function body(name: string, text = src): string {
  const m = new RegExp(`function ${name}\\(`).exec(text);
  assert.ok(m, `${name} found`);
  let i = m.index + m[0].length, depth = 1;
  for (; depth > 0; i++) depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0;
  i = text.indexOf('{', i);
  for (depth = 1, i++; depth > 0; i++) depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0;
  return text.slice(m.index, i);
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
/** The move buttons a viewer lists (their full labels). */
const moveLabels = (html: string) => [...html.matchAll(/class="line-viewer-move"[^>]*aria-label="([^"]+)"/g)].map(m => m[1]);
/** A viewer's summary at the end of its line. */
const summaryAtEnd = (fen: string, line: string[], extra: Record<string, unknown> = {}) => {
  const html = renderToStaticMarkup(<LineViewer title="t" startFen={fen} line={line} orientation="w" initialStep={line.length} {...extra}/>);
  return /<p class="line-viewer-summary">([^<]*)<\/p>/.exec(html)?.[1] ?? '';
};

// ---------------------------------------------------------------- fixtures (invented or textbook)

/** His game (White): Re7 leaves the back rank; Black (the solver) plays Rd1+ Re1 Rxe1#. Better was h3. */
const BEFORE = '3r2k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';
const PUNISH_FEN = after(BEFORE, 'e1e7').fen;
const punishCard = (winAfter = 2): TrainerItem => ({
  id: 'punish-t1', fen: PUNISH_FEN, moves: ['d8d1'], rating: 1000, themes: ['personal', 'opening'], gameUrl: '', source: 'pack', kind: 'punish',
  pack: { playedSan: 'Re7', playedUci: 'e1e7', sourceFen: BEFORE, pvUci: ['d8d1', 'e7e1', 'd1e1'], rowId: 't1', winAfter, solverColor: 'b' },
});
const siblingCard = (pack: Record<string, unknown> = {}): TrainerItem => ({
  id: 'pack-t1', fen: BEFORE, moves: ['h2h3'], rating: 1000, themes: ['personal'], gameUrl: '', source: 'pack', kind: 'mistake',
  pack: { playedSan: 'Re7', playedUci: 'e1e7', pvUci: ['h2h3', 'd8d1', 'e1d1'], winBefore: 70, winAfter: 2, ...pack },
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
/** The French after 1.e4 e6 2.d4 d5, as a Lichess puzzle: 3.Nc3 Nf6 4.Bg5. */
const FRENCH = 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6 0 3';
const frenchBank = (): TrainerItem => ({ id: 'bank-french', fen: FRENCH, moves: ['b1c3', 'g8f6', 'c1g5'], rating: 1400, themes: ['opening', 'advantage'], gameUrl: '', source: 'bank' });
/** A drill as the page's pools hold it (with its stored explanation), or as the older tests build it (without). */
const drill = (id: string, withExplanation = false): TrainerItem => {
  const d = endgameDrills.find(x => x.id === id);
  assert.ok(d, id);
  return {
    id: d!.id, fen: d!.fen, moves: [...d!.moves], rating: d!.rating, themes: [...d!.themes], gameUrl: '', source: 'endgame',
    ...(withExplanation && d!.explanation ? { explanation: d!.explanation } : {}),
  };
};
/** Invented: White's bishop b2 can take the rook on h8 (no check). */
const BISHOP = '7r/8/8/8/8/8/1B6/K6k w - - 0 1';
const note = (id: string, itemId: string, at: number, reply: string | undefined): AnsweredNote =>
  ({ id, doc: { at, kind: 'comment', itemId, source: 'bank', themes: [], fen: FRENCH, sessionId: 's', text: 'invented note', status: reply ? 'done' : 'open', ...(reply ? { reply } : {}) } as FeedbackDoc });

const PART_NAMES = ['board', 'feedback', 'controls', 'ladder', 'advance', 'head', 'coach', 'solved', 'viewers', 'trySlot', 'foot'] as const;
const markers = Object.fromEntries(PART_NAMES.map(n => [n, <i data-part={n}/>])) as unknown as PracticeParts;
const columns = (layout: PracticeLayout, item: TrainerItem, view: TryView | null) =>
  renderToStaticMarkup(<PracticeColumns layout={layout} parts={{ ...markers, trySlot: <TrySlot view={view} solving/> }} tryCollapsed={tryCollapsedOnPhone(item, view)}/>);

test('fixtures are legal', () => {
  assert.deepEqual(sans(PUNISH_FEN, ['d8d1', 'e7e1', 'd1e1']), ['Rd1+', 'Re1', 'Rxe1#']);
  assert.deepEqual(sans(PUNISH_FEN, [TRY.uci, ...TRY.reply]), ['h6', 'Kf1', 'Rd1+', 'Re1']);
  assert.deepEqual(sans(BEFORE, ['h2h3', 'd8d1', 'e1d1']), ['h3', 'Rd1', 'Rxd1']);
  assert.deepEqual(sans(MISTAKE_FEN, ['d1d8']), ['Qxd8#']);
  assert.deepEqual(sans(MISTAKE_FEN, ['d1d7', 'd8d7', 'h2h3']), ['Qd7', 'Rxd7', 'h3']);
  assert.deepEqual(sans(FRENCH, ['b1c3', 'g8f6', 'c1g5']), ['Nc3', 'Nf6', 'Bg5']);
  assert.deepEqual(sans(FRENCH, ['e4d5', 'e6d5']), ['exd5', 'exd5']);
  assert.deepEqual(sans(BISHOP, ['b2h8', 'h1g2']), ['Bxh8', 'Kg2']);
});

// ---------------------------------------------------------------- R1-2: what a note points at

test('R1-2: a note points at his latest try, set on every try (a try still being checked, another mate); cleared with each new card', () => {
  // The position and the try, as version 6 sent them; a pending own-game try is a try like any other.
  const card = mistakeCard();
  assert.deepEqual(feedbackPosition(card, { fen: MISTAKE_FEN, uci: 'd1d7', index: 0 }), { fen: MISTAKE_FEN, playedUci: 'd1d7' });
  assert.deepEqual(feedbackPosition(card, null), { fen: MISTAKE_FEN }, 'no try: the card position');
  // Wiring: the ref is set first thing in tryOther, before any branch, any check and the `setWrong(null)` that a running
  // own-game check used to leave the note with; and on another mate in play(); cleared by every new card or question.
  const other = body('tryOther');
  assert.match(other, /const key = tryKey\(item\.id, at, uci\), kind = teachKind\(item\);\s*latestTry\.current = \{ fen: fenBefore, uci, index: at \};/);
  assert.ok(other.indexOf('latestTry.current =') < other.indexOf("kind === 'endgame'") && other.indexOf('latestTry.current =') < other.indexOf('setWrong(null)'));
  assert.match(body('play'), /if \(uci !== active\.moves\[index\] && !alternateMate\) \{[^{}]*tryOther\(active, fen, uci, index\);\s*return;\s*\}\s*\/\/[^\n]*\n\s*if \(uci !== active\.moves\[index\]\) latestTry\.current = \{ fen, uci, index \};/);
  assert.match(body('startPuzzle'), /latestTry\.current = null;/);
  assert.match(body('startSafe'), /latestTry\.current = null;/);
  assert.equal(count(src, 'latestTry.current ='), 4, 'set in tryOther and play, cleared in startPuzzle and startSafe');
  // The note reads the ref; the coach keeps `wrong` (no explain input while the check runs).
  const send = body('sendFeedback');
  assert.match(send, /feedbackPosition\(active, latestTry\.current\)/);
  assert.doesNotMatch(send, /feedbackPosition\(active, wrong\)/);
  assert.match(src, /explainInput\(active, wrong, active\.source, \{ check, sibling \}\)/);
});

// ---------------------------------------------------------------- R2-1: the warm-up after a stopped check

test('R2-1: stopping a running check lets the next own-game card warm the engine again; an idle stop changes nothing', () => {
  // Every stop the page makes goes through stopCheck, which clears `warmed` only when a check was running.
  assert.match(body('stopCheck'), /if \(tryGate\.pending\(\)\) warmed\.current = false;\s*tryGate\.stop\(\);/);
  assert.equal(count(src, 'tryGate.stop()'), 2, 'stopCheck and the unmount cleanup only');
  assert.match(src, /useEffect\(\(\) => \(\) => tryGate\.stop\(\), \[tryGate\]\)/);
  assert.match(body('clearTry'), /stopCheck\(\); setTryView\(null\);/);
  assert.match(body('dropPendingTry'), /if \(!tryGate\.pending\(\)\) return;\s*stopCheck\(\);/);
  assert.equal(count(body('tryOther'), 'stopCheck();'), 5, 'the drill grade, and the reused grades on both branches');
  // A new check over a running one (a second try on a Lichess puzzle) stops it too.
  assert.match(body('startTryCheck'), /if \(tryGate\.pending\(\)\) warmed\.current = false;\s*const engine = getSharedEngine\(\);/);
  // The next own-game card then warms again (startPuzzle stops any check before it looks at `warmed`).
  const start = body('startPuzzle');
  assert.ok(start.indexOf('clearTry();') < start.indexOf('if (!warmed.current && waitsForEngine(p))'));
  assert.match(start, /if \(!warmed\.current && waitsForEngine\(p\)\) \{ warmed\.current = true; warmEngine\(p\.fen\); \}/);
  // Every place `warmed` is cleared: stopCheck and startTryCheck, each guarded by a running check, and the end of a check
  // with no result (next test).
  assert.equal(count(src, 'warmed.current = false'), 3);
  assert.equal(count(src, 'if (tryGate.pending()) warmed.current = false;'), 2);
  assert.equal(count(src, "if (engine && g.source === 'stored') warmed.current = false;"), 1);
});

test('R2-1, the deadline path: the 6 s deadline stops a running search as a stop does, so a check with no result clears the warm-up', async () => {
  // A search that never answers, as a hung or very slow engine: the deadline aborts it. (The real worker driver ends its
  // worker when a running search is aborted, engine.ts `onAbort` -> `fail` -> `kill`; R2's O6 saw it 6.0 s after `go`.)
  let started = 0, aborted = 0;
  const hung: AnalysisEngine = {
    analyse: (_fen, o) => new Promise((_resolve, reject) => {
      started++;
      o.signal?.addEventListener('abort', () => { aborted++; reject(new DOMException('Analysis stopped.', 'AbortError')); }, { once: true });
    }),
    dispose: () => undefined,
  };
  const check = await checkTryWithin(hung, MISTAKE_FEN, 'h2h3', 'd1d8', new AbortController().signal, 40);
  assert.equal(check, null, 'no result at the deadline');
  assert.equal(started, 1);
  assert.equal(aborted, 1, 'the deadline stops the running search');
  // That null check is graded with no result (source 'stored', the R2-2 test), and the page then clears `warmed`, before
  // the grade is settled, so the next own-game card shown warms the engine again (startPuzzle).
  assert.match(body('startTryCheck'), /void gradeAfterCheck\(tryGate, engine, item, fenBefore, uci, at, g => \{[^]*?if \(engine && g\.source === 'stored'\) warmed\.current = false;\s*settleLatest\.current\(key, fenBefore, uci, at, g\);\s*\}\);/);
});

// ---------------------------------------------------------------- R2-2: one grade per try without a result

test('R2-2: a try graded with no result keeps that grade for the rest of the card visit; engine and tablebase grades are not kept here', () => {
  // The grade with no result (the deadline, a failure, no engine): an error with the honest copy, source "stored".
  const card = mistakeCard();
  const none = gradeCardTry(card, MISTAKE_FEN, 'h2h3', 0, null);
  assert.deepEqual([none.grade.action, none.grade.tryVerdict, none.source, none.check], ['error', 'unchecked', 'stored', undefined]);
  // Reused, it gives the same view and the same words: the move cannot read two verdicts.
  const key = tryKey(card.id, 0, 'h2h3');
  assert.deepEqual(tryViewOf(key, MISTAKE_FEN, 'h2h3', [], none), tryViewOf(key, MISTAKE_FEN, 'h2h3', [], none));
  // An engine result and a drill's tablebase grade have their own sources, so they are never kept as "no result".
  assert.equal(gradeCardTry(card, MISTAKE_FEN, 'h2h3', 0, check({ tryUci: 'h2h3', trySan: 'h3', replyLine: ['d8d1'], tryWin: 2, bestWin: 99.6 })).source, 'engine');
  const kpk = drill('tech-kpk-take-the-opposition');
  assert.equal(gradeCardTry(kpk, kpk.fen, 'e3e4', 0, null).source, 'tablebase');
  // A check for another move is no result for this one.
  assert.equal(gradeCardTry(card, MISTAKE_FEN, 'h2h3', 0, check({ tryUci: 'g2g3', trySan: 'g3', replyLine: [], tryWin: 2, bestWin: 99.6 })).source, 'stored');
  // Wiring: settleTry keeps a grade it applies when it has no engine result (a stopped check never reaches settleTry);
  // tryOther reuses it before any new check, on a Lichess puzzle (after counting the error, as for any miss) and on his
  // games; every new card visit starts empty.
  const settle = body('settleTry');
  assert.match(settle, /if \(g\.source === 'stored'\) noResult\.current\.set\(key, g\);\s*setTryView\(tryViewOf\(key, fenBefore, uci, answerMovesFrom\(item, fenBefore, at\), g\)\);/);
  assert.ok(settle.indexOf('noResult.current.set') > settle.indexOf('return;'), 'after the identity check: only a grade that applies');
  const other = body('tryOther');
  assert.match(other, /const unchecked = noResult\.current\.get\(key\) \?\? null;/);
  const reuse = /if \(unchecked\) \{ stopCheck\(\); settleTry\(key, fenBefore, uci, at, unchecked\); return; \}/g;
  assert.equal([...other.matchAll(reuse)].length, 2, 'both branches');
  const bank = other.slice(other.indexOf("if (kind === 'bank')"), other.indexOf('setWrong(null);'));
  assert.ok(bank.indexOf('countError(uci);') < bank.search(reuse) && bank.search(/if \(unchecked\)/) < bank.indexOf('startTryCheck('), 'a Lichess puzzle: counted, then the kept grade, no new check');
  const own = other.slice(other.indexOf('setWrong(null);'));
  assert.ok(own.search(/if \(unchecked\)/) < own.indexOf('setFeedback(`Checking'), 'his games: the kept grade, no "Checking …"');
  assert.match(body('startPuzzle'), /noResult\.current = new Map\(\);/);
  assert.equal(count(src, 'noResult.current = new Map()'), 1);
});

// ---------------------------------------------------------------- R4-3: no move on while Claude's answer shows

test('R4-3: a clean Lichess solve moves on, except while Claude\'s answer to his note shows on the card', () => {
  const bank = frenchBank();
  assert.equal(movesOnAfterCleanSolve(bank, []), true);
  assert.equal(movesOnAfterCleanSolve(bank, [note('f1', bank.id, 1_000, 'The puzzle line is correct.')]), false, 'an answer shows');
  assert.equal(movesOnAfterCleanSolve(bank, [note('f2', bank.id, 1_000, undefined)]), true, 'an open note shows nothing on the card');
  assert.equal(movesOnAfterCleanSolve(bank, [note('f3', bank.id, 1_000, '   ')]), true, 'an empty reply is no answer');
  for (const item of [mistakeCard(), punishCard(), drill('tech-kpk-take-the-opposition'), null]) {
    assert.equal(movesOnAfterCleanSolve(item, []), advancesAfterCleanSolve(item), item?.id ?? 'null');
    assert.equal(movesOnAfterCleanSolve(item, []), false);
  }
  // Wiring: the one call site reads the card's answers, the same list CardAnswer shows.
  assert.match(body('play'), /movesOnAfterCleanSolve\(active, cardAnswers\)\) scheduleAdvance\(\);/);
  assert.match(src, /const cardAnswers = useMemo\(\(\) => answersFor\(view\.answeredFeedback, active\?\.id\), \[view\.answeredFeedback, active\?\.id\]\);/);
  assert.match(src, /<CardAnswer items=\{cardAnswers\}\/>/);
});

// ---------------------------------------------------------------- R4-6 (drill part): the explanation, without "The idea"

test('R4-6: after a drill the stored explanation shows and "The idea" is left out; the idea stays for a drill without one', () => {
  // Every bundled drill has both, so after a drill the panel shows the explanation only.
  assert.equal(endgameDrills.length, 26);
  assert.ok(endgameDrills.every(d => !!d.explanation && !!drillTeach(d.id)?.idea));
  // The pools carry the explanation to the card.
  const pools = buildPools({ bank: [], endgames: endgameDrills, pack: null, personal: [], drills: [] });
  const pooled = pools.byId.get('tech-kpk-take-the-opposition')!;
  assert.equal(pooled.explanation, endgameDrills.find(d => d.id === pooled.id)!.explanation);
  for (const item of [pooled, drill('tech-krk-mate-in-two-king-step', true)]) {
    assert.equal(renderToStaticMarkup(<SolvedNotes item={item}/>), '', `${item.id}: no "The idea"`);
    assert.deepEqual(solvedTextsOf(item, null), { gameLine: false, explanation: true }, `${item.id}: the panel prints the explanation`);
  }
  assert.match(src, /\{active\.explanation && solvedTexts\.explanation && <p className="small">\{active\.explanation\}<\/p>\}\s*<SolvedNotes item=\{active\} sibling=\{sibling\} lesson=\{lesson\}\/>/);
  // Without a stored explanation the idea is the fallback, as before.
  const bare = drill('tech-kpk-take-the-opposition');
  assert.equal(renderToStaticMarkup(<SolvedNotes item={bare}/>), `<div class="teach-notes"><p><strong>The idea: </strong>${esc(drillTeach(bare.id)!.idea)}</p></div>`);
  // A punish card's lesson is not affected.
  assert.match(renderToStaticMarkup(<SolvedNotes item={punishCard()} sibling={siblingCard()}/>), /^<div class="teach-notes"><p>In your game you played Re7\./);
});

// ---------------------------------------------------------------- R6-2: the focus during the 2 s guard

test('R6-2: during the 2 s guard the hint button stays focusable (aria-disabled) and a press is ignored; "Checking …" still disables it', () => {
  const t = 1_000_000;
  assert.deepEqual(hintButton(3, t, t + 500), { label: 'Ready in a moment', disabled: true });
  assert.deepEqual(hintButton(3, t, t + 2000), { label: 'Next hint (4 of 4)', disabled: false });
  // The button: never `disabled` for the guard (that dropped the focus to the page), aria-disabled instead.
  assert.match(src, /\{hintBtn && <button className="secondary" disabled=\{locked\} aria-disabled=\{hintBtn\.disabled \|\| undefined\} onClick=\{showHint\}><Lightbulb size=\{17\}\/>\{hintBtn\.label\}<\/button>\}/);
  assert.doesNotMatch(src, / disabled=\{hintBtn\.disabled/, 'the guard no longer sets `disabled`');
  // A press during the guard: showHint asks hintButton again and returns, so nothing is shown and nothing is counted.
  const show = body('showHint');
  assert.match(show, /if \(!active \|\| complete \|\| locked\) return;/);
  assert.match(show, /const button = hintButton\(shown, shown === 3 \? hintStep\.at : null, Date\.now\(\)\);\s*if \(!button \|\| button\.disabled\) return;/);
  assert.ok(show.indexOf('if (!button || button.disabled) return;') < show.indexOf('setHints('));
  // The page re-renders when the last hint becomes available, so the same button (and its focus) gets the new label.
  assert.match(src, /const timer = setTimeout\(\(\) => setHintClock\(n => n \+ 1\), left \+ 25\);/);
  // It looks disabled: an appended block, one rule, no colour, no token, no comma selector (D12).
  const at = css.indexOf('/* ---- Part 11: M3 fix round 2, stage 2 (FX2c');
  assert.ok(at > css.indexOf('/* ---- Part 10: M3 fix round 2 (FX2b'), 'Part 11 after Part 10');
  // Fix round 3 appends Part 12 after it (tests/m3_fix3_trainer.test.tsx); Part 11 itself is unchanged, read up to there.
  const next = css.indexOf('/* ---- Part 12', at);
  const rules = [...css.slice(at, next === -1 ? undefined : next).replace(/\/\*[^]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.deepEqual(rules.map(r => [r[1].trim(), r[2]]), [['.coach-actions .secondary[aria-disabled="true"]', 'opacity:.55;cursor:default']]);
  for (const [, sel, decl] of rules) {
    assert.doesNotMatch(sel, /,/);
    assert.doesNotMatch(decl, /#[0-9a-fA-F]{3,8}\b|rgba?\(|var\(|\bwhite\b|\bblack\b/);
  }
  assert.match(css, /button:disabled\{cursor:default;opacity:\.55\}/, 'the same look as a disabled button');
});

// ---------------------------------------------------------------- R6-3: a try viewer opens on his try

test('R6-3: a try viewer opens on his try, asking him to guess the reply; its intro is the caption at the start', () => {
  const card = punishCard();
  const g = gradeCardTry(card, card.fen, TRY.uci, 0, tryCheck(13.7, 99.6));
  const view = tryViewOf(tryKey(card.id, 0, TRY.uci), card.fen, TRY.uci, answerMovesFrom(card, card.fen, 0), g)!;
  assert.equal(view.intro, 'After h6 the engine gives Black 14% to win; the best move keeps 100%.');
  const html = renderToStaticMarkup(<TrySlot view={view} solving/>);
  assert.match(html, /<p class="line-viewer-legend">Guess the next move, then press Next\.<\/p>/);
  assert.match(html, /<p class="line-viewer-caption" aria-live="polite"><strong>1\.\.\. h6<\/strong> /);
  assert.deepEqual(moveLabels(html), ['1... h6'], 'the try alone, then "…"');
  assert.match(html, /<li class="line-viewer-more"/);
  assert.doesNotMatch(html, /Press Next to step through the line\./);
  // The board shows the position after the try, with the try as the arrow.
  assert.match(html, /data-square="h6" class="square [^"]*" aria-label="h6 black pawn"/);
  // At the start (one press back): the intro. The same viewer at step 0 shows it.
  const start = renderToStaticMarkup(<LineViewer title={view.title} startFen={view.fenBefore} line={view.line} orientation="b" intro={view.intro} initialStep={0}/>);
  assert.ok(start.includes(`<p class="line-viewer-caption" aria-live="polite">${esc(view.intro!)}</p>`));
  // A drill's counted miss: the listed note is the intro, the viewer opens on the try too.
  const kpk = drill('tech-kpk-take-the-opposition');
  const e4 = tryViewOf(tryKey(kpk.id, 0, 'e3e4'), kpk.fen, 'e3e4', answerMovesFrom(kpk, kpk.fen, 0), gradeCardTry(kpk, kpk.fen, 'e3e4', 0, null))!;
  const drillHtml = renderToStaticMarkup(<TrySlot view={e4} solving/>);
  assert.deepEqual(moveLabels(drillHtml), ['1. e4']);
  assert.match(drillHtml, /Guess the next move, then press Next\./);
  // A line of the try alone (nothing to guess after it) opens on its end.
  const krk = drill('tech-krk-mate-in-two-king-step');
  const rg7 = drillTeach(krk.id)!.steps.find(s => s.step === 0)!.tries.find(t => t.san === 'Rg7')!;
  const alone = tryViewOf(tryKey(krk.id, 0, rg7.uci), krk.fen, rg7.uci, answerMovesFrom(krk, krk.fen, 0), gradeCardTry(krk, krk.fen, rg7.uci, 0, null))!;
  assert.deepEqual(alone.line, [rg7.uci]);
  assert.match(renderToStaticMarkup(<TrySlot view={alone} solving/>), /<p class="line-viewer-legend">End of the line\.<\/p>/);
  // Wiring: the slot's one viewer; the answer and game viewers still open at the start (they begin at the card).
  // Version 7.3: the intro is still the caption at the start, except a drill's own note, which stands above the viewer
  // (opening on his try had left that note one press back, where it was not read).
  assert.match(body('TrySlot'), /intro=\{note \? undefined : view\.intro\}\n\s*initialStep=\{1\} verdict=\{verdict\} omit=\{omit\} noChangeSentence=\{false\} \{\.\.\.closed\}\/>/);
  // Version 7.1 (brief m31 4.4, item C): a second viewer opens on a move he made, the viewer of his game move after a
  // mistake card (`gameMoveViewer`: "opened at step 1"). The count was 1 before 7.1.
  assert.equal(count(src, 'initialStep='), 2);
  assert.match(body('SolvedViewers'), /intro=\{allowed\.intro\} initialStep=\{1\} verdict=\{allowed\.verdict\} noChangeSentence=\{false\} defaultOpen=\{false\}/);
});

// ---------------------------------------------------------------- 9.10 (h) extended: every finished try on a phone

test('9.10 (h) extended: on a phone every finished try sits one press away right under the message; wider widths unchanged', () => {
  const kpk = drill('tech-kpk-take-the-opposition');
  const bank = frenchBank();
  const own = punishCard();
  const krk = drill('tech-krk-mate-in-two-king-step');
  const cases: Array<{ name: string; item: TrainerItem; view: TryView; label: string; title: RegExp }> = [
    {
      name: 'a Lichess puzzle\'s miss', item: bank, label: "See the engine's reply", title: /Why exd5 doesn&#x27;t work/,
      view: tryViewOf(tryKey(bank.id, 0, 'e4d5'), FRENCH, 'e4d5', answerMovesFrom(bank, FRENCH, 0),
        gradeCardTry(bank, FRENCH, 'e4d5', 0, check({ tryUci: 'e4d5', trySan: 'exd5', replyLine: ['e6d5', 'b1c3'], tryWin: 40, bestWin: 58 })))!,
    },
    {
      name: 'his own game\'s counted miss', item: own, label: "See the engine's reply", title: /Why h6 doesn&#x27;t work/,
      view: tryViewOf(tryKey(own.id, 0, TRY.uci), own.fen, TRY.uci, answerMovesFrom(own, own.fen, 0), gradeCardTry(own, own.fen, TRY.uci, 0, tryCheck(13.7, 99.6)))!,
    },
    {
      name: 'his game move with the stored line', item: mistakeCard(), label: "See the engine's reply", title: /Why Qd7 doesn&#x27;t work/,
      view: tryViewOf(tryKey('pack-m1', 0, 'd1d7'), MISTAKE_FEN, 'd1d7', answerMovesFrom(mistakeCard(), MISTAKE_FEN, 0), gradeCardTry(mistakeCard(), MISTAKE_FEN, 'd1d7', 0, null))!,
    },
    {
      name: 'a drill\'s counted miss', item: kpk, label: 'See the line', title: /Why e4 doesn&#x27;t work/,
      view: tryViewOf(tryKey(kpk.id, 0, 'e3e4'), kpk.fen, 'e3e4', answerMovesFrom(kpk, kpk.fen, 0), gradeCardTry(kpk, kpk.fen, 'e3e4', 0, null))!,
    },
  ];
  for (const { name, item, view, label, title } of cases) {
    assert.equal(view.collapsed, undefined, `${name}: a counted miss, open by itself`);
    assert.equal(tryCollapsedOnPhone(item, view), true, name);
    assert.equal(tryToggleLabel(view), label, name);
    const phone = columns('phone', item, view);
    // Version 7.3: a drill's own note stands above its toggle; every other kind is the toggle alone, as before.
    const note = view.source === 'tablebase' && view.intro ? `<p class="try-note small">${esc(view.intro)}</p>` : '';
    assert.equal(note !== '', name === 'a drill\'s counted miss', `${name}: only the drill carries a note`);
    assert.ok(phone.includes(`<i data-part="feedback"></i><div class="try-check">${note}<button type="button" class="secondary line-viewer-toggle" aria-expanded="false">${esc(label)}</button></div><i data-part="ladder"></i>`), `${name}: toggle under the message`);
    assert.doesNotMatch(phone, /class="line-viewer-title"/, `${name}: collapsed`);
    assert.ok(phone.indexOf('class="try-check"') < phone.indexOf('class="coach-panel"'), `${name}: under the board`);
    // Wider: open, no toggle, where it was (the coach panel when wide, under the board from 651 to 1000 px).
    const wide = columns('wide', item, view), mid = columns('mid', item, view);
    for (const [layout, html] of [['wide', wide], ['mid', mid]] as const) {
      assert.match(html, title, `${name}, ${layout}: open`);
      assert.equal(count(html, 'line-viewer-toggle'), 0, `${name}, ${layout}: no toggle`);
    }
    assert.ok(wide.indexOf('class="try-check"') > wide.indexOf('class="coach-panel"'), `${name}: wide, in the coach panel`);
    assert.ok(mid.indexOf('class="board-viewers"') < mid.indexOf('class="try-check"') && mid.indexOf('class="try-check"') < mid.indexOf('class="coach-panel"'), `${name}: mid, under the board`);
  }
  // A soft retry stays one press away at every width, with its stage 1 label; a drill's reads "See the tablebase line".
  const ra8 = tryViewOf(tryKey(krk.id, 0, 'a7a8'), krk.fen, 'a7a8', answerMovesFrom(krk, krk.fen, 0), gradeCardTry(krk, krk.fen, 'a7a8', 0, null))!;
  assert.deepEqual([ra8.collapsed, tryToggleLabel(ra8), tryCollapsedOnPhone(krk, ra8)], [true, 'See the tablebase line', true]);
  for (const layout of ['phone', 'mid', 'wide'] as const) assert.match(columns(layout, krk, ra8), /aria-expanded="false">See the tablebase line<\/button>/, layout);
  const soft = tryViewOf(tryKey(own.id, 0, TRY.uci), own.fen, TRY.uci, answerMovesFrom(own, own.fen, 0), gradeCardTry(own, own.fen, TRY.uci, 0, tryCheck(75.1, 99.6)))!;
  assert.deepEqual([soft.collapsed, tryToggleLabel(soft)], [true, "See the engine's reply"]);
  // Nothing to place: no try, or a check still running (it stays in the coach panel on a phone).
  assert.equal(tryCollapsedOnPhone(bank, null), false);
  const checking: TryView = { key: tryKey(bank.id, 0, 'e4d5'), status: 'checking', trySan: 'exd5', fenBefore: FRENCH, answers: [], line: [], title: '' };
  assert.equal(tryCollapsedOnPhone(bank, checking), false);
  const running = columns('phone', bank, checking);
  assert.ok(running.indexOf('Checking exd5…') > running.indexOf('class="coach-panel"'));
  // Wiring: the slot's toggle label.
  assert.match(body('TrySlot'), /const closed = view\.collapsed \|\| byBoard \? \{ defaultOpen: false, toggleLabel: tryToggleLabel\(view\) \} : \{\};/);
});

// ---------------------------------------------------------------- narrationNames: the viewer's own options (verify)

test('narrationNames reads a try line with the narrator options the viewer uses (FX2b; verified)', () => {
  // The viewer narrates with maxPlies = the line, nameMate false and its verdict, omit and noChangeSentence ...
  const viewerSrc = readFileSync(join(ARTIFACT_DIR, 'components/LineViewer.tsx'), 'utf8');
  assert.match(viewerSrc, /return narrateLine\(startFen, line, \{ maxPlies: line\.length, nameMate: false, verdict, omit, noChangeSentence \}\);/);
  // ... and the cut reads the shown part the same way, from the options the slot gives the viewer.
  assert.match(body('narrationNames'), /const n = narrateLine\(fenBefore, line, \{ maxPlies: line\.length, nameMate: false, verdict: opts\.verdict \?\? null, omit: opts\.omit \?\? null, noChangeSentence: opts\.noChangeSentence \?\? false \}\);/);
  assert.match(body('solvingTryLine'), /cutBeforeAnswer\(view\.fenBefore, view\.line, view\.answers, tryViewerOptions\(view, true\)\)/);
  assert.match(body('TrySlot'), /const \{ verdict, omit \} = tryViewerOptions\(view, solving\);/);
  // The viewer shows each ply's caption (FX1c, R4-6) where the cut reads the one-sentence text: the same piece words,
  // squares and SANs, in one sentence or split (FX1c's corpus test in tests/m3_fix2b_narrate.test.tsx), so a match on the
  // text is at least as strict. Kept as built: no change.
  assert.match(body('narrationNames'), /const caption = sentenceAfterMove\(p\.text, p\.san\);/);
  // The verdict reaches what the cut reads: the summary the viewer closes on (invented BISHOP line, his try's figure 6%).
  const rook = lineNarration(BISHOP, ['b2h8', 'h1g2'], undefined, { verdict: { side: 'w', win: 6 }, omit: null, noChangeSentence: false });
  assert.equal(rook.summary, 'White is a rook up at the end of this line, but the engine gives Black 94% to win.');
});

// ---------------------------------------------------------------- (r) 3 gaps: the game line and the small edges

test('(r) 3: "What you could have played in the game" gets his side and the sibling card\'s stored figure', () => {
  const card = punishCard(), sib = siblingCard();
  assert.deepEqual(gameLineOf(card, sib), { fen: BEFORE, line: ['h2h3', 'd8d1', 'e1d1'] });
  assert.deepEqual(gameLineVerdict(card, sib), { side: 'w', win: 70 }, 'his side (White, to move in his game), pack.winBefore');
  assert.equal(gameLineVerdict(card, undefined), null, 'no sibling, no line');
  assert.equal(gameLineVerdict(card, siblingCard({ winBefore: undefined })), null, 'no stored figure');
  assert.equal(gameLineVerdict(card, siblingCard({ winBefore: Number.NaN })), null);
  assert.equal(gameLineVerdict(card, { ...siblingCard(), fen: FRENCH, moves: ['b1c3'] }), null, 'a sibling from another position has no game line');
  // The closing sentence with it: settled where the figure agrees, the verdict sentence where it does not.
  const line = gameLineOf(card, sib)!.line;
  assert.equal(summaryAtEnd(BEFORE, line), 'White wins a rook.');
  assert.equal(summaryAtEnd(BEFORE, line, { verdict: gameLineVerdict(card, sib) }), 'White wins a rook.', '70% agrees');
  const low = gameLineVerdict(card, siblingCard({ winBefore: 40 }))!;
  assert.equal(summaryAtEnd(BEFORE, line, { verdict: low }), 'White is a rook up at the end of this line, but the engine gives Black 60% to win.');
  // The viewer gets it (open after help; one press away after an unaided solve).
  const open = renderToStaticMarkup(<SolvedViewers item={card} sibling={siblingCard({ winBefore: 40 })} assisted/>);
  assert.match(open, />What you could have played in the game<\/h3>/);
  assert.match(body('SolvedViewers'), /verdict=\{gameLineVerdict\(item, sibling\)\} noChangeSentence=\{false\}/);
});

test('(r) 3: a small edge\'s line (Games tab) gets the punisher\'s stored figure, solverWinAfter', () => {
  // The one change to PunishStudy.tsx (9.11.7): the import and the edge viewer's verdict.
  assert.match(study, /import \{ punishAnswerLine, punishLesson, solverWinAfter \} from '@\/src\/teach\/punish';/);
  assert.match(study, /const win = solverWinAfter\(card\);/);
  assert.match(study, /orientation=\{solverSide\(card\)\} compact defaultOpen=\{false\} toggleLabel="Show the line" verdict=\{win === null \? null : \{ side: solverSide\(card\), win \}\}\/>/);
  // An invented small edge: White punishes with Bxh8; his move left him (Black) 48%, so White has 52%: "about level".
  const edge: TrainerItem = { id: 'punish-edge', fen: BISHOP, moves: ['b2h8'], rating: 1000, themes: ['personal'], gameUrl: '', source: 'pack', kind: 'punish',
    pack: { pvUci: ['b2h8', 'h1g2'], winAfter: 48, solverColor: 'w' } };
  assert.equal(solverWinAfter(edge), 52);
  assert.equal(summaryAtEnd(BISHOP, ['b2h8', 'h1g2']), 'White wins a rook.');
  assert.equal(summaryAtEnd(BISHOP, ['b2h8', 'h1g2'], { verdict: { side: 'w', win: 52 } }), 'White is a rook up at the end of this line, but the engine rates the position about level.');
  assert.equal(solverWinAfter({ pack: {} }), null, 'no stored figure: no verdict');
});

// ---------------------------------------------------------------- (r) 5: one figure for his game move

test('(r) 5: the stored-numbers intro is left out whenever the try viewer shows figures for his game move, and kept otherwise', () => {
  const mistake = mistakeCard();
  const intro = 'After Qxd8# the engine gives you 100% to win; your game move Qd7 left 0%.';
  const key = tryKey(mistake.id, 0, 'd1d7');
  const live = (tryWin: number, bestWin: number, depth = 12) => tryViewOf(key, MISTAKE_FEN, 'd1d7', [],
    gradeCardTry(mistake, MISTAKE_FEN, 'd1d7', 0, check({ tryUci: 'd1d7', trySan: 'Qd7', replyLine: ['d8d7'], tryWin, bestWin, depth })))!;
  // Figures for his game move on the page: the stored pair, or any live pair (FX2b's 50/84 beside a stored 35/85).
  assert.equal(storedNumbersIntro(mistake, live(50, 84)), undefined);
  assert.equal(storedNumbersIntro(mistake, live(3, 99.8)), undefined);
  // No figures shown for it: a search too shallow to trust, or a near try graded SOFT under (p): the intro stays.
  const shallow = live(3, 99.8, 9);
  assert.equal(shallow.numbers, undefined);
  assert.equal(storedNumbersIntro(mistake, shallow), intro);
  const near = live(97, 99.8);
  assert.deepEqual([near.collapsed, near.numbers], [true, undefined]);
  assert.equal(storedNumbersIntro(mistake, near), intro);
  // Another move, another step or another card: the intro stays.
  const otherMove = tryViewOf(tryKey(mistake.id, 0, 'h2h3'), MISTAKE_FEN, 'h2h3', [],
    gradeCardTry(mistake, MISTAKE_FEN, 'h2h3', 0, check({ tryUci: 'h2h3', trySan: 'h3', replyLine: ['d8d1'], tryWin: 2, bestWin: 99.8 })))!;
  assert.equal(storedNumbersIntro(mistake, otherMove), intro);
  assert.equal(storedNumbersIntro(mistake, { ...live(50, 84), key: tryKey(mistake.id, 2, 'd1d7') }), intro);
  assert.equal(storedNumbersIntro(mistake, { ...live(50, 84), key: tryKey('pack-other', 0, 'd1d7') }), intro);
});
