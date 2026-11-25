import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chess, type Square } from 'chess.js';
import LineViewer, { hasFirstMove, keyAction, legendFor, lineNarration, matchingNarration, moveLabel, resolveOpen, resolveStep, sentenceAfterMove, stepAfter } from '../components/LineViewer';
import { squareCentre } from '../components/Chessboard';
import { buildSteps } from '../src/teach/stepper';
import { narrateLine, type NarratedLine } from '../src/teach/narrate';
import { ARTIFACT_DIR } from './b3_paths';

// M3 L2 line viewer. Textbook positions only: Scholar's mate, the Ruy Lopez main line, a lone pawn promoting,
// and a knight shuffle from the start position. Expected sentences come from the narrator, never typed here.
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6 4.Qxf7#. */
const SCHOLAR = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
/** Black to move after 1.e4 e5 2.Nf3. */
const AFTER_NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
/** 2...Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7 6.Re1 b5 7.Bb3 d6 8.c3 O-O: 13 plies, both castlings. */
const RUY = ['b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7', 'f1e1', 'b7b5', 'a4b3', 'd7d6', 'c2c3', 'e8g8'];
const PROMO = '8/P7/8/8/8/8/8/k6K w - - 0 1';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(m => ({ tag: m[1], inner: m[2] }));
const squares = (html: string) => buttons(html).filter(b => attr(b.tag, 'data-square'));
const lastSquares = (html: string) => squares(html).filter(b => (attr(b.tag, 'class') ?? '').split(/\s+/).includes('last')).map(b => attr(b.tag, 'data-square')!).sort();
/** Accessible name: aria-label, else the text with aria-hidden parts removed. */
const nameOf = (b: { tag: string; inner: string }) => attr(b.tag, 'aria-label') ?? b.inner.replace(/<svg\b[^>]*aria-hidden="true"[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
const controls = (html: string) => {
  const group = /<div class="line-viewer-controls" role="group" aria-label="Step through the line">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  return buttons(group).map(b => ({ name: nameOf(b), off: attr(b.tag, 'aria-disabled') === 'true', type: attr(b.tag, 'type'), inner: b.inner }));
};
const moveButtons = (html: string) => buttons(html).filter(b => attr(b.tag, 'class') === 'line-viewer-move')
  .map(b => ({ name: nameOf(b), text: b.inner, current: attr(b.tag, 'aria-current') ?? null }));
const caption = (html: string) => /<p class="line-viewer-caption" aria-live="polite">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? null;
const summaryOf = (html: string) => /<p class="line-viewer-summary">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? null;
/** The caption the viewer must show after ply k of a narration: the numbered move in bold, then the sentence. */
const captionFor = (n: NarratedLine, k: number) => {
  const p = n.plies[k - 1];
  return `<strong>${esc(moveLabel(p.fenBefore, p.san))}</strong> ${esc(sentenceAfterMove(p.text, p.san))}`;
};
const arrowOf = (html: string) => {
  const m = /<svg class="board-arrow"[\s\S]*?<line x1="([-\d.e]+)" y1="([-\d.e]+)" x2="([-\d.e]+)" y2="([-\d.e]+)"/.exec(html);
  return m ? { x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) } : null;
};
/** The arrow starts on the centre of the from-square and points at the to-square. */
function assertArrow(html: string, uci: string, orientation: 'w' | 'b') {
  const a = arrowOf(html);
  assert.ok(a, `an arrow for ${uci}`);
  const from = squareCentre(uci.slice(0, 2), orientation), to = squareCentre(uci.slice(2, 4), orientation);
  assert.ok(Math.abs(a.x1 - from.x) < 1e-9 && Math.abs(a.y1 - from.y) < 1e-9, `${uci} starts on ${uci.slice(0, 2)}`);
  assert.ok(Math.abs((a.x2 - from.x) * (to.y - from.y) - (a.y2 - from.y) * (to.x - from.x)) < 1e-9, `${uci} points at ${uci.slice(2, 4)}`);
  const along = Math.hypot(a.x2 - from.x, a.y2 - from.y) / Math.hypot(to.x - from.x, to.y - from.y);
  assert.ok(along > 0.5 && along <= 1, `${uci} reaches toward ${uci.slice(2, 4)}`);
}
/** Every square of the rendered board holds what chess.js says the position holds, and none takes a move. */
function assertBoard(html: string, fen: string) {
  const board = new Chess(fen), names: Record<string, string> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
  const shown = squares(html);
  assert.equal(shown.length, 64);
  for (const b of shown) {
    const sq = attr(b.tag, 'data-square') as Square, piece = board.get(sq);
    assert.equal(attr(b.tag, 'aria-label'), `${sq}${piece ? ` ${piece.color === 'w' ? 'white' : 'black'} ${names[piece.type]}` : ' empty'}`);
    assert.ok(/\sdisabled=""/.test(b.tag), `${sq} is not playable`);
  }
}
const fenAfter = (fen: string, line: readonly string[], plies: number) => {
  const board = new Chess(fen);
  for (const uci of line.slice(0, plies)) board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return board.fen();
};

const narrated = narrateLine(START, SCHOLAR);
/** FX1 (brief 9.9.2 b): the captions the viewer shows for this line. 3...Nf6 allows Qxf7#, so the viewer narrates the
 *  line itself without naming the mate ("..., but it allows mate in one."); every other caption equals `narrated`'s. */
const shown = narrateLine(START, SCHOLAR, { nameMate: false });
const scholar = (props: Partial<Parameters<typeof LineViewer>[0]> = {}) =>
  renderToStaticMarkup(<LineViewer title="Why Qxf7# works" startFen={START} line={SCHOLAR} orientation="w" narrated={narrated} {...props}/>);

test('the narrator covers the textbook line, one sentence per move starting with the move (fixture check)', () => {
  assert.equal(narrated.plies.length, SCHOLAR.length);
  assert.equal(narrated.stoppedAt, undefined);
  for (const p of narrated.plies) {
    assert.ok(p.text.startsWith(`${p.san} `), `ply ${p.index}: "${p.text}"`);
    assert.ok(sentenceAfterMove(p.text, p.san).length > 0);
  }
  assert.equal(narrated.result, 'mate');
  assert.ok(narrated.summary.length > 0);
});

test('step 0: the start position, nothing highlighted, no arrow, the intro as the caption; Start and Back inactive', () => {
  const html = scholar({ intro: 'Watch the queen and the bishop aim at f7.' });
  const id = /^<section class="line-viewer" aria-labelledby="([^"]+)">/.exec(html)?.[1];
  assert.ok(id, 'a labelled section');
  assert.match(html, new RegExp(`<h3 id="${re(id)}" class="line-viewer-title">Why Qxf7# works</h3>`));
  assertBoard(html, START);
  assert.deepEqual(lastSquares(html), []);
  // Brief 8.15 / 9.4: nothing previews the first move (it used to be drawn as an arrow here).
  assert.equal(arrowOf(html), null, 'no arrow before the first move');
  assert.equal(caption(html), esc('Watch the queen and the bishop aim at f7.'));
  // FX1c (brief 9.11.3, R4-4 and R6-3): the title often names the first move, so step 0 only says how to step (it used
  // to read "Guess the first move, then press Next.").
  assert.match(html, /<p class="line-viewer-legend">Press Next to step through the line\.<\/p>/);
  assert.deepEqual(controls(html).map(c => [c.name, c.off]), [['Start', true], ['Back', true], ['Next', false], ['End', false]]);
  assert.doesNotMatch(html, /aria-current=/, 'no move is current before the first move');
  assert.equal(summaryOf(html), null);
});

test('step 0 without an intro says whose move it is; the line under the board says how to step (FX1c: no guess at step 0)', () => {
  assert.equal(caption(scholar()), 'White to move.');
  const black = renderToStaticMarkup(<LineViewer title="t" startFen={AFTER_NF3} line={RUY} orientation="b"/>);
  assert.equal(caption(black), 'Black to move.');
  assert.equal(arrowOf(black), null);
  assert.match(black, /<p class="line-viewer-legend">Press Next to step through the line\.<\/p>/);
});

test('each later step: the board after that move, the move as lastMove and as the arrow, its narrated sentence as the caption', () => {
  for (let k = 1; k < SCHOLAR.length; k++) {
    const html = scholar({ initialStep: k });
    assertBoard(html, fenAfter(START, SCHOLAR, k));
    const played = SCHOLAR[k - 1];
    assert.deepEqual(lastSquares(html), [played.slice(0, 2), played.slice(2, 4)].sort(), `step ${k} highlights ${played}`);
    // Brief 8.15 / 9.4: the arrow is the move just played (it used to be the next move, SCHOLAR[k]).
    assertArrow(html, played, 'w');
    assert.match(html, /<p class="line-viewer-legend">Guess the next move, then press Next\.<\/p>/);
    // FX1 (9.9.2 b): `shown`, not `narrated`: at step 6 the caption no longer names Qxf7#, the next move.
    assert.equal(caption(html), captionFor(shown, k));
    const current = moveButtons(html).filter(b => b.current !== null);
    assert.equal(current.length, 1, `step ${k}: one current move`);
    assert.equal(current[0].current, 'step');
    assert.equal(current[0].name, moveLabel(narrated.plies[k - 1].fenBefore, narrated.plies[k - 1].san));
    assert.equal(summaryOf(html), null, 'the summary waits for the end');
    assert.deepEqual(controls(html).map(c => c.off), [false, false, false, false]);
  }
  // The bold move is not repeated by the sentence: "4. Qxf7# takes ...", not "4. Qxf7# Qxf7# takes ...".
  assert.doesNotMatch(caption(scholar({ initialStep: 7 }))!, /<\/strong> Qxf7#/);
});

test('the last step: the last move as the arrow, "End of the line", the line summary; Next and End inactive; a step past the end is clamped', () => {
  for (const initialStep of [SCHOLAR.length, 99]) {
    const html = scholar({ initialStep });
    assertBoard(html, fenAfter(START, SCHOLAR, SCHOLAR.length));
    // Brief 8.15 / 9.4: the move just played keeps its arrow at the end (there used to be none).
    assertArrow(html, 'h5f7', 'w');
    assert.deepEqual(lastSquares(html), ['f7', 'h5']);
    assert.match(html, /<p class="line-viewer-legend">End of the line\.<\/p>/);
    assert.equal(summaryOf(html), esc(narrated.summary));
    assert.deepEqual(controls(html).map(c => [c.name, c.off]), [['Start', false], ['Back', false], ['Next', true], ['End', true]]);
    assert.equal(moveButtons(html).at(-1)?.current, 'step');
  }
  assert.equal(caption(scholar({ initialStep: -3 })), 'White to move.', 'a negative step is the start');
});

test('Black to move, board from Black\'s side: moves numbered from the FEN, every move its own button, so a long line wraps', () => {
  const html = renderToStaticMarkup(<LineViewer title="The main line" startFen={AFTER_NF3} line={RUY} orientation="b" initialStep={2}/>);
  assert.equal(attr(squares(html)[0].tag, 'data-square'), 'h1', 'Black\'s side: h1 is drawn first');
  // FX1c (brief 9.11.3, R4-4): the list shows the moves up to the step on the board, then "…" (it used to list all 13
  // at every step). The whole list is checked at the last step below.
  const moves = moveButtons(html);
  assert.equal(moves.length, 2);
  assert.deepEqual(moves.map(m => m.name), ['2... Nc6', '3. Bb5']);
  assert.deepEqual(moves.map(m => m.current), [null, 'step']);
  assert.match(html, /<li class="line-viewer-more"[^>]*><span aria-hidden="true">…<\/span><span class="sr-only">More moves follow\.<\/span><\/li><\/ol>/);
  const whole = moveButtons(renderToStaticMarkup(<LineViewer title="The main line" startFen={AFTER_NF3} line={RUY} orientation="b" initialStep={RUY.length}/>));
  assert.deepEqual(whole.map(m => m.name), ['2... Nc6', '3. Bb5', '3... a6', '4. Ba4', '4... Nf6', '5. O-O', '5... Be7', '6. Re1', '6... b5', '7. Bb3', '7... d6', '8. c3', '8... O-O']);
  assert.deepEqual(whole.map(m => m.text), ['2... Nc6', '3. Bb5', 'a6', '4. Ba4', 'Nf6', '5. O-O', 'Be7', '6. Re1', 'b5', '7. Bb3', 'd6', '8. c3', 'O-O']);
  for (const m of whole) assert.ok(m.name.endsWith(m.text), `the name "${m.name}" contains what is shown`);
  assert.deepEqual(whole.map(m => m.current), [...Array(12).fill(null), 'step']);
  assertBoard(html, fenAfter(AFTER_NF3, RUY, 2));
  // Brief 8.15 / 9.4: the arrow is move 2, 3.Bb5, just played (it used to be the next move, 3...a6).
  assertArrow(html, 'f1b5', 'b');
  assert.equal(caption(html), captionFor(narrateLine(AFTER_NF3, RUY), 2), 'no narration passed: the viewer narrates the line itself');
  const castled = renderToStaticMarkup(<LineViewer title="t" startFen={AFTER_NF3} line={RUY} orientation="b" initialStep={6}/>);
  assert.deepEqual(lastSquares(castled), ['e1', 'g1'], 'castling highlights the king\'s move');
  assertArrow(castled, 'e1g1', 'b');
  const end = renderToStaticMarkup(<LineViewer title="t" startFen={AFTER_NF3} line={RUY} orientation="b" initialStep={RUY.length}/>);
  assert.match(end, /<ol class="line-viewer-moves" role="list" aria-label="Moves in the line">(<li><button [^>]*>[^<]+<\/button><\/li>){13}<\/ol>/);
  assert.doesNotMatch(end, /line-viewer-more/, 'no "…" once every move is shown');
});

test('a narration made for another line or another position is never shown: the viewer narrates the line it shows', () => {
  const tampered = { ...narrated, plies: narrated.plies.map((p, i) => i === 3 ? { ...p, uci: 'g8f6', text: 'Not this sentence.' } : p), summary: 'Not this summary.' };
  for (const wrong of [narrateLine(START, ['d2d4', 'd7d5']), narrateLine(AFTER_NF3, RUY), tampered]) {
    assert.equal(matchingNarration(START, SCHOLAR, wrong), undefined);
    // FX1 (9.9.2 b): the viewer's own narration is `shown` (no mating move named at step 6).
    for (let k = 1; k <= SCHOLAR.length; k++) assert.equal(caption(scholar({ narrated: wrong, initialStep: k })), captionFor(shown, k));
    assert.equal(summaryOf(scholar({ narrated: wrong, initialStep: 99 })), esc(narrated.summary));
  }
  const counters = START.replace(/ 0 1$/, ' 4 9');
  assert.equal(matchingNarration(counters, SCHOLAR, narrated), narrated, 'the same position with other move counters');
  assert.equal(matchingNarration(START, SCHOLAR, undefined), undefined);
});

test('a matching narration passed in is used as given', () => {
  // FX1 (9.9.2 b): on a line where no move allows mate in one (the Ruy Lopez; Scholar's mate has 3...Nf6, whose
  // default sentence names Qxf7#, so a narration of it is no longer used as given: tests/m3_fix1_modules.test.tsx).
  const ruy = narrateLine(AFTER_NF3, RUY);
  assert.ok(ruy.plies.every(p => !p.facts.allowsMate), 'fixture: no move of this line allows mate in one');
  const own = { ...ruy, plies: ruy.plies.map(p => ({ ...p, text: `${p.san} is move ${p.index + 1} of the given narration.` })), summary: 'The given summary.' };
  assert.equal(lineNarration(AFTER_NF3, RUY, own), own);
  const ruyViewer = (initialStep: number) => renderToStaticMarkup(<LineViewer title="t" startFen={AFTER_NF3} line={RUY} orientation="b" narrated={own} initialStep={initialStep}/>);
  assert.equal(caption(ruyViewer(2)), '<strong>3. Bb5</strong> is move 2 of the given narration.');
  assert.equal(summaryOf(ruyViewer(RUY.length)), 'The given summary.');
});

test('a narration of part of the line is replaced by one of the whole line, so the summary is about the line shown', () => {
  const short = narrateLine(START, SCHOLAR, { maxPlies: 4 });
  assert.equal(short.plies.length, 4);
  assert.equal(matchingNarration(START, SCHOLAR, short), short);
  assert.notEqual(lineNarration(START, SCHOLAR, short), short);
  assert.equal(summaryOf(scholar({ narrated: short, initialStep: 99 })), esc(narrated.summary));
  assert.notEqual(short.summary, narrated.summary, 'the first four moves end differently from the whole line');
  // FX1 (9.9.2 b): the whole-line narration the viewer makes is `shown` (step 6 no longer names Qxf7#).
  assert.equal(caption(scholar({ narrated: short, initialStep: 6 })), captionFor(shown, 6));
});

test('a line that breaks stops before the illegal move; nothing renders without a readable position or a legal first move', () => {
  const broken = ['e2e4', 'e7e5', 'e4e5', 'g1f3'];
  const html = renderToStaticMarkup(<LineViewer title="t" startFen={START} line={broken} orientation="w" initialStep={9}/>);
  assert.equal(moveButtons(html).length, 2);
  assertBoard(html, fenAfter(START, broken, 2));
  // Brief 8.15 / 9.4: the arrow is the last legal move, 1...e5 (there used to be none); never the illegal one.
  assertArrow(html, 'e7e5', 'w');
  assert.match(html, /End of the line\./);
  const n = narrateLine(START, broken);
  assert.equal(n.stoppedAt, 2);
  // FX1b (brief 9.11.2 (r) 4): the narrator still closes this line with "No material changes hands." (the default),
  // and the viewer leaves that one sentence out, so there is no summary paragraph here.
  assert.equal(n.summary, 'No material changes hands.');
  assert.equal(summaryOf(html), null, 'the viewer leaves out the no-change sentence');
  for (const props of [{ line: [] as string[] }, { line: ['e2e5'] }, { line: ['zz'] }, { startFen: 'not a fen' }, { startFen: '' }]) {
    assert.equal(renderToStaticMarkup(<LineViewer title="t" startFen={START} line={SCHOLAR} orientation="w" {...props}/>), '', JSON.stringify(props));
  }
});

test('past the narrator\'s limit a step names its move only, and no summary is shown for a line only partly narrated', () => {
  const shuffle = Array.from({ length: 17 }, () => ['g1f3', 'g8f6', 'f3g1', 'f6g8']).flat();
  const n = narrateLine(START, shuffle, { maxPlies: shuffle.length });
  assert.ok(n.plies.length < shuffle.length, `the narrator stops at ${n.plies.length} of ${shuffle.length}`);
  const html = renderToStaticMarkup(<LineViewer title="t" startFen={START} line={shuffle} orientation="w" initialStep={shuffle.length}/>);
  assert.equal(moveButtons(html).length, shuffle.length);
  assert.equal(caption(html), `<strong>${esc(moveLabel(fenAfter(START, shuffle, shuffle.length - 1), 'Ng8'))}</strong>`);
  assert.equal(summaryOf(html), null);
  const inside = renderToStaticMarkup(<LineViewer title="t" startFen={START} line={shuffle} orientation="w" initialStep={n.plies.length}/>);
  assert.equal(caption(inside), captionFor(n, n.plies.length));
});

test('promotion: no arrow before the move; after it, the five-character move is drawn as an arrow and highlighted', () => {
  const n = narrateLine(PROMO, ['a7a8q']);
  assert.equal(n.plies[0].san, 'a8=Q+');
  const before = renderToStaticMarkup(<LineViewer title="t" startFen={PROMO} line={['a7a8q']} orientation="w"/>);
  // Brief 8.15 / 9.4: the promotion is not previewed (it used to be drawn as an arrow at step 0).
  assert.equal(arrowOf(before), null);
  const after = renderToStaticMarkup(<LineViewer title="t" startFen={PROMO} line={['a7a8q']} orientation="w" initialStep={1}/>);
  assertArrow(after, 'a7a8q', 'w');
  assert.deepEqual(lastSquares(after), ['a7', 'a8']);
  assert.match(after, /aria-label="a8 white queen"/);
  assert.equal(caption(after), captionFor(n, 1));
  assert.equal(summaryOf(after), esc(n.summary));
});

test('controls and moves are real buttons with accessible names; icons are hidden; the caption is announced; compact adds its class', () => {
  const html = scholar({ initialStep: 3, compact: true });
  assert.match(html, /^<section class="line-viewer line-viewer-compact" /);
  const cs = controls(html);
  assert.deepEqual(cs.map(c => c.name), ['Start', 'Back', 'Next', 'End']);
  for (const c of cs) {
    assert.equal(c.type, 'button');
    assert.match(c.inner, /^<svg[^>]*aria-hidden="true"/, `${c.name}: the icon is decoration`);
    assert.ok(c.inner.endsWith(`<span>${c.name}</span>`), `${c.name}: the word is visible`);
  }
  const others = buttons(html).filter(b => !attr(b.tag, 'data-square'));
  // FX1c (R4-4): at step 3 the list holds the first three moves (it used to hold all seven).
  assert.equal(others.length, 4 + 3);
  for (const b of others) {
    assert.equal(attr(b.tag, 'type'), 'button');
    assert.ok(nameOf(b).length > 0, `a name for ${b.tag}`);
    assert.doesNotMatch(b.tag, /\sdisabled=""/, 'controls stay focusable at the ends (aria-disabled)');
  }
  assert.match(html, /<p class="line-viewer-caption" aria-live="polite">/);
  assert.doesNotMatch(scholar(), /line-viewer-compact/);
});

test('two viewers on one page get their own heading ids', () => {
  const html = renderToStaticMarkup(<>
    <LineViewer title="Why e4 works" startFen={START} line={['e2e4']} orientation="w"/>
    <LineViewer title="What you could have played" startFen={START} line={['d2d4']} orientation="w"/>
  </>);
  const ids = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.equal((html.match(new RegExp(` id="${re(id)}"`, 'g')) ?? []).length, 1);
});

test('stepping, keys, labels, the sentence after the move, and the reset when the line changes (pure helpers)', () => {
  const steps = buildSteps(START, SCHOLAR);
  assert.equal(steps.length, SCHOLAR.length + 1);
  const last = SCHOLAR.length;
  assert.equal(stepAfter('next', 0, steps), 1);
  assert.equal(stepAfter('back', 0, steps), 0);
  assert.equal(stepAfter('back', 4, steps), 3);
  assert.equal(stepAfter('next', last, steps), last);
  assert.equal(stepAfter('end', 2, steps), last);
  assert.equal(stepAfter('start', 5, steps), 0);
  assert.equal(stepAfter(3, 0, steps), 3);
  assert.equal(stepAfter(99, 0, steps), last);
  assert.equal(stepAfter(-4, 3, steps), 0);
  assert.equal(stepAfter(Number.NaN, 3, steps), 0);
  assert.deepEqual(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'a'].map(keyAction), ['back', 'next', 'start', 'end', null, null, null]);
  assert.equal(moveLabel(START, 'e4'), '1. e4');
  assert.equal(moveLabel(AFTER_NF3, 'Nc6'), '2... Nc6');
  assert.equal(moveLabel('7k/8/8/8/8/8/8/K7 b - -', 'Kg8'), '1... Kg8', 'no move counters: numbered 1');
  assert.equal(sentenceAfterMove('Bxh7+ takes the pawn on h7 with check.', 'Bxh7+'), 'takes the pawn on h7 with check.');
  assert.equal(sentenceAfterMove('The bishop takes on h7.', 'Bxh7+'), 'The bishop takes on h7.', 'another form is kept whole');
  assert.equal(sentenceAfterMove('Bxh7 takes the pawn.', 'Bxh7+'), 'Bxh7 takes the pawn.', 'only the exact move is dropped');
  assert.equal(resolveStep({ key: 'a', step: 5 }, 'a', 0, steps), 5, 'same line: the step he moved to');
  assert.equal(resolveStep({ key: 'a', step: 5 }, 'b', 2, steps), 2, 'a new line starts at the requested step');
  assert.equal(resolveStep({ key: 'a', step: 5 }, 'b', undefined, steps), 0);
  assert.equal(resolveStep({ key: 'b', step: 50 }, 'b', 0, steps), last, 'clamped');
});

// F3 (brief 8.15 and 9.4): no preview arrow; the arrow is the move just played; a viewer can start collapsed.
test('the arrow is always the move just played, on the highlighted squares: every step of a line with both castlings, from Black\'s side', () => {
  for (let k = 0; k <= RUY.length; k++) {
    const html = renderToStaticMarkup(<LineViewer title="t" startFen={AFTER_NF3} line={RUY} orientation="b" initialStep={k}/>);
    if (k === 0) {
      assert.equal(arrowOf(html), null, 'step 0: no arrow');
      assert.deepEqual(lastSquares(html), []);
      continue;
    }
    const played = RUY[k - 1];
    assert.equal((html.match(/<svg class="board-arrow"/g) ?? []).length, 1, `step ${k}: one arrow`);
    assertArrow(html, played, 'b');
    assert.deepEqual(lastSquares(html), [played.slice(0, 2), played.slice(2, 4)].sort(), `step ${k}: the arrow and the highlight are the same move`);
  }
});

test('collapsed (defaultOpen false): only a button with the label, announced as collapsed; no board and no narration until it is pressed', () => {
  const collapsed = scholar({ defaultOpen: false });
  assert.equal(collapsed, '<button type="button" class="secondary line-viewer-toggle" aria-expanded="false">Show the line</button>');
  assert.equal(scholar({ defaultOpen: false, toggleLabel: 'Show why it works' }),
    '<button type="button" class="secondary line-viewer-toggle" aria-expanded="false">Show why it works</button>');
  assert.equal(scholar({ defaultOpen: true }), scholar(), 'defaultOpen true is the default: open at once, unchanged markup');
  assert.doesNotMatch(scholar(), /line-viewer-toggle|aria-expanded|tabindex/, 'an open viewer has no toggle and keeps its markup');
  // A narration that throws when read: the collapsed viewer never reads it (it narrates nothing), the open one does.
  const trap = new Proxy({} as NarratedLine, { get() { throw new Error('narration read'); } });
  assert.equal(scholar({ defaultOpen: false, narrated: trap }), collapsed);
  assert.throws(() => scholar({ narrated: trap }), /narration read/, 'the trap does catch a viewer that narrates');
  // onOpen belongs to the press: rendering never calls it, open or collapsed.
  let calls = 0;
  const onOpen = () => { calls++; };
  scholar({ defaultOpen: false, onOpen });
  scholar({ onOpen });
  assert.equal(calls, 0);
});

test('collapsed or open, the viewer renders nothing for the same inputs: no readable position or no legal first move', () => {
  const CASTLE = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  const cases: Array<[string, string[], boolean]> = [
    [START, SCHOLAR, true], [START, [], false], [START, ['e2e5'], false], [START, ['zz'], false],
    ['not a fen', SCHOLAR, false], ['', SCHOLAR, false], [PROMO, ['a7a8q'], true], [PROMO, ['a7a8'], false],
    [CASTLE, ['e1h1'], true], [START, ['E2E4'], true], [AFTER_NF3, ['e2e4'], false],
  ];
  for (const [fen, line, expected] of cases) {
    const what = `${fen} ${JSON.stringify(line)}`;
    assert.equal(hasFirstMove(fen, line), expected, what);
    assert.equal(hasFirstMove(fen, line), buildSteps(fen, line).length >= 2, `${what}: the same answer as the stepper`);
    const open = renderToStaticMarkup(<LineViewer title="t" startFen={fen} line={line} orientation="w"/>);
    const closed = renderToStaticMarkup(<LineViewer title="t" startFen={fen} line={line} orientation="w" defaultOpen={false}/>);
    assert.equal(open === '', !expected, `${what}: open`);
    assert.equal(closed === '', !expected, `${what}: collapsed`);
  }
});

test('open state and legend (pure helpers): a new line starts as defaultOpen asks; the legend never describes a preview', () => {
  assert.equal(resolveOpen({ key: 'a', open: true }, 'a', false), true, 'opened by him, same line: stays open');
  assert.equal(resolveOpen({ key: 'a', open: true }, 'b', false), false, 'a new line starts collapsed again');
  assert.equal(resolveOpen({ key: 'a', open: false }, 'b', true), true);
  assert.equal(resolveOpen({ key: 'a', open: false }, 'a', true), false);
  // FX1c (brief 9.11.3, R4-4 and R6-3): step 0 says how to step; it used to be "Guess the first move, then press Next.".
  assert.equal(legendFor(0, 7), 'Press Next to step through the line.');
  assert.equal(legendFor(3, 7), 'Guess the next move, then press Next.');
  assert.equal(legendFor(7, 7), 'End of the line.');
  assert.equal(legendFor(0, 1), 'Press Next to step through the line.');
  for (const k of [0, 1, 6, 7]) assert.doesNotMatch(legendFor(k, 7), /arrow/i);
});

// Stylesheet: D12 rules (tokens, contrast, no comma selectors) for the viewer's own rules, and the phone layout.
const css = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const viewerRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] })).filter(r => r.sel.includes('line-viewer'));
const rule = (sel: string) => viewerRules.find(r => r.sel === sel)?.body ?? '';
const tokensIn = (body: string) => new Map([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)].map(m => [m[1], m[2].trim()]));
function lum(hex: string) {
  const h = hex.replace('#', ''), full = h.length === 3 ? [...h].map(c => c + c).join('') : h.slice(0, 6);
  const ch = (i: number) => { const x = parseInt(full.slice(i, i + 2), 16) / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('stylesheet: viewer rules exist, use no comma selectors and no literal colours, and every text colour reaches 4.5:1 on its fill in both themes', () => {
  assert.ok(viewerRules.length >= 15, `viewer rules found: ${viewerRules.length}`);
  for (const r of viewerRules) {
    assert.doesNotMatch(r.sel, /,/, `comma selector: ${r.sel}`);
    assert.doesNotMatch(r.body, /#[0-9a-fA-F]{3,8}\b|rgba?\(|\b(?:white|black)\b(?!-space)/, `literal colour in ${r.sel}`);
  }
  const bare = new Map<string, string>();
  for (const m of css.matchAll(/(?:^|\})\s*:root\s*\{([^{}]*)\}/g)) for (const [k, v] of tokensIn(m[1])) if (!bare.has(k)) bare.set(k, v);
  const dark = tokensIn(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^{}]*)\}/.exec(css)![1]);
  const v = (theme: Map<string, string>, t: string) => theme.get(t) ?? bare.get(t)!;
  let pairs = 0;
  for (const r of viewerRules) {
    const fg = /(?:^|;)color:var\((--[a-z0-9-]+)\)/.exec(r.body)?.[1];
    if (!fg) continue;
    const bg = /background:var\((--[a-z0-9-]+)\)/.exec(r.body)?.[1] ?? '--surface';
    for (const theme of [bare, dark]) assert.ok(ratio(v(theme, fg), v(theme, bg)) >= 4.5, `${r.sel}: ${fg} on ${bg} ${ratio(v(theme, fg), v(theme, bg)).toFixed(2)}`);
    pairs++;
  }
  assert.ok(pairs >= 3);
  for (const [fg, bg] of [['--ink', '--surface'], ['--muted', '--surface'], ['--blue', '--surface'], ['--ink', '--tint-hover-2']]) {
    for (const theme of [bare, dark]) assert.ok(ratio(v(theme, fg), v(theme, bg)) >= 4.5, `${fg} on ${bg}`);
  }
  assert.match(rule('.line-viewer'), /background:var\(--surface\)/, 'the viewer brings its own surface');
});

test('stylesheet: long lines wrap, nothing forces the page wider than a 360 px phone, controls are 44 px, compact means a smaller board', () => {
  assert.match(rule('.line-viewer-moves'), /display:flex;flex-wrap:wrap/);
  assert.match(rule('.line-viewer-move'), /white-space:nowrap/, 'a move never breaks inside itself');
  for (const sel of ['.line-viewer-caption', '.line-viewer-title', '.line-viewer-summary']) assert.match(rule(sel), /overflow-wrap:anywhere/, sel);
  assert.match(rule('.line-viewer-controls'), /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(rule('.line-viewer-controls .secondary'), /min-width:0;min-height:44px/);
  assert.match(css, /@media\(max-width:650px\)\{\.line-viewer-move\{min-height:44px\}\}/);
  assert.match(css, /@media\(max-width:400px\)\{\.line-viewer\{padding:10px\}\}/);
  // Icons only when the row is wide enough for icon and word in all four (about 62 px each): words alone fit at every width.
  assert.match(rule('.line-viewer-controls'), /container-type:inline-size/);
  assert.equal(rule('.line-viewer-controls svg'), 'display:none', 'words only by default (also where container queries are missing)');
  assert.match(css, /@container \(min-width:300px\)\{\.line-viewer-controls svg\{display:inline\}\}/);
  for (const r of viewerRules) {
    for (const [, prop, value] of r.body.matchAll(/(?:^|;)((?:min-)?width):([^;]+)/g)) {
      assert.ok(value === '0' || value === '100%' || /^min\(100%,\d+px\)$/.test(value), `${r.sel} ${prop}:${value} could push a phone page sideways`);
    }
  }
  assert.match(rule('.line-viewer-board'), /width:min\(100%,400px\)/);
  assert.match(rule('.line-viewer-compact .line-viewer-board'), /width:min\(100%,240px\)/);
  assert.match(rule('.line-viewer-board .board-wrap'), /width:100%/, 'the phone rule that sizes the main board does not size this one');
  assert.match(rule('.line-viewer-moves li'), /margin:0/);
});
