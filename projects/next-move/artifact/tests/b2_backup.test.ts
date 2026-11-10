import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBackup, backupFilename, BACKUP_KIND } from '../components/backup';
import { buildProgress } from '../components/progress';
import { trainingThemes } from '../lib/scheduler.js';
import { parseState } from '../lib/training-state';
import { applySiteImport, planSiteImport } from '../src/importers/siteBackup';
import { createFakeStore } from '../src/contract/store';

const settings = { rating: 1000, sessionLength: 10, dailyReviewCap: 20, dailyNewCap: 10, updatedAt: 7 };

test('backup: Site-compatible TrainingState core plus the artifact extras', () => {
  const b = buildBackup({
    attempts: [
      { puzzleId: 'a', themes: ['fork'], correct: true, unassisted: true, hints: 0, revealed: false, durationMs: 5, at: 1, source: 'bank' },
      { puzzleId: 'b', themes: ['pin'], correct: false, unassisted: false, hints: 0, revealed: true, durationMs: 5, at: 2, source: 'pack', playedUci: 'e2e4', coached: true },
    ],
    progress: { cards: {}, skills: {} },
    settings,
    personal: [{ id: 'p1', fen: '8/8/8/8/8/8/8/K6k w - - 0 1', moves: ['a1a2'], rating: 1000, themes: ['personal'], gameUrl: 'not-a-url' }],
    plan: null, notes: [], openFeedback: [], packVersion: 'v1', exportedAt: 9,
  });
  assert.equal(b.version, 1);
  assert.deepEqual(Object.keys(b.progress.attempts[1]).sort(), ['at', 'correct', 'durationMs', 'hints', 'puzzleId', 'revealed', 'themes', 'unassisted']);
  assert.deepEqual(b.progress.settings, { rating: 1000, sessionLength: 10 });
  assert.equal(b.progress.settingsUpdatedAt, 7);
  assert.deepEqual(b.games, []);
  assert.equal(b.personalPuzzles[0].gameUrl, '', 'Site schema needs an http(s) URL or empty');
  assert.equal(b.nextMove.kind, BACKUP_KIND);
  assert.deepEqual(b.nextMove.attemptExtras, [{ key: 'a:1', source: 'bank' }, { key: 'b:2', source: 'pack', playedUci: 'e2e4', coached: true }]);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(b)));
  assert.match(backupFilename(new Date(2026, 10, 10).getTime()), /^next-move-progress-2026-11-10\.json$/);
});

test('backup round trip: the Site parser reads the export, and the artifact importer takes it back idempotently', async () => {
  const FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
  const attempts = [
    { puzzleId: 'a', themes: ['fork'], correct: true, unassisted: true, hints: 0, revealed: false, durationMs: 5, at: 1000, source: 'bank' as const },
    { puzzleId: 'personal-x', themes: ['personal'], correct: false, unassisted: false, hints: 1, revealed: false, durationMs: 5, at: 2000, source: 'personal' as const, playedUci: 'g1f1' },
  ];
  const progress = buildProgress(attempts, settings, trainingThemes);
  const text = JSON.stringify(buildBackup({
    attempts, progress, settings, personal: [{ id: 'personal-x', fen: FEN, moves: ['a1a8'], rating: 1000, themes: ['personal'] }],
    plan: null, notes: [], openFeedback: [], packVersion: null, exportedAt: 9,
  }));
  const site = parseState(text);
  assert.equal(site.progress.attempts.length, 2);
  assert.deepEqual(site.progress.cards, progress.cards, 'the Site rebuilds the same cards');
  assert.equal(site.personalPuzzles[0].id, 'personal-x');
  const store = createFakeStore();
  const plan = await planSiteImport(text, { parse: parseState });
  await applySiteImport(store, plan, { deviceId: 'd1' });
  const first = store.dump();
  await applySiteImport(store, await planSiteImport(text, { parse: parseState }), { deviceId: 'd1' });
  assert.deepEqual(store.dump(), first, 're-import writes identical documents');
  // The page passes the attempts it already holds as skipKeys: nothing new is written for its own export.
  const held = new Set(attempts.map(x => `${x.puzzleId}:${x.at}`));
  const again = await planSiteImport(text, { parse: parseState, skipKeys: held });
  assert.equal(again.counts.attempts, 0); assert.equal(again.counts.alreadyStored, 2);
  const sessions = Object.entries(first).filter(([p]) => p.startsWith('sessions/'));
  assert.equal(sessions.flatMap(([, d]) => (d as { attempts: unknown[] }).attempts).length, 2);
});
