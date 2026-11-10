import test from 'node:test';
import assert from 'node:assert/strict';
import { positionThemes } from '../lib/game-phase';

test('a king-and-pawn ending is an endgame and a pawn ending, whatever the move number (QA P1-1)', () => {
  // Kings and ten pawns: the 2026-11-08 QA repro shape, which the old rule called "middlegame".
  assert.deepEqual(positionThemes('8/5k2/1p3pp1/p1p5/P1P5/1P3PP1/5K2/8 w - - 0 40', 97), ['endgame', 'pawnEndgame']);
  assert.deepEqual(positionThemes('8/5k2/1p3pp1/p1p5/P1P5/1P3PP1/5K2/8 w - - 0 5', 9), ['endgame', 'pawnEndgame']);
});

test('single-kind endings get their Lichess ending theme; mixed endings get only endgame', () => {
  assert.deepEqual(positionThemes('8/5k2/1p3pp1/p1p5/P1P5/1P3PP1/5K2/R6r w - - 0 40', 79), ['endgame', 'rookEndgame']);
  assert.deepEqual(positionThemes('3q2k1/8/8/8/8/8/8/3Q2K1 w - - 0 50', 99), ['endgame', 'queenEndgame']);
  assert.deepEqual(positionThemes('r2q2k1/8/8/8/8/8/8/R2Q2K1 w - - 0 30', 59), ['endgame']);
  assert.deepEqual(positionThemes('4k3/8/8/8/8/8/8/4K3 w - - 0 60', 119), ['endgame']);
});

test('the divider boundary is six queens, rooks, bishops and knights; above it, ply decides opening or middlegame', () => {
  assert.deepEqual(positionThemes('r3k3/8/8/8/8/8/8/RNB1KB1R w - - 0 15', 29), ['endgame']);
  assert.deepEqual(positionThemes('rn2k3/8/8/8/8/8/8/RNB1KB1R w - - 0 15', 29), ['middlegame']);
  assert.deepEqual(positionThemes('rn2k3/8/8/8/8/8/8/RNB1KB1R w - - 0 5', 9), ['opening']);
  assert.deepEqual(positionThemes('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 2), ['opening']);
  assert.deepEqual(positionThemes('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 41), ['middlegame']);
});
