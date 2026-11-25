import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildPack, readPack, loadPersonalPack, withThemePriors, practicePools, sanMoves, packDetailOf, cleanPriors, positionKey, STUB_PACK, PRIOR_MAX, PRIOR_MIN, type PersonalPack } from '../lib/personal-pack';
import { selectPuzzle, recordAttempt } from '../lib/scheduler.js';
import { newState } from '../lib/training-state';

const dir = path.join(process.cwd(), 'tests/fixtures/personal-pack');
const fixture = (name: string) => readFileSync(path.join(dir, name), 'utf8');
const build = (overrides: Partial<Parameters<typeof buildPack>[0]> = {}) => buildPack({ profile: JSON.parse(fixture('weakness_profile.json')), positions: fixture('mistake_positions.jsonl'), special: fixture('special_sets.jsonl'), importedAt: '2026-11-09T00:00:00Z', ...overrides });
const json = (body: string, type = 'application/json', status = 200) => async () => new Response(body, { status, headers: { 'content-type': type } });

test('the fixture builds a pack: only drillable rows become single-move cards with personal and phase themes', () => {
  const { pack, report } = build();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(pack.counts, { rows: 3, drillable: 2, notDrillable: 1, specialRows: 2, specialDrillable: 2, cards: 4, mergedRows: 0, stalemateCards: 1, conversionCards: 1, study: 1, warnings: 0 });
  const [opening, ending] = pack.cards;
  assert.match(opening.id, /^pack-[0-9a-f]{16}$/);
  assert.deepEqual(opening.moves, ['f3d4']);
  assert.deepEqual(opening.themes, ['personal', 'opening']);
  assert.equal(opening.pack.playedSan, 'Nxe5');
  assert.equal(opening.pack.bestSan, 'Nxd4');
  assert.deepEqual(opening.pack.refutationPvUci, ['d8g5', 'e5f7', 'g5g2']);
  assert.equal(opening.pack.moveSeconds, 4);
  assert.ok(!('extraProducerField' in opening.pack));
  assert.deepEqual(ending.themes, ['personal', 'endgame', 'pawnEndgame']);
  assert.equal(ending.pack.ownerColor, 'b');
  assert.deepEqual(pack.priors, { hangingPiece: 1.5, defensiveMove: 0.8 });
  assert.deepEqual(pack.cards.slice(2).map(c => [c.pack.sets, c.pack.outcome]), [[['stalemate'], undefined], [['conversion'], 'time']]);
  assert.match(opening.explanation, /^You played Nxe5\. The engine preferred Nxd4, and it stayed clearly best on a deeper check \(depth 18\)\. By the engine's estimate, your move lowered your winning chances by about \d+ points out of 100\.$/);
  assert.deepEqual(opening.pack.occurrences, [{ date: '2026-10-01', timeClass: 'rapid', gameUrl: 'https://www.chess.com/game/live/100000001', moveNumber: 4, playedSan: 'Nxe5' }]);
});

test('invalid rows stop the import unless explicitly skipped; illegal or inconsistent chess is caught', () => {
  const rows = fixture('mistake_positions.jsonl').trim().split('\n');
  const illegal = rows[2].replace('"bestUci":"e5d5"', '"bestUci":"e5e7"');
  assert.throws(() => build({ positions: [rows[0], illegal].join('\n') }), /1 invalid row/);
  const skipped = build({ positions: [rows[0], illegal].join('\n'), skipInvalid: true });
  assert.equal(skipped.pack.cards.filter(c => c.pack.sets.includes('mistake')).length, 1);
  assert.match(skipped.report.errors[0], /mistake_positions\.jsonl:2: bestUci e5e7 is illegal/);
  const wrongSide = rows[0].replace('"ownerColor":"w"', '"ownerColor":"b"');
  assert.throws(() => build({ positions: wrongSide }), /side to move differs/);
  assert.throws(() => build({ positions: [rows[0], rows[0]].join('\n') }), /duplicate id/);
  assert.throws(() => build({ positions: '{not json' }), /not valid JSON/);
  assert.throws(() => build({ positions: rows[0].replace('"timeClass":"rapid"', '"timeClass":"bullet"') }), /timeClass/);
  assert.throws(() => build({ profile: { schemaVersion: 2 } }), /weakness_profile\.json/);
});

test('readPack accepts a JSON round trip, returns null for the stub and rejects tampering', () => {
  const { pack } = build();
  assert.deepEqual(readPack(JSON.parse(JSON.stringify(pack))), pack);
  assert.equal(readPack(STUB_PACK), null);
  const tampered = JSON.parse(JSON.stringify(pack)) as PersonalPack;
  tampered.cards[0].moves = ['a1a8'];
  assert.throws(() => readPack(tampered), /illegal move/);
  assert.throws(() => readPack({ ...pack, kind: 'something-else' }));
  assert.throws(() => readPack({ ...pack, cards: [pack.cards[0], pack.cards[0]] }), /Duplicate/);
});

test('loading: a missing, stub, HTML or invalid response means no pack; a valid pack loads', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const { pack } = build();
    assert.equal(await loadPersonalPack(json('Not found', 'text/plain', 404)), null);
    assert.equal(await loadPersonalPack(json(JSON.stringify(STUB_PACK))), null);
    assert.equal(await loadPersonalPack(json('<!doctype html><title>App</title>', 'text/html')), null);
    assert.equal(await loadPersonalPack(json('{"kind":"next-move-personal-pack","installed":true}')), null);
    assert.equal(await loadPersonalPack(async () => { throw new TypeError('offline'); }), null);
    assert.deepEqual(await loadPersonalPack(json(JSON.stringify(pack))), pack);
  } finally { console.warn = warn; }
});

test('the installed pack file, when present, is the stub or a pack that loads (code review P1-3)', () => {
  // A public checkout leaves public/personal-pack/ out; a real import replaces the stub. Both are valid states.
  const file = path.join(process.cwd(), 'public/personal-pack/pack.json');
  if (!existsSync(file)) return;
  const installed = readPack(JSON.parse(readFileSync(file, 'utf8')));
  assert.ok(installed === null || installed.installed === true, 'readPack throws for anything else');
});

test('without priors selection is unchanged; a prior nudges new material and real attempts outweigh it', () => {
  const progress = newState().progress;
  assert.equal(withThemePriors(progress, null), progress);
  assert.equal(withThemePriors(progress, {}), progress);
  assert.equal(withThemePriors(progress, { fork: 1 }), progress);
  const bank = [
    { id: 'a-fork', fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', moves: ['e2e4'], rating: 1000, themes: ['fork'], gameUrl: '' },
    { id: 'b-hanging', fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', moves: ['e2e4'], rating: 1000, themes: ['hangingPiece'], gameUrl: '' },
  ];
  const now = 1_000_000;
  assert.equal(selectPuzzle(bank, progress, { now })!.id, 'a-fork');
  assert.equal(selectPuzzle(bank, withThemePriors(progress, { hangingPiece: 1.5 }), { now })!.id, 'b-hanging');
  // Twelve clean real attempts on other loose-piece puzzles outweigh the prior: the order returns to the no-prior order.
  let practised = progress;
  for (let i = 0; i < 12; i++) practised = recordAttempt(practised, { ...bank[1], id: `other-${i}` }, { correct: true, now: now - 100_000 + i });
  const view = withThemePriors(practised, { hangingPiece: 1.5 });
  assert.equal(selectPuzzle(bank, practised, { now })!.id, selectPuzzle(bank, view, { now })!.id);
  assert.equal(practised.skills.hangingPiece.attempts, 12, 'the stored skill row is not changed by the view');
  assert.equal(view.attempts, practised.attempts);
});

test('practice pools: no pack means the same pools as before; pack cards join own-game practice only', () => {
  const stored = [{ id: 'personal-1' }], bank = [{ id: 'bank-1' }, { id: 'bank-2' }], pack = [{ id: 'pack-1' }];
  const without = practicePools(stored, [], bank);
  assert.equal(without.all, without.mixed);
  assert.equal(without.own, stored);
  assert.deepEqual(without.all.map(p => p.id), ['personal-1', 'bank-1', 'bank-2']);
  const withPack = practicePools(stored, pack, bank);
  assert.deepEqual(withPack.all.map(p => p.id), ['personal-1', 'pack-1', 'bank-1', 'bank-2']);
  assert.deepEqual(withPack.mixed.map(p => p.id), ['personal-1', 'bank-1', 'bank-2']);
  assert.deepEqual(withPack.own.map(p => p.id), ['personal-1', 'pack-1']);
});

test('display helpers: SAN lines stop at the first illegal move; pack details only on pack cards', () => {
  assert.deepEqual(sanMoves('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', ['e2e4', 'e7e5', 'e1e3', 'g1f3']), ['e4', 'e5']);
  const { pack } = build();
  assert.deepEqual(packDetailOf(pack.cards[0])?.sets, ['mistake']);
  assert.equal(packDetailOf({ id: 'x', fen: '', moves: [], rating: 1000, themes: [], gameUrl: '' }), undefined);
});

const lines = (name: string) => fixture(name).trim().split('\n');
const withId = (row: string, id: string, game: string, date: string) => row.replace(/"id":"[^"]+"/, `"id":"${id}"`).replace(/"gameUrl":"[^"]+"/, `"gameUrl":"https://www.chess.com/game/live/${game}"`).replace(/"date":"[^"]+"/, `"date":"${date}"`);

test('one card per position: repeats across games and sets merge, ids are stable, and the same id in both special sets imports (review R2, code review P1-2, P1-4, P2-11)', () => {
  const [mistake] = lines('mistake_positions.jsonl');
  const [stalemate] = lines('special_sets.jsonl');
  const repeat = withId(mistake, '100000009:7', '100000009', '2026-10-09').replace(' 4 4"', ' 3 9"');
  assert.notEqual(repeat, mistake);
  const conversionOfMistake = withId(mistake, '100000001:7', '100000001', '2026-10-01').replace(/}$/, ',"set":"conversion","outcome":"mated"}');
  const conversionOfStalemate = stalemate.replace('"set":"stalemate"', '"set":"conversion","outcome":"other"');
  const { pack, report } = build({ positions: [mistake, repeat].join('\n'), special: [stalemate, conversionOfMistake, conversionOfStalemate].join('\n') });
  assert.deepEqual(report.errors, []);
  assert.equal(pack.cards.length, 2, 'two distinct positions');
  assert.equal(pack.counts.mergedRows, 3);
  assert.equal(new Set(pack.cards.map(c => positionKey(c.fen))).size, pack.cards.length);
  const opening = pack.cards.find(c => c.pack.sets.includes('mistake'))!;
  assert.deepEqual(opening.pack.sets, ['mistake', 'conversion']);
  assert.equal(opening.pack.outcome, 'mated');
  assert.deepEqual(opening.pack.occurrences.map(o => o.date), ['2026-10-09', '2026-10-01'], 'every game, newest first');
  const ending = pack.cards.find(c => c.pack.sets.includes('stalemate'))!;
  assert.deepEqual(ending.pack.sets, ['stalemate', 'conversion']);
  // Stable ids: the card id depends on the position and move only, not on which rows are drillable in a run.
  const alone = build({ positions: mistake, special: '' }).pack.cards[0];
  assert.equal(alone.id, opening.id);
  assert.ok(pools(pack).own.length === 2);
});
const pools = (pack: PersonalPack) => practicePools([], pack.cards, []);

test('stalemate rows become unscored study items, drillable or not; a row whose move is not stalemate is refused', () => {
  const [stalemate] = lines('special_sets.jsonl');
  const notDrillable = withId(stalemate, '100000008:119', '100000008', '2026-10-08').replace('"drillable":true', '"drillable":false');
  const twin = build({ special: notDrillable }).pack;
  assert.equal(twin.study.length, 1);
  assert.equal(twin.cards.filter(c => c.pack.sets.includes('stalemate')).length, 0, 'not drillable: no graded card');
  const [item] = twin.study;
  assert.match(item.id, /^study-[0-9a-f]{16}$/);
  assert.deepEqual([item.playedSan, item.bestSan, item.date], ['Qg6', 'Qg7#', '2026-10-08']);
  assert.ok(!practicePools([], twin.cards, []).all.some(p => p.id === item.id), 'study items never reach practice pools');
  const notStalemate = stalemate.replace('"playedUci":"g1g6"', '"playedUci":"g1g2"').replace('"playedSan":"Qg6"', '"playedSan":"Qg2"');
  assert.throws(() => build({ special: notStalemate }), /does not give stalemate/);
  const tampered = JSON.parse(JSON.stringify(twin)) as PersonalPack;
  tampered.study[0].playedUci = 'g1g2';
  assert.throws(() => readPack(tampered), /does not match its moves/);
});

test('theme priors: the producer range 0.5-2.5 is kept, its order survives, metadata themes are dropped (review R4, code review P2-9)', () => {
  assert.deepEqual(cleanPriors({ hangingPiece: 2.5, fork: 1.88, pin: 9, skewer: 0.1, equality: 0.5, rookEndgame: 1, short: 2 }), { hangingPiece: 2.5, fork: 1.88, pin: PRIOR_MAX, skewer: PRIOR_MIN });
  const progress = newState().progress;
  assert.equal(withThemePriors(progress, { equality: 0.5 }), progress, 'a metadata theme has no effect, so no view is made');
  const rate = (w: number) => { const s = withThemePriors(progress, { fork: w }).skills.fork; return 1 - s.successes / s.attempts; };
  assert.ok(Math.abs(rate(1.0001) - 0.5) < 1e-3, 'w = 1 is neutral');
  assert.ok(Math.abs(rate(2.5) - 2.5 / 3.5) < 1e-9);
  assert.ok(Math.abs(rate(0.5) - 1 / 3) < 1e-9);
  assert.equal(rate(10), rate(2.5), 'clamped at the top');
  assert.ok(rate(2.5) > rate(1.88) && rate(1.88) > rate(1.5) && rate(0.8) > rate(0.5), 'the producer order is kept (the old clamp tied 2.5 and 1.88)');
  for (const w of [0.5, 2.5, 10]) assert.ok(rate(w) > 0 && rate(w) < 1, 'never a negative pseudo-success');
});

test('a top-weight prior stops changing selection after twelve clean attempts on that theme', () => {
  const bank = [
    { id: 'a-fork', fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', moves: ['e2e4'], rating: 1000, themes: ['fork'], gameUrl: '' },
    { id: 'b-hanging', fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', moves: ['e2e4'], rating: 1000, themes: ['hangingPiece'], gameUrl: '' },
  ];
  const now = 1_000_000;
  let practised = newState().progress;
  assert.equal(selectPuzzle(bank, withThemePriors(practised, { hangingPiece: 2.5 }), { now })!.id, 'b-hanging');
  for (let i = 0; i < 12; i++) practised = recordAttempt(practised, { ...bank[1], id: `other-${i}` }, { correct: true, now: now - 100_000 + i });
  assert.equal(selectPuzzle(bank, withThemePriors(practised, { hangingPiece: 2.5 }), { now })!.id, selectPuzzle(bank, practised, { now })!.id);
});
