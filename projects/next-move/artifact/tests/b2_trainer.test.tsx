import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import Trainer from '../components/Trainer';
import FeedbackBar from '../components/FeedbackBar';
import { createFakeStore, createMemoryKv } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { createTrainerModel } from '../components/model';

const dir = path.join(process.cwd(), 'components');
const sources = readdirSync(dir).filter(f => /\.(ts|tsx)$/.test(f)).map(f => [f, readFileSync(path.join(dir, f), 'utf8')] as const);
const css = readFileSync(path.join(process.cwd(), 'styles/app.css'), 'utf8');

test('removed from the port: Chess.com fetch, /api/state sync, ChatGPT sign-in, browser-download links, the static pack fetch, PGN analysis', () => {
  for (const [file, text] of sources) {
    for (const banned of [/api\.chess\.com/, /\/api\/state/, /signin-with-chatgpt/, /useTrainingState/, /loadPersonalPack/, /a\.download\s*=/, /\bdownload=/, /createObjectURL/, /analyzeGame/, /fetch\(/, /\/engine\//, /localStorage|sessionStorage/]) {
      assert.doesNotMatch(text, banned, `${file} still contains ${banned}`);
    }
  }
});

test('no owner data in components or styles: no username, no game links, no absolute paths', () => {
  for (const [file, text] of [...sources, ['app.css', css] as const]) {
    // A literal account name in a Chess.com profile or archive link (the page builds that link from settings).
    assert.doesNotMatch(text, /chess\.com\/(member|games\/archive)\/[A-Za-z0-9_-]/, file);
    assert.doesNotMatch(text, /chess\.com\/game\/live\/\d/, file);
    assert.doesNotMatch(text, /\/Users\/|\/private\/tmp|file:\/\//, file);
  }
});

test('no Tailwind utility layer: the import is gone and components use semantic classes', () => {
  assert.doesNotMatch(css, /@import\s+["']tailwindcss["']|@apply|@tailwind/);
  for (const [file, text] of sources) {
    const classes = [...text.matchAll(/className="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/));
    const utility = classes.filter(c => /^(flex|grid|p[xytrbl]?-\d|m[xytrbl]?-\d|text-(xs|sm|lg|xl)|bg-|w-\d|h-\d|gap-\d|rounded|items-|justify-)/.test(c));
    assert.deepEqual(utility, [], `${file} uses utility classes`);
  }
});

test('phone layout: the board column comes before the coach panel; toolbar and notes come after the board', () => {
  const trainer = sources.find(([f]) => f === 'Trainer.tsx')![1];
  assert.ok(trainer.indexOf('className="board-column"') < trainer.indexOf('className="coach-panel"'));
  assert.match(css, /\.practice-page>\.practice-layout\{order:2\}/);
  assert.match(css, /\.practice-page>\.practice-toolbar\{order:3/);
  assert.match(css, /\.practice-page>\.plan-notes\{order:4\}/);
  assert.match(css, /@media\(max-width:650px\)\{[^]*\.practice-page>\.page-heading\{display:none\}/);
  // The board faces the side to move (the learner; the opponent's side on punish cards), and a clean answer auto-advances.
  assert.match(trainer, /orientation=\{turn\}/);
  assert.match(trainer, /AUTO_ADVANCE_MS = 1200/);
});

test('first render: before the data arrives the page shows the loading state and the device-only banner, not a position', async () => {
  const store = createFakeStore({ connection: 'local-only' });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'd1', events: null });
  try {
    const html = renderToStaticMarkup(<Trainer store={store} deviceId="d1" sessions={sessions} coach={null} saveFile={null} isOwner={null}/>);
    assert.match(html, /Saved on this device only/);
    assert.match(html, /Loading your practice room/);
    assert.doesNotMatch(html, /class="chessboard"/);
  } finally { sessions.dispose(); }
});

test('feedback bar: four buttons and a note, in plain words', () => {
  const html = renderToStaticMarkup(<FeedbackBar itemId="x" onSend={async () => true}/>);
  for (const label of ['Something is wrong', 'Too easy', 'Too hard', 'More like this', 'Note for Claude']) assert.match(html, new RegExp(label));
});

test('lazy model: nothing is subscribed until the first listener, and closing the last listener stops it', async () => {
  const store = createFakeStore({ seed: { 'settings/main': { rating: 1200, sessionLength: 10, updatedAt: 1, device: 'd' } } });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'd1', events: null });
  const model = createTrainerModel({ store, sessions, deviceId: 'd1', lazy: true });
  try {
    await new Promise(r => setTimeout(r, 10));
    assert.equal(model.get().settings.rating, 1000, 'not started');
    const off = model.subscribe(() => {});
    await new Promise(r => setTimeout(r, 10));
    assert.equal(model.get().settings.rating, 1200);
    off();
  } finally { model.dispose(); sessions.dispose(); }
});

test('banner copy, every connection state: says what the session writer really does with the answers', async () => {
  const { connectionCopy, saveLabel } = await import('../components/HomePanels');
  // [state, saveState, persistent, expected banner, expected label]: kept on device and uploaded later / kept and synced / not kept.
  const cases: Array<[Parameters<typeof connectionCopy>[0], Parameters<typeof connectionCopy>[1], boolean, RegExp | '', string]> = [
    ['live', 'saved', true, '', 'Saved'],
    ['live', 'pending', true, '', 'Saving…'],
    ['live', 'error', true, /^Your account refused a save\. Your answers stay on this device and are sent again the next time Next Move opens\.$/, 'Saved on this device'],
    ['live', 'pending', false, /blocks storage, so wait for "Saved" before closing/, 'Saving…'],
    ['live', 'error', false, /refused a save, and this device cannot keep the answers: answers not yet saved are lost when the page closes/, 'Not saved'],
    ['connecting', 'saved', true, '', 'Connecting…'],
    ['stale', 'pending', true, /kept on this device and saved when the connection returns/, 'Will save when online'],
    ['stale', 'pending', false, /kept until this page closes and saved when the connection returns/, 'Will save when online'],
    ['local-only', 'saved', true, /Saved on this device only for now\. Your answers upload to your account the next time/, 'Saved on this device'],
    ['local-only', 'saved', false, /^Not saved: this browser blocks storage and the database is unavailable\. Answers made now are lost when the page closes\.$/, 'Not saved'],
    ['read-only', 'saved', true, /^This view cannot save to your account\. Your answers stay on this device until a view that can save opens\.$/, 'Saved on this device'],
    ['read-only', 'saved', false, /lost when the page closes/, 'Not saved'],
    ['full', 'error', true, /full\. Your answers are kept on this device; Claude can tidy older history\. Your account refused a save/, 'Storage full'],
    ['full', 'error', false, /kept until this page closes.*answers not yet saved are lost when the page closes/, 'Storage full'],
    ['revoked', 'pending', true, /^Access to your saved progress was withdrawn\. Reload the page\.$/, 'Not saving'],
    // Writer states proposed to B1 for the re-check: transient retry, an invalid answer set aside, device storage full.
    ['live', 'retrying', true, /^Saving did not work just now\. Your answers are kept on this device and sent again automatically\.$/, 'Retrying…'],
    ['live', 'retrying', false, /kept until this page closes and sent again automatically/, 'Retrying…'],
    ['stale', 'error', true, /saved when the connection returns\. Your account refused a save\./, 'Saved on this device'],
    ['live', 'set-aside', true, /^One answer could not be saved because its record was not valid, so it was set aside\. Your other answers are not affected\.$/, 'One answer not saved'],
    ['stale', 'set-aside', true, /saved when the connection returns\. One answer could not be saved/, 'One answer not saved'],
    ['live', 'device-full', true, /storage is full\. Answers are still being saved to your account; wait for "Saved" before closing/, 'Saving…'],
    ['stale', 'device-full', false, /kept until this page closes and saved when the connection returns/, 'Will save when online'],
    ['live', 'device-full', false, /storage is full\. Answers are still being saved/, 'Saving…'],
    ['local-only', 'device-full', false, /^Not saved: this device’s storage is full and the database is unavailable\. Answers made now are lost when the page closes\.$/, 'Not saved'],
    ['read-only', 'device-full', false, /this device’s storage is full\. Answers made now are lost when the page closes/, 'Not saved'],
  ];
  for (const [state, save, persistent, banner, label] of cases) {
    const text = connectionCopy(state, save, persistent);
    if (banner === '') assert.equal(text, '', `${state}/${save}/${persistent}`); else assert.match(text, banner, `${state}/${save}/${persistent}`);
    assert.doesNotMatch(text, /not kept/, 'no state claims answers are dropped while the writer keeps them');
    if (save === 'device-full' || !persistent) assert.doesNotMatch(text, /kept on this device|Saved on this device|stay on this device/, `${state}/${save}: no device-keeps claim when the device cannot keep them`);
    if (save === 'set-aside') assert.doesNotMatch(text, /tried again|sent again/, 'a set-aside answer is not retried');
    if (save === 'error') assert.doesNotMatch(text, /automatically|tried again/, 'a permanent refusal is not retried on a timer');
    assert.equal(saveLabel(state, save, persistent), label, `label ${state}/${save}/${persistent}`);
  }
});

test('re-check F1: "Saved" only after the database has confirmed every answer; timeouts and unknown states never read as saved', async () => {
  const { connectionCopy, saveLabel } = await import('../components/HomePanels');
  assert.equal(saveLabel('live', 'saved', true, 0), 'Saved');
  assert.equal(saveLabel('live', 'saved', true, 2), 'Saving…', 'writer says saved but answers are still unconfirmed');
  for (const unknown of ['timeout', 'unknown', 'unconfirmed']) {
    assert.equal(saveLabel('live', unknown, true, 1), 'Not yet confirmed');
    assert.match(connectionCopy('live', unknown, true), /not confirmed yet\. They are kept on this device and sent again/);
    assert.match(connectionCopy('live', unknown, false), /kept until this page closes/);
  }
  for (const state of ['connecting', 'stale', 'local-only', 'read-only', 'full', 'revoked'] as const) {
    for (const save of ['saved', 'pending', 'error', 'timeout']) assert.notEqual(saveLabel(state, save, true, 1), 'Saved', `${state}/${save}`);
  }
});

test('re-check P2-6: on phones the winning min-height of "Another position" is 44 px', () => {
  // Element: <button class="text-button"> in .practice-toolbar, in section.page.practice-page. Naive cascade:
  // rules active at 360 px wide, matching selectors made of classes on that chain, ranked by (classes, order).
  const chain = new Set(['page', 'practice-page', 'practice-toolbar', 'text-button']);
  const active = (media: string | null) => media === null || /max-width:\s*(650|850|1150)px/.test(media) && !/min-width/.test(media);
  const found: Array<{ spec: number; order: number; value: string }> = [];
  let order = 0;
  const visit = (block: string, media: string | null) => {
    const re = /@media([^{]*)\{((?:[^{}]*\{[^{}]*\})*)\s*\}|([^{}@]+)\{([^{}]*)\}/g;
    for (let m; (m = re.exec(block));) {
      if (m[1] !== undefined) { visit(m[2], m[1]); continue; }
      if (!active(media)) continue;
      const decl = /min-height:\s*([^;}\s]+)/.exec(m[4]); order++;
      if (!decl) continue;
      for (const sel of m[3].split(',').map(x => x.trim())) {
        const classes = sel.match(/\.[a-z0-9-]+/g) ?? [];
        if (!sel.endsWith('.text-button') || /[#\[:]|\b[a-z]+\./.test(sel.replace(/\.[a-z0-9-]+/g, '')) ) continue;
        if (!classes.every(c => chain.has(c.slice(1)))) continue;
        const spec = classes.length;
        found.push({ spec, order, value: decl[1] });
      }
    }
  };
  visit(css.replace(/\/\*[^]*?\*\//g, ''), null);
  assert.ok(found.some(f => f.value === '20px'), 'the base phone rule (20 px) is seen, so the check is live');
  const winner = [...found].sort((a, b) => b.spec - a.spec || b.order - a.order)[0];
  assert.equal(winner.value, '44px');
});
