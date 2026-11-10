import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeStore } from '../src/contract/store';
import { readDoc, type SessionDoc } from '../src/contract/docs';
import { applySiteImport, idMapFromPackChunks, NOT_A_BACKUP, planSiteImport, sourceOf } from '../src/importers/siteBackup';

const T0 = 1_794_000_000_000;
const att = (puzzleId: string, at: number, correct = true) => ({ puzzleId, themes: ['fork'], correct, unassisted: correct, hints: 0, revealed: false, durationMs: 3000, at });
const PGN = '[Event "Casual"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';
function backup(extra: Partial<{ attempts: unknown[]; settingsUpdatedAt: number; rating: number }> = {}) {
  const attempts = extra.attempts ?? [
    ...Array.from({ length: 700 }, (_, i) => att(`b${i % 50}`, T0 + i * 1000, i % 3 !== 0)),
    att('pack-0123456789abcdef', T0 + 870_000), att('endgame-krk', T0 + 870_001), att('g1-5', T0 + 870_002),
    att('b1', T0 + 1000), // duplicate key of an attempt above (b1 at T0+1000)
  ];
  return JSON.stringify({
    version: 1,
    progress: { attempts, cards: { b1: { attempts: 1 } }, skills: {}, settings: { rating: extra.rating ?? 1135, sessionLength: 12 }, settingsUpdatedAt: extra.settingsUpdatedAt ?? T0 + 5 },
    games: [{ id: 'g1', headers: { Event: 'Casual', Result: '1-0' }, moves: [], pgn: PGN, result: '1-0', userColor: 'w', importedAt: T0 }],
    personalPuzzles: [{ id: 'g1-5', fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', moves: ['h5f7'], rating: 1000, themes: ['mateIn1'], gameUrl: '' }],
  });
}

test('a Site backup imports idempotently: same ids, same bodies, no duplicate attempts', async () => {
  const store = createFakeStore();
  const text = backup();
  const plan1 = await planSiteImport(text, { idMap: { 'pack-0123456789abcdef': 'pack-123:5' } });
  const plan2 = await planSiteImport(text, { idMap: { 'pack-0123456789abcdef': 'pack-123:5' } });
  assert.deepEqual(plan1, plan2, 'the plan is deterministic');
  assert.equal((await planSiteImport(text)).sha8, plan1.sha8, 'same documents with or without an idMap');
  assert.match(plan1.sha8, /^[0-9a-f]{8}$/);
  assert.equal(plan1.counts.attempts, 703);
  assert.equal(plan1.counts.duplicateAttempts, 1);
  assert.equal(plan1.counts.sessions, 2, '600 attempts per document');
  await applySiteImport(store, plan1, { deviceId: 'dev1' });
  const first = store.dump();
  await applySiteImport(store, plan2, { deviceId: 'dev1' });
  assert.deepEqual(store.dump(), first, 're-import changes nothing');
  const sessionPaths = Object.keys(first).filter(p => p.startsWith('sessions/')).sort();
  assert.deepEqual(sessionPaths, [`sessions/s-import-${plan1.sha8}-00`, `sessions/s-import-${plan1.sha8}-01`]);
  const all = sessionPaths.flatMap(p => readDoc<SessionDoc>(p, first[p])!.attempts);
  assert.equal(all.length, 703);
  assert.equal(new Set(all.map(a => `${a.puzzleId}:${a.at}`)).size, 703);
  assert.ok(all.every((a, i) => i === 0 || all[i - 1].at <= a.at), 'sorted by time');
  // Source inference and the pack id remap.
  const by = (id: string) => all.find(a => a.puzzleId === id)!;
  assert.equal(by('pack-123:5').source, 'pack');
  assert.equal(all.some(a => a.puzzleId === 'pack-0123456789abcdef'), false);
  assert.equal(by('endgame-krk').source, 'endgame');
  assert.equal(by('g1-5').source, 'personal');
  assert.equal(by('b3').source, 'bank');
  assert.equal(plan1.counts.remapped, 1);
  // Games and personal puzzles; cards and skills are dropped.
  assert.equal(first['games/g1'].pgn, PGN);
  assert.deepEqual(first['games/g1'].mistakes, []);
  assert.deepEqual((first['personal/import-00'].puzzles as Array<{ id: string; gameUrl?: string }>).map(p => [p.id, p.gameUrl]), [['g1-5', undefined]]);
  assert.ok(!Object.keys(first).some(p => p.includes('cards') || p.includes('skills')));
});

test('settings apply only when newer than settings/main.updatedAt', async () => {
  const store = createFakeStore({ seed: { 'settings/main': { rating: 870, sessionLength: 10, updatedAt: T0 + 100, device: 'phone' } } });
  const older = await planSiteImport(backup({ settingsUpdatedAt: T0 + 5 }));
  assert.equal((await applySiteImport(store, older, { deviceId: 'mac' })).settingsApplied, false);
  assert.equal(store.dump()['settings/main'].rating, 870);
  const newer = await planSiteImport(backup({ settingsUpdatedAt: T0 + 500, rating: 1250 }));
  assert.equal((await applySiteImport(store, newer, { deviceId: 'mac' })).settingsApplied, true);
  assert.deepEqual(store.dump()['settings/main'], { rating: 1250, sessionLength: 12, updatedAt: T0 + 500, device: 'mac' });
  const fresh = createFakeStore();
  await applySiteImport(fresh, await planSiteImport(backup({ settingsUpdatedAt: 0 })), { deviceId: 'mac' });
  assert.equal(fresh.dump()['settings/main'], undefined, 'never-changed Site settings are not applied');
});

test('a damaged or foreign file is refused with one plain sentence and nothing is written', async () => {
  await assert.rejects(planSiteImport('{"hello":1}'), { message: NOT_A_BACKUP });
  await assert.rejects(planSiteImport('not json'), { message: NOT_A_BACKUP });
  await assert.rejects(planSiteImport('{"__proto__":{}}'), { message: 'Invalid backup key.' });
  const bad = JSON.parse(backup());
  bad.progress.attempts[1].unassisted = false; // contradicts correct && hints==0 && !revealed
  await assert.rejects(planSiteImport(JSON.stringify(bad)), { message: NOT_A_BACKUP });
});

test('an injected parser (the Site parseState) is used; idMap comes from pack chunks', async () => {
  let called = 0;
  const plan = await planSiteImport(backup(), { parse: text => { called++; return JSON.parse(text); } });
  assert.equal(called, 1);
  assert.equal(plan.counts.games, 1);
  assert.deepEqual(idMapFromPackChunks([{ cards: [{ id: 'pack-1:2', siteId: 'pack-00000000000000aa' }], study: [{ id: 'study-3:4', siteId: 'study-00000000000000bb' }] }]),
    { 'pack-00000000000000aa': 'pack-1:2', 'study-00000000000000bb': 'study-3:4' });
  assert.equal(sourceOf('agent-set1-0', new Set()), 'agent');
});

test('the artifact export round-trips: extras restored, long histories accepted, no second copy on re-import', async () => {
  const base = JSON.parse(backup());
  base.progress.attempts.push(att('agent-s-0', T0 + 950_000, false));
  base.nextMove = { kind: 'next-move-artifact-backup', exportedAt: T0, attemptExtras: [
    { key: `b3:${T0 + 3000}`, source: 'bank', playedUci: 'e2e4', coached: true },
    { key: `agent-s-0:${T0 + 950_000}`, source: 'agent', verdict: 'unsafe' },
  ] };
  const plan = await planSiteImport(JSON.stringify(base));
  const all = plan.writes.filter(w => w.path.startsWith('sessions/')).flatMap(w => (w.data as unknown as SessionDoc).attempts);
  const one = all.find(a => a.puzzleId === 'b3' && a.at === T0 + 3000)!;
  assert.deepEqual([one.source, one.playedUci, one.coached], ['bank', 'e2e4', true]);
  assert.deepEqual([all.find(a => a.puzzleId === 'agent-s-0')!.source, all.find(a => a.puzzleId === 'agent-s-0')!.verdict], ['agent', 'unsafe']);
  assert.equal(plan.counts.extrasRestored, 2);
  // Over the Site's 20,000-attempt cap: refused as a Site backup, accepted as an artifact export.
  const many = Array.from({ length: 20_001 }, (_, i) => att('b1', T0 + i, true));
  await assert.rejects(planSiteImport(JSON.stringify({ ...JSON.parse(backup()), progress: { ...base.progress, attempts: many } })), { message: NOT_A_BACKUP });
  assert.equal((await planSiteImport(JSON.stringify({ ...base, progress: { ...base.progress, attempts: many } }))).counts.attempts, 20_001);
  // Re-importing into a database that already holds every attempt writes no session documents.
  const keys = new Set(all.map(a => `${a.puzzleId}:${a.at}`));
  const again = await planSiteImport(JSON.stringify(base), { skipKeys: keys });
  assert.equal(again.counts.sessions, 0);
  assert.equal(again.counts.alreadyStored, all.length);
  assert.equal(again.sha8, plan.sha8);
});
