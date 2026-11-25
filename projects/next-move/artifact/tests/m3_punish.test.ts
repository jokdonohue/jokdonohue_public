/**
 * M3 B1: punish curation (classifyPunish) and the punish lesson text. Invented positions only (no owner game data);
 * each is checked with chess.js first. `winAfter` values are fixture inputs: the lesson reports the number it is
 * given and decides its wording from it; it computes no evaluation itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import type { TrainerItem } from '../components/pools';
import {
  betterMoveSan, classifyPunish, LESSON_MAX_CHARS, punishAnswerLine, punishLesson, punishSiblingId, solverWinAfter,
  type PunishLike,
} from '../src/teach/punish';
import { buildHints } from '../src/teach/hints';

const play = (fen: string, uci: string) => {
  const b = new Chess(fen);
  const m = b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return { fen: b.fen(), san: m.san };
};
/** A punish card as the pack stores it: the position after his game move, solver = his opponent. */
function card(before: string, playedUci: string, pvUci: string[], winAfter: number | undefined, extra: Record<string, unknown> = {}): PunishLike {
  const g = play(before, playedUci);
  return {
    fen: g.fen, moves: [pvUci[0]],
    pack: { playedSan: g.san, playedUci, sourceFen: before, pvUci, rowId: 'row-1', ...(winAfter === undefined ? {} : { winAfter }), ...extra },
  };
}

test('classifyPunish: the solver Win% after his move (100 - winAfter) against 50 and 65', () => {
  const c = (winAfter: unknown) => classifyPunish({ pack: { winAfter } });
  assert.equal(c(51), 'missed-win');     // solver 49
  assert.equal(c(50.0001), 'missed-win');
  assert.equal(c(50), 'small-edge');     // solver 50
  assert.equal(c(35.5), 'small-edge');   // solver 64.5
  assert.equal(c(35), 'punish');         // solver 65
  assert.equal(c(0), 'punish');
  // Missing or unusable: served as before M3.
  assert.equal(c(undefined), 'punish');
  assert.equal(c(Number.NaN), 'punish');
  assert.equal(c('40'), 'punish');
  assert.equal(classifyPunish({}), 'punish');
  assert.equal(classifyPunish({ pack: null }), 'punish');
  assert.equal(solverWinAfter({ pack: { winAfter: 12.5 } }), 87.5);
  assert.equal(solverWinAfter({ pack: {} }), null);
  assert.equal(punishSiblingId({ pack: { rowId: 'abc-1' } }), 'pack-abc-1');
  assert.equal(punishSiblingId({ pack: {} }), null);
});

test('the answer line is pack.pvUci when it starts with the card move, else the card moves', () => {
  assert.deepEqual(punishAnswerLine({ fen: 'x', moves: ['e2e4'], pack: { pvUci: ['e2e4', 'e7e5'] } }), ['e2e4', 'e7e5']);
  assert.deepEqual(punishAnswerLine({ fen: 'x', moves: ['e2e4'], pack: { pvUci: ['d2d4', 'e7e5'] } }), ['e2e4']);
  assert.deepEqual(punishAnswerLine({ fen: 'x', moves: ['e2e4'], pack: {} }), ['e2e4']);
});

test('lesson, White owner: the move, what it allowed, the decisive later move, the better move', () => {
  // Invented: Re7 leaves the back rank; Rd1+ Re1 Rxe1# follows.
  const before = '3r2k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';
  const c = card(before, 'e1e7', ['d8d1', 'e7e1', 'd1e1'], 0);
  assert.equal(classifyPunish(c), 'punish');
  assert.equal(punishLesson(c, { fen: before, moves: ['h2h3'] }),
    'In your game you played Re7. That allowed Rd1+, which gives check. Then Rxe1# takes the rook on e1 with checkmate. Better was h3.');
});

test('lesson, Black owner: material won, and the small-edge and missed-win wordings', () => {
  // Invented: ...Bb4 puts the bishop where the c3 pawn takes it.
  const before = '5bk1/6pp/8/8/8/2P5/6PP/6K1 b - - 0 1';
  const c = card(before, 'f8b4', ['c3b4', 'g8f7', 'b4b5'], 8);
  assert.equal(punishLesson(c, { fen: before, moves: ['f8e7'] }),
    'In your game you played Bb4. That allowed cxb4, which takes the bishop on b4. White wins a bishop. Better was Be7.');

  // Invented: a3 lets Black's bishop reach c4 and stop castling: a positional point, so the engine's number is given.
  const quiet = '6k1/5ppp/8/3b4/8/8/PP4PP/4K2R w K - 0 1';
  const sib = { fen: quiet, moves: ['e1g1'] };
  assert.equal(punishLesson(card(quiet, 'a2a3', ['d5c4'], 15), sib),
    'In your game you played a3. That allowed Bc4, which stops White castling kingside. After your move the engine gives Black about 85% to win. Better was O-O.');
  assert.equal(punishLesson(card(quiet, 'a2a3', ['d5c4'], 42), sib),
    'In your game you played a3. That allowed Bc4, which stops White castling kingside. After your move the engine gives Black about 58% to win, only a small edge. Better was O-O.');
  assert.equal(punishLesson(card(quiet, 'a2a3', ['d5c4'], 48), sib),
    'In your game you played a3. That allowed Bc4, which stops White castling kingside. After your move the engine rates the game about level (Black about 52% to win). Better was O-O.');

  // Invented missed-win: h3 lets the loose bishop escape; Rxd5 would have won it. White stays better (rook for bishop).
  // F1: Black's pawn stands on h6, not h7. With h7 the king had no square, so the fixture's "best reply" Be6 allowed
  // Rd8#, which the narrator now reports (allowsMate, brief 9.3); the lesson wording under test is unchanged.
  const missed = '6k1/5pp1/7p/3b4/8/8/5PPP/3R2K1 w - - 0 1';
  const m = card(missed, 'h2h3', ['d5e6'], 75);
  assert.equal(classifyPunish(m), 'missed-win');
  assert.equal(punishLesson(m, { fen: missed, moves: ['d1d5'] }),
    "In your game you played h3. Black's best reply is Be6, which moves the bishop out of attack. White is still better (about 75% to win). Better was Rxd5.");
  // Wording check (the number is a fixture input): near 50% "still better" would overclaim.
  assert.equal(punishLesson(card(missed, 'h2h3', ['d5e6'], 53), { fen: missed, moves: ['d1d5'] }),
    "In your game you played h3. Black's best reply is Be6, which moves the bishop out of attack. The engine rates the game about level (White about 53% to win). Better was Rxd5.");

  // Invented small edge with material: h6 leaves the a7 pawn to the rook. A rook ending a pawn up can be close to
  // level, so a small-edge card gives the engine's number, not "White wins a pawn".
  const pawn = '6k1/p5pp/8/8/8/8/6PP/R5K1 b - - 0 1';
  const small = card(pawn, 'h7h6', ['a1a7'], 42);
  assert.equal(classifyPunish(small), 'small-edge');
  // FX4b (brief 9.11.3, R3-4): the a7 pawn was already loose before h6 (level 1: "still undefended"), so h6 did not
  // "allow" Rxa7: it left the pawn to be taken. This line read "That allowed Rxa7, which takes the pawn on a7." before.
  assert.equal(punishLesson(small, { fen: pawn, moves: ['g8f7'] }),
    'In your game you played h6. Your move left the pawn on a7 to be taken: Rxa7, which takes it. After your move the engine gives White about 58% to win, only a small edge. Better was Kf7.');
});

test('lesson: a game move with check or with a capture changes the wording', () => {
  // Invented: Qh5+ is answered by g6 (defended by the h7 pawn), which blocks and hits the queen: his check did not
  // "allow" the reply, so the lesson says "best reply".
  const chk = '4k3/6pp/8/8/8/8/5PPP/3Q2K1 w - - 0 1';
  assert.equal(play(chk, 'd1h5').san, 'Qh5+');
  assert.equal(punishLesson(card(chk, 'd1h5', ['g7g6'], 45), { fen: chk, moves: ['d1e2'] }),
    "In your game you played Qh5+. Black's best reply is g6, which blocks the check and attacks the queen on h5. After your move the engine gives Black about 55% to win, only a small edge. Better was Qe2+.");

  // Invented: Bxf6 gxf6 is an even trade. The narrator counts from the card, where gxf6 looks like a gain, so the
  // lesson gives the engine's number instead of "Black wins a bishop".
  const trade = '6k1/5ppp/5n2/6B1/8/8/5PPP/6K1 w - - 0 1';
  const lesson = punishLesson(card(trade, 'g5f6', ['g7f6'], 45), { fen: trade, moves: ['h2h4'] })!;
  assert.equal(lesson, 'In your game you played Bxf6. That allowed gxf6, which takes the bishop on f6. After your move the engine gives Black about 55% to win, only a small edge. Better was h4.');
  assert.ok(!lesson.includes('wins'));
});

test('F1: a line whose end is unsettled keeps its earlier winning capture and gives the engine\'s number, not a material result', () => {
  // Invented: ...Rh8 walks into Nf7+, and Nxh8 wins the rook. The line then ends on Ng6, where the king can take
  // the knight (Codex P2: not settled), so the lesson keeps "Then Nxh8 ..." but does not say "White wins a rook".
  const before = '3k4/8/8/6Nr/8/8/8/6K1 b - - 0 1';
  const pv = ['g5f7', 'd8e7', 'f7h8', 'e7f6', 'h8g6'];
  const c = card(before, 'h5h8', pv, 10);
  assert.equal((c.pack as { playedSan: string }).playedSan, 'Rh8');
  const sib = { fen: before, moves: ['h5g5'] };
  assert.equal(punishLesson(c, sib),
    'In your game you played Rh8. That allowed Nf7+, which forks the king and the rook on h8. Then Nxh8 takes the rook on h8. After your move the engine gives White about 90% to win. Better was Rxg5+.');
  // The same line stopped before Ng6 is settled, so the material result is given.
  assert.equal(punishLesson(card(before, 'h5h8', pv.slice(0, 4), 10), sib),
    'In your game you played Rh8. That allowed Nf7+, which forks the king and the rook on h8. Then Nxh8 takes the rook on h8. White wins a rook. Better was Rxg5+.');
});

test('the better move: guarded by position, legality and difference from his move', () => {
  const before = '5bk1/6pp/8/8/8/2P5/6PP/6K1 b - - 0 1';
  const c = card(before, 'f8b4', ['c3b4'], 8);
  assert.equal(betterMoveSan(c, { fen: before, moves: ['f8e7'] }), 'Be7');
  assert.equal(betterMoveSan(c, { moves: ['f8e7'] }), 'Be7');                                   // sibling without fen: pack.sourceFen
  assert.equal(betterMoveSan(c, { fen: '8/8/4k3/8/3K4/4P3/8/8 w - - 0 1', moves: ['d4e4'] }), null); // another position
  assert.equal(betterMoveSan(c, { fen: before, moves: ['f8a1'] }), null);                       // illegal
  assert.equal(betterMoveSan(c, { fen: before, moves: ['f8b4'] }), null);                       // his own move
  assert.equal(betterMoveSan(c, null), null);
  assert.equal(punishLesson(c), 'In your game you played Bb4. That allowed cxb4, which takes the bishop on b4. White wins a bishop.');
  assert.equal(punishLesson(c, { fen: before, moves: ['f8a1'] }), punishLesson(c));
});

test('no usable data gives null; TrainerItem-shaped cards need no cast', () => {
  const before = '5bk1/6pp/8/8/8/2P5/6PP/6K1 b - - 0 1';
  const c = card(before, 'f8b4', ['c3b4'], 8);
  assert.equal(punishLesson({ ...c, pack: undefined }), null);
  assert.equal(punishLesson({ ...c, moves: [], pack: { ...(c.pack as object), pvUci: [] } }), null);
  assert.equal(punishLesson({ ...c, moves: ['a1a2'], pack: { ...(c.pack as object), pvUci: ['a1a2'] } }), null);
  assert.equal(punishLesson({ ...c, fen: 'bad' }), null);
  // his game move's SAN is computed from the source position when the pack lacks it
  const { playedSan: _omit, ...rest } = c.pack as Record<string, unknown>;
  void _omit;
  assert.match(punishLesson({ ...c, pack: rest })!, /^In your game you played Bb4\. /);

  // The Trainer's item type (pack: Record<string, unknown> & {...}) passes as it is.
  const item: TrainerItem = {
    id: 'punish-test', fen: c.fen, moves: ['c3b4'], rating: 1200, themes: ['personal', 'punish'], gameUrl: '', kind: 'punish', source: 'pack',
    pack: { ...(c.pack as Record<string, unknown>), playedUci: 'f8b4' },
  };
  const sibling: TrainerItem = { id: 'pack-row-1', fen: before, moves: ['f8e7'], rating: 1200, themes: ['personal'], gameUrl: '', source: 'pack' };
  assert.equal(classifyPunish(item), 'punish');
  assert.equal(punishSiblingId(item), 'pack-row-1');
  assert.match(punishLesson(item, sibling)!, /Better was Be7\.$/);
});

test('seeded random games: every lesson is non-null, within 300 characters, deterministic, and well formed', () => {
  // Synthetic punish cards from seeded random legal games: his move at a random ply, the next plies as the line.
  let seed = 20261112;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const PIECE_WORD: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  let n = 0, sharedSan = 0;
  for (let g = 0; g < 40; g++) {
    const b = new Chess();
    for (let i = 0; i < 50 && !b.isGameOver(); i++) {
      const moves = b.moves({ verbose: true });
      // Prefer captures now and then so lines carry material swings.
      const caps = moves.filter(m => m.captured);
      const pick = caps.length && rand() < 0.35 ? caps[Math.floor(rand() * caps.length)] : moves[Math.floor(rand() * moves.length)];
      b.move(pick);
    }
    const hist = b.history({ verbose: true });
    if (hist.length < 12) continue;
    const k = 4 + Math.floor(rand() * (hist.length - 10));
    const before = hist[k].before;
    const playedUci = `${hist[k].from}${hist[k].to}${hist[k].promotion ?? ''}`;
    const pv = hist.slice(k + 1, k + 7).map(m => `${m.from}${m.to}${m.promotion ?? ''}`);
    const winAfter = Math.round(rand() * 1000) / 10;
    const c = card(before, playedUci, pv, winAfter);
    const alt = new Chess(before).moves({ verbose: true }).find(m => `${m.from}${m.to}${m.promotion ?? ''}` !== playedUci);
    const sib = alt ? { fen: before, moves: [`${alt.from}${alt.to}${alt.promotion ?? ''}`] } : null;
    const lesson = punishLesson(c, sib);
    const where = `game ${g} ply ${k}: ${lesson}`;
    assert.ok(lesson, where);
    assert.ok(lesson!.length <= LESSON_MAX_CHARS, where);
    assert.equal(punishLesson(c, sib), lesson, where);
    // m31 F2: when the solver could play the same SAN (check and mate marks aside), his move is named with its piece and
    // the square it came from. Computed here from the game history, not with punish.ts.
    const bare = (s: string) => s.replace(/[+#]+$/, '');
    const shared = new Chess(c.fen).moves().some(m => bare(m) === bare(hist[k].san));
    const named = shared ? `${hist[k].san} (the ${PIECE_WORD[hist[k].piece]} from ${hist[k].from})` : hist[k].san;
    if (shared) sharedSan++;
    assert.ok(lesson!.startsWith(`In your game you played ${named}. `), where);
    assert.ok(lesson!.endsWith('.') && !lesson!.includes('!') && !/undefined|NaN|null/.test(lesson!), where);
    if (sib) assert.ok(lesson!.endsWith(`Better was ${alt!.san}.`), where);
    // The hint ladder for the same card names his move, never throws, says "you" only about his game move, and
    // keeps the answer's SAN out of levels 1-3 (unless his own move has the same SAN).
    const hs = buildHints({ fen: c.fen, line: pv, themes: ['personal', 'punish'], kind: 'punish', justPlayed: { uci: playedUci, san: hist[k].san, byLearner: true, fenBefore: before } });
    assert.equal(hs.length, 4);
    assert.ok(hs[0].text.startsWith(`The move just played, ${hist[k].san}, was yours in the game. `), hs[0].text);
    const answer = new Chess(c.fen).move({ from: pv[0].slice(0, 2), to: pv[0].slice(2, 4), promotion: pv[0][4] }).san;
    const core = (s: string) => s.replace(/[+#]/g, '');
    for (const h of hs.slice(0, 3)) {
      assert.ok(!/\byou(r)?\b/i.test(h.text.replace('was yours in the game', '')), `${where} | ${h.text}`);
      const text = h.level === 1 ? h.text.replace(`The move just played, ${hist[k].san}, `, '') : h.text;
      if (core(answer) !== core(hist[k].san)) {
        const re = new RegExp(`(^|[^A-Za-z0-9])${core(answer).replace(/[.*+?^${}()|[\]\\=]/g, '\\$&')}([^A-Za-z0-9]|$)`);
        assert.ok(!re.test(text), `${where} | answer ${answer} | ${h.text}`);
      }
    }
    n++;
  }
  assert.ok(n >= 35, String(n));
  assert.ok(sharedSan >= 1, `cards where both sides have the same SAN: ${sharedSan}`);
});
