import test from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_DIR } from './b3_paths';
import assert from 'node:assert/strict';
import { createFakeStore, createMemoryKv, type DocData, type Store } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { createTrainerModel } from '../components/model';
import { DEFAULT_AGENT_SHARE, pickNext, withAgentShare } from '../components/daily';
import { buildPools, fallbackPool, type TrainerItem } from '../components/pools';
import { buildProgress } from '../components/progress';
import { buildBackup, SITE_MAX_ATTEMPTS } from '../components/backup';
import { limitMessage } from '../components/CoachPanel';
import { selectPuzzle, trainingThemes, type Progress as SP } from '../lib/scheduler.js';
import { withThemePriors } from '../lib/personal-pack';
import { puzzles } from '../lib/puzzles';
import { endgameDrills } from '../lib/endgames';

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const NOW = Date.now();
// The seeded plan's shape: no agent share.
const PLAN = { updatedAt: NOW, author: 'claude', expires: NOW + 14 * 86_400_000, focus: [{ theme: 'fork', weight: 2, reason: 'most missed' }], mix: { bank: 0.5, pack: 0.4, endgame: 0.1, agent: 0 } };
const SET = { title: 'Back-rank checks', reason: 'missed twice this week', createdAt: NOW, active: true, cards: [
  { id: 'agent-br-1', fen: FEN, moves: ['a1a8'], themes: ['backRankMate'], rating: 900 },
  { id: 'agent-br-2', fen: FEN, moves: ['a1a7'], themes: ['backRankMate'], rating: 900 },
] };

async function open(seed: Record<string, DocData>, wrap?: (s: Store) => Store) {
  const base = createFakeStore({ seed });
  const store = wrap ? wrap(base) : base;
  const sessions = await createSessionWriter({ store: base, kv: createMemoryKv(), deviceId: 'd1', events: null });
  const model = createTrainerModel({ store, sessions, deviceId: 'd1', packRetryMs: 10 });
  await tick();
  return { base, model, done: () => { model.dispose(); sessions.dispose(); } };
}
function picks(view: ReturnType<ReturnType<typeof createTrainerModel>['get']>, n: number) {
  const pools = buildPools({ bank: puzzles, endgames: endgameDrills, pack: view.pack, personal: view.personal, drills: view.drills });
  const progress = buildProgress(view.attempts, view.settings, trainingThemes);
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const out: Array<TrainerItem | null> = [];
  for (let i = 0; i < n; i++) {
    out.push(pickNext<TrainerItem>({
      pools: pools.bySource, progress, plan: view.plan, priors: null, flagged: view.flaggedWrong, caps: { reviewsLeft: 20, newLeft: 10, done: false }, excludeIds: [], now: NOW, rand,
      select: (pool, p, o) => selectPuzzle(pool, p as unknown as SP, o), withPriors: (p, pr) => withThemePriors(p, pr), fallback: (b, p) => fallbackPool(b, p.attempts.length),
    }).item);
  }
  return out;
}

test('P1-1: a drill set written after load shows up in the daily set under a plan with mix.agent 0, no republish', async () => {
  const { base, model, done } = await open({ 'plan/current': PLAN });
  try {
    assert.equal(picks(model.get(), 200).filter(p => p?.source === 'agent').length, 0, 'no set yet');
    await base.set('drills/br', SET);
    await tick();
    assert.equal(model.get().drills.length, 1);
    const served = picks(model.get(), 500).filter(p => p?.source === 'agent').length;
    assert.ok(served > 500 * DEFAULT_AGENT_SHARE * 0.5 && served < 500 * DEFAULT_AGENT_SHARE * 1.5, `agent share near the default 0.10: ${served}/500`);
    // A card flagged wrong is skipped; a flag on the set id skips the whole set.
    await model.sendFeedback({ kind: 'wrong', item: { id: 'agent-br-1', source: 'agent', themes: ['backRankMate'], fen: FEN } });
    assert.ok(picks(model.get(), 300).every(p => p?.id !== 'agent-br-1'));
    await model.sendFeedback({ kind: 'wrong', item: { id: 'br', source: 'agent', themes: ['backRankMate'], fen: FEN } });
    await tick();
    assert.equal(model.get().drills.length, 0);
    assert.equal(picks(model.get(), 200).filter(p => p?.source === 'agent').length, 0);
  } finally { done(); }
});

test('P1-1: the drill share is mix.agent as written when above 0, else 0.10; also with no plan; none without a set', async () => {
  const close = (a: Record<string, number> | null, b: Record<string, number>) => { assert.ok(a); for (const k of Object.keys(b)) assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${k}: ${a[k]} vs ${b[k]}`); };
  close(withAgentShare({ bank: 0.5, pack: 0.5, endgame: 0, agent: 0 }, true, 0), { bank: 0.45, pack: 0.45, endgame: 0, agent: 0.1 });
  close(withAgentShare({ bank: 0.5, pack: 0.5, endgame: 0, agent: 0 }, true, undefined), { bank: 0.45, pack: 0.45, endgame: 0, agent: 0.1 });
  // As written, even when renormalisation over available sources would have raised it (pack empty here).
  close(withAgentShare({ bank: 0.45 / 0.55, pack: 0, endgame: 0, agent: 0.1 / 0.55 }, true, 0.1), { bank: 0.9, pack: 0, endgame: 0, agent: 0.1 });
  close(withAgentShare({ bank: 0.7, pack: 0, endgame: 0, agent: 0.3 }, true, 0.3), { bank: 0.7, pack: 0, endgame: 0, agent: 0.3 });
  close(withAgentShare({ bank: 0.95, pack: 0, endgame: 0, agent: 0.05 }, true, 0.05), { bank: 0.95, pack: 0, endgame: 0, agent: 0.05 });
  close(withAgentShare({ bank: 1, pack: 0, endgame: 0, agent: 0 }, false, 0.3), { bank: 1, pack: 0, endgame: 0, agent: 0 });
  const { base, model, done } = await open({});
  try {
    await base.set('drills/br', SET);
    await tick();
    const served = picks(model.get(), 500).filter(p => p?.source === 'agent').length;
    assert.ok(served > 0, 'no plan: drill cards are still served');
  } finally { done(); }
});

test('P2-9: a drill document that fails the contract is reported in rejected with id "*"', async () => {
  const { base, done } = await open({ 'drills/bad': { reason: 'no title', createdAt: NOW, active: true, cards: [] } });
  try {
    await tick();
    const doc = base.dump()['drills/bad'] as { rejected?: Array<{ id: string; reason: string }> };
    assert.equal(doc.rejected?.[0].id, '*');
    assert.match(doc.rejected?.[0].reason ?? '', /Whole set ignored: title/);
  } finally { done(); }
});

test('P2-1 and P2-10: history uses the newest 1000 sessions, plus rolled-up summaries', async () => {
  const seed: Record<string, DocData> = {};
  for (let i = 0; i < 1001; i++) seed[`sessions/s-${1000 + i}-d0`] = { device: 'd0', startedAt: 1000 + i, attempts: [{ puzzleId: `p${i}`, themes: ['fork'], correct: true, unassisted: true, hints: 0, revealed: false, durationMs: 1, at: 1000 + i }] };
  seed['summaries/2026-01'] = { month: '2026-01', attempts: [{ puzzleId: 'old', themes: ['pin'], correct: true, unassisted: true, hints: 0, revealed: false, durationMs: 1, at: 5 }] };
  const { model, done } = await open(seed);
  try {
    const ids = new Set(model.get().attempts.map(a => a.puzzleId));
    assert.ok(ids.has('p1000'), 'newest session kept');
    assert.ok(!ids.has('p0'), 'the oldest drops out first');
    assert.ok(ids.has('old'), 'summaries count');
  } finally { done(); }
});

test('P2-4: a failed pack chunk read is retried while the meta is unchanged', async () => {
  let failures = 1;
  const wrap = (s: Store): Store => ({ ...s, get: async <T,>(p: string) => { if (p === 'pack/v-cards-00' && failures-- > 0) return null; return s.get<T>(p); } });
  const { model, done } = await open({
    'pack/meta': { packVersion: 'v', importedAt: 1, counts: {}, priors: {}, chunks: { cards: ['v-cards-00'], special: [] } },
    'pack/v-cards-00': { cards: [{ id: 'pack-a:1', fen: FEN, moves: ['a1a8'], rating: 1000, themes: ['backRankMate'] }] },
  }, wrap);
  try {
    await tick(60);
    assert.equal(model.get().pack?.cards.length, 1);
    assert.equal(model.get().error, '', 'the pack message clears once the retry succeeds');
  } finally { done(); }
});

test('P2-3: settings cannot be saved before the stored settings have arrived', async () => {
  const store = createFakeStore({ latencyMs: 40, seed: { 'settings/main': { rating: 1200, sessionLength: 10, updatedAt: 1, device: 'x', lastIngest: 5 } } });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'd1', events: null });
  const model = createTrainerModel({ store, sessions, deviceId: 'd1' });
  try {
    assert.equal(model.get().synced, false);
    assert.equal(await model.saveSettings({ rating: 800 }), false);
    assert.equal((store.dump()['settings/main'] as { lastIngest?: number }).lastIngest, 5);
    await tick(120);
    assert.equal(model.get().synced, true);
    assert.equal(await model.saveSettings({ rating: 800 }), true);
    assert.equal((store.dump()['settings/main'] as { lastIngest?: number }).lastIngest, 5);
  } finally { model.dispose(); sessions.dispose(); }
});

test('P2-7: the coach request is refused before any reveal when the daily cap or cooldown applies', () => {
  assert.match(limitMessage({ remainingToday: 0, cooldownUntil: 0 }, 1000) ?? '', /used up/);
  assert.equal(limitMessage({ remainingToday: 3, cooldownUntil: 5000 }, 1000), 'Ask again in 4 s.');
  assert.equal(limitMessage({ remainingToday: 3, cooldownUntil: 500 }, 1000), null);
});

test('P2-5: an export keeps at most the newest 20,000 attempts so the Site can import it', () => {
  const attempts = Array.from({ length: SITE_MAX_ATTEMPTS + 3 }, (_, i) => ({ puzzleId: `p${i}`, themes: ['fork'], correct: true, unassisted: true, hints: 0, revealed: false, durationMs: 1, at: i }));
  const b = buildBackup({ attempts, progress: { cards: {}, skills: {} }, settings: { rating: 1000, sessionLength: 10, dailyReviewCap: 20, dailyNewCap: 10, updatedAt: 0 }, personal: [], plan: null, notes: [], openFeedback: [], packVersion: null, exportedAt: 1 });
  assert.equal(b.progress.attempts.length, SITE_MAX_ATTEMPTS);
  assert.equal(b.progress.attempts[0].puzzleId, 'p3');
  assert.equal(b.nextMove.omittedAttempts, 3);
});


// The seed is private (his positions) and never published: without it this test skips with a stated reason.
// Nothing from the seed is copied here; drill sets are discovered from seed/drills/ at run time.
const SEED_PLAN = join(SEED_DIR, 'plan', 'current.json');
const SEED_DRILLS = join(SEED_DIR, 'drills');
const seedSkip = existsSync(SEED_PLAN) && existsSync(SEED_DRILLS) ? false : `private seed absent at ${SEED_DIR} (never published; set NEXT_MOVE_SEED_ROOT to run it)`;
test('B3 seed: the sample drill set and plan load, pass the page checks, and the set is served at the plan share', { skip: seedSkip }, async () => {
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as DocData;
  const plan = read(SEED_PLAN);
  const drillFiles = readdirSync(SEED_DRILLS).filter(f => f.endsWith('.json'));
  assert.ok(drillFiles.length > 0, 'the seed holds at least one drill set');
  const docs: Record<string, DocData> = { 'plan/current': { ...plan, expires: NOW + 86_400_000 } }; // keep the seeded plan in force
  for (const f of drillFiles) docs[`drills/${f.slice(0, -5)}`] = read(join(SEED_DRILLS, f));
  const { model, done } = await open(docs);
  try {
    const v = model.get();
    assert.ok(v.plan, 'seed plan passes the contract');
    assert.ok((v.plan.mix.agent ?? 0) > 0, 'seed plan gives drill sets a share');
    assert.equal(v.drills.length, drillFiles.length, 'every seeded set is active and passes the contract');
    for (const set of v.drills) { assert.ok(set.cards.length > 0, set.id); assert.equal(set.rejected.length, 0, set.id); }
    const served = picks(v, 500).filter(p => p?.source === 'agent').length;
    const share = v.plan.mix.agent;
    assert.ok(served > 500 * share * 0.5 && served < 500 * share * 1.5, `served ${served}/500 at share ${share}`);
  } finally { done(); }
});
