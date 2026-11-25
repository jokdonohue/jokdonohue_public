import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { endgameDrills, isEndgameDrill } from '../lib/endgames';
import { puzzles } from '../lib/puzzles';
import { trainingThemes } from '../lib/scheduler.js';

test('the 26 technique drills are the verified deliverable, unchanged', () => {
  const provenance = JSON.parse(readFileSync(path.join(process.cwd(), 'data/technical_endgames.provenance.json'), 'utf8'));
  const bytes = readFileSync(path.join(process.cwd(), 'data/technical_endgames.json'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.source_sha256);
  assert.equal(endgameDrills.length, 26);
  assert.equal(endgameDrills.filter(d => d.themes.includes('planb')).length, 13);
  assert.ok(endgameDrills.every(d => isEndgameDrill(d) && d.themes.includes('endgame') && d.gameUrl === ''));
});

test('every drill replays legally: solver to move, odd length, nothing after the game ends, mates are mates', () => {
  const bankIds = new Set(puzzles.map(p => p.id));
  assert.equal(new Set(endgameDrills.map(d => d.id)).size, endgameDrills.length);
  for (const drill of endgameDrills) {
    assert.ok(!bankIds.has(drill.id), `${drill.id} collides with a bank id`);
    assert.equal(drill.moves.length % 2, 1, `${drill.id} has an even line`);
    assert.ok(drill.rating >= 600 && drill.rating <= 1800 && (drill.title?.length ?? 0) <= 60 && (drill.explanation?.length ?? 0) <= 300);
    const board = new Chess(drill.fen);
    for (const [ply, uci] of drill.moves.entries()) {
      assert.ok(!board.isGameOver(), `${drill.id} continues after the game ended at ply ${ply}`);
      board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    }
    if (drill.themes.some(t => t === 'mate' || t.startsWith('mateIn'))) assert.ok(board.isCheckmate(), `${drill.id} should end in mate`);
  }
});

test('technique and Plan B themes are skills of their own, never merged with Lichess equality', () => {
  assert.deepEqual(trainingThemes(['endgame-tech', 'endgame', 'rookEndgame', 'planb']), ['endgame-tech', 'endgame', 'rookEndgame', 'planb']);
  assert.ok(!endgameDrills.some(d => d.themes.includes('equality')));
});
