/**
 * M3 fix pass, writer FX2 (brief 9.10 f, g, h, i, m, n):
 * - (f) after a punish card his game move is named once;
 * - (g) a drill's verdict shows once, in the message line by the board;
 * - (h) on a phone a collapsed try slot sits right under the message line; with the lead's 02:00 ruling (repair FXR1)
 *   so does a Lichess puzzle's miss, one press away there and open at wider widths;
 * - (i) off the phone the hint and reveal buttons come before the hints shown;
 * - (m) a short engine scan's line is titled "The line after {answer}";
 * - (n) while he solves, a try line that the spoiler cut leaves with his try alone shows no viewer.
 *
 * As in m3_trainer_a, b and c: the page has no DOM test renderer (a static render of the Trainer stops at "Loading"),
 * so the Trainer is covered through its exported pieces, and the wiring is pinned by reading Trainer.tsx. The first
 * screen itself (390x844 and 1280x800) is measured in a real browser; see logs/m3_FX2.md.
 *
 * Positions are textbook or invented, each checked with chess.js; the drills are the page's own textbook drills
 * (data/technical_endgames.json). No owner game data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chess } from 'chess.js';
import {
  answerLineOf, answerMovesFrom, cutBeforeAnswer, drillTryText, gradeCardTry, isEngineScanCard, lessonFor, PracticeColumns, PunishGameLine, SolvedNotes, solvedTextsOf,
  SolvedViewers, solvingTryLine, TrySlot, tryCollapsedOnPhone, tryKey, tryViewOf, type PracticeLayout, type PracticeParts, type TryView,
} from '../components/Trainer';
import LineViewer from '../components/LineViewer';
import type { TrainerItem } from '../components/pools';
import { endgameDrills } from '../lib/endgames';
import { drillTeach } from '../lib/endgameTeach';
import { ARTIFACT_DIR } from './b3_paths';

const src = readFileSync(join(ARTIFACT_DIR, 'components/Trainer.tsx'), 'utf8');
const css = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const count = (text: string, s: string) => text.split(s).length - 1;
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

// ---------------------------------------------------------------- fixtures (invented)

/** His game (White): Re7 leaves the back rank; Black (the solver) plays Rd1+ Re1 Rxe1#. Better was h3. */
const BEFORE = '3r2k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';
const punishCard = (extra: Partial<TrainerItem> = {}): TrainerItem => ({
  id: 'punish-t1', fen: after(BEFORE, 'e1e7').fen, moves: ['d8d1'], rating: 1000, themes: ['personal', 'opening'], gameUrl: '', source: 'pack', kind: 'punish',
  pack: { playedSan: 'Re7', playedUci: 'e1e7', sourceFen: BEFORE, pvUci: ['d8d1', 'e7e1', 'd1e1'], rowId: 't1', winAfter: 2, solverColor: 'b' }, ...extra,
});
const siblingCard = (): TrainerItem => ({
  id: 'pack-t1', fen: BEFORE, moves: ['h2h3'], rating: 1000, themes: ['personal'], gameUrl: '', source: 'pack', kind: 'mistake',
  pack: { playedSan: 'Re7', playedUci: 'e1e7', pvUci: ['h2h3', 'd8d1', 'e1d1'] },
});
/** A punish card's stored explanation, in the shape the pack importer writes (src/importers/packDocs.ts). */
const STORED = "In your game you played Re7 here. Your opponent's best reply was Rd1+ (engine line: Rd1+ Re1 Rxe1#). Before each move, ask what it allows.";
/** A mistake card from his games (White to move): Qxd8# wins; his game move Qd7 lets the rook take the queen. */
const MISTAKE_FEN = '3r2k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1';
const mistakeCard = (): TrainerItem => ({
  id: 'pack-m1', fen: MISTAKE_FEN, moves: ['d1d8'], rating: 1000, themes: ['personal'], gameUrl: '', source: 'pack', kind: 'mistake',
  pack: { playedSan: 'Qd7', playedUci: 'd1d7', pvUci: ['d1d8'], refutationPvUci: ['d8d7', 'h2h3'], winBefore: 99.6, winAfter: 0.4 },
});
/** A position from his games saved by the Site app or made on this page: Nd5 Nxd5 Rxd5 from a short engine scan. */
const TRADE_FEN = '4k3/8/5n2/8/8/2N5/8/3RK3 w - - 0 1';
const scanCard = (): TrainerItem => ({ id: 'personal-scan1', fen: TRADE_FEN, moves: ['c3d5', 'f6d5', 'd1d5'], rating: 1000, themes: ['personal', 'middlegame'], gameUrl: '', source: 'personal' });
/** (n): White to move. The card's move is Rd8+; after his try h3 the reply ...Rd8 (Black's rook) has the answer's name. */
const CUT_FEN = 'r5k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
const drill = (id: string): TrainerItem => {
  const d = endgameDrills.find(x => x.id === id);
  assert.ok(d, id);
  return { id: d!.id, fen: d!.fen, moves: [...d!.moves], rating: d!.rating, themes: [...d!.themes], gameUrl: '', source: 'endgame' };
};

test('fixtures are legal', () => {
  assert.deepEqual(sans(punishCard().fen, ['d8d1', 'e7e1', 'd1e1']), ['Rd1+', 'Re1', 'Rxe1#']);
  assert.deepEqual(sans(BEFORE, ['h2h3', 'd8d1', 'e1d1']), ['h3', 'Rd1', 'Rxd1']);
  assert.deepEqual(sans(MISTAKE_FEN, ['d1d8']), ['Qxd8#']);
  assert.deepEqual(sans(TRADE_FEN, ['c3d5', 'f6d5', 'd1d5']), ['Nd5', 'Nxd5', 'Rxd5']);
  assert.deepEqual(sans(CUT_FEN, ['d1d8']), ['Rd8+']);
  assert.deepEqual(sans(CUT_FEN, ['h2h3', 'a8d8', 'd1d8']), ['h3', 'Rd8', 'Rxd8#']);
  assert.deepEqual(sans(CUT_FEN, ['h2h3', 'g8f8', 'd1d8']), ['h3', 'Kf8', 'Rd8+']);
});

// ---------------------------------------------------------------- (f) his game move named once after a punish card

/** The punish texts of the complete panel, as the Trainer renders them (the wiring is pinned below from the source). */
function punishTexts(item: TrainerItem, sibling: TrainerItem | undefined, lesson: string | null): string {
  const t = solvedTextsOf(item, lesson);
  return renderToStaticMarkup(<>
    {t.gameLine && <PunishGameLine item={item} sibling={sibling}/>}
    {item.explanation && t.explanation && <p className="small">{item.explanation}</p>}
    <SolvedNotes item={item} sibling={sibling} lesson={lesson}/>
  </>);
}

test('9.10 (f): after a punish card "In your game you played Re7" appears once: the lesson, else the stored text, else the corrected line', () => {
  const sib = siblingCard();
  const lesson = lessonFor(punishCard(), sib)!;
  assert.ok(lesson.startsWith('In your game you played Re7. ') && lesson.endsWith(' Better was h3.'), lesson);
  for (const stored of [true, false]) for (const withLesson of [true, false]) for (const sibling of [sib, undefined]) {
    const card = punishCard(stored ? { explanation: STORED } : {});
    const l = withLesson ? lessonFor(card, sibling) : null;
    const html = punishTexts(card, sibling, l);
    const where = `stored ${stored}, lesson ${withLesson}, sibling ${!!sibling}`;
    assert.equal(count(html, 'In your game'), 1, where);
    if (withLesson) assert.equal(html, `<div class="teach-notes"><p>${esc(l!)}</p></div>`, `${where}: the lesson alone`);
    else if (stored) assert.equal(html, `<p class="small">${esc(STORED)}</p>`, `${where}: the stored text is the fallback`);
    else assert.equal(html, `<p class="punish-game-line"><strong>In your game</strong> you played Re7.${sibling ? ' Better was h3.' : ''}</p>`, `${where}: the corrected line`);
  }
  // The decision, by kind. Other kinds keep their stored explanation and never get a corrected line.
  assert.deepEqual(solvedTextsOf(punishCard({ explanation: STORED }), lesson), { gameLine: false, explanation: false });
  assert.deepEqual(solvedTextsOf(punishCard(), lesson), { gameLine: false, explanation: false });
  assert.deepEqual(solvedTextsOf(punishCard({ explanation: STORED }), null), { gameLine: false, explanation: true });
  assert.deepEqual(solvedTextsOf(punishCard(), null), { gameLine: true, explanation: false });
  assert.deepEqual(solvedTextsOf({ ...mistakeCard(), explanation: 'You played Qd7. The engine preferred Qxd8#.' }, null), { gameLine: false, explanation: true });
  assert.deepEqual(solvedTextsOf(mistakeCard(), null), { gameLine: false, explanation: false });
  assert.equal(lessonFor(mistakeCard()), null, 'a lesson only on punish cards');
  // SolvedNotes shows the lesson it is given (made once by the page), and makes it itself when none is given.
  assert.equal(renderToStaticMarkup(<SolvedNotes item={punishCard()} sibling={sib} lesson={null}/>), '');
  assert.equal(renderToStaticMarkup(<SolvedNotes item={punishCard()} sibling={sib}/>), `<div class="teach-notes"><p>${esc(lesson)}</p></div>`);
});

test('9.10 (f) wiring: the lesson is made once the card is complete, and gates both corrected lines and the stored text', () => {
  assert.match(src, /const lesson = useMemo\(\(\) => \(active && complete \? lessonFor\(active, sibling\) : null\), \[active, sibling, complete\]\);/);
  assert.match(src, /const solvedTexts = active \? solvedTextsOf\(active, lesson\) : \{ gameLine: false, explanation: false \};/);
  assert.equal(count(src, '<PunishGameLine '), 2, 'two places: with and without the game detail');
  assert.equal(count(src, 'solvedTexts.gameLine && <PunishGameLine item={active} sibling={sibling}/>'), 2, 'both gated');
  assert.equal(count(src, '{active.explanation && solvedTexts.explanation && <p className="small">{active.explanation}</p>}'), 1);
  assert.equal(count(src, '<SolvedNotes item={active} sibling={sibling} lesson={lesson}/>'), 1);
});

// ---------------------------------------------------------------- (g) a drill's verdict once

test('9.10 (g): a drill verdict appears once, in the message line; a viewer intro or the slot\'s words never repeat it', () => {
  const kpk = drill('tech-kpk-take-the-opposition');
  const e4 = gradeCardTry(kpk, kpk.fen, 'e3e4', 0, null);
  assert.equal(e4.grade.message, 'This only draws.');
  const both = drillTryText(kpk, kpk.fen, 'e3e4', 0)!;
  assert.ok(both.intro!.startsWith('This only draws. '), 'drillTryText still carries both; the page drops the verdict');
  assert.ok(e4.text!.line.length > 1, 'a line to step through');
  assert.equal(e4.text!.intro, both.intro!.slice('This only draws. '.length), 'the viewer gets the listed note alone');
  const open = renderToStaticMarkup(<TrySlot view={tryViewOf(tryKey(kpk.id, 0, 'e3e4'), kpk.fen, 'e3e4', answerMovesFrom(kpk, kpk.fen, 0), e4)} solving/>);
  assert.match(open, /<section [^>]*class="line-viewer"/);
  assert.equal(count(open, 'This only draws'), 0);
  // Every listed try at every step of every drill: the grade's message is the verdict, and neither the intro nor the
  // slot as rendered while he solves repeats it.
  let n = 0;
  for (const d of endgameDrills) {
    const item = drill(d.id);
    for (const s of drillTeach(d.id)?.steps ?? []) for (const t of s.tries) {
      n++;
      const g = gradeCardTry(item, s.fen, t.uci, s.step, null);
      const where = `${d.id} step ${s.step} ${t.san}`;
      assert.ok(g.grade.message, where);
      assert.ok(!(g.text?.intro ?? '').includes(g.grade.message), `${where}: intro`);
      const v = tryViewOf(tryKey(item.id, s.step, t.uci), s.fen, t.uci, answerMovesFrom(item, s.fen, s.step), g);
      assert.equal(count(renderToStaticMarkup(<TrySlot view={v} solving/>), esc(g.grade.message)), 0, `${where}: slot`);
    }
  }
  assert.equal(n, 177, 'all listed drill tries');
  assert.match(body('gradeCardTry'), /return \{ grade, text: text \? withoutMessage\(text, grade\.message\) : null, source: 'tablebase' \};/);
});

// ---------------------------------------------------------------- (h) and (i): where the parts go

const PART_NAMES = ['board', 'feedback', 'controls', 'ladder', 'advance', 'head', 'coach', 'solved', 'viewers', 'trySlot', 'foot'] as const;
const markers = Object.fromEntries(PART_NAMES.map(n => [n, <i data-part={n}/>])) as unknown as PracticeParts;
const render = (layout: PracticeLayout, tryCollapsed?: boolean, parts: PracticeParts = markers) =>
  renderToStaticMarkup(<PracticeColumns layout={layout} parts={parts} {...(tryCollapsed === undefined ? {} : { tryCollapsed })}/>);
/** The parts inside one block, in order. `board-help` and `board-viewers` hold markers only, so they end at the next `</div>`. */
function placed(html: string, block: 'board-help' | 'board-viewers' | 'board-column' | 'coach-panel'): string[] {
  const open = html.indexOf(`class="${block}"`);
  if (open < 0) return [];
  const close = block === 'coach-panel' ? html.length : block === 'board-column' ? html.indexOf('class="coach-panel"') : html.indexOf('</div>', open);
  return [...html.slice(open, close).matchAll(/data-part="([a-zA-Z]+)"/g)].map(m => m[1]);
}
const once = (html: string) => { for (const n of PART_NAMES) assert.equal(count(html, `data-part="${n}"`), 1, `${n} once`); };

test('9.10 (h): on a phone a collapsed try slot sits right under the message line; an open one stays in the coach panel', () => {
  const collapsed = render('phone', true);
  once(collapsed);
  assert.deepEqual(placed(collapsed, 'board-help'), ['controls', 'feedback', 'trySlot', 'ladder']);
  assert.deepEqual(placed(collapsed, 'coach-panel'), ['head', 'coach', 'solved', 'viewers', 'foot']);
  // Not one press away (no try, or a background check still running): as in stage (c), the slot stays in the coach
  // panel. (FX2c, 9.11.3: every finished try is one press away on a phone now, a drill's and his own game's counted
  // miss included; below, and the next test for a Lichess puzzle's miss.)
  for (const html of [render('phone', false), render('phone')]) {
    once(html);
    assert.deepEqual(placed(html, 'board-help'), ['controls', 'feedback', 'ladder']);
    assert.deepEqual(placed(html, 'coach-panel'), ['head', 'coach', 'solved', 'viewers', 'trySlot', 'foot']);
  }
  // Wider screens do not move it.
  for (const layout of ['wide', 'mid'] as const) assert.equal(render(layout, true), render(layout, false), layout);
  // A real collapsed slot: a soft retry on a drill (Ra8+ mates, but not in two). Its toggle comes right after the message.
  const krk = drill('tech-krk-mate-in-two-king-step');
  const ra8 = tryViewOf(tryKey(krk.id, 0, 'a7a8'), krk.fen, 'a7a8', answerMovesFrom(krk, krk.fen, 0), gradeCardTry(krk, krk.fen, 'a7a8', 0, null))!;
  assert.deepEqual([ra8.status, ra8.collapsed], ['done', true]);
  assert.equal(tryCollapsedOnPhone(krk, ra8), true);
  const html = render('phone', tryCollapsedOnPhone(krk, ra8), { ...markers, trySlot: <TrySlot view={ra8} solving/> });
  assert.ok(html.includes('<i data-part="feedback"></i><div class="try-check"><button type="button" class="secondary line-viewer-toggle" aria-expanded="false">See the tablebase line</button></div><i data-part="ladder"></i>'));
  assert.equal(count(html, 'line-viewer-toggle'), 1, 'one slot');
  // A drill's counted miss opens its viewer (not collapsed) where the layout keeps it open. FX2c (9.11.3, 9.10 h
  // extended): on a phone it too sits one press away right under the message, its toggle reading "See the line" (it
  // stayed open in the coach panel before).
  const kpk = drill('tech-kpk-take-the-opposition');
  const e4 = tryViewOf(tryKey(kpk.id, 0, 'e3e4'), kpk.fen, 'e3e4', [], gradeCardTry(kpk, kpk.fen, 'e3e4', 0, null))!;
  assert.equal(e4.collapsed, undefined);
  assert.equal(tryCollapsedOnPhone(kpk, e4), true);
  const e4Phone = render('phone', tryCollapsedOnPhone(kpk, e4), { ...markers, trySlot: <TrySlot view={e4} solving/> });
  assert.ok(e4Phone.includes('<i data-part="feedback"></i><div class="try-check"><button type="button" class="secondary line-viewer-toggle" aria-expanded="false">See the line</button></div><i data-part="ladder"></i>'));
  // Wiring: the page passes `tryCollapsedOnPhone` (done and one press away; a check still running never moves), and
  // renders one TrySlot.
  assert.match(src, /\}\} tryCollapsed=\{tryCollapsedOnPhone\(active, tryView\)\}\/> : dailyDone \?/);
  assert.equal(count(src, '<TrySlot '), 1);
  assert.match(body('PracticeColumns'), /const tryByBoard = phone && tryCollapsed;/);
  assert.match(body('PracticeColumns'), /\{phone && <div className="board-help">\{p\.controls\}\{p\.feedback\}\{tryByBoard && p\.trySlot\}\{p\.ladder\}<\/div>\}/);
  assert.match(body('PracticeColumns'), /\{!mid && !tryByBoard && p\.trySlot\}/);
});

/** A Lichess puzzle (the textbook French, 1.e4 e6 2.d4 d5): the card's moves are 3.Nc3 Nf6 4.Bg5. */
const FRENCH = 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6 0 3';
const bankCard = (): TrainerItem => ({ id: 'bank-french', fen: FRENCH, moves: ['b1c3', 'g8f6', 'c1g5'], rating: 1400, themes: ['opening', 'advantage'], gameUrl: '', source: 'bank' });

test('9.10 (h), the lead\'s 02:00 ruling: on a phone a Lichess puzzle\'s miss starts one press away right under the message line; wider, it stays open where it was', () => {
  const bank = bankCard();
  assert.deepEqual(sans(FRENCH, ['e4d5', 'e6d5', 'b1c3']), ['exd5', 'exd5', 'Nc3']);
  // 3.exd5? is counted at once (Lichess puzzles have one solution); the engine's check fills the viewer.
  const g = gradeCardTry(bank, FRENCH, 'e4d5', 0, { tryUci: 'e4d5', trySan: 'exd5', replyLine: ['e6d5', 'b1c3'], tryWin: 40, bestWin: 58, verdict: 'worse', depth: 12, ms: 5 });
  assert.deepEqual([g.grade.action, g.grade.tryVerdict, g.source, g.text!.title], ['error', 'worse', 'engine', "Why exd5 doesn't work"]);
  const view = tryViewOf(tryKey(bank.id, 0, 'e4d5'), FRENCH, 'e4d5', answerMovesFrom(bank, FRENCH, 0), g)!;
  assert.equal(view.collapsed, undefined, 'the view itself is open, as for every counted miss');
  assert.equal(tryCollapsedOnPhone(bank, view), true);
  const slotted = { ...markers, trySlot: <TrySlot view={view} solving/> };
  const at = (layout: PracticeLayout) => renderToStaticMarkup(<PracticeColumns layout={layout} parts={slotted} tryCollapsed={tryCollapsedOnPhone(bank, view)}/>);
  const openTitle = /<h3 [^>]*class="line-viewer-title">Why exd5 doesn&#x27;t work<\/h3>/;

  // Phone: "See the engine's reply" right after the message, before the hints shown; nothing open, nothing in the panel.
  const phone = at('phone');
  assert.ok(phone.includes('<i data-part="feedback"></i><div class="try-check"><button type="button" class="secondary line-viewer-toggle" aria-expanded="false">See the engine&#x27;s reply</button></div><i data-part="ladder"></i>'));
  assert.equal(count(phone, 'class="try-check"'), 1, 'one slot');
  assert.doesNotMatch(phone, openTitle);
  assert.ok(phone.indexOf('class="try-check"') < phone.indexOf('class="coach-panel"'), 'under the board, not in the coach panel');

  // Wide: open in the coach panel, as before the ruling. Mid: open under the board (.board-viewers), as before.
  const wide = at('wide'), mid = at('mid');
  for (const [layout, html] of [['wide', wide], ['mid', mid]] as const) {
    assert.match(html, openTitle, `${layout}: open`);
    assert.equal(count(html, 'line-viewer-toggle'), 0, `${layout}: no toggle`);
    assert.equal(count(html, 'class="try-check"'), 1, `${layout}: one slot`);
  }
  assert.ok(wide.indexOf('class="try-check"') > wide.indexOf('class="coach-panel"'), 'wide: in the coach panel');
  assert.ok(mid.indexOf('class="board-viewers"') < mid.indexOf('class="try-check"') && mid.indexOf('class="try-check"') < mid.indexOf('class="coach-panel"'), 'mid: under the board');
  // Outside PracticeColumns (no layout known) the slot keeps stage (c)'s open viewer.
  assert.match(renderToStaticMarkup(<TrySlot view={view} solving/>), openTitle);
  // While he solves the line still stops before the answer: the toggle opens exd5 exd5, never Nc3.
  assert.deepEqual(solvingTryLine(view), ['e4d5', 'e6d5']);

  // A check still running never moves: "Checking exd5…" stays in the coach panel on a phone.
  const checking: TryView = { key: view.key, status: 'checking', trySan: 'exd5', fenBefore: FRENCH, answers: view.answers, line: [], title: '' };
  assert.equal(tryCollapsedOnPhone(bank, checking), false);
  const running = renderToStaticMarkup(<PracticeColumns layout="phone" parts={{ ...markers, trySlot: <TrySlot view={checking} solving/> }} tryCollapsed={tryCollapsedOnPhone(bank, checking)}/>);
  assert.ok(running.indexOf('Checking exd5…') > running.indexOf('class="coach-panel"'));
  assert.equal(tryCollapsedOnPhone(bank, null), false, 'no try, nothing to move');

  // A line the spoiler cut leaves with his try alone (9.10 n) has no toggle: on a phone its words sit under the message.
  const cutBank: TrainerItem = { id: 'bank-cut', fen: CUT_FEN, moves: ['d1d8'], rating: 1000, themes: ['backRankMate'], gameUrl: '', source: 'bank' };
  const h3 = tryViewOf(tryKey(cutBank.id, 0, 'h2h3'), CUT_FEN, 'h2h3', answerMovesFrom(cutBank, CUT_FEN, 0),
    gradeCardTry(cutBank, CUT_FEN, 'h2h3', 0, { tryUci: 'h2h3', trySan: 'h3', replyLine: ['a8d8', 'd1d8'], tryWin: 40, bestWin: 70, verdict: 'worse', depth: 12, ms: 5 }))!;
  assert.deepEqual([solvingTryLine(h3), tryCollapsedOnPhone(cutBank, h3)], [[], true]);
  const words = renderToStaticMarkup(<PracticeColumns layout="phone" parts={{ ...markers, trySlot: <TrySlot view={h3} solving/> }} tryCollapsed={tryCollapsedOnPhone(cutBank, h3)}/>);
  assert.ok(words.includes(`<i data-part="feedback"></i><p class="try-check small">${esc('After h3 the engine gives White 40% to win; the best move keeps 70%.')}</p><i data-part="ladder"></i>`));

  // His own game's counted miss (a punish card, h6 at depth 12, worse). FX2c (9.11.3, 9.10 h extended): on a phone it
  // sits one press away right under the message too, "See the engine's reply" (it kept its open viewer in the coach
  // panel before); wider, it stays open in the coach panel.
  const punish = punishCard();
  assert.deepEqual(sans(punish.fen, ['h7h6', 'e7e1']), ['h6', 'Re1']);
  const miss = gradeCardTry(punish, punish.fen, 'h7h6', 0, { tryUci: 'h7h6', trySan: 'h6', replyLine: ['e7e1'], tryWin: 40, bestWin: 99.6, verdict: 'worse', depth: 12, ms: 5 });
  assert.equal(miss.grade.action, 'error');
  const own = tryViewOf(tryKey(punish.id, 0, 'h7h6'), punish.fen, 'h7h6', answerMovesFrom(punish, punish.fen, 0), miss)!;
  assert.equal(tryCollapsedOnPhone(punish, own), true);
  const ownAt = (layout: PracticeLayout) => renderToStaticMarkup(<PracticeColumns layout={layout} parts={{ ...markers, trySlot: <TrySlot view={own} solving/> }} tryCollapsed={tryCollapsedOnPhone(punish, own)}/>);
  const ownPhone = ownAt('phone');
  assert.ok(ownPhone.includes('<i data-part="feedback"></i><div class="try-check"><button type="button" class="secondary line-viewer-toggle" aria-expanded="false">See the engine&#x27;s reply</button></div><i data-part="ladder"></i>'));
  assert.doesNotMatch(ownPhone, /class="line-viewer-title"/, 'nothing open on a phone');
  assert.ok(ownPhone.indexOf('class="try-check"') < ownPhone.indexOf('class="coach-panel"'), 'under the board, not in the coach panel');
  const ownWide = ownAt('wide');
  assert.match(ownWide, /<h3 [^>]*class="line-viewer-title">Why h6 doesn&#x27;t work<\/h3>/);
  assert.ok(ownWide.indexOf('class="try-check"') > ownWide.indexOf('class="coach-panel"'), 'wide: open in the coach panel');

  // Wiring: the slot reads the placement from PracticeColumns (a context, so the page's one <TrySlot> call is unchanged).
  assert.match(body('PracticeColumns'), /return <TryByBoard\.Provider value=\{tryByBoard\}><div className="practice-layout">/);
  assert.match(body('TrySlot'), /const byBoard = useContext\(TryByBoard\);/);
  assert.match(body('TrySlot'), /const closed = view\.collapsed \|\| byBoard \? \{ defaultOpen: false,/);
  // FX2c (9.11.3): every finished try (it was a soft retry or a Lichess puzzle's miss only).
  assert.match(body('tryCollapsedOnPhone'), /return view\?\.status === 'done';/);
});

test('9.10 (i): off the phone the hint and reveal buttons follow the message, before the hints shown and the coach', () => {
  for (const layout of ['wide', 'mid'] as const) {
    const html = render(layout);
    once(html);
    assert.deepEqual(placed(html, 'coach-panel').slice(0, 5), ['head', 'feedback', 'controls', 'ladder', 'coach'], layout);
  }
  // The phone keeps the buttons first under the board.
  assert.deepEqual(placed(render('phone'), 'board-help')[0], 'controls');
  // The Ask Claude panel stays a direct child of the coach panel in the same slot in every layout (no remount).
  assert.match(body('PracticeColumns'), /<aside className="coach-panel">\s*\{p\.head\}\s*\{!phone && p\.feedback\}\s*\{!phone && p\.controls\}\s*\{!phone && p\.ladder\}\s*\{p\.coach\}/);
});

test('stylesheet: the fix-pass block (Part 9) appends layout rules only: no colour, no token, no comma selector', () => {
  const at = css.indexOf('/* ---- Part 9: M3 fix pass (FX2');
  assert.ok(at > css.indexOf('/* ---- Part 8: M3 trainer, stage (c)'), 'Part 9 after Part 8');
  // Fix round 2 appends Part 10 after it (tests/m3_fix2a_trainer.test.tsx); Part 9 itself is unchanged.
  const next = css.indexOf('/* ---- Part 10', at);
  const part = css.slice(at, next === -1 ? undefined : next);
  const rules = [...part.replace(/\/\*[^]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.equal(rules.length, 2);
  for (const [, sel, decl] of rules) {
    assert.doesNotMatch(sel, /,/, `no comma selector: ${sel.trim()}`);
    assert.doesNotMatch(decl, /#[0-9a-fA-F]{3,8}\b|rgba?\(|var\(|\bwhite\b|\bblack\b/, `no colour or token: ${sel.trim()}`);
    assert.doesNotMatch(sel.trim(), /\.text-button$/);
  }
  assert.match(part, /\.coach-panel>\.coach-actions\+\.hint-ladder\{margin-top:14px\}/, '(i) the hints keep a gap below the buttons');
  assert.match(part, /\.board-help>\.try-check\{margin:0\}/, '(h) spaced by the block\'s gap, like the other parts under the board');
});

// ---------------------------------------------------------------- (m) a short engine scan's line

test('9.10 (m): a short engine scan (Site import or page-made) is "The line after Nd5"; pack and punish cards keep "Why … works"', () => {
  const scan = scanCard();
  assert.equal(isEngineScanCard(scan), true);
  const open = renderToStaticMarkup(<SolvedViewers item={scan} assisted/>);
  assert.match(open, />The line after Nd5<\/h3>/);
  // FX2c (FX1c's R4-4): open at the start the viewer lists no move yet, then "…" (it listed the whole line before); the
  // line it steps through is the same line, read at its end.
  assert.doesNotMatch(open, /class="line-viewer-move"/);
  assert.match(open, /<li class="line-viewer-more"/);
  assert.match(renderToStaticMarkup(<LineViewer title="t" startFen={scan.fen} line={answerLineOf(scan)} orientation="w" initialStep={answerLineOf(scan).length}/>),
    /aria-label="1\. Nd5"[^]*aria-label="1\.\.\. Nxd5"[^]*aria-label="2\. Rxd5"/, 'the same line');
  assert.doesNotMatch(open, /why/i);
  assert.equal(renderToStaticMarkup(<SolvedViewers item={scan} assisted={false}/>),
    '<div class="teach-viewers"><button type="button" class="secondary line-viewer-toggle" aria-expanded="false">Show the line</button></div>');
  // A Site backup may hold a position without the 'personal' theme (tests/b3_siteBackup.test.ts has one): still a scan.
  const untagged: TrainerItem = { ...scan, themes: ['mateIn1'] };
  assert.equal(isEngineScanCard(untagged), true);
  // Not a short scan: pack mistake cards and punish cards (they carry the 'personal' theme too; their lines come from
  // the offline engine pass), Lichess puzzles and drills.
  const bank: TrainerItem = { ...scan, id: 'bank-x', themes: ['fork'], source: 'bank' };
  for (const item of [mistakeCard(), punishCard(), bank, drill('tech-kpk-take-the-opposition')]) assert.equal(isEngineScanCard(item), false, item.id);
  assert.match(renderToStaticMarkup(<SolvedViewers item={mistakeCard()} assisted/>), />Why Qxd8# works<\/h3>/);
  assert.match(renderToStaticMarkup(<SolvedViewers item={punishCard()} sibling={siblingCard()} assisted/>), />Why Rd1\+ works<\/h3>/);
  assert.match(renderToStaticMarkup(<SolvedViewers item={punishCard()} sibling={siblingCard()} assisted={false}/>), />Show why it works<\/button>/);
});

// ---------------------------------------------------------------- (n) a try line cut down to the try alone

test('9.10 (n): while he solves, a try line the spoiler cut leaves with his try alone shows no viewer; complete, it is whole', () => {
  const intro = 'After h3 the engine gives White 40% to win; the best move keeps 70%.';
  // Fix round 2 (9.11.2 t 1): the answers by identity. Black's ...Rd8 is not the answer (another rook, another side) and no
  // longer cuts by its name; White's Rxd8# is the answer itself (the rook from d1 to d8), and the caption of ...Rd8
  // ("…, but it allows mate in one.") points at that very mate, so the cut still leaves his try alone.
  const answers = answerMovesFrom({ moves: ['d1d8'] }, CUT_FEN, 0);
  assert.deepEqual(answers, [{ from: 'd1', to: 'd8', piece: 'r', san: 'Rd8+' }]);
  const view: TryView = { key: 'k', status: 'done', trySan: 'h3', fenBefore: CUT_FEN, line: ['h2h3', 'a8d8', 'd1d8'], title: "Why h3 doesn't work", intro, answers, source: 'engine' };
  assert.deepEqual(cutBeforeAnswer(CUT_FEN, view.line, view.answers), ['h2h3'], 'the cut leaves his try alone');
  assert.deepEqual(solvingTryLine(view), []);
  // No viewer, open or one press away: the result in words; without words, nothing.
  for (const v of [view, { ...view, collapsed: true }]) assert.equal(renderToStaticMarkup(<TrySlot view={v} solving/>), `<p class="try-check small">${esc(intro)}</p>`);
  assert.equal(renderToStaticMarkup(<TrySlot view={{ ...view, intro: undefined }} solving/>), '');
  // Once the card is complete the whole line shows. FX2c (FX1c's R4-4 and 9.11.3 R6-3): the viewer opens on the try and
  // lists the moves up to the step on the board, then "…" (it listed the whole line before); the line it steps through is
  // the whole line (the wiring at the end; read at its end here).
  const moves = (html: string) => [...html.matchAll(/class="line-viewer-move"[^>]*aria-label="([^"]+)"/g)].map(m => m[1]);
  const complete = renderToStaticMarkup(<TrySlot view={view} solving={false}/>);
  assert.deepEqual(moves(complete), ['1. h3']);
  assert.match(complete, /<li class="line-viewer-more"/);
  assert.match(renderToStaticMarkup(<LineViewer title="t" startFen={CUT_FEN} line={view.line} orientation="w" initialStep={view.line.length}/>),
    /aria-label="1\. h3"[^]*aria-label="1\.\.\. Rd8"[^]*aria-label="2\. Rxd8#"/);
  // A cut that keeps the reply still shows the viewer, on the try, with the reply to come.
  const kept: TryView = { ...view, line: ['h2h3', 'g8f8', 'd1d8'] };
  assert.deepEqual(solvingTryLine(kept), ['h2h3', 'g8f8']);
  const keptHtml = renderToStaticMarkup(<TrySlot view={kept} solving/>);
  assert.deepEqual(moves(keptHtml), ['1. h3']);
  assert.match(keptHtml, /<li class="line-viewer-more"/);
  // A line that was his try alone before any cut stays: the drill's stalemating try shows the position it leaves.
  const krk = drill('tech-krk-mate-in-two-king-step');
  const rg7 = drillTeach(krk.id)!.steps.find(s => s.step === 0)!.tries.find(t => t.san === 'Rg7')!;
  const stale = tryViewOf(tryKey(krk.id, 0, rg7.uci), krk.fen, rg7.uci, answerMovesFrom(krk, krk.fen, 0), gradeCardTry(krk, krk.fen, rg7.uci, 0, null))!;
  assert.deepEqual(stale.line, [rg7.uci]);
  assert.deepEqual(solvingTryLine(stale), [rg7.uci]);
  assert.match(renderToStaticMarkup(<TrySlot view={stale} solving/>), /<section [^>]*class="line-viewer"/);
  // Wiring.
  assert.match(body('TrySlot'), /solving \? solvingTryLine\(view\) : view\.line/);
});
