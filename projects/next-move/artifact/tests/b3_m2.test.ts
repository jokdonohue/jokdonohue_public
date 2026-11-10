import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Chess } from 'chess.js';
import { buildSafeCards, quotas, SAFE_PRESHOW_FIELDS, type GameInfo, type JudgedMove, type RowLines } from '../src/importers/safeDocs';
import { buildOpeningAccidents, parseArchiveContext, readArchiveRows, wilson, MIN_RANKED_GAMES } from '../src/importers/openingsDocs';
import { appendTransferPoint, transferPoint } from '../src/importers/transferDocs';
import { buildM2Docs } from '../src/importers/m2Docs';
import { buildPackDocs, previousIdsFromDocs } from '../src/importers/packDocs';
import { docBytes, MAX_DOC_BYTES, readDoc, packChunkIds, type PackMetaDoc } from '../src/contract/docs';
import { PROFILE, jsonl, rng, syntheticRows } from './b3_fixtures';
import { PROFILE_DIR, SEED_DIR, SEED_INPUTS_DIR } from './b3_paths';

/** Synthetic engine cache: random games (White = owner), every owner move judged. */
function syntheticCache(nGames: number, seed = 1) {
  const rand = rng(seed);
  const games = new Map<string, GameInfo>(), moves: JudgedMove[] = [], rows = new Map<string, RowLines>();
  for (let gi = 0; gi < nGames; gi++) {
    const g = String(500000 + gi), board = new Chess(), fens = [board.fen()], ucis: string[] = [];
    for (let ply = 0; ply < 60 && !board.isGameOver(); ply++) {
      const legal = board.moves({ verbose: true });
      const m = legal[Math.floor(rand() * legal.length)];
      board.move(m); ucis.push(m.from + m.to + (m.promotion ?? '')); fens.push(board.fen());
    }
    games.set(g, { url: `https://www.chess.com/game/live/${g}`, date: '2026-10-01', timeClass: 'rapid', ownerColor: 'w', fens });
    for (let p = 1; p <= ucis.length; p += 2) {
      const fen = fens[p - 1], legal = new Chess(fen).moves({ verbose: true });
      const other = legal.find(x => x.from + x.to + (x.promotion ?? '') !== ucis[p - 1]);
      const blunder = rand() < 0.3;
      const ph = p < 20 ? 'opening' : p < 40 ? 'middlegame' : 'endgame';
      const bm = blunder && other ? other.from + other.to + (other.promotion ?? '') : ucis[p - 1];
      moves.push({ g, p, mn: Math.ceil(p / 2), ph, j: blunder ? 'blunder' : null, wb: rand() < 0.15 ? 90 : 50, wa: blunder ? 20 : 48.7, drop: blunder ? 30 : 0.5, bm, pu: ucis[p - 1], best: !blunder, mate: false, sec: 3 });
      if (blunder) rows.set(`${g}:${p}`, { pvUci: [bm], refutationPvUci: ucis[p] ? [ucis[p]] : [] });
    }
  }
  return { games, moves, rows };
}

test('safe or not: deterministic, half and half overall and in every phase', () => {
  const c = syntheticCache(40, 3);
  const a = buildSafeCards({ ...c, perHalf: 60 }), b = buildSafeCards({ ...c, perHalf: 60 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.counts.safeCards, a.counts.unsafeCards);
  assert.ok(a.counts.safeCards > 10);
  for (const ph of ['opening', 'middlegame', 'endgame']) {
    const n = (v: string) => a.cards.filter(x => x.kind === v && (x.themes as string[])[2] === ph).length;
    assert.equal(n('safe'), n('unsafe'), ph);
  }
  // The halves are interleaved, not grouped by verdict.
  const firstTen = a.cards.slice(0, 10).map(x => x.kind);
  assert.ok(firstTen.includes('safe') && firstTen.includes('unsafe'));
});

test('safe or not: no leakage of the answer in the fields shown before judging', () => {
  const { cards } = buildSafeCards({ ...syntheticCache(40, 5), perHalf: 80 });
  const shape = (c: Record<string, unknown>) => JSON.stringify(SAFE_PRESHOW_FIELDS.map(k => [k, typeof c[k], Array.isArray(c[k]) ? (c[k] as unknown[]).length : null]));
  const shapes = new Set(cards.map(shape));
  assert.equal(shapes.size, 1, 'same field set and shape for both halves');
  for (const c of cards) {
    const shown = JSON.stringify(Object.fromEntries(SAFE_PRESHOW_FIELDS.map(k => [k, c[k]])));
    assert.doesNotMatch(shown, /safe\b(?! or not)|unsafe|blunder|mistake|winBefore|drop|engine|chess\.com/i, String(c.id));
    assert.match(String(c.id), /^judge-\d+:\d+$/);
    assert.match(String(c.title), /^Safe or not\? · Rapid · \d{4}-\d{2}-\d{2} · move \d+$/);
    assert.deepEqual((c.themes as string[]).slice(0, 2), ['personal', 'safety']);
    assert.deepEqual(Object.keys(c.question as object).sort(), ['playedSan', 'playedUci', 'side']);
    assert.equal((c.moves as string[])[0], (c.question as { playedUci: string }).playedUci);
    assert.equal(c.gameUrl, undefined, 'the game link (which shows the outcome) is only in reveal');
    assert.equal(c.explanation, undefined);
    const reveal = c.reveal as { verdict: string; explanation: string };
    assert.equal(reveal.verdict, c.kind);
    assert.match(reveal.explanation, c.kind === 'safe' ? /^Safe\./ : /^Not safe\./);
  }
});

test('safe or not: blunders he also drills as pack cards are used last', () => {
  const c = syntheticCache(40, 3);
  const plain = buildSafeCards({ ...c, perHalf: 20 });
  const familiar = new Set(plain.cards.filter(x => x.kind === 'unsafe').map(x => String(x.id).slice('judge-'.length)));
  const avoided = buildSafeCards({ ...c, perHalf: 20, familiar });
  assert.equal(avoided.counts.unsafeAlsoInPack, 0);
  assert.equal(avoided.counts.unsafeCards, avoided.counts.safeCards);
});

test('safe or not: level positions only, no repeated positions, cap split by phase', () => {
  const c = syntheticCache(30, 9);
  const { cards, counts } = buildSafeCards({ ...c, perHalf: 1000 });
  const byId = new Map(c.moves.map(m => [`judge-${m.g}:${m.p}`, m]));
  for (const card of cards) { const m = byId.get(String(card.id))!; assert.ok(m.wb >= 30 && m.wb <= 70); }
  assert.ok(!cards.some(card => String(card.id).endsWith(':1')), 'the start position occurs in every game');
  assert.ok(counts.skipped_repeated > 0 && counts.skipped_band > 0);
  assert.deepEqual(quotas({ opening: 50, middlegame: 30, endgame: 20 }, 10), { opening: 5, middlegame: 3, endgame: 2 });
  assert.deepEqual(quotas({ opening: 3, middlegame: 2, endgame: 0 }, 10), { opening: 3, middlegame: 2, endgame: 0 });
});

test('opening accidents: 30-game minimum, Wilson interval over games, archive scores as context only', () => {
  assert.deepEqual(wilson(23, 61), [0.2661, 0.5025], 'Wilson 95% interval, computed independently for 23 of 61');
  const profile = { ...PROFILE, openings: [
    { name: 'Alpha', color: 'w', games: 40, scorePct: 50, earlyBlunderRate: 0.5 },
    { name: 'Beta', color: 'b', games: 100, scorePct: 50, earlyBlunderRate: 0.6, earlyBlunderCi95: [0.5, 0.64] },
    { name: 'Gamma', color: 'w', games: 12, scorePct: 50, earlyBlunderRate: 0.9 },
  ] };
  const gameFamily = new Map([['11', { family: 'Alpha', color: 'w' as const }], ['12', { family: 'Gamma', color: 'w' as const }]]);
  const rows = [
    { id: '11:3', judgement: 'blunder', moveNumber: 2 }, { id: '11:41', judgement: 'blunder', moveNumber: 21 },
    { id: '11:7', judgement: 'inaccuracy', moveNumber: 4 }, { id: '12:5', judgement: 'mistake', moveNumber: 3 },
  ];
  // Synthetic archive summary and rows (the real rows are a git-ignored generation input).
  const md = '## 8. Openings\n**As white, lowest score (families with ≥30 games)**\n\n| family | games | W | D | L | score |\n|---|---|---|---|---|---|\n| Alpha Gambit | 61 | 23 | 4 | 34 | 41.0% |\n| Beta Defence | 143 | 64 | 7 | 72 | 46.3% |\n\n**As Black: their first move and your reply**\n\n| moves | games | W | D | L | score |\n|---|---|---|---|---|---|\n| 1.c4 e6 | 227 | 113 | 8 | 111 | 52.8% |\nFetched from 2019-02-03 to 2025-06-07.';
  const archiveRows = readArchiveRows([
    { label: '1.c4 e6', color: 'b', table: 'As Black: their first move and your reply' },
    { label: 'Beta Defence', color: 'w', table: 'As white, lowest score' },
    { label: 'Alpha Gambit', color: 'w', table: 'As white, lowest score' },
  ]);
  assert.throws(() => readArchiveRows([{ label: 'x', color: 'g', table: 't' }]), /color/);
  const ctx = parseArchiveContext(md, archiveRows);
  assert.deepEqual(ctx.map(c => [c.label, c.color, c.games, c.scorePct]), [['1.c4 e6', 'b', 227, 52.8], ['Beta Defence', 'w', 143, 46.3], ['Alpha Gambit', 'w', 61, 41]]);
  assert.deepEqual(parseArchiveContext(md, []), [], 'no rows given, no context');
  assert.ok(ctx[0].source.includes('2019-02-03 to 2025-06-07'));
  assert.ok(ctx.every(c => c.source.includes('SUMMARY.md') && c.source.includes('no engine')));
  const doc = buildOpeningAccidents({ profile, rows, gameFamily, cardFor: new Map([['11:3', 'pack-11:3'], ['12:5', 'pack-12:5']]), archiveContext: ctx, at: PROFILE.generatedAt });
  const groups = doc.groups as Array<{ opening: string; rank: number | null; fewGames: boolean; ci95: number[]; cardIds: string[]; mistakesFirst12: number }>;
  assert.deepEqual(groups.map(g => [g.opening, g.rank, g.fewGames]), [['Beta', 1, false], ['Alpha', 2, false], ['Gamma', null, true]]);
  assert.deepEqual(groups[1].ci95, wilson(20, 40));
  assert.deepEqual(groups[1].cardIds, ['pack-11:3'], 'moves 1-12 only, mistakes and blunders only');
  assert.equal(groups[2].mistakesFirst12, 1);
  const without = buildOpeningAccidents({ profile, rows, gameFamily, cardFor: new Map(), archiveContext: [], at: PROFILE.generatedAt });
  assert.deepEqual((without.groups as Array<{ opening: string }>).map(g => g.opening), groups.map(g => g.opening), 'context never changes the ranking');
  assert.equal(MIN_RANKED_GAMES, 30);
  assert.notEqual(readDoc('openings/accidents', doc), null);
});

test('transfer history: first point from the pass; a refresh appends, a rerun replaces its own point', () => {
  const profile = { ...PROFILE, overall: { blundersPer100: 6.13, ci95: [5.72, 6.61] }, conversion: { gamesWinningBy3: 437, notWon: 97, notWonShare: 0.2354, notWonShareCi95: [0.1972, 0.2786], byOutcome: { time: 41, mated: 30, other: 26 } } };
  const p1 = transferPoint(profile, { packVersion: 'p1', at: '2026-11-10T00:00:00Z' });
  assert.deepEqual([p1.blundersPer100, p1.ci95, p1.convNotWonPct, p1.convCi95, p1.onTimeShare], [6.13, [5.72, 6.61], 23.54, [19.72, 27.86], 0.4227]);
  const doc1 = appendTransferPoint(null, p1);
  assert.notEqual(readDoc('transfer/history', doc1), null);
  const again = appendTransferPoint(doc1 as { points: Array<Record<string, unknown>> }, p1);
  assert.equal((again.points as unknown[]).length, 1, 'idempotent per packVersion');
  const p2 = transferPoint(profile, { packVersion: 'p2', at: '2026-11-17T00:00:00Z' });
  const doc2 = appendTransferPoint(again as { points: Array<Record<string, unknown>> }, p2);
  assert.deepEqual((doc2.points as Array<{ packVersion: string }>).map(p => p.packVersion), ['p1', 'p2']);
});

test('M2 docs pass the contract and the size limit; pack/meta keeps the M1 chunks and adds the safe ones', () => {
  const pack = buildPackDocs({ profile: PROFILE, positions: jsonl(syntheticRows(20, { seed: 4 })), special: '' });
  const c = syntheticCache(20, 2);
  const profile = { ...PROFILE, openings: [], conversion: { gamesWinningBy3: 10, notWon: 4, notWonShare: 0.4, notWonShareCi95: [0.17, 0.66], byOutcome: { time: 2, mated: 1, other: 1 } }, overall: { blundersPer100: 6.13, ci95: [5.72, 6.61] } };
  const out = buildM2Docs({ pack, profile, ...c, rowLines: c.rows, openingRows: [], gameFamily: new Map(), at: PROFILE.generatedAt, perHalf: 30 });
  assert.equal(out.docs[out.docs.length - 1].path, 'pack/meta', 'meta last');
  for (const d of out.docs) { assert.ok(docBytes(d.data) <= MAX_DOC_BYTES); assert.notEqual(readDoc(d.path, d.data), null, d.path); }
  const meta = readDoc<PackMetaDoc>('pack/meta', out.docs[out.docs.length - 1].data)!;
  const m1 = readDoc<PackMetaDoc>('pack/meta', pack.docs[pack.docs.length - 1].data)!;
  assert.deepEqual(meta.chunks.cards, m1.chunks.cards);
  assert.equal(meta.packVersion, m1.packVersion);
  assert.ok((meta.chunks.safe ?? []).length >= 1);
  assert.deepEqual(packChunkIds(meta).filter(id => id.includes('-safe-')), meta.chunks.safe);
  // A snapshot holding safe chunks must not feed judge-* ids into the pack's previousIds.
  const prev = previousIdsFromDocs(out.docs.filter(d => d.path !== 'pack/meta' && d.path.startsWith('pack/')).map(d => d.data).concat(pack.docs.slice(0, -1).map(d => d.data)));
  assert.ok(Object.values(prev).every(id => !id.startsWith('judge-')));
});

const SRC = PROFILE_DIR;
test('real cache: M2 dry run is balanced and fits (counts only)', { skip: !existsSync(join(SRC, 'cache/final_moves.jsonl')) }, () => {
  const cwd = resolve(import.meta.dirname ?? '.', '..');
  const text = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/pack-to-docs.mjs', '--m2', '--check', '--src', SRC, '--archive-rows', join(SEED_INPUTS_DIR, 'archive_context.json')], { cwd, encoding: 'utf8', maxBuffer: 4 << 20 });
  const m2 = JSON.parse(/^m2: (.*)$/m.exec(text)![1]);
  const packCounts = JSON.parse(/^pack \S+: (.*)$/m.exec(text)![1]);
  // Expected counts come from the seed's own pack/meta at run time (no personal number in this file).
  const metaFile = join(SEED_DIR, 'pack', 'meta.json');
  if (existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { counts: Record<string, number> };
    assert.equal(packCounts.punish + packCounts.punishStudy, meta.counts.punish + meta.counts.punishStudy, 'every punish position is graded or study');
    assert.equal(packCounts.cards, meta.counts.cards);
  }
  assert.ok(packCounts.punish > 0 && packCounts.punishStudy_no_eval === 0, 'the engine cache grades them');
  assert.equal(m2.safeCards, m2.unsafeCards);
  assert.equal(m2.safeCards, 300);
  const rowsFile = join(SEED_INPUTS_DIR, 'archive_context.json');
  assert.equal(m2.archiveContext, existsSync(rowsFile) ? (JSON.parse(readFileSync(rowsFile, 'utf8')) as unknown[]).length : 0);
  const largest = Number(/largest (\d+) bytes/.exec(text)![1]);
  assert.ok(largest <= MAX_DOC_BYTES);
  console.log(`real m2: ${m2.safeCards}+${m2.unsafeCards} safe-or-not cards, ${m2.openingGroups} opening groups, largest doc ${largest} bytes`);
});
