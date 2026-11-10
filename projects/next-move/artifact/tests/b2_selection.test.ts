import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPuzzle, recordAttempt, trainingThemes, type Progress as SchedulerProgress } from '../lib/scheduler.js';
import { withThemePriors } from '../lib/personal-pack';
import { mergeStates, newState } from '../lib/training-state';
import { pickNext, type MixKey } from '../components/daily';
import { buildPools, fallbackPool, type TrainerItem } from '../components/pools';
import { buildProgress, type Progress } from '../components/progress';
import type { PlanDoc } from '../src/contract/docs';

const FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const NOW = Date.UTC(2026, 10, 10, 12);
const p = (id: string, themes: string[], rating = 1000) => ({ id, fen: FEN, moves: ['a1a8'], rating, themes });
const plan = (over: Partial<PlanDoc> = {}): PlanDoc => ({ updatedAt: NOW, author: 'claude', expires: NOW + 86_400_000, focus: [], mix: { bank: 1, pack: 0, endgame: 0, agent: 0 }, ...over } as PlanDoc);
const settings = { rating: 1000, sessionLength: 10 };

function run(pools: Record<MixKey, TrainerItem[]>, progress: Progress, over: Partial<Parameters<typeof pickNext<TrainerItem>>[0]> = {}) {
  return pickNext<TrainerItem>({
    pools, progress, plan: null, priors: null, flagged: new Set(), caps: null, excludeIds: [], now: NOW, rand: () => 0.5,
    select: (pool, prog, o) => selectPuzzle(pool, prog as unknown as SchedulerProgress, o),
    withPriors: (prog, priors) => withThemePriors(prog, priors), fallback: (byS, prog) => fallbackPool(byS, prog.attempts.length), ...over,
  });
}

test('rebuilt progress equals the Site app mergeStates fold', () => {
  let state = newState().progress;
  const puzzle = (id: string, themes: string[]) => ({ ...p(id, themes), gameUrl: '' });
  state = recordAttempt(state, puzzle('a', ['fork', 'short']), { correct: true, now: 1000 });
  state = recordAttempt(state, puzzle('a', ['fork', 'short']), { correct: false, now: 2000 });
  state = recordAttempt(state, puzzle('b', ['pin']), { correct: true, hints: 1, now: 3000 });
  state = recordAttempt(state, puzzle('a', ['fork', 'short']), { correct: true, now: 4000 });
  const merged = mergeStates(newState(), { ...newState(), progress: { ...state, settingsUpdatedAt: 0 } });
  const ours = buildProgress(state.attempts, settings, trainingThemes);
  assert.deepEqual(ours.cards, merged.progress.cards);
  assert.deepEqual(ours.skills, merged.progress.skills);
});

test('selection honours plan.focus with the real scheduler: the focus theme is served first among new positions', () => {
  const pools = buildPools({ bank: [p('fork1', ['fork']), p('pin1', ['pin'])], endgames: [], pack: null, personal: [], drills: [] });
  const progress = buildProgress([], settings, trainingThemes);
  // Without a focus, the tie between equal unseen positions is broken by id.
  assert.equal(run(pools.bySource, progress, { plan: plan() }).item?.id, 'fork1');
  assert.equal(run(pools.bySource, progress, { plan: plan({ focus: [{ theme: 'pin', weight: 3, reason: 'most missed' }] }) }).item?.id, 'pin1');
  // An expired plan has no effect.
  assert.equal(run(pools.bySource, progress, { plan: plan({ expires: NOW - 1, focus: [{ theme: 'pin', weight: 3, reason: '' }] }) }).item?.id, 'fork1');
});

test('selection honours plan.mix with the real scheduler and skips positions flagged wrong', () => {
  const pools = buildPools({
    bank: [p('b1', ['fork'])], endgames: [p('e1', ['endgame-tech', 'endgame'])], drills: [],
    pack: { version: 'v', meta: {} as never, cards: [p('pack-0000000000000001', ['fork']) as never, p('pack-0000000000000002', ['fork']) as never], punish: [], study: [], punishStudy: [] },
    personal: [],
  });
  const progress = buildProgress([], settings, trainingThemes);
  const packOnly = plan({ mix: { bank: 0, pack: 1, endgame: 0, agent: 0 } });
  assert.equal(run(pools.bySource, progress, { plan: packOnly }).item?.id, 'pack-0000000000000001');
  assert.equal(run(pools.bySource, progress, { plan: packOnly, flagged: new Set(['pack-0000000000000001']) }).item?.id, 'pack-0000000000000002');
  assert.equal(run(pools.bySource, progress, { plan: packOnly, flagged: new Set(['pack-0000000000000001', 'pack-0000000000000002']) }).item?.id, 'b1', 'pack exhausted: the default rule serves');
  const endgameOnly = plan({ mix: { bank: 0, pack: 0, endgame: 1, agent: 0 } });
  assert.equal(run(pools.bySource, progress, { plan: endgameOnly }).item?.id, 'e1');
  // Without a plan, a new profile gets no endgame drill (app rule, QA P1-3).
  for (let i = 0; i < 3; i++) assert.notEqual(run(pools.bySource, progress, { rand: () => i / 3 }).item?.source, 'endgame');
});

test('daily set with the real scheduler: due reviews first while review places remain; done at the caps', () => {
  const pools = buildPools({ bank: [p('seen', ['fork']), p('fresh', ['fork'])], endgames: [], pack: null, personal: [], drills: [] });
  const old = { puzzleId: 'seen', themes: ['fork'], correct: false, unassisted: false, hints: 0, revealed: false, durationMs: 1, at: NOW - 3 * 86_400_000 };
  const progress = buildProgress([old], settings, trainingThemes);
  assert.equal(run(pools.bySource, progress, { caps: { reviewsLeft: 5, newLeft: 0, done: false } }).item?.id, 'seen');
  assert.equal(run(pools.bySource, progress, { caps: { reviewsLeft: 0, newLeft: 5, done: false } }).item?.id, 'fresh');
  assert.equal(run(pools.bySource, progress, { caps: { reviewsLeft: 0, newLeft: 0, done: true } }).reason, 'daily-done');
});
