import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFakeStore } from '../src/contract/store';
import PgnImport, { summaryLine, LOCAL_ONLY_LINE } from '../components/pgn/PgnImport';
import { stubEngine } from './m2_pgn_stub';

test('the import screen: paste box, .pgn file, his names, and the phone timing note; no engine on render', () => {
  let made = 0;
  const html = renderToStaticMarkup(<PgnImport store={{ ...createFakeStore(), kind: 'db' }} myNames={['Alex Example']} saveMyNames={async () => true}
    knownCards={[]} createEngine={() => { made++; return stubEngine(); }}/>);
  assert.match(html, /Import games from a PGN/);
  assert.match(html, /This can take a few minutes on a phone\./);
  assert.match(html, /<textarea[^>]*id="pgn-text"/);
  assert.match(html, /type="file"[^>]*accept="\.pgn/);
  assert.match(html, /value="Alex Example"/);
  assert.match(html, /Paste up to 10 finished games/);
  assert.equal(made, 0, 'the engine starts only when he asks for a check');
  // With the saved storage the boxes are on (the Check button waits for text).
  assert.doesNotMatch(html, /<input id="pgn-my-names"[^>]*disabled/);
  assert.doesNotMatch(html, /<textarea[^>]*disabled/);
  assert.doesNotMatch(html, /type="file"[^>]*disabled/);
  assert.ok(!html.includes(LOCAL_ONLY_LINE));
  assert.doesNotMatch(html, /\b(SAN|FEN|UCI|ply|MultiPV|centipawn)\b/i, 'no jargon on the page');
});

test('the summary line is plain and never one bare number', () => {
  const base = { games: 2, positions: 3, mistakes: 4, skippedAlready: 1, skippedProblem: 0, skippedKnown: 1, cardIds: [] };
  assert.equal(summaryLine(base), 'Checked 2 games: 3 new positions to practise from your mistakes. 1 mistake was already in your practice. 1 game was imported before.');
  assert.match(summaryLine({ ...base, positions: 0, skippedKnown: 0, skippedAlready: 0 }), /Only mistakes with one clearly best answer become positions\./);
});

test('PGN stream files: no outside fetch, no absolute engine path, no browser storage, no owner data', () => {
  const files = [
    ...readdirSync('src/analysis').map(f => path.join('src/analysis', f)),
    ...readdirSync('components/pgn').map(f => path.join('components/pgn', f)),
    ...readdirSync('tests').filter(f => f.startsWith('m2_pgn_')).map(f => path.join('tests', f)),
  ];
  assert.ok(files.length >= 8);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const code = f.startsWith('tests') ? '' : text;
    for (const banned of [/fetch\(/, /XMLHttpRequest|WebSocket|sendBeacon/, /["'`(]\/engine\//, /localStorage|sessionStorage|indexedDB/, /api\.chess\.com/, /createObjectURL/, /import\(/]) {
      assert.doesNotMatch(code, banned, `${f} contains ${banned}`);
    }
    assert.doesNotMatch(text, /\/Users\/|\/home\/|file:\/\//, `${f}: no absolute paths`);
    assert.doesNotMatch(text, /chess\.com\/(member|games\/archive)\/[A-Za-z0-9_-]/, `${f}: no account links`);
  }
});

test('review P2-1: on the local-only store the import and the names box are off, with one plain reason', () => {
  // Reviewer's reproduction (logs/m2_review_tmp/r_pgn_local.test.ts): there, an import on this store "succeeds"
  // and a reload (a fresh local-only store) holds nothing. The screen now refuses before anything runs.
  const store = createFakeStore({ connection: 'local-only' });
  assert.equal(store.kind, 'memory');
  let saved = 0;
  const html = renderToStaticMarkup(<PgnImport store={store} myNames={['Alex Example']} saveMyNames={async () => { saved++; return true; }}
    knownCards={[]} createEngine={() => stubEngine()}/>);
  assert.ok(html.includes(LOCAL_ONLY_LINE));
  assert.match(LOCAL_ONLY_LINE, /Your practice still works\.$/);
  assert.match(html, /<input id="pgn-my-names"[^>]*disabled=""/);
  assert.match(html, /<textarea[^>]*disabled=""[^>]*id="pgn-text"|<textarea[^>]*id="pgn-text"[^>]*disabled=""/);
  assert.match(html, /type="file"[^>]*disabled=""/);
  assert.match(html, /<button type="button" class="primary" disabled="">Check these games/);
  assert.match(html, /<button type="button" class="secondary" disabled="">Save/);
  assert.equal(saved, 0);
});
