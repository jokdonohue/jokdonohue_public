import test from 'node:test';
import assert from 'node:assert/strict';
import { activePlan, capState, dailyCounts, flaggedWrongIds, focusPriors, localDay, pickNext, pickSource, sourceWeights, todayPool, type MixKey, type SelectProgress, type Selector } from '../components/daily';
import type { PlanDoc } from '../src/contract/docs';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime();
const plan = (over: Partial<PlanDoc> = {}): PlanDoc => ({ updatedAt: NOW - DAY, author: 'claude', expires: NOW + DAY, focus: [{ theme: 'fork', weight: 3, reason: '' }], mix: { bank: 0, pack: 1, endgame: 0, agent: 0 }, ...over } as PlanDoc);
type P = { id: string; themes: string[] };
const p = (id: string, theme = 'fork'): P => ({ id, themes: [theme] });
const progress = (cards: SelectProgress['cards'] = {}): SelectProgress => ({ attempts: [], cards, skills: {}, settings: { rating: 1000, sessionLength: 10 } });
// Stub scheduler: first item in the pool, after exclusions. The real one is exercised in b2_selection.
const first: Selector<P> = (pool, _progress, o) => pool.find(x => !(o.excludeIds ?? []).includes(x.id)) ?? null;
const noPriors = <T,>(x: T) => x;
const fallbackBank = (pools: Record<MixKey, P[]>) => pools.bank;
const pools = (over: Partial<Record<MixKey, P[]>> = {}): Record<MixKey, P[]> => ({ bank: [p('b1'), p('b2')], pack: [p('k1'), p('k2')], endgame: [p('e1', 'endgame-tech')], agent: [], ...over });
const base = { progress: progress(), plan: null, priors: null, flagged: new Set<string>(), caps: null, excludeIds: [], now: NOW, rand: () => 0.5, select: first, withPriors: noPriors, fallback: fallbackBank };

test('daily counts: first attempt at a position is new; repeats and older positions are reviews', () => {
  const yesterday = NOW - DAY;
  const attempts = [{ puzzleId: 'a', at: yesterday }, { puzzleId: 'a', at: NOW - 1000 }, { puzzleId: 'b', at: NOW - 900 }, { puzzleId: 'b', at: NOW - 800 }];
  assert.deepEqual(dailyCounts(attempts, NOW), { date: localDay(NOW), reviews: 2, new: 1 });
  const caps = capState({ date: '', reviews: 20, new: 3 }, { reviewCap: 20, newCap: 10 });
  assert.deepEqual(caps, { reviewsLeft: 0, newLeft: 7, done: false });
  assert.equal(capState({ date: '', reviews: 25, new: 10 }, { reviewCap: 20, newCap: 10 }).done, true);
});

test('daily pool: new places serve unseen positions only; review places serve due ones only', () => {
  const cards = { seenDue: { due: NOW - 1 }, seenLater: { due: NOW + DAY } };
  const pool = [p('fresh'), p('seenDue'), p('seenLater')];
  assert.deepEqual(todayPool(pool, cards, { reviewsLeft: 5, newLeft: 0, done: false }, NOW).map(x => x.id), ['seenDue']);
  assert.deepEqual(todayPool(pool, cards, { reviewsLeft: 0, newLeft: 5, done: false }, NOW).map(x => x.id), ['fresh']);
  assert.deepEqual(todayPool(pool, cards, { reviewsLeft: 5, newLeft: 5, done: false }, NOW).map(x => x.id), ['fresh', 'seenDue']);
});

test('plan: ignored once expired (ms or ISO); focus multiplies priors', () => {
  assert.ok(activePlan(plan(), NOW));
  assert.equal(activePlan(plan({ expires: NOW - 1 }), NOW), null);
  assert.equal(activePlan(plan({ expires: new Date(NOW - 1).toISOString() }), NOW), null);
  assert.ok(activePlan(plan({ expires: new Date(NOW + 1000).toISOString() }), NOW));
  assert.equal(activePlan(null, NOW), null);
  assert.deepEqual(focusPriors({ fork: 2, pin: 1.5 }, plan()), { fork: 6, pin: 1.5 });
  assert.deepEqual(focusPriors(null, plan({ focus: [{ theme: 'skewer', weight: 0.5, reason: '' }] })), { skewer: 0.5 });
  assert.deepEqual(focusPriors({ fork: 2 }, null), { fork: 2 });
});

test('mix: renormalised over sources that can serve; deterministic pick', () => {
  assert.deepEqual(sourceWeights({ bank: 0.5, pack: 0.25, endgame: 0.25, agent: 0 }, { bank: 3, pack: 0, endgame: 2, agent: 0 }), { bank: 2 / 3, pack: 0, endgame: 1 / 3, agent: 0 });
  assert.equal(sourceWeights({ bank: 0, pack: 1, endgame: 0, agent: 0 }, { bank: 3, pack: 0, endgame: 0, agent: 0 }), null);
  const w = { bank: 0.5, pack: 0.5, endgame: 0, agent: 0 };
  assert.equal(pickSource(w, 0.1), 'bank'); assert.equal(pickSource(w, 0.6), 'pack'); assert.equal(pickSource(w, 0.9999999), 'pack');
});

test('selection honours plan.mix: an all-pack plan serves pack positions; without a plan the fallback rule applies', () => {
  assert.deepEqual(pickNext({ ...base, pools: pools(), plan: plan() }).item?.id, 'k1');
  assert.equal(pickNext({ ...base, pools: pools(), plan: plan() }).source, 'pack');
  assert.deepEqual(pickNext({ ...base, pools: pools() }).item?.id, 'b1');
  // Expired plan: fallback.
  assert.deepEqual(pickNext({ ...base, pools: pools(), plan: plan({ expires: NOW - 1 }) }).item?.id, 'b1');
  // Mix over an empty source falls back to the renormalised rest, then to the default rule.
  assert.deepEqual(pickNext({ ...base, pools: pools({ pack: [] }), plan: plan({ mix: { bank: 0, pack: 0.5, endgame: 0.5, agent: 0 } }) }).item?.id, 'e1');
  assert.deepEqual(pickNext({ ...base, pools: pools({ pack: [] }), plan: plan() }).item?.id, 'b1');
});

test('selection honours plan.focus: the focus priors reach the scheduler', () => {
  let seen: Record<string, number> | null | undefined;
  const withPriors = <T,>(x: T, priors: Record<string, number> | null | undefined) => { seen = priors; return x; };
  pickNext({ ...base, pools: pools(), plan: plan(), priors: { fork: 1.5 }, withPriors });
  assert.deepEqual(seen, { fork: 4.5 });
});

test('selection skips positions flagged wrong, in every source', () => {
  const flagged = new Set(['k1', 'b1']);
  assert.equal(pickNext({ ...base, pools: pools(), plan: plan(), flagged }).item?.id, 'k2');
  assert.equal(pickNext({ ...base, pools: pools(), flagged }).item?.id, 'b2');
  assert.equal(pickNext({ ...base, pools: pools({ bank: [p('b1')] }), flagged }).item?.id, 'k2', 'the rule pool is all flagged: another source serves');
  assert.equal(pickNext({ ...base, pools: { bank: [p('b1')], pack: [p('k1')], endgame: [], agent: [] }, flagged }).reason, 'empty');
  assert.deepEqual(flaggedWrongIds([{ kind: 'wrong', status: 'open', itemId: 'x' }, { kind: 'wrong', status: 'done', itemId: 'y' }, { kind: 'more', status: 'open', itemId: 'z' }]), new Set(['x']));
});

test('daily set: caps reached means done; a capped pool can also run out', () => {
  assert.equal(pickNext({ ...base, pools: pools(), caps: { reviewsLeft: 0, newLeft: 0, done: true } }).reason, 'daily-done');
  const cards = { b1: { due: NOW + DAY, lastAttempt: NOW - DAY }, b2: { due: NOW + DAY, lastAttempt: NOW - DAY } };
  const r = pickNext({ ...base, progress: progress(cards), pools: pools({ pack: [], endgame: [] }), caps: { reviewsLeft: 5, newLeft: 0, done: false } });
  assert.equal(r.reason, 'daily-done');
  assert.equal(pickNext({ ...base, pools: pools(), caps: { reviewsLeft: 0, newLeft: 3, done: false } }).item?.id, 'b1');
});

test('selection never excludes the whole pool through recent-position avoidance', () => {
  assert.equal(pickNext({ ...base, pools: pools({ bank: [p('b1')] }), excludeIds: ['b1'] }).item?.id, 'b1');
  assert.equal(pickNext({ ...base, pools: pools(), excludeIds: ['b1'] }).item?.id, 'b2');
});
