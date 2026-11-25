import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFakeStore, createMemoryKv, StoreError, type DocData, type QuerySpec, type Store } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { answeredFeedbackFrom, createTrainerModel } from '../components/model';
import { AnswersPanel, CardAnswer, MAX_ANSWERS_SHOWN, answeredNotes, type AnsweredNote } from '../components/HomePanels';
import type { FeedbackDoc } from '../src/contract/docs';

// M3 (L7, brief 9.5): answered notes in the model, the From Claude panel and on the card. Invented ids and texts only.
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const fb = (at: number, extra: Partial<FeedbackDoc> = {}): FeedbackDoc => ({
  at, kind: 'comment', itemId: '00AbC', source: 'bank', themes: ['fork'], fen: FEN, sessionId: 's-1-phone', status: 'done', reply: 'An answer.', text: 'A question.', ...extra,
});
const path = (at: number) => `feedback/f-${at}-phone`;

async function setup(seed: Record<string, DocData>, wrap?: (store: Store) => Store) {
  const store = createFakeStore({ seed: { 'settings/main': { rating: 1000, sessionLength: 10, updatedAt: 1, device: 'phone' }, ...seed } });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'laptop', events: null, debounceMs: 1 });
  const model = createTrainerModel({ store: wrap ? wrap(store) : store, sessions, deviceId: 'laptop', readyTimeoutMs: 1000 });
  await tick(20);
  return { store, model, done: () => { model.dispose(); sessions.dispose(); } };
}

test('model: answered notes are the done ones with a reply, newest first; open feedback is unchanged', async () => {
  const { store, model, done } = await setup({
    [path(1000)]: { ...fb(1000), status: 'open', reply: undefined },
    [path(2000)]: { ...fb(2000, { kind: 'wrong', text: undefined, reply: 'The line is right.' }) },
    [path(3000)]: { ...fb(3000) },
    [path(2500)]: { ...fb(2500), reply: undefined },
    [path(2600)]: { ...fb(2600, { reply: '   ' }) },
    [path(2700)]: { ...fb(2700, { reply: 'x'.repeat(1001) }) },
  });
  try {
    const v = model.get();
    assert.deepEqual(v.answeredFeedback.map(f => f.id), ['f-3000-phone', 'f-2000-phone'], 'no reply, a blank reply and an invalid document are left out');
    assert.equal(v.answeredFeedback[1].doc.reply, 'The line is right.');
    assert.deepEqual(v.openFeedback.map(f => f.id), ['f-1000-phone']);
    assert.equal(v.flaggedWrong.has('00AbC'), false, 'a closed flag sets nothing aside');
    assert.equal(v.error, '');
    // Claude answers the open note: it moves from open to answered.
    await store.update(path(1000), { status: 'done', reply: 'Here is why.' });
    await tick(20);
    assert.deepEqual(model.get().answeredFeedback.map(f => f.id), ['f-3000-phone', 'f-2000-phone', 'f-1000-phone']);
    assert.deepEqual(model.get().openFeedback, []);
  } finally { done(); }
});

test('model: the newest 100 answered notes are read (ordered by the note time, not by id)', async () => {
  // Ids sort as text (f-1-, f-10-, f-100-, ...), so an id-ordered window would keep the wrong ones.
  const seed: Record<string, DocData> = {};
  for (let at = 1; at <= 101; at++) seed[path(at)] = { ...fb(at) };
  const { model, done } = await setup(seed);
  try {
    const ats = model.get().answeredFeedback.map(f => f.doc.at);
    assert.equal(ats.length, 100);
    assert.equal(ats[0], 101);
    assert.equal(ats[99], 2);
    assert.ok(!ats.includes(1), 'the oldest is outside the window');
  } finally { done(); }
});

test('model: one new query for answered notes; the open-feedback query is as before', async () => {
  const specs: QuerySpec[] = [];
  const spy = (store: Store): Store => ({ ...store, subscribeQuery: (spec, next, error) => { specs.push(spec); return store.subscribeQuery(spec, next, error); } });
  const { done } = await setup({}, spy);
  try {
    const feedback = specs.filter(s => s.collection === 'feedback');
    assert.equal(feedback.length, 2);
    assert.deepEqual(feedback[0], { collection: 'feedback', where: [['status', '==', 'open']], limit: 1000 });
    assert.deepEqual(feedback[1], { collection: 'feedback', where: [['status', '==', 'done']], orderBy: { field: 'at', dir: 'desc' }, limit: 100 });
  } finally { done(); }
});

test('model: a failed answered-notes query leaves the list empty, with no banner and no wait', async () => {
  const failing = (store: Store): Store => ({
    ...store,
    subscribeQuery: (spec, next, error) => {
      if (spec.collection === 'feedback' && spec.where?.[0]?.[2] === 'done') {
        const t = setTimeout(() => error?.(new StoreError('unavailable', 'injected')), 0);
        return () => clearTimeout(t);
      }
      return store.subscribeQuery(spec, next, error);
    },
  });
  const { model, done } = await setup({ [path(1000)]: { ...fb(1000), status: 'open', reply: undefined }, [path(2000)]: { ...fb(2000) } }, failing);
  try {
    const v = model.get();
    assert.equal(v.ready, true);
    assert.equal(v.error, '');
    assert.deepEqual(v.answeredFeedback, []);
    assert.deepEqual(v.openFeedback.map(f => f.id), ['f-1000-phone']);
  } finally { done(); }
  // A query that never answers does not hold the page back (the load timer here is 1000 ms).
  const silent = (store: Store): Store => ({
    ...store,
    subscribeQuery: (spec, next, error) => (spec.collection === 'feedback' && spec.where?.[0]?.[2] === 'done' ? () => {} : store.subscribeQuery(spec, next, error)),
  });
  const quiet = await setup({}, silent);
  try { assert.equal(quiet.model.get().ready, true); } finally { quiet.done(); }
});

test('answeredFeedbackFrom: valid, done, replied; newest first, ties by id', () => {
  const docs = [
    { id: 'f-5-a', path: 'feedback/f-5-a', data: fb(5) },
    { id: 'f-5-b', path: 'feedback/f-5-b', data: fb(5) },
    { id: 'f-9-a', path: 'feedback/f-9-a', data: fb(9, { status: 'open' }) },
    { id: 'f-7-a', path: 'feedback/f-7-a', data: { nonsense: true } },
  ];
  assert.deepEqual(answeredFeedbackFrom(docs).map(f => f.id), ['f-5-b', 'f-5-a']);
});

const note = (at: number, extra: Partial<FeedbackDoc> = {}): AnsweredNote => ({ id: `f-${at}-phone`, doc: fb(at, extra) });
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 12);

test('AnswersPanel: newest first, at most 10, with date, title or kind, his note and the reply', () => {
  const items = Array.from({ length: 12 }, (_, i) => note(T0 + i * DAY, { text: `Question ${i}.`, reply: `Answer ${i}.` }));
  const before = items.map(i => i.id);
  const html = renderToStaticMarkup(<AnswersPanel items={items} titleOf={() => null}/>);
  assert.equal(MAX_ANSWERS_SHOWN, 10);
  assert.ok(html.startsWith('<section class="surface plan-notes answers-panel" aria-label="Answers to your notes" style="overflow-wrap:anywhere"><div class="notes"><h2>Answers to your notes</h2>'));
  assert.equal((html.match(/<article class="note">/g) ?? []).length, 10);
  const order = [...html.matchAll(/Answer (\d+)\./g)].map(m => Number(m[1]));
  assert.deepEqual(order, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2], 'the two oldest are not shown');
  assert.ok(html.includes(new Date(T0 + 11 * DAY).toLocaleDateString()), 'date as the notes panel shows it');
  assert.match(html, /<strong>Your note: <\/strong>Question 11\./);
  assert.match(html, /<strong>Claude: <\/strong>Answer 11\./);
  assert.deepEqual(items.map(i => i.id), before, 'the caller\'s list is not reordered');
});

test('AnswersPanel: the card title when known, else the kind; what he sent when there is no text', () => {
  const items = [
    note(T0 + 5, { itemId: 'punish-x1', source: 'pack' }),
    note(T0 + 4, { kind: 'wrong', text: undefined, itemId: '00XyZ', source: 'bank' }),
    note(T0 + 3, { kind: 'too-hard', text: undefined, itemId: 'tech-kpk', source: 'endgame' }),
    note(T0 + 2, { itemId: 'agent-set-1', source: 'agent' }),
    note(T0 + 1, { kind: 'more', text: 'More pins.', itemId: 'pack-abc', source: 'pack' }),
  ];
  const titles: Record<string, string> = { 'punish-x1': 'Punish it · Rapid · 2026-01-01 · move 9' };
  const html = renderToStaticMarkup(<AnswersPanel items={items} titleOf={id => titles[id] ?? null}/>);
  const date = (ms: number) => new Date(ms).toLocaleDateString();
  assert.ok(html.includes(`${date(T0 + 5)} · Punish it · Rapid · 2026-01-01 · move 9`));
  assert.ok(html.includes(`${date(T0 + 4)} · Lichess puzzle`));
  assert.ok(html.includes(`${date(T0 + 3)} · Endgame drill`));
  assert.ok(html.includes(`${date(T0 + 2)} · Practice line from Claude`));
  assert.ok(html.includes(`${date(T0 + 1)} · Position from your game`));
  assert.match(html, /<p class="small">You reported that something is wrong\.<\/p>/);
  assert.match(html, /<p class="small">You marked it too hard\.<\/p>/);
  assert.match(html, /<p class="small">You asked for more like this\.<\/p><p><strong>Your note: <\/strong>More pins\.<\/p>/);
  assert.equal((html.match(/You left a note/g) ?? []).length, 0, 'a comment with text shows the text only');
});

test('AnswersPanel and CardAnswer: replies and notes are plain text; line breaks are kept', () => {
  const evil = note(T0, { text: 'Line one\nLine <two>', reply: '<b>Bold</b> & <script>alert(1)</script>' });
  for (const html of [renderToStaticMarkup(<AnswersPanel items={[evil]} titleOf={() => '<i>t</i>'}/>), renderToStaticMarkup(<CardAnswer items={[evil]}/>)]) {
    assert.doesNotMatch(html, /<script|<b>|<i>/);
    assert.ok(html.includes('&lt;b&gt;Bold&lt;/b&gt; &amp; &lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('Line one<br/>Line &lt;two&gt;'));
  }
});

test('AnswersPanel and CardAnswer: nothing answered renders nothing', () => {
  const unanswered = [note(T0, { reply: undefined }), note(T0 + 1, { reply: '  ' }), note(T0 + 2, { status: 'open' })];
  assert.deepEqual(answeredNotes(unanswered), []);
  assert.equal(renderToStaticMarkup(<AnswersPanel items={unanswered} titleOf={() => null}/>), '');
  assert.equal(renderToStaticMarkup(<AnswersPanel items={[]} titleOf={() => null}/>), '');
  assert.equal(renderToStaticMarkup(<CardAnswer items={unanswered}/>), '');
  assert.equal(renderToStaticMarkup(<CardAnswer items={[]}/>), '');
});

test('CardAnswer: "Claude\'s answer to your note" with the date, his note and the reply', () => {
  const one = renderToStaticMarkup(<CardAnswer items={[note(T0, { text: 'Why not Re1?', reply: 'Re1 drops the back rank.' })]}/>);
  assert.ok(one.startsWith('<section class="coach-answer card-answer" aria-label="Claude&#x27;s answer to your note" style="overflow-wrap:anywhere"><h3>Claude&#x27;s answer to your note</h3>'));
  assert.ok(one.includes(`<p class="small">${new Date(T0).toLocaleDateString()}</p>`));
  assert.match(one, /<strong>Your note: <\/strong>Why not Re1\?<\/p><p><strong>Claude: <\/strong>Re1 drops the back rank\.<\/p>/);
  const two = renderToStaticMarkup(<CardAnswer items={[note(T0, { reply: 'First.' }), note(T0 + DAY, { reply: 'Second.' })]}/>);
  assert.match(two, /<h3>Claude&#x27;s answers to your notes<\/h3>/);
  assert.ok(two.indexOf('Second.') < two.indexOf('First.'), 'newest first');
});
