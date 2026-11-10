import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPools, fallbackPool, isPunish } from '../components/pools';
import { buildProgress } from '../components/progress';

const FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const base = (id: string, themes = ['fork']) => ({ id, fen: FEN, moves: ['a1a8'], rating: 1000, themes });

test('pools: sources tagged, ids unique (first wins), punish cards marked, drill titles carried', () => {
  const pools = buildPools({
    bank: [base('b1'), base('dup')],
    endgames: [base('e1', ['endgame-tech'])],
    pack: { version: 'v', meta: {} as never, cards: [base('pack-1') as never, base('dup') as never], punish: [base('punish-1') as never], study: [], punishStudy: [] },
    personal: [base('personal-1', ['personal'])],
    drills: [{ id: 's', title: 'Back rank', reason: '', cards: [base('agent-s-1') as never], rejected: [] }],
  });
  assert.deepEqual(pools.bySource.bank.map(p => p.id), ['b1']);
  assert.deepEqual(pools.bySource.pack.map(p => [p.id, p.source]), [['personal-1', 'personal'], ['pack-1', 'pack'], ['dup', 'pack'], ['punish-1', 'pack']]);
  assert.ok(isPunish(pools.byId.get('punish-1')));
  assert.equal(isPunish(pools.byId.get('pack-1')), false);
  assert.equal(pools.byId.get('agent-s-1')?.title, 'Back rank');
  assert.equal(pools.byId.get('agent-s-1')?.source, 'agent');
  assert.equal(pools.byId.get('e1')?.source, 'endgame');
  assert.equal(pools.all.length, 7);
});

test('fallback pool: own-game slot every fourth attempt; no endgame drills for a new profile', () => {
  const pools = buildPools({ bank: [base('b1')], endgames: [base('e1', ['endgame-tech'])], pack: null, personal: [base('personal-1')], drills: [] });
  assert.deepEqual(fallbackPool(pools.bySource, 3).map(p => p.id), ['personal-1']);
  assert.deepEqual(fallbackPool(pools.bySource, 0).map(p => p.id), ['personal-1', 'b1']);
  assert.deepEqual(fallbackPool(pools.bySource, 5).map(p => p.id), ['personal-1', 'b1', 'e1']);
});

test('progress: cards and skills rebuilt from attempts in time order', () => {
  const at = (puzzleId: string, t: number, ok: boolean) => ({ puzzleId, themes: ['fork', 'short'], correct: ok, unassisted: ok, hints: 0, revealed: false, durationMs: 1, at: t });
  const p = buildProgress([at('x', 2000, true), at('x', 1000, false)], { rating: 1000, sessionLength: 10 }, t => t.filter(x => x !== 'short'));
  assert.deepEqual(p.attempts.map(a => a.at), [1000, 2000]);
  assert.equal(p.cards.x.attempts, 2); assert.equal(p.cards.x.lapses, 1); assert.equal(p.cards.x.streak, 1);
  assert.equal(p.cards.x.due, 2000 + 86_400_000);
  assert.deepEqual(p.skills, { fork: { attempts: 2, successes: 1, lastAttempt: 2000 } });
});
