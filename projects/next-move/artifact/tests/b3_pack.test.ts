import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildPackDocs, previousIdsFromDocs, siteCardId, positionKey, punishGrade, afterEvalFromCache, fenAfter, lineWin, type AfterEval, type Row } from '../src/importers/packDocs';
import { buildSeedDocs, buildSampleDrills, SAMPLE_DRILL_SET } from '../src/importers/seedDocs';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { docBytes, MAX_DOC_BYTES, packChunkIds, readDoc, schemaForPath, type PackMetaDoc } from '../src/contract/docs';
import { PROFILE, STALEMATE_ROW, jsonl, rowAt, syntheticRows } from './b3_fixtures';
import { PROFILE_DIR } from './b3_paths';

const cardsOf = (out: ReturnType<typeof buildPackDocs>) => out.docs.filter(d => d.path !== 'pack/meta').flatMap(d => d.data.cards as Array<Record<string, unknown>>);
const metaOf = (out: ReturnType<typeof buildPackDocs>) => out.docs[out.docs.length - 1];

test('pack-to-docs is deterministic: same input, byte-identical documents', () => {
  const rows = syntheticRows(60, { seed: 7 });
  const input = { profile: PROFILE, positions: jsonl(rows), special: jsonl([STALEMATE_ROW]) };
  const a = buildPackDocs(input), b = buildPackDocs(input);
  assert.equal(JSON.stringify(a.docs), JSON.stringify(b.docs));
  assert.match(a.packVersion, /^p20261110-[0-9a-f]{8}$/);
  assert.equal(metaOf(a).data.importedAt, PROFILE.generatedAt, 'no wall clock');
});

test('card ids derive from producer row ids; punish and study use their own namespaces; all unique', () => {
  const rows = syntheticRows(40, { seed: 3 });
  const out = buildPackDocs({ profile: PROFILE, positions: jsonl(rows), special: jsonl([STALEMATE_ROW]), afterEvals: evalsFor(rows) });
  const cards = cardsOf(out);
  const study = out.docs.flatMap(d => (d.data.study as Array<{ id: string; set: string }> | undefined) ?? []).filter(s => s.set === 'stalemate');
  const ids = [...cards.map(c => String(c.id)), ...study.map(s => s.id)];
  assert.equal(new Set(ids).size, ids.length);
  const rowIds = new Set(rows.map(r => r.id));
  for (const c of cards) {
    const m = /^(pack|punish)-(\d+:\d+)$/.exec(String(c.id));
    assert.ok(m, `id ${c.id}`);
    assert.ok(rowIds.has(m![2]));
    assert.equal(c.kind === 'punish', m![1] === 'punish');
  }
  assert.deepEqual(study.map(s => s.id), ['study-731:75']);
  const first = cards.find(c => c.id === `pack-${rows[0].id}`)!;
  assert.equal(first.siteId, siteCardId(String(rows[0].fen), String(rows[0].bestUci)), 'siteId maps to the Site loader id');
  assert.equal(out.counts.punish, cards.filter(c => c.kind === 'punish').length);
});

test('ids are stable across a refresh that adds newer games, including one reaching an existing position', () => {
  const old = syntheticRows(30, { seed: 11, date: '2026-10-01' });
  const before = buildPackDocs({ profile: PROFILE, positions: jsonl(old), special: '' });
  // A newer game reaches the position of old[5]; newer rows go on top, as the producer orders them.
  const repeat = rowAt({ gameId: 999999, ply: Number(String(old[5].id).split(':')[1]), date: '2026-11-07', fen: String(old[5].fen) })!;
  const fresh = syntheticRows(10, { seed: 99, date: '2026-11-08', firstGame: 900000 });
  const after = buildPackDocs({ profile: PROFILE, positions: jsonl([...fresh, repeat, ...old]), special: '' });
  const idsBefore = new Map(cardsOf(before).map(c => [`${c.kind}|${c.fen}`, c.id]));
  const idsAfter = new Map(cardsOf(after).map(c => [`${c.kind}|${c.fen}`, c.id]));
  for (const [k, id] of idsBefore) assert.equal(idsAfter.get(k), id, `id changed for ${k}`);
  const merged = cardsOf(after).find(c => c.id === `pack-${old[5].id}`)!;
  assert.deepEqual(merged.aliases, ['mistake:999999:' + String(old[5].id).split(':')[1]]);
  assert.equal((merged.pack as { occurrences: unknown[] }).occurrences.length, 2);
  assert.notEqual(before.packVersion, after.packVersion);
});

test('sliding sample: when a merged position loses its oldest row, previousIds keep the id (the oldest-row rule alone would rename)', () => {
  const rows = syntheticRows(12, { seed: 31, date: '2026-10-01' });
  const newer = rowAt({ gameId: 888888, ply: 7, date: '2026-10-20', fen: String(rows[4].fen) })!;
  const first = buildPackDocs({ profile: PROFILE, positions: jsonl([newer, ...rows]), special: '' });
  const canonical = `pack-${rows[4].id}`;
  assert.ok(cardsOf(first).some(c => c.id === canonical));
  // Next refresh: rows[4]'s game has left the most-recent-N sample; the newer row remains.
  const remaining = [newer, ...rows.filter((_, i) => i !== 4)];
  const without = buildPackDocs({ profile: PROFILE, positions: jsonl(remaining), special: '' });
  assert.ok(cardsOf(without).some(c => c.id === 'pack-888888:7'), 'renamed without --prev');
  // A snapshot file may wrap the body as {data}; previousIdsFromDocs accepts both.
  const snapshotFiles = first.docs.filter(d => d.path !== 'pack/meta').map((d, i) => (i % 2 ? { data: d.data, version: 3 } : d.data));
  const prev = previousIdsFromDocs(snapshotFiles);
  assert.equal(Object.keys(prev).length, first.counts.cards + first.counts.punish + first.counts.punishStudy);
  const withPrev = buildPackDocs({ profile: PROFILE, positions: jsonl(remaining), special: '', previousIds: prev });
  assert.ok(cardsOf(withPrev).some(c => c.id === canonical), 'kept with --prev');
  assert.ok(!cardsOf(withPrev).some(c => c.id === 'pack-888888:7'));
});

test('previousIds keep an issued id even when an older row joins the position', () => {
  const rows = syntheticRows(20, { seed: 5, date: '2026-10-01' });
  const first = buildPackDocs({ profile: PROFILE, positions: jsonl(rows), special: '' });
  const prev = previousIdsFromDocs(first.docs.filter(d => d.path !== 'pack/meta').map(d => d.data));
  const older = rowAt({ gameId: 1, ply: 9, date: '2020-01-01', fen: String(rows[2].fen) })!;
  const without = buildPackDocs({ profile: PROFILE, positions: jsonl([...rows, older]), special: '' });
  assert.ok(cardsOf(without).some(c => c.id === 'pack-1:9'), 'the oldest-row rule alone would rename');
  const withPrev = buildPackDocs({ profile: PROFILE, positions: jsonl([...rows, older]), special: '', previousIds: prev });
  assert.ok(cardsOf(withPrev).some(c => c.id === `pack-${rows[2].id}`));
  assert.ok(!cardsOf(withPrev).some(c => c.id === 'pack-1:9'));
});

test('every chunk stays under 180 KiB and every document passes its contract schema', () => {
  const rows = syntheticRows(433, { seed: 21 });
  const out = buildPackDocs({ profile: PROFILE, positions: jsonl(rows), special: jsonl([STALEMATE_ROW]) });
  for (const d of out.docs) {
    assert.ok(docBytes(d.data) <= MAX_DOC_BYTES, `${d.path} ${docBytes(d.data)}`);
    assert.ok(schemaForPath(d.path)!.safeParse(d.data).success, d.path);
    assert.notEqual(readDoc(d.path, d.data), null, `readDoc accepts ${d.path}`);
  }
  const meta = readDoc<PackMetaDoc>('pack/meta', metaOf(out).data)!;
  assert.deepEqual(packChunkIds(meta), out.docs.slice(0, -1).map(d => d.path.slice('pack/'.length)), 'meta lists every chunk; meta is written last');
  assert.equal(cardsOf(out).length, out.counts.cards + out.counts.punish);
  assert.ok(Object.values(meta.counts).every(v => typeof v === 'number'));
});

test('one card per position: same position in two rows merges; non-drillable rows make no cards', () => {
  const rows = syntheticRows(5, { seed: 2 });
  const dup = { ...rows[0], id: '42:7', date: '2026-11-01' };
  const notDrill: Record<string, unknown> = { ...syntheticRows(1, { seed: 77, firstGame: 700000 })[0], drillable: false };
  const out = buildPackDocs({ profile: PROFILE, positions: jsonl([dup, ...rows, notDrill]), special: '' });
  assert.equal(out.counts.cards, 5);
  assert.equal(out.counts.mergedRows, 1);
  assert.ok(!cardsOf(out).some(c => String(c.id).includes(String(notDrill.id))));
});

test('reconciliation fails on a count that differs from run_manifest.json', () => {
  const rows = syntheticRows(8, { seed: 4 });
  const ok = buildPackDocs({ profile: PROFILE, positions: jsonl(rows), special: '', manifest: { counts: { mistakePositions: 8, drillable: 8 } } });
  assert.equal(ok.reconcile.ok, true);
  const bad = buildPackDocs({ profile: PROFILE, positions: jsonl(rows), special: '', manifest: { counts: { mistakePositions: 9, drillable: 8 } } });
  assert.equal(bad.reconcile.ok, false);
  assert.match(bad.reconcile.diffs[0], /mistakePositions: manifest 9, converted 8/);
});

test('seed docs: plan, note and ingest state pass the contract and are deterministic', () => {
  const rows = syntheticRows(10, { seed: 8 });
  const out = buildPackDocs({ profile: PROFILE, positions: jsonl(rows), special: '' });
  const a = buildSeedDocs(PROFILE, out.counts, out.packVersion, PROFILE.generatedAt);
  const b = buildSeedDocs(PROFILE, out.counts, out.packVersion, PROFILE.generatedAt);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(a.map(d => d.path), ['plan/current', 'notes/n-20261110-pack', 'ingest/state']);
  for (const d of a) assert.notEqual(readDoc(d.path, d.data), null, d.path);
  const plan = a[0].data as { focus: Array<{ theme: string; weight: number }>; mix: Record<string, number> };
  assert.deepEqual(plan.focus.map(f => f.theme), ['fork', 'hangingPiece']);
  assert.ok(plan.focus.every(f => f.weight >= 0.5 && f.weight <= 3));
  assert.ok(plan.mix.agent > 0, 'agent drill sets must be served (review 2 P1-1)');
  assert.ok(Math.abs(Object.values(plan.mix).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(String((a[1].data as { text: string }).text).length <= 600);
});

test('invalid rows are refused, not silently dropped', () => {
  const rows = syntheticRows(3, { seed: 6 });
  assert.throws(() => buildPackDocs({ profile: PROFILE, positions: jsonl([...rows, { ...rows[0], id: 'bad id' }]), special: '' }), /invalid row/);
  assert.throws(() => buildPackDocs({ profile: PROFILE, positions: jsonl([rows[0], rows[0]]), special: '' }), /duplicate id/);
});

// Real producer files: counts and limits only, never content. Skipped when the folder is absent.
const SRC = PROFILE_DIR;
test('real pack: counts reconcile with run_manifest.json, all documents fit, deterministic', { skip: !existsSync(join(SRC, 'mistake_positions.jsonl')) }, () => {
  const read = (f: string) => readFileSync(join(SRC, f), 'utf8');
  const input = { profile: JSON.parse(read('weakness_profile.json')), positions: read('mistake_positions.jsonl'), special: read('special_sets.jsonl'), manifest: JSON.parse(read('run_manifest.json')) };
  const out = buildPackDocs(input);
  assert.equal(out.reconcile.ok, true, out.reconcile.diffs.join('; '));
  // Expected counts are read from the producer's run_manifest.json at run time (no personal number in this file).
  const c = (input.manifest as { counts: { mistakePositions: number; drillable: number; specialSets: { stalemate: { records: number }; conversion: { withDecisiveError: number } } } }).counts;
  assert.equal(out.counts.rows, c.mistakePositions);
  assert.equal(out.counts.drillable, c.drillable);
  assert.equal(out.counts.conversionRows, c.specialSets.conversion.withDecisiveError);
  assert.equal(out.counts.stalemateRows, c.specialSets.stalemate.records);
  assert.equal(out.counts.study, c.specialSets.stalemate.records);
  assert.ok(out.counts.punish === 0 && out.counts.punishStudy > 0, 'with no evaluations every punish position is a study item');
  for (const d of out.docs) assert.ok(docBytes(d.data) <= MAX_DOC_BYTES, d.path);
  const ids = cardsOf(out).map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(cardsOf(out).filter(c => c.kind !== 'punish').map(c => positionKey(String(c.fen)))).size, out.counts.cards);
  const again = buildPackDocs(input);
  assert.equal(JSON.stringify(again.docs.map(d => d.data)), JSON.stringify(out.docs.map(d => d.data)));
  console.log(`real pack ${out.packVersion}: cards ${out.counts.cards}, punish ${out.counts.punish}, study ${out.counts.study}, docs ${out.docs.length}, largest ${Math.max(...out.docs.map(d => docBytes(d.data)))} bytes`);
});

/** After-position evaluations that make every refutation clearly unique (gap 20), except where `override` says. */
function evalsFor(rows: Array<Record<string, unknown>>, override: (row: Record<string, unknown>) => Partial<AfterEval> = () => ({})): Record<string, AfterEval> {
  const out: Record<string, AfterEval> = {};
  for (const r of rows) {
    const ref = r.refutationPvUci as string[];
    const after = fenAfter(String(r.fen), String(r.playedUci));
    if (!after || !ref?.length) continue;
    out[positionKey(after)] = { best14: ref[0], gap: 20, gapDepth: 14, ...override(r) };
  }
  return out;
}
const punishStudyOf = (out: ReturnType<typeof buildPackDocs>) => out.docs.flatMap(d => ((d.data.study as Array<Record<string, unknown>> | undefined) ?? []).filter(x => x.set === 'punish'));

test('punishGrade applies the producer drillable rule to the after-position', () => {
  const row = { winAfter: 20, mateAfter: null } as unknown as Row;
  const ev = (o: Partial<AfterEval>): AfterEval => ({ best14: 'e7e5', gap: 12, gapDepth: 14, ...o });
  assert.equal(punishGrade(row, 'e7e5', ev({})), 'unique');
  assert.equal(punishGrade(row, 'e7e5', ev({ gap: 9.99 })), 'not-unique');
  assert.equal(punishGrade(row, 'e7e5', ev({ gap: null })), 'not-unique');
  assert.equal(punishGrade(row, 'e7e5', ev({ best14: 'd7d5' })), 'not-held');
  assert.equal(punishGrade(row, 'e7e5', null), 'no-eval');
  assert.equal(punishGrade({ winAfter: 3, mateAfter: null } as unknown as Row, 'e7e5', ev({})), 'decided', 'solver at 97%');
  assert.equal(punishGrade({ winAfter: 0, mateAfter: -3 } as unknown as Row, 'e7e5', ev({})), 'unique', 'forced mate for the solver is the lesson');
  assert.equal(punishGrade({ winAfter: 100, mateAfter: 4 } as unknown as Row, 'e7e5', ev({})), 'decided', 'mate against the solver');
  // Gap from cache lines (side-to-move view), deeper MultiPV 2 preferred.
  const e14 = { bm: 'e7e5', d: 14, l: [{ s: { cp: 300 } }, { s: { cp: 250 } }] };
  assert.equal(afterEvalFromCache(e14)!.gap, Math.round((lineWin({ cp: 300 }) - lineWin({ cp: 250 })) * 100) / 100);
  const e18 = { bm: 'e7e5', d: 18, l: [{ s: { mate: 2 } }, { s: { cp: 100 } }] };
  assert.deepEqual([afterEvalFromCache(e14, e18)!.gapDepth, afterEvalFromCache(e14, e18)!.gap! > 10], [18, true]);
  assert.equal(afterEvalFromCache({ bm: 'e7e5', d: 14, l: [{ s: { cp: 1 } }] })!.gap, null);
});

test('a non-unique refutation is never graded; it becomes an ungraded study item with the same id', () => {
  const rows = syntheticRows(30, { seed: 13 });
  const flaky = new Set(rows.slice(0, 10).map(r => r.id));
  const out = buildPackDocs({ profile: PROFILE, positions: jsonl(rows), special: '', afterEvals: evalsFor(rows, r => (flaky.has(r.id) ? { gap: 4 } : {})) });
  const graded = cardsOf(out).filter(c => c.kind === 'punish');
  const study = punishStudyOf(out);
  for (const id of flaky) {
    assert.ok(!graded.some(c => c.id === `punish-${id}`), `punish-${id} graded`);
    const item = study.find(x => x.id === `punish-${id}`);
    assert.ok(item, `punish-${id} kept as study`);
    assert.equal(item!.graded, false);
    assert.equal(item!.why, 'not-unique');
    assert.ok(item!.replySan && (item!.lineSan as string[]).length >= 1 && item!.playedSan);
  }
  assert.equal(out.counts.punish, graded.length);
  assert.equal(out.counts.punishStudy, study.length);
  assert.equal(out.counts.punishStudy_not_unique, 10);
  const meta = readDoc<PackMetaDoc>('pack/meta', metaOf(out).data)!;
  assert.equal(meta.counts.punish, graded.length);
  assert.equal(meta.counts.punishStudy, study.length);
  // No evaluation at all: nothing is graded.
  const none = buildPackDocs({ profile: PROFILE, positions: jsonl(rows), special: '' });
  assert.equal(none.counts.punish, 0);
  assert.equal(none.counts.punishStudy_no_eval, none.counts.punishStudy);
});

test('ids are unchanged for punish cards that stay graded, and previousIds carry punish study items', () => {
  const rows = syntheticRows(30, { seed: 17 });
  const allUnique = buildPackDocs({ profile: PROFILE, positions: jsonl(rows), special: '', afterEvals: evalsFor(rows) });
  const someNot = buildPackDocs({ profile: PROFILE, positions: jsonl(rows), special: '', afterEvals: evalsFor(rows, r => (Number(String(r.id).split(':')[1]) % 2 ? { gap: 1 } : {})) });
  const ids = (o: ReturnType<typeof buildPackDocs>) => new Map(cardsOf(o).filter(c => c.kind === 'punish').map(c => [String(c.fen), c.id]));
  const before = ids(allUnique), after = ids(someNot);
  assert.ok(after.size > 0 && after.size < before.size);
  for (const [fen, id] of after) assert.equal(before.get(fen), id);
  // Pack card ids do not depend on punish grading at all.
  assert.deepEqual(cardsOf(allUnique).filter(c => c.kind !== 'punish').map(c => c.id), cardsOf(someNot).filter(c => c.kind !== 'punish').map(c => c.id));
  const prev = previousIdsFromDocs(someNot.docs.filter(d => d.path !== 'pack/meta').map(d => d.data));
  for (const item of punishStudyOf(someNot)) assert.equal(prev[`punish|${positionKey(String(item.fen))}`], item.id);
  for (const d of someNot.docs) assert.ok(docBytes(d.data) <= MAX_DOC_BYTES);
});

test('sample drill set: built only from graded pack cards already in the pack, valid for the page', () => {
  const rows = syntheticRows(40, { seed: 23 });
  const out = buildPackDocs({ profile: PROFILE, positions: jsonl(rows), special: '' });
  const packCards = cardsOf(out);
  const drills = buildSampleDrills(packCards, PROFILE.generatedAt)!;
  assert.equal(drills.id, SAMPLE_DRILL_SET);
  const doc = readDoc<{ active: boolean; cards: Array<{ id: string; fen: string; moves: string[]; fromCard: string; refutationPvUci?: string[] }> }>(`drills/${drills.id}`, drills.data)!;
  assert.ok(doc && doc.active);
  assert.equal(doc.cards.length, 6);
  const byId = new Map(packCards.map(c => [String(c.id), c]));
  doc.cards.forEach((c, n) => {
    assert.equal(c.id, `agent-${SAMPLE_DRILL_SET}-${n}`);
    const src = byId.get(c.fromCard)!;
    assert.ok(src && src.kind === 'mistake', 'from a graded pack card');
    assert.equal(c.fen, src.fen);
    assert.deepEqual(c.moves, src.moves);
    assert.equal(c.refutationPvUci, undefined, 'the game-move refutation is not passed to a drill');
  });
  const seeds = buildSeedDocs(PROFILE, out.counts, out.packVersion, PROFILE.generatedAt, packCards);
  assert.deepEqual(seeds.map(d => d.path), ['plan/current', 'notes/n-20261110-pack', 'ingest/state', `drills/${SAMPLE_DRILL_SET}`]);
  assert.equal(JSON.stringify(seeds), JSON.stringify(buildSeedDocs(PROFILE, out.counts, out.packVersion, PROFILE.generatedAt, packCards)));
});

test('--validate reports every near-miss the page would silently ignore, and passes a good document', () => {
  // Strict: each call gets its own fresh directory, no retry; every assertion message carries the child's output.
  const run = (docPath: string, body: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'b3v-'));
    const f = join(dir, 'doc.json');
    writeFileSync(f, JSON.stringify(body));
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/pack-to-docs.mjs', '--validate', docPath, f], { cwd: resolve(import.meta.dirname ?? '.', '..'), encoding: 'utf8', timeout: 120_000 });
    const out = `${r.stdout ?? ''}`, why = `exit ${r.status} signal ${r.signal} error ${r.error?.message ?? 'none'}\nstdout: ${out}\nstderr: ${(r.stderr ?? '').slice(0, 2000)}`;
    assert.match(out, /^(ok|INVALID) /m, `validator printed no verdict for ${docPath}: ${why}`);
    return { code: r.status, out, why };
  };
  const good = { updatedAt: '2026-11-10', author: 'claude', expires: '2026-11-24', focus: [{ theme: 'fork', weight: 1.5, reason: 'r' }], mix: { bank: 0.45, pack: 0.35, endgame: 0.1, agent: 0.1 } };
  const ok = run('plan/current', good);
  assert.equal(ok.code, 0, ok.why);
  const bad = run('plan/current', { ...good, focus: [{ theme: 'fork', weight: 3.5 }], mix: { bank: 0.5, pack: 0.5, endgame: 0 } });
  assert.equal(bad.code, 1, bad.why);
  for (const want of ['focus.0.weight', 'focus.0.reason', 'mix.agent']) assert.ok(bad.out.includes(want), want);
  assert.equal(run('notes/n1', { text: 'x'.repeat(601), createdAt: '2026-11-10' }).code, 1);
  const drill = { title: 't', reason: 'r', createdAt: '2026-11-10', active: true, cards: [{ id: 'agent-x-0', fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', moves: ['f1b5', 'a7a6'], themes: ['pin'], rating: 1000 }] };
  assert.equal(run('drills/x', drill).code, 0);
  const illegal = run('drills/x', { ...drill, cards: [{ ...drill.cards[0], moves: ['f1b6'] }] });
  assert.equal(illegal.code, 1);
  assert.match(illegal.out, /not legal/);
});
