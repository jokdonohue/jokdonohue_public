/**
 * M3 fix round 2, stage 2 repair round 1, writer FXR2b1 (brief 9.11.8): `omit` takes a list, and an answer move that a
 * caption would describe as a discovered attack or as "lets … pin" is left out.
 * - narrate.ts: `omit` is one `MoveRef`, a list of them, or none; every rule applies to each move in the list, and one
 *   move reads exactly as a list of one. For each move, "uncovers {by} against {target}" is left out when `by` is the
 *   move's piece on its from-square and `target` sits on its to-square, and "lets {by} pin {pinned} to {behind}" when
 *   `by` is that piece on that square and `pinned` or `behind` sits on its to-square. The next discovered attack or pin
 *   that no listed move describes is named instead; the rest of the caption stays.
 * - LineViewer.tsx: `omit` and `ViewerNarrateOptions.omit` take the list; an empty list leaves nothing out.
 * - Trainer.tsx: while he solves, `tryViewerOptions(view, true).omit` is the whole `view.answers` list.
 *
 * Positions are invented, each checked with chess.js. No owner game data and no bank puzzle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chess } from 'chess.js';
import LineViewer, { lineNarration } from '../components/LineViewer';
import { answerMovesFrom, cutBeforeAnswer, solvingTryLine, TrySlot, tryViewerOptions, type TryView } from '../components/Trainer';
import { narrateLine, omitRefs, type MoveRef } from '../src/teach/narrate';
import { ARTIFACT_DIR } from './b3_paths';

/** SAN of each move of `line` from `fen` (throws on an illegal move). */
const sans = (fen: string, line: readonly string[]) => { const b = new Chess(fen); return line.map(u => b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); };
const legal = (fen: string) => { const b = new Chess(fen); assert.equal(b.inCheck(), false, `fixture: no side in check (${fen})`); return b; };
/** Each step's caption as the viewer shows it (`caption` when the narrator split the sentence, else `text`). */
const captions = (fen: string, line: readonly string[], omit?: MoveRef | readonly MoveRef[] | null) =>
  narrateLine(fen, line, omit === undefined ? undefined : { omit }).plies.map(p => p.caption ?? p.text);
const captionOf = (html: string) => /<p class="line-viewer-caption" aria-live="polite">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? null;
/** A move that no clause of these lines describes. */
const UNRELATED: MoveRef = { from: 'a1', to: 'a2', piece: 'k' };

// ------------------------------------------------------------------ fixtures (invented)

/** White Kg1 Re1 Ne4; Black Kg8 Ne7. Any knight move opens the e-file: the rook on e1 then attacks the knight on e7. */
const DISC = '6k1/4n3/8/8/4N3/8/8/4R1K1 w - - 0 1';
/** The rook from e1 taking on e7: the later answer move the discovered attack would describe. */
const RXE7: MoveRef = { from: 'e1', to: 'e7', piece: 'r' };
/** White Kh1 Re1 Bc2 Ne4; Black Kg8 Ne7 Rg6. Nc5 opens two lines: the bishop on c2 to g6 and the rook on e1 to e7. */
const TWO = '6k1/4n3/6r1/8/4N3/8/2B5/4R2K w - - 0 1';
const BXG6: MoveRef = { from: 'c2', to: 'g6', piece: 'b' };
/** White Kg1 Re1 Ne3; Black Ke8, pawn e6. Nc4 lets the rook on e1 pin the pawn on e6 to the king (no discovered
 *  attack: a pawn is not a target worth 3). */
const PIN = '4k3/8/4p3/8/8/4N3/8/4R1K1 w - - 0 1';
const RXE6: MoveRef = { from: 'e1', to: 'e6', piece: 'r' };
/** White Kg1 Re1 Ne3; Black Kg8 Qe8 Ne6. Nc4 uncovers the rook against the knight and pins it to the queen. */
const PIN_Q = '4q1k1/8/4n3/8/8/4N3/8/4R1K1 w - - 0 1';
const RXE8: MoveRef = { from: 'e1', to: 'e8', piece: 'r' };

test('fixtures: legal invented positions and the moves the tests play', () => {
  for (const fen of [DISC, TWO, PIN, PIN_Q]) legal(fen);
  assert.deepEqual(sans(DISC, ['e4c5', 'g8f8']), ['Nc5', 'Kf8']);
  assert.deepEqual(sans(DISC, ['e4g5', 'g8h8', 'e1e7']), ['Ng5', 'Kh8', 'Rxe7']);
  assert.deepEqual(sans(TWO, ['e4c5']), ['Nc5']);
  assert.deepEqual(sans(PIN, ['e3c4']), ['Nc4']);
  assert.deepEqual(sans(PIN_Q, ['e3c4']), ['Nc4']);
  // The facts the clauses come from (they keep everything, with or without `omit`).
  for (const omit of [undefined, [RXE7]]) {
    const n = narrateLine(DISC, ['e4c5'], omit ? { omit } : undefined);
    assert.deepEqual(n.plies[0].facts.discovered.map(d => `${d.by.piece}${d.by.square}>${d.target.piece}${d.target.square}`), ['re1>ne7']);
  }
  assert.deepEqual(narrateLine(PIN_Q, ['e3c4'], { omit: [RXE6] }).plies[0].facts.pins.map(p => `${p.by.square}:${p.pinned.square}>${p.behind.square}`), ['e1:e6>e8']);
});

// ------------------------------------------------------------------ narrate.ts: the discovered-attack clause

test('9.11.8: the discovered-attack clause is left out when a listed move is that piece from its square onto the target', () => {
  const line = ['e4c5', 'g8f8'];
  const plain = captions(DISC, line);
  assert.deepEqual(plain, ['Nc5 uncovers the rook on e1 against the knight on e7.', 'Kf8 moves the king to f8.']);
  // The answer at this step (another move) first, the later answer Rxe7 second: the clause is gone, and the caption
  // still reads as a sentence.
  const list = [{ from: 'e4', to: 'g5', piece: 'n' } as MoveRef, RXE7];
  assert.deepEqual(captions(DISC, line, list), ['Nc5 moves the knight to c5.', 'Kf8 moves the king to f8.']);
  // Unrelated moves keep it: another move, the same piece from the same square to another square, another piece on
  // the same squares.
  for (const omit of [[UNRELATED], [{ from: 'e4', to: 'g5', piece: 'n' } as MoveRef], [{ from: 'e1', to: 'e5', piece: 'r' } as MoveRef],
    [{ from: 'e1', to: 'e7', piece: 'q' } as MoveRef], [{ from: 'e2', to: 'e7', piece: 'r' } as MoveRef]]) {
    assert.deepEqual(captions(DISC, line, omit), plain, JSON.stringify(omit));
  }
  // The summary and the facts: unchanged here (the king on f8 guards the knight, so nothing is pending).
  assert.equal(narrateLine(DISC, line, { omit: list }).summary, narrateLine(DISC, line).summary);
  assert.equal(narrateLine(DISC, line, { omit: list }).material.settled, narrateLine(DISC, line).material.settled);
});

test('9.11.8: the next discovered attack that no listed move describes is named instead', () => {
  assert.deepEqual(captions(TWO, ['e4c5']), ['Nc5 uncovers the bishop on c2 against the rook on g6.']);
  assert.deepEqual(captions(TWO, ['e4c5'], [BXG6]), ['Nc5 uncovers the rook on e1 against the knight on e7.']);
  assert.deepEqual(captions(TWO, ['e4c5'], [UNRELATED, BXG6, RXE7]), ['Nc5 moves the knight to c5.'], 'the substitute is tested against every move');
  assert.deepEqual(captions(TWO, ['e4c5'], [RXE7]), ['Nc5 uncovers the bishop on c2 against the rook on g6.']);
});

// ------------------------------------------------------------------ narrate.ts: "lets … pin"

test('9.11.8: "lets … pin" is left out when a listed move is the pinner from its square onto the pinned piece', () => {
  assert.deepEqual(captions(PIN, ['e3c4']), ['Nc4 lets the rook on e1 pin the pawn on e6 to the king.']);
  assert.deepEqual(captions(PIN, ['e3c4'], [UNRELATED, RXE6]), ['Nc4 moves the knight to c4.']);
  assert.deepEqual(captions(PIN, ['e3c4'], [UNRELATED]), ['Nc4 lets the rook on e1 pin the pawn on e6 to the king.']);
  assert.deepEqual(captions(PIN, ['e3c4'], [{ from: 'e1', to: 'e5', piece: 'r' }]), ['Nc4 lets the rook on e1 pin the pawn on e6 to the king.']);
});

test('9.11.8: "lets … pin" also goes when the listed move lands on the piece behind; the discovered attack stays then', () => {
  const plain = 'Nc4 uncovers the rook on e1 against the knight on e6. It also lets the rook on e1 pin the knight on e6 to the queen on e8.';
  assert.deepEqual(captions(PIN_Q, ['e3c4']), [plain]);
  // Onto the queen behind: only the pin describes that move; the rest of the caption stays.
  assert.deepEqual(captions(PIN_Q, ['e3c4'], [UNRELATED, RXE8]), ['Nc4 uncovers the rook on e1 against the knight on e6.']);
  // Onto the pinned knight: both clauses describe it.
  assert.deepEqual(captions(PIN_Q, ['e3c4'], [RXE6]), ['Nc4 moves the knight to c4.']);
  assert.deepEqual(captions(PIN_Q, ['e3c4'], [UNRELATED]), [plain]);
});

// ------------------------------------------------------------------ narrate.ts: a list, one move, none

test('9.11.8: one move reads exactly as a list of one; null, undefined and an empty list leave nothing out', () => {
  const cases: Array<[string, string[], MoveRef]> = [
    [DISC, ['e4c5', 'g8f8'], RXE7],
    [DISC, ['e4c5', 'g8h8'], RXE7],
    [PIN, ['e3c4'], RXE6],
    // fix round 2's invented summary positions (m3_fix2a_narrate): loose piece, take-back, mate, promotion, fork.
    ['6k1/3p4/8/6b1/8/5N2/7P/6K1 w - - 0 1', ['h2h3', 'd7d6'], { from: 'f3', to: 'g5', piece: 'n' }],
    ['3b2k1/7p/8/6P1/8/5N2/7P/6K1 w - - 0 1', ['h2h3', 'd8g5'], { from: 'f3', to: 'g5', piece: 'n' }],
    ['4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', ['d1d7'], { from: 'e8', to: 'e1', piece: 'r' }],
    ['8/2k4b/8/6N1/8/1p6/6PP/7K w - - 0 1', ['g5h7', 'b3b2'], { from: 'b2', to: 'b1', piece: 'p', promotion: 'q' }],
    ['6k1/2r3pp/5r2/8/1N6/7P/5PP1/6K1 w - - 0 1', ['b4d5'], { from: 'd5', to: 'c7', piece: 'n' }],
  ];
  for (const [fen, line, ref] of cases) {
    const one = narrateLine(fen, line, { omit: ref });
    assert.deepEqual(narrateLine(fen, line, { omit: [ref] }), one, `${fen} ${line.join(' ')}`);
    assert.deepEqual(narrateLine(fen, line, { omit: [UNRELATED, ref] }), one, 'its place in the list does not matter');
    const plain = narrateLine(fen, line);
    for (const none of [null, undefined, [] as MoveRef[], [UNRELATED]]) assert.deepEqual(narrateLine(fen, line, { omit: none }), plain, JSON.stringify(none));
  }
  assert.deepEqual(omitRefs(RXE7), [RXE7]);
  assert.deepEqual(omitRefs([RXE7, RXE6]), [RXE7, RXE6]);
  for (const none of [null, undefined, [] as MoveRef[]]) assert.deepEqual(omitRefs(none), []);
  assert.deepEqual(omitRefs([RXE7, null as unknown as MoveRef]), [RXE7], 'an entry that is not an object is skipped');
});

test('9.11.8: every summary rule reads each move of the list (loose piece, take-back, mate, promotion, fork)', () => {
  // The loose piece: after Nc5 Kh8 the rook on e1 can take the knight on e7, and Rxe7 is a later answer.
  assert.equal(narrateLine(DISC, ['e4c5', 'g8h8']).summary, 'So far in this line no material changes hands, but the rook on e1 can take the knight on e7.');
  const loose = narrateLine(DISC, ['e4c5', 'g8h8'], { omit: [{ from: 'e4', to: 'g5', piece: 'n' }, RXE7] });
  assert.equal(loose.summary, 'So far in this line no material changes hands.');
  assert.deepEqual(loose.plies.map(p => p.caption ?? p.text), ['Nc5 moves the knight to c5.', 'Kh8 moves the king to h8.']);
  assert.equal(loose.material.settled, false, 'leaving the clause out never settles the line');
  // m3_fix2a_narrate's single-move cases, with the move second in a list.
  assert.equal(narrateLine('3b2k1/7p/8/6P1/8/5N2/7P/6K1 w - - 0 1', ['h2h3', 'd8g5'], { omit: [UNRELATED, { from: 'f3', to: 'g5', piece: 'n' }] }).summary,
    'So far in this line Black has won a pawn.');
  assert.equal(narrateLine('4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', ['d1d7'], { omit: [UNRELATED, { from: 'e8', to: 'e1', piece: 'r' }] }).summary,
    'So far in this line no material changes hands.');
  assert.equal(narrateLine('8/2k4b/8/6N1/8/1p6/6PP/7K w - - 0 1', ['g5h7', 'b3b2'], { omit: [UNRELATED, { from: 'b2', to: 'b1', piece: 'p', promotion: 'q' }] }).summary,
    'So far in this line White has won a bishop.');
  assert.equal(narrateLine('6k1/2r3pp/5r2/8/1N6/7P/5PP1/6K1 w - - 0 1', ['b4d5'], { omit: [UNRELATED, { from: 'd5', to: 'c7', piece: 'n' }] }).summary,
    'So far in this line no material changes hands.');
  // Controls: with the unrelated move alone, each clause is there.
  assert.match(narrateLine('3b2k1/7p/8/6P1/8/5N2/7P/6K1 w - - 0 1', ['h2h3', 'd8g5'], { omit: [UNRELATED] }).summary, /White can take back on g5/);
  assert.match(narrateLine('4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', ['d1d7'], { omit: [UNRELATED] }).summary, /Black can mate in one: Re1#/);
  assert.match(narrateLine('8/2k4b/8/6N1/8/1p6/6PP/7K w - - 0 1', ['g5h7', 'b3b2'], { omit: [UNRELATED] }).summary, /pawn on b2 can promote/);
  assert.match(narrateLine('6k1/2r3pp/5r2/8/1N6/7P/5PP1/6K1 w - - 0 1', ['b4d5'], { omit: [UNRELATED] }).summary, /the knight on d5 attacks/);
});

// ------------------------------------------------------------------ LineViewer.tsx

test('9.11.8: the viewer takes a list for `omit`; an empty list is no omit', () => {
  const line = ['e4c5', 'g8f8'];
  const view = (omit?: MoveRef | readonly MoveRef[] | null) =>
    renderToStaticMarkup(<LineViewer title="What could follow Nc5" startFen={DISC} line={line} orientation="w" initialStep={1} omit={omit}/>);
  assert.equal(captionOf(view()), '<strong>1. Nc5</strong> uncovers the rook on e1 against the knight on e7.');
  assert.equal(captionOf(view([{ from: 'e4', to: 'g5', piece: 'n' }, RXE7])), '<strong>1. Nc5</strong> moves the knight to c5.');
  assert.equal(captionOf(view(RXE7)), '<strong>1. Nc5</strong> moves the knight to c5.', 'one move, as before');
  assert.equal(captionOf(view([])), captionOf(view()));
  // A narration passed in is used with no omit, null or an empty list, and narrated again with a list that has a move.
  const given = { ...narrateLine(DISC, line), summary: 'The given summary.' };
  for (const omit of [undefined, null, [] as MoveRef[]]) assert.equal(lineNarration(DISC, line, given, { omit }), given, JSON.stringify(omit));
  assert.notEqual(lineNarration(DISC, line, given, { omit: [RXE7] }), given);
  assert.equal(lineNarration(DISC, line, given, { omit: [RXE7] }).plies[0].text, 'Nc5 moves the knight to c5.');
  // The memo key reads every move of the list (a static render cannot change props; the source is pinned instead).
  const viewerSrc = readFileSync(join(ARTIFACT_DIR, 'components/LineViewer.tsx'), 'utf8');
  assert.match(viewerSrc, /const omitKey = omitRefs\(omit\)\.map\(o => `\$\{o\.piece\}\$\{o\.from\}\$\{o\.to\}\$\{o\.promotion \?\? ''\}`\)\.join\(' '\);/);
  assert.match(viewerSrc, /\[key, narrated, open, verdictKey, omitKey, noChangeSentence\]/);
});

// ------------------------------------------------------------------ Trainer.tsx

test('9.11.8: while he solves the try viewer leaves out every move still to find (`omit` is the whole list)', () => {
  // An invented card on DISC: 1.Ng5 Kh8 2.Rxe7. His try 1.Nc5 opens the e-file, and the try line 1.Nc5 Kf8 would say the
  // rook on e1 is uncovered against the knight on e7, which is the card's second move by identity.
  const answers = answerMovesFrom({ moves: ['e4g5', 'g8h8', 'e1e7'] }, DISC, 0);
  assert.deepEqual(answers, [{ from: 'e4', to: 'g5', piece: 'n', san: 'Ng5' }, { from: 'e1', to: 'e7', piece: 'r', san: 'Rxe7' }]);
  const view: TryView = { key: 'k', status: 'done', trySan: 'Nc5', fenBefore: DISC, line: ['e4c5', 'g8f8'], title: 'What could follow Nc5', answers, source: 'engine' };
  assert.deepEqual(tryViewerOptions(view, true), { verdict: null, omit: answers, noChangeSentence: false });
  assert.equal((tryViewerOptions(view, true).omit as readonly MoveRef[]).length, 2, 'not only the move at this step');
  assert.equal(tryViewerOptions(view, false).omit, null, 'complete: nothing left out');
  assert.deepEqual(tryViewerOptions({ answers: [] }, true).omit, [], 'no move replays: an empty list, which leaves nothing out');
  // Before 9.11.8 the viewer left out the first move alone, and this caption named the second.
  assert.match(lineNarration(DISC, view.line, undefined, { omit: answers[0], noChangeSentence: false }).plies[0].text, /uncovers the rook on e1 against the knight on e7/);
  const solving = lineNarration(DISC, view.line, undefined, tryViewerOptions(view, true));
  assert.deepEqual(solving.plies.map(p => p.caption ?? p.text), ['Nc5 moves the knight to c5.', 'Kf8 moves the king to f8.']);
  // The cut reads the line with the same options: nothing in it describes an answer, so nothing is cut.
  assert.deepEqual(cutBeforeAnswer(DISC, view.line, answers, tryViewerOptions(view, true)), ['e4c5', 'g8f8']);
  assert.deepEqual(solvingTryLine(view), ['e4c5', 'g8f8']);
  // On the page: the open viewer (on the try, R6-3) while he solves, and once the card is complete.
  const open = renderToStaticMarkup(<TrySlot view={view} solving/>);
  assert.equal(captionOf(open), '<strong>1. Nc5</strong> moves the knight to c5.');
  assert.doesNotMatch(open, /uncovers the rook on e1/);
  assert.equal(captionOf(renderToStaticMarkup(<TrySlot view={view} solving={false}/>)), '<strong>1. Nc5</strong> uncovers the rook on e1 against the knight on e7.');
});
