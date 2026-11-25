import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, readState, parseState, exportState, NOT_A_BACKUP, type TrainingState } from '../lib/training-state';

test('a large profile exported as a backup can be merged back (audit A2 S-1)', () => {
  const draft: TrainingState = newState();
  for (let i = 0; i < 15_000; i++) {
    const correct = i % 3 !== 0;
    draft.progress.attempts.push({ puzzleId: `p${i % 2000}`, themes: ['fork', 'middlegame', 'short'], correct, unassisted: correct, hints: 0, revealed: false, durationMs: 12_345, at: 1_700_000_000_000 + i * 1000 });
  }
  const state = readState(draft);
  const indented = JSON.stringify(state, null, 2), compact = exportState(state);
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  assert.ok(bytes(indented) > 4_000_000, 'an indented export made before 2026-11-09 is over 4 MB as text');
  assert.equal(parseState(indented).progress.attempts.length, 15_000, 'it restores now: the 4 MB limit applies to the compact form (review R7)');
  assert.throws(() => parseState(' '.repeat(16_000_001)), /exceeds 16 MB/);
  assert.ok(bytes(compact) < 3_950_000, 'the compact export stays within the live cap');
  const restored = parseState(compact);
  assert.equal(restored.progress.attempts.length, 15_000);
  assert.deepEqual(restored.progress.cards, state.progress.cards);
});

test('a file that is not a backup gets one plain sentence, not validation output (QA P2-3)', () => {
  assert.throws(() => parseState('{"not":"a backup"}'), (e: Error) => e.message === NOT_A_BACKUP);
  assert.throws(() => parseState('not json at all'), (e: Error) => e.message === NOT_A_BACKUP);
  assert.throws(() => parseState('{"__proto__":{}}'), /Invalid backup key/);
});

test('a compact backup over 4 MB is still refused', () => {
  const big = { ...newState(), padding: 'x'.repeat(4_000_001) };
  assert.throws(() => parseState(JSON.stringify(big)), /exceeds 4 MB/);
});
