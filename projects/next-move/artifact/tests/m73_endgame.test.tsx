/**
 * Version 7.3, endgames: the key squares of a drill are ringed on the board (every one of them, not only the first),
 * and the give-up-the-pawn drill says why each step holds (its old text stopped before the step where only one king
 * move keeps the draw). The drills are the bundled, tablebase-checked set; nothing here comes from his games.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { renderToStaticMarkup } from 'react-dom/server';
import Chessboard from '../components/Chessboard';
import { TrySlot, answerMovesFrom, answerSansFrom, drillKeySquares, drillTryText, gradeCardTry, hintMarks, tryKey, tryViewOf } from '../components/Trainer';
import { endgameDrills } from '../lib/endgames';
import { drillTeach } from '../lib/endgameTeach';
import { buildHints } from '../src/teach/hints';
import type { TrainerItem } from '../components/pools';

const ID = 'tech-kpkp-give-up-pawn-keep-opposition';
const drill = endgameDrills.find(d => d.id === ID)!;
const teach = drillTeach(ID)!;
/** The position and the rest of the line at the solver's k-th move (0, 1, 2). */
function at(k: number) {
  const board = new Chess(drill.fen);
  for (const uci of drill.moves.slice(0, 2 * k)) board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return { fen: board.fen(), line: drill.moves.slice(2 * k) };
}
const hintsAt = (k: number) => buildHints({ ...at(k), themes: drill.themes, kind: 'endgame', idea: teach.idea, keySquares: teach.keySquares });
const ringed = (html: string) => [...html.matchAll(/data-square="([a-h][1-8])" class="([^"]*)"/g)].filter(m => /\bhint-square\b/.test(m[2])).map(m => m[1]).sort();

test('the give-up-the-pawn drill names the key squares of the c4 pawn, in its idea, its data and its explanation', () => {
  assert.deepEqual(teach.keySquares, ['b6', 'c6', 'd6']);
  assert.match(teach.idea, /b6, c6 or d6, the key squares/);
  assert.match(drill.explanation ?? '', /b6, c6 or d6/);
  assert.match(drill.explanation ?? '', /Kd7 would leave b6 open/, 'the step the old text skipped is explained');
  assert.ok((drill.explanation ?? '').length <= 300);
  // The squares are the three in front of the pawn, two ranks up: the textbook key squares of a pawn on its fourth rank.
  assert.equal(new Chess(drill.fen).get('c4')?.type, 'p');
});

test('what the explanation says about each king move is what the tablebase data says', () => {
  const step = (k: number) => teach.steps[k];
  // Kb7 waits (the only move that holds), and Kc7 at once loses.
  assert.deepEqual(Object.entries(step(0).results).filter(([, r]) => r === 'draw').map(([m]) => m), ['b6b7']);
  assert.equal(step(0).results.b6c7, 'loss');
  // After Kxc5: Kc7 is the only move that holds.
  assert.deepEqual(Object.entries(step(1).results).filter(([, r]) => r === 'draw').map(([m]) => m), ['b7c7']);
  // After Kb5: Kb7 holds and Kd7 loses.
  assert.deepEqual(Object.entries(step(2).results).filter(([, r]) => r === 'draw').map(([m]) => m), ['c7b7']);
  assert.equal(step(2).results.c7d7, 'loss');
  // "guards": a king guards the squares next to it. From c7: b6, c6 and d6. From b7: b6 and c6. From d7: not b6.
  const next = (from: string, to: string) => Math.max(Math.abs(from.charCodeAt(0) - to.charCodeAt(0)), Math.abs(Number(from[1]) - Number(to[1]))) === 1;
  assert.ok(['b6', 'c6', 'd6'].every(s => next('c7', s)));
  assert.ok(next('b7', 'b6') && next('b7', 'c6'));
  assert.ok(!next('d7', 'b6'));
  // The notes after the capture name the key square each losing try gives up, and the square is one White's king enters.
  for (const k of [1, 2]) for (const t of step(k).tries) {
    const m = /leaves the key square ([a-h][1-8]) unguarded/.exec(t.note);
    assert.ok(m, `${k} ${t.san}: ${t.note}`);
    assert.ok(teach.keySquares!.includes(m![1]));
    assert.equal(t.lineUci[0].slice(2, 4), m![1], `${t.san}: White's king steps onto ${m![1]} at once`);
    assert.ok(!next(t.uci.slice(2, 4), m![1]), `${t.san}: the king no longer guards ${m![1]}`);
  }
});

test('the second hint names the key squares and the board rings every one of them', () => {
  // At the first step his king stands on b6 and is about to leave it. The list still names all three (seen in the
  // browser run: "c6 and d6" under an idea that says "b6, c6 or d6" read as a contradiction at the very first step).
  for (const k of [0, 1, 2]) {
    const two = hintsAt(k)[1];
    assert.equal(two.text, 'Key squares: b6, c6 and d6.');
    assert.equal(two.square, 'b6');
    assert.deepEqual(two.squares, ['b6', 'c6', 'd6']);
    const marks = hintMarks(hintsAt(k), 2);
    assert.deepEqual(marks.hintSquares, ['b6', 'c6', 'd6']);
    assert.deepEqual(ringed(renderToStaticMarkup(<Chessboard fen={at(k).fen} orientation="b" hintSquare={marks.hintSquare} hintSquares={marks.hintSquares}/>)), ['b6', 'c6', 'd6']);
  }
  // A hint with one square is as before: no list.
  assert.equal(hintMarks(hintsAt(1), 3).hintSquares, undefined);
  assert.equal(hintMarks(hintsAt(1), 1).hintSquares, undefined);
  assert.deepEqual(ringed(renderToStaticMarkup(<Chessboard fen={at(1).fen} hintSquare="c7"/>)), ['c7']);
});

test('a finished drill shows its key squares on the board; an unfinished one and every other card do not', () => {
  assert.deepEqual(drillKeySquares(drill, true), ['b6', 'c6', 'd6']);
  assert.deepEqual(drillKeySquares(drill, false), []);
  assert.deepEqual(drillKeySquares({ id: 'bank-1', themes: ['fork'] }, true), []);
  assert.deepEqual(drillKeySquares(null, true), []);
  const without = endgameDrills.find(d => !drillTeach(d.id)?.keySquares)!;
  assert.deepEqual(drillKeySquares(without, true), []);
  // Every drill that lists key squares lists real squares, and a single-square drill still rings its square.
  for (const d of endgameDrills) for (const s of drillTeach(d.id)?.keySquares ?? []) assert.match(s, /^[a-h][1-8]$/);
});

test('a wrong king move in a drill shows its reason in plain sight, above the line, and names no move still to find', () => {
  // The third move (after Kb7 Kxc5 Kc7 Kb5): Kd7 is the natural wrong move there. The message line says "This loses.".
  const { fen } = at(2);
  // The drill as the page holds it (the bundled set's fields, with its source).
  const item: TrainerItem = { id: drill.id, fen: drill.fen, moves: [...drill.moves], rating: drill.rating, themes: [...drill.themes], gameUrl: '', source: 'endgame', title: drill.title };
  const graded = gradeCardTry(item, fen, 'c7d7', 4, null);
  assert.deepEqual([graded.grade.action, graded.grade.message, graded.source], ['error', 'This loses.', 'tablebase']);
  const view = tryViewOf(tryKey(item.id, 4, 'c7d7'), fen, 'c7d7', answerMovesFrom(item, fen, 4), graded)!;
  assert.match(view.intro ?? '', /^Kd7 leaves the key square b6 unguarded: White's king steps onto it with Kb6/);
  assert.doesNotMatch(view.intro ?? '', /\bKb7\b|\bb7\b/, 'the answer (Kb7) is not given away');
  const html = renderToStaticMarkup(<TrySlot view={view} solving/>);
  const note = `<p class="try-note small">${(view.intro ?? '').replace(/'/g, '&#x27;')}</p>`;
  assert.ok(html.startsWith(`<div class="try-check">${note}<section class="line-viewer"`), 'the note comes first, then the open viewer');
  assert.equal(html.split(note).length, 2, 'said once: the viewer does not repeat it as its first caption');
  assert.match(html, /Why Kd7 doesn&#x27;t work/);
  // Every one of the drill's eight notes from the capture on is shown while he is still solving: none names c7 or b7,
  // the squares of the moves still to find (the page withholds a note that does; the first wording of four of them
  // said "runs to c7" and was withheld).
  for (const k of [1, 2]) for (const t of teach.steps[k].tries) {
    const g = gradeCardTry(item, at(k).fen, t.uci, 2 * k, null);
    assert.ok((g.text?.intro ?? '').includes(t.note), `step ${k} ${t.san}: the note is shown`);
  }
  // A try the engine graded (a card from his games) keeps its figures as the viewer's first caption: no note above.
  const engineTry = { ...view, source: 'engine' as const };
  assert.doesNotMatch(renderToStaticMarkup(<TrySlot view={engineTry} solving/>), /try-note/);
});

test('a note shown for a wrong move that is the right move at a later step does not say when it is right', () => {
  // Review of 7.3, P1-1. The page shows a try's note in plain sight while he is still solving, and lets the note name the
  // try itself. Five notes also said when: "Kb5 comes one move too soon" stood on screen one step before Kb5 was the
  // answer ("c7 comes too early" and "Kc6 comes too early" likewise). A note may say what the try allows; it may not
  // say that its turn comes later.
  const TIMING = /\btoo (early|soon)\b|\bone move too\b|\bnot yet\b|\bpremature|\bcomes later\b|\bwrong moment\b|\bbefore its time\b/i;
  const core = (san: string) => san.replace(/[+#]+$/, '');
  const seen: string[] = [];
  for (const d of endgameDrills) {
    const item: TrainerItem = { id: d.id, fen: d.fen, moves: [...d.moves], rating: d.rating, themes: [...d.themes], gameUrl: '', source: 'endgame', title: d.title };
    for (const s of drillTeach(d.id)?.steps ?? []) {
      const later = answerSansFrom(item, s.fen, s.step).slice(1).map(core);
      for (const t of s.tries) {
        if (t.uci === d.moves[s.step] || !later.includes(core(t.san))) continue;
        const shown = drillTryText(item, s.fen, t.uci, s.step)?.intro ?? '';
        if (!shown.includes(t.note.trim())) continue; // withheld by the page: never on screen
        seen.push(`${d.id}@${s.step} ${t.san}`);
        assert.doesNotMatch(t.note, TIMING, `${d.id}, step ${s.step}, ${t.san}: "${t.note}"`);
      }
    }
  }
  // The bundled set has fourteen such notes, so the loop above looks at something; the five reworded ones are among them.
  assert.equal(seen.length, 14);
  for (const k of ['tech-kpkp-triangulation@2 Kb5', 'tech-reti-double-threat@0 c7', 'tech-reti-double-threat@2 c7', 'tech-kpkp-go-around@2 Kc6', 'tech-kpkp-go-around@4 Kc6'])
    assert.ok(seen.includes(k), k);
});
