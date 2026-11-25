import test from 'node:test';
import assert from 'node:assert/strict';
import { isDarkSquare } from '../components/Chessboard';
import { sessionStartAt, sessionCount, SESSION_GAP_MS } from '../lib/session';
import { drillGoal, recentExclusion, RECENT_POSITIONS } from '../lib/practice';
import { endgameDrills } from '../lib/endgames';
import { selectPuzzle } from '../lib/scheduler.js';
import { newState } from '../lib/training-state';

test('board colours: a1 and h8 are dark, h1 and a8 light (QA P1-1)', () => {
  for (const square of ['a1', 'h8', 'c1', 'd4', 'e5', 'a3', 'd8']) assert.equal(isDarkSquare(square), true, square);
  for (const square of ['h1', 'a8', 'b1', 'e4', 'd5', 'd1']) assert.equal(isDarkSquare(square), false, square);
  // The drill texts the QA pass found contradicted: a8 light, d8 dark (listed above), e3 dark.
  assert.equal(isDarkSquare('e3'), true);
});

test('session: a new one starts after an idle gap, not while practising (review R8, code review P2-6)', () => {
  const start = 1_000_000_000, minute = 60_000;
  assert.equal(sessionStartAt(start, start + 30 * minute, start + 60 * minute), start, 'active: unchanged');
  assert.equal(sessionStartAt(start, start + 30 * minute, start + 30 * minute + SESSION_GAP_MS + 1), start + 30 * minute + SESSION_GAP_MS + 1, 'after the gap: a new session');
  assert.equal(sessionStartAt(start, undefined, start + SESSION_GAP_MS), start, 'exactly the gap: unchanged');
  assert.equal(sessionStartAt(start, start - 5 * minute, start + 10 * minute), start, 'an older attempt does not end a fresh session');
  const attempts = [{ at: start - 1 }, { at: start }, { at: start + 5 }];
  assert.equal(sessionCount(attempts, start), 2);
  assert.equal(sessionCount(attempts, start + 10), 0);
});

test('drill goal: every hold drill says hold the draw, every win drill says win', () => {
  const goals = endgameDrills.map(drillGoal);
  assert.equal(goals.filter(g => g === 'Goal: hold the draw').length, 13);
  assert.equal(goals.filter(g => g === 'Goal: win').length, 13);
});

test('"Another position" with no attempts cycles through more than two positions (QA P1-3, audit A1 F3)', () => {
  const progress = newState().progress;
  const pool = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', moves: ['e2e4'], rating: 1000, themes: ['fork'], gameUrl: '' }));
  const recent: string[] = [];
  let active: string | undefined;
  const served: string[] = [];
  for (let i = 0; i < 6; i++) {
    const picked: { id: string } = selectPuzzle(pool, progress, { excludeIds: recentExclusion(pool, 'all', recent, active) })!;
    served.push(picked.id); recent.push(picked.id); active = picked.id;
  }
  assert.equal(new Set(served).size, 6, `served ${served.join(',')}`);
  // The old rule (exclude only the current position) alternates between two.
  const old: string[] = []; active = undefined;
  for (let i = 0; i < 4; i++) { const picked: { id: string } = selectPuzzle(pool, progress, { excludeIds: active ? [active] : [] })!; old.push(picked.id); active = picked.id; }
  assert.equal(new Set(old).size, 2);
});

test('recent exclusion never empties the pool and respects the theme filter', () => {
  const pool = [{ id: 'a', themes: ['fork'] }, { id: 'b', themes: ['fork'] }, { id: 'c', themes: ['pin'] }];
  assert.deepEqual(recentExclusion(pool, 'fork', ['a', 'b'], 'b'), ['b'], 'both forks recent: keep one candidate');
  assert.deepEqual(recentExclusion(pool, 'all', ['a', 'b'], 'b'), ['a', 'b']);
  assert.deepEqual(recentExclusion([{ id: 'a', themes: [] }], 'all', ['a'], 'a'), []);
  assert.ok(RECENT_POSITIONS >= 3);
});

test('every bank puzzle has the opponent move that led to it, consistent with its position (QA P2-14)', async () => {
  const { puzzles } = await import('../lib/puzzles');
  const { setupMove } = await import('../lib/puzzle-setup');
  const { Chess } = await import('chess.js');
  for (const puzzle of puzzles) {
    const uci = setupMove(puzzle.id);
    assert.ok(uci && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci), puzzle.id);
    const board = new Chess(puzzle.fen);
    const moved = board.get(uci.slice(2, 4) as never);
    assert.ok(moved && moved.color !== board.turn(), `${puzzle.id}: the opponent's piece stands on ${uci.slice(2, 4)}`);
    assert.equal(board.get(uci.slice(0, 2) as never), undefined, `${puzzle.id}: ${uci.slice(0, 2)} is empty after the move`);
  }
  assert.equal(setupMove('tech-krk-mate-in-two-king-step'), undefined, 'drills have no previous move');
  assert.equal(setupMove('constructor'), undefined);
});
