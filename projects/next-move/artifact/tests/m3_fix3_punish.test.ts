/**
 * M3 fix round 3 (brief 9.12.2), writer FX1e: the punish lesson.
 * - Item 3 (V1-6 part 2): "about level" is decided on the figure the lesson prints (rounded), at both places that say
 *   it: the small-edge outcome and the missed-win standing.
 * - Item 4 (V1-4): "That allowed {reply}" is decided from the position before his move. A reply that takes a piece of
 *   his that was already loose there (undefended, or its cheapest legal taker worth less; pawns included) reads
 *   "{Side}'s best reply is …". The piece he moved, a piece his move newly left loose, and R3-4's left-still wording keep
 *   their sentences.
 * - Item 5 (V2-3): `betterMove: false` leaves out "Better was {Y}."; the default keeps it.
 * Invented positions only, each checked with chess.js first. `winAfter` values are fixture inputs: the lesson reports
 * the number it is given and decides its wording from it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, type Square } from 'chess.js';
import { buildHintsWithRules, looseNow } from '../src/teach/hints';
import { classifyPunish, leftStillPiece, punishLesson, type PunishLike } from '../src/teach/punish';

/** A punish card as the pack stores it: the position after his game move; the solver is his opponent. */
function card(before: string, playedUci: string, pvUci: string[], winAfter: number): PunishLike & { themes: string[] } {
  const b = new Chess(before);
  const m = b.move({ from: playedUci.slice(0, 2), to: playedUci.slice(2, 4), promotion: playedUci[4] });
  return { fen: b.fen(), moves: [pvUci[0]], themes: [], pack: { playedSan: m.san, playedUci, sourceFen: before, pvUci, rowId: 'row-1', winAfter } };
}
const legal = (fen: string, line: readonly string[]) => {
  const b = new Chess(fen);
  return line.map(u => b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
};
/** The level-1 hint's rule for the card, built as the page builds it at step 0. */
const levelOne = (c: ReturnType<typeof card>) => {
  const p = c.pack as Record<string, unknown>;
  return buildHintsWithRules({ fen: c.fen, line: p.pvUci as string[], themes: [], kind: 'punish', ply: 0, justPlayed: { uci: p.playedUci as string, san: p.playedSan as string, byLearner: true, fenBefore: p.sourceFen as string } }).rules.idea;
};
const VAL: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
/** Test oracle (no punish.ts code): with `by` to move in `fen`, can `by` legally take the piece on `sq`, and is it loose? */
function looseFor(fen: string, sq: string, by: 'w' | 'b'): boolean {
  const f = fen.split(' ');
  let b: Chess;
  try { b = new Chess([f[0], by, f[2], '-', '0', f[5] ?? '1'].join(' ')); } catch { return false; }
  const t = b.get(sq as Square);
  if (!t || t.color === by) return false;
  const caps = b.moves({ verbose: true }).filter(m => m.captured && m.to === sq && !m.isEnPassant());
  if (!caps.length) return false;
  return b.attackers(sq as Square, t.color).length === 0 || Math.min(...caps.map(m => VAL[m.piece])) < VAL[t.type];
}

// ---------------------------------------------------------------- item 3

test('item 3 (V1-6 part 2): a small edge is "about level" only when the printed figure is under 55', () => {
  // Invented: a3 lets Black's bishop reach c4 and stop castling (the fixture of tests/m3_punish.test.ts).
  const quiet = '6k1/5ppp/8/3b4/8/8/PP4PP/4K2R w K - 0 1';
  const sib = { fen: quiet, moves: ['e1g1'] };
  assert.deepEqual(legal(quiet, ['a2a3', 'd5c4']), ['a3', 'Bc4']);
  const head = 'In your game you played a3. That allowed Bc4, which stops White castling kingside. After your move the engine';
  // Black's figure 54.95 prints 55: the edge reads as the 55 it prints (was "about level (Black about 55% to win)").
  for (const winAfter of [45.05, 45.5]) {
    const c = card(quiet, 'a2a3', ['d5c4'], winAfter);
    assert.equal(classifyPunish(c), 'small-edge');
    assert.equal(punishLesson(c, sib), `${head} gives Black about 55% to win, only a small edge. Better was O-O.`, String(winAfter));
  }
  assert.equal(punishLesson(card(quiet, 'a2a3', ['d5c4'], 45.51), sib), `${head} rates the game about level (Black about 54% to win). Better was O-O.`);
  assert.equal(punishLesson(card(quiet, 'a2a3', ['d5c4'], 48), sib), `${head} rates the game about level (Black about 52% to win). Better was O-O.`);
});

test('item 3: a missed win\'s standing is decided on the printed figure too', () => {
  // Invented (tests/m3_punish.test.ts): h3 lets the loose bishop escape; Rxd5 would have won it.
  const missed = '6k1/5pp1/7p/3b4/8/8/5PPP/3R2K1 w - - 0 1';
  const sib = { fen: missed, moves: ['d1d5'] };
  assert.deepEqual(legal(missed, ['h2h3', 'd5e6']), ['h3', 'Be6']);
  const head = "In your game you played h3. Black's best reply is Be6, which moves the bishop out of attack.";
  for (const winAfter of [54.6, 54.5]) {
    const c = card(missed, 'h2h3', ['d5e6'], winAfter);
    assert.equal(classifyPunish(c), 'missed-win');
    assert.equal(punishLesson(c, sib), `${head} White is still better (about 55% to win). Better was Rxd5.`, String(winAfter));
  }
  assert.equal(punishLesson(card(missed, 'h2h3', ['d5e6'], 54.4), sib), `${head} The engine rates the game about level (White about 54% to win). Better was Rxd5.`);
});

// ---------------------------------------------------------------- item 4

test('item 4 (V1-4): a reply that takes a piece already loose before his move is the "best reply", never "allowed"', () => {
  // Invented: White's rook on d1 hangs to the queen on d8 whatever he plays; a3 changes nothing and Qxd1# mates.
  const mate = '3q2k1/5ppp/8/8/8/8/P4PPP/3R2K1 w - - 0 1';
  assert.deepEqual(legal(mate, ['a2a3', 'd8d1']), ['a3', 'Qxd1#']);
  const m = card(mate, 'a2a3', ['d8d1'], 0);
  assert.ok(looseFor(mate, 'd1', 'b'), 'fixture: the rook was loose before a3');
  assert.deepEqual(looseNow(mate).map(l => l.square), ['d1']);
  assert.equal(levelOne(m), 'punish/left-mate', 'fixture: the hint gives another rule, so R3-4 does not apply');
  assert.equal(leftStillPiece(m), null);
  // Was "In your game you played a3. That allowed Qxd1#, which takes the rook on d1 with checkmate. Better was h3."
  assert.equal(punishLesson(m, { fen: mate, moves: ['h2h3'] }), "In your game you played a3. Black's best reply is Qxd1#, which takes the rook on d1 with checkmate. Better was h3.");
});

test('item 4: his move may defend the piece and the reply still take it: "best reply"', () => {
  // Invented: White's pawn on e5 hangs to the pawn on d6; Ra5 defends it, and dxe5 Rxe5 is a trade.
  const before = '6k1/5pp1/3p3p/4P3/R7/8/5PPP/6K1 w - - 0 1';
  assert.deepEqual(legal(before, ['a4a5', 'd6e5', 'a5e5']), ['Ra5', 'dxe5', 'Rxe5']);
  const c = card(before, 'a4a5', ['d6e5', 'a5e5'], 45);
  assert.ok(looseFor(before, 'e5', 'b'), 'fixture: the pawn was loose before Ra5');
  assert.ok(!looseFor(c.fen, 'e5', 'b'), 'fixture: after Ra5 the rook defends it (a pawn takes a pawn: not loose)');
  assert.equal(leftStillPiece(c), null);
  assert.equal(punishLesson(c, null), "In your game you played Ra5. Black's best reply is dxe5, which takes the pawn on e5. After your move the engine gives Black about 55% to win, only a small edge.");
});

test('item 4: a piece loose before a move made out of check counts too (hints.ts cannot read that position)', () => {
  // Invented: White is in check from the rook on h8; Kg1 is forced, and the rook on a1 hangs to the bishop all along.
  const before = '6kr/8/5b2/8/8/8/5PP1/R6K w - - 0 1';
  assert.ok(new Chess(before).inCheck(), 'fixture: White is in check before his move');
  assert.deepEqual(legal(before, ['h1g1', 'f6a1']), ['Kg1', 'Bxa1']);
  const c = card(before, 'h1g1', ['f6a1'], 10);
  assert.deepEqual(looseNow(before), [], 'fixture: hints.ts reads nothing loose in check');
  assert.ok(looseFor(before, 'a1', 'b'));
  assert.equal(punishLesson(c, null), "In your game you played Kg1. Black's best reply is Bxa1, which takes the rook on a1. Black wins a rook.");
});

test('item 4: the piece he moved, a piece newly left loose and R3-4\'s left-still wording keep their sentences', () => {
  // Invented: the knight on c3 hangs to the bishop on b4; Ne4 moves it where the d5 pawn takes it. His move put it there.
  const moved = '6k1/5ppp/8/3p4/1b6/2N5/5PPP/6K1 w - - 0 1';
  assert.deepEqual(legal(moved, ['c3e4', 'd5e4']), ['Ne4', 'dxe4']);
  assert.equal(punishLesson(card(moved, 'c3e4', ['d5e4'], 20), null), 'In your game you played Ne4. That allowed dxe4, which takes the knight on e4. Black wins a knight.');
  // Invented (tests/m3_fix2b_coach.test.ts): the d6 pawn defends the knight on e5; his d5 takes that away.
  const fresh = '6k1/5ppp/3p4/4n3/8/2B5/6PP/6K1 b - - 0 1';
  assert.ok(!looseFor(fresh, 'e5', 'w'), 'fixture: the knight was not loose before d5');
  assert.equal(punishLesson(card(fresh, 'd6d5', ['c3e5'], 10), null), 'In your game you played d5. That allowed Bxe5, which takes the knight on e5. White wins a knight.');
  // R3-4: the knight on e5 is loose before and after h6, and the hint says so: the left-still wording stays.
  const still = '6k1/5ppp/8/4n3/8/2B5/6PP/6K1 b - - 0 1';
  const s = card(still, 'h7h6', ['c3e5'], 10);
  assert.equal(levelOne(s), 'punish/left-still');
  assert.equal(punishLesson(s, null), 'In your game you played h6. Your move left the knight on e5 to be taken: Bxe5, which takes it. White wins a knight.');
});

test('item 4 invariant over seeded random games: no "That allowed" for a reply that takes a piece already loose', () => {
  let seed = 20261113;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  let cards = 0, already = 0, allowed = 0;
  for (let g = 0; g < 16; g++) {
    const b = new Chess();
    for (let i = 0; i < 60 && !b.isGameOver(); i++) {
      const moves = b.moves({ verbose: true });
      const caps = moves.filter(m => m.captured);
      b.move(caps.length && rand() < 0.35 ? caps[Math.floor(rand() * caps.length)] : moves[Math.floor(rand() * moves.length)]);
    }
    const hist = b.history({ verbose: true });
    for (let k = 4; k + 3 < hist.length; k += 3) {
      const his = hist[k], reply = hist[k + 1];
      const c = card(his.before, `${his.from}${his.to}${his.promotion ?? ''}`, hist.slice(k + 1, k + 6).map(m => `${m.from}${m.to}${m.promotion ?? ''}`), Math.round(rand() * 1000) / 10);
      const lesson = punishLesson(c, null)!;
      const where = `game ${g} ply ${k}: ${lesson}`;
      assert.ok(lesson && lesson.length <= 300, where);
      cards++;
      if (/That allowed /.test(lesson)) allowed++;
      // The reply takes a piece that stood there before his move and was loose then (not the piece he moved).
      const movedTo = [his.to, ...(his.isKingsideCastle() ? [`f${his.to[1]}`] : his.isQueensideCastle() ? [`d${his.to[1]}`] : [])];
      const sq = reply.isEnPassant() ? `${reply.to[0]}${reply.from[1]}` : reply.to;
      if (!reply.captured || movedTo.includes(sq) || !looseFor(his.before, sq, reply.color)) continue;
      already++;
      assert.doesNotMatch(lesson, /That allowed /, where);
      if (/Your move left the /.test(lesson)) assert.equal(levelOne(c), 'punish/left-still', `${where}: "Your move left" only with the hint's left-still rule`);
    }
  }
  assert.ok(cards >= 150 && already >= 5 && allowed >= 20, `cards ${cards}, already loose ${already}, "That allowed" ${allowed}`);
});

// ---------------------------------------------------------------- item 5

test('item 5 (V2-3): betterMove false leaves out "Better was"; the default and true keep it', () => {
  const quiet = '6k1/5ppp/8/3b4/8/8/PP4PP/4K2R w K - 0 1';
  const sib = { fen: quiet, moves: ['e1g1'] };
  const c = card(quiet, 'a2a3', ['d5c4'], 42);
  const full = 'In your game you played a3. That allowed Bc4, which stops White castling kingside. After your move the engine gives Black about 58% to win, only a small edge.';
  assert.equal(punishLesson(c, sib), `${full} Better was O-O.`);
  assert.equal(punishLesson(c, sib, { betterMove: true }), `${full} Better was O-O.`);
  assert.equal(punishLesson(c, sib, { betterMove: false }), full);
  assert.equal(punishLesson(c, sib, { betterMove: false, engineFigure: false }), 'In your game you played a3. That allowed Bc4, which stops White castling kingside.');
  // A missed win and a mate in the reply leave it out as well.
  const missed = '6k1/5pp1/7p/3b4/8/8/5PPP/3R2K1 w - - 0 1';
  assert.doesNotMatch(punishLesson(card(missed, 'h2h3', ['d5e6'], 75), { fen: missed, moves: ['d1d5'] }, { betterMove: false })!, /Better was|Rxd5/);
  const mate = '3q2k1/5ppp/8/8/8/8/P4PPP/3R2K1 w - - 0 1';
  assert.equal(punishLesson(card(mate, 'a2a3', ['d8d1'], 0), { fen: mate, moves: ['h2h3'] }, { betterMove: false }), "In your game you played a3. Black's best reply is Qxd1#, which takes the rook on d1 with checkmate.");
});
