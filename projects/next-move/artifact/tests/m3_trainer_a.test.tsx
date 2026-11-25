/**
 * M3 C-core stage (a) (brief 9.6): the hint ladder, the three line viewers, the punish framing and lesson, punish
 * curation, no auto-advance on own-game cards, nothing recorded by viewers or replays, exact replays.
 *
 * The page has no DOM test renderer, so a click path through <Trainer> cannot run here (a static render of the
 * Trainer stops at "Loading"). The Trainer is built from the exported helpers and components tested below; the
 * wiring between them is pinned by reading Trainer.tsx, as tests/b2_trainer.test.tsx does.
 *
 * Positions are textbook or invented, each checked with chess.js; the two endgame drills are the page's own
 * textbook drills (data/technical_endgames.json). No owner game data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chess } from 'chess.js';
import {
  advancesAfterCleanSolve, answerLineOf, answerMovesFrom, answerSansFrom, backgroundCheck, checkTryWithin, createTryGate, cutBeforeAnswer, drillTryText,
  engineTryText, gameLineOf, hintBody, hintButton, HINT_LABELS, HintLadder, hintLadderFor, hintMarks, justPlayedAt, lineFromStep,
  hiddenAnswers, MOVE_HINT_DELAY_MS, namesAnyMove, playLine, positionsAlong, punishLead, PunishGameLine, sanAt, SolvedNotes, SolvedViewers, solvingTryLine, storedTryText,
  teachKind, TRY_DEADLINE_MS, TrySlot, tryViewerOptions, type TryView,
} from '../components/Trainer';
import LineViewer, { lineNarration } from '../components/LineViewer';
import { drillTeach, teachDrillIds } from '../lib/endgameTeach';
import { buildPools, type TrainerItem } from '../components/pools';
import type { LoadedPack } from '../components/model';
import { buildHints } from '../src/teach/hints';
import { moveRefOf, narrateLine, sameMove } from '../src/teach/narrate';
import { classifyPunish, punishLesson } from '../src/teach/punish';
import type { TryCheck } from '../src/teach/tryMove';
import type { AnalysisEngine } from '../src/analysis/engine';
import { endgameDrills } from '../lib/endgames';
import { ARTIFACT_DIR } from './b3_paths';

const src = readFileSync(join(ARTIFACT_DIR, 'components/Trainer.tsx'), 'utf8');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
/** The first square each board in `html` draws: a8 for a board facing White, h1 for one facing Black. */
const firstSquares = (html: string) => [...html.matchAll(/<div class="chessboard[^"]*"[^>]*><button type="button" data-square="([a-h][1-8])"/g)].map(m => m[1]);
/** Where a function declared in Trainer.tsx starts and ends (parameter list and body matched by bracket counting). */
function span(name: string): { start: number; end: number } {
  const m = new RegExp(`function ${name}\\(`).exec(src);
  assert.ok(m, `${name} found`);
  let i = m.index + m[0].length, depth = 1;
  for (; depth > 0; i++) depth += src[i] === '(' ? 1 : src[i] === ')' ? -1 : 0;
  i = src.indexOf('{', i);
  for (depth = 1, i++; depth > 0; i++) depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0;
  return { start: m.index, end: i };
}
const body = (name: string) => { const s = span(name); return src.slice(s.start, s.end); };
function after(fen: string, uci: string) {
  const b = new Chess(fen);
  const m = b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return { fen: b.fen(), san: m.san };
}

// ---------------------------------------------------------------- fixtures (invented)

/** A three-ply "bank" line: Nd5 Nxd5 Rxd5. At step 2 the rook only takes back the knight Black just took. */
const TRADE_FEN = '4k3/8/5n2/8/8/2N5/8/3RK3 w - - 0 1';
const bank = (): TrainerItem => ({ id: 'bank-trade', fen: TRADE_FEN, moves: ['c3d5', 'f6d5', 'd1d5'], rating: 1000, themes: ['crushing', 'short'], gameUrl: '', source: 'bank' });

/** His game (White): Re7 leaves the back rank; Black (the solver) plays Rd1+ Re1 Rxe1#. Better was h3. */
const BEFORE = '3r2k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';
function punishCard(winAfter = 2, extra: Record<string, unknown> = {}): TrainerItem {
  const g = after(BEFORE, 'e1e7');
  return {
    id: 'punish-t1', fen: g.fen, moves: ['d8d1'], rating: 1000, themes: ['personal', 'opening'], gameUrl: '', source: 'pack', kind: 'punish',
    pack: { playedSan: g.san, playedUci: 'e1e7', sourceFen: BEFORE, pvUci: ['d8d1', 'e7e1', 'd1e1'], rowId: 't1', winAfter, solverColor: 'b', ...extra },
  };
}
const siblingCard = (): TrainerItem => ({
  id: 'pack-t1', fen: BEFORE, moves: ['h2h3'], rating: 1000, themes: ['personal'], gameUrl: '', source: 'pack', kind: 'mistake',
  pack: { playedSan: 'Re7', playedUci: 'e1e7', pvUci: ['h2h3', 'd8d1', 'e1d1'] },
});

/** A mistake card from his games (White to move): Qxd8+ wins; his game move Qd7 lets the rook take the queen. */
const MISTAKE_FEN = '3r2k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1';
const mistakeCard = (): TrainerItem => ({
  id: 'pack-m1', fen: MISTAKE_FEN, moves: ['d1d8'], rating: 1000, themes: ['personal'], gameUrl: '', source: 'pack', kind: 'mistake',
  pack: { playedSan: 'Qd7', playedUci: 'd1d7', pvUci: ['d1d8'], refutationPvUci: ['d8d7', 'h2h3'], winBefore: 99.6, winAfter: 0.4 },
});

const drill = (id: string): TrainerItem => {
  const d = endgameDrills.find(x => x.id === id);
  assert.ok(d, id);
  return { id: d!.id, fen: d!.fen, moves: [...d!.moves], rating: d!.rating, themes: [...d!.themes], gameUrl: '', source: 'endgame' };
};

test('fixtures are legal, and the punish card is a graded one with a lesson', () => {
  assert.equal(positionsAlong(TRADE_FEN, bank().moves).length, 4);
  assert.equal(positionsAlong(punishCard().fen, punishCard().pack!.pvUci as string[]).length, 4);
  assert.equal(positionsAlong(BEFORE, siblingCard().pack!.pvUci as string[]).length, 4);
  assert.equal(positionsAlong(MISTAKE_FEN, ['d1d7', 'd8d7', 'h2h3']).length, 4);
  assert.equal(classifyPunish(punishCard()), 'punish');
  assert.ok(punishLesson(punishCard(), siblingCard()));
});

// ---------------------------------------------------------------- hint ladder (L3, 9.3, 8.16)

test('hint ladder: built from the answer line at this step; at a later step the previous ply goes in with its position (9.3)', () => {
  const item = bank(), pos = positionsAlong(item.fen, item.moves);
  assert.equal(justPlayedAt(item, 0), undefined, 'no move just played at the start of a bank puzzle');
  assert.deepEqual(justPlayedAt(item, 2), { uci: 'f6d5', san: 'Nxd5', byLearner: false, fenBefore: pos[1] });
  const ladder = hintLadderFor(item, pos[2], 2);
  assert.deepEqual(ladder, buildHints({ fen: pos[2], line: ['d1d5'], themes: item.themes, kind: 'bank', ply: 2, justPlayed: justPlayedAt(item, 2) }));
  // The recapture is never called a win: with the previous ply counted, the knight taken back is no gain.
  for (const h of ladder.slice(0, 2)) assert.doesNotMatch(h.text, /\bwins?\b/, h.text);
  const blind = buildHints({ fen: pos[2], line: ['d1d5'], themes: item.themes, kind: 'bank', ply: 2 });
  assert.match(blind[1].text, /wins it/, 'without the previous ply the same step claims a win (the defect 9.3 fixes)');
  assert.deepEqual(ladder.map(h => h.level), [1, 2, 3, 4]);
  assert.equal(ladder[3].arrow, 'd1d5');
});

test('hint ladder: punish cards name his game move at the start (byLearner, from pack.sourceFen); drills pass the L9 idea', () => {
  const card = punishCard();
  assert.deepEqual(justPlayedAt(card, 0), { uci: 'e1e7', san: 'Re7', byLearner: true, fenBefore: BEFORE });
  const ladder = hintLadderFor(card, card.fen, 0);
  assert.match(ladder[0].text, /^The move just played, Re7, was yours in the game\./);
  assert.equal(ladder[3].arrow, 'd8d1', 'the answer line is pack.pvUci, solver first');
  const kpk = drill('tech-kpk-take-the-opposition');
  const idea = hintLadderFor(kpk, kpk.fen, 0)[0].text;
  assert.ok(idea.length > 20 && !/Look at checks, captures and threats/.test(idea), idea);
  assert.equal(teachKind(kpk), 'endgame');
  assert.equal(teachKind(card), 'punish');
  assert.equal(teachKind(bank()), 'bank');
  assert.equal(teachKind({ ...bank(), source: 'agent' }), 'agent');
  assert.equal(teachKind(mistakeCard()), 'pack');
  assert.equal(teachKind({ ...mistakeCard(), source: 'personal' }), 'pack');
});

test('hint ladder: the button reads "Show a hint", then "Next hint (n of 4)"; the move waits 2 s after level 3; then it is gone', () => {
  const t = 1_000_000;
  assert.deepEqual(hintButton(0, null, t), { label: 'Show a hint', disabled: false });
  assert.deepEqual(hintButton(1, null, t), { label: 'Next hint (2 of 4)', disabled: false });
  assert.deepEqual(hintButton(2, null, t), { label: 'Next hint (3 of 4)', disabled: false });
  assert.equal(MOVE_HINT_DELAY_MS, 2000);
  assert.deepEqual(hintButton(3, t, t), { label: 'Ready in a moment', disabled: true });
  assert.deepEqual(hintButton(3, t, t + 1999), { label: 'Ready in a moment', disabled: true });
  assert.deepEqual(hintButton(3, t, t + 2000), { label: 'Next hint (4 of 4)', disabled: false });
  assert.equal(hintButton(4, t, t + 5000), null, 'all four shown: no button');
  assert.deepEqual([...HINT_LABELS], ['Idea', 'Target', 'Piece', 'Move']);
});

test('hint ladder: every level shown stays listed with its label; the newest square is marked and level 4 is an arrow', () => {
  const card = punishCard();
  const ladder = hintLadderFor(card, card.fen, 0);
  assert.equal(renderToStaticMarkup(<HintLadder hints={ladder} shown={0}/>), '');
  const two = renderToStaticMarkup(<HintLadder hints={ladder} shown={2}/>);
  assert.equal((two.match(/<li class="hint-box">/g) ?? []).length, 2);
  assert.ok(two.indexOf('<strong>Idea:</strong>') < two.indexOf('<strong>Target:</strong>'));
  assert.ok(two.includes(esc(hintBody(ladder[1]))));
  assert.doesNotMatch(two, /Target:<\/strong> Target/, 'the label is not repeated');
  assert.doesNotMatch(two, /Rd1\+/, 'levels 1 and 2 do not name the answer');
  const four = renderToStaticMarkup(<HintLadder hints={ladder} shown={4}/>);
  for (const label of HINT_LABELS) assert.ok(four.includes(`<strong>${label}:</strong>`), label);
  assert.match(four, /<strong>Move:<\/strong> Play Rd1\+\./);
  // Marks follow the newest level: none for the idea, the target square, the piece's square, then the arrow only.
  assert.deepEqual(hintMarks(ladder, 0), {});
  assert.deepEqual(hintMarks(ladder, 1), ladder[0].square ? { hintSquare: ladder[0].square } : {});
  assert.deepEqual(hintMarks(ladder, 2), { hintSquare: 'g1' });
  assert.deepEqual(hintMarks(ladder, 3), { hintSquare: 'd8' });
  assert.deepEqual(hintMarks(ladder, 4), { arrow: 'd8d1' });
  assert.deepEqual(hintMarks(null, 2), {});
  assert.equal(hintBody({ level: 2, text: 'Targets: the king on g8 and the rook on a8.' }), 'The king on g8 and the rook on a8.');
  assert.equal(hintBody({ level: 3, text: 'Use your bishop on c1.' }), 'Use your bishop on c1.');
});

test('hint ladder wiring: counted per press, reset per card and step, old fixed texts gone, marks on the board', () => {
  for (const old of ['Look at forcing moves and loose pieces', 'Start with the kings: which squares', 'Look closely at the piece on', "'Another hint'"]) {
    assert.ok(!src.includes(old), `old hint text still present: ${old}`);
  }
  const show = body('showHint');
  assert.match(show, /hintButton\(shown, shown === 3 \? hintStep\.at : null, Date\.now\(\)\)/);
  assert.match(show, /if \(!button \|\| button\.disabled\) return;/);
  assert.match(show, /setHintStep\(\{ index, shown: shown \+ 1, at: Date\.now\(\) \}\);\s*setHints\(n => n \+ 1\);/, 'each level is one hint in the attempt');
  assert.match(body('startPuzzle'), /setHints\(0\)[^]*setHintStep\(\{ index: 0, shown: 0, at: 0 \}\)/);
  assert.match(src, /const shownNow = active && !complete && hintStep\.index === index \? hintStep\.shown : 0;/, 'a new step starts a new ladder');
  assert.match(src, /useMemo\(\(\) => \(active && shownNow > 0 \? hintLadderFor\(active, fen, index\) : null\)/, 'built once per card and step, only when asked');
  assert.match(src, /hintSquare=\{marks\.hintSquare\} arrow=\{marks\.arrow\}/);
});

// ---------------------------------------------------------------- try viewer (L2, L4, 8.2, 9.1 copy)

test('try text from the engine: the try\'s result only, never the answer; numbers only from a trusted depth', () => {
  const base = { trySan: 'Qd7', tryWin: 0.4, bestWin: 99.6, depth: 12 };
  assert.deepEqual(engineTryText(base, 'w'), { title: "Why Qd7 doesn't work", intro: 'After Qd7 the engine gives White 0% to win; the best move keeps 100%.' });
  assert.deepEqual(engineTryText({ ...base, depth: 0 }, 'b').intro, 'After Qd7 the engine gives Black 0% to win; the best move keeps 100%.', 'depth 0 is a finished position, exact');
  assert.deepEqual(engineTryText({ ...base, depth: 9 }, 'w'), { title: 'What could follow Qd7' }, 'shallow: no numbers, no failure claim');
  // A try about as good as the answer, or strong: no "doesn't work".
  assert.equal(engineTryText({ ...base, tryWin: 80.4, bestWin: 82 }, 'w').title, 'What could follow Qd7');
  assert.equal(engineTryText({ ...base, tryWin: 70, bestWin: 95 }, 'w').title, 'What could follow Qd7');
  assert.equal(engineTryText({ ...base, tryWin: 50, bestWin: 95 }, 'w').title, "Why Qd7 doesn't work");
  assert.equal(engineTryText({ ...base, bestWin: null }, 'w').intro, undefined);
});

test('stored fallback (L4): only a mistake card at its first step, only for his game move, with the stored line after it', () => {
  const card = mistakeCard();
  assert.deepEqual(storedTryText(card, card.fen, 'd1d7', 0), {
    line: ['d1d7', 'd8d7', 'h2h3'], title: "Why Qd7 doesn't work", intro: 'After Qd7 the engine gives White 0% to win; the best move keeps 100%.',
  });
  assert.equal(storedTryText(card, card.fen, 'd1d6', 0), null, 'another try never borrows the game move\'s refutation');
  assert.equal(storedTryText(card, card.fen, 'd1d7', 1), null);
  assert.equal(storedTryText({ ...card, kind: 'punish' }, card.fen, 'd1d7', 0), null, 'on punish cards playedUci belongs to pack.sourceFen');
  assert.equal(storedTryText(bank(), TRADE_FEN, 'c3d5', 0), null);
  const noNumbers = storedTryText({ ...card, pack: { ...card.pack, winBefore: undefined } }, card.fen, 'd1d7', 0)!;
  assert.deepEqual([noNumbers.title, noNumbers.intro], ['What could follow Qd7', undefined]);
});

test('drill tries use the tablebase data in words, never a percentage, never the answer while solving', () => {
  const kpk = drill('tech-kpk-take-the-opposition');
  const e4 = drillTryText(kpk, kpk.fen, 'e3e4', 0)!;
  assert.equal(e4.title, "Why e4 doesn't work");
  assert.match(e4.intro!, /^This only draws\. /);
  assert.equal(e4.line[0], 'e3e4');
  assert.ok(e4.line.length > 2 && positionsAlong(kpk.fen, e4.line).length === e4.line.length + 1, 'the listed line replays');
  const krk = drill('tech-krk-mate-in-two-king-step');
  const ra8 = drillTryText(krk, krk.fen, 'a7a8', 0)!;
  assert.equal(ra8.title, 'What could follow Ra8+', 'a slower mate keeps the goal: no "doesn\'t work"');
  assert.match(ra8.intro!, /^That also mates, but not in two\./);
  for (const t of [e4, ra8, drillTryText(krk, krk.fen, 'a7g7', 0)!]) {
    assert.doesNotMatch(t.intro!, /%/);
    assert.doesNotMatch(t.intro!, /\bKe4\b|\bKg6\b/, 'the answer is not named');
  }
  assert.equal(drillTryText(kpk, kpk.fen, 'e3e5', 0), null, 'an illegal move has no result');
});

test('try slot: "Checking …" while the engine works, then an open viewer of the try and the reply line', () => {
  const card = mistakeCard();
  const checking: TryView = { key: 'k', status: 'checking', trySan: 'Qd7', fenBefore: card.fen, line: [], title: '', answers: answerMovesFrom(card, card.fen, 0) };
  // Fix round 2 (9.11.2 t 1): the answers by identity, each with its SAN at its own step.
  assert.deepEqual(checking.answers, [{ from: 'd1', to: 'd8', piece: 'q', san: 'Qxd8#' }]);
  assert.equal(renderToStaticMarkup(<TrySlot view={checking} solving/>), '<p class="try-check small" role="status">Checking Qd7…</p>');
  const done: TryView = { ...checking, status: 'done', ...storedTryText(card, card.fen, 'd1d7', 0)! };
  const html = renderToStaticMarkup(<TrySlot view={done} solving/>);
  assert.match(html, /<h3 [^>]*class="line-viewer-title">Why Qd7 doesn&#x27;t work<\/h3>/);
  // FX2c (9.11.3 R6-3): the viewer opens on his try (step 1) and asks him to guess the reply; the intro is the caption at
  // the start, one press back (the slot passes it with initialStep 1). It was the step-0 caption on opening before.
  assert.match(html, /<p class="line-viewer-legend">Guess the next move, then press Next\.<\/p>/);
  assert.match(html, /<p class="line-viewer-caption" aria-live="polite"><strong>1\. Qd7<\/strong> /);
  assert.ok(!html.includes(esc(done.intro!)), 'the intro waits at the start');
  assert.match(body('TrySlot'), /intro=\{view\.intro\}\n\s*initialStep=\{1\} verdict=\{verdict\}/);
  assert.doesNotMatch(html, /Qxd8/, 'no answer SAN while solving');
  assert.deepEqual(firstSquares(html), ['a8'], 'faces the solver (White)');
  assert.doesNotMatch(html, /aria-expanded="false"/, 'open after a miss');
  assert.equal(renderToStaticMarkup(<TrySlot view={{ ...done, line: [] }} solving/>), `<p class="try-check small">${esc(done.intro!)}</p>`);
  assert.equal(renderToStaticMarkup(<TrySlot view={null} solving/>), '');
});

test('8.2: while he solves, an open try viewer stops before any later move that is the answer (by identity, 9.11.2 t 1); complete, it is whole', () => {
  // KPK, take the opposition (textbook drill): after 1.e4? the tablebase line has Ke4, the drill's answer (the king from d4
  // to e4), as its fifth move.
  const kpk = drill('tech-kpk-take-the-opposition');
  const e4 = drillTryText(kpk, kpk.fen, 'e3e4', 0)!;
  const answers = answerMovesFrom(kpk, kpk.fen, 0);
  assert.deepEqual(answers, [{ from: 'd4', to: 'e4', piece: 'k', san: 'Ke4' }]);
  assert.deepEqual(answerSansFrom(kpk, kpk.fen, 0), ['Ke4'], 'the SAN list stays for the drill notes');
  const sans = (line: readonly string[]) => { const b = new Chess(kpk.fen); return line.map(u => b.move({ from: u.slice(0, 2), to: u.slice(2, 4) }).san); };
  assert.equal(sans(e4.line)[4], 'Ke4');
  assert.equal(e4.line[4], 'd4e4', 'the same king, from d4 to e4: the answer itself');
  assert.deepEqual(cutBeforeAnswer(kpk.fen, e4.line, answers), e4.line.slice(0, 4));
  const view: TryView = { key: 'k', status: 'done', trySan: 'e4', fenBefore: kpk.fen, ...e4, answers, source: 'tablebase' };
  const labels = (html: string) => [...html.matchAll(/class="line-viewer-move"[^>]*aria-label="([^"]+)"/g)].map(m => m[1].replace(/^\d+\.(\.\.)? /, ''));
  const solving = renderToStaticMarkup(<TrySlot view={view} solving/>), done = renderToStaticMarkup(<TrySlot view={view} solving={false}/>);
  // FX2c: the viewer lists the moves up to the step on the board, then "…" (FX1c's R4-4), and opens on the try (9.11.3
  // R6-3), so its markup lists the try alone. The line it steps through: the cut line while solving, the whole line once
  // the card is complete (before R4-4 the markup listed the whole cut line, and the whole line).
  assert.deepEqual(solvingTryLine(view), e4.line.slice(0, 4));
  assert.match(body('TrySlot'), /useMemo\(\(\) => \(view\?\.status !== 'done' \? \[\] : solving \? solvingTryLine\(view\) : view\.line\), \[view, solving\]\)/);
  for (const html of [solving, done]) {
    assert.deepEqual(labels(html), sans(e4.line.slice(0, 1)));
    assert.match(html, /<li class="line-viewer-more"/, 'more moves follow');
  }
  assert.ok(!labels(solving).includes('Ke4') && !/\bKe4\b/.test(solving), 'nothing names the answer while solving');
  // The try itself always stays (here the answer's own move as the try); no answer, no cut.
  assert.deepEqual(cutBeforeAnswer(kpk.fen, ['d4e4'], answers), ['d4e4']);
  assert.deepEqual(cutBeforeAnswer(kpk.fen, e4.line, []), e4.line);
  // Identity, not the sign: the rook from a8 to b8 is the answer whatever its check sign (Rb8+ here, Rb8# as the answer).
  assert.deepEqual(cutBeforeAnswer('7k/R7/5K2/8/8/8/8/8 w - - 0 1', ['a7a8', 'h8h7', 'a8b8'], [{ from: 'a8', to: 'b8', piece: 'r', san: 'Rb8#' }]), ['a7a8', 'h8h7']);
  assert.equal(namesAnyMove('After e4, Black plays Kd6.', ['Kd6+']), true);
  assert.equal(namesAnyMove('After e4, Black plays Kd6.', ['Kd']), false);
  assert.equal(namesAnyMove('Rxd8 wins.', ['Rd8']), false);
  // Drill notes (free text) still use the SAN list: the try's own name is already on screen.
  assert.deepEqual(hiddenAnswers(['Ke8', 'Kd7', 'Ke8'], 'Ke8+'), ['Kd7']);
  // Invented: 1...Ke8 2.Kd6 Kd8 3.e5 Ke8. The try (the king from e7 to e8) is on screen, so a later answer that is the same
  // move hides nothing; 3...Ke8 (from d8) is another move. A later answer Kd8 (from e8, played as 2...Kd8) cuts there.
  const KINGS = '8/4k3/8/3K4/4P3/8/8/8 b - - 0 1';
  const kings = ['e7e8', 'd5d6', 'e8d8', 'e4e5', 'd8e8'];
  const kd7 = { ...moveRefOf(KINGS, 'e7d7')!, san: 'Kd7' }, ke8 = { ...moveRefOf(KINGS, 'e7e8')!, san: 'Ke8' };
  assert.deepEqual(cutBeforeAnswer(KINGS, kings, [kd7, ke8]), kings);
  assert.deepEqual(cutBeforeAnswer(KINGS, kings, [kd7, { from: 'e8', to: 'd8', piece: 'k', san: 'Kd8' }]), kings.slice(0, 2));
  // 8.2 guard kept from fix 1: a later move of his side printed with the answer's own SAN stops the line too, though it is
  // another piece, and so does a sentence printing it. KQK mate in two, step 2 (textbook drill): after 2.Qf7+? Kh8 the
  // summary would say "White can mate in one: Qg7#" (the queen from f7), and Qg7# (the queen from e7) is the answer: only
  // the try shows.
  const kqk = drill('tech-kqk-mate-in-two-king-step');
  const step2 = drillTeach(kqk.id)!.steps.find(s => s.step === 2)!;
  const qf7 = drillTryText(kqk, step2.fen, 'e7f7', 2)!;
  assert.deepEqual(qf7.line, ['e7f7', 'g8h8', 'f7g7']);
  const kqkAnswers = answerMovesFrom(kqk, step2.fen, 2);
  assert.deepEqual(kqkAnswers, [{ from: 'e7', to: 'g7', piece: 'q', san: 'Qg7#' }]);
  const beforeMate = after(after(step2.fen, 'e7f7').fen, 'g8h8').fen;
  assert.equal(sameMove(beforeMate, 'f7g7', kqkAnswers[0]), false, 'another queen move, by identity');
  assert.match(narrateLine(step2.fen, qf7.line.slice(0, 2)).summary, /mate in one: Qg7#/, 'the sentence the cut must hide');
  assert.deepEqual(cutBeforeAnswer(step2.fen, qf7.line, kqkAnswers, { omit: kqkAnswers[0] }), ['e7f7']);
  // Every listed drill try, read as the viewer reads it while he solves (`tryViewerOptions`): no later move of the shown
  // part is a remaining answer (identity), no move of his side prints an answer's SAN, and no caption, summary or intro
  // names one (the try's own move and name aside).
  let cut = 0, tries = 0;
  for (const id of teachDrillIds()) {
    const item = drill(id);
    for (const step of drillTeach(id)!.steps) {
      for (const t of step.tries) {
        tries++;
        const text = drillTryText(item, step.fen, t.uci, step.step)!;
        const rest = answerMovesFrom(item, step.fen, step.step);
        const hidden = rest.filter(a => !sameMove(step.fen, t.uci, a)), names = hiddenAnswers(rest.map(a => a.san!), t.san);
        const opts = tryViewerOptions({ answers: rest }, true);
        const shown = cutBeforeAnswer(step.fen, text.line, rest, opts);
        if (shown.length < text.line.length) cut++;
        const told = lineNarration(step.fen, shown, undefined, opts);
        assert.equal(told.plies.length, shown.length, `${id} ${t.san}: the shown part replays`);
        for (const p of told.plies.slice(1)) {
          assert.equal(hidden.some(a => sameMove(p.fenBefore, p.uci, a)), false, `${id} ${t.san}: move ${p.san} is an answer`);
          if (p.index % 2 === 0) assert.equal(namesAnyMove(p.san, names), false, `${id} ${t.san}: move ${p.san}`);
        }
        for (const p of told.plies) assert.equal(namesAnyMove(p.text.slice(p.san.length + 1), names), false, `${id} ${t.san}: caption ${p.text}`);
        assert.equal(namesAnyMove(told.summary, names), false, `${id} ${t.san}: summary ${told.summary}`);
        assert.equal(namesAnyMove(text.intro ?? '', hiddenAnswers(answerSansFrom(item, step.fen, step.step), t.san)), false, `${id} ${t.san} intro`);
      }
    }
  }
  // Fix 1 cut 52 of 177 by SAN text; identity with the omitted sentences and the 8.2 guard cuts 45.
  assert.deepEqual({ tries, cut }, { tries: 177, cut: 45 });
});

// A stub engine: answers with a legal first move and a level score (White's view) after `delayMs`, never (`hang`),
// or fails; an abort rejects at once, as the worker engine does.
function stubEngine(o: { delayMs?: number; hang?: boolean; fail?: boolean } = {}): AnalysisEngine & { calls: string[] } {
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
          const m = new Chess(fen).moves({ verbose: true })[0];
          resolve([{ multipv: 1, depth: 12, score: { cp: 0, mate: null }, pv: m ? [`${m.from}${m.to}${m.promotion ?? ''}`] : [] }]);
        }, o.delayMs ?? 1);
      });
    },
  };
}

test('background check: the result reaches the panel only while it is the latest try on this card and step', async () => {
  const card = mistakeCard();
  const gate = createTryGate();
  const got: Array<TryCheck | null> = [];
  await backgroundCheck(gate, stubEngine(), card.fen, 'd1d7', 'd1d8', c => got.push(c));
  assert.equal(got.length, 1);
  assert.equal(got[0]?.tryUci, 'd1d7');
  assert.equal(got[0]?.replyLine[0], new Chess(after(card.fen, 'd1d7').fen).moves({ verbose: true }).map(m => `${m.from}${m.to}`)[0]);
  assert.equal(gate.pending(), false);
  // A newer try: the older check is stopped and its result dropped.
  const slow = stubEngine({ delayMs: 30 });
  const first: unknown[] = [], second: unknown[] = [];
  const p1 = backgroundCheck(gate, slow, card.fen, 'd1d7', 'd1d8', c => first.push(c));
  const p2 = backgroundCheck(gate, slow, card.fen, 'd1d6', 'd1d8', c => second.push(c));
  await Promise.all([p1, p2]);
  assert.deepEqual(first, []);
  assert.equal((second[0] as TryCheck | undefined)?.tryUci, 'd1d6');
  // A new card (or a new step) stops the gate: nothing arrives.
  const dropped: unknown[] = [];
  const p3 = backgroundCheck(gate, stubEngine({ delayMs: 10 }), card.fen, 'd1d7', 'd1d8', c => dropped.push(c));
  gate.stop();
  await p3;
  assert.deepEqual(dropped, []);
});

test('background check: past the deadline, or when the engine fails, the result is null (the caller falls back)', async () => {
  const card = mistakeCard();
  assert.equal(TRY_DEADLINE_MS, 6000);
  const gate = createTryGate();
  const late: unknown[] = [];
  await backgroundCheck(gate, stubEngine({ hang: true }), card.fen, 'd1d7', 'd1d8', c => late.push(c), 30);
  assert.deepEqual(late, [null]);
  const failed: unknown[] = [];
  await backgroundCheck(gate, stubEngine({ fail: true }), card.fen, 'd1d7', 'd1d8', c => failed.push(c));
  assert.deepEqual(failed, [null]);
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(await checkTryWithin(stubEngine(), card.fen, 'd1d7', 'd1d8', stopped.signal), null);
});

test('try wiring: every other move goes through tryOther; drills never reach the engine; the engine is created at the first try that needs it, a question or the warm-up', () => {
  // Stage (c) (Cc, brief 9.1): the error is no longer counted in play() for every kind. play() hands every move that is
  // not the card's move (and not a mate) to tryOther, which grades it (tests/m3_trainer_c.test.tsx covers the grading).
  const play = body('play');
  assert.match(play, /if \(!active \|\| complete \|\| locked\) return;/, 'the board waits while a try is checked');
  assert.match(play, /if \(uci !== active\.moves\[index\] && !alternateMate\) \{[^{}]*tryOther\(active, fen, uci, index\);\s*return;\s*\}/);
  const other = body('tryOther');
  assert.doesNotMatch(other, /getSharedEngine/, 'tryOther never creates the engine itself');
  // FX2c (9.11.3 R2-1): the page stops a running check through `stopCheck` (it was `tryGate.stop()`).
  assert.match(other, /if \(kind === 'endgame'\) \{ stopCheck\(\); settleTry\(key, fenBefore, uci, at, gradeCardTry\(item, fenBefore, uci, at, null\)\); return; \}/, 'drills: the tablebase grade at once');
  assert.ok(other.indexOf("kind === 'endgame'") < other.indexOf('startTryCheck('), 'the drill branch returns before any check starts');
  const start = body('startTryCheck');
  assert.match(start, /const engine = getSharedEngine\(\);/);
  // FX2c (9.11.3 R2-1, the deadline path): the callback first clears `warmed` on a grade with no result, then settles
  // (it read `g => settleLatest.current(key, fenBefore, uci, at, g)`); tests/m3_fix2b_trainer.test.tsx pins the reset.
  assert.match(start, /void gradeAfterCheck\(tryGate, engine, item, fenBefore, uci, at, g => \{[^]*?settleLatest\.current\(key, fenBefore, uci, at, g\);\s*\}\);/,
    'the raw result reaches the grade, and the try view keeps it for the coach input');
  // Stage (b) (Cb): a question after the card checks the moves it names on the same engine; stage (c) (Cc): the first
  // own-game card shown warms it (9.1). Brief section 7: created on the first wrong try or question, never at page load.
  const engineCalls = [...src.matchAll(/getSharedEngine\(\)/g)].map(m => m.index!);
  assert.equal(engineCalls.length, 3, 'three call sites: startTryCheck, questionCheck and warmEngine');
  for (const i of engineCalls) assert.ok(['startTryCheck', 'questionCheck', 'warmEngine'].some(n => { const s = span(n); return i > s.start && i < s.end; }), 'a getSharedEngine() call outside the three');
  assert.doesNotMatch(start, /setErrors|setHints|finish\(|record\(/, 'the check never counts or records anything');
  for (const fn of ['startPuzzle', 'startSafe', 'choose']) assert.match(body(fn), /clearTry\(\)/, `${fn} stops a running check`);
  assert.match(src, /useEffect\(\(\) => \(\) => tryGate\.stop\(\), \[tryGate\]\)/, 'leaving the page stops it');
  // 9.1 identity rule: any step change (a correct move, the last move, a reveal) drops a pending check; a finished line stays.
  // FX2c (9.11.3 R2-1): through `stopCheck` (it was `tryGate.stop()`), which also lets the next own-game card warm again.
  assert.match(body('dropPendingTry'), /if \(!tryGate\.pending\(\)\) return;\s*stopCheck\(\);\s*setTryView\(v => \(v\?\.status === 'checking' \? null : v\)\);/);
  assert.match(play, /setFen\(board\.fen\(\)\); setIndex\(next\);\s*dropPendingTry\(\);\s*if \(alternateMate \|\| next >= active\.moves\.length\)/, 'before the completion branch, so both paths drop it');
  assert.match(body('reveal'), /dropPendingTry\(\);/);
  assert.match(src, /<TrySlot view=\{tryView\} solving=\{!complete\}\/>/);
});

// ---------------------------------------------------------------- punish framing, lesson, viewers (L5, L8, section 7)

test('punish framing while solving (L8): his game move, highlighted, and the side he now plays', () => {
  assert.equal(punishLead(punishCard()), 'In your game you played Re7 (highlighted). Now play Black, your opponent’s side: find the move that makes it cost.');
  const noMove = punishCard(2, { playedSan: undefined, playedUci: undefined });
  assert.equal(punishLead(noMove), 'This is the position after your move in one of your games. Play your opponent’s side and find the move that takes advantage of it.');
  assert.match(src, /startPuzzle[^]*isPunish\(p\) && typeof p\.pack\?\.playedUci === 'string' \? p\.pack\.playedUci/, 'the board highlights his game move');
  assert.match(src, /punish \? punishLead\(active\)/);
});

test('punish line after solving: "In your game you played X. Better was Y." (no sibling: the first sentence only)', () => {
  assert.equal(renderToStaticMarkup(<PunishGameLine item={punishCard()} sibling={siblingCard()}/>), '<p class="punish-game-line"><strong>In your game</strong> you played Re7. Better was h3.</p>');
  assert.equal(renderToStaticMarkup(<PunishGameLine item={punishCard()}/>), '<p class="punish-game-line"><strong>In your game</strong> you played Re7.</p>');
  // A sibling from another position, or one that repeats his move, is not "better".
  assert.equal(renderToStaticMarkup(<PunishGameLine item={punishCard()} sibling={{ ...siblingCard(), fen: TRADE_FEN }}/>), '<p class="punish-game-line"><strong>In your game</strong> you played Re7.</p>');
  assert.doesNotMatch(src, /the engine preferred \$\{detail\.bestSan\}/, 'the opponent\'s reply is no longer labelled as his better move');
});

test('after solving a punish card: the lesson, then "Why Rd1+ works" facing the solver and the game line facing his side', () => {
  const card = punishCard(), sib = siblingCard();
  const notes = renderToStaticMarkup(<SolvedNotes item={card} sibling={sib}/>);
  assert.equal(notes, `<div class="teach-notes"><p>${esc(punishLesson(card, sib)!)}</p></div>`);
  const open = renderToStaticMarkup(<SolvedViewers item={card} sibling={sib} assisted/>);
  const answer = open.indexOf('>Why Rd1+ works</h3>'), game = open.indexOf('>What you could have played in the game</h3>');
  assert.ok(answer > 0 && game > answer, 'both viewers, the answer first');
  assert.deepEqual(firstSquares(open), ['h1', 'a8'], 'answer faces Black (the solver); his game faces White (his side)');
  const [answerHtml, gameHtml] = open.split('<section').slice(1);
  const labels = (html: string) => [...html.matchAll(/class="line-viewer-move"[^>]*aria-label="([^"]+)"/g)].map(m => m[1]);
  // FX2c (FX1c's R4-4): a viewer lists the moves up to the step on the board, then "…". Both open at the start, so no move
  // is listed yet (before R4-4 the markup listed each whole line). The lines they step through, read at their ends:
  for (const html of [answerHtml, gameHtml]) {
    assert.deepEqual(labels(html), []);
    assert.match(html, /<li class="line-viewer-more"/, 'more moves follow');
  }
  assert.match(body('SolvedViewers'), /const line = answerLineOf\(item\);[^]*startFen=\{item\.fen\} line=\{line\}[^]*startFen=\{game\.fen\} line=\{game\.line\}/);
  const atEnd = (fen: string, line: string[]) => renderToStaticMarkup(<LineViewer title="t" startFen={fen} line={line} orientation="w" initialStep={line.length}/>);
  assert.deepEqual(labels(atEnd(card.fen, answerLineOf(card))), ['1... Rd1+', '2. Re1', '2... Rxe1#'], 'the whole answer line (pack.pvUci)');
  assert.deepEqual(labels(atEnd(BEFORE, gameLineOf(card, sib)!.line)), ['1. h3', '1... Rd1', '2. Rxd1'], "the sibling's line from pack.sourceFen");
  assert.deepEqual(gameLineOf(card, sib), { fen: BEFORE, line: ['h2h3', 'd8d1', 'e1d1'] });
  assert.equal(gameLineOf(card, undefined), null);
  // Unaided solve: one press away each, with labels that tell them apart; nothing narrated yet.
  const closed = renderToStaticMarkup(<SolvedViewers item={card} sibling={sib} assisted={false}/>);
  assert.equal(closed, '<div class="teach-viewers"><button type="button" class="secondary line-viewer-toggle" aria-expanded="false">Show why it works</button>'
    + '<button type="button" class="secondary line-viewer-toggle" aria-expanded="false">Show what you could have played</button></div>');
  // Without a sibling only the answer viewer.
  assert.equal((renderToStaticMarkup(<SolvedViewers item={card} assisted/>).match(/<section/g) ?? []).length, 1);
});

test('after solving other kinds: the answer viewer over the whole line; a drill shows its idea; no lesson elsewhere', () => {
  const kpk = drill('tech-kpk-take-the-opposition');
  const idea = renderToStaticMarkup(<SolvedNotes item={kpk}/>);
  assert.match(idea, /^<div class="teach-notes"><p><strong>The idea: <\/strong>[^<]{20,}<\/p><\/div>$/);
  assert.equal(renderToStaticMarkup(<SolvedNotes item={bank()}/>), '');
  // Version 7.1 (brief m31 4.4, item C): after a mistake card whose stored reply line shows a loss, the notes say what
  // his game move allowed (a punish lesson of that move, no figure, no "Better was"). It was '' before 7.1.
  assert.equal(renderToStaticMarkup(<SolvedNotes item={mistakeCard()}/>),
    '<div class="teach-notes"><p class="game-move-words">In your game you played Qd7. That allowed Rxd7, which takes the queen on d7. Black wins the queen.</p></div>');
  const html = renderToStaticMarkup(<SolvedViewers item={bank()} assisted/>);
  assert.match(html, />Why Nd5 works<\/h3>/);
  // FX2c (FX1c's R4-4): open at the start, the viewer lists no move yet, then "…"; it steps through the whole line (read
  // at its end). Before R4-4 the markup listed the whole line at once.
  assert.doesNotMatch(html, /class="line-viewer-move"/);
  assert.match(html, /<li class="line-viewer-more"/);
  assert.deepEqual(answerLineOf(bank()), ['c3d5', 'f6d5', 'd1d5']);
  assert.match(renderToStaticMarkup(<LineViewer title="t" startFen={TRADE_FEN} line={answerLineOf(bank())} orientation="w" initialStep={3}/>),
    /aria-label="1\. Nd5"[^]*aria-label="1\.\.\. Nxd5"[^]*aria-label="2\. Rxd5"/);
  // A mistake card from his games: the whole engine line (pack.pvUci) when it starts with the card's move.
  assert.deepEqual(answerLineOf({ ...mistakeCard(), pack: { pvUci: ['d1d8', 'g8h7'] } }), ['d1d8', 'g8h7']);
  assert.deepEqual(answerLineOf({ ...mistakeCard(), pack: { pvUci: ['d1d7', 'd8d7'] } }), ['d1d8']);
  assert.deepEqual(lineFromStep(bank(), 2), ['d1d5']);
  assert.deepEqual(lineFromStep({ ...bank(), pack: { pvUci: ['c3d5', 'f6d5', 'd1d5', 'e8e7'] } }, 2), ['d1d5', 'e8e7'], 'the longer line while it agrees with the moves played');
  assert.deepEqual(lineFromStep({ ...bank(), pack: { pvUci: ['c3d5', 'e8d7', 'd1d5'] } }, 2), ['d1d5'], 'else the card moves');
});

test('panel wiring: section 7 order, the answer viewer only when complete, the try slot in one place before and after', () => {
  // Stage (c) (Cc, 8.6): the panel is built as named parts that PracticeColumns places by layout (tests/m3_trainer_c
  // renders the placement). The complete branch is the `solved` part, then the `viewers` part; both only when complete.
  const done = src.indexOf('solved: complete ? <>'), actions = src.indexOf('<div className="coach-actions">');
  assert.ok(done > 0, 'the complete branch is found');
  const order = ['<div className="theme-tags">', '<div className="solution">', '<PunishGameLine', '{active.explanation &&', '<SolvedNotes', 'Rehearse this line again', 'viewers: complete ? <SolvedViewers'];
  let at = done;
  for (const piece of order) { const i = src.indexOf(piece, at); assert.ok(i > at, `${piece} in order`); at = i; }
  assert.ok(at < actions, 'all before the controls (complete ? null : coach-actions)');
  assert.match(src, /controls: complete \? null : <div className="coach-actions">/);
  assert.ok(src.indexOf('trySlot: <TrySlot view={tryView} solving={!complete}/>') > actions, 'one try slot, the same part while solving and when complete');
  // Fix round 2 (9.11.2 r 3, r 5): the latest try view goes along for the answer viewer's figure and intro.
  assert.match(src, /<SolvedViewers item=\{active\} sibling=\{sibling\} assisted=\{assisted\} onOpen=\{cancelAdvance\} latest=\{tryView\}\/>/);
  assert.match(src, /const assisted = errors > 0 \|\| hints > 0 \|\| revealed;/);
  assert.match(src, /pools\.byId\.get\(punishSiblingId\(active\) \?\? ''\)/);
});

// ---------------------------------------------------------------- curation (L5, 9.6)

test('curation: only class "punish" is graded; small edges go to the reading list with their sibling; missed wins are not shown', (t) => {
  const p = (id: string, winAfter?: number) => ({ ...punishCard(winAfter), id, pack: { ...punishCard(winAfter).pack, rowId: id } }) as never;
  const pack = {
    version: 'v', meta: {} as LoadedPack['meta'], study: [], punishStudy: [],
    cards: [{ ...siblingCard(), id: 'pack-e1' }, { ...siblingCard(), id: 'pack-m1' }] as never,
    punish: [p('punish-a', 2), p('punish-b', 35), p('punish-c', 0), p('punish-e1', 40), p('punish-e2', 50), p('punish-m1', 51), p('punish-m2', 80), p('punish-n')],
  } as unknown as LoadedPack;
  const pools = buildPools({ bank: [], endgames: [], pack, personal: [], drills: [] });
  const graded = pools.own.filter(c => c.kind === 'punish').map(c => c.id);
  assert.deepEqual(graded, ['punish-a', 'punish-b', 'punish-c', 'punish-n'], 'solver Win% 65 and up, or no stored Win% (served as before)');
  assert.deepEqual(pools.smallEdge.map(c => c.id), ['punish-e1', 'punish-e2']);
  assert.deepEqual(pools.missedWin.map(c => c.id), ['punish-m1', 'punish-m2']);
  for (const held of [...pools.smallEdge, ...pools.missedWin]) {
    assert.equal(pools.byId.has(held.id), false, `${held.id} is not servable`);
    assert.equal(pools.all.some(c => c.id === held.id), false);
    assert.equal(pools.bySource.pack.some(c => c.id === held.id), false);
  }
  assert.deepEqual(pools.punishClasses, { punish: 4, 'small-edge': 2, 'missed-win': 2 });
  t.diagnostic(`punish classes over the invented cards: ${JSON.stringify(pools.punishClasses)}`);
  // The Trainer pairs each small edge with its sibling (pack-<rowId>) once per pool change and passes them to PunishStudy.
  assert.match(src, /pools\.smallEdge\.map\(card => \(\{ card, sibling: pools\.byId\.get\(punishSiblingId\(card\) \?\? ''\) \}\)\), \[pools\]\)/);
  // Version 7.1 (brief m31 4.5, item D): the list also gets the cards held as 'not-unique' (`notUnique`), paired the same way.
  assert.match(src, /pools\.notUnique\.map\(card => \(\{ card, sibling: pools\.byId\.get\(punishSiblingId\(card\) \?\? ''\) \}\)\), \[pools\]\)/);
  assert.match(src, /<PunishStudy items=\{punishStudy\} edges=\{punishEdges\} notUnique=\{punishAlso\}\/>/);
  assert.equal(pools.byId.get('pack-e1')?.id, 'pack-e1', 'the sibling of punish-e1 is found');
});

test('curation keeps the version-6 dedupe: a page-made position equal to a held punish card still gives way', () => {
  const held = punishCard(60);
  const pack = { version: 'v', meta: {} as LoadedPack['meta'], study: [], punishStudy: [], cards: [], punish: [held as never] } as unknown as LoadedPack;
  const pools = buildPools({ bank: [], endgames: [], pack, drills: [], personal: [{ id: 'pack-page-1', fen: held.fen, moves: ['d8d1'], rating: 1000, themes: ['personal'], origin: 'page' as const }] });
  assert.equal(pools.byId.has('pack-page-1'), false);
  // Version 7.1 (brief m31 4.5, item D): and the punish cards the document holds (`notUnique`, `notHeld`).
  assert.match(src, /knownCards=\{\[\.\.\.pools\.own, \.\.\.pools\.smallEdge, \.\.\.pools\.missedWin, \.\.\.pools\.notUnique, \.\.\.pools\.notHeld\]/, 'the PGN import still knows every punish position');
});

// ---------------------------------------------------------------- auto-advance (8.7), one attempt (8.8)

test('no auto-advance after an own-game card, a drill from Claude or an endgame drill; a clean bank puzzle keeps 1.2 s', () => {
  assert.equal(advancesAfterCleanSolve(bank()), true);
  for (const item of [punishCard(), mistakeCard(), { ...mistakeCard(), source: 'personal' as const }, { ...bank(), source: 'agent' as const }, drill('tech-kpk-take-the-opposition')]) {
    assert.equal(advancesAfterCleanSolve(item), false, `${item.id} (${item.source})`);
  }
  assert.equal(advancesAfterCleanSolve(null), false);
  const calls = [...src.matchAll(/(?<!function )scheduleAdvance\(\)/g)].map(m => src.slice(Math.max(0, m.index! - 120), m.index!));
  assert.equal(calls.length, 1, 'one call site');
  // FX2c (9.11.3 R4-3): the call also waits while Claude's answer to his note shows on the card
  // (`movesOnAfterCleanSolve`, tests/m3_fix2b_trainer.test.tsx); it read `advancesAfterCleanSolve(active)`.
  assert.match(calls[0], /if \(clean && !wasRehearsal && tab === 'practice' && movesOnAfterCleanSolve\(active, cardAnswers\)\) $/);
  assert.match(src, /AUTO_ADVANCE_MS = 1200/);
});

test('one attempt per card: viewers, hints, the try check and replays record nothing; a rehearsal stays unrecorded', () => {
  const records = [...src.matchAll(/model\.record\(/g)].map(m => m.index!);
  assert.equal(records.length, 3, 'finish, answerSafe and putBack only');
  const inside = (name: string) => { const s = span(name); return (i: number) => i > s.start && i < s.end; };
  for (const i of records) assert.ok(['finish', 'answerSafe', 'putBack'].some(n => inside(n)(i)), 'a record call outside the three');
  assert.equal(body('putBack'), 'function putBack(item: TrainerItem) { if (model.record(putBackAttempt(item.id, item.source, Date.now()))) setRecordCount(n => n + 1); }');
  const finish = body('finish');
  assert.match(finish, /if \(!active \|\| recorded\.current\) return;\s*recorded\.current = true; setComplete\(true\);/, 'at most once per card');
  assert.match(finish, /if \(rehearsing\.current\) return;/);
  // The M3 helpers and components hold no model, store or attempt state.
  const block = src.slice(src.indexOf('// ---------------------------------------------------------------- M3 stage (a)'), src.indexOf('export default function Trainer'));
  assert.ok(block.length > 2000);
  // (`gate.finish(token)` only releases the try gate; the Trainer's finish() takes no token.)
  for (const banned of [/model\./, /\brecord\(/, /(?<![.\w])finish\((?:\)|true|false)/, /setHints|setErrors|setComplete/, /store\./]) assert.doesNotMatch(block, banned);
  const viewer = readFileSync(join(ARTIFACT_DIR, 'components/LineViewer.tsx'), 'utf8');
  assert.doesNotMatch(viewer, /from '\.\/model'|contract\/store|\.record\(/, 'the viewer cannot record');
  // Opening a collapsed viewer only stops the auto-advance.
  assert.match(src, /onOpen=\{cancelAdvance\}/);
});

// ---------------------------------------------------------------- exact replays (8.9)

test('exact replays on the practice board: castling, en passant, underpromotion, Black to move', () => {
  const castle = playLine('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', ['e1g1', 'e8c8']);
  assert.deepEqual(castle, { fen: '2kr3r/8/8/8/8/8/8/R4RK1 w - - 2 2', last: 'e8c8', played: 2 });
  const ep = playLine('7k/8/8/3pP3/8/8/8/K7 w - d6 0 1', ['e5d6']);
  assert.equal(ep.fen.split(' ')[0], '7k/8/3P4/8/8/8/8/K7', 'the d5 pawn is gone');
  const under = playLine('7k/8/8/8/8/8/p7/7K b - - 0 1', ['a2a1r', 'h1h2']);
  assert.equal(under.fen.split(' ')[0], '7k/8/8/8/8/8/7K/r7');
  assert.deepEqual(playLine('7k/8/8/8/8/8/p7/7K b - - 0 1', ['a2a1r', 'h1h1', 'h8g8']), { ...playLine('7k/8/8/8/8/8/p7/7K b - - 0 1', ['a2a1r']), played: 1 }, 'stops before an illegal move');
  assert.match(body('reveal'), /playLine\(fen, active\.moves\.slice\(index\)\)/, '"Reveal solution" uses it');
  assert.equal(sanAt('7k/8/8/8/8/8/p7/7K b - - 0 1', 'a2a1n'), 'a1=N');
  assert.equal(sanAt('7k/8/8/8/8/8/p7/7K b - - 0 1', 'a2a3'), '');
});

test('exact replays in the answer viewer: a Black card with underpromotion, both castlings and en passant', () => {
  // Invented: 1...a1=N 2.O-O O-O-O 3.b4 cxb3 (en passant).
  const fen = 'r3k3/8/8/8/2p5/8/pP6/4K2R b Kq - 0 1';
  const line = ['a2a1n', 'e1g1', 'e8c8', 'b2b4', 'c4b3'];
  const sans: string[] = [];
  const b = new Chess(fen);
  for (const uci of line) sans.push(b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
  assert.deepEqual(sans, ['a1=N', 'O-O', 'O-O-O', 'b4', 'cxb3']);
  assert.equal(b.fen().split(' ')[0], '2kr4/8/8/8/8/1p6/8/n4RK1');
  const item: TrainerItem = { id: 'agent-replay', fen, moves: line, rating: 1000, themes: ['promotion'], gameUrl: '', source: 'agent' };
  const html = renderToStaticMarkup(<SolvedViewers item={item} assisted/>);
  assert.match(html, />Why a1=N works<\/h3>/);
  assert.deepEqual(firstSquares(html), ['h1'], 'faces Black');
  // FX2c (FX1c's R4-4): the viewer opens at the start and lists no move yet; at the end of the line it lists every move.
  const labelsIn = (h: string) => [...h.matchAll(/class="line-viewer-move"[^>]*aria-label="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(labelsIn(html), []);
  assert.deepEqual(answerLineOf(item), line, 'the viewer steps through the card line');
  const labels = labelsIn(renderToStaticMarkup(<LineViewer title="t" startFen={fen} line={answerLineOf(item)} orientation="b" initialStep={line.length}/>));
  assert.deepEqual(labels, ['1... a1=N', '2. O-O', '2... O-O-O', '3. b4', '3... cxb3'], 'every move replays, numbered from the card');
  assert.deepEqual(positionsAlong(fen, line).map(f => f.split(' ')[0]).at(-1), '2kr4/8/8/8/8/1p6/8/n4RK1');
});
