/**
 * FX1c, fix round 2 stage 2 (brief 9.11.3): the narrator and the line viewer.
 * - R4-4 and R6-3: the move list shows the moves up to the step on the board and "…" while more remain; the legend
 *   at step 0 is "Press Next to step through the line."; later steps keep "Guess the next move, then press Next.".
 * - R4-6: a caption with three or more facts (or over 25 words) is split, so no sentence runs over 25 words; the
 *   cross-check sentence reads "blocks the check and gives check".
 * - "forks" only when the forking piece cannot legally be taken; otherwise "gives check and attacks …" or
 *   "attacks … and …".
 * - The side condition on (r) 1: the last mover's check, promoting pawn and protected fork open the line only when the
 *   last mover is level or behind in the count.
 * - "About level": a verdict that gives the named material winner 50 to 54 (rounded).
 * Positions: public Lichess bank puzzles read from the bundled bank by id, and invented positions, each replayed with
 * chess.js before a sentence is pinned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chess } from 'chess.js';
import LineViewer, { focusAfterStep, legendFor, lineNarration, withCaptions } from '../components/LineViewer';
import { describeMove, narrateLine } from '../src/teach/narrate';
import { ARTIFACT_DIR } from './b3_paths';

const bank: Array<{ id: string; fen: string; moves: string[]; themes?: string[] }> = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'data/puzzles.json'), 'utf8'));
const puzzle = (id: string) => {
  const p = bank.find(x => x.id === id);
  assert.ok(p, `the bundled bank holds ${id}`);
  return p;
};
/** SAN of each move, and the end position: chess.js replays the line before any sentence is pinned. */
const replay = (fen: string, line: readonly string[]) => {
  const b = new Chess(fen);
  const sans = line.map(u => b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
  return { sans, end: b };
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const legendOf = (html: string) => /<p class="line-viewer-legend">([^<]*)<\/p>/.exec(html)?.[1] ?? null;
const captionOf = (html: string) => /<p class="line-viewer-caption" aria-live="polite">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? null;
const summaryOf = (html: string) => /<p class="line-viewer-summary">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? null;
const moveList = (html: string) => /<ol class="line-viewer-moves" role="list" aria-label="Moves in the line">([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? null;
/** The moves the list shows: aria-label, the step it is for, and whether it is current. */
const listed = (html: string) => [...(moveList(html) ?? '').matchAll(/<button type="button" class="line-viewer-move" data-ply="(\d+)"( aria-current="step")? aria-label="([^"]+)">/g)]
  .map(m => ({ ply: Number(m[1]), current: !!m[2], name: m[3] }));
const MORE = '<li class="line-viewer-more" style="align-self:center;padding:0 4px;color:var(--muted)"><span aria-hidden="true">…</span><span class="sr-only">More moves follow.</span></li>';
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const sentencesOf = (s: string) => s.split(/(?<=[.?])\s+/);
const START = new Chess().fen();

// ------------------------------------------------------------------ R4-4 and R6-3: the move list and the legend

test('R4-4: at step 0 the list shows no move, only "…", and the legend says how to step (R4\'s own repro line)', () => {
  // R4's repro: "Why e4 works" over 1.e4 e5 2.Nf3 Nc6 asked him to guess e4 while the title and the list showed it.
  const html = renderToStaticMarkup(<LineViewer title="Why e4 works" startFen={START} line={['e2e4', 'e7e5', 'g1f3', 'b8c6']} orientation="w"/>);
  assert.equal(legendOf(html), 'Press Next to step through the line.');
  assert.deepEqual(listed(html), []);
  assert.equal(moveList(html), MORE);
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) assert.doesNotMatch(moveList(html)!, new RegExp(`\\b${san}\\b`), `${san} is not listed yet`);
});

test('R4-4: each step lists the moves played so far, the last one current, and "…" until the end of the line', () => {
  const line = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'];
  const names = ['1. e4', '1... e5', '2. Nf3', '2... Nc6', '3. Bb5'];
  for (let k = 0; k <= line.length; k++) {
    const html = renderToStaticMarkup(<LineViewer title="The line" startFen={START} line={line} orientation="w" initialStep={k}/>);
    const shown = listed(html);
    assert.deepEqual(shown.map(m => m.name), names.slice(0, k), `step ${k}`);
    assert.deepEqual(shown.map(m => m.ply), Array.from({ length: k }, (_, i) => i + 1), `step ${k}: each button carries its step`);
    assert.deepEqual(shown.map(m => m.current), Array.from({ length: k }, (_, i) => i === k - 1), `step ${k}: the move on the board is current`);
    assert.equal(moveList(html)!.endsWith(MORE), k < line.length, `step ${k}: "…" while more remain`);
    assert.equal(legendOf(html), k === 0 ? 'Press Next to step through the line.' : k < line.length ? 'Guess the next move, then press Next.' : 'End of the line.');
  }
});

test('R6-3: a try viewer opened at step 1 shows his try alone and asks him to guess the reply', () => {
  // Invented: 1.h3 e5 2.Nxe5 from a quiet position (the try viewer FX2c opens at initialStep 1).
  const fen = '6k1/3p4/8/8/8/5N2/7P/6K1 w - - 0 1';
  assert.deepEqual(replay(fen, ['h2h3', 'd7d5', 'f3e5']).sans, ['h3', 'd5', 'Ne5']);
  const html = renderToStaticMarkup(<LineViewer title="Why h3 doesn't work" startFen={fen} line={['h2h3', 'd7d5', 'f3e5']} orientation="w" initialStep={1}/>);
  assert.deepEqual(listed(html).map(m => m.name), ['1. h3']);
  assert.ok(moveList(html)!.endsWith(MORE));
  assert.equal(legendOf(html), 'Guess the next move, then press Next.');
  assert.doesNotMatch(moveList(html)!, /\bd5\b|\bNe5\b/, 'the reply and the move after it are not listed');
});

test('R4-4: legend and focus helpers (pure)', () => {
  assert.equal(legendFor(0, 5), 'Press Next to step through the line.');
  assert.equal(legendFor(1, 5), 'Guess the next move, then press Next.');
  assert.equal(legendFor(4, 5), 'Guess the next move, then press Next.');
  assert.equal(legendFor(5, 5), 'End of the line.');
  assert.equal(legendFor(0, 1), 'Press Next to step through the line.', 'a one-move line still starts by saying how to step');
  // A step back removes the move buttons after the new step. Focus on one of those follows to the move now current,
  // or to Next when no move is left in the list; focus anywhere else stays where it is.
  assert.equal(focusAfterStep(null, 0), null, 'the focus is not on a move button');
  assert.equal(focusAfterStep(3, 3), null, 'the focused move is still listed');
  assert.equal(focusAfterStep(2, 4), null, 'a step forward never removes a button');
  assert.equal(focusAfterStep(4, 3), 'move');
  assert.equal(focusAfterStep(4, 0), 'next');
  assert.equal(focusAfterStep(1, 0), 'next');
});

test('the collapsed viewer is still one button, with nothing narrated or listed', () => {
  const html = renderToStaticMarkup(<LineViewer title="t" startFen={START} line={['e2e4', 'e7e5']} orientation="w" defaultOpen={false}/>);
  assert.equal(html, '<button type="button" class="secondary line-viewer-toggle" aria-expanded="false">Show the line</button>');
});

// ------------------------------------------------------------------ R4-6: captions split; one sentence for every other reader

test('R4-6: two facts and a "but" make three, so the caption is two sentences; `text` stays one sentence', () => {
  // Invented. White Kg1 Bc4; Black Kh8 Qe8 Rf8, pawn f7. Bxf7 hits the queen, and the rook can take the bishop.
  const fen = '4qr1k/5p2/8/8/2B5/8/8/6K1 w - - 0 1';
  assert.deepEqual(replay(fen, ['c4f7']).sans, ['Bxf7']);
  const p = describeMove(fen, 'c4f7')!;
  assert.equal(p.text, 'Bxf7 takes the pawn on f7 and attacks the queen on e8, but the rook on f8 can take the bishop on f7.');
  assert.equal(p.caption, 'Bxf7 takes the pawn on f7 and attacks the queen on e8. But the rook on f8 can take the bishop on f7.');
  // The viewer shows the caption at that step.
  const html = renderToStaticMarkup(<LineViewer title="t" startFen={fen} line={['c4f7']} orientation="w" initialStep={1}/>);
  assert.equal(captionOf(html), `<strong>1. Bxf7</strong> ${esc('takes the pawn on f7 and attacks the queen on e8. But the rook on f8 can take the bishop on f7.')}`);
});

test('R4-6: a sentence of two facts over 25 words is split too', () => {
  // Invented. White Kg1 Qh3 Bb5 Nd7; Black Ke8 Nc6 Nf4. Nf8 opens the bishop's pin, and the queen on h3 hangs to a
  // knight that takes it with check.
  const fen = '4k3/3N4/2n5/1B6/5n2/7Q/8/6K1 w - - 0 1';
  assert.deepEqual(replay(fen, ['d7f8']).sans, ['Nf8']);
  const p = describeMove(fen, 'd7f8')!;
  assert.equal(p.text, 'Nf8 lets the bishop on b5 pin the knight on c6 to the king, but the knight on f4 can take the queen on h3 with check.');
  assert.equal(words(p.text), 27);
  assert.equal(p.caption, 'Nf8 lets the bishop on b5 pin the knight on c6 to the king. But the knight on f4 can take the queen on h3 with check.');
  for (const s of sentencesOf(p.caption!)) assert.ok(words(s) <= 25, s);
});

test('R4-6: three facts in the clauses read "A, B and C" in `text`, and "It also" starts the caption\'s second sentence', () => {
  // Public bank 02FEH: its fourth move takes, promotes with check and hits a rook.
  const p = puzzle('02FEH');
  const n = narrateLine(p.fen, p.moves, { maxPlies: p.moves.length, nameMate: false });
  const ply = n.plies[3];
  assert.equal(ply.san, 'bxc1=Q+');
  assert.equal(ply.text, 'bxc1=Q+ takes the knight on c1, promotes with check and attacks the undefended rook on b1.');
  assert.equal(ply.caption, 'bxc1=Q+ takes the knight on c1 and promotes with check. It also attacks the undefended rook on b1.');
});

test('R4-6: the mate clause splits the same way, and keeps or leaves out the mating move as asked', () => {
  // Public bank 00Kbj: its fourth move blocks the check and hits a rook, but allows mate in one.
  const p = puzzle('00Kbj');
  const viewer = narrateLine(p.fen, p.moves, { maxPlies: p.moves.length, nameMate: false }).plies[3];
  assert.equal(viewer.text, 'Rd1 blocks the check and attacks the undefended rook on a1, but it allows mate in one.');
  assert.equal(viewer.caption, 'Rd1 blocks the check and attacks the undefended rook on a1. But it allows mate in one.');
  const lesson = narrateLine(p.fen, p.moves, { maxPlies: p.moves.length }).plies[3];
  assert.ok(lesson.facts.allowsMate, 'fixture: the move allows mate in one');
  assert.equal(lesson.text, `Rd1 blocks the check and attacks the undefended rook on a1, but it allows mate in one: ${lesson.facts.allowsMate}.`);
  assert.equal(lesson.caption, `Rd1 blocks the check and attacks the undefended rook on a1. But it allows mate in one: ${lesson.facts.allowsMate}.`);
});

test('R4-6: two facts under 25 words keep one sentence and get no caption', () => {
  // Scholar's mate: 3...Nf6 forks the queen and the pawn, but allows Qxf7#. Two facts, 15 words.
  const n = narrateLine(START, ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'], { nameMate: false });
  assert.equal(n.plies[5].text, 'Nf6 forks the queen on h5 and the pawn on e4, but it allows mate in one.');
  assert.equal(n.plies[5].caption, undefined);
  // A plain move and a check have no caption either.
  assert.equal(describeMove(START, 'e2e4')!.caption, undefined);
});

test('R4-6: withCaptions puts each caption in place of its sentence, and leaves a narration without captions alone', () => {
  const fen = '4qr1k/5p2/8/8/2B5/8/8/6K1 w - - 0 1';
  const n = narrateLine(fen, ['c4f7', 'f8f7']);
  const w = withCaptions(n);
  assert.equal(w.plies[0].text, n.plies[0].caption);
  assert.equal(w.plies[1], n.plies[1], 'a ply without a caption is the same object');
  assert.equal(n.plies[0].text.endsWith(', but the rook on f8 can take the bishop on f7.'), true, 'the narration itself is not changed');
  const plain = narrateLine(START, ['e2e4', 'e7e5']);
  assert.equal(withCaptions(plain), plain);
  // The viewer's own narration keeps `text` and `caption` apart; only the steps carry the caption.
  const own = lineNarration(fen, ['c4f7', 'f8f7']);
  assert.equal(own.plies[0].text, n.plies[0].text);
  assert.equal(own.plies[0].caption, n.plies[0].caption);
});

test('R4-6 corpus: over every bundled bank answer line, no caption sentence runs over 25 words, a caption names what its sentence names, and `text` is one sentence', () => {
  // R4's tokenizer: the SAN the viewer prints in bold is left out, sentences split after "." or "?".
  const JOIN = new Set(['it', 'also', 'but', 'and']);
  const names = (s: string) => s.toLowerCase().replace(/[.,]/g, ' ').split(/\s+/).filter(w => w && !JOIN.has(w)).sort().join(' ');
  let plies = 0, split = 0;
  for (const p of bank) {
    const n = narrateLine(p.fen, p.moves, { maxPlies: p.moves.length, nameMate: false });
    for (const ply of n.plies) {
      plies++;
      const shown = ply.caption ?? ply.text;
      const body = shown.startsWith(`${ply.san} `) ? shown.slice(ply.san.length + 1) : shown;
      for (const s of sentencesOf(body)) assert.ok(words(s) <= 25, `${p.id} ${ply.san}: "${s}"`);
      assert.equal(sentencesOf(ply.text.replace(/: [^ ]+\.$/, '.')).length, 1, `${p.id} ${ply.san}: one sentence in text`);
      if (!ply.caption) continue;
      split++;
      assert.notEqual(ply.caption, ply.text);
      assert.equal(names(ply.caption), names(ply.text), `${p.id} ${ply.san}: the same names`);
      assert.ok(ply.caption.startsWith(`${ply.san} `), 'a caption starts with its move, as the viewer expects');
    }
  }
  assert.ok(plies > 5000 && split > 300, JSON.stringify({ plies, split }));
});

// ------------------------------------------------------------------ R4-6: the cross-check sentence

test('R4-6: a move that answers a check and gives one says the answer first', () => {
  // Invented. White Ka1, pawn e4; Black Kd6 Qh8. The queen checks on the long diagonal; e5 blocks and checks the king.
  const block = '7q/8/3k4/8/4P3/8/8/K7 w - - 0 1';
  assert.deepEqual(replay(block, ['e4e5']).sans, ['e5+']);
  assert.equal(describeMove(block, 'e4e5')!.text, 'e5+ blocks the check and gives check.');
  // Invented. White Ke2 Rh2; Black Ka2 Re8. Kd3 leaves the e-file and uncovers the rook's check along the second rank.
  const king = '4r3/8/8/8/8/8/k3K2R/8 w - - 0 1';
  assert.deepEqual(replay(king, ['e2d3']).sans, ['Kd3+']);
  assert.equal(describeMove(king, 'e2d3')!.text, 'Kd3+ moves the king out of check and uncovers check from the rook on h2.');
  // A block that gives no check keeps its order (tests/m3_narrate.test.ts pins "c6 blocks the check and attacks …").
});

// ------------------------------------------------------------------ "forks" only when the forking piece cannot be taken

test('fork: "forks" when the piece cannot be taken; "gives check and attacks" when it can; the fact keeps the fork', () => {
  // Invented twins. Nf7+ hits the king on d8 and the rook on h8; in the second, a bishop on g8 can take the knight.
  const safe = '3k3r/8/8/6N1/8/8/8/6K1 w - - 0 1', open = '3k2br/8/8/6N1/8/8/8/6K1 w - - 0 1';
  assert.equal(new Chess(open).moves({ verbose: true }).length > 0, true);
  const bxf7 = replay(open, ['g5f7']).end.moves({ verbose: true }).some(m => m.to === 'f7' && m.piece === 'b');
  assert.ok(bxf7, 'fixture: the bishop can take on f7');
  assert.equal(describeMove(safe, 'g5f7')!.text, 'Nf7+ forks the king and the rook on h8.');
  const p = describeMove(open, 'g5f7')!;
  assert.equal(p.text, 'Nf7+ gives check and attacks the rook on h8.');
  assert.equal(p.facts.fork, true, 'facts keep everything: hints and the coach still see the double attack');
  // With a capture, the check rides on it: "takes … with check and attacks …".
  const take = '3k2br/5p2/8/6N1/8/8/8/6K1 w - - 0 1';
  assert.deepEqual(replay(take, ['g5f7']).sans, ['Nxf7+']);
  assert.equal(describeMove(take, 'g5f7')!.text, 'Nxf7+ takes the pawn on f7 with check and attacks the rook on h8.');
});

test('fork: the pieces named are the ones "forks" would have named, without the king (no pawn added)', () => {
  // Invented. White Kh1 Qc2 Ne3; Black Kh7 Qf6, pawn f3. Qf5+ checks, hits the queen and the pawn; the black queen can
  // take on f5 (an even trade, the knight guards f5), so it is not a fork. "forks the king and the queen on f6" named
  // two with the king and left the pawn out, and so does the new sentence.
  const fen = '8/7k/5q2/8/8/4Np2/2Q5/7K w - - 0 1';
  const r = replay(fen, ['c2f5']);
  assert.deepEqual(r.sans, ['Qf5+']);
  assert.deepEqual(r.end.moves({ verbose: true }).filter(m => m.to === 'f5').map(m => m.san), ['Qxf5'], 'fixture: the queen can take');
  const p = describeMove(fen, 'c2f5')!;
  assert.deepEqual(p.facts.threats.map(t => t.piece + t.square), ['qf6', 'pf3'], 'fixture: the queen and the pawn are both hit');
  assert.deepEqual(p.facts.leftHanging, [], 'fixture: an even trade, so the pawn is not left out for that reason');
  assert.equal(p.text, 'Qf5+ gives check and attacks the undefended queen on f6.');
});

test('fork: without the king, "attacks … and …" when the piece can be taken, en passant included', () => {
  // Invented twins (FX1b's fork fixture): Nd5 hits both rooks; a pawn on e6 can take the knight in the second.
  const safe = '6k1/2r3pp/5r2/8/1N6/7P/5PP1/6K1 w - - 0 1', open = '6k1/2r3pp/4pr2/8/1N6/7P/5PP1/6K1 w - - 0 1';
  assert.equal(describeMove(safe, 'b4d5')!.text, 'Nd5 forks the rook on c7 and the rook on f6.');
  assert.equal(describeMove(open, 'b4d5')!.text, 'Nd5 attacks the rook on c7 and the rook on f6, but the pawn on e6 can take the knight on d5.');
  // Invented twins: d4 hits a rook and a knight; in the first only en passant (exd3) can take the pawn.
  const ep = '7k/8/8/2r1n3/4p3/8/3P4/7K w - - 0 1', noEp = '7k/8/8/2r1n3/8/8/3P4/7K w - - 0 1';
  const after = replay(ep, ['d2d4']).end;
  assert.deepEqual(after.moves({ verbose: true }).filter(m => m.isEnPassant()).map(m => m.san), ['exd3'], 'fixture: en passant is the only way to take');
  assert.equal(after.moves({ verbose: true }).filter(m => m.to === 'd4').length, 0, 'fixture: nothing takes on d4 directly');
  assert.equal(describeMove(ep, 'd2d4')!.text, 'd4 attacks the rook on c5 and the knight on e5, but the pawn on e4 can take the pawn on d4.');
  assert.equal(describeMove(noEp, 'd2d4')!.text, 'd4 forks the rook on c5 and the knight on e5.');
});

test('fork, decision: block, check and attack keep all three facts; the caption splits them', () => {
  // Invented. White Ka1 Rd2; Black Kd8 Rh1 (checking on the first rank). Rd1+ blocks, checks the king on d8 and hits
  // the rook on h1, which can take it. "gives check" and the attack share one clause, so neither is pushed out.
  const fen = '3k4/8/8/8/8/8/3R4/K6r w - - 0 1';
  assert.deepEqual(replay(fen, ['d2d1']).sans, ['Rd1+']);
  const p = describeMove(fen, 'd2d1')!;
  assert.equal(p.text, 'Rd1+ blocks the check, gives check and attacks the undefended rook on h1.');
  assert.equal(p.caption, 'Rd1+ blocks the check and gives check. It also attacks the undefended rook on h1.');
});

// ------------------------------------------------------------------ the side condition on (r) 1

test('side condition: the last mover\'s check or promoting pawn opens the line only when it is level or behind', () => {
  // Ahead and giving check: the check only adds to the lead (FX1b's fixture, settled again).
  const q = '3q2k1/5p1p/6p1/8/8/7P/5PP1/3R2K1 w - - 0 1';
  const ahead = narrateLine(q, ['d1d8']);
  assert.equal(ahead.material.settled, true);
  assert.equal(ahead.summary, 'White wins the queen.');
  // Level and giving check: the line stays open.
  const level = narrateLine('7q/8/3k4/8/4P3/8/8/K7 w - - 0 1', ['e4e5']);
  assert.equal(level.material.settled, false);
  assert.equal(level.summary, 'So far in this line no material changes hands, but White is giving check.');
  // Behind and giving check: public bank 00GVf, still open (tests/m3_fix2a_narrate.test.tsx pins the sentence).
  const p = puzzle('00GVf');
  assert.equal(narrateLine(p.fen, p.moves).material.settled, false);
  // Invented. White Kg1 Bc1, pawn b7; Black Kh8 Nh6. Ahead with a pawn that can promote: settled.
  const promo = '7k/1P6/7n/8/8/8/8/2B3K1 w - - 0 1';
  assert.deepEqual(replay(promo, ['c1h6']).sans, ['Bxh6']);
  assert.equal(narrateLine(promo, ['c1h6']).summary, 'White wins a knight.');
  // The same pawn with the count level (no knight to take): open.
  const quiet = '7k/1P6/8/8/8/8/8/2B3K1 w - - 0 1';
  assert.equal(narrateLine(quiet, ['c1h6']).summary, "So far in this line no material changes hands, but White's pawn on b7 can promote.");
});

test('side condition: with the last mover ahead, the side behind can still take a loose piece (the rule from before (r) 1)', () => {
  // Invented. White Kg1 Rd1 Nf7, pawns f2 g2 h2; Black Kg8 Qd8. Rxd8+ wins the queen with check, and the king can
  // take the loose knight on f7 to get out of it.
  const fen = '3q2k1/5N2/8/8/8/8/5PPP/3R2K1 w - - 0 1';
  const r = replay(fen, ['d1d8']);
  assert.deepEqual(r.sans, ['Rxd8+']);
  assert.ok(r.end.moves().includes('Kxf7'), 'fixture: Kxf7 is legal');
  const n = narrateLine(fen, ['d1d8']);
  assert.equal(n.material.settled, false);
  assert.equal(n.summary, 'So far in this line White has won the queen, but the king can take the knight on f7.');
});

// ------------------------------------------------------------------ "about level"

test('about level: a verdict that gives the named winner 50 to 54 (rounded) closes "the engine rates the position about level"', () => {
  const fen = '7k/1P6/7n/8/8/8/8/2B3K1 w - - 0 1', line = ['c1h6'];
  const close = (v: unknown) => narrateLine(fen, line, { verdict: v as never }).summary;
  const level = 'White is a knight up at the end of this line, but the engine rates the position about level.';
  for (const v of [{ side: 'w', win: 50 }, { side: 'w', win: 52 }, { side: 'w', win: 54 }, { side: 'w', win: 54.4 }, { side: 'w', win: 49.6 }]) assert.equal(close(v), level, JSON.stringify(v));
  // The figure is rounded for the side it was given for: 45.5 for Black is 46 for Black, so 54 for White.
  assert.equal(close({ side: 'b', win: 45.5 }), level);
  assert.equal(close({ side: 'b', win: 50 }), level);
  // 55 and up agrees with the count; below 50 names the other side's figure, as before.
  assert.equal(close({ side: 'w', win: 54.5 }), 'White wins a knight.');
  assert.equal(close({ side: 'b', win: 45.4 }), 'White wins a knight.');
  assert.equal(close({ side: 'w', win: 49.4 }), 'White is a knight up at the end of this line, but the engine gives Black 51% to win.');
  // The winning form has no number, so it is never "about level".
  assert.equal(close({ side: 'w', winning: true }), 'White wins a knight.');
  assert.equal(close({ side: 'b', winning: true }), 'White is a knight up at the end of this line, but Black is winning.');
});

test('about level: applied before the pending clause, and shown by the viewer at the last step', () => {
  // Public bank 00GVf: "So far in this line Black has won a rook, but White is giving check." without a verdict.
  const p = puzzle('00GVf');
  assert.equal(narrateLine(p.fen, p.moves, { verdict: { side: 'b', win: 52 } }).summary,
    'Black is a rook up at the end of this line, but the engine rates the position about level.');
  const html = renderToStaticMarkup(<LineViewer title="t" startFen={p.fen} line={p.moves} orientation="w" initialStep={p.moves.length} verdict={{ side: 'w', win: 48 }}/>);
  assert.equal(summaryOf(html), esc('Black is a rook up at the end of this line, but the engine rates the position about level.'));
});
