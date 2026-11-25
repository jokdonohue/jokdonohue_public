/**
 * FX1b, fix round 2 (brief 9.11.2): the narrator's new closing rules and the line viewer's new props.
 * - (r) 1: a line is not settled when the last mover is giving check, has a pawn that can promote, or has a piece
 *   that forks two loose pieces and cannot be taken.
 * - (r) 2: a verdict that puts the named material winner below 50 replaces the closing sentence.
 * - (r) 4: the viewer leaves out "No material changes hands.".
 * - (t) 2: `omit` keeps every sentence from describing one move (the answer, while the card is unsolved).
 * Positions: the two public Lichess bank puzzles R3's skeptic reproduced (read from the bundled bank by id), the
 * public puzzle behind R3-3, the skeptic's two invented positions, and invented positions of my own. Every invented
 * position is first checked with chess.js, so no sentence here rests on a recalled FEN.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chess } from 'chess.js';
import LineViewer, { lineNarration } from '../components/LineViewer';
import { moveRefOf, narrateLine, sameMove, NO_CHANGE_SENTENCE, type MoveRef } from '../src/teach/narrate';
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
  return { sans, end: b, inCheck: b.inCheck(), turn: b.turn() as 'w' | 'b' };
};
const summaryOf = (html: string) => /<p class="line-viewer-summary">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? null;
const captionOf = (html: string) => /<p class="line-viewer-caption" aria-live="polite">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? null;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

// ------------------------------------------------------------------ (r) 1 the three new closing rules

test('(r) 1 R3-2, public bank 00GVf: a line that ends with the side ahead in check is not settled', () => {
  const p = puzzle('00GVf');
  const { sans, inCheck, turn } = replay(p.fen, p.moves);
  assert.deepEqual(sans, ['Rh8+', 'Qxh8', 'Qe7+', 'Kg8', 'Qd8+']);
  assert.equal(inCheck, true, 'fixture: Black is in check at the end');
  assert.equal(turn, 'b', 'fixture: Black, the side ahead in material, is to move');
  const n = narrateLine(p.fen, p.moves);
  assert.equal(n.material.net, -5, 'Black is a rook up over the line');
  assert.equal(n.material.settled, false);
  // Was "Black wins a rook." while White is giving check and wins the queen next.
  assert.equal(n.summary, 'So far in this line Black has won a rook, but White is giving check.');
});

test('(r) 1 R3-2, public bank 01gGh: a pawn one step from promoting leaves the line open', () => {
  const p = puzzle('01gGh');
  const { sans, end } = replay(p.fen, p.moves);
  assert.equal(sans[sans.length - 1], 'a7');
  assert.equal(end.get('a7')?.color, 'w', 'fixture: the white pawn stands on a7');
  assert.equal(end.inCheck(), false, 'fixture: no check, so the promotion rule is what fires');
  const n = narrateLine(p.fen, p.moves);
  assert.equal(n.material.net, -1);
  assert.equal(n.material.settled, false);
  // Was "Black wins a pawn." with a8=Q next.
  assert.equal(n.summary, "So far in this line Black has won a pawn, but White's pawn on a7 can promote.");
});

test("(r) 1 R3-2, the skeptic's two invented positions: a check and a pawn race undo the count", () => {
  // White Kg1 Qc1 Bb3, pawns f2 g2 h2; Black Kh8 Qb8 Nd4 Bd5, pawns g7 h7. Bxd5 Ne2+ forks the king and the queen.
  const forkFen = '1q5k/6pp/8/3b4/3n4/1B6/5PPP/2Q3K1 w - - 0 1';
  const fork = replay(forkFen, ['b3d5', 'd4e2']);
  assert.deepEqual(fork.sans, ['Bxd5', 'Ne2+']);
  assert.equal(fork.inCheck, true, 'fixture: White is in check');
  const forkLine = narrateLine(forkFen, ['b3d5', 'd4e2']);
  assert.equal(forkLine.material.net, 3);
  assert.equal(forkLine.material.settled, false);
  assert.equal(forkLine.summary, 'So far in this line White has won a bishop, but Black is giving check.');
  // White Kh1 Ng5, pawns g2 h2; Black Kc7 Bh7, pawn b3. After Nxh7 b2 nothing stops b1=Q.
  const raceFen = '8/2k4b/8/6N1/8/1p6/6PP/7K w - - 0 1';
  const race = replay(raceFen, ['g5h7', 'b3b2']);
  assert.deepEqual(race.sans, ['Nxh7', 'b2']);
  assert.equal(race.inCheck, false);
  assert.equal(race.end.get('b2')?.color, 'b');
  const raceLine = narrateLine(raceFen, ['g5h7', 'b3b2']);
  assert.equal(raceLine.material.net, 3);
  assert.equal(raceLine.material.settled, false);
  assert.equal(raceLine.summary, "So far in this line White has won a bishop, but Black's pawn on b2 can promote.");
});

test('(r) 1 a fork counts only when it is two loose pieces and the forking piece cannot be taken', () => {
  // Invented. White Kg1 Nb4, pawns f2 g2 h3; Black Kg8 Rc7 Rf6, pawns g7 h7. Nd5 hits both rooks.
  const safe = '6k1/2r3pp/5r2/8/1N6/7P/5PP1/6K1 w - - 0 1';
  const r = replay(safe, ['b4d5']);
  assert.deepEqual(r.sans, ['Nd5']);
  assert.equal(r.inCheck, false, 'fixture: no check, so the fork rule is what fires');
  assert.equal(r.end.moves({ verbose: true }).some(m => m.to === 'd5'), false, 'fixture: Black cannot take the knight on d5');
  const n = narrateLine(safe, ['b4d5']);
  assert.equal(n.material.settled, false);
  assert.equal(n.summary, 'So far in this line no material changes hands, but the knight on d5 attacks the rook on c7 and the rook on f6.');
  // The same fork with a black pawn on e6, which can take the knight: the fork clause is not used.
  const takeable = '6k1/2r3pp/4pr2/8/1N6/7P/5PP1/6K1 w - - 0 1';
  const t = replay(takeable, ['b4d5']);
  assert.equal(t.end.moves({ verbose: true }).some(m => m.to === 'd5' && m.piece === 'p'), true, 'fixture: exd5 is legal');
  const takeableLine = narrateLine(takeable, ['b4d5']);
  assert.doesNotMatch(takeableLine.summary, /attacks/, takeableLine.summary);
  assert.equal(takeableLine.summary, 'So far in this line no material changes hands, but the pawn on e6 can take the knight on d5.');
  // Two defended bishops are not loose against a knight, so that line stays settled.
  const held = '2r3k1/2b3pp/5b2/8/1N6/7P/5PP1/6K1 w - - 0 1';
  const h = replay(held, ['b4d5']);
  assert.equal(h.inCheck, false);
  const heldLine = narrateLine(held, ['b4d5']);
  assert.equal(heldLine.material.settled, true);
  assert.equal(heldLine.summary, NO_CHANGE_SENTENCE);
  // FX1c (brief 9.11.3, the side condition on (r) 1): a fork by the side that is already ahead only adds to its lead,
  // so the line stays settled. (FX1b's rule, unconditional, read "So far in this line White has won a bishop, and the
  // knight on d5 attacks the rook on c7 and the rook on f6.")
  const ahead = '6k1/2r3pp/5r2/3b4/1N6/7P/5PP1/6K1 w - - 0 1';
  assert.deepEqual(replay(ahead, ['b4d5']).sans, ['Nxd5']);
  assert.equal(narrateLine(ahead, ['b4d5']).summary, 'White wins a bishop.');
  assert.equal(narrateLine(ahead, ['b4d5']).material.settled, true);
});

test('(r) 1 the new rules leave the old ones in place, and a quiet end is still settled', () => {
  const start = new Chess().fen();
  // A mate in one still outranks the three new clauses (the side to move is not in check here).
  const scholar = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6'];
  assert.equal(narrateLine(start, scholar).summary, 'So far in this line no material changes hands, but White can mate in one: Qxf7#.');
  // A take-back still outranks them: Bxf6 in the Queen's Gambit, with the bishop ready to take back.
  const qgd = new Chess();
  for (const s of ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7']) qgd.move(s);
  assert.equal(narrateLine(qgd.fen(), ['g5f6']).summary, 'So far in this line White has won a knight, but Black can take back on f6.');
  // A pawn on its seventh rank that cannot move is no promotion threat. Invented: its own rook stands on a8.
  const blocked = 'R7/P7/7k/8/8/8/8/6K1 w - - 0 1';
  const b = replay(blocked, ['g1g2']);
  assert.equal(b.inCheck, false);
  assert.equal(b.end.get('a8')?.color, 'w', 'fixture: White blocks its own pawn');
  assert.equal(narrateLine(blocked, ['g1g2']).summary, NO_CHANGE_SENTENCE);
  // A pawn blocked by an enemy piece is the same: the rook on d8 holds the pawn on d7.
  const held = '3r2k1/3P4/8/8/8/8/8/3RK3 w - - 0 1';
  assert.equal(replay(held, ['d1d3']).inCheck, false);
  assert.equal(narrateLine(held, ['d1d3']).summary, NO_CHANGE_SENTENCE);
  // A pinned pawn cannot promote either, and only chess.js can see that: the pawn on d7 is held on the seventh rank
  // by the rook on a7 and the king on h7, so pushing it would leave its own king in check.
  const pinned = '8/r2P3K/8/8/7k/8/8/3R4 w - - 0 1';
  const p = replay(pinned, ['d1d2']);
  assert.equal(p.inCheck, false);
  assert.equal(p.end.get('d8'), undefined, 'fixture: d8 is empty, so a geometric test would call this a promotion');
  assert.equal(narrateLine(pinned, ['d1d2']).summary, NO_CHANGE_SENTENCE);
});

// ------------------------------------------------------------------ (r) 2 the verdict sentence

test('(r) 2 a verdict below 50 for the named winner replaces the closing sentence, with the number from the page', () => {
  // R3-3: public bank 00s8j, the try Kxd8 with the engine's reply. The settled count names Black, the solver, as a
  // rook up, while the check behind the grade gave Black 6%.
  const p = puzzle('00s8j');
  const line = ['c7d8', 'g2g4', 'c6a6'];
  const { sans } = replay(p.fen, line);
  assert.deepEqual(sans, ['Kxd8', 'g4', 'Ra6']);
  const plain = narrateLine(p.fen, line);
  assert.equal(plain.summary, 'Black wins a rook.');
  const withVerdict = narrateLine(p.fen, line, { verdict: { side: 'b', win: 6 } });
  assert.equal(withVerdict.summary, 'Black is a rook up at the end of this line, but the engine gives White 94% to win.');
  assert.equal(withVerdict.material.settled, true, 'the verdict changes the sentence, never the position');
  // The same figure given for the other side reads the same way (the other side's figure is 100 - win).
  assert.equal(narrateLine(p.fen, line, { verdict: { side: 'w', win: 94 } }).summary, withVerdict.summary);
  // A verdict that agrees with the count leaves the sentence alone, at the boundary too.
  assert.equal(narrateLine(p.fen, line, { verdict: { side: 'b', win: 60 } }).summary, 'Black wins a rook.');
  // FX1c (brief 9.11.3, "about level"): 49.6 rounds to 50, which is now the about-level sentence (it was left alone).
  assert.equal(narrateLine(p.fen, line, { verdict: { side: 'b', win: 49.6 } }).summary,
    'Black is a rook up at the end of this line, but the engine rates the position about level.', '49.6 rounds to 50');
  assert.match(narrateLine(p.fen, line, { verdict: { side: 'b', win: 49.4 } }).summary, /^Black is a rook up at the end of this line, but the engine gives White 51% to win\.$/);
  // The figure is rounded once, for the side the verdict was given for, so a .5 figure reads the same as the rest of
  // the page reads it: 54.5 for White is 55 for White, and the named winner keeps 45.
  assert.equal(narrateLine(p.fen, line, { verdict: { side: 'w', win: 54.5 } }).summary,
    'Black is a rook up at the end of this line, but the engine gives White 55% to win.');
  assert.equal(narrateLine(p.fen, line, { verdict: { side: 'b', win: 45.5 } }).summary,
    'Black is a rook up at the end of this line, but the engine gives White 54% to win.', '45.5 for Black reads 46 for Black');
  // A verdict without a usable number is no verdict at all (the Trainer may hold a half-finished check).
  const unusable: unknown[] = [null, undefined, {}, { side: 'b' }, { side: 'b', win: Number.NaN }, { side: 'x', win: 1 }];
  for (const bad of unusable) {
    assert.equal(narrateLine(p.fen, line, { verdict: bad as never }).summary, 'Black wins a rook.', JSON.stringify(bad));
  }
});

test('(r) 2 the winning form has no number, and the verdict is applied before the pending clause', () => {
  const p = puzzle('00GVf');
  // A bank answer line wins for the solver by construction (brief 9.11.2 (r) 3), and this one closes on the
  // opponent's material. The verdict sentence replaces the pending clause, which is the check.
  const withVerdict = narrateLine(p.fen, p.moves, { verdict: { side: 'w', winning: true } });
  assert.equal(withVerdict.summary, 'Black is a rook up at the end of this line, but White is winning.');
  assert.equal(withVerdict.material.settled, false, 'the position is still unsettled; only the sentence changed');
  // A winning verdict for the side the count already names changes nothing.
  assert.equal(narrateLine(p.fen, p.moves, { verdict: { side: 'b', winning: true } }).summary,
    'So far in this line Black has won a rook, but White is giving check.');
  // A promotion with no capture names what the side is up as "a new queen".
  const promo = '3k4/4P3/8/8/8/8/8/K7 w - - 0 1';
  assert.deepEqual(replay(promo, ['e7e8q']).sans, ['e8=Q+']);
  assert.equal(narrateLine(promo, ['e7e8q'], { verdict: { side: 'b', winning: true } }).summary,
    'White is a new queen up at the end of this line, but Black is winning.');
  // A queen won from a side that had one reads "the queen" in the settled sentence and "a queen" in this one.
  const q = '3q2k1/5p1p/6p1/8/8/7P/5PP1/3R2K1 w - - 0 1';
  assert.deepEqual(replay(q, ['d1d8']).sans, ['Rxd8+']);
  // FX1c (brief 9.11.3, the side condition): White, the side giving check, is already ahead, so the line is settled.
  assert.equal(narrateLine(q, ['d1d8']).summary, 'White wins the queen.');
  assert.equal(narrateLine(q, ['d1d8'], { verdict: { side: 'b', winning: true } }).summary,
    'White is a queen up at the end of this line, but Black is winning.');
});

test('(r) 2 a verdict is used only where a side is named as the material winner', () => {
  const start = new Chess().fen();
  const against = { side: 'b' as const, win: 99 };
  // Nothing taken, and trades that cancel: no side is named, so the sentence stands.
  assert.equal(narrateLine(start, ['g1f3', 'g8f6', 'f3g1'], { verdict: against }).summary, NO_CHANGE_SENTENCE);
  const trade = '6k1/8/5n2/3b4/8/2N5/8/3R2K1 w - - 0 1';
  assert.deepEqual(replay(trade, ['c3d5', 'f6d5']).sans, ['Nxd5', 'Nxd5']);
  assert.equal(narrateLine(trade, ['c3d5', 'f6d5'], { verdict: against }).summary,
    'So far in this line the trades are even, but White can take back on d5.');
  // Mate and stalemate keep their own sentences.
  const scholar = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
  assert.equal(narrateLine(start, scholar, { verdict: against }).summary, 'The line ends in checkmate by White.');
  assert.equal(narrateLine('k7/8/1K6/8/8/8/8/2Q5 w - - 0 1', ['c1c7'], { verdict: against }).summary, 'The line ends in stalemate, a draw.');
});

// ------------------------------------------------------------------ (r) 4 the no-change sentence

test('(r) 4 noChangeSentence false leaves out "No material changes hands." and nothing else', () => {
  const start = new Chess().fen();
  const quiet = ['g1f3', 'g8f6', 'f3g1'];
  assert.equal(narrateLine(start, quiet).summary, NO_CHANGE_SENTENCE, 'the default is unchanged for lessons, hints and coach inputs');
  assert.equal(narrateLine(start, quiet, { noChangeSentence: true }).summary, NO_CHANGE_SENTENCE);
  assert.equal(narrateLine(start, quiet, { noChangeSentence: false }).summary, '');
  // The trades-are-even sentence and the unsettled form both stay: they say something the count does not.
  const trade = '6k1/8/5n2/3b4/8/2N5/8/3R2K1 w - - 0 1';
  assert.equal(narrateLine(trade, ['c3d5', 'f6d5'], { noChangeSentence: false }).summary,
    'So far in this line the trades are even, but White can take back on d5.');
  const push = '4k3/1p6/8/8/8/2N5/8/4K3 b - - 0 1';
  assert.equal(narrateLine(push, ['b7b5'], { noChangeSentence: false }).summary,
    'So far in this line no material changes hands, but the knight on c3 can take the pawn on b5.');
});

// ------------------------------------------------------------------ (t) 2 omit

test('(t) 1 moveRefOf and sameMove read a move by identity, never by its SAN', () => {
  const start = new Chess().fen();
  assert.deepEqual(moveRefOf(start, 'e2e4'), { from: 'e2', to: 'e4', piece: 'p' });
  assert.deepEqual(moveRefOf(start, 'g1f3'), { from: 'g1', to: 'f3', piece: 'n' });
  // A promotion keeps the new piece; a castling is the king's two-square move; an illegal move is null.
  const promo = '3k4/4P3/8/8/8/8/8/K7 w - - 0 1';
  assert.deepEqual(moveRefOf(promo, 'e7e8q'), { from: 'e7', to: 'e8', piece: 'p', promotion: 'q' });
  const castle = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  assert.deepEqual(moveRefOf(castle, 'e1g1'), { from: 'e1', to: 'g1', piece: 'k' });
  assert.deepEqual(moveRefOf(castle, 'e1h1'), { from: 'e1', to: 'g1', piece: 'k' }, 'king takes own rook is castling');
  assert.equal(moveRefOf(start, 'e2e5'), null);
  assert.equal(moveRefOf('not a fen', 'e2e4'), null);
  // The same square reached from another square is another move. Invented: White Ka1 Bg1; Black Kg8 Nf3 Nh3, Black
  // to move, so either knight can take the bishop on g1.
  const twoWays = '6k1/8/8/8/8/5n1n/8/K5B1 b - - 0 1';
  const fixture = new Chess(twoWays);
  assert.equal(fixture.inCheck(), false, 'fixture: a legal position with Black to move');
  assert.deepEqual(fixture.moves({ verbose: true }).filter(m => m.to === 'g1').map(m => m.san).sort(), ['Nfxg1', 'Nhxg1']);
  const ref = moveRefOf(twoWays, 'f3g1')!;
  assert.deepEqual(ref, { from: 'f3', to: 'g1', piece: 'n' });
  assert.equal(sameMove(twoWays, 'f3g1', ref), true);
  assert.equal(sameMove(twoWays, 'h3g1', ref), false, 'the same square from another square is another move');
  assert.equal(sameMove(twoWays, 'f3h2', ref), false);
  assert.equal(sameMove(twoWays, 'g8f8', ref), false, 'another piece is another move');
  // Promotions: the same squares to a different piece is a different move; a missing letter is not compared.
  const pr = moveRefOf(promo, 'e7e8q')!;
  assert.equal(sameMove(promo, 'e7e8q', pr), true);
  assert.equal(sameMove(promo, 'e7e8r', pr), false);
  assert.equal(sameMove(promo, 'e7e8n', pr), false);
  assert.equal(sameMove(promo, 'e7e8q', { from: 'e7', to: 'e8', piece: 'p' }), true, 'a ref with no promotion matches the squares');
  assert.equal(sameMove(promo, 'e7e8', pr), false, 'a promotion needs its letter to be legal');
  assert.equal(sameMove(start, 'e2e4', null as unknown as MoveRef), false);
});

test('(t) 2 omit keeps a caption and a summary from describing the answer move', () => {
  // R4's second repro, invented: White Kg1 Nf3, pawn h2; Black Kg8 Bg5, pawn d7. The answer is Nxg5, and the try
  // line h3 d6 describes it in words.
  const fen = '6k1/3p4/8/6b1/8/5N2/7P/6K1 w - - 0 1';
  const line = ['h2h3', 'd7d6'];
  assert.deepEqual(replay(fen, line).sans, ['h3', 'd6']);
  const ref = moveRefOf(fen, 'f3g5')!;
  assert.deepEqual(ref, { from: 'f3', to: 'g5', piece: 'n' });
  const plain = narrateLine(fen, line);
  assert.equal(plain.plies[1].text, 'd6 lets the knight on f3 take the bishop on g5.');
  assert.equal(plain.summary, 'So far in this line no material changes hands, but the knight on f3 can take the bishop on g5.');
  const cut = narrateLine(fen, line, { omit: ref });
  assert.equal(cut.plies[1].text, 'd6 pushes the pawn to d6.');
  assert.equal(cut.summary, 'So far in this line no material changes hands.', 'the clause goes, the first half stays');
  assert.equal(cut.material.settled, false, 'leaving the clause out never settles the line');
  assert.deepEqual(cut.plies[1].facts.leftHanging.map(h => `${h.by.square}${h.square}`), ['f3g5'], 'the facts keep everything');
  // Another move of the same piece is still described.
  assert.equal(narrateLine(fen, line, { omit: { from: 'f3', to: 'd4', piece: 'n' } }).plies[1].text, plain.plies[1].text);
});

test('(t) 2 omit skips to the next loose piece, and covers the take-back and mate clauses', () => {
  // Invented: White Kg1 Rd1 Nf3, pawns f2 g2 h2; Black Kg8 Rg5 Bd4, pawn d7. Both black pieces are loose, and the
  // knight's capture of the rook on g5 is the answer.
  const two = '6k1/3p4/8/6r1/3b4/5N2/5PPP/3R2K1 w - - 0 1';
  const line = ['h2h3', 'd7d6'];
  assert.deepEqual(replay(two, line).sans, ['h3', 'd6']);
  const ref = moveRefOf(two, 'f3g5')!;
  assert.equal(narrateLine(two, line).summary, 'So far in this line no material changes hands, but the knight on f3 can take the rook on g5.');
  const cut = narrateLine(two, line, { omit: ref });
  assert.equal(cut.plies[1].text, 'd6 lets the knight on f3 take the bishop on d4.');
  assert.equal(cut.summary, 'So far in this line no material changes hands, but the knight on f3 can take the bishop on d4.');
  // A take-back clause whose only taker is the answer is left out. Invented: White Kg1 Nf3, pawns g5 h2; Black Kg8
  // Bd8, pawn h7. After h3 Bxg5 the knight would take back on g5, and that capture is the answer.
  const back = '3b2k1/7p/8/6P1/8/5N2/7P/6K1 w - - 0 1';
  const backLine = ['h2h3', 'd8g5'];
  assert.deepEqual(replay(back, backLine).sans, ['h3', 'Bxg5']);
  assert.equal(narrateLine(back, backLine).summary, 'So far in this line Black has won a pawn, but White can take back on g5.');
  const backRef: MoveRef = { from: 'f3', to: 'g5', piece: 'n' };
  const backCut = narrateLine(back, backLine, { omit: backRef });
  assert.equal(backCut.summary, 'So far in this line Black has won a pawn.');
  assert.equal(backCut.plies[1].text, 'Bxg5 takes the pawn on g5.');
  // A mate-in-one clause that names the answer is left out. Invented back rank: after Rd7, Re1 mates.
  const rank = '4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
  const black = rank.replace(' w ', ' b ');
  const mateRef = moveRefOf(black, 'e8e1')!;
  assert.deepEqual(mateRef, { from: 'e8', to: 'e1', piece: 'r' });
  assert.equal(narrateLine(rank, ['d1d7']).summary, 'So far in this line no material changes hands, but Black can mate in one: Re1#.');
  assert.equal(narrateLine(rank, ['d1d7'], { omit: mateRef }).summary, 'So far in this line no material changes hands.');
  // A promotion threat that is the answer, and a fork clause that points at it, go the same way.
  const race = '8/2k4b/8/6N1/8/1p6/6PP/7K w - - 0 1';
  assert.equal(narrateLine(race, ['g5h7', 'b3b2'], { omit: { from: 'b2', to: 'b1', piece: 'p', promotion: 'q' } }).summary,
    'So far in this line White has won a bishop.');
  const forkEnd = '6k1/2r3pp/5r2/8/1N6/7P/5PP1/6K1 w - - 0 1';
  assert.equal(narrateLine(forkEnd, ['b4d5'], { omit: { from: 'd5', to: 'c7', piece: 'n' } }).summary,
    'So far in this line no material changes hands.');
});

// ------------------------------------------------------------------ the line viewer's new props

test('the viewer passes verdict, omit and noChangeSentence to the narrator', () => {
  const p = puzzle('00s8j');
  const line = ['c7d8', 'g2g4', 'c6a6'];
  const view = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<LineViewer title="Why Kxd8 doesn't work" startFen={p.fen} line={line} orientation="b" initialStep={line.length} {...props}/>);
  assert.equal(summaryOf(view()), esc('Black wins a rook.'));
  assert.equal(summaryOf(view({ verdict: { side: 'b', win: 6 } })), esc('Black is a rook up at the end of this line, but the engine gives White 94% to win.'));
  assert.equal(summaryOf(view({ verdict: { side: 'b', winning: true } })), esc('Black wins a rook.'), 'a verdict that agrees changes nothing');
  // (r) 4: every viewer leaves out the no-change sentence; a caller can ask for it back.
  const start = new Chess().fen();
  const quiet = ['g1f3', 'g8f6', 'f3g1'];
  const quietView = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<LineViewer title="t" startFen={start} line={quiet} orientation="w" initialStep={quiet.length} {...props}/>);
  assert.equal(summaryOf(quietView()), null);
  assert.equal(summaryOf(quietView({ noChangeSentence: true })), esc(NO_CHANGE_SENTENCE));
  // (t) 2: the caption and the summary of a try line leave the answer out.
  const fen = '6k1/3p4/8/6b1/8/5N2/7P/6K1 w - - 0 1';
  const tryLine = ['h2h3', 'd7d6'];
  const tryView = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<LineViewer title="What could follow h3" startFen={fen} line={tryLine} orientation="w" initialStep={2} {...props}/>);
  assert.match(captionOf(tryView()) ?? '', /lets the knight on f3 take the bishop on g5/);
  const omit = moveRefOf(fen, 'f3g5')!;
  assert.equal(captionOf(tryView({ omit })), '<strong>1... d6</strong> pushes the pawn to d6.');
  assert.equal(summaryOf(tryView({ omit })), esc('So far in this line no material changes hands.'));
});

test('a narration passed in is used only when it can have been made with these options', () => {
  const p = puzzle('00s8j');
  const line = ['c7d8', 'g2g4', 'c6a6'];
  const given = { ...narrateLine(p.fen, line), summary: 'The given summary.' };
  assert.equal(lineNarration(p.fen, line, given), given, 'no new option: used as given');
  for (const opts of [{ verdict: { side: 'b' as const, win: 6 } }, { omit: moveRefOf(p.fen, 'c7d8') }]) {
    assert.notEqual(lineNarration(p.fen, line, given, opts), given, JSON.stringify(opts));
  }
  // A narration that closes on the sentence the viewer leaves out is narrated again, so the viewer drops it.
  const start = new Chess().fen();
  const quiet = ['g1f3', 'g8f6', 'f3g1'];
  const quietGiven = narrateLine(start, quiet);
  assert.equal(quietGiven.summary, NO_CHANGE_SENTENCE);
  assert.equal(lineNarration(start, quiet, quietGiven, { noChangeSentence: true }), quietGiven);
  assert.equal(lineNarration(start, quiet, quietGiven).summary, '');
});
