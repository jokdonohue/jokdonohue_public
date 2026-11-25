import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bankLevel, BANK_LEVEL_DOWN, BANK_LEVEL_GATE, BANK_LEVEL_MAX, BANK_LEVEL_MIN, BANK_LEVEL_UP, type BankLevelAttempt,
} from '../components/bankLevel';

// M3 bank level (brief 8.18 / 9.5). Invented puzzle ids and ratings only.
const attempt = (puzzleId: string, at: number, unassisted = true): BankLevelAttempt => ({ puzzleId, at, unassisted });
const bank = (ratings: Record<string, number>) => (id: string) => ratings[id];

test('bank level: constants are the audit rule (gate 150, +25, -100, clamp 600-1750)', () => {
  assert.deepEqual([BANK_LEVEL_GATE, BANK_LEVEL_UP, BANK_LEVEL_DOWN, BANK_LEVEL_MIN, BANK_LEVEL_MAX], [150, 25, 100, 600, 1750]);
});

test('bank level: no attempts gives the seed, unclamped; a seed that is not a number falls back to 1000', () => {
  assert.deepEqual(bankLevel([], () => undefined, 1000), { level: 1000, counted: 0, held: 0 });
  assert.deepEqual(bankLevel([], () => undefined, 1800), { level: 1800, counted: 0, held: 0 }, 'the seed is never clamped');
  assert.deepEqual(bankLevel([], () => undefined, 600), { level: 600, counted: 0, held: 0 });
  assert.equal(bankLevel([attempt('p1', 1)], bank({ p1: 1000 }), Number.NaN).level, 1025);
});

test('bank level: a clean first try adds 25, any other first try takes 100', () => {
  const ratingOf = bank({ p1: 1000, p2: 1000 });
  assert.deepEqual(bankLevel([attempt('p1', 1)], ratingOf, 1000), { level: 1025, counted: 1, held: 0 });
  assert.deepEqual(bankLevel([attempt('p1', 1, false)], ratingOf, 1000), { level: 900, counted: 1, held: 0 });
  assert.deepEqual(bankLevel([attempt('p1', 1), attempt('p2', 2, false)], ratingOf, 1000), { level: 925, counted: 2, held: 0 });
});

test('bank level: equilibrium at 80% first-try success (four clean, one miss, back to the start)', () => {
  // Every puzzle is rated at the seed, so the level (at most 100 above it) never leaves the gate.
  const ratings: Record<string, number> = {};
  const list: BankLevelAttempt[] = [];
  for (let i = 0; i < 50; i++) {
    ratings[`p${i}`] = 1200;
    list.push(attempt(`p${i}`, i + 1, i % 5 !== 4));
  }
  assert.deepEqual(bankLevel(list, bank(ratings), 1200), { level: 1200, counted: 50, held: 0 });
  // At every point the level stays within one cycle's swing of the start.
  for (let n = 1; n <= 50; n++) {
    const { level } = bankLevel(list.slice(0, n), bank(ratings), 1200);
    assert.ok(level >= 1200 && level <= 1300, `after ${n}: ${level}`);
  }
  // Better than 80% climbs, worse than 80% falls.
  const better = list.map((a, i) => ({ ...a, unassisted: i % 10 !== 9 }));
  const worse = list.map((a, i) => ({ ...a, unassisted: i % 3 !== 2 }));
  assert.ok(bankLevel(better, bank(ratings), 1200).level > 1200);
  assert.ok(bankLevel(worse, bank(ratings), 1200).level < 1200);
});

test('bank level: the gate holds first tries more than 150 from the running level; exactly 150 counts', () => {
  const ratingOf = bank({ up150: 1150, up151: 1151, down150: 850, down151: 849 });
  assert.deepEqual(bankLevel([attempt('up150', 1)], ratingOf, 1000), { level: 1025, counted: 1, held: 0 });
  assert.deepEqual(bankLevel([attempt('up151', 1)], ratingOf, 1000), { level: 1000, counted: 0, held: 1 });
  assert.deepEqual(bankLevel([attempt('down150', 1, false)], ratingOf, 1000), { level: 900, counted: 1, held: 0 });
  assert.deepEqual(bankLevel([attempt('down151', 1, false)], ratingOf, 1000), { level: 1000, counted: 0, held: 1 });
  // A held miss does not lower the level.
  assert.deepEqual(bankLevel([attempt('up151', 1, false)], ratingOf, 1000), { level: 1000, counted: 0, held: 1 });
});

test('bank level: clean solves near one rating climb until that rating falls out of the gate, then hold', () => {
  // Ten clean first tries at puzzles all rated 1000: 1000 -> 1025 ... -> 1150 (still within 150) -> 1175, then held.
  const ratings: Record<string, number> = {};
  const list: BankLevelAttempt[] = [];
  for (let i = 0; i < 10; i++) { ratings[`q${i}`] = 1000; list.push(attempt(`q${i}`, 100 + i)); }
  assert.deepEqual(bankLevel(list, bank(ratings), 1000), { level: 1175, counted: 7, held: 3 });
  // From a seed far above that history everything is held: the seed decides.
  assert.deepEqual(bankLevel(list, bank(ratings), 1400), { level: 1400, counted: 0, held: 10 });
});

test('bank level: clamps at 600 and 1750 after a counted step', () => {
  const ratingOf = bank({ hi: 1750, lo: 640, top: 1700, far: 1600 });
  assert.deepEqual(bankLevel([attempt('hi', 1)], ratingOf, 1740), { level: 1750, counted: 1, held: 0 });
  assert.deepEqual(bankLevel([attempt('hi', 1)], ratingOf, 1750), { level: 1750, counted: 1, held: 0 }, 'a step the clamp cancels still counts');
  assert.deepEqual(bankLevel([attempt('lo', 1, false)], ratingOf, 640), { level: 600, counted: 1, held: 0 });
  assert.deepEqual(bankLevel([attempt('lo', 1, false)], ratingOf, 600), { level: 600, counted: 1, held: 0 });
  // A seed above the clamp: a held try leaves it; a counted clean try lands on 1750 (the clamp, not a penalty).
  assert.deepEqual(bankLevel([attempt('far', 1)], ratingOf, 1800), { level: 1800, counted: 0, held: 1 });
  assert.deepEqual(bankLevel([attempt('top', 1)], ratingOf, 1800), { level: 1750, counted: 1, held: 0 });
  // Long runs never leave the range.
  const ratings: Record<string, number> = {};
  const wins: BankLevelAttempt[] = [], losses: BankLevelAttempt[] = [];
  for (let i = 0; i < 80; i++) {
    ratings[`w${i}`] = 1750; ratings[`l${i}`] = 600;
    wins.push(attempt(`w${i}`, i + 1)); losses.push(attempt(`l${i}`, i + 1, false));
  }
  assert.equal(bankLevel(wins, bank(ratings), 1700).level, 1750);
  assert.equal(bankLevel(losses, bank(ratings), 700).level, 600);
});

test('bank level: only the first attempt at each puzzle counts, in time order, whatever the input order', () => {
  const ratingOf = bank({ a: 1000, b: 1000 });
  // A repeat miss after a clean first try changes nothing.
  assert.deepEqual(bankLevel([attempt('a', 1), attempt('a', 2, false), attempt('a', 3, false)], ratingOf, 1000), { level: 1025, counted: 1, held: 0 });
  // The earliest attempt is the first try even when it is listed last.
  assert.deepEqual(bankLevel([attempt('a', 9), attempt('a', 2, false)], ratingOf, 1000), { level: 900, counted: 1, held: 0 });
  // A repeat never stands in for a first try that was held: the puzzle is spent.
  const far = bank({ f: 1300 });
  assert.deepEqual(bankLevel([attempt('f', 1), attempt('f', 50)], far, 1000), { level: 1000, counted: 0, held: 1 });
  // Same time: ties go by id, so the result does not depend on the input order.
  const tied = [attempt('b', 5, false), attempt('a', 5)];
  assert.deepEqual(bankLevel(tied, ratingOf, 1000), bankLevel([...tied].reverse(), ratingOf, 1000));
});

test('bank level: ids in skip, non-bank ids and unusable ratings are ignored altogether', () => {
  const ratingOf = (id: string) => ({ flagged: 1000, ok: 1000, odd: Number.NaN } as Record<string, number>)[id];
  const list = [attempt('flagged', 1, false), attempt('flagged', 2), attempt('pack-0000000000000001', 3, false), attempt('odd', 4, false), attempt('ok', 5)];
  assert.deepEqual(bankLevel(list, ratingOf, 1000, new Set(['flagged'])), { level: 1025, counted: 1, held: 0 });
  assert.deepEqual(bankLevel(list, ratingOf, 1000), { level: 925, counted: 2, held: 0 }, 'without skip the flagged miss counts');
});

test('bank level: the caller\'s list is not changed', () => {
  const list = [attempt('b', 3), attempt('a', 1, false)];
  const copy = JSON.parse(JSON.stringify(list)) as BankLevelAttempt[];
  bankLevel(list, bank({ a: 1000, b: 1000 }), 1000);
  assert.deepEqual(list, copy);
});

test('bank level: each counted step goes the right way (seeded random histories)', () => {
  let s = 12345;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let run = 0; run < 40; run++) {
    const ratings: Record<string, number> = {};
    const list: BankLevelAttempt[] = [];
    const n = 30 + Math.floor(rand() * 30);
    for (let i = 0; i < n; i++) {
      const id = `r${run}-${Math.floor(rand() * n)}`; // repeats happen
      ratings[id] = 600 + 50 * Math.floor(rand() * 25);
      list.push(attempt(id, i + 1, rand() < 0.8));
    }
    const seed = 600 + 50 * Math.floor(rand() * 24); // 600 to 1750
    let before = bankLevel([], bank(ratings), seed);
    for (let k = 1; k <= list.length; k++) {
      const after = bankLevel(list.slice(0, k), bank(ratings), seed);
      const a = list[k - 1];
      assert.ok(after.level >= 600 && after.level <= 1750);
      assert.ok(after.counted + after.held >= before.counted + before.held);
      if (after.counted > before.counted) {
        assert.equal(after.level, a.unassisted ? Math.min(1750, before.level + 25) : Math.max(600, before.level - 100), `run ${run} step ${k}`);
      } else assert.equal(after.level, before.level, `run ${run} step ${k}: no step without a counted first try`);
      before = after;
    }
  }
});
