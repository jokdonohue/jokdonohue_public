import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPools, fallbackPool, isPunish, type Pools, type TrainerItem } from '../components/pools';
import { buildProgress } from '../components/progress';
import { loadTeach, type LoadedPack, type LoadedTeach } from '../components/model';
import { todayPool, capState, dailyCounts } from '../components/daily';
import { readTeachMeta, type TeachHeld, type TeachThreat } from '../src/contract/teachDocs';
import { classifyPunish } from '../src/teach/punish';
import { threatFacts } from '../src/teach/threat';

// Version 7.1 (brief m31, 4.2 and 4.5): the join of `teach/meta` in the pools. Invented cards only.

const FEN = '6k1/5pp1/7p/n7/8/8/5PPP/3R2K1 w - - 0 1';
const base = (id: string, moves = ['d1d5'], extra: Record<string, unknown> = {}) => ({ id, fen: FEN, moves, rating: 1000, themes: ['quiet'], ...extra });
/** A punish card whose solver Win% after the game move is `solverWin` (65 or more: graded; 50 to 64: small edge; under 50: missed win). */
const punish = (id: string, solverWin: number, moves = ['d1d5']) => base(id, moves, { kind: 'punish', pack: { winAfter: 100 - solverWin, playedUci: 'g7g8' } });

const pack = (): LoadedPack => ({
  version: 'v', meta: {} as never,
  cards: [base('pack-1', ['d1d5'], { pack: { playedUci: 'd1d4' } }), base('pack-2', ['d1d7']), base('pack-3')] as never,
  punish: [punish('punish-1', 80), punish('punish-2', 70), punish('punish-3', 90), punish('punish-4', 66), punish('punish-edge', 60), punish('punish-missed', 40)] as never,
  study: [], punishStudy: [],
});
const threat = (id: string, a = 'd1d5', extra: Partial<TeachThreat> = {}): TeachThreat => ({ id, a, t: ['d5a5'], k: 'capture', sq: 'a5', r: 'undefended', pre: false, ...extra });
const teachOf = (cards: TeachThreat[], held: TeachHeld[]): LoadedTeach =>
  loadTeach(readTeachMeta({ v: 1, teachVersion: 't20261114-00000000', packVersion: 'v', at: 1, cards, held }))!;
const build = (teach?: LoadedTeach | null) => buildPools({
  bank: [base('bank-1')], endgames: [base('eg-1', ['d1d5'], { themes: ['endgame-tech'] })], pack: pack(),
  personal: [{ ...base('personal-1', ['d1d5'], { themes: ['personal'] }), fen: '6k1/5pp1/7p/n7/8/8/5PPP/2R3K1 w - - 0 1' }],
  drills: [{ id: 's', title: 'Set', reason: '', cards: [base('agent-s-1') as never], rejected: [] }],
  ...(teach !== undefined ? { teach } : {}),
});
const ids = (list: readonly TrainerItem[]) => list.map(p => p.id);
const everywhere = (p: Pools) => [...p.all, ...p.own, ...p.byId.values(), ...Object.values(p.bySource).flat()];

test('pools 7.1: without the document every pool is version 7\'s, and the two new lists are empty', () => {
  const v7 = build();
  assert.deepEqual(ids(v7.own), ['personal-1', 'pack-1', 'pack-2', 'pack-3', 'punish-1', 'punish-2', 'punish-3', 'punish-4']);
  assert.deepEqual(ids(v7.smallEdge), ['punish-edge']);
  assert.deepEqual(ids(v7.missedWin), ['punish-missed']);
  assert.deepEqual(v7.punishClasses, { punish: 4, 'small-edge': 1, 'missed-win': 1 });
  assert.deepEqual([v7.notUnique, v7.notHeld], [[], []]);
  for (const p of [...everywhere(v7), ...v7.smallEdge, ...v7.missedWin]) assert.ok(!('teach' in p) && !('teachHeld' in p), p.id);
  // null, an empty document and a document about other cards all give the same pools.
  const empty = teachOf([], []);
  const strangers = teachOf([threat('pack-999'), threat('bank-1'), threat('personal-1'), threat('agent-s-1'), threat('eg-1')], [{ id: 'punish-999', a: 'd1d5', why: 'not-unique', alt: 'd1d4' }, { id: 'pack-1', a: 'd1d5', why: 'not-unique' }, { id: 'bank-1', a: 'd1d5', why: 'not-held' }]);
  for (const t of [null, empty, strangers]) assert.deepEqual(build(t), v7);
});

test('pools 7.1: an entry is joined only when it was computed for the card\'s own move', () => {
  const teach = teachOf(
    [threat('pack-1'), threat('pack-2', 'd1d5'), threat('punish-1'), threat('punish-edge'), threat('punish-missed'), threat('punish-2', 'd1d4')],
    [],
  );
  const p = build(teach);
  assert.equal(p.byId.get('pack-1')?.teach, teach.byId.get('pack-1'), 'the stored entry itself, not a copy');
  assert.equal(p.byId.get('punish-1')?.teach, teach.byId.get('punish-1'));
  assert.equal(p.smallEdge[0].teach, teach.byId.get('punish-edge'), 'reading-list cards carry their entry too');
  assert.equal(p.missedWin[0].teach, teach.byId.get('punish-missed'));
  // Stale: the entry names another answer than the card's move (pack-2 plays d1d7; punish-2 plays d1d5).
  assert.equal(p.byId.get('pack-2')?.teach, undefined);
  assert.equal(p.byId.get('punish-2')?.teach, undefined);
  assert.equal(p.byId.get('pack-3')?.teach, undefined, 'no entry');
  // The same object is in every pool that holds the card.
  assert.equal(p.all.find(x => x.id === 'pack-1'), p.byId.get('pack-1'));
  assert.equal(p.own.find(x => x.id === 'pack-1'), p.byId.get('pack-1'));
  assert.equal(p.bySource.pack.find(x => x.id === 'pack-1'), p.byId.get('pack-1'));
  // Nothing else about the pools changes: same ids, same order, same classes; every other field of a card is equal.
  const v7 = build();
  for (const key of ['all', 'own', 'smallEdge', 'missedWin'] as const) assert.deepEqual(ids(p[key]), ids(v7[key]), key);
  assert.deepEqual(p.punishClasses, v7.punishClasses);
  assert.deepEqual([p.notUnique, p.notHeld], [[], []]);
  for (const x of p.all) { const { teach: _t, ...rest } = x; assert.deepEqual(rest, v7.byId.get(x.id)); }
  // The joined card is what the page module reads.
  assert.equal(threatFacts(p.byId.get('pack-1')!)?.k, 'capture');
  assert.equal(threatFacts(p.byId.get('pack-2')!), null);
});

test('pools 7.1: a held graded punish card is in none of all, own, byId or bySource', () => {
  const teach = teachOf([threat('punish-1')], [
    { id: 'punish-1', a: 'd1d5', why: 'not-unique', alt: 'd1d4' },
    { id: 'punish-3', a: 'd1d5', why: 'not-held' },
  ]);
  const p = build(teach);
  assert.deepEqual(ids(p.notUnique), ['punish-1']);
  assert.deepEqual(ids(p.notHeld), ['punish-3']);
  assert.equal(p.notUnique[0].teachHeld, teach.held.get('punish-1'));
  assert.equal(p.notHeld[0].teachHeld, teach.held.get('punish-3'));
  assert.equal(p.notUnique[0].teach, teach.byId.get('punish-1'), 'a held card keeps its threat entry for the reading list');
  assert.ok(isPunish(p.notUnique[0]) && isPunish(p.notHeld[0]));
  for (const id of ['punish-1', 'punish-3']) {
    assert.ok(!everywhere(p).some(x => x.id === id), `${id} is in a pool`);
    assert.equal(p.byId.has(id), false);
  }
  assert.deepEqual(ids(p.own), ['personal-1', 'pack-1', 'pack-2', 'pack-3', 'punish-2', 'punish-4']);
  assert.deepEqual(ids(p.own.filter(isPunish)), ['punish-2', 'punish-4'], 'the graded set');
  assert.equal(p.all.length, build().all.length - 2);
  // The three class keys and their version 7 counts stay: a held card is still class `punish` by its Win%.
  assert.deepEqual(p.punishClasses, { punish: 4, 'small-edge': 1, 'missed-win': 1 });
  assert.deepEqual(Object.keys(p.punishClasses), ['punish', 'small-edge', 'missed-win']);
  assert.equal(classifyPunish(p.notUnique[0]), 'punish');
  // graded + held = the class count.
  assert.equal(p.own.filter(isPunish).length + p.notUnique.length + p.notHeld.length, p.punishClasses.punish);
  // The other held lists are untouched, and no served card carries a held row.
  assert.deepEqual([ids(p.smallEdge), ids(p.missedWin)], [['punish-edge'], ['punish-missed']]);
  for (const x of everywhere(p)) assert.equal(x.teachHeld, undefined);
  // The fallback pool (no plan) never serves a held card either.
  for (let n = 0; n < 8; n++) assert.ok(!fallbackPool(p.bySource, n).some(x => x.id === 'punish-1' || x.id === 'punish-3'));
});

test('pools 7.1: a stale or unknown held row is ignored and the card stays graded', () => {
  const v7 = build();
  const rows: Array<[string, TeachHeld]> = [
    ['a row for another answer', { id: 'punish-1', a: 'd1d4', why: 'not-unique', alt: 'd1d5' }],
    ['a reason this page does not know', { id: 'punish-1', a: 'd1d5', why: 'too-easy' }],
    ['a small-edge card', { id: 'punish-edge', a: 'd1d5', why: 'not-unique', alt: 'd1d4' }],
    ['a missed-win card', { id: 'punish-missed', a: 'd1d5', why: 'not-held' }],
    ['a mistake card', { id: 'pack-1', a: 'd1d5', why: 'not-unique', alt: 'd1d4' }],
    ['an id no card has', { id: 'punish-0', a: 'd1d5', why: 'not-unique', alt: 'd1d4' }],
  ];
  for (const [name, row] of rows) assert.deepEqual(build(teachOf([], [row])), v7, name);
  // A pack refresh changed the card's move: the old verdict no longer applies, and neither does the old entry.
  const moved = buildPools({ bank: [], endgames: [], personal: [], drills: [], pack: { ...pack(), punish: [punish('punish-1', 80, ['d1d4'])] as never }, teach: teachOf([threat('punish-1')], [{ id: 'punish-1', a: 'd1d5', why: 'not-unique', alt: 'd1d4' }]) });
  assert.deepEqual(ids(moved.own.filter(isPunish)), ['punish-1']);
  assert.deepEqual([moved.notUnique, moved.notHeld], [[], []]);
  assert.equal(moved.byId.get('punish-1')?.teach, undefined);
  assert.equal(moved.byId.get('punish-1')?.teachHeld, undefined);
});

test('pools 7.1: an id a pack card already took is dropped as in version 7, never listed as held', () => {
  const clash: LoadedPack = { ...pack(), cards: [base('same-id')] as never, punish: [punish('same-id', 80), punish('punish-2', 70)] as never };
  const input = { bank: [], endgames: [], personal: [], drills: [], pack: clash };
  const v7 = buildPools(input);
  assert.deepEqual(ids(v7.own), ['same-id', 'punish-2']);
  assert.equal(isPunish(v7.byId.get('same-id')), false, 'the pack card wins');
  const p = buildPools({ ...input, teach: teachOf([], [{ id: 'same-id', a: 'd1d5', why: 'not-unique', alt: 'd1d4' }]) });
  assert.deepEqual(p, v7);
});

test('pools 7.1: attempts stored for a held card stay in the history and do not break the progress rebuild', () => {
  const teach = teachOf([], [{ id: 'punish-1', a: 'd1d5', why: 'not-unique', alt: 'd1d4' }, { id: 'punish-3', a: 'd1d5', why: 'not-held' }]);
  const p = build(teach);
  const at = (puzzleId: string, t: number, ok: boolean) => ({ puzzleId, themes: ['quiet'], correct: ok, unassisted: ok, hints: 0, revealed: false, durationMs: 1, at: t });
  const DAY = 86_400_000;
  // He practised both cards under version 7, before they were held; a version 7 tab left open may add more.
  const attempts = [at('punish-1', 1000, false), at('punish-1', 2000, true), at('punish-3', 3000, true), at('pack-1', 4000, true), at('punish-2', 5000, false)];
  const progress = buildProgress(attempts, { rating: 1000, sessionLength: 10 }, t => t);
  assert.deepEqual(progress.attempts.map(a => a.puzzleId), ['punish-1', 'punish-1', 'punish-3', 'pack-1', 'punish-2'], 'every attempt is kept');
  assert.deepEqual([progress.cards['punish-1'].attempts, progress.cards['punish-1'].lapses, progress.cards['punish-3'].attempts], [2, 1, 1]);
  assert.equal(progress.skills.quiet.attempts, 5);
  // Their schedule entries are due, but nothing can serve them: they are in no pool.
  const now = 6000 + 400 * DAY;
  assert.ok(progress.cards['punish-1'].due < now && progress.cards['punish-3'].due < now);
  const due = todayPool(p.all, progress.cards, capState(dailyCounts(progress.attempts, now), { reviewCap: 20, newCap: 10 }), now);
  assert.ok(due.some(x => x.id === 'pack-1') && due.some(x => x.id === 'punish-2'));
  assert.ok(!due.some(x => x.id === 'punish-1' || x.id === 'punish-3'));
  // The same history over version 7's pools serves them, which shows the document is what holds them.
  const dueV7 = todayPool(build().all, progress.cards, capState(dailyCounts(progress.attempts, now), { reviewCap: 20, newCap: 10 }), now);
  assert.ok(dueV7.some(x => x.id === 'punish-1') && dueV7.some(x => x.id === 'punish-3'));
});
