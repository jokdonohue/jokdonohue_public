import test from 'node:test';
import assert from 'node:assert/strict';
import { trainingThemes } from '../lib/scheduler.js';
import { computeSnapshot } from '../components/snapshot';
import { buildProgress } from '../components/progress';
import { snapshotDoc, type SessionAttempt } from '../src/contract/docs';

const NOW = Date.UTC(2026, 10, 10, 12), DAY = 86_400_000;
const a = (puzzleId: string, at: number, ok: boolean, themes = ['fork'], source?: SessionAttempt['source']): SessionAttempt => ({ puzzleId, themes, correct: ok, unassisted: ok, hints: 0, revealed: false, durationMs: 1, at, ...(source ? { source } : {}) });

test('snapshot: windows, themes, weakest (5+ attempts), due, sources, pack coverage; valid against the contract', () => {
  const attempts = [
    ...Array.from({ length: 6 }, (_, i) => a(`f${i}`, NOW - 2 * DAY + i, i < 2, ['fork', 'short'], 'bank')),
    ...Array.from({ length: 5 }, (_, i) => a(`p${i}`, NOW - 40 * DAY + i, true, ['pin'], 'pack')),
    a('pack-0000000000000001', NOW - 3 * DAY, false, ['fork'], 'pack'),
  ];
  const progress = buildProgress(attempts, { rating: 1000, sessionLength: 10 }, trainingThemes);
  const snap = computeSnapshot({
    attempts, progress, themesOf: trainingThemes, priors: { fork: 2 }, servableIds: ['f0', 'f2', 'pack-0000000000000001', 'gone'],
    packIds: ['pack-0000000000000001', 'pack-0000000000000002'], session: { id: 's-1-d', attempts: attempts.slice(0, 2) }, deviceId: 'd', now: NOW,
  });
  assert.ok(snapshotDoc.safeParse(snap).success);
  assert.equal(snap.attemptsTotal, 12);
  assert.deepEqual(snap.last7d, { attempts: 7, firstTryRate: 0.286 });
  assert.equal(snap.last30d.attempts, 7);
  assert.equal(snap.themes.fork.attempts, 7); assert.equal(snap.themes.fork.prior, 2); assert.equal(snap.themes.short, undefined, 'metadata themes dropped');
  assert.deepEqual(snap.weakest.map(w => w.theme), ['fork', 'pin']);
  assert.equal(snap.due.count, 3, 'f0 (clean, 1-day interval), f2 and the pack card (missed, 10 min); "gone" is not servable');
  assert.equal(snap.due.overdue, 2, 'f2 and the pack card are more than a day overdue; f0 is due exactly now');
  assert.ok(snap.due.nextIds.includes('pack-0000000000000001'));
  assert.deepEqual(snap.sources, { bank: 6, pack: 6, endgame: 0, personal: 0, agent: 0 });
  assert.deepEqual(snap.packCoverage, { seen: 1, total: 2 });
  assert.equal(snap.lastSession?.attempts, 2);
  assert.equal(snap.device, 'd');
});
