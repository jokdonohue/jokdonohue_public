/**
 * M3 A1: narrator facts, sentences and line summaries, plus the Win% helpers. Textbook or invented positions only
 * (no owner game data). Every invented position is first checked with chess.js (the SAN, check/mate flags, en
 * passant), so a test never rests on a recalled FEN.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, type Square } from 'chess.js';
import { PIECE_NAME, PIECE_VALUE, winPctFromCp, winPctFromScore } from '../src/teach/values';
import { boardText, describeMove, narrateLine, type NarratedPly } from '../src/teach/narrate';

const START = new Chess().fen();
/** FEN after SAN moves from the start (or `from`), played by chess.js. */
const play = (sans: string[], from?: string) => { const b = new Chess(from); for (const s of sans) b.move(s); return b.fen(); };
/** chess.js's own view of a UCI move at `fen`. */
const move = (fen: string, uci: string) => new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
const after = (fen: string, uci: string) => { const b = new Chess(fen); b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); return b; };
const texts = (fen: string, line: string[]) => narrateLine(fen, line).plies.map(p => p.text);

test('values: piece values and names, Lichess Win% with the +/-1000 cp ceiling, score conversion', () => {
  assert.deepEqual(PIECE_VALUE, { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 });
  assert.deepEqual(PIECE_NAME, { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' });
  assert.equal(winPctFromCp(0), 50);
  assert.ok(Math.abs(winPctFromCp(100) - 59.10) < 0.01, String(winPctFromCp(100)));
  for (const cp of [35, 120, 480, 999]) assert.ok(Math.abs(winPctFromCp(cp) + winPctFromCp(-cp) - 100) < 1e-9);
  assert.equal(winPctFromCp(5000), winPctFromCp(1000));
  assert.ok(winPctFromCp(1000) > 97.4 && winPctFromCp(1000) < 97.6);
  assert.ok(Number.isNaN(winPctFromCp(Number.NaN)));
  // Scores from White's view (engine convention) read for either side.
  assert.equal(winPctFromScore({ cp: 100 }, 'w', 'w'), winPctFromCp(100));
  assert.equal(winPctFromScore({ cp: 100 }, 'b', 'w'), winPctFromCp(-100));
  assert.equal(winPctFromScore({ cp: -250, mate: null }, 'b', 'w'), winPctFromCp(250));
  // Mate: 100 for the side that mates, 0 for the side that is mated; an EngineScore shape passes as it is.
  assert.equal(winPctFromScore({ cp: null, mate: 3 }, 'w', 'w'), 100);
  assert.equal(winPctFromScore({ cp: null, mate: 3 }, 'b', 'w'), 0);
  assert.equal(winPctFromScore({ mate: -2 }, 'w', 'w'), 0);
  assert.equal(winPctFromScore({ mate: -2 }, 'b', 'w'), 100);
  assert.equal(winPctFromScore({ cp: null, mate: 0, mated: 'b' }, 'b', 'w'), 0);
  assert.equal(winPctFromScore({ cp: null, mate: 0, mated: 'b' }, 'w', 'w'), 100);
  // mate 0 without `mated` is read as UCI reads it: the score's side is mated.
  assert.equal(winPctFromScore({ mate: 0 }, 'b', 'b'), 0);
  assert.ok(Number.isNaN(winPctFromScore({ cp: null, mate: null }, 'w', 'w')));
  assert.ok(Number.isNaN(winPctFromScore({}, 'w', 'w')));
});

test('discovered attack with check winning the queen (Bxh7+ type)', () => {
  // Invented: White Kg1 Qd1 Bd3, pawns f2 g2 h2; Black Kg8 Rf8 Qd5, pawns f7 g7 h7. The bishop on d3 hides the d-file.
  const fen = '5rk1/5ppp/8/3q4/8/3B4/5PPP/3Q2K1 w - - 0 1';
  assert.equal(move(fen, 'd3h7').san, 'Bxh7+');
  const line = narrateLine(fen, ['d3h7', 'g8h7', 'd1d5']);
  const [bxh7, kxh7, qxd5] = line.plies;
  assert.equal(bxh7.text, 'Bxh7+ takes the pawn on h7 with check and uncovers the queen on d1 against the queen on d5.');
  assert.deepEqual(bxh7.facts.capture, { piece: 'p', color: 'b', square: 'h7' });
  assert.equal(bxh7.facts.check, true);
  assert.deepEqual(bxh7.facts.discovered, [{ by: { piece: 'q', color: 'w', square: 'd1' }, target: { piece: 'q', color: 'b', square: 'd5' } }]);
  // The bishop can be taken by the king (a fact), but a move that gives check gets no hanging clause.
  assert.deepEqual(bxh7.facts.leftHanging, [{ piece: 'b', color: 'w', square: 'h7', by: { piece: 'k', color: 'b', square: 'g8' } }]);
  assert.equal(kxh7.text, 'Kxh7 takes the bishop on h7, but the queen on d1 can take the queen on d5.');
  assert.equal(qxd5.text, 'Qxd5 takes the queen on d5.');
  // The line ends on a capture that nothing can take back: settled (A1 refinement), so the result is claimed.
  assert.equal(line.material.settled, true);
  assert.equal(line.material.pov, 'w');
  assert.equal(line.material.net, 7);
  assert.deepEqual(line.material.won.map(p => p.piece + p.square), ['ph7', 'qd5']);
  assert.deepEqual(line.material.lost.map(p => p.piece + p.square), ['bh7']);
  assert.equal(line.summary, 'White wins the queen and a pawn for a bishop.');
});

test('an undefended rook pinning the queen hangs to a queen capture with check along the file', () => {
  // Invented: White Kh1 Rb1, pawns g2 h3; Black Ke8 Qe4. Re1 pins the queen, but the rook on e1 is undefended.
  const fen = '4k3/8/8/8/4q3/7P/6P1/1R5K w - - 0 1';
  assert.equal(move(fen, 'b1e1').san, 'Re1');
  assert.equal(move(after(fen, 'b1e1').fen(), 'e4e1').san, 'Qxe1+');
  const line = narrateLine(fen, ['b1e1', 'e4e1', 'h1h2']);
  const re1 = line.plies[0];
  assert.deepEqual(re1.facts.pins, [{ pinned: { piece: 'q', color: 'b', square: 'e4' }, behind: { piece: 'k', color: 'b', square: 'e8' }, by: { piece: 'r', color: 'w', square: 'e1' } }]);
  assert.deepEqual(re1.facts.leftHanging, [{ piece: 'r', color: 'w', square: 'e1', by: { piece: 'q', color: 'b', square: 'e4' } }]);
  assert.deepEqual(re1.facts.threats.map(t => t.square), ['e4']);
  assert.equal(re1.text, 'Re1 pins the queen on e4 to the king, but the queen can take the rook on e1 with check.');
  assert.equal(line.plies[1].text, 'Qxe1+ takes the rook on e1 with check.');
  assert.equal(line.plies[2].text, 'Kh2 moves the king out of check.');
  assert.equal(line.material.net, -5);
  assert.equal(line.summary, 'Black wins a rook.');
  // The defended twin (a second rook on a1 guards e1): the pin holds, since Qxe1+ Rxe1 loses the queen for a rook.
  const guarded = '4k3/8/8/8/4q3/7P/6P1/RR5K w - - 0 1';
  const held = describeMove(guarded, 'b1e1')!;
  assert.deepEqual(held.facts.leftHanging, []);
  assert.ok(new Chess(held.fenAfter).moves().includes('Qxe1+'), 'the queen can still take, at a loss');
  assert.equal(held.text, 'Re1 pins the queen on e4 to the king.');
});

test('knight fork of king and rook', () => {
  const fen = '3k3r/8/8/6N1/8/8/8/6K1 w - - 0 1';
  assert.equal(move(fen, 'g5f7').san, 'Nf7+');
  const line = narrateLine(fen, ['g5f7', 'd8e7', 'f7h8']);
  const nf7 = line.plies[0];
  assert.equal(nf7.text, 'Nf7+ forks the king and the rook on h8.');
  assert.equal(nf7.facts.fork, true);
  assert.equal(nf7.facts.check, true);
  assert.deepEqual(nf7.facts.threats, [{ piece: 'r', color: 'b', square: 'h8', undefended: true }]);
  assert.deepEqual(nf7.facts.leftHanging, []);
  assert.equal(line.plies[1].text, 'Ke7 moves the king out of check and attacks the knight on f7, but the knight can take the rook on h8.');
  assert.equal(line.plies[2].text, 'Nxh8 takes the rook on h8.');
  assert.equal(line.summary, 'White wins a rook.');
  // A queen fork names the king and the rook before an undefended pawn it also hits (the fact keeps the pawn).
  const qfen = 'r5k1/6pp/5p2/1p6/8/8/8/3Q2K1 w - - 0 1';
  assert.equal(move(qfen, 'd1d5').san, 'Qd5+');
  const qd5 = describeMove(qfen, 'd1d5')!;
  assert.deepEqual(qd5.facts.threats.map(t => t.piece + t.square), ['ra8', 'pb5']);
  assert.equal(qd5.text, 'Qd5+ forks the king and the rook on a8.');
});

test('absolute pin: a new pin is reported once, an existing pin is not reported again', () => {
  const nimzo = play(['d4', 'Nf6', 'c4', 'e6', 'Nc3']);
  const bb4 = describeMove(nimzo, 'f8b4')!;
  assert.equal(bb4.text, 'Bb4 pins the knight on c3 to the king.');
  assert.deepEqual(bb4.facts.pins, [{ pinned: { piece: 'n', color: 'w', square: 'c3' }, behind: { piece: 'k', color: 'w', square: 'e1' }, by: { piece: 'b', color: 'b', square: 'b4' } }]);
  assert.equal(new Chess(bb4.fenAfter).moves({ square: 'c3' }).length, 0, 'chess.js agrees the knight cannot move');
  // The bishop slides back along the same diagonal: the knight stays pinned, but nothing NEW is pinned.
  const later = play(['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3']);
  const ba5 = describeMove(later, 'b4a5')!;
  assert.equal(new Chess(ba5.fenAfter).moves({ square: 'c3' }).length, 0);
  assert.deepEqual(ba5.facts.pins, []);
  assert.ok(!ba5.text.includes('pins'), ba5.text);
  // Castling while the pin stands does not report it either.
  assert.deepEqual(describeMove(later, 'e8g8')!.facts.pins, []);
});

test('a bishop taking away castling, only when the right is still in the FEN and castling was possible before', () => {
  // Invented: Black has castled neither way; the a3-f8 diagonal is open and b2 is empty.
  const fen = 'rnbqk2r/pppp1ppp/5n2/4p3/4P3/1P6/P1PP1PPP/RNBQK1NR w KQkq - 0 1';
  assert.ok(new Chess(play(['Nh3'], fen)).moves().includes('O-O'), 'Black could castle before');
  const ba3 = describeMove(fen, 'c1a3')!;
  assert.equal(ba3.text, 'Ba3 stops Black castling kingside.');
  assert.deepEqual(ba3.facts.castlingStopped, ['k']);
  assert.ok(!new Chess(ba3.fenAfter).moves().includes('O-O'));
  // No kingside right in the FEN: nothing is stopped.
  assert.deepEqual(describeMove(fen.replace('KQkq', 'KQq'), 'c1a3')!.facts.castlingStopped, []);
  // g8 already attacked by the rook on g1 (open g-file): castling was already impossible, so Ba3 stops nothing.
  const open = 'rnbqk2r/pppp1p1p/5n2/4p3/4P3/1P6/P1PP1P1P/RNBQK1R1 w Qkq - 0 1';
  assert.ok(new Chess(open).isAttacked('g8', 'w'));
  assert.deepEqual(describeMove(open, 'c1a3')!.facts.castlingStopped, []);
  // The bishop still on f8: castling was not possible anyway, so nothing is stopped (although f8 is now attacked).
  const early = play(['e4', 'e5', 'b3', 'Nf6']);
  const ba3Early = describeMove(early, 'c1a3')!;
  assert.ok(new Chess(ba3Early.fenAfter).isAttacked('f8', 'w'));
  assert.deepEqual(ba3Early.facts.castlingStopped, []);
  assert.ok(!ba3Early.text.includes('castling'), ba3Early.text);
  // A plain check does not count as stopping castling.
  const italian = play(['e4', 'e5', 'Nf3', 'd6']);
  const bb5 = describeMove(italian, 'f1b5')!;
  assert.equal(bb5.san, 'Bb5+');
  assert.deepEqual(bb5.facts.castlingStopped, []);
  assert.equal(bb5.text, 'Bb5+ gives check.');
});

test('en passant: the capture is the pawn on its own square', () => {
  const fen = play(['e4', 'Nf6', 'e5', 'd5']);
  assert.equal(move(fen, 'e5d6').isEnPassant(), true);
  const line = narrateLine(fen, ['e5d6']);
  const exd6 = line.plies[0];
  assert.equal(exd6.san, 'exd6');
  assert.deepEqual(exd6.facts.capture, { piece: 'p', color: 'b', square: 'd5' });
  assert.equal(exd6.text, 'exd6 takes the pawn on d5 en passant.');
  assert.deepEqual(line.material.won, [{ piece: 'p', color: 'b', square: 'd5' }]);
});

test('promotion with check, underpromotion, and a new queen that can be taken', () => {
  const fen = '7k/4P3/8/8/8/8/8/K7 w - - 0 1';
  assert.equal(move(fen, 'e7e8q').san, 'e8=Q+');
  const line = narrateLine(fen, ['e7e8q']);
  assert.equal(line.plies[0].text, 'e8=Q+ promotes with check.');
  assert.equal(line.plies[0].facts.promotion, 'q');
  assert.equal(line.material.net, 8);
  // FX1c (brief 9.11.3, the side condition on (r) 1): the new queen gives check, but White, the last mover, is already
  // ahead, so the check only adds to its lead and the line is settled, as before fix round 2. (FX1b had made this
  // "So far in this line White has promoted a pawn to a queen, and White is giving check.")
  assert.equal(line.material.settled, true);
  assert.equal(line.summary, 'White promotes a pawn to a queen.');
  assert.equal(narrateLine(fen, ['e7e8n']).summary, 'White promotes a pawn to a knight.', 'a promotion with no check is settled');
  assert.equal(describeMove(fen, 'e7e8n')!.text, 'e8=N promotes to a knight.');
  // The king can take the new queen: not settled, and the summary says what happened so far and what can follow
  // (F1, brief 9.3; was "The new queen can be taken at the end of the line.").
  const near = '3k4/4P3/8/8/8/8/8/K7 w - - 0 1';
  const taken = narrateLine(near, ['e7e8q']);
  assert.equal(taken.plies[0].san, 'e8=Q+');
  assert.equal(taken.material.settled, false);
  assert.equal(taken.summary, 'So far in this line White has promoted a pawn to a queen, but the new queen can be taken.');
  // Once taken, the promoted queen counts as the pawn it was: Black is a pawn up.
  const gone = narrateLine(near, ['e7e8q', 'd8e8']);
  assert.equal(gone.material.net, -1);
  assert.equal(gone.summary, 'Black wins a pawn.');
});

test('smothered mate and checkmate summaries', () => {
  const fen = '6rk/6pp/8/6N1/8/8/8/6K1 w - - 0 1';
  assert.ok(after(fen, 'g5f7').isCheckmate());
  const line = narrateLine(fen, ['g5f7']);
  assert.equal(line.plies[0].text, 'Nf7# is a smothered mate: the king is boxed in by its own pieces.');
  assert.equal(line.plies[0].facts.mate, true);
  assert.equal(line.result, 'mate');
  assert.equal(line.summary, 'The line ends in checkmate by White.');
  // A mate that takes something: one sentence, "with checkmate".
  const scholar = play(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6']);
  assert.equal(describeMove(scholar, 'h5f7')!.text, 'Qxf7# takes the pawn on f7 with checkmate.');
  // Plies after mate are illegal: the line stops there.
  const over = narrateLine(fen, ['g5f7', 'h8g8']);
  assert.equal(over.stoppedAt, 1);
  assert.equal(over.result, 'mate');
});

test('stalemate', () => {
  const fen = 'k7/8/1K6/8/8/8/8/2Q5 w - - 0 1';
  assert.ok(after(fen, 'c1c7').isStalemate());
  const line = narrateLine(fen, ['c1c7']);
  assert.equal(line.plies[0].text, 'Qc7 is stalemate: Black has no legal move, so the game is a draw.');
  assert.equal(line.plies[0].facts.stalemate, true);
  assert.equal(line.result, 'stalemate');
  assert.equal(line.summary, 'The line ends in stalemate, a draw.');
});

test('a line with an illegal or malformed ply stops there (stoppedAt) and never throws', () => {
  const broken = narrateLine(START, ['e2e4', 'e7e5', 'e4e5', 'g1f3']);
  assert.equal(broken.stoppedAt, 2);
  assert.deepEqual(broken.plies.map(p => p.san), ['e4', 'e5']);
  assert.equal(broken.summary, 'No material changes hands.', 'F1, brief 9.3: zero change, not "stays level"');
  assert.equal(narrateLine(START, ['e2e4', 'zz']).stoppedAt, 1);
  assert.equal(narrateLine(START, ['e2e4q']).stoppedAt, 0, 'a promotion letter on a pawn push');
  assert.equal(narrateLine('7k/4P3/8/8/8/8/8/K7 w - - 0 1', ['e7e8']).stoppedAt, 0, 'a promotion without its letter');
  const badFen = narrateLine('not a fen', ['e2e4']);
  assert.deepEqual([badFen.plies.length, badFen.stoppedAt, badFen.summary], [0, 0, '']);
  assert.equal(narrateLine(START, undefined as unknown as string[]).plies.length, 0);
  assert.equal(narrateLine(START, []).summary, '');
  assert.equal(narrateLine(START, [' E2E4 ']).plies[0]?.uci, 'e2e4', 'case and spaces are forgiven');
  assert.equal(narrateLine(START, ['e2e4', 'e7e5', 'g1f3'], { maxPlies: 2 }).plies.length, 2);
  assert.equal(narrateLine(START, ['e2e4', 'e7e5', 'g1f3'], { maxPlies: 2 }).stoppedAt, undefined);
  assert.equal(describeMove(START, 'e2e5'), null);
  assert.equal(describeMove('bad', 'e2e4'), null);
});

test('a line ending mid-exchange is not settled; one ending after the recapture is', () => {
  const qgd = play(['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7']);
  const mid = narrateLine(qgd, ['g5f6']);
  assert.equal(mid.plies[0].text, 'Bxf6 takes the knight on f6.', 'the pinned bishop can take back, so no pin is named');
  assert.equal(mid.material.settled, false);
  assert.equal(mid.material.net, 3);
  // F1, brief 9.3: an unsettled end says what changed so far, never a settled win (was "The exchanges are still
  // going at the end of the line.").
  assert.equal(mid.summary, 'So far in this line White has won a knight, but Black can take back on f6.');
  const done = narrateLine(qgd, ['g5f6', 'e7f6']);
  assert.equal(done.plies[1].text, 'Bxf6 takes the bishop on f6.');
  assert.equal(done.material.settled, true);
  assert.equal(done.material.net, 0);
  // F1: captures that cancel read "The trades are even." ("No material changes hands." is for lines with no capture).
  assert.equal(done.summary, 'The trades are even.');
  // A "recapture" that exists only on paper (the knight is pinned to its king) does not keep the line open.
  const pinnedBack = '4k3/3np3/8/1B2p3/8/8/8/4R1K1 w - - 0 1';
  assert.equal(move(pinnedBack, 'e1e5').san, 'Rxe5');
  assert.ok(after(pinnedBack, 'e1e5').attackers('e5' as Square, 'b').includes('d7' as Square), 'pseudo-legal attacker exists');
  const won = narrateLine(pinnedBack, ['e1e5']);
  assert.equal(won.material.settled, true);
  assert.equal(won.summary, 'White wins a pawn.');
});

test('F1 (Codex P2): the end of the line is checked whatever the last move was; an unsettled end never reads as a settled win', () => {
  // Codex's invented repro: Qxd7 Kh8 Qc7, after which the rook on c8 can take the queen.
  const fen = '2r3k1/3p4/8/8/8/8/8/3Q2K1 w - - 0 1';
  const line = narrateLine(fen, ['d1d7', 'g8h8', 'd7c7']);
  assert.deepEqual(line.plies.map(p => p.san), ['Qxd7', 'Kh8', 'Qc7']);
  assert.equal(new Chess(line.plies[2].fenAfter).move({ from: 'c8', to: 'c7' }).captured, 'q', 'Rxc7 is legal and takes the queen');
  assert.equal(line.plies[2].text, 'Qc7 lets the rook on c8 take the queen on c7.');
  assert.equal(line.material.net, 1);
  assert.equal(line.material.settled, false);
  assert.equal(line.summary, 'So far in this line White has won a pawn, but the rook on c8 can take the queen on c7.');
  // Zero change reads "No material changes hands.", also with White a queen up from the start (Codex: not "level").
  assert.equal(narrateLine('7k/8/8/8/8/8/8/Q5K1 w - - 0 1', ['a1b1']).summary, 'No material changes hands.');
  // A pawn that has just moved counts, as in its own sentence; en passant included.
  const push = narrateLine('4k3/1p6/8/8/8/2N5/8/4K3 b - - 0 1', ['b7b5']);
  assert.equal(push.plies[0].text, 'b5 lets the knight on c3 take the pawn on b5.');
  assert.equal(push.summary, 'So far in this line no material changes hands, but the knight on c3 can take the pawn on b5.');
  const ep = narrateLine('4k3/8/8/8/3p4/8/4P3/4K3 w - - 0 1', ['e2e4']);
  assert.ok(new Chess(ep.plies[0].fenAfter).moves().includes('dxe3'), 'en passant is legal');
  assert.equal(ep.summary, 'So far in this line no material changes hands, but the pawn on d4 can take the pawn on e4.');
  // A defended piece offered for an equal one after a quiet move is an offer to trade, not a loss: settled.
  const offer = narrateLine('2kr4/8/8/8/8/8/4K3/2R5 w - - 0 1', ['c1d1']);
  assert.ok(new Chess(offer.plies[0].fenAfter).moves().includes('Rxd1'), 'the rook on d8 can take, and the king takes back');
  assert.equal(offer.material.settled, true);
  assert.equal(offer.summary, 'No material changes hands.');
  // Captures that cancel: "The trades are even." (settled); unsettled: "the trades are even, but ...".
  const trades = narrateLine('6k1/8/5n2/3b4/8/2N5/8/3R2K1 w - - 0 1', ['c3d5', 'f6d5']);
  assert.equal(trades.summary, 'So far in this line the trades are even, but White can take back on d5.');
  // Mate and stalemate keep precedence; a line cut one move before a mate says that the mate is there.
  const scholar = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
  assert.equal(narrateLine(START, scholar).summary, 'The line ends in checkmate by White.');
  const cut = narrateLine(START, scholar.slice(0, 6));
  assert.equal(cut.material.settled, false);
  assert.equal(cut.summary, 'So far in this line no material changes hands, but White can mate in one: Qxf7#.');
  assert.equal(narrateLine('k7/8/1K6/8/8/8/8/2Q5 w - - 0 1', ['c1c7']).summary, 'The line ends in stalemate, a draw.');
});

test('F1: when the side already ahead is to move at the end, what it can still take only adds to its lead, so the count stands', () => {
  // Invented: Rxd5 wins the bishop, then Nf2 leaves the knight to the king. White is ahead and to move.
  const fen = '4k3/8/8/3b4/6n1/8/8/3RK3 w - - 0 1';
  const ahead = narrateLine(fen, ['d1d5', 'g4f2']);
  assert.ok(new Chess(ahead.plies[1].fenAfter).moves().includes('Kxf2'), 'the king can take the knight');
  assert.equal(ahead.plies[1].text, 'Nf2 lets the king take the knight on f2.');
  assert.equal(ahead.material.net, 3);
  assert.equal(ahead.material.settled, true);
  assert.equal(ahead.summary, 'White wins a bishop.');
  // The same end with the count level (no bishop to take): the side to move can change it, so not settled.
  const level = narrateLine('4k3/8/8/8/6n1/8/8/3RK3 w - - 0 1', ['d1d5', 'g4f2']);
  assert.equal(level.material.settled, false);
  assert.equal(level.summary, 'So far in this line no material changes hands, but the king can take the knight on f2.');
  // The side behind to move still unsettles a lead (Codex's repro above).
  assert.equal(narrateLine('2r3k1/3p4/8/8/8/8/8/3Q2K1 w - - 0 1', ['d1d7', 'g8h8', 'd7c7']).material.settled, false);
  // An exchange still going stays unsettled for either side (A1's take-back rule). When the side ahead is the one
  // that can take back, the clause says "and", not "but". Invented: Rxd5, then Rxe2+ with the king to take back.
  const back = narrateLine('4k3/8/8/3n4/8/8/4P2r/3RK3 w - - 0 1', ['d1d5', 'h2e2']);
  assert.equal(back.plies[1].san, 'Rxe2+');
  assert.ok(new Chess(back.plies[1].fenAfter).moves().includes('Kxe2'), 'the king can take back');
  assert.equal(back.material.net, 2);
  assert.equal(back.material.settled, false);
  assert.equal(back.summary, 'So far in this line White has won a knight for a pawn, and White can take back on e2.');
});

test('F1: allowsMate names a mate-in-one reply; its clause replaces the hanging clause and follows a check too', () => {
  // Scholar's mate: 4...Nf6 allows Qxf7#.
  const nf6 = describeMove(play(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5']), 'g8f6')!;
  assert.equal(nf6.facts.allowsMate, 'Qxf7#');
  assert.match(nf6.text, /^Nf6 [^,]+, but it allows mate in one: Qxf7#\.$/);
  // Nothing else to say: the short form. Invented back rank: the rook leaves the first rank, Re1 mates.
  const backRank = '4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
  assert.ok(after(after(backRank, 'd1d7').fen(), 'e8e1').isCheckmate());
  const rd7 = describeMove(backRank, 'd1d7')!;
  assert.equal(rd7.facts.allowsMate, 'Re1#');
  assert.equal(rd7.text, 'Rd7 allows mate in one: Re1#.');
  // The same move with the rook also left to a bishop: the facts keep the loose rook, the sentence names the mate only.
  const both = '2b1r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
  assert.ok(new Chess(after(both, 'd1d7').fen()).moves().includes('Bxd7'));
  const rd7b = describeMove(both, 'd1d7')!;
  assert.deepEqual(rd7b.facts.leftHanging.map(h => h.piece + h.square), ['rd7']);
  assert.equal(rd7b.text, 'Rd7 allows mate in one: Re1#.');
  // After a check too (invented): Rg1+ is met by hxg1=Q#.
  const chk = '8/6R1/8/8/8/8/7p/5k1K w - - 0 1';
  assert.ok(after(after(chk, 'g7g1').fen(), 'h2g1q').isCheckmate());
  const rg1 = describeMove(chk, 'g7g1')!;
  assert.equal(rg1.facts.check, true);
  assert.equal(rg1.text, 'Rg1+ gives check, but it allows mate in one: hxg1=Q#.');
  // Absent when there is no mate in one (the key is left out), and on a mating move itself.
  assert.equal('allowsMate' in describeMove(START, 'e2e4')!.facts, false);
  assert.equal('allowsMate' in describeMove(after(backRank, 'd1d7').fen(), 'e8e1')!.facts, false);
});

test('check kinds, answering a check, castling notation, and the quiet-move sentences', () => {
  const disc = '4k3/8/8/8/4N3/8/8/4R1K1 w - - 0 1';
  assert.equal(describeMove(disc, 'e4c5')!.text, 'Nc5+ uncovers check from the rook on e1.');
  assert.equal(describeMove(disc, 'e4f6')!.text, 'Nf6+ gives double check.');
  assert.equal(describeMove(disc, 'e4f6')!.facts.discovered[0].target.piece, 'k');
  // Blocking a check.
  const checked = play(['e4', 'e5', 'Nf3', 'd6', 'Bb5+']);
  assert.equal(describeMove(checked, 'c7c6')!.text, 'c6 blocks the check and attacks the bishop on b5.');
  // King-takes-rook castling notation is read as castling.
  const castle = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
  assert.equal(describeMove(castle, 'e1h1')!.text, 'O-O castles kingside.');
  assert.equal(describeMove(castle, 'e1h1')!.uci, 'e1g1');
  assert.equal(describeMove(castle, 'e1c1')!.text, 'O-O-O castles queenside.');
  assert.equal(describeMove(START, 'g1f3')!.text, 'Nf3 moves the knight to f3.');
  assert.equal(describeMove(START, 'e2e4')!.text, 'e4 pushes the pawn to e4.');
  // A quiet move that leaves the moved piece to a pawn.
  assert.equal(describeMove('4k3/8/8/3p4/8/8/8/R5K1 w - - 0 1', 'a1c1')!.text, 'Rc1 moves the rook to c1.');
  assert.equal(describeMove('4k3/8/8/3p4/8/8/8/2R3K1 w - - 0 1', 'c1c4')!.text, 'Rc4 lets the pawn on d5 take the rook on c4.');
  // Out of attack, defends, and the opposition (only when nothing tactical happens).
  assert.equal(describeMove('4k3/8/3p4/4N3/8/8/8/4K3 w - - 0 1', 'e5f3')!.text, 'Nf3 moves the knight out of attack.');
  assert.equal(describeMove('4k3/8/8/8/1b6/2N5/8/2B3K1 w - - 0 1', 'c1d2')!.text, 'Bd2 defends the knight on c3.');
  // The opposition (KPK drill position "take the opposition", public textbook data).
  const kpk = '8/8/4k3/8/3K4/4P3/8/8 w - - 0 1';
  assert.deepEqual(texts(kpk, ['e3e4', 'e6d6']), ['e4 pushes the pawn to e4.', 'Kd6 takes the opposition.']);
  assert.equal(describeMove(kpk, 'd4e4')!.text, 'Ke4 takes the opposition.');
});

test('clause priority: the moved piece\'s own threat comes before a pin that another piece gains', () => {
  // Invented: e5-e6 uncovers check from Bf4, hits the queen on d7, and cuts the Bg4 defence of d7, so the queen on
  // d2 now pins the knight on d4 to an undefended queen. The sentence keeps the two clauses that matter most.
  const fen = '1k6/pp1q1ppp/8/4P3/3n1Bb1/8/PPPQ2PP/1K6 w - - 0 1';
  assert.equal(move(fen, 'e5e6').san, 'e6+');
  const e6 = describeMove(fen, 'e5e6')!;
  assert.deepEqual(e6.facts.discovered.map(d => d.by.square + d.target.piece), ['f4k']);
  assert.deepEqual(e6.facts.threats.map(t => t.piece + t.square), ['qd7']);
  assert.deepEqual(e6.facts.pins.map(p => `${p.by.square}:${p.pinned.square}>${p.behind.square}`), ['d2:d4>d7']);
  assert.equal(e6.text, 'e6+ uncovers check from the bishop on f4 and attacks the queen on d7.');
});

test('trades cancel by kind first: winning a bishop and a knight for a knight is "a bishop"', () => {
  // Invented: 1.Nxd5 (takes the bishop) Nxd5 2.Rxd5 (takes the knight).
  const fen = '6k1/8/5n2/3b4/8/2N5/8/3R2K1 w - - 0 1';
  const line = narrateLine(fen, ['c3d5', 'f6d5', 'd1d5']);
  assert.deepEqual(line.plies.map(p => p.san), ['Nxd5', 'Nxd5', 'Rxd5']);
  assert.deepEqual(line.material.won.map(p => p.piece), ['b', 'n']);
  assert.deepEqual(line.material.lost.map(p => p.piece), ['n']);
  assert.equal(line.material.net, 3);
  assert.equal(line.summary, 'White wins a bishop.');
});

test('boardText lists pieces by kind and square, then pawns, then the side to move', () => {
  assert.equal(boardText(START),
    'White: Ke1, Qd1, Ra1, Rh1, Bc1, Bf1, Nb1, Ng1; pawns a2, b2, c2, d2, e2, f2, g2, h2. '
    + 'Black: Ke8, Qd8, Ra8, Rh8, Bc8, Bf8, Nb8, Ng8; pawns a7, b7, c7, d7, e7, f7, g7, h7. White to move.');
  assert.equal(boardText('8/8/4k3/8/3K4/4P3/8/8 b - - 0 1'), 'White: Kd4; pawn e3. Black: Ke6. Black to move.');
  assert.equal(boardText('nonsense'), '');
});

/** Seeded random playouts (pattern of tests/b3_fixtures.ts): every fact checked against chess.js. */
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
function between(a: string, b: string): string[] {
  const f0 = a.charCodeAt(0), r0 = Number(a[1]), f1 = b.charCodeAt(0), r1 = Number(b[1]);
  const df = Math.sign(f1 - f0), dr = Math.sign(r1 - r0);
  const out: string[] = [];
  for (let f = f0 + df, r = r0 + dr; f !== f1 || r !== r1; f += df, r += dr) out.push(String.fromCharCode(f) + r);
  return out;
}
function invariants(p: NarratedPly): string[] {
  const bad: string[] = [];
  const board = new Chess(p.fenAfter);
  const mover = p.color, enemy = mover === 'w' ? 'b' : 'w';
  const legal = board.moves({ verbose: true });
  if (!p.text.startsWith(`${p.san} `)) bad.push('starts with SAN');
  if (!p.text.endsWith('.')) bad.push('ends with a period');
  if (/undefined|NaN|!|—|–| - |\[|\]/.test(p.text)) bad.push('stray characters');
  for (const t of p.facts.threats) {
    if (t.piece === 'k' || t.color !== enemy) bad.push(`threat target ${t.square}`);
    if (!board.attackers(t.square as Square, mover).length) bad.push(`threat ${t.square} not attacked`);
  }
  for (const h of p.facts.leftHanging) {
    const ok = legal.some(m => m.from === h.by.square && m.captured && (m.isEnPassant() ? m.to[0] + m.from[1] : m.to) === h.square);
    if (!ok || h.color !== mover) bad.push(`hanging ${h.square} not a legal capture`);
  }
  for (const pin of p.facts.pins) {
    if (pin.behind.piece !== 'k') continue;
    const onLine = new Set([...between(pin.behind.square, pin.by.square), pin.by.square]);
    for (const m of legal) if (m.from === pin.pinned.square && !onLine.has(m.to)) bad.push(`pinned ${pin.pinned.square} leaves the line`);
  }
  for (const side of p.facts.castlingStopped) {
    if (!board.getCastlingRights(enemy)[side]) bad.push('castling right not in FEN');
    if (legal.some(m => (side === 'k' ? m.isKingsideCastle() : m.isQueensideCastle()))) bad.push('can still castle');
    const rank = enemy === 'w' ? '1' : '8';
    if ((side === 'k' ? 'fg' : 'bcd').split('').some(f => board.get(`${f}${rank}` as Square))) bad.push('castling was blocked anyway');
  }
  for (const d of p.facts.discovered) if (!board.attackers(d.target.square as Square, mover).includes(d.by.square as Square)) bad.push('discovered not attacking');
  if (p.facts.fork && !p.facts.threats.length) bad.push('fork without a threat');
  if (p.facts.mate !== board.isCheckmate() || p.facts.check !== board.inCheck() || p.facts.stalemate !== board.isStalemate()) bad.push('flags');
  // F1: allowsMate is a legal mating reply, and present whenever one exists.
  const mates = legal.filter(m => m.san.endsWith('#')).map(m => m.san);
  if (p.facts.allowsMate ? !mates.includes(p.facts.allowsMate) : mates.length > 0) bad.push('allowsMate');
  return bad.map(b => `${b}: ${p.fenBefore} ${p.uci} -> ${p.text}`);
}

test('invariant sweep over seeded random games: every computed fact agrees with chess.js', () => {
  const rand = rng(20261112);
  const failures: string[] = [];
  let plies = 0, forks = 0, pins = 0, hanging = 0, warned = 0;
  for (let g = 0; g < 16; g++) {
    const b = new Chess();
    const line: string[] = [];
    for (let i = 0; i < 48 && !b.isGameOver(); i++) {
      const ms = b.moves({ verbose: true });
      const sharp = ms.filter(m => m.captured || m.san.includes('+'));
      const pick = sharp.length && rand() < 0.5 ? sharp[Math.floor(rand() * sharp.length)] : ms[Math.floor(rand() * ms.length)];
      b.move(pick);
      line.push(pick.from + pick.to + (pick.promotion ?? ''));
    }
    const n = narrateLine(new Chess().fen(), line, { maxPlies: 64 });
    assert.equal(n.stoppedAt, undefined, `game ${g} replays in full`);
    assert.equal(n.plies.length, line.length);
    for (const p of n.plies) {
      plies++;
      if (p.facts.fork) forks++;
      if (p.facts.pins.length) pins++;
      if (p.facts.leftHanging.length) hanging++;
      failures.push(...invariants(p));
      // F1 (Codex P2): every ply as a one-move line. A closing sentence that warns (a piece can be taken, or a mate
      // in one) never sits beside a settled summary, and an unsettled summary never claims a settled result.
      const one = narrateLine(p.fenBefore, [p.uci]);
      const warns = /, but [^.]* can take |^\S+ lets [^.]* take |allows mate in one/.test(one.plies[0].text);
      if (warns) warned++;
      if (warns && one.material.settled) failures.push(`warning caption beside a settled summary: ${p.fenBefore} ${p.uci} -> ${one.plies[0].text} | ${one.summary}`);
      if (!one.material.settled && !one.summary.startsWith('So far in this line ')) failures.push(`unsettled summary: ${p.fenBefore} ${p.uci} -> ${one.summary}`);
      if (one.material.settled && /^So far/.test(one.summary)) failures.push(`settled "so far": ${one.summary}`);
    }
  }
  assert.deepEqual(failures.slice(0, 5), []);
  assert.ok(plies > 600 && forks > 5 && pins > 3 && hanging > 60 && warned > 20, JSON.stringify({ plies, forks, pins, hanging, warned }));
});
