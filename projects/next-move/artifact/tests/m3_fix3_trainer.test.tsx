/**
 * M3 fix round 3 (brief 9.12.2), writer FX2e, the Trainer, Learn and stylesheet side:
 * - item 6 (V2-1): `drillTryText` also drops a drill try note that names the destination square of any move still to find
 *   (`answerMovesFrom` at the try's step), the try's own destination square aside; the message line stays;
 * - item 9 (V2-4): the Learn sources text says the page's engine checks use the bundled Stockfish;
 * - item 10 (V4-2): on phones and up to 850 px the From Claude area keeps the sticky bar's height clear above it when the
 *   "N notes from Claude" chip scrolls to it (an appended stylesheet block, Part 12).
 *
 * As in the other trainer tests, the Trainer is covered through its exported pieces and the wiring is pinned by reading
 * the sources; the chip's scroll and the drill's try slot were also run in a real browser (logs/m3_FX2e.md).
 * Positions are the page's own textbook drills. No owner game data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  answerMovesFrom, drillTryText, gradeCardTry, hiddenAnswerSquares, namesAnySquare, tryKey, TrySlot, tryViewOf, type TryView,
} from '../components/Trainer';
import LineViewer from '../components/LineViewer';
import Learn from '../components/Learn';
import type { TrainerItem } from '../components/pools';
import { endgameDrills } from '../lib/endgames';
import { drillTeach } from '../lib/endgameTeach';
import { ARTIFACT_DIR } from './b3_paths';

const src = readFileSync(join(ARTIFACT_DIR, 'components/Trainer.tsx'), 'utf8');
const css = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8');

/** The page's drill as a card. */
const drill = (id: string): TrainerItem => {
  const d = endgameDrills.find(x => x.id === id);
  if (!d) throw new Error(id);
  return { ...d, source: 'endgame' } as unknown as TrainerItem;
};
/** Every listed try (a try with a stored line and note) of a drill, at every step, with the try view he sees while solving. */
function listedTries(id: string) {
  const item = drill(id);
  return (drillTeach(id)?.steps ?? []).flatMap(s => s.tries.filter(t => t.uci !== item.moves[s.step]).map(t => {
    const answers = answerMovesFrom(item, s.fen, s.step);
    const graded = gradeCardTry(item, s.fen, t.uci, s.step, null);
    return { item, step: s.step, fen: s.fen, uci: t.uci, san: t.san, note: t.note.trim(), answers, graded,
      view: tryViewOf(tryKey(id, s.step, t.uci), s.fen, t.uci, answers, graded), text: drillTryText(item, s.fen, t.uci, s.step) };
  }));
}
/** The answer squares a note shown while solving must not name (the rule under test, written out independently). */
const leakedSquares = (note: string, answers: readonly { to: string }[], uci: string) =>
  answers.map(a => a.to).filter(sq => sq !== uci.slice(2, 4) && new RegExp(`(?<![0-9])${sq}(?![0-9])`).test(note));

// ---------------------------------------------------------------- item 6 (V2-1): a drill note that names an answer's square

test('item 6: namesAnySquare finds a square alone or inside a move; hiddenAnswerSquares leaves out the try\'s own square', () => {
  const note = 'Kc4 does not step into the square of the pawn (d4 to h8), so the h-pawn runs and promotes on h8: White wins.';
  assert.ok(namesAnySquare(note, ['d4']) && namesAnySquare(note, ['h8']) && namesAnySquare(note, ['c4']));
  assert.ok(!namesAnySquare(note, ['e5', 'f6', 'g7']));
  assert.ok(namesAnySquare("Black's king takes it with Kxc7: Black wins.", ['c7']), 'a square inside a capture');
  assert.ok(namesAnySquare('Nbd2 and Ra1', ['d2']) && namesAnySquare('Nbd2 and Ra1', ['a1']));
  assert.ok(!namesAnySquare('the king walks to the corner', ['c4']) && !namesAnySquare('a 34-move mate', ['a3']), 'no square, no digit run');
  assert.ok(!namesAnySquare(note, ['xx', '', 'd9']), 'only real squares are looked for');
  // The squares of every move still to find, each once, except where his try itself goes.
  assert.deepEqual(hiddenAnswerSquares([{ to: 'd4' }, { to: 'e5' }, { to: 'd4' }, { to: 'c4' }], 'c3c4'), ['d4', 'e5']);
  assert.deepEqual(hiddenAnswerSquares([{ to: 'e8' }], 'e7e8q'), [], 'a promotion goes to its square too');
});

test('item 6: "Step into the square": all 16 listed wrong king moves keep "This loses." and lose the note that gives the answer\'s square', () => {
  const tries = listedTries('tech-rule-of-the-square');
  assert.equal(tries.length, 16);
  for (const t of tries) {
    const where = `step ${t.step} ${t.san}`;
    // The stored note names the box the answer must enter ("(d4 to h8)"): the answer's own square.
    assert.deepEqual(leakedSquares(t.note, t.answers.slice(0, 1), t.uci), [t.answers[0].to], where);
    assert.equal(t.graded.grade.message, 'This loses.', where);
    assert.equal(t.text?.intro, 'This loses.', `${where}: the message only`);
    assert.ok(t.view && t.view.intro === undefined && t.view.line.length > 1, `${where}: the viewer keeps its line, with no note`);
    const slot = renderToStaticMarkup(<TrySlot view={t.view} solving={true}/>);
    assert.ok(slot.includes(`Why ${t.san} doesn&#x27;t work`) && !slot.includes('square of the pawn'), where);
    // One press of Back: step 0 of the viewer shows whose move it is, not the note (as the browser run shows).
    const start = renderToStaticMarkup(<LineViewer title={t.view!.title} startFen={t.fen} line={t.view!.line} orientation="b" intro={t.view!.intro} initialStep={0}/>);
    assert.ok(start.includes('Black to move.') && !start.includes('square of the pawn'), where);
  }
});

test('item 6: a note naming a later answer\'s square, or the square inside a move, is dropped; one naming only the try\'s own square stays', () => {
  // A later step's square ("a step too slow on the way to c7"): the step's own answer goes elsewhere.
  const later = listedTries('tech-kpk-rook-pawn-corner').filter(t => {
    const hit = leakedSquares(t.note, t.answers, t.uci);
    return hit.length && !hit.includes(t.answers[0].to);
  });
  assert.ok(later.length >= 5, `later-step notes: ${later.length}`);
  for (const t of later) assert.equal(t.view?.intro, undefined, `${t.step} ${t.san}: ${t.note}`);
  // "… Black's king takes it with Kxc7": c7 is where a pawn move still to find goes.
  const reti = listedTries('tech-reti-double-threat').find(t => t.step === 6 && t.san === 'Kd5');
  assert.ok(reti && /Kxc7/.test(reti.note) && reti.answers.some(a => a.to === 'c7'));
  assert.equal(reti.view?.intro, undefined);
  // Ra8+ in the king-step mate: its note names a8 (Ra8+ itself), and a move still to find also goes to a8. His try already
  // shows that square, so the note stays.
  const own = listedTries('tech-krk-mate-in-two-king-step').find(t => t.step === 0 && t.san === 'Ra8+');
  assert.ok(own && own.answers.some(a => a.to === 'a8') && /Ra8\+/.test(own.note));
  assert.deepEqual(leakedSquares(own.note, own.answers, own.uci), []);
  assert.equal(own.view?.intro, own.note, 'the note shows with the try\'s own square');
  // A note that names no square of a move still to find stays, word for word, in the same drill as the dropped one.
  const kept = listedTries('tech-reti-double-threat').filter(t => t !== reti && t.note && !leakedSquares(t.note, t.answers, t.uci).length);
  assert.ok(kept.length >= 10);
  for (const t of kept) assert.equal(t.view?.intro, t.note, `${t.step} ${t.san}`);
});

test('item 6: over all 26 drills, no note shown while solving names a square of a move still to find (other than the try\'s own)', () => {
  let listed = 0, shown = 0, dropped = 0;
  const leaks: string[] = [], wrongDrops: string[] = [];
  assert.equal(endgameDrills.length, 26);
  for (const d of endgameDrills) {
    for (const t of listedTries(d.id)) {
      if (!t.note) continue;
      listed++;
      const intro = t.view?.intro ?? '';
      if (intro) shown++; else dropped++;
      if (intro && leakedSquares(intro, t.answers, t.uci).length) leaks.push(`${d.id} ${t.step} ${t.san}: ${intro}`);
      // A note is dropped only for a square of a move still to find, or (as before) for an answer's SAN.
      if (!intro && !leakedSquares(t.note, t.answers, t.uci).length && !t.answers.some(a => a.san && t.note.includes(a.san.replace(/[+#]$/, '')) && a.san !== t.san)) {
        wrongDrops.push(`${d.id} ${t.step} ${t.san}: ${t.note}`);
      }
      // The message line by the board never names a square of a move still to find.
      assert.deepEqual(leakedSquares(t.graded.grade.message, t.answers, t.uci), [], `${d.id} ${t.step} ${t.san}`);
    }
  }
  assert.deepEqual(leaks, []);
  // Measured in logs/m3_FX2e.md: 177 listed notes, 174 shown before this round, 138 now (V2-1's 16 + 7 + 12, and the
  // "Kxc7" note above). The 3 notes dropped before this round print an answer's SAN.
  // Version 7.3: 142 shown, 35 dropped. Four notes of the give-up-the-pawn drill, at his second move, said "the pawn
  // runs to c7" and were dropped for it (c7 is that step's answer square). They were reworded to be read; `leaks`
  // above still holds for them, as for every other shown note.
  assert.deepEqual({ listed, shown, dropped }, { listed: 177, shown: 142, dropped: 35 });
  assert.deepEqual(wrongDrops, []);
});

test('item 6: the square rule sits in drillTryText, beside the SAN rule, and the message stays; no other path shows the note', () => {
  const fn = src.slice(src.indexOf('export function drillTryText('), src.indexOf('/** One background check at a time'));
  assert.match(fn, /!namesAnySquare\(g\.intro, hiddenAnswerSquares\(answerMovesFrom\(item, fenBefore, index\), tryUci\)\)/);
  assert.match(fn, /intro: \[g\.message, note\]\.filter\(Boolean\)\.join\(' '\)/, 'the message stays');
  // Every read of a grade's intro (where gradeTry puts the drill note) is inside drillTryText.
  const reads = (text: string) => (text.match(/\b(?:g|grade|graded)\.intro\b/g) ?? []).length;
  assert.ok(reads(fn) > 0);
  assert.equal(reads(src), reads(fn), 'the drill note reaches the page only through drillTryText');
});

// ---------------------------------------------------------------- item 9 (V2-4): the Learn sources text

test('item 9: the Learn sources text says the page\'s engine checks use the bundled Stockfish, and keeps its licence links', () => {
  const html = renderToStaticMarkup(<Learn onTheme={() => undefined}/>);
  assert.ok(html.includes('<p>Engine checks on this page use the bundled Stockfish; positions from your games come from an offline pass. <a href="COPYING-GPL-3.0.txt"'));
  assert.ok(!html.includes('does not run an engine itself') && !html.includes('Engine: positions from your games'));
  assert.ok(html.includes('href="https://github.com/nmrugg/stockfish.js"') && html.includes('>corresponding source</a>'));
});

// ---------------------------------------------------------------- item 10 (V4-2): the chip's scroll under the sticky bar

test('item 10: Part 12 appends one rule: up to 850 px, #from-claude keeps the sticky bar\'s 69 px (and the top inset) clear', () => {
  const at = css.indexOf('/* ---- Part 12: M3 fix round 3 (FX2e');
  assert.ok(at > css.indexOf('/* ---- Part 11: M3 fix round 2, stage 2 (FX2c'), 'Part 12 after Part 11');
  const next = css.indexOf('/* ---- Part 13', at);
  const part = css.slice(at, next === -1 ? undefined : next);
  const rules = part.replace(/\/\*[^]*?\*\//g, '').trim();
  assert.equal(rules, '@media(max-width:850px){#from-claude{scroll-margin-top:calc(69px + env(safe-area-inset-top,0px))}}');
  // D12: no colour, no token, no comma selector.
  assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b|rgba?\(|var\(|\bwhite\b|\bblack\b/);
  assert.doesNotMatch(rules, /,(?![^()]*\))/, 'the only comma is env()\'s fallback');
  // The breakpoint is the one where the bar becomes sticky at the top (Part 1), and the bar sits under the top inset.
  assert.match(css, /@media\(max-width:850px\)\{\.app-shell\{grid-template-columns:1fr\}\.sidebar\{height:auto;position:sticky;top:0;/);
  assert.match(css, /\.sidebar\{top:env\(safe-area-inset-top,0px\)\}/);
  // 69 px covers the measured bar (68.94 px at 390 and 360 px wide, 61.59 px from 651 to 850 px; the comment says so).
  assert.match(part, /68\.94 px at 390 and 360 px wide, 61\.59 px from 651 to 850 px/);
  // The chip scrolls the area that carries the id, to the top of the screen; the margin keeps it below the bar.
  assert.match(src, /onNotes=\{\(\) => document\.getElementById\('from-claude'\)\?\.scrollIntoView\(\{ block: 'start' \}\)\}/);
  assert.match(src, /<PlanAndNotes id="from-claude" /);
});
