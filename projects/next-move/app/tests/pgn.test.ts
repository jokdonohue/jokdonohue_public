import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { parsePgn } from '../lib/pgn';
import { puzzles } from '../lib/puzzles';

test('completed multi-game PGN preserves legal mainline, headers and result', () => {
  const games = parsePgn('[Event "Castle"]\n[Result "1-0"]\n1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.O-O {plan} (4.d3 d6) Be7 1-0\n\n[Event "Second"]\n1.d4 d5 1/2-1/2');
  assert.equal(games.length, 2);
  assert.equal(games[0].moves[6].uci, 'e1g1');
  assert.equal(games[0].moves[6].san, 'O-O');
  assert.equal(games[0].headers.Event, 'Castle');
  assert.equal(games[1].result, '1/2-1/2');
  assert.notEqual(games[0].id, games[1].id);
});
test('underpromotion from setup FEN is retained in UCI', () => {
  const [game] = parsePgn('[SetUp "1"]\n[FEN "7k/P7/8/8/8/8/8/7K w - - 0 1"]\n1.a8=N 1/2-1/2');
  assert.equal(game.moves[0].uci, 'a7a8n');
});
test('rejects incomplete, contradictory, illegal or malformed games', () => {
  for (const pgn of ['1.e4 e5 *', '1.e4 e5', '1.e4 e5 2.Ke3 1-0', '[Result "0-1"]\n1.e4 1-0', '1.e4 (e5 1-0', '1.e4 {missing 1-0', '1.e4 1-0 garbage', '[Variant "Crazyhouse"]\n1.e4 1-0', '1.e4 -- 2.e5 1-0', '1.f3 e5 2.g4 Qh4# 1-0']) {
    assert.throws(() => parsePgn(pgn), pgn);
  }
});
test('comments and variations cannot create spurious games', () => {
  const games = parsePgn('1.e4 {1-0 [Event "fake"]} e5 (1...c5 (2.Nf3) 0-1) 2.Nf3 $1 Nc6 ; 1-0\n 1/2-1/2');
  assert.equal(games.length, 1);
  assert.equal(games[0].moves.length, 4);
});
test('all 2000 normalized puzzle lines are legal and span practical difficulty', () => {
  assert.equal(puzzles.length, 2000);
  assert.equal(new Set(puzzles.map(p => p.id)).size, puzzles.length);
  for (const puzzle of puzzles) {
    assert.ok(puzzle.rating >= 600 && puzzle.rating <= 1800);
    assert.ok(puzzle.moves.length > 0);
    const chess = new Chess(puzzle.fen);
    for (const uci of puzzle.moves) assert.doesNotThrow(() => chess.move(uci), `${puzzle.id}: ${uci}`);
  }
  assert.ok(puzzles.filter(p => p.themes.includes('defensiveMove')).length >= 100);
  assert.ok(puzzles.filter(p => p.themes.includes('pawnEndgame')).length >= 80);
});
