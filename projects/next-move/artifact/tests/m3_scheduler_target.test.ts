import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPuzzle, trainingThemes, type Progress, type Puzzle, type SelectOptions } from '../lib/scheduler.js';

// M3 bank level (brief 8.18 / 9.5): `selectPuzzle(..., { targetOf })`. Invented items only.
type Item = Puzzle & { source: 'bank' | 'pack' | 'endgame' };
const FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const item = (id: string, rating: number, source: Item['source'] = 'bank', themes = ['fork']): Item => ({ id, fen: FEN, moves: ['a1a8'], rating, themes, source });
const fresh = (rating = 1000): Progress => ({ attempts: [], cards: {}, skills: {}, settings: { rating, sessionLength: 10 } });

/** The whole order the scheduler gives a pool of unseen items: pick, exclude, pick again. */
function ranking(pool: readonly Item[], progress: Progress, options: SelectOptions<Item> = {}): string[] {
  const order: string[] = [];
  for (;;) {
    const p = selectPuzzle(pool, progress, { ...options, excludeIds: [...order] });
    if (!p) return order;
    order.push(p.id);
  }
}

/** `selectPuzzle` as it was before M3 (lib/scheduler.js, 2026-11-08), kept here as the reference. */
function legacySelect(puzzles: readonly Puzzle[], progress: Progress, { theme = 'all', now = Date.now(), excludeIds = [] as string[] } = {}): Puzzle | null {
  const excluded = new Set(excludeIds);
  let pool = puzzles.filter(p => !excluded.has(p.id) && (theme === 'all' || p.themes.includes(theme)));
  if (!pool.length) return null;
  const latest = progress.attempts?.at(-1)?.puzzleId;
  if (pool.length > 1) pool = pool.filter(p => p.id !== latest);
  const cards = progress.cards || {};
  const rating = progress.settings?.rating ?? 1000;
  const weakness = (p: Puzzle) => {
    const themes = trainingThemes(p.themes);
    if (!themes.length) return 0.5;
    return themes.reduce((sum, t) => {
      const s = progress.skills?.[t];
      return sum + (s ? (s.attempts - s.successes + 2) / (s.attempts + 4) : 0.5);
    }, 0) / themes.length;
  };
  const byFit = (a: Puzzle, b: Puzzle) => (weakness(b) - weakness(a)) * 600 + Math.abs(a.rating - rating) - Math.abs(b.rating - rating) || a.id.localeCompare(b.id);
  const unseen = pool.filter(p => !cards[p.id]).sort(byFit);
  const due = pool.filter(p => cards[p.id]?.due <= now).sort((a, b) => cards[a.id].due - cards[b.id].due || byFit(a, b));
  if (unseen.length && (!due.length || (progress.attempts?.length || 0) % 3 === 2)) return unseen[0];
  if (due.length) return due[0];
  if (unseen.length) return unseen[0];
  return pool.sort((a, b) => cards[a.id].lastAttempt - cards[b.id].lastAttempt || byFit(a, b))[0];
}

const POOL = [
  item('b0900', 900), item('b1000', 1000), item('b1100', 1100), item('b1200', 1200), item('b1300', 1300), item('b1400', 1400),
  item('k0001', 1000, 'pack'), item('k0002', 1000, 'pack'), item('e0001', 1200, 'endgame'), item('e0002', 700, 'endgame'),
];

test('scheduler: without targetOf (or when it gives no number) the order is exactly as before', () => {
  const base = ranking(POOL, fresh());
  assert.deepEqual(base, POOL.map(p => p.id).sort((a, b) => {
    const r = (id: string) => Math.abs(POOL.find(p => p.id === id)!.rating - 1000);
    return r(a) - r(b) || a.localeCompare(b);
  }), 'equal weakness: closest to settings.rating first, then id');
  assert.deepEqual(ranking(POOL, fresh(), { targetOf: undefined }), base);
  assert.deepEqual(ranking(POOL, fresh(), { targetOf: () => undefined }), base);
  assert.deepEqual(ranking(POOL, fresh(), { targetOf: () => Number.NaN }), base);
  assert.deepEqual(ranking(POOL, fresh(), { targetOf: () => 1000 }), base, 'a target equal to settings.rating changes nothing');
});

test('scheduler: targetOf reorders the bank items only; the other items keep their order', () => {
  const level = 1300;
  const targetOf = (p: Item) => (p.source === 'bank' ? level : undefined);
  const before = ranking(POOL, fresh()), after = ranking(POOL, fresh(), { targetOf });
  const isBank = (id: string) => POOL.find(p => p.id === id)!.source === 'bank';
  assert.deepEqual(after.filter(id => !isBank(id)), before.filter(id => !isBank(id)), 'non-bank order unchanged');
  assert.deepEqual(after.filter(isBank), ['b1300', 'b1200', 'b1400', 'b1100', 'b1000', 'b0900'], 'bank items by distance to the level, then id');
  assert.deepEqual(before.filter(isBank), ['b1000', 'b0900', 'b1100', 'b1200', 'b1300', 'b1400']);
  assert.equal(selectPuzzle(POOL.filter(p => p.source === 'bank'), fresh(), { targetOf })?.id, 'b1300');
  assert.equal(selectPuzzle(POOL.filter(p => p.source === 'bank'), fresh())?.id, 'b1000');
});

test('scheduler: targetOf only replaces the rating distance; weaker themes still come first, and due order still leads', () => {
  const progress = fresh();
  progress.skills.fork = { attempts: 10, successes: 10, lastAttempt: 1 }; // fork is strong: (0 + 2) / 14
  // A pin puzzle (unseen theme, weakness 0.5) 150 from the level still beats a fork puzzle at the level:
  // (0.5 - 2/14) * 600 = 214 points of weakness against 150 points of distance. At 300 points the distance wins.
  const pool = [item('fork-at-level', 1300, 'bank', ['fork']), item('pin-150-away', 1150, 'bank', ['pin'])];
  assert.equal(selectPuzzle(pool, progress, { targetOf: () => 1300 })?.id, 'pin-150-away');
  assert.equal(selectPuzzle([pool[0], item('pin-300-away', 1000, 'bank', ['pin'])], progress, { targetOf: () => 1300 })?.id, 'fork-at-level');
  // Due reviews: the earlier due time wins; an equal due time is broken by the fit to the level.
  const due = { attempts: 1, successes: 1, lapses: 0, streak: 1, intervalDays: 1, lastAttempt: 1 };
  const dueProgress = fresh();
  dueProgress.cards = { d1000: { ...due, due: 5 }, d1300: { ...due, due: 5 }, early: { ...due, due: 4 } };
  const duePool = [item('d1000', 1000), item('d1300', 1300), item('early', 1600)];
  assert.equal(selectPuzzle(duePool, dueProgress, { now: 10, targetOf: () => 1300 })?.id, 'early');
  const tie = duePool.slice(0, 2);
  assert.equal(selectPuzzle(tie, dueProgress, { now: 10 })?.id, 'd1000');
  assert.equal(selectPuzzle(tie, dueProgress, { now: 10, targetOf: () => 1300 })?.id, 'd1300');
});

test('scheduler: with no targetOf the pick matches the pre-M3 selector on 600 random states', () => {
  let s = 2026;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const THEMES = ['fork', 'pin', 'skewer', 'short', 'mateIn1', 'personal'];
  for (let run = 0; run < 600; run++) {
    const n = 1 + Math.floor(rand() * 12);
    const pool = Array.from({ length: n }, (_, i) => item(`x${run}-${i}`, 600 + 50 * Math.floor(rand() * 25), 'bank', THEMES.filter(() => rand() < 0.35)));
    const progress = fresh(pick([600, 800, 1000, 1200, 1400, 1600, 1800]));
    for (const p of pool) if (rand() < 0.4) progress.cards[p.id] = { attempts: 1, successes: 1, lapses: 0, streak: 1, intervalDays: 1, lastAttempt: Math.floor(rand() * 50), due: Math.floor(rand() * 100) };
    for (const t of THEMES) if (rand() < 0.5) { const a = Math.floor(rand() * 9); progress.skills[t] = { attempts: a, successes: Math.floor(rand() * (a + 1)), lastAttempt: 1 }; }
    const k = Math.floor(rand() * 5);
    for (let j = 0; j < k; j++) progress.attempts.push({ puzzleId: pick(pool).id, themes: [], correct: true, unassisted: true, hints: 0, revealed: false, durationMs: 1, at: j });
    const options = { theme: rand() < 0.3 ? pick(THEMES) : 'all', now: 50, excludeIds: pool.filter(() => rand() < 0.2).map(p => p.id) };
    assert.equal(selectPuzzle(pool, progress, options)?.id ?? null, legacySelect(pool, progress, options)?.id ?? null, `run ${run}`);
  }
});
