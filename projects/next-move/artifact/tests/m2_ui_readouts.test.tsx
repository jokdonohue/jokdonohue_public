import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFakeStore, createMemoryKv } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { createTrainerModel } from '../components/model';
import { openingRows, rangesOverlap, transferView } from '../components/insights';
import { OpeningAccidents, TransferCard } from '../components/GameReadouts';
import { readDoc, type OpeningsDoc, type TransferDoc } from '../src/contract/docs';
import { HAVE_SEED_M2, loadSeedDocs, SEED_M2_DIR } from './m2_ui_seed';

// Invented openings, rates and windows only.
const openings = {
  groups: [
    { opening: 'Example Gambit', color: 'w', games: 40, earlyBlunderRate: 0.5, ci95: [0.62, 0.38], cardIds: ['pack-a:1', 'pack-a:2', 'pack-gone:9'] },
    { opening: 'Sample Defence', color: 'b', games: 120, earlyBlunderRate: 0.61, ci95: [0.52, 0.7], cardIds: ['pack-b:1'] },
    { opening: 'Tiny Line', color: 'b', games: 12, earlyBlunderRate: 0.9, fewGames: true, cardIds: [] },
    { opening: 'Edge Case', color: 'w', games: 29, earlyBlunderRate: 0.95, cardIds: ['pack-c:1'] },
  ],
  archiveContext: [{ label: '1.e4 e5', color: 'b', games: 300, scorePct: 47.2, source: 'invented' }, { label: 'bad row' }],
} as unknown as OpeningsDoc;

test('D8 rows: ranked by early-blunder rate (30+ games), then the few-games group; ranges ordered; context rows parsed', () => {
  const { ranked, few, context } = openingRows(openings);
  assert.deepEqual(ranked.map(r => r.opening), ['Sample Defence', 'Example Gambit']);
  assert.deepEqual(ranked[1].ci, [0.38, 0.62]);
  assert.deepEqual(few.map(r => r.opening), ['Edge Case', 'Tiny Line'], 'under 30 games is never ranked, flagged or not');
  assert.deepEqual(context, [{ label: '1.e4 e5', color: 'b', games: 300, scorePct: 47.2 }]);
  assert.deepEqual(openingRows(null), { ranked: [], few: [], context: [] });
});

test('D8 render: rate with its range and games; practise only the positions that exist; few games collapsed; context marked no engine', () => {
  const have = new Set(['pack-a:1', 'pack-a:2', 'pack-b:1']);
  let got: string[] = [];
  const html = renderToStaticMarkup(<OpeningAccidents doc={openings} isAvailable={id => have.has(id)} onPractise={(_r, ids) => { got = ids; }}/>);
  assert.match(html, /Opening accidents/);
  assert.ok(html.indexOf('Sample Defence') < html.indexOf('Example Gambit'));
  assert.match(html, /61%.*range 52–70%/s);
  assert.match(html, /as White · 40 games/);
  assert.match(html, /Practise these 2 positions/);
  assert.match(html, /Practise these 1 position</);
  assert.match(html, /<details class="opening-few"><summary>Few games \(2 openings under 30 games\)/);
  assert.match(html, /no engine, for context only/);
  assert.match(html, /1\.e4 e5 as Black: you scored 47% over 300 games/);
  assert.match(html, /outside today’s limits/);
  assert.equal(got.length, 0);
  assert.equal(renderToStaticMarkup(<OpeningAccidents doc={null} isAvailable={() => true} onPractise={() => undefined}/>), '');
});

const point = (at: string, b: number, lo: number, hi: number, nw: number, nlo: number, nhi: number) =>
  ({ at, games: 500, window: '2100-01-01..2100-06-30', blundersPer100: b, ci95: [lo, hi], convNotWonPct: nw, convCi95: [nlo, nhi], onTimeShare: 0.4 });

test('D9 one point: the numbers, ranges, window and games; no trend; the next refresh adds a point', () => {
  const doc = { points: [point('2100-07-01T00:00:00Z', 7.5, 7.1, 7.9, 30, 27, 33)] } as TransferDoc;
  const html = renderToStaticMarkup(<TransferCard doc={doc}/>);
  assert.match(html, /In your real games/);
  assert.match(html, /2100-01-01 to 2100-06-30 \(500 games\)/);
  assert.match(html, /7\.5<\/strong><span>blunders per 100 of your moves/);
  assert.match(html, /range 7\.1–7\.9/);
  assert.match(html, /30%<\/strong>/);
  assert.match(html, /range 27–33%/);
  assert.match(html, /next refresh of your games adds a second point/);
  assert.doesNotMatch(html, /<svg/);
  assert.equal(renderToStaticMarkup(<TransferCard doc={null}/>), '');
});

test('D9 two points: a small SVG trend per measure; overlap says "no clear change yet"; windows overlap is said', () => {
  const overlapping = { points: [point('2100-07-01T00:00:00Z', 7.5, 7.1, 7.9, 30, 27, 33), point('2100-08-01T00:00:00Z', 7.2, 6.8, 7.6, 20, 17, 23)] } as TransferDoc;
  const v = transferView(overlapping);
  assert.equal(v.blundersClear, false);
  assert.equal(v.notWonClear, true);
  const html = renderToStaticMarkup(<TransferCard doc={overlapping}/>);
  assert.equal((html.match(/<svg class="trend"/g) ?? []).length, 2, 'two charts, never two scales on one');
  assert.equal((html.match(/<circle/g) ?? []).length, 4);
  assert.match(html, /No clear change yet: the last two ranges overlap/);
  assert.match(html, /this looks like a real change/);
  assert.match(html, /the windows overlap/);
  assert.equal(rangesOverlap([1, 2], [2, 3]), true);
  assert.equal(rangesOverlap([1, 2], [2.1, 3]), false);
});

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
test('model: openings and transfer load when valid; an invalid one is skipped and listed, never a banner', async () => {
  const store = createFakeStore({ seed: { 'openings/accidents': openings as never, 'transfer/history': { points: [{ at: 1 }] } } });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'd1', events: null, debounceMs: 1 });
  const m = createTrainerModel({ store, sessions, deviceId: 'd1', readyTimeoutMs: 500 });
  await tick(30);
  assert.equal(m.get().openings?.groups.length, 4);
  assert.equal(m.get().transfer, null);
  assert.deepEqual(m.get().docErrors.map(e => e.path), ['transfer/history']);
  assert.equal(m.get().error, '');
  m.dispose(); sessions.dispose();
});

test('seed_m2 read-outs parse and render (counts only)', { skip: !HAVE_SEED_M2 }, () => {
  const docs = Object.fromEntries(loadSeedDocs(SEED_M2_DIR).map(d => [d.path, d.data]));
  const o = readDoc<OpeningsDoc>('openings/accidents', docs['openings/accidents']);
  const t = readDoc<TransferDoc>('transfer/history', docs['transfer/history']);
  assert.ok(o && t);
  const rows = openingRows(o);
  assert.ok(rows.ranked.length > 0 && rows.ranked.every(r => r.games >= 30));
  for (let i = 1; i < rows.ranked.length; i++) assert.ok(rows.ranked[i - 1].rate >= rows.ranked[i].rate);
  assert.ok(transferView(t).points.length >= 1);
  assert.ok(renderToStaticMarkup(<TransferCard doc={t}/>).includes('In your real games'));
  console.log(`seed_m2 read-outs: ${rows.ranked.length} ranked, ${rows.few.length} few, ${rows.context.length} context, ${t.points.length} transfer point(s)`);
});
