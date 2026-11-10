import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeStore, createMemoryKv, type DocData } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { createTrainerModel } from '../components/model';
import { computeSnapshot } from '../components/snapshot';
import { buildProgress } from '../components/progress';
import { safeAttempt, safeQuestion } from '../components/safe';
import { putBackAttempt } from '../components/leech';
import * as v4 from './fixtures/v4_docs';

// D14: what the M2 page writes to documents both versions touch (`sessions/*`, `settings/main`, `derived/snapshot`,
// `feedback/*`) stays readable by version 4. Checked against the frozen copy of the version-4 contract. Invented values.
const FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const card = (id: string, kind: 'safe' | 'unsafe') => ({ id, kind, fen: FEN, moves: ['f1c4'], rating: 1000, themes: ['personal', 'safety', 'opening'] });

test('D14: the fixture is the version-4 contract (no M2 additions)', () => {
  assert.equal('safeMeta' in v4.paths, false);
  assert.deepEqual([...v4.ATTEMPT_SOURCES], ['bank', 'pack', 'endgame', 'agent', 'personal']);
});

test('D14: sessions, settings, feedback and the snapshot as M2 writes them are valid version-4 documents', async () => {
  const store = createFakeStore({ seed: { 'settings/main': { rating: 1000, sessionLength: 10, updatedAt: 1, device: 'phone', lastIngest: '2100-01-01T00:00:00Z' } } });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'laptop', events: null, debounceMs: 1 });
  const m = createTrainerModel({ store, sessions, deviceId: 'laptop', readyTimeoutMs: 500 });
  await tick(20);
  const now = Date.now();
  const q = safeQuestion(card('judge-g1:5', 'unsafe') as never)!;
  const answers = [
    safeAttempt(q, 'unsafe', 'unsafe', now - 5000, now - 10),
    safeAttempt(q, 'unsafe', 'safe', now - 5000, now - 9),
    safeAttempt(q, 'unsafe', 'unsure', now - 5000, now - 8),
    putBackAttempt('pack-g2:7', 'pack', now - 7),
    { puzzleId: 'bank-1', themes: ['fork'], correct: false, unassisted: false, hints: 1, revealed: false, durationMs: 900, at: now - 6, source: 'bank' as const },
  ];
  for (const a of answers) assert.equal(m.record(a), true);
  assert.equal(await m.saveSettings({ myNames: ['Player One'], dailyNewCap: 5 }), true);
  assert.equal(await m.sendFeedback({ kind: 'wrong', item: { id: q.id, source: 'pack', themes: q.themes, fen: q.fen }, text: 'invented' }), true);
  await tick(80);
  const dump = (store as unknown as { dump(): Record<string, DocData> }).dump();
  const sessionPaths = Object.keys(dump).filter(p => p.startsWith('sessions/'));
  assert.ok(sessionPaths.length >= 1);
  let total = 0;
  for (const p of sessionPaths) {
    const parsed = v4.readDoc<{ attempts: unknown[] }>(p, dump[p]);
    assert.ok(parsed, `${p} is readable by version 4`);
    total += parsed!.attempts.length;
  }
  assert.equal(total, answers.length, 'no attempt is lost to version 4');
  // Settings: version 4 reads it; it drops `myNames` (unknown key), which M2 treats as "ask again".
  const settings = v4.readDoc<Record<string, unknown>>('settings/main', dump['settings/main']);
  assert.ok(settings);
  assert.equal(settings!.dailyNewCap, 5);
  assert.equal('myNames' in settings!, false);
  const fb = Object.keys(dump).filter(p => p.startsWith('feedback/'));
  assert.equal(fb.length, 1);
  assert.ok(v4.readDoc(fb[0], dump[fb[0]]), 'feedback on a "Safe or not?" card is a version-4 feedback document');
  // Snapshot with every M2 field filled.
  const attempts = m.get().attempts;
  const snap = computeSnapshot({
    attempts, progress: buildProgress(attempts, { rating: 1000, sessionLength: 10 }, t => t), themesOf: t => t, priors: null, servableIds: [], packIds: [],
    session: null, deviceId: 'laptop', now, safe: { caught: { k: 1, n: 3 }, trusted: { k: 0, n: 0 }, unknown: 0 }, leeches: ['bank-1'],
    docErrors: [{ path: 'plan/current', issue: 'mix: Required', at: now }],
  });
  assert.ok(v4.readDoc('derived/snapshot', snap), 'version 4 reads the M2 snapshot');
  assert.doesNotThrow(() => v4.prepareWrite('derived/snapshot', snap), 'and version 4 could rewrite it');
  m.dispose(); sessions.dispose();
});
