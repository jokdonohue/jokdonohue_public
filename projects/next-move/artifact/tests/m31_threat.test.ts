import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import {
  almostAsHighly, applyThreatHints, narrateAsViewer, passFen, QUIET_BARE, readThreat, targetReason, threatFacts, threatSay, THREAT_MAX_PLIES,
  type ThreatCard, type ThreatFacts,
} from '../src/teach/threat';
import { buildHints, buildHintsWithRules, type Hint } from '../src/teach/hints';
import { lineNarration } from '../components/LineViewer';
import type { TeachThreat } from '../src/contract/teachDocs';

// Version 7.1, item A (brief m31, 4.1 and 4.3): the page module. Every position below is invented for these tests
// (bare kings, a few pieces, round move numbers); none comes from a game.

/** A: White's rook goes to d5 and then attacks the loose knight on a5. */
const A_FEN = '6k1/5pp1/7p/n7/8/8/5PPP/3R2K1 w - - 0 1';
/** B: White's knight goes to d5; from there Ne7+ forks the king and the queen on c8. */
const B_FEN = '2q3k1/2p2pp1/7p/8/8/2N5/5PPP/6K1 w - - 0 1';
/** B with the knight already on d5: the check is legal on the card. */
const B_PRE_FEN = '2q3k1/2p2pp1/7p/3N4/8/8/5PPP/6K1 w - - 0 1';
/** C: White's queen goes to e4; with the bishop on d3 behind it, Qxh7 is then mate. */
const C_FEN = '5rk1/5ppp/1n6/8/8/3B4/4QPPP/6K1 w - - 0 1';
/** D: a pawn steps to b7 and can then promote. D_PRE: it already stands on b7. */
const D_FEN = '8/8/1P4k1/8/8/8/6K1/n7 w - - 0 1';
const D_PRE_FEN = '8/1P6/6k1/8/8/8/6K1/n7 w - - 0 1';
/** DR: the pawn promotes, the rook on a8 takes the new queen, and White's rook takes back. */
const DR_FEN = 'r7/8/1P4k1/8/8/8/6K1/1R6 w - - 0 1';
/** E: the knight on e5 is pinned to its king by the rook on e1 and attacked by the pawn on f4. */
const E_FEN = '4k3/6pp/3p4/4n3/5P2/8/6PP/4R1K1 w - - 0 1';
/** F: the same, but the rook is on d1: the answer Re1 itself makes the pin. */
const F_FEN = '4k3/6pp/3p4/4n3/5P2/8/6PP/3R2K1 w - - 0 1';
/** G: Black to move; the rook goes to d4 and then takes the loose knight on a4. */
const G_FEN = '3r2k1/5ppp/8/8/N7/7P/5PP1/6K1 b - - 3 30';

const entry = (a: string, t: string[], k: string, pre: boolean, extra: Partial<TeachThreat> = {}): TeachThreat => ({ id: 'card', a, t, k, pre, ...extra });
const card = (fen: string, a: string, teach?: TeachThreat | null, kind?: string): ThreatCard => ({ fen, moves: [a], ...(kind ? { kind } : {}), ...(teach !== undefined ? { teach } : {}) });
const A_CARD = () => card(A_FEN, 'd1d5', entry('d1d5', ['d5a5'], 'capture', false, { sq: 'a5', r: 'undefended' }));
const B_CARD = () => card(B_FEN, 'c3d5', entry('c3d5', ['d5e7', 'g8h7', 'e7c8'], 'check', false, { sq: 'c8', r: 'undefended' }));
const B_PRE_CARD = () => card(B_PRE_FEN, 'g2g3', entry('g2g3', ['d5e7', 'g8h7', 'e7c8'], 'check', true, { sq: 'c8', r: 'undefended' }));
const C_CARD = () => card(C_FEN, 'e2e4', entry('e2e4', ['e4h7'], 'mate', false));
const D_CARD = () => card(D_FEN, 'b6b7', entry('b6b7', ['b7b8q'], 'promotion', false));
const D_PRE_CARD = () => card(D_PRE_FEN, 'g2f3', entry('g2f3', ['b7b8q'], 'promotion', true));
const DR_CARD = () => card(DR_FEN, 'b6b7', entry('b6b7', ['b7b8q', 'a8b8', 'b1b8'], 'promotion', false, { sq: 'a8', r: 'undefended' }));
const E_CARD = () => card(E_FEN, 'h2h3', entry('h2h3', ['f4e5', 'd6e5', 'e1e5'], 'capture', true, { sq: 'e5', r: 'pinned', pin: 'e8' }));
const G_CARD = () => card(G_FEN, 'd8d4', entry('d8d4', ['d4a4'], 'capture', false, { sq: 'a4', r: 'undefended' }), 'punish');

/** A version 7 ladder as `buildHints` shapes it, with the bare quiet idea at rung 1. */
const ladder = (head = '', two: Partial<Hint> = { text: 'The right move goes to d5.', square: 'd5' }): Hint[] => [
  { level: 1, text: `${head}${QUIET_BARE}` },
  { level: 2, text: 'x', ...two } as Hint,
  { level: 3, text: 'Use your rook on d1.', square: 'd1' },
  { level: 4, text: 'Play Rd5.', arrow: 'd1d5' },
];

test('threat: QUIET_BARE is the sentence version 7 prints for a quiet answer with nothing else to say', () => {
  assert.equal(QUIET_BARE, 'The right move is a quiet one: no capture and no check.');
  for (const [fen, a] of [[C_FEN, 'e2e4'], [E_FEN, 'h2h3'], [D_PRE_FEN, 'g2f3']] as const) {
    const r = buildHintsWithRules({ fen, line: [a], themes: ['quiet'], kind: 'pack', ply: 0 });
    assert.equal(r.rules.idea, 'quiet', fen);
    assert.equal(r.hints[0].text, QUIET_BARE, fen);
  }
});

test('passFen: the answer played, the move handed back, en passant cleared, the counters moved on', () => {
  // White solves: halfmove + 1 and the move number + 1 (Black is the side that passes).
  assert.equal(passFen(A_FEN, 'd1d5'), '6k1/5pp1/7p/n2R4/8/8/5PPP/6K1 w - - 2 2');
  // A pawn move resets the halfmove clock first.
  assert.equal(passFen(D_FEN, 'b6b7'), '8/1P6/6k1/8/8/8/6K1/n7 w - - 1 2');
  // Black solves: the move number was already raised by the answer and stays.
  assert.equal(passFen(G_FEN, 'd8d4'), '6k1/5ppp/8/8/N2r4/7P/5PP1/6K1 b - - 5 31');
  // A double pawn step leaves an en-passant square after the answer; the pass position has none.
  const ep = '6k1/8/8/8/3p4/8/4P1PP/6K1 w - - 0 1';
  const after = new Chess(ep); after.move({ from: 'e2', to: 'e4' });
  assert.equal(after.fen().split(' ')[3], 'e3', 'chess.js keeps the en-passant square after the answer');
  assert.equal(passFen(ep, 'e2e4'), '6k1/8/8/8/3pP3/8/6PP/6K1 w - - 1 2');
  // Castling is quiet; the castling rights of the side that passes are kept.
  assert.equal(passFen('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1', 'e1g1'), 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R4RK1 w kq - 2 2');
  // Every pass position loads, keeps the solver on move and leaves the opponent out of check.
  for (const [fen, a] of [[A_FEN, 'd1d5'], [B_FEN, 'c3d5'], [C_FEN, 'e2e4'], [E_FEN, 'h2h3'], [G_FEN, 'd8d4']] as const) {
    const p = passFen(fen, a)!;
    const b = new Chess(p);
    assert.equal(b.turn(), new Chess(fen).turn());
    const foeKing = b.findPiece({ type: 'k', color: b.turn() === 'w' ? 'b' : 'w' })[0];
    assert.equal(b.isAttacked(foeKing, b.turn()), false);
  }
});

test('passFen: null unless the answer is legal and quiet', () => {
  assert.equal(passFen(A_FEN, 'd1d8'), null, 'a check');
  assert.equal(passFen(C_FEN, 'd3h7'), null, 'a capture with check');
  assert.equal(passFen(E_FEN, 'f4e5'), null, 'a capture');
  assert.equal(passFen(D_PRE_FEN, 'b7b8q'), null, 'a promotion');
  assert.equal(passFen('6k1/8/8/3pP3/8/8/6PP/6K1 w - d6 0 2', 'e5d6'), null, 'an en-passant capture');
  assert.equal(passFen('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 'a1a8'), null, 'mate');
  assert.equal(passFen(A_FEN, 'd1d9'), null, 'not a move');
  assert.equal(passFen(A_FEN, 'a1a2'), null, 'not legal');
  assert.equal(passFen('not a fen', 'd1d5'), null);
  for (const odd of [undefined, null, 5, {}, []]) assert.equal(passFen(odd as never, odd as never), null);
});

test('readThreat: the kind and "already legal on the card", read from the replay alone', () => {
  const kinds: Array<[string, string, string[], string, boolean, string[]]> = [
    [A_FEN, 'd1d5', ['d5a5'], 'capture', false, ['Rxa5']],
    [B_FEN, 'c3d5', ['d5e7', 'g8h7', 'e7c8'], 'check', false, ['Ne7+', 'Kh7', 'Nxc8']],
    [B_PRE_FEN, 'g2g3', ['d5e7', 'g8h7', 'e7c8'], 'check', true, ['Ne7+', 'Kh7', 'Nxc8']],
    [C_FEN, 'e2e4', ['e4h7'], 'mate', false, ['Qxh7#']],
    [D_FEN, 'b6b7', ['b7b8q'], 'promotion', false, ['b8=Q']],
    [D_PRE_FEN, 'g2f3', ['b7b8q'], 'promotion', true, ['b8=Q']],
    [E_FEN, 'h2h3', ['f4e5', 'd6e5', 'e1e5'], 'capture', true, ['fxe5', 'dxe5', 'Rxe5+']],
    [G_FEN, 'd8d4', ['d4a4'], 'capture', false, ['Rxa4']],
  ];
  for (const [fen, a, t, k, pre, san] of kinds) {
    const r = readThreat(fen, a, t)!;
    assert.ok(r, fen);
    assert.deepEqual([r.k, r.pre, r.san, r.line, r.passFen], [k, pre, san, t, passFen(fen, a)], fen);
    assert.equal(r.firstFrom, t[0].slice(0, 2));
    assert.deepEqual(r.answerSquares, [a.slice(0, 2), a.slice(2, 4)]);
  }
  // A check that is also a capture is a check; a line that ends in mate is a mate whatever its first move is.
  assert.equal(readThreat(E_FEN, 'h2h3', ['e1e5'])!.k, 'check');
  const mateInTwo = readThreat('7k/p5pp/8/8/8/1n6/5PPP/4R1K1 w - - 0 1', 'g2g3', ['h2h4', 'a7a6', 'e1e8'])!;
  assert.deepEqual([mateInTwo.k, mateInTwo.pre, mateInTwo.san], ['mate', true, ['h4', 'a6', 'Re8#']]);
  // Mate by the OTHER side at the end of the line is not a mate threat: the first move decides.
  const mated = readThreat('6k1/5ppp/8/8/8/8/r4PPP/1N4K1 w - - 0 1', 'h2h3', ['b1a3', 'a2a1']);
  assert.equal(mated, null, 'a quiet first move and a mate by the opponent');
  // Castling answers touch four squares.
  const castle = readThreat('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1', 'e1g1', ['f1e1', 'e8g8', 'e1e7'])!;
  assert.equal(castle, null, 'no forcing first move');
  assert.deepEqual(readThreat('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', 'e1c1', ['d1d8'])?.answerSquares, ['e1', 'c1', 'a1', 'd1']);
});

test('readThreat: null for a line the page cannot use', () => {
  assert.equal(readThreat(A_FEN, 'd1d5', []), null, 'empty');
  assert.equal(readThreat(A_FEN, 'd1d5', ['d5d7']), null, 'a quiet first move, no mate');
  assert.equal(readThreat(A_FEN, 'd1d5', ['h2h3', 'g8h7', 'd5a5']), null, 'a quiet first move before a capture');
  assert.equal(readThreat(A_FEN, 'd1d5', ['d5a5', 'g8g7']), null, 'a ply that is not legal');
  assert.equal(readThreat(A_FEN, 'd1d5', ['a5a6']), null, 'not the solver\'s move');
  assert.equal(readThreat(A_FEN, 'd1d8', ['d8g8']), null, 'the answer is a check');
  assert.equal(readThreat(E_FEN, 'f4e5', ['d6e5']), null, 'the answer is a capture');
  assert.equal(readThreat(A_FEN, 'd1d5', 'd5a5' as never), null);
  assert.equal(THREAT_MAX_PLIES, 8);
  const nine = ['d5d4', 'g8h7', 'd4d5', 'h7g8', 'd5d4', 'g8h7', 'd4d5', 'h7g8', 'd5a5'];
  assert.equal(readThreat(A_FEN, 'd1d5', nine), null, 'nine plies');
  assert.equal(readThreat(A_FEN, 'd1d5', ['d5a5', ...nine.slice(0, 0)])!.k, 'capture');
  for (const odd of [undefined, null, 5, {}]) assert.equal(readThreat(odd as never, odd as never, odd as never), null);
});

test('targetReason: pinned to its own king first, else undefended, else nothing; read on the position given', () => {
  assert.deepEqual(targetReason(E_FEN, 'e5'), { r: 'pinned', pin: 'e8' });
  assert.equal(targetReason(F_FEN, 'e5'), null, 'the rook is not on the e-file yet, and the pawn on d6 defends the knight');
  assert.deepEqual(targetReason(passFen(F_FEN, 'd1e1')!, 'e5'), { r: 'pinned', pin: 'e8' }, 'after the answer the pin exists: that is why the builder reads the card');
  assert.deepEqual(targetReason(A_FEN, 'a5'), { r: 'undefended' });
  assert.deepEqual(targetReason(B_FEN, 'c8'), { r: 'undefended' });
  assert.equal(targetReason(B_FEN, 'c7'), null, 'the queen defends the pawn');
  // Pins along a rank and a diagonal; a piece between breaks the pin; the pinner must move along the line.
  assert.deepEqual(targetReason('8/8/8/8/R2n2k1/8/8/6K1 b - - 0 1', 'd4'), { r: 'pinned', pin: 'g4' });
  assert.deepEqual(targetReason('7k/6r1/8/8/3Q4/8/8/6K1 b - - 0 1', 'g7'), { r: 'pinned', pin: 'h8' });
  assert.deepEqual(targetReason('8/8/8/8/R1pn2k1/8/8/6K1 b - - 0 1', 'd4'), { r: 'undefended' }, 'the pawn on c4 stands between');
  assert.deepEqual(targetReason('8/8/8/8/B2n2k1/8/8/6K1 b - - 0 1', 'd4'), { r: 'undefended' }, 'a bishop does not pin along a rank');
  assert.deepEqual(targetReason('8/8/8/8/r2n2k1/8/8/6K1 b - - 0 1', 'd4'), null, 'its own rook behind it defends it');
  // Not for a king, an empty square or junk.
  assert.equal(targetReason(E_FEN, 'e8'), null);
  assert.equal(targetReason(E_FEN, 'a1'), null);
  assert.equal(targetReason(E_FEN, 'z9'), null);
  assert.equal(targetReason('nope', 'e5'), null);
});

test('threatFacts: the checked facts of each kind', () => {
  const expected: Array<[() => ThreatCard, ThreatFacts]> = [
    [A_CARD, { answerSan: 'Rd5', firstSan: 'Rxa5', passFen: passFen(A_FEN, 'd1d5')!, line: ['d5a5'], k: 'capture', pre: false, target: { square: 'a5', piece: 'n', colour: 'b' }, reason: { kind: 'undefended' }, solver: 'White', opponent: 'Black' }],
    [B_CARD, { answerSan: 'Nd5', firstSan: 'Ne7+', passFen: passFen(B_FEN, 'c3d5')!, line: ['d5e7', 'g8h7', 'e7c8'], k: 'check', pre: false, target: { square: 'c8', piece: 'q', colour: 'b' }, reason: { kind: 'undefended' }, solver: 'White', opponent: 'Black' }],
    [C_CARD, { answerSan: 'Qe4', firstSan: 'Qxh7#', passFen: passFen(C_FEN, 'e2e4')!, line: ['e4h7'], k: 'mate', pre: false, target: { square: 'g8', piece: 'k', colour: 'b' }, solver: 'White', opponent: 'Black' }],
    [D_CARD, { answerSan: 'b7', firstSan: 'b8=Q', passFen: passFen(D_FEN, 'b6b7')!, line: ['b7b8q'], k: 'promotion', pre: false, solver: 'White', opponent: 'Black' }],
    [E_CARD, { answerSan: 'h3', firstSan: 'fxe5', passFen: passFen(E_FEN, 'h2h3')!, line: ['f4e5', 'd6e5', 'e1e5'], k: 'capture', pre: true, target: { square: 'e5', piece: 'n', colour: 'b' }, reason: { kind: 'pinned', to: 'e8' }, solver: 'White', opponent: 'Black' }],
    [G_CARD, { answerSan: 'Rd4', firstSan: 'Rxa4', passFen: passFen(G_FEN, 'd8d4')!, line: ['d4a4'], k: 'capture', pre: false, target: { square: 'a4', piece: 'n', colour: 'w' }, reason: { kind: 'undefended' }, solver: 'Black', opponent: 'White' }],
  ];
  for (const [make, facts] of expected) assert.deepEqual(threatFacts(make()), facts);
});

test('threatFacts: null (version 7 behaviour) unless the entry is for this answer and the page reads the same kind', () => {
  assert.equal(threatFacts(card(A_FEN, 'd1d5')), null, 'no entry');
  assert.equal(threatFacts(card(A_FEN, 'd1d5', null)), null, 'null entry');
  // The `a` guard: an entry computed for another answer (a stale one after a pack refresh) is not used.
  assert.equal(threatFacts(card(A_FEN, 'd1d4', A_CARD().teach)), null, 'the card\'s move changed');
  assert.equal(threatFacts(card(A_FEN, 'd1d5', entry('d1d4', ['d5a5'], 'capture', false))), null, 'the entry names another answer');
  // The page's own reading must agree with the stored kind and with `pre`.
  assert.equal(threatFacts(card(A_FEN, 'd1d5', entry('d1d5', ['d5a5'], 'check', false))), null, 'stored check, read capture');
  assert.equal(threatFacts(card(A_FEN, 'd1d5', entry('d1d5', ['d5a5'], 'mate', false))), null);
  assert.equal(threatFacts(card(A_FEN, 'd1d5', entry('d1d5', ['d5a5'], 'fork', false))), null, 'a kind this page does not know');
  assert.equal(threatFacts(card(A_FEN, 'd1d5', entry('d1d5', ['d5a5'], 'capture', true))), null, 'stored pre true, read false');
  assert.equal(threatFacts(card(E_FEN, 'h2h3', entry('h2h3', ['f4e5', 'd6e5', 'e1e5'], 'capture', false))), null, 'stored pre false, read true');
  // The line must replay, in 1 to 8 plies, from the pass position of a quiet answer.
  assert.equal(threatFacts(card(A_FEN, 'd1d5', entry('d1d5', ['d5a5', 'g8g7'], 'capture', false))), null);
  assert.equal(threatFacts(card(A_FEN, 'd1d5', entry('d1d5', [], 'capture', false))), null);
  assert.equal(threatFacts(card(A_FEN, 'd1d8', entry('d1d8', ['d8g8'], 'capture', false))), null, 'the answer is not quiet');
  // Junk never throws.
  for (const odd of [undefined, null, 5, 'x', {}, { fen: A_FEN }, { fen: 5, moves: 'd1d5', teach: 7 }, { fen: A_FEN, moves: ['d1d5'], teach: { a: 'd1d5', t: 'd5a5', k: 'capture', pre: false } }, { fen: A_FEN, moves: ['d1d5'], teach: { a: 'd1d5', t: ['d5a5'], k: 'capture', pre: 'no' } }]) {
    assert.equal(threatFacts(odd as never), null);
    assert.equal(threatSay(odd as never), null);
  }
});

test('threatFacts: a target or a reason that fails on the card is dropped alone', () => {
  const base = () => E_CARD().teach!;
  const facts = (extra: Partial<TeachThreat>) => threatFacts(card(E_FEN, 'h2h3', { ...base(), ...extra }))!;
  const bare = (f: ThreatFacts) => [f.k, f.pre, f.line.length, f.target, f.reason];
  // sq: no enemy piece other than the king there, or a square of the answer: sq, r and pin go; the rest stays.
  for (const sq of ['a1', 'e1', 'e8', 'h3', 'h2', 'f4', 'z9']) assert.deepEqual(bare(facts({ sq })), ['capture', true, 3, undefined, undefined], sq);
  assert.deepEqual(bare(facts({ sq: undefined })), ['capture', true, 3, undefined, undefined], 'a reason without a square is not used');
  // pin: not the enemy king's square: r and pin go; the target stays.
  const target = { square: 'e5', piece: 'n', colour: 'b' };
  for (const pin of ['d6', 'e1', 'g1', 'a1', undefined, 'e9']) assert.deepEqual(bare(facts({ pin })), ['capture', true, 3, target, undefined], String(pin));
  // The reason must be true on the card: a defended piece is not "undefended"; an unknown reason is not printed.
  assert.deepEqual(bare(facts({ r: 'undefended', pin: undefined })), ['capture', true, 3, target, undefined]);
  assert.deepEqual(bare(facts({ r: 'attacked twice' })), ['capture', true, 3, target, undefined]);
  assert.deepEqual(bare(facts({ r: undefined })), ['capture', true, 3, target, undefined]);
  // A pin the answer itself creates is not a fact of the card: stored or not, the page does not print it.
  const made = threatFacts(card(F_FEN, 'd1e1', entry('d1e1', ['f4e5', 'd6e5', 'e1e5'], 'capture', true, { sq: 'e5', r: 'pinned', pin: 'e8' })))!;
  assert.deepEqual(bare(made), ['capture', true, 3, target, undefined]);
  // Another enemy piece is accepted as the target when it stands there (the page does not re-derive which piece the
  // line wins; the builder does), with a reason only when that reason is true of it.
  assert.deepEqual(bare(facts({ sq: 'd6', r: 'undefended', pin: undefined })), ['capture', true, 3, { square: 'd6', piece: 'p', colour: 'b' }, { kind: 'undefended' }]);
  // A mate names the enemy king and never a reason, whatever is stored.
  const mate = threatFacts(card(C_FEN, 'e2e4', entry('e2e4', ['e4h7'], 'mate', false, { sq: 'h7', r: 'undefended' })))!;
  assert.deepEqual([mate.target, mate.reason], [{ square: 'g8', piece: 'k', colour: 'b' }, undefined]);
});

test('threatFacts and threatSay are cached per card object', () => {
  const c = A_CARD();
  const first = threatFacts(c);
  assert.equal(threatFacts(c), first, 'same object back');
  assert.equal(threatSay(c), threatSay(c));
  // The cache is keyed by the object, so a new card object is read afresh (the pools make new objects).
  const again = A_CARD();
  assert.notEqual(threatFacts(again), first);
  assert.deepEqual(threatFacts(again), first);
  const none = card(A_FEN, 'd1d5');
  assert.equal(threatFacts(none), null);
  assert.equal(threatFacts(none), null);
});

test('applyThreatHints: H1 for every kind, with the head kept', () => {
  const one = (c: ThreatCard, head = '') => applyThreatHints(ladder(head), threatFacts(c), false)[0].text;
  assert.equal(one(C_CARD()), 'The right move is a quiet one, but it threatens checkmate.');
  assert.equal(one(B_CARD()), 'The right move is a quiet one, but it threatens a check that wins material.');
  assert.equal(one(A_CARD()), 'The right move is a quiet one, but it threatens a capture that wins material.');
  assert.equal(one(D_CARD()), 'The right move is a quiet one, but it threatens to promote a pawn.');
  assert.equal(one(B_PRE_CARD()), 'The right move is a quiet one. It prepares a check that wins material.');
  assert.equal(one(E_CARD()), 'The right move is a quiet one. It prepares a capture that wins material.');
  assert.equal(one(D_PRE_CARD()), 'The right move is a quiet one. It prepares the promotion of a pawn.');
  // A mate always "threatens", also when its first move is already legal on the card.
  const mateInTwo = card('7k/p5pp/8/8/8/1n6/5PPP/4R1K1 w - - 0 1', 'g2g3', entry('g2g3', ['h2h4', 'a7a6', 'e1e8'], 'mate', true));
  assert.equal(threatFacts(mateInTwo)!.pre, true);
  assert.equal(one(mateInTwo), 'The right move is a quiet one, but it threatens checkmate.');
  // The head before the quiet sentence stays (a punish card names his game move first).
  const head = 'The move just played, Nb6, was yours in the game. ';
  assert.equal(one(C_CARD(), head), `${head}The right move is a quiet one, but it threatens checkmate.`);
  assert.equal(one(E_CARD(), head), `${head}The right move is a quiet one. It prepares a capture that wins material.`);
});

test('applyThreatHints: H2 names the target; without a target, and for a promotion, rung 2 stays', () => {
  const two = (c: ThreatCard, punish = false) => applyThreatHints(ladder(), threatFacts(c), punish)[1];
  assert.deepEqual(two(C_CARD()), { level: 2, text: 'Target: the black king on g8. The right move threatens checkmate.', square: 'g8' });
  assert.deepEqual(two(B_CARD()), { level: 2, text: 'Target: the queen on c8. It is undefended. The right move threatens a check that wins it.', square: 'c8' });
  assert.deepEqual(two(B_PRE_CARD()), { level: 2, text: 'Target: the queen on c8. It is undefended. The right move prepares a check that wins it. Giving the check at once is not the move.', square: 'c8' });
  assert.deepEqual(two(A_CARD()), { level: 2, text: 'Target: the knight on a5. It is undefended. The right move threatens to win it.', square: 'a5' });
  assert.deepEqual(two(E_CARD()), { level: 2, text: 'Target: the knight on e5. It is pinned to the king on e8. The right move prepares to win it. Playing the capture at once is not the move.', square: 'e5' });
  // No reason: the bracket is left out.
  const noReason = card(F_FEN, 'd1e1', entry('d1e1', ['f4e5', 'd6e5', 'e1e5'], 'capture', true, { sq: 'e5' }));
  assert.deepEqual(two(noReason), { level: 2, text: 'Target: the knight on e5. The right move prepares to win it. Playing the capture at once is not the move.', square: 'e5' });
  // A punish card names pieces with their colour, as version 7 does.
  assert.equal(two(A_CARD(), true).text, 'Target: the black knight on a5. It is undefended. The right move threatens to win it.');
  assert.equal(two(G_CARD(), true).text, 'Target: the white knight on a4. It is undefended. The right move threatens to win it.');
  assert.equal(two(E_CARD(), true).text, 'Target: the black knight on e5. It is pinned to the king on e8. The right move prepares to win it. Playing the capture at once is not the move.');
  assert.equal(two(C_CARD(), true).text, 'Target: the black king on g8. The right move threatens checkmate.');
  // The old mark and any arrow go with the old text.
  const marked = applyThreatHints(ladder('', { text: 'The right move goes to d5.', square: 'd5', arrow: 'd1d5' }), threatFacts(A_CARD()), false)[1];
  assert.deepEqual(Object.keys(marked).sort(), ['level', 'square', 'text']);
  assert.equal(marked.square, 'a5');
  // No target: rung 1 changes, rung 2 is version 7's.
  const v7 = ladder()[1];
  assert.deepEqual(two(D_CARD()), v7);
  assert.deepEqual(two(card(A_FEN, 'd1d5', entry('d1d5', ['d5a5'], 'capture', false))), v7, 'an entry without sq');
  // A promotion with a target: table 4.3 gives no target text for it, so rung 2 stays as well.
  assert.equal(threatFacts(DR_CARD())!.target?.square, 'a8');
  assert.deepEqual(two(DR_CARD()), v7);
  assert.equal(applyThreatHints(ladder(), threatFacts(DR_CARD()), false)[0].text, 'The right move is a quiet one, but it threatens to promote a pawn.');
});

test('applyThreatHints: never adds or removes a rung, never touches rungs 3 and 4, and leaves other ladders alone', () => {
  const cards = [A_CARD(), B_CARD(), B_PRE_CARD(), C_CARD(), D_CARD(), D_PRE_CARD(), DR_CARD(), E_CARD(), G_CARD()];
  for (const c of cards) for (const punish of [false, true]) {
    const before = ladder();
    const frozen = JSON.stringify(before);
    const after = applyThreatHints(before, threatFacts(c), punish);
    assert.equal(JSON.stringify(before), frozen, 'the ladder passed in is not changed');
    assert.deepEqual(after.map(h => h.level), [1, 2, 3, 4]);
    assert.equal(after[2], before[2], 'rung 3 is the same object');
    assert.equal(after[3], before[3], 'rung 4 is the same object');
    assert.notEqual(after[0].text, before[0].text);
    // Twice is once: the new rung 1 no longer ends with the bare sentence.
    assert.deepEqual(applyThreatHints(after, threatFacts(c), punish), after);
  }
  // Null facts: unchanged, with the same rung objects.
  const l = ladder();
  const same = applyThreatHints(l, null, false);
  assert.deepEqual(same, l);
  same.forEach((h, i) => assert.equal(h, l[i]));
  // No rung 1 that ends with the bare sentence: unchanged, whatever the facts.
  const others: Hint[][] = [
    [{ level: 1, text: 'Look for a fork: one move that attacks two pieces at once.' }, ...ladder().slice(1)],
    [{ level: 1, text: 'Start with a quiet move (no capture, no check). A fork follows on your second move.' }, ...ladder().slice(1)],
    [{ level: 1, text: `${QUIET_BARE} ` }, ...ladder().slice(1)],
    [{ level: 2, text: QUIET_BARE }, { level: 3, text: QUIET_BARE, square: 'd1' }],
    [],
  ];
  for (const o of others) {
    const out = applyThreatHints(o, threatFacts(A_CARD()), false);
    assert.deepEqual(out, o);
    out.forEach((h, i) => assert.equal(h, o[i]));
  }
  assert.deepEqual(applyThreatHints(undefined as never, threatFacts(A_CARD()), false), []);
});

test('applyThreatHints on real version 7 ladders: only rungs 1 and 2 can change, and nothing gives the answer away', () => {
  const real: Array<[ThreatCard, 'pack' | 'punish', object?]> = [
    [C_CARD(), 'pack'], [E_CARD(), 'pack'], [D_PRE_CARD(), 'pack'],
    // C as a punish card: his game move Nd7-b6 led to this position.
    [C_CARD(), 'punish', { uci: 'd7b6', san: 'Nb6', byLearner: true, fenBefore: '5rk1/3n1ppp/8/8/8/3B4/4QPPP/6K1 b - - 0 1' }],
  ];
  for (const [c, kind, justPlayed] of real) {
    const v7 = buildHints({ fen: c.fen, line: [...c.moves], themes: ['quiet'], kind, ply: 0, ...(justPlayed ? { justPlayed: justPlayed as never } : {}) });
    assert.ok(v7[0].text.endsWith(QUIET_BARE), v7[0].text);
    const f = threatFacts(c)!;
    const out = applyThreatHints(v7, f, kind === 'punish');
    assert.equal(out.length, 4);
    assert.deepEqual(out.slice(2), v7.slice(2));
    assert.ok(!out[0].text.includes(QUIET_BARE));
    assert.equal(out[0].text.slice(0, v7[0].text.length - QUIET_BARE.length), v7[0].text.slice(0, -QUIET_BARE.length), 'the head stays');
    if (kind === 'punish') assert.ok(out[0].text.startsWith('The move just played, Nb6, was yours in the game. '));
    // H1 and H2 (the rungs 7.1 wrote): no answer SAN, no SAN of t[0], no square of the answer, no from-square of
    // t[0]. A rung 2 that stays version 7's (no target) says what it said before, no more.
    const answer = c.moves[0];
    const banned = [f.answerSan, f.firstSan, answer.slice(0, 2), answer.slice(2, 4), f.line[0].slice(0, 2)];
    assert.notDeepEqual(out[0], v7[0]);
    for (const [i, h] of out.slice(0, 2).entries()) {
      if (JSON.stringify(h) === JSON.stringify(v7[i])) { assert.equal(f.target, undefined, 'only a card without a target keeps rung 2'); continue; }
      for (const b of banned) assert.ok(!h.text.includes(b), `${h.text} names ${b}`);
      assert.ok(!banned.includes(h.square ?? ''), `mark on ${h.square}`);
      assert.equal(h.arrow, undefined);
    }
  }
  // On E version 7's rung 2 was "pushes a pawn"; with the target it names the pinned knight instead.
  const e = E_CARD();
  const out = applyThreatHints(buildHints({ fen: e.fen, line: [...e.moves], themes: ['quiet'], kind: 'pack', ply: 0 }), threatFacts(e), false);
  assert.equal(out[1].square, 'e5');
  // On C version 7's rung 2 gave the destination square away ("goes to e4"); the target rung does not.
  const cOut = applyThreatHints(buildHints({ fen: C_FEN, line: ['e2e4'], themes: ['quiet'], kind: 'pack', ply: 0 }), threatFacts(C_CARD()), false);
  assert.deepEqual(cOut[1], { level: 2, text: 'Target: the black king on g8. The right move threatens checkmate.', square: 'g8' });
});

test('threatSay: the paragraph, the three lesson clauses and the viewer, for every kind', () => {
  const frame = 'If Black made no move in reply:';
  assert.deepEqual(threatSay(C_CARD()), {
    paragraph: `Qe4 threatens checkmate. ${frame} Qxh7#.`,
    clause: { full: `It threatens checkmate. ${frame} Qxh7#.`, fullNoClosing: `It threatens checkmate. ${frame} Qxh7#.`, short: 'It threatens checkmate.' },
    viewer: { fen: passFen(C_FEN, 'e2e4'), line: ['e4h7'], title: 'What Qe4 threatens', toggle: 'Show what it threatens', intro: 'Qe4 has been played. If Black made no move in reply, this would follow.' },
  });
  assert.deepEqual(threatSay(A_CARD()), {
    paragraph: `Rd5 threatens Rxa5. The knight on a5 is undefended. ${frame} Rxa5. White wins a knight.`,
    clause: {
      full: `It threatens Rxa5. The knight on a5 is undefended. ${frame} Rxa5. White wins a knight.`,
      fullNoClosing: `It threatens Rxa5. The knight on a5 is undefended. ${frame} Rxa5.`,
      short: 'It threatens Rxa5.',
    },
    viewer: { fen: passFen(A_FEN, 'd1d5'), line: ['d5a5'], title: 'What Rd5 threatens', toggle: 'Show what it threatens', intro: 'Rd5 has been played. If Black made no move in reply, this would follow.' },
  });
  assert.equal(threatSay(B_CARD())!.paragraph, `Nd5 threatens Ne7+. The queen on c8 is undefended. ${frame} Ne7+ Kh7 Nxc8. White wins the queen.`);
  const e = threatSay(E_CARD())!;
  assert.equal(e.paragraph, `h3 prepares fxe5. The knight on e5 is pinned to the king on e8. ${frame} fxe5 dxe5 Rxe5+. White wins a knight.`);
  assert.deepEqual(e.clause, {
    full: `It prepares fxe5. The knight on e5 is pinned to the king on e8. ${frame} fxe5 dxe5 Rxe5+. White wins a knight.`,
    fullNoClosing: `It prepares fxe5. The knight on e5 is pinned to the king on e8. ${frame} fxe5 dxe5 Rxe5+.`,
    short: 'It prepares fxe5.',
  });
  assert.deepEqual([e.viewer.title, e.viewer.toggle], ['What h3 prepares', 'Show what it prepares']);
  // No target, or a target without a reason: no reason sentence.
  assert.equal(threatSay(D_CARD())!.paragraph, `b7 threatens b8=Q. ${frame} b8=Q. White promotes a pawn to a queen.`);
  assert.equal(threatSay(D_PRE_CARD())!.paragraph, `Kf3 prepares b8=Q. ${frame} b8=Q. White promotes a pawn to a queen.`);
  assert.equal(threatSay(DR_CARD())!.paragraph, `b7 threatens b8=Q. The rook on a8 is undefended. ${frame} b8=Q Rxb8 Rxb8. ${narrateAsViewer(passFen(DR_FEN, 'b6b7')!, ['b7b8q', 'a8b8', 'b1b8']).summary}`);
  const noReason = card(F_FEN, 'd1e1', entry('d1e1', ['f4e5', 'd6e5', 'e1e5'], 'capture', true, { sq: 'e5' }));
  assert.equal(threatSay(noReason)!.paragraph, `Re1 prepares fxe5. ${frame} fxe5 dxe5 Rxe5+. White wins a knight.`);
  // Black solves: the colours swap; the lesson sentences name pieces without a colour, as the narrator does.
  const g = threatSay(G_CARD())!;
  assert.equal(g.paragraph, 'Rd4 threatens Rxa4. The knight on a4 is undefended. If White made no move in reply: Rxa4. Black wins a knight.');
  assert.equal(g.viewer.intro, 'Rd4 has been played. If White made no move in reply, this would follow.');
  // A mate with a longer line keeps the frame and has no closing sentence in any form.
  const m = threatSay(card('7k/p5pp/8/8/8/1n6/5PPP/4R1K1 w - - 0 1', 'g2g3', entry('g2g3', ['h2h4', 'a7a6', 'e1e8'], 'mate', true)))!;
  assert.equal(m.paragraph, 'g3 threatens checkmate. If Black made no move in reply: h4 a6 Re8#.');
  assert.equal(m.clause.full, m.clause.fullNoClosing);
  assert.equal(m.viewer.title, 'What g3 threatens');
  assert.equal(threatSay(card(A_FEN, 'd1d5')), null);
});

test('threatSay: the viewer replays its line from its start, and the closing is the one a line viewer prints', () => {
  for (const c of [A_CARD(), B_CARD(), B_PRE_CARD(), C_CARD(), D_CARD(), D_PRE_CARD(), DR_CARD(), E_CARD(), G_CARD()]) {
    const say = threatSay(c)!;
    const board = new Chess(say.viewer.fen);
    for (const u of say.viewer.line) board.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    assert.ok(say.viewer.line.length >= 1 && say.viewer.line.length <= 8);
    // The viewer narrates with its own options; the paragraph's closing is that same sentence.
    const shown = lineNarration(say.viewer.fen, say.viewer.line, undefined, { noChangeSentence: false });
    assert.deepEqual(shown, narrateAsViewer(say.viewer.fen, say.viewer.line));
    const mate = threatFacts(c)!.k === 'mate';
    if (mate) assert.equal(shown.summary, 'The line ends in checkmate by White.');
    else assert.ok(say.paragraph.endsWith(` ${shown.summary}`), say.paragraph);
    assert.ok(mate || say.clause.full.endsWith(` ${shown.summary}`));
    assert.ok(mate || !say.clause.fullNoClosing.includes(shown.summary));
    assert.ok(say.clause.full.startsWith(say.clause.short.slice(0, -1)));
    assert.ok(say.paragraph.length <= 300, 'short enough for a note under the card');
    // The "if" frame is in the paragraph, in the clause and in the viewer's first caption alike.
    for (const s of [say.paragraph, say.clause.full, say.clause.fullNoClosing]) assert.match(s, /If (White|Black) made no move in reply: /);
    assert.match(say.viewer.intro, /If (White|Black) made no move in reply, this would follow\.$/);
  }
});

test('almostAsHighly: the line for a card held as not-unique, only for this answer and a legal other move', () => {
  const held = (extra: object = {}) => ({ id: 'punish-x', a: 'd1d5', why: 'not-unique', alt: 'd1d4', ...extra });
  const c = (h: object | null) => ({ fen: A_FEN, moves: ['d1d5'], teachHeld: h as never });
  assert.equal(almostAsHighly(c(held())), 'The engine rates Rd4 almost as highly.');
  assert.equal(almostAsHighly(c(held({ alt: 'g1f1' }))), 'The engine rates Kf1 almost as highly.');
  assert.equal(almostAsHighly(c(held({ why: 'not-held' }))), null);
  assert.equal(almostAsHighly(c(held({ alt: undefined }))), null);
  assert.equal(almostAsHighly(c(held({ alt: 'd1d5' }))), null, 'the same move');
  assert.equal(almostAsHighly(c(held({ alt: 'd1h5' }))), null, 'not legal');
  assert.equal(almostAsHighly(c(held({ a: 'd1d4' }))), null, 'a row for another answer');
  assert.equal(almostAsHighly(c(null)), null);
  assert.equal(almostAsHighly({ fen: 'nope', moves: ['d1d5'], teachHeld: held() as never }), null);
  for (const odd of [undefined, null, 5, {}]) assert.equal(almostAsHighly(odd as never), null);
});
