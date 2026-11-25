/**
 * M3 B1: Lichess theme ideas and the four-level hint ladder. Textbook or invented positions only (no owner game
 * data); every invented position is first checked with chess.js (SAN, check, mate) so no test rests on a recalled
 * FEN. The bank sample reads the public Lichess puzzle file (CC0) shipped with the page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { ARTIFACT_DIR } from './b3_paths';
import { ideaFromThemes, mateIdea, TACTICAL_THEMES, MATE_PATTERNS, tacticalIdea, themesFitLine, mateCountFromThemes } from '../src/teach/themes';
import { buildHints, buildHintsWithRules, looseNow, type Hint, type HintInput } from '../src/teach/hints';

/** Position after a UCI move, and the move's SAN, as chess.js plays it. */
const play = (fen: string, uci: string) => {
  const b = new Chess(fen);
  const m = b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return { fen: b.fen(), san: m.san, board: b };
};
const texts = (hs: Hint[]) => hs.map(h => h.text);
/** The ladder's shape: four entries, levels 1..4, each non-empty, sentences ending with a period, no "!". */
function assertShape(hs: Hint[], where = '') {
  assert.equal(hs.length, 4, where);
  hs.forEach((h, i) => {
    assert.equal(h.level, i + 1, where);
    assert.ok(h.text.trim().length > 0, `${where} level ${i + 1} empty`);
    assert.ok(h.text.endsWith('.'), `${where} level ${i + 1}: ${h.text}`);
    assert.ok(!h.text.includes('!'), `${where} level ${i + 1}: ${h.text}`);
  });
}
/** Does `text` contain the SAN as a whole token (check marks ignored)? */
const hasSan = (text: string, san: string) => {
  const core = san.replace(/[+#]/g, '').replace(/[.*+?^${}()|[\]\\=]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${core}([^A-Za-z0-9]|$)`).test(text);
};

// ---------------------------------------------------------------- themes

test('themes: priority (mates, then the brief order), pointers only, non-tactical tags ignored', () => {
  assert.equal(ideaFromThemes(['crushing', 'middlegame', 'short', 'master', 'advantage']), null);
  assert.equal(ideaFromThemes([]), null);
  assert.equal(ideaFromThemes(['unknownTag']), null);
  // Priority is the table's, not the tag order.
  assert.equal(ideaFromThemes(['pin', 'fork', 'short']), 'Look for a fork: one piece attacking two at once.');
  assert.match(ideaFromThemes(['discoveredAttack', 'doubleCheck'])!, /^Look for a double check/);
  assert.match(ideaFromThemes(['hangingPiece', 'skewer'])!, /^Look for a skewer/);
  assert.match(ideaFromThemes(['kingsideAttack', 'zugzwang'])!, /zugzwang/);
  // Mates come first, with the count from the tag and a pointer for the named pattern.
  assert.equal(ideaFromThemes(['fork', 'mateIn2', 'backRankMate', 'mate']), 'There is a checkmate in two moves: look for a back-rank mate, against a king shut in on its back rank by its own pieces.');
  assert.equal(ideaFromThemes(['mate', 'mateIn1', 'operaMate']), 'There is a checkmate in one move.');
  assert.match(ideaFromThemes(['mate', 'smotheredMate'])!, /^There is a checkmate: look for a smothered mate/);
  assert.equal(ideaFromThemes(['mate']), 'There is a checkmate.');
  assert.equal(mateCountFromThemes(['mateIn3', 'mateIn2']), 2);
  assert.equal(mateIdea(3, []), 'There is a checkmate in three moves.');
  assert.equal(tacticalIdea(['mateIn2', 'fork'])?.tag, 'fork');
  // Every sentence: one idea, plain, short, no SAN or square, no exclamation mark.
  for (const [tag, idea] of TACTICAL_THEMES) {
    assert.ok(idea.length <= 120 && idea.endsWith('.') && !idea.includes('!'), tag);
    assert.ok(!/\b[a-h][1-8]\b/.test(idea), `${tag} names a square`);
  }
  for (const [tag, pointer] of MATE_PATTERNS) assert.ok(pointer.startsWith('look for') && !/\b[a-h][1-8]\b/.test(pointer), tag);
  // The brief's tactical tags are all present, in its order.
  const order = TACTICAL_THEMES.map(([t]) => t);
  const brief = ['doubleCheck', 'discoveredAttack', 'fork', 'pin', 'skewer', 'xRayAttack', 'deflection', 'attraction', 'clearance', 'interference',
    'intermezzo', 'capturingDefender', 'trappedPiece', 'hangingPiece', 'sacrifice', 'quietMove', 'zugzwang', 'promotion', 'advancedPawn',
    'defensiveMove', 'exposedKing', 'kingsideAttack', 'queensideAttack'];
  assert.deepEqual(order.filter(t => brief.includes(t)), brief);
});

test('themes: Lichess length tags tell whether the tags still describe the remaining line', () => {
  assert.equal(themesFitLine(['short', 'fork'], 3), true);
  assert.equal(themesFitLine(['short', 'fork'], 1), false);
  assert.equal(themesFitLine(['oneMove'], 1), true);
  assert.equal(themesFitLine(['long'], 3), false);
  assert.equal(themesFitLine(['veryLong'], 7), true);
  assert.equal(themesFitLine(['veryLong'], 5), false);
  assert.equal(themesFitLine(['mateIn2', 'short'], 3), true);
  assert.equal(themesFitLine(['mateIn2', 'short'], 1), false);
  assert.equal(themesFitLine(['fork'], 9), true);
});

// ---------------------------------------------------------------- ladders on invented positions

test('discovered attack with check winning the queen: idea, target that the line wins, piece, move', () => {
  // Invented (the narrator's own test position): the bishop on d3 hides the d-file from the queen on d1.
  const fen = '5rk1/5ppp/8/3q4/8/3B4/5PPP/3Q2K1 w - - 0 1';
  assert.equal(play(fen, 'd3h7').san, 'Bxh7+');
  const hs = buildHints({ fen, line: ['d3h7', 'g8h7', 'd1d5'], themes: [], kind: 'pack' });
  assertShape(hs);
  assert.deepEqual(hs, [
    { level: 1, text: 'Look for a discovered attack: move one piece out of the way so that a piece behind it attacks.' },
    { level: 2, text: 'Target: the queen on d5. The right line wins it.', square: 'd5' },
    { level: 3, text: 'Use your bishop on d3.', square: 'd3' },
    { level: 4, text: 'Play Bxh7+.', arrow: 'd3h7' },
  ]);
});

test('knight fork of king and rook: the fork targets, and which one the line wins', () => {
  const fen = '3k3r/8/8/6N1/8/8/8/6K1 w - - 0 1';
  assert.equal(play(fen, 'g5f7').san, 'Nf7+');
  const line = ['g5f7', 'd8e7', 'f7h8'];
  const own = buildHints({ fen, line, themes: [], kind: 'agent' });
  assert.equal(own[0].text, 'Look for a fork: a check that also attacks another piece.');
  assert.deepEqual(own[1], { level: 2, text: 'Targets: the king on d8 and the rook on h8. The right line wins the rook.', square: 'h8' });
  // The same line as a Lichess puzzle: the tag gives level 1 at the start ...
  const bank = buildHints({ fen, line, themes: ['fork', 'short', 'endgame'], kind: 'bank', ply: 0 });
  assert.equal(bank[0].text, 'Look for a fork: one piece attacking two at once.');
  // ... but not two plies later, where the fork has already happened (with or without `ply`).
  const later = play(play(fen, 'g5f7').fen, 'd8e7').fen;
  for (const input of [{ ply: 2 }, {}]) {
    const hs = buildHints({ fen: later, line: ['f7h8'], themes: ['fork', 'short', 'endgame'], kind: 'bank', ...input });
    assert.equal(hs[0].text, 'Look for an undefended enemy piece that you can take.');
    assert.deepEqual(hs[1], { level: 2, text: 'Target: the rook on h8. The right line wins it.', square: 'h8' });
    assert.deepEqual(hs[3], { level: 4, text: 'Play Nxh8.', arrow: 'f7h8' });
  }
});

test('mates: a count only when certain, the enemy king as target with its free squares', () => {
  // Back-rank mate in two (invented): Qe8+ Rxe8 Rxe8#.
  const fen = '3r2k1/5ppp/8/8/8/8/4QPPP/4R1K1 w - - 0 1';
  const line = ['e2e8', 'd8e8', 'e1e8'];
  const end = new Chess(fen);
  for (const u of line) end.move({ from: u.slice(0, 2), to: u.slice(2, 4) });
  assert.ok(end.isCheckmate());
  const themes = ['backRankMate', 'mate', 'mateIn2', 'short', 'middlegame'];
  const bank = buildHints({ fen, line, themes, kind: 'bank', ply: 0 });
  assert.equal(bank[0].text, 'There is a checkmate in two moves: look for a back-rank mate, against a king shut in on its back rank by its own pieces.');
  assert.deepEqual(bank[1], { level: 2, text: 'Target: the king on g8. Right now it can only go to f8 or h8.', square: 'g8' });
  assert.deepEqual(bank[2], { level: 3, text: 'Use your queen on e2.', square: 'e2' });
  // Two plies later the Lichess count is recomputed for the remaining line.
  const step2 = play(play(fen, 'e2e8').fen, 'd8e8').fen;
  const bank2 = buildHints({ fen: step2, line: ['e1e8'], themes, kind: 'bank', ply: 2 });
  assert.match(bank2[0].text, /^There is a checkmate in one move: look for a back-rank mate/);
  assert.equal(bank2[3].text, 'Play Rxe8#.');
  // An engine line or a Claude line states no count beyond one move.
  assert.equal(buildHints({ fen, line, themes: [], kind: 'pack' })[0].text, "Look for checkmate: the engine's line ends in mate.");
  assert.equal(buildHints({ fen, line, themes: [], kind: 'agent' })[0].text, 'Look for checkmate: the line ends in mate.');
  const m1 = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
  assert.equal(play(m1, 'd1d8').san, 'Rd8#');
  assert.equal(buildHints({ fen: m1, line: ['d1d8'], themes: [], kind: 'pack' })[0].text, 'There is a checkmate in one move.');
  // A mate-in-3 tag fits a two-move remainder (one forced pair already played), so the count holds ...
  assert.equal(buildHints({ fen, line, themes: ['mate', 'mateIn3'], kind: 'bank' })[0].text, 'There is a checkmate in two moves.');
  // ... unless `ply` says the puzzle has just started, or the tag cannot fit (mate in one on a two-move mate).
  assert.equal(buildHints({ fen, line, themes: ['mate', 'mateIn3'], kind: 'bank', ply: 0 })[0].text, 'Look for checkmate: the puzzle line ends in mate.');
  assert.equal(buildHints({ fen, line, themes: ['mate', 'mateIn1'], kind: 'bank' })[0].text, 'Look for checkmate: the puzzle line ends in mate.');
});

test('pin, castling taken away, a defended piece, and a quiet move followed by a fork', () => {
  // Nimzo-Indian after 1.d4 Nf6 2.c4 e6 3.Nc3: 3...Bb4 pins the knight to the king.
  const nimzo = new Chess();
  for (const s of ['d4', 'Nf6', 'c4', 'e6', 'Nc3']) nimzo.move(s);
  const pin = buildHints({ fen: nimzo.fen(), line: ['f8b4'], themes: [], kind: 'pack' });
  assert.equal(pin[0].text, 'Look for a pin: a piece that cannot move away because its king stands behind it.');
  assert.deepEqual(pin[1], { level: 2, text: 'Target: the knight on c3, in front of the king on e1.', square: 'c3' });

  // Invented: the bishop goes to c4 and covers f1, so White can no longer castle kingside.
  const castle = '6k1/5ppp/8/3b4/8/8/PP4PP/4K2R b K - 0 1';
  assert.equal(play(castle, 'd5c4').san, 'Bc4');
  assert.ok(!play(castle, 'd5c4').board.moves().includes('O-O'));
  const c = buildHints({ fen: castle, line: ['d5c4'], themes: [], kind: 'agent' });
  assert.equal(c[0].text, 'The enemy king has not castled yet: look for a move that stops it castling.');
  assert.deepEqual(c[1], { level: 2, text: 'Target: the king on e1. The right move stops it castling kingside.', square: 'e1' });

  // Invented: the pawn on b4 attacks the knight on c3; the answer moves it to safety.
  const def = '6k1/5ppp/8/8/1p6/2N5/5PPP/6K1 w - - 0 1';
  assert.deepEqual(looseNow(def).map(l => l.square), ['c3']);
  const d = buildHints({ fen: def, line: ['c3e4'], themes: [], kind: 'pack' });
  assert.equal(d[0].text, 'One of your pieces is under attack. The right move keeps it safe.');
  assert.deepEqual(d[1], { level: 2, text: 'Your knight on c3 is under attack from the pawn on b4.', square: 'c3' });

  // Invented: h3 first (quiet), then Nc7+ forks the king (now on e8) and the rook on a8.
  const quiet = 'r2k4/8/8/1N6/8/8/7P/7K w - - 0 1';
  const q = buildHintsWithRules({ fen: quiet, line: ['h2h3', 'd8e8', 'b5c7'], themes: [], kind: 'pack' });
  assert.equal(q.rules.idea, 'later-fork');
  assert.equal(q.hints[0].text, 'Start with a quiet move (no capture, no check). A fork follows on your second move.');
  // Targets are named where they stand now: the king is on d8 before the line starts.
  assert.deepEqual(q.hints[1], { level: 2, text: 'Targets: the king on d8 and the rook on a8. Your second move forks them.', square: 'a8' });
});

test('in check at the start, castling given as king-takes-rook, and endgame drills', () => {
  // Invented: the rook on e2 checks the king on e1 and is undefended; the king takes it.
  const chk = '6k1/8/8/8/8/8/4r3/4K2R w - - 0 1';
  assert.ok(new Chess(chk).inCheck());
  const c = buildHints({ fen: chk, line: ['e1e2'], themes: [], kind: 'pack' });
  assert.equal(c[0].text, 'You are in check. Look for an undefended enemy piece that you can take.');
  assert.deepEqual(c[3], { level: 4, text: 'Play Kxe2.', arrow: 'e1e2' });

  // Invented knight check (no block possible): a quiet king move; level 1 lists only the ways out that exist.
  const knight = '6k1/8/8/8/8/5n2/6PP/6K1 w - - 0 1';
  assert.ok(new Chess(knight).inCheck());
  assert.equal(buildHints({ fen: knight, line: ['g1f1'], themes: [], kind: 'pack' })[0].text,
    'You are in check: compare every way out (moving the king or taking the checking piece).');

  // Castling written as the king taking its own rook: the arrow and the piece come from the narrated move.
  const cas = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  const k = buildHints({ fen: cas, line: ['e1h1'], themes: [], kind: 'pack' });
  assert.deepEqual(k.slice(2), [{ level: 3, text: 'Use your king on e1.', square: 'e1' }, { level: 4, text: 'Play O-O.', arrow: 'e1g1' }]);

  // KPK (public drill position): level 1 is the drill's idea; level 2 its key squares, else what the move does.
  const kpk = '8/8/4k3/8/3K4/4P3/8/8 w - - 0 1';
  const idea = 'Take the opposition: kings face to face with one square between.';
  const e = buildHints({ fen: kpk, line: ['d4e4'], themes: ['endgame-tech', 'pawnEndgame'], kind: 'endgame', idea, keySquares: ['d5', 'e5', 'f5'] });
  assert.equal(e[0].text, idea);
  // Version 7.3: a hint that names several squares carries them all (`squares`), so the board can ring each one.
  assert.deepEqual(e[1], { level: 2, text: 'Key squares: d5, e5 and f5.', square: 'd5', squares: ['d5', 'e5', 'f5'] });
  assert.deepEqual(e[3], { level: 4, text: 'Play Ke4.', arrow: 'd4e4' });
  const plain = buildHints({ fen: kpk, line: ['d4e4'], themes: [], kind: 'endgame', idea });
  assert.equal(plain[1].text, 'The right move takes the opposition.');
  // A single key square the moving piece is about to leave is left out (the last line below). Version 7.3: a list of
  // several stays whole. Until 7.3 this case gave "Key square: d5."; in the give-up-the-pawn drill that rule printed
  // "Key squares: c6 and d6." under an idea that names "b6, c6 or d6", a contradiction at the drill's first step.
  assert.deepEqual(buildHints({ fen: kpk, line: ['d4e4'], themes: [], kind: 'endgame', idea, keySquares: ['d4', 'd5'] })[1], { level: 2, text: 'Key squares: d4 and d5.', square: 'd4', squares: ['d4', 'd5'] });
  assert.equal(buildHints({ fen: kpk, line: ['d4e4'], themes: [], kind: 'endgame', idea, keySquares: ['d4'] })[1].text, plain[1].text);
  // No idea given: the computed idea is used instead.
  assert.equal(buildHints({ fen: kpk, line: ['d4e4'], themes: [], kind: 'endgame' })[0].text, 'The right move is a quiet one: no capture and no check.');
  // A quiet pawn push: its SAN is its square, so level 2 does not name the square.
  const push = buildHints({ fen: kpk, line: ['e3e4'], themes: [], kind: 'pack' });
  assert.equal(play(kpk, 'e3e4').san, 'e4');
  assert.deepEqual(push[1], { level: 2, text: 'The right move pushes a pawn.' });
  // Invented: b5 can be taken by the knight. The narrator says so naming b5, which for a pawn push is the move itself.
  const loose = buildHints({ fen: '4k3/1p6/8/8/8/2N5/8/4K3 b - - 0 1', line: ['b7b5'], themes: [], kind: 'pack' });
  assert.deepEqual(loose[1], { level: 2, text: 'The right move pushes a pawn.' });
  for (const h of loose.slice(0, 3)) assert.ok(!/\bb5\b/.test(h.text), h.text);
  for (const h of push.slice(0, 3)) assert.ok(!hasSan(h.text, 'e4'), h.text);
});

// ---------------------------------------------------------------- punish cards

test('punish card, White owner: his move and what it allows, colours instead of "you", the brief-shaped call', () => {
  // Invented: White's rook leaves the back rank (Re7), and Black mates with Rd1+ Re1 Rxe1#.
  const before = '3r2k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';
  const game = play(before, 'e1e7');
  assert.equal(game.san, 'Re7');
  const line = ['d8d1', 'e7e1', 'd1e1'];
  const input: HintInput = { fen: game.fen, line, themes: ['personal', 'punish'], kind: 'punish', justPlayed: { uci: 'e1e7', san: 'Re7', byLearner: true, fenBefore: before } };
  const hs = buildHints(input);
  assertShape(hs);
  assert.deepEqual(texts(hs), [
    "The move just played, Re7, was yours in the game. It allows a checkmate: the engine's line ends in mate.",
    'Target: the white king on g1. Right now it can only go to f1 or h1.',
    'Use the black rook on d8.',
    'Play Rd1+.',
  ]);
  // "you" appears only for his game move.
  for (const h of hs.slice(0, 3)) assert.ok(!/\byou(r)?\b/i.test(h.text.replace('was yours in the game', '')), h.text);
  // The brief's call shape (no `fenBefore`) still names the move and gives the computed idea.
  const { fenBefore: _drop, ...jp } = input.justPlayed!;
  void _drop;
  assert.equal(buildHints({ ...input, justPlayed: jp })[0].text, hs[0].text);
  // Two plies later his game move is no longer the move just played: the same `justPlayed` is not named there
  // (checked through `fenBefore`, else through `ply`), while the move that did lead to the position can be.
  const reply = play(game.fen, 'd8d1');
  const step2 = play(reply.fen, 'e7e1');
  const later = { ...input, fen: step2.fen, line: ['d1e1'], ply: 2 };
  assertShape(buildHints(later));
  assert.equal(buildHints(later)[0].text, 'There is a checkmate in one move.');
  assert.equal(buildHints({ ...later, justPlayed: jp })[0].text, 'There is a checkmate in one move.');
  assert.match(buildHints({ ...later, justPlayed: { uci: 'e7e1', san: 'Re1', byLearner: false, fenBefore: reply.fen } })[0].text, /^The move just played was Re1\. /);
});

test('punish card, Black owner: a piece put where a pawn takes it, and a game move that was itself a capture', () => {
  // Invented: Black's bishop goes to b4, where the c3 pawn takes it.
  const before = '5bk1/6pp/8/8/8/2P5/6PP/6K1 b - - 0 1';
  const game = play(before, 'f8b4');
  assert.equal(game.san, 'Bb4');
  const hs = buildHints({ fen: game.fen, line: ['c3b4'], themes: [], kind: 'punish', justPlayed: { uci: 'f8b4', san: 'Bb4', byLearner: true, fenBefore: before } });
  assert.deepEqual(hs, [
    { level: 1, text: 'The move just played, Bb4, was yours in the game. It put the black bishop where a white pawn can take it.' },
    { level: 2, text: 'Target: the black bishop on b4. The right line wins it.', square: 'b4' },
    { level: 3, text: 'Use the white pawn on c3.', square: 'c3' },
    { level: 4, text: 'Play cxb4.', arrow: 'c3b4' },
  ]);

  // Invented: White's bishop takes the knight on f6 and the pawn takes back: an even trade, not a gain for Black.
  const tBefore = '6k1/5ppp/5n2/6B1/8/8/5PPP/6K1 w - - 0 1';
  const trade = play(tBefore, 'g5f6');
  assert.equal(trade.san, 'Bxf6');
  assert.equal(play(trade.fen, 'g7f6').san, 'gxf6');
  const t = buildHints({ fen: trade.fen, line: ['g7f6'], themes: [], kind: 'punish', justPlayed: { uci: 'g5f6', san: 'Bxf6', byLearner: true, fenBefore: tBefore } });
  assert.equal(t[0].text, 'The move just played, Bxf6, was yours in the game. Look for an undefended white piece that Black can take.');
  assert.deepEqual(t[1], { level: 2, text: 'Target: the white bishop on f6.', square: 'f6' });
  // Without `fenBefore` the captured kind is unknown, so no "wins it" either.
  const u = buildHints({ fen: trade.fen, line: ['g7f6'], themes: [], kind: 'punish', justPlayed: { uci: 'g5f6', san: 'Bxf6', byLearner: true } });
  assert.equal(u[1].text, 'Target: the white bishop on f6.');
});

// ---------------------------------------------------------------- F1: the move just played, on every kind (brief 9.3)

test('F1: a recapture at a later step is not called a win when the previous ply is passed, on bank-like and pack-like inputs', () => {
  // Invented (the narrator's trade position): 1.Nxd5 (takes the bishop) Nxd5 (takes the knight) 2.Rxd5. At ply 2
  // White takes back a knight for the knight it lost: an even trade, not a win.
  const start = '6k1/8/5n2/3b4/8/2N5/8/3R2K1 w - - 0 1';
  const one = play(start, 'c3d5'), two = play(one.fen, 'f6d5');
  assert.deepEqual([one.san, two.san, play(two.fen, 'd1d5').san], ['Nxd5', 'Nxd5', 'Rxd5']);
  const justPlayed = { uci: 'f6d5', san: 'Nxd5', byLearner: false, fenBefore: one.fen };
  const inputs: HintInput[] = [
    { fen: two.fen, line: ['d1d5'], themes: ['short', 'advantage', 'middlegame'], kind: 'bank', ply: 2 },
    { fen: two.fen, line: ['d1d5'], themes: [], kind: 'pack', ply: 2 },
    { fen: two.fen, line: ['d1d5'], themes: [], kind: 'agent', ply: 2 },
  ];
  for (const input of inputs) {
    // Without the previous ply the material counts from the board shown (B1 open issue 1) ...
    assert.equal(buildHints(input)[1].text, 'Target: the knight on d5. The right line wins it.', input.kind);
    // ... with it, the knight it took is counted, so no win is claimed at either level.
    const hs = buildHints({ ...input, justPlayed });
    assertShape(hs, input.kind);
    assert.deepEqual(hs[1], { level: 2, text: 'Target: the knight on d5.', square: 'd5' }, input.kind);
    for (const h of hs.slice(0, 2)) assert.doesNotMatch(h.text, /\bwins?\b/, `${input.kind}: ${h.text}`);
    // Only punish cards name the move just played.
    assert.ok(!hs[0].text.startsWith('The move just played'), hs[0].text);
  }
  // A punish card at a later step (previous ply, byLearner false): named, and its capture counted.
  const p = buildHints({ fen: two.fen, line: ['d1d5'], themes: [], kind: 'punish', ply: 2, justPlayed });
  assert.equal(p[0].text, 'The move just played was Nxd5. Look for an undefended black piece that White can take.');
  assert.equal(p[1].text, 'Target: the black knight on d5.');
});

test('F1: a real gain after the opponent\'s capture keeps its claim; unverified, unknown and promotion cases claim nothing', () => {
  // Invented: Black's queen takes the d5 pawn, and the rook takes the undefended queen: a queen for a pawn.
  const before = '6k1/8/8/q2P4/8/8/8/3R2K1 b - - 0 1';
  const qxd5 = play(before, 'a5d5');
  assert.equal(qxd5.san, 'Qxd5');
  assert.equal(play(qxd5.fen, 'd1d5').san, 'Rxd5');
  for (const kind of ['bank', 'pack'] as const) {
    const hs = buildHints({ fen: qxd5.fen, line: ['d1d5'], themes: [], kind, ply: 2, justPlayed: { uci: 'a5d5', san: 'Qxd5', byLearner: false, fenBefore: before } });
    assert.deepEqual(hs[1], { level: 2, text: 'Target: the queen on d5. The right line wins it.', square: 'd5' }, kind);
  }
  // The trade position again: a `fenBefore` that does not lead to the position, or none, is not trusted; with a
  // capture SAN no win is claimed.
  const start = '6k1/8/5n2/3b4/8/2N5/8/3R2K1 w - - 0 1';
  const two = play(play(start, 'c3d5').fen, 'f6d5');
  const base: HintInput = { fen: two.fen, line: ['d1d5'], themes: [], kind: 'pack', ply: 2 };
  assert.equal(buildHints({ ...base, justPlayed: { uci: 'f6d5', san: 'Nxd5', byLearner: false, fenBefore: start } })[1].text, 'Target: the knight on d5.');
  assert.equal(buildHints({ ...base, kind: 'bank', justPlayed: { uci: 'f6d5', san: 'Nxd5', byLearner: false } })[1].text, 'Target: the knight on d5.');
  // A promotion just played (invented): taking the new queen wins back a pawn, not a queen, so no claim.
  const promo = '7k/8/8/8/8/7K/p7/1R6 b - - 0 1';
  const a1q = play(promo, 'a2a1q');
  assert.equal(a1q.san, 'a1=Q');
  const q: HintInput = { fen: a1q.fen, line: ['b1a1'], themes: [], kind: 'pack', ply: 2 };
  assert.equal(buildHints(q)[1].text, 'Target: the queen on a1. The right line wins it.');
  assert.equal(buildHints({ ...q, justPlayed: { uci: 'a2a1q', san: 'a1=Q', byLearner: false, fenBefore: promo } })[1].text, 'Target: the queen on a1.');
});

test('F1: pin wording follows the pinned piece; a quiet answer that allows mate gets no narrator clause at level 2', () => {
  // Invented: Rg2 pins the g7 pawn to its king, and the pawn can still push along the g-file.
  const fen = '6k1/6p1/8/8/8/8/1R6/2K5 w - - 0 1';
  const rg2 = play(fen, 'b2g2');
  assert.equal(rg2.san, 'Rg2');
  assert.deepEqual(rg2.board.moves({ square: 'g7' }), ['g6', 'g5']);
  const hs = buildHints({ fen, line: ['b2g2'], themes: [], kind: 'pack' });
  assert.equal(hs[0].text, 'Look for a pin: a piece that cannot leave the line because its king stands behind it.');
  assert.deepEqual(hs[1], { level: 2, text: 'Target: the pawn on g7, in front of the king on g8.', square: 'g7' });
  // The theme sentence (no position to check) uses the wording that is true either way.
  assert.equal(ideaFromThemes(['pin']), 'Look for a pin: a piece that cannot leave the line without exposing a more valuable piece behind it.');
  // Invented and contrived: an answer that allows a back-rank mate. Its sentence names the mate (Re1#), so level 2
  // falls back to the square.
  const backRank = '4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
  const ladder = buildHints({ fen: backRank, line: ['d1d7'], themes: [], kind: 'pack' });
  assert.deepEqual(ladder[1], { level: 2, text: 'The right move goes to d7.', square: 'd7' });
  for (const h of ladder.slice(0, 3)) assert.ok(!/mate|Re1/.test(h.text), h.text);
});

test('F1: a line that ends with the solver ahead and to move keeps its claim; a piece the solver could still take adds to it', () => {
  // Invented: Rxd5 wins the bishop, then Nf2 leaves the knight to the king. The solver (White) is to move at the end.
  const hs = buildHints({ fen: '4k3/8/8/3b4/6n1/8/8/3RK3 w - - 0 1', line: ['d1d5', 'g4f2'], themes: [], kind: 'pack' });
  assert.deepEqual(hs[1], { level: 2, text: 'Target: the bishop on d5. The right line wins it.', square: 'd5' });
  // Codex's repro: the solver's queen can be taken at the end, so no claim (the line is not settled).
  const repro = buildHints({ fen: '2r3k1/3p4/8/8/8/8/8/3Q2K1 w - - 0 1', line: ['d1d7', 'g8h8', 'd7c7'], themes: [], kind: 'pack' });
  for (const h of repro.slice(0, 2)) assert.ok(!/\bwins?\b/.test(h.text), h.text);
});

// ---------------------------------------------------------------- robustness and invariants

test('bad input never throws and still gives four entries', () => {
  const kpk = '8/8/4k3/8/3K4/4P3/8/8 w - - 0 1';
  const cases: HintInput[] = [
    { fen: 'not a fen', line: ['e2e4'], themes: [], kind: 'bank' },
    { fen: kpk, line: [], themes: [], kind: 'pack' },
    { fen: kpk, line: ['e2e4'], themes: [], kind: 'pack' },
    { fen: kpk, line: ['zz'], themes: [], kind: 'agent' },
    { fen: kpk, line: ['d4e4', 'e6e6'], themes: [], kind: 'agent' },
    { fen: kpk, line: undefined as unknown as string[], themes: undefined as unknown as string[], kind: 'bank' },
    { fen: kpk, line: ['d4e4'], themes: [], kind: 'punish', justPlayed: { uci: 'zz', san: '', byLearner: true, fenBefore: 'bad' } },
  ];
  for (const input of cases) assertShape(buildHints(input), JSON.stringify(input));
  assert.equal(buildHints({ fen: kpk, line: [], themes: [], kind: 'endgame', idea: 'Kings first.' })[0].text, 'Kings first.');
  assert.equal(buildHints(null as unknown as HintInput).length, 4);
});

test('bank sample (public Lichess file): shape, piece and arrow from the narrated move, no answer SAN in levels 1-3', () => {
  const bank = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'data/puzzles.json'), 'utf8')) as Array<{ id: string; fen: string; moves: string[]; themes: string[] }>;
  // Every tenth puzzle, plus four whose pawn push lands where the enemy king could step (the king-room clause once
  // named that square, so level 2 gave the push away).
  const regress = new Set(['00CMj', '01Xg6', '00GuD', '00Oim']);
  const sample = bank.filter((p, i) => i % 10 === 0 || regress.has(p.id));
  assert.ok(sample.length >= 150 && [...regress].every(id => sample.some(p => p.id === id)));
  let checked = 0;
  for (const p of sample) {
    for (const step of [0, 2]) {
      if (step >= p.moves.length) continue;
      const b = new Chess(p.fen);
      for (const u of p.moves.slice(0, step)) b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      const u = p.moves[step];
      const mv = new Chess(b.fen()).move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      const hs = buildHints({ fen: b.fen(), line: p.moves.slice(step), themes: p.themes, kind: 'bank', ply: step });
      const where = `${p.id}@${step}`;
      assertShape(hs, where);
      assert.equal(hs[2].square, mv.from, where);
      assert.equal(hs[3].arrow, `${mv.from}${mv.to}${mv.promotion ?? ''}`, where);
      assert.equal(hs[3].text, `Play ${mv.san}.`, where);
      if (hs[1].square) assert.match(hs[1].square, /^[a-h][1-8]$/, where);
      // No answer SAN in levels 1-3, pawn pushes included (their SAN is the bare square).
      for (const h of hs.slice(0, 3)) assert.ok(!hasSan(h.text, mv.san), `${where}: ${h.text}`);
      checked++;
    }
  }
  assert.ok(checked > 300, String(checked));
});
