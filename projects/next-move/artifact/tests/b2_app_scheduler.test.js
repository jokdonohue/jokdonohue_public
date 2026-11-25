import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPuzzle, recordAttempt, getSkillStats, dueCount, trainingThemes } from '../lib/scheduler.js';
const createProgress = () => ({ attempts: [], cards: {}, skills: {}, settings: { rating: 1000, sessionLength: 10 } });
const puzzle = (id, themes = ['fork'], rating = 1000) => ({ id, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: ['e2e4'], themes, rating });

test('attempts are immutable; assisted success resets recall spacing', () => {
  const original = createProgress();
  const first = recordAttempt(original, puzzle('one'), { correct: true, now: 1000 });
  assert.deepEqual(original, createProgress());
  assert.equal(first.cards.one.intervalDays, 1);
  const second = recordAttempt(first, puzzle('one'), { correct: true, now: 2000 });
  assert.equal(second.cards.one.intervalDays, 3);
  const assisted = recordAttempt(second, puzzle('one'), { correct: true, hints: 1, now: 3000 });
  assert.equal(assisted.cards.one.streak, 0);
  assert.equal(assisted.cards.one.successes, 2);
  assert.equal(assisted.cards.one.due, 603000);
  assert.equal(assisted.skills.fork.attempts, 3);
  assert.equal(assisted.skills.fork.successes, 2);
  assert.equal(assisted.attempts[2].unassisted, false);
  assert.equal(assisted.cards.one.lapses, 1);
});

test('reveal and wrong answer count as unsuccessful unassisted recall', () => {
  let progress = recordAttempt(createProgress(), puzzle('one'), { correct: true, revealed: true, now: 0 });
  progress = recordAttempt(progress, puzzle('one'), { correct: false, now: 1 });
  assert.equal(progress.cards.one.successes, 0);
  assert.equal(progress.cards.one.lapses, 2);
  assert.equal(dueCount(progress, 600000), 0);
  assert.equal(dueCount(progress, 600001), 1);
  assert.throws(() => recordAttempt(progress, puzzle('one'), { correct: true, hints: -1 }), /Invalid/);
});

test('selector respects filters/exclusions, balances due review and exploration', () => {
  const bank = [puzzle('a'), puzzle('b'), puzzle('c', ['pin'])];
  let progress = recordAttempt(createProgress(), bank[0], { correct: false, now: 0 });
  progress = recordAttempt(progress, bank[1], { correct: true, now: 1 });
  progress = recordAttempt(progress, bank[1], { correct: true, now: 2 });
  assert.equal(selectPuzzle(bank, progress, { now: 700000 }).id, 'a');
  assert.equal(selectPuzzle(bank, progress, { now: 700000, excludeIds: ['a'] }).id, 'c');
  assert.equal(selectPuzzle(bank, progress, { theme: 'pin' }).id, 'c');
  assert.equal(selectPuzzle(bank, progress, { theme: 'missing' }), null);
  progress = recordAttempt(progress, bank[0], { correct: false, now: 1 });
  assert.equal(selectPuzzle(bank, progress, { now: 700000 }).id, 'c');
  assert.equal(selectPuzzle([], progress), null);
});

test('selector prioritizes weaker themes and does not repeat latest card when others available', () => {
  const bank = [puzzle('a', ['fork']), puzzle('b', ['pin'])];
  let progress = createProgress();
  for (let i = 0; i < 5; i++) progress = recordAttempt(progress, bank[0], { correct: true, now: i });
  const weak = puzzle('c', ['pin']);
  const strong = puzzle('d', ['fork']);
  assert.equal(selectPuzzle([strong, weak], progress, { now: 0 }).id, 'c');
  progress = recordAttempt(progress, bank[1], { correct: true, now: 10 });
  assert.equal(selectPuzzle(bank, progress, { now: 20 }).id, 'a');
});

test('skill feedback distinguishes no data and small samples from proficiency', () => {
  const bank = [puzzle('a')];
  assert.equal(getSkillStats(createProgress(), bank)[0].accuracy, null);
  const progress = recordAttempt(createProgress(), bank[0], { correct: true, now: 0 });
  const stat = getSkillStats(progress, bank)[0];
  assert.equal(stat.accuracy, 1);
  assert.equal(stat.confidence, 'early');
  assert.match(stat.label, /Too few/);
});

test('source metadata remains provenance without becoming skills or selection weights', () => {
  const raw = ['crushing', 'endgame', 'fork', 'short'];
  const bank = [puzzle('a', raw)];
  const progress = recordAttempt(createProgress(), bank[0], { correct: false, now: 0 });
  assert.deepEqual(progress.attempts[0].themes, raw);
  assert.deepEqual(Object.keys(progress.skills).sort(), ['endgame', 'fork']);
  // Existing metadata skill records are tolerated but hidden and ignored.
  progress.skills.crushing = { attempts: 1000, successes: 0, lastAttempt: 0 };
  progress.skills.short = { attempts: 1000, successes: 0, lastAttempt: 0 };
  assert.deepEqual(getSkillStats(progress, bank).map(s => s.theme), ['endgame', 'fork']);
  assert.deepEqual(trainingThemes(['fork', 'short', 'fork', 'personal', 'masterVsMaster']), ['fork']);
  progress.skills.fork = { attempts: 10, successes: 10, lastAttempt: 0 };
  const tagged = [puzzle('tagged', ['crushing', 'fork', 'short']), puzzle('plain', ['pin'])];
  const untagged = [puzzle('tagged', ['fork']), puzzle('plain', ['pin'])];
  assert.equal(selectPuzzle(tagged, progress).id, 'plain');
  assert.equal(selectPuzzle(tagged, progress).id, selectPuzzle(untagged, progress).id);
  const metadataOnly = recordAttempt(createProgress(), puzzle('metadata', ['short', 'personal']), { correct: true, now: 0 });
  assert.deepEqual(metadataOnly.skills, {});
  assert.deepEqual(getSkillStats(metadataOnly, [puzzle('metadata', ['short'])]), []);
  assert.equal(selectPuzzle([puzzle('neutral', ['short']), puzzle('other', [])], createProgress()).id, 'neutral');
});

