/**
 * Version 7.1 (brief m31, sections 4.3 and 4.6), writer W2: the punish lesson and the hint head.
 * - F1: a reply the narrator says nothing about, or one with no tactical fact, reads "{Side}'s best reply is {reply}."
 *   and never the bare "That allowed {reply}.".
 * - F2: `playedLabel` adds the piece and the square it came from when his SAN is also a legal SAN for the solver on the
 *   card (check and mate marks aside); the lesson's first sentence uses it, and the hint head prints it through the
 *   optional `justPlayed.label`.
 * - `keyPly`: a later capture that only takes back is never the "Then …" / "Later …" sentence.
 * - `opts.threat`: the four lesson rules of 4.3 (after his capture; no "Then" or "Later" beside it; the outcome
 *   sentence; the order full, short, none).
 * Invented positions only, each checked with chess.js first. `winAfter` values are fixture inputs (the lesson reports
 * the number it is given), and so are the threat sentences: on the page `threatSay` (threat.ts) builds them from a
 * stored line; here they are written by hand for the fixture and are true of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { buildHints, hasTactic, type HintInput } from '../src/teach/hints';
import { describeMove, narrateLine } from '../src/teach/narrate';
import { LESSON_MAX_CHARS, playedLabel, punishLesson, type PunishLessonOptions, type PunishLike } from '../src/teach/punish';

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
const PIECE: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const VAL: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const ENGINE_80 = 'After your move the engine gives White about 80% to win.';

// ---------------------------------------------------------------- F1

test('F1: a reply the narrator only places is the "best reply"; the bare "That allowed {reply}." is gone', () => {
  // Invented: after ...h6 the rook goes to c1. Nothing is taken, attacked or pinned.
  const before = '6k1/5ppp/8/8/8/8/5PPP/R5K1 b - - 0 1';
  assert.deepEqual(legal(before, ['h7h6', 'a1c1']), ['h6', 'Rc1']);
  const c = card(before, 'h7h6', ['a1c1'], 20);
  const reply = describeMove(c.fen, 'a1c1')!;
  assert.equal(reply.text, 'Rc1 moves the rook to c1.');
  assert.ok(!hasTactic(reply));
  // Version 7: "In your game you played h6. That allowed Rc1. After your move the engine gives White about 80% to win."
  assert.equal(punishLesson(c, null), `In your game you played h6. White's best reply is Rc1. ${ENGINE_80}`);
});

test('F1: a reply with words but no tactical fact is the "best reply" too, and keeps its words', () => {
  // Invented (tests/m3_punish.test.ts): h3 lets the attacked bishop step away.
  const before = '6k1/5pp1/7p/3b4/8/8/5PPP/3R2K1 w - - 0 1';
  assert.deepEqual(legal(before, ['h2h3', 'd5e6']), ['h3', 'Be6']);
  const c = card(before, 'h2h3', ['d5e6'], 20);
  assert.ok(!hasTactic(describeMove(c.fen, 'd5e6')!));
  // Version 7: "… That allowed Be6, which moves the bishop out of attack. …"
  assert.equal(punishLesson(c, { fen: before, moves: ['d1d5'] }),
    "In your game you played h3. Black's best reply is Be6, which moves the bishop out of attack. After your move the engine gives Black about 80% to win. Better was Rxd5.");
});

test('F1: a reply whose only fact the narrator does not put into words is the "best reply" too', () => {
  // Invented: Bg2 pins the d5 pawn to the rook on a8. The narrator keeps that fact but does not word a pin of a pawn
  // to a rook, so its sentence only places the bishop. Version 7 wrote the bare "That allowed Bg2." here.
  const before = 'r5k1/5ppp/4p3/3p4/8/6P1/5P1P/5BK1 b - - 0 1';
  assert.deepEqual(legal(before, ['h7h6', 'f1g2']), ['h6', 'Bg2']);
  const c = card(before, 'h7h6', ['f1g2'], 20);
  const reply = describeMove(c.fen, 'f1g2')!;
  assert.equal(reply.text, 'Bg2 moves the bishop to g2.');
  assert.ok(hasTactic(reply) && reply.facts.pins.length === 1, 'fixture: a tactical fact with no words');
  assert.equal(punishLesson(c, null), `In your game you played h6. White's best reply is Bg2. ${ENGINE_80}`);
});

test('F1: a quiet reply that attacks, pins or stops castling keeps "That allowed"', () => {
  // Invented: ...Qa5 lets the b-pawn attack the queen (the a3 pawn defends b4).
  const before = '3q2k1/5pp1/7p/8/8/PP6/5PPP/4R1K1 b - - 0 1';
  assert.deepEqual(legal(before, ['d8a5', 'b3b4']), ['Qa5', 'b4']);
  const c = card(before, 'd8a5', ['b3b4'], 20);
  assert.ok(hasTactic(describeMove(c.fen, 'b3b4')!));
  assert.equal(punishLesson(c, null), `In your game you played Qa5. That allowed b4, which attacks the queen on a5. ${ENGINE_80}`);
  // Invented (tests/m3_punish.test.ts): a3 lets the bishop stop castling.
  const quiet = '6k1/5ppp/8/3b4/8/8/PP4PP/4K2R w K - 0 1';
  assert.match(punishLesson(card(quiet, 'a2a3', ['d5c4'], 15), null)!, /^In your game you played a3\. That allowed Bc4, which stops White castling kingside\. /);
});

test('F1 over seeded random games: no "That allowed" before a reply with no tactical fact', () => {
  let seed = 20261114;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  let cards = 0, plain = 0, allowed = 0;
  for (let g = 0; g < 16; g++) {
    const b = new Chess();
    for (let i = 0; i < 60 && !b.isGameOver(); i++) {
      const moves = b.moves({ verbose: true });
      const caps = moves.filter(m => m.captured);
      b.move(caps.length && rand() < 0.3 ? caps[Math.floor(rand() * caps.length)] : moves[Math.floor(rand() * moves.length)]);
    }
    const hist = b.history({ verbose: true });
    for (let k = 4; k + 3 < hist.length; k += 3) {
      const his = hist[k];
      const pv = hist.slice(k + 1, k + 6).map(m => `${m.from}${m.to}${m.promotion ?? ''}`);
      // A fixed figure keeps every card in the punish class, where "That allowed" can be written at all.
      const c = card(his.before, `${his.from}${his.to}${his.promotion ?? ''}`, pv, 20);
      const lesson = punishLesson(c, null)!;
      const where = `game ${g} ply ${k}: ${lesson}`;
      assert.ok(lesson && lesson.length <= LESSON_MAX_CHARS, where);
      cards++;
      if (/That allowed /.test(lesson)) allowed++;
      const reply = describeMove(c.fen, pv[0])!;
      if (hasTactic(reply)) continue;
      plain++;
      assert.doesNotMatch(lesson, /That allowed /, where);
      assert.ok(lesson.includes(`'s best reply is ${reply.san}`), where);
    }
  }
  assert.ok(cards >= 150 && plain >= 40 && allowed >= 20, `cards ${cards}, replies with no tactical fact ${plain}, "That allowed" ${allowed}`);
});

// ---------------------------------------------------------------- F2

test('F2 playedLabel: the piece and its from-square when the solver could play the same SAN', () => {
  // Invented: his Rxb5 takes the knight; Black's rook takes back, also "Rxb5".
  const rook = '1r4k1/5pp1/7p/1n6/8/8/5PPP/1R4K1 w - - 0 1';
  assert.deepEqual(legal(rook, ['b1b5', 'b8b5']), ['Rxb5', 'Rxb5']);
  const c = card(rook, 'b1b5', ['b8b5'], 10);
  assert.ok(new Chess(c.fen).moves().includes('Rxb5'), 'fixture: the solver can play Rxb5 too');
  assert.equal(playedLabel(c), 'Rxb5 (the rook from b1)');
  assert.equal(punishLesson(c, { fen: rook, moves: ['h2h3'] }),
    'In your game you played Rxb5 (the rook from b1). That allowed Rxb5, which takes the rook on b5. After your move the engine gives Black about 90% to win. Better was h3.');
  // A pawn: exd5 answered by exd5.
  const pawn = '6k1/5ppp/4p3/3p4/4P3/8/5PPP/6K1 w - - 0 1';
  assert.deepEqual(legal(pawn, ['e4d5', 'e6d5']), ['exd5', 'exd5']);
  assert.equal(playedLabel(card(pawn, 'e4d5', ['e6d5'], 40)), 'exd5 (the pawn from e4)');
  // Castling is one SAN for both sides as well; the king's square tells them apart.
  const castle = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
  assert.deepEqual(legal(castle, ['e1g1', 'e8g8']), ['O-O', 'O-O']);
  assert.equal(playedLabel(card(castle, 'e1g1', ['e8g8'], 40)), 'O-O (the king from e1)');
});

test('F2 playedLabel: a check or mate mark does not make two SANs different', () => {
  // Invented: his Rxe8+ gives check; the solver's Rxe8 takes back without one.
  const before = 'r3r1k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';
  assert.deepEqual(legal(before, ['e1e8', 'a8e8']), ['Rxe8+', 'Rxe8']);
  const c = card(before, 'e1e8', ['a8e8'], 10);
  const moves = new Chess(c.fen).moves();
  assert.ok(!moves.includes('Rxe8+') && moves.includes('Rxe8'), 'fixture: the two SANs differ only by the check mark');
  assert.equal(playedLabel(c), 'Rxe8+ (the rook from e1)');
  assert.equal(punishLesson(c, null), "In your game you played Rxe8+ (the rook from e1). Black's best reply is Rxe8, which takes the rook on e8. After your move the engine gives Black about 90% to win.");
});

test('F2 playedLabel: the bare SAN when no move of the solver has it, or when the square cannot be computed', () => {
  const before = '5bk1/6pp/8/8/8/2P5/6PP/6K1 b - - 0 1';
  const plain = card(before, 'f8b4', ['c3b4'], 8);
  assert.equal(playedLabel(plain), 'Bb4');
  assert.match(punishLesson(plain, null)!, /^In your game you played Bb4\. /);
  const rook = '1r4k1/5pp1/7p/1n6/8/8/5PPP/1R4K1 w - - 0 1';
  const c = card(rook, 'b1b5', ['b8b5'], 10);
  const pack = c.pack as Record<string, unknown>;
  // No source position, no game move in UCI, a move that is not legal there, or a stored SAN that is not that move's.
  const { sourceFen: _s, ...noSource } = pack;
  const { playedUci: _u, ...noUci } = pack;
  void _s; void _u;
  assert.equal(playedLabel({ ...c, pack: noSource }), 'Rxb5');
  assert.equal(playedLabel({ ...c, pack: noUci }), 'Rxb5');
  assert.equal(playedLabel({ ...c, pack: { ...pack, playedUci: 'b1b9' } }), 'Rxb5');
  assert.equal(playedLabel({ ...c, pack: { ...pack, playedUci: 'g1h1' } }), 'Rxb5');
  // A source position that does not lead to the card: the square would be another game's.
  assert.equal(playedLabel({ ...c, pack: { ...pack, sourceFen: '1r4k1/5pp1/7p/1n6/8/7P/5PP1/1R4K1 w - - 0 1' } }), 'Rxb5');
  // The SAN is computed when the pack does not store it, and the label follows.
  const { playedSan: _p, ...noSan } = pack;
  void _p;
  assert.equal(playedLabel({ ...c, pack: noSan }), 'Rxb5 (the rook from b1)');
  // Nothing to name.
  assert.equal(playedLabel({ ...c, pack: undefined }), '');
  assert.equal(playedLabel({ ...c, pack: {} }), '');
  assert.equal(playedLabel({ fen: 'bad', moves: [], pack: pack }), 'Rxb5');
  assert.equal(playedLabel(null as unknown as PunishLike), '');
});

test('F2 hint head: the label is printed in the head only, and no other rung changes', () => {
  const rook = '1r4k1/5pp1/7p/1n6/8/8/5PPP/1R4K1 w - - 0 1';
  const c = card(rook, 'b1b5', ['b8b5'], 10);
  const jp = { uci: 'b1b5', san: 'Rxb5', byLearner: true, fenBefore: rook };
  const input: HintInput = { fen: c.fen, line: ['b8b5'], themes: [], kind: 'punish', ply: 0, justPlayed: jp };
  const plain = buildHints(input);
  assert.ok(plain[0].text.startsWith('The move just played, Rxb5, was yours in the game. '), plain[0].text);
  const label = playedLabel(c);
  const labelled = buildHints({ ...input, justPlayed: { ...jp, label } });
  assert.equal(labelled[0].text, plain[0].text.replace('The move just played, Rxb5, was', 'The move just played, Rxb5 (the rook from b1), was'));
  assert.deepEqual({ ...labelled[0], text: '' }, { ...plain[0], text: '' });
  assert.deepEqual(labelled.slice(1), plain.slice(1));
  // A label equal to the SAN, one that is not that SAN plus a note, and one that is not a string change nothing.
  for (const bad of ['Rxb5', 'Qd4 (the queen from d1)', '(the rook from b1) Rxb5', '', 7 as unknown as string]) {
    assert.deepEqual(buildHints({ ...input, justPlayed: { ...jp, label: bad } }), plain, String(bad));
  }
  // A note that names a square of the answer's first move (here b8 and b5) is not printed: rung 1 gives no answer square away.
  for (const leak of ['Rxb5 (the rook from b8)', 'Rxb5 (the rook from b5)']) {
    assert.deepEqual(buildHints({ ...input, justPlayed: { ...jp, label: leak } }), plain, leak);
  }
  // At a later step the head has its other wording and takes the label the same way.
  const later = buildHints({ ...input, ply: 2, justPlayed: { ...jp, byLearner: false, label } });
  assert.ok(later[0].text.startsWith('The move just played was Rxb5 (the rook from b1). '), later[0].text);
});

// ---------------------------------------------------------------- keyPly

test('keyPly: a later capture that only takes back is not the "Then" sentence', () => {
  // Invented: Ra1, then Black's knight takes the bishop on a3 and the rook takes back. An even trade.
  const before = '6k1/5ppp/8/1n6/8/B7/1P3PPP/3R2K1 b - - 0 1';
  assert.deepEqual(legal(before, ['h7h6', 'd1a1', 'b5a3', 'a1a3']), ['h6', 'Ra1', 'Nxa3', 'Rxa3']);
  // Version 7: "In your game you played h6. That allowed Ra1. Then Rxa3 takes the knight on a3. After your move …"
  assert.equal(punishLesson(card(before, 'h7h6', ['d1a1', 'b5a3', 'a1a3'], 20), null), `In your game you played h6. White's best reply is Ra1. ${ENGINE_80}`);
  // With more of the line, the next move that does something is named instead.
  const more = '6k1/1p3ppp/8/1n6/8/B7/1P3PPP/3R2K1 b - - 0 1';
  assert.deepEqual(legal(more, ['h7h6', 'd1a1', 'b5a3', 'a1a3', 'g7g6', 'a3a7']), ['h6', 'Ra1', 'Nxa3', 'Rxa3', 'g6', 'Ra7']);
  assert.equal(punishLesson(card(more, 'h7h6', ['d1a1', 'b5a3', 'a1a3', 'g7g6', 'a3a7'], 20), null),
    `In your game you played h6. White's best reply is Ra1. Later Ra7 attacks the undefended pawn on b7. ${ENGINE_80}`);
});

test('keyPly: the take-back is skipped where the material count had picked it, and the real gain is named', () => {
  // Invented: Rb1; ...a5 leaves the bishop on b6 undefended; Rxb6 wins it; then the knight takes the bishop on h3 and
  // the g-pawn takes back. The count cancels bishop for bishop, so version 7 named the take-back as the winning capture.
  const before = '6k1/p4ppp/1b6/8/5n2/7B/6PP/R6K b - - 0 1';
  const pv = ['a1b1', 'a7a5', 'b1b6', 'f4h3', 'g2h3'];
  assert.deepEqual(legal(before, ['h7h6', ...pv]), ['h6', 'Rb1', 'a5', 'Rxb6', 'Nxh3', 'gxh3']);
  assert.equal(punishLesson(card(before, 'h7h6', pv, 20), null),
    "In your game you played h6. White's best reply is Rb1. Then Rxb6 takes the bishop on b6. White wins a knight.");
  // Invented: the reply itself wins a knight; the other knight takes on d3 and the c-pawn takes back. No later move is
  // the point, so there is no "Then" sentence (version 7 had one for the take-back).
  const trade = '6k1/5ppp/8/4n3/1n6/3N4/1BP3PP/6K1 b - - 0 1';
  assert.deepEqual(legal(trade, ['h7h6', 'b2e5', 'b4d3', 'c2d3']), ['h6', 'Bxe5', 'Nxd3', 'cxd3']);
  assert.equal(punishLesson(card(trade, 'h7h6', ['b2e5', 'b4d3', 'c2d3'], 20), null),
    "In your game you played h6. White's best reply is Bxe5, which takes the knight on e5. White wins a knight.");
});

test('keyPly: a capture on that square that wins material, or does more than take back, is still named', () => {
  // A queen taken for the pawn it took is a gain.
  const queen = '6k1/5ppp/8/2q5/8/8/2P2PPP/R5K1 b - - 0 1';
  assert.deepEqual(legal(queen, ['h7h6', 'a1c1', 'c5c2', 'c1c2']), ['h6', 'Rc1', 'Qxc2', 'Rxc2']);
  assert.equal(punishLesson(card(queen, 'h7h6', ['a1c1', 'c5c2', 'c1c2'], 20), null),
    "In your game you played h6. White's best reply is Rc1, which defends the pawn on c2. Then Rxc2 takes the queen on c2. White wins the queen for a pawn.");
  // The last capture of an exchange the solver began on that square (bishop takes bishop, knight takes back, queen
  // takes the knight) wins the piece: the solver has taken two pieces there and lost one.
  const began = 'q5k1/3b1ppp/8/8/B7/2N5/6PP/7K w - - 0 1';
  assert.deepEqual(legal(began, ['h2h3', 'd7a4', 'c3a4', 'a8a4']), ['h3', 'Bxa4', 'Nxa4', 'Qxa4']);
  assert.equal(punishLesson(card(began, 'h2h3', ['d7a4', 'c3a4', 'a8a4'], 20), null),
    'In your game you played h3. That allowed Bxa4, which takes the bishop on a4. Then Qxa4 takes the knight on a4. Black wins a knight.');
  // A take-back that also gives check does more than take back.
  const check = 'k7/5ppp/8/1n6/8/B7/1P3PPP/3R2K1 b - - 0 1';
  assert.deepEqual(legal(check, ['h7h6', 'd1a1', 'b5a3', 'a1a3']), ['h6', 'Ra1', 'Nxa3', 'Rxa3+']);
  assert.equal(punishLesson(card(check, 'h7h6', ['d1a1', 'b5a3', 'a1a3'], 20), null),
    `In your game you played h6. White's best reply is Ra1. Then Rxa3+ takes the knight on a3 with check. ${ENGINE_80}`);
});

test('keyPly over seeded random games: a take-back named by "Then" or "Later" always does something more', () => {
  let seed = 20261115;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  let cards = 0, named = 0, takeBacks = 0, skipped = 0;
  for (let g = 0; g < 24; g++) {
    const b = new Chess();
    for (let i = 0; i < 60 && !b.isGameOver(); i++) {
      const moves = b.moves({ verbose: true });
      const caps = moves.filter(m => m.captured);
      b.move(caps.length && rand() < 0.45 ? caps[Math.floor(rand() * caps.length)] : moves[Math.floor(rand() * moves.length)]);
    }
    const hist = b.history({ verbose: true });
    for (let k = 4; k + 7 < hist.length; k += 2) {
      const his = hist[k];
      const line = hist.slice(k + 1, k + 7);
      const c = card(his.before, `${his.from}${his.to}${his.promotion ?? ''}`, line.map(m => `${m.from}${m.to}${m.promotion ?? ''}`), 20);
      const lesson = punishLesson(c, null)!;
      const where = `game ${g} ply ${k}: ${lesson}`;
      cards++;
      // Test oracle (chess.js only): the solver's later moves that take back on the square where its piece was just
      // taken, having taken no more on that square in this line than it lost there.
      const n = narrateLine(c.fen, line.map(m => `${m.from}${m.to}${m.promotion ?? ''}`), { maxPlies: 32 });
      for (let i = 2; i < line.length; i += 2) {
        const mv = line[i], prev = line[i - 1];
        if (!mv.captured || !prev.captured || prev.to !== mv.to) continue;
        let taken = 0, lost = 0;
        for (let j = 0; j <= i; j++) if (line[j].captured && line[j].to === mv.to) { if (j % 2 === 0) taken += VAL[line[j].captured!]; else lost += VAL[line[j].captured!]; }
        if (taken > lost) continue;
        takeBacks++;
        const text = n.plies[i].text;
        const isNamed = lesson.includes(`Then ${text}`) || lesson.includes(`Later ${text}`);
        // Named only when the narrator says more than the capture itself.
        if (isNamed) { named++; assert.notEqual(text, `${mv.san} takes the ${PIECE[mv.captured]} on ${mv.to}.`, where); } else skipped++;
      }
    }
  }
  assert.ok(cards >= 150 && takeBacks >= 30 && skipped >= 20, `cards ${cards}, take-backs ${takeBacks}, named ${named}, not named ${skipped}`);
});

// ---------------------------------------------------------------- the threat option (brief m31 4.3, row L)

/** Invented: ...h6 lets the b-pawn attack the knight on a5, which has no square that saves it for nothing. */
const CAPTURE = '6k1/5ppp/8/n7/8/8/1P3PPP/6K1 b - - 0 1';
const CAPTURE_PV = ['b2b4', 'h6h5', 'b4a5'];
/** The same idea after a capture by him: his knight takes the pawn on a5 and the b-pawn attacks it. */
const AFTER_CAPTURE = '6k1/5ppp/2n5/P7/8/8/1P3PPP/6K1 b - - 0 1';
/** What b4 threatens, as `threatSay` words it (fixture input; true of both positions). */
const T_CAPTURE = {
  full: 'It threatens bxa5. If Black made no move in reply: bxa5. White wins a knight.',
  fullNoClosing: 'It threatens bxa5. If Black made no move in reply: bxa5.',
  short: 'It threatens bxa5.',
};
/** Invented: ...Ne8 takes the guard off h7; Qd3 lines up with the bishop on c2 and threatens Qxh7#. */
const MATE = '5rk1/p4ppp/5n2/8/8/8/2B2PPP/3Q2K1 b - - 0 1';
const T_MATE = {
  full: 'It threatens checkmate. If Black made no move in reply: Qxh7#.',
  fullNoClosing: 'It threatens checkmate. If Black made no move in reply: Qxh7#.',
  short: 'It threatens checkmate.',
};

test('threat option: the threat follows the second sentence; no "Then", and the engine figure is the outcome', () => {
  assert.deepEqual(legal(CAPTURE, ['h7h6', ...CAPTURE_PV]), ['h6', 'b4', 'h5', 'bxa5']);
  const c = card(CAPTURE, 'h7h6', CAPTURE_PV, 20);
  const sib = { fen: CAPTURE, moves: ['a5c6'] };
  const without = 'In your game you played h6. That allowed b4, which attacks the knight on a5. Then bxa5 takes the knight on a5. White wins a knight. Better was Nc6.';
  assert.equal(punishLesson(c, sib), without);
  assert.equal(punishLesson(c, sib, {}), without);
  const lesson = punishLesson(c, sib, { threat: T_CAPTURE })!;
  assert.equal(lesson, `In your game you played h6. That allowed b4, which attacks the knight on a5. ${T_CAPTURE.full} ${ENGINE_80} Better was Nc6.`);
  assert.doesNotMatch(lesson, / (Then|Later) /);
  // The stored line's own "White wins a knight." is left out: the words appear once, in the threat's closing sentence.
  assert.equal(lesson.split('White wins a knight.').length - 1, 1);
  // Without the engine's figure there is no outcome sentence at all, never the stored line's material summary.
  assert.equal(punishLesson(c, sib, { threat: T_CAPTURE, engineFigure: false }),
    `In your game you played h6. That allowed b4, which attacks the knight on a5. ${T_CAPTURE.full} Better was Nc6.`);
  assert.equal(punishLesson(c, sib, { threat: T_CAPTURE, betterMove: false }),
    `In your game you played h6. That allowed b4, which attacks the knight on a5. ${T_CAPTURE.full} ${ENGINE_80}`);
});

test('threat option: after a capture by him the threat comes without its closing sentence', () => {
  assert.deepEqual(legal(AFTER_CAPTURE, ['c6a5', 'b2b4', 'h7h6', 'b4a5']), ['Nxa5', 'b4', 'h6', 'bxa5']);
  const c = card(AFTER_CAPTURE, 'c6a5', ['b2b4', 'h7h6', 'b4a5'], 20);
  const sib = { fen: AFTER_CAPTURE, moves: ['h7h6'] };
  assert.equal(punishLesson(c, sib), `In your game you played Nxa5. That allowed b4, which attacks the knight on a5. Then bxa5 takes the knight on a5. ${ENGINE_80} Better was h6.`);
  const lesson = punishLesson(c, sib, { threat: T_CAPTURE })!;
  assert.equal(lesson, `In your game you played Nxa5. That allowed b4, which attacks the knight on a5. ${T_CAPTURE.fullNoClosing} ${ENGINE_80} Better was h6.`);
  assert.doesNotMatch(lesson, /wins/);
  // `full` is never used after his capture: with no usable `fullNoClosing` the short form is next.
  assert.equal(punishLesson(c, sib, { threat: { ...T_CAPTURE, fullNoClosing: '' } }),
    `In your game you played Nxa5. That allowed b4, which attacks the knight on a5. ${T_CAPTURE.short} ${ENGINE_80} Better was h6.`);
});

test('threat option: a quiet reply with nothing to say about it, and a mate the stored line ends in', () => {
  assert.deepEqual(legal(MATE, ['f6e8', 'd1d3', 'g7g6']), ['Ne8', 'Qd3', 'g6']);
  const sib = { fen: MATE, moves: ['h7h6'] };
  const c = card(MATE, 'f6e8', ['d1d3', 'g7g6'], 20);
  assert.equal(punishLesson(c, sib), `In your game you played Ne8. White's best reply is Qd3. ${ENGINE_80} Better was h6.`);
  assert.equal(punishLesson(c, sib, { threat: T_MATE }), `In your game you played Ne8. White's best reply is Qd3. ${T_MATE.full} ${ENGINE_80} Better was h6.`);
  // The stored line mates. Without a threat the "Then" sentence says so; with one that sentence is gone, so the
  // closing sentence must say it.
  assert.deepEqual(legal(MATE, ['f6e8', 'd1d3', 'a7a6', 'd3h7']), ['Ne8', 'Qd3', 'a6', 'Qxh7#']);
  const m = card(MATE, 'f6e8', ['d1d3', 'a7a6', 'd3h7'], 20);
  assert.equal(punishLesson(m, sib), "In your game you played Ne8. White's best reply is Qd3. Then Qxh7# takes the pawn on h7 with checkmate. Better was h6.");
  assert.equal(punishLesson(m, sib, { threat: T_MATE }),
    `In your game you played Ne8. White's best reply is Qd3. ${T_MATE.full} The line ends in checkmate by White. Better was h6.`);
  assert.equal(punishLesson(m, sib, { threat: T_MATE, engineFigure: false }),
    `In your game you played Ne8. White's best reply is Qd3. ${T_MATE.full} The line ends in checkmate by White. Better was h6.`);
});

test('threat option: over 300 characters the short form is tried, then the lesson is exactly the one without it', () => {
  const c = card(CAPTURE, 'h7h6', CAPTURE_PV, 20);
  const sib = { fen: CAPTURE, moves: ['a5c6'] };
  const without = punishLesson(c, sib)!;
  // A threat line of eight plies with a reason sentence (true of the fixture) makes the full form too long.
  const long = 'It threatens bxa5. The knight on a5 is undefended. If Black made no move in reply: bxa5 Kh7 a6 Kg8 a7 Kh7 a8=Q Kg6. White wins a knight and promotes a pawn to a queen.';
  assert.deepEqual(legal(CAPTURE, ['h7h6', 'b2b4', 'g8h8', 'b4a5', 'h8h7', 'a5a6', 'h7g8', 'a6a7', 'g8h7', 'a7a8q', 'h7g6']).slice(3), ['bxa5', 'Kh7', 'a6', 'Kg8', 'a7', 'Kh7', 'a8=Q', 'Kg6']);
  const head = 'In your game you played h6. That allowed b4, which attacks the knight on a5.';
  assert.ok(`${head} ${long} ${ENGINE_80} Better was Nc6.`.length > LESSON_MAX_CHARS, 'fixture: the full form does not fit');
  assert.equal(punishLesson(c, sib, { threat: { full: long, fullNoClosing: long, short: T_CAPTURE.short } }), `${head} ${T_CAPTURE.short} ${ENGINE_80} Better was Nc6.`);
  // Neither form fits: the lesson of version 7, "Then" sentence and material summary included.
  assert.equal(punishLesson(c, sib, { threat: { full: long, fullNoClosing: long, short: long } }), without);
  assert.ok(without.includes('Then bxa5 takes the knight on a5. White wins a knight.'));
});

test('threat option: a part that is not a non-empty string counts as absent', () => {
  const c = card(CAPTURE, 'h7h6', CAPTURE_PV, 20);
  const sib = { fen: CAPTURE, moves: ['a5c6'] };
  const without = punishLesson(c, sib)!;
  const bad: unknown[] = [null, undefined, {}, 'It threatens bxa5.', 7, [], { full: '', fullNoClosing: '', short: '' }, { full: '   ', short: ' ' }, { full: 7, fullNoClosing: null, short: {} }];
  for (const threat of bad) {
    assert.equal(punishLesson(c, sib, { threat } as unknown as PunishLessonOptions), without, JSON.stringify(threat));
  }
  // Only the short form usable: it is the one tried.
  assert.equal(punishLesson(c, sib, { threat: { full: '', fullNoClosing: '', short: T_CAPTURE.short } }),
    `In your game you played h6. That allowed b4, which attacks the knight on a5. ${T_CAPTURE.short} ${ENGINE_80} Better was Nc6.`);
  // Only the full form usable.
  assert.equal(punishLesson(c, sib, { threat: { full: T_CAPTURE.full, fullNoClosing: '', short: '' } }),
    `In your game you played h6. That allowed b4, which attacks the knight on a5. ${T_CAPTURE.full} ${ENGINE_80} Better was Nc6.`);
});

test('threat option: a small edge and a missed win keep their engine sentence after the threat', () => {
  const sib = { fen: CAPTURE, moves: ['a5c6'] };
  // Small edge (White at 58): the engine's sentence was already the outcome.
  assert.equal(punishLesson(card(CAPTURE, 'h7h6', CAPTURE_PV, 42), sib, { threat: T_CAPTURE, betterMove: false }),
    `In your game you played h6. That allowed b4, which attacks the knight on a5. ${T_CAPTURE.full} After your move the engine gives White about 58% to win, only a small edge.`);
  // Missed win (he is still better): the threat follows the "best reply" sentence in the same way.
  const missed = card(CAPTURE, 'h7h6', CAPTURE_PV, 75);
  assert.equal(punishLesson(missed, sib), "In your game you played h6. White's best reply is b4, which attacks the knight on a5. Black is still better (about 75% to win). Better was Nc6.");
  assert.equal(punishLesson(missed, sib, { threat: T_CAPTURE }),
    `In your game you played h6. White's best reply is b4, which attacks the knight on a5. ${T_CAPTURE.full} Black is still better (about 75% to win). Better was Nc6.`);
});

test('threat option over seeded random games: placed after the second sentence, never beside "Then", never over 300', () => {
  // The sentences are fixed strings here (not true of the random positions): this test is about where they go.
  const threat = { full: 'It threatens Zz9. If nobody moved: Zz9. Closing sentence.', fullNoClosing: 'It threatens Zz9. If nobody moved: Zz9.', short: 'It threatens Zz9.' };
  let seed = 20261116;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  let cards = 0, full = 0, noClosing = 0, short = 0, none = 0;
  for (let g = 0; g < 16; g++) {
    const b = new Chess();
    for (let i = 0; i < 60 && !b.isGameOver(); i++) {
      const moves = b.moves({ verbose: true });
      const caps = moves.filter(m => m.captured);
      b.move(caps.length && rand() < 0.35 ? caps[Math.floor(rand() * caps.length)] : moves[Math.floor(rand() * moves.length)]);
    }
    const hist = b.history({ verbose: true });
    for (let k = 4; k + 3 < hist.length; k += 3) {
      const his = hist[k];
      const pv = hist.slice(k + 1, k + 7).map(m => `${m.from}${m.to}${m.promotion ?? ''}`);
      const c = card(his.before, `${his.from}${his.to}${his.promotion ?? ''}`, pv, Math.round(rand() * 1000) / 10);
      const without = punishLesson(c, null)!, lesson = punishLesson(c, null, { threat })!;
      const where = `game ${g} ply ${k}: ${lesson}`;
      assert.ok(lesson.length <= LESSON_MAX_CHARS, where);
      assert.equal(punishLesson(c, null, { threat }), lesson, where);
      cards++;
      const at = lesson.indexOf(threat.short);
      if (at < 0) { none++; assert.equal(lesson, without, where); continue; }
      // Exactly two sentences come before it: his move, and the reply.
      const before = lesson.slice(0, at).trim();
      assert.ok(before.startsWith('In your game you played ') && before.endsWith('.') && before.split('. ').length === 2, where);
      assert.doesNotMatch(lesson, / (Then|Later) /, where);
      const hisCapture = his.san.includes('x');
      if (lesson.includes(threat.full)) { full++; assert.ok(!hisCapture, where); }
      else if (lesson.includes(threat.fullNoClosing)) { noClosing++; assert.ok(hisCapture, where); }
      else short++;
      // What follows the threat is the engine's sentence, the mate, or nothing: never the stored line's material summary.
      const used = lesson.includes(threat.full) ? threat.full : lesson.includes(threat.fullNoClosing) ? threat.fullNoClosing : threat.short;
      const after = lesson.slice(at + used.length).trim();
      assert.match(after, /^$|^After your move the engine |^The line ends in checkmate by (White|Black)\.$|^(White|Black) is still better |^The engine rates the game about level /, where);
    }
  }
  assert.ok(cards >= 150 && full >= 40 && noClosing >= 10, `cards ${cards}, full ${full}, without closing ${noClosing}, short ${short}, none ${none}`);
});
