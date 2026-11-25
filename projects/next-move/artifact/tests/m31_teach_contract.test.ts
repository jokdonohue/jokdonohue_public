import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readTeachMeta, teachHeldSchema, teachMetaShape, teachThreatSchema, TEACH_FORMAT, TEACH_MAX_BYTES, TEACH_MAX_PLIES, TEACH_META_PATH,
  type TeachMetaDoc,
} from '../src/contract/teachDocs';
import { assertDocPath, COLLECTIONS, docBytes, MAX_DOC_BYTES, parsePackChunkId, readDoc, schemaForPath } from '../src/contract/docs';
import { createFakeStore } from '../src/contract/store';

// Version 7.1 (brief m31, 3.2): the reader of `teach/meta`. Invented entries only: ids, moves and squares below come
// from no game.

const threat = (extra: Record<string, unknown> = {}) => ({ id: 'pack-t:1', a: 'd1d5', t: ['d5a5'], k: 'capture', sq: 'a5', r: 'undefended', pre: false, ...extra });
const held = (extra: Record<string, unknown> = {}) => ({ id: 'punish-t:2', a: 'c3d5', why: 'not-unique', alt: 'c3e4', ...extra });
const doc = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1, teachVersion: 't20261114-0123abcd', packVersion: 'p20261110-00000000', at: 1_794_000_000_000, cards: [threat()], held: [held()], ...extra,
});

test('teach contract: the path is a document path in a collection of its own, outside the frozen contract', () => {
  assert.equal(TEACH_META_PATH, 'teach/meta');
  assert.equal(assertDocPath(TEACH_META_PATH), TEACH_META_PATH);
  assert.ok(!Object.values(COLLECTIONS).includes('teach' as never), 'teach is not a contract collection');
  // The frozen contract has no schema for it: the tolerant reader gives null and the strict one knows nothing.
  assert.equal(schemaForPath(TEACH_META_PATH), null);
  assert.equal(readDoc(TEACH_META_PATH, doc()), null);
  // Not a pack chunk id, so no pack loader can take it for one.
  assert.equal(parsePackChunkId('meta'), null);
  assert.equal(TEACH_FORMAT, 1);
  assert.equal(TEACH_MAX_PLIES, 8);
  assert.equal(TEACH_MAX_BYTES, 153_600);
  assert.ok(TEACH_MAX_BYTES < MAX_DOC_BYTES, 'the builder limit is under the store limit');
});

test('teach contract: a good document is read whole, with unknown fields kept', () => {
  const r = readTeachMeta(doc({ later: 'kept', cards: [threat({ future: 7 }), threat({ id: 'pack-t:3', k: 'mate', sq: undefined, r: undefined, t: ['e4h7'], a: 'e2e4' })] }));
  assert.equal(r.ok, true);
  assert.equal(r.newer, false);
  assert.equal(r.issue, '');
  assert.equal(r.skipped, 0);
  assert.equal(r.teachVersion, 't20261114-0123abcd');
  assert.deepEqual(r.cards.map(c => c.id), ['pack-t:1', 'pack-t:3']);
  assert.equal((r.cards[0] as unknown as { future: number }).future, 7, 'an entry keeps a field a later session added');
  assert.deepEqual(r.held, [held()]);
  // Optional parts: an entry without sq, r and pin; a held row without alt; reserved chunks.
  const bare = readTeachMeta(doc({ cards: [{ id: 'x', a: 'e2e4', t: ['e4h7'], k: 'mate', pre: false }], held: [{ id: 'y', a: 'e2e4', why: 'not-held' }], chunks: [] }));
  assert.equal(bare.ok, true);
  assert.equal(bare.skipped, 0);
  assert.deepEqual(bare.cards[0], { id: 'x', a: 'e2e4', t: ['e4h7'], k: 'mate', pre: false });
  assert.deepEqual(bare.held[0], { id: 'y', a: 'e2e4', why: 'not-held' });
  // A kind or a reason this page does not know is still read; the page module decides what to do with it.
  assert.equal(readTeachMeta(doc({ cards: [threat({ k: 'fork', r: 'overloaded' })] })).cards.length, 1);
});

test('teach contract: absent gives no issue; a later format is ignored without an issue', () => {
  for (const absent of [undefined, null]) {
    assert.deepEqual(readTeachMeta(absent), { ok: false, teachVersion: '', cards: [], held: [], skipped: 0, issue: '', newer: false });
  }
  for (const v of [2, 3, 1.5, 99]) {
    // Whatever else a later format holds, this page does not judge it.
    const r = readTeachMeta({ v, cards: 'another shape', anything: true });
    assert.deepEqual(r, { ok: false, teachVersion: '', cards: [], held: [], skipped: 0, issue: '', newer: true }, `v ${v}`);
  }
});

test('teach contract: an unreadable document gives one issue text and no entries', () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ['a string', 'teach', /expected an object/],
    ['an array', [doc()], /expected an object/],
    ['v missing', doc({ v: undefined }), /^v: /],
    ['v 0', doc({ v: 0 }), /^v: /],
    ['v as text', doc({ v: '1' }), /^v: /],
    ['no teachVersion', doc({ teachVersion: undefined }), /^teachVersion: /],
    ['teachVersion not a path segment', doc({ teachVersion: 'a/b' }), /^teachVersion: /],
    ['no packVersion', doc({ packVersion: undefined }), /^packVersion: /],
    ['at as text', doc({ at: 'today' }), /^at: /],
    ['at negative', doc({ at: -1 }), /^at: /],
    ['cards not a list', doc({ cards: { a: 1 } }), /^cards: /],
    ['held missing', doc({ held: undefined }), /^held: /],
  ];
  for (const [name, data, re] of bad) {
    const r = readTeachMeta(data);
    assert.equal(r.ok, false, name);
    assert.equal(r.newer, false, name);
    assert.match(r.issue, re, name);
    assert.ok(r.issue.length <= 300, name);
    assert.deepEqual([r.cards, r.held, r.skipped], [[], [], 0], name);
  }
});

test('teach contract: entries are read one by one; a bad one is skipped and counted, the rest are used', () => {
  const badThreats: Array<[string, Record<string, unknown>]> = [
    ['no id', threat({ id: undefined })],
    ['id not a path segment', threat({ id: 'a b' })],
    ['answer not UCI', threat({ a: 'Rd5' })],
    ['empty line', threat({ t: [] })],
    ['nine plies', threat({ t: Array.from({ length: 9 }, () => 'd5a5') })],
    ['a ply that is not UCI', threat({ t: ['d5a5', 'O-O'] })],
    ['line not a list', threat({ t: 'd5a5' })],
    ['no kind', threat({ k: undefined })],
    ['kind not text', threat({ k: 3 })],
    ['square off the board', threat({ sq: 'i9' })],
    ['pin off the board', threat({ pin: 'e0' })],
    ['pre missing', threat({ pre: undefined })],
    ['pre as text', threat({ pre: 'false' })],
  ];
  for (const [name, entry] of badThreats) {
    const r = readTeachMeta(doc({ cards: [threat({ id: 'pack-t:0' }), entry, threat({ id: 'pack-t:9' })] }));
    assert.equal(r.ok, true, name);
    assert.equal(r.skipped, 1, name);
    assert.deepEqual(r.cards.map(c => c.id), ['pack-t:0', 'pack-t:9'], name);
    assert.match(r.issue, /^1 entry skipped: cards\.1/, name);
    assert.equal(r.held.length, 1, name);
  }
  const badHeld: Array<[string, Record<string, unknown>]> = [
    ['no id', held({ id: undefined })], ['answer not UCI', held({ a: 'x' })], ['no why', held({ why: undefined })], ['alt not UCI', held({ alt: 'Ne4' })],
  ];
  for (const [name, entry] of badHeld) {
    const r = readTeachMeta(doc({ held: [entry, held({ id: 'punish-t:8' })] }));
    assert.equal(r.ok, true, name);
    assert.equal(r.skipped, 1, name);
    assert.deepEqual(r.held.map(h => h.id), ['punish-t:8'], name);
    assert.match(r.issue, /^1 entry skipped: held\.0/, name);
    assert.equal(r.cards.length, 1, name);
  }
  // Several bad entries: all counted, the first one named.
  const many = readTeachMeta(doc({ cards: [threat({ t: [] }), 5, null, threat()], held: ['x', held()] }));
  assert.deepEqual([many.ok, many.skipped, many.cards.length, many.held.length], [true, 4, 1, 1]);
  assert.match(many.issue, /^4 entries skipped: cards\.0/);
  // A second entry for one card: the first wins, the second is skipped.
  const twice = readTeachMeta(doc({ cards: [threat({ k: 'capture' }), threat({ k: 'mate' })], held: [held(), held({ why: 'not-held' })] }));
  assert.deepEqual([twice.skipped, twice.cards.length, twice.cards[0].k, twice.held.length, twice.held[0].why], [2, 1, 'capture', 1, 'not-unique']);
});

test('teach contract: an issue text never carries a card id or a move', () => {
  const secretId = 'pack-secret:77', secretMove = 'h7h8q';
  const samples = [
    doc({ cards: [threat({ id: secretId, a: secretMove, t: [secretMove, 'zz'] })] }),
    doc({ cards: [threat({ id: secretId, a: secretMove, k: 12 })] }),
    doc({ cards: [threat({ id: secretId, a: secretMove, sq: secretMove })] }),
    doc({ cards: [threat({ id: secretId, a: secretMove }), threat({ id: secretId, a: secretMove })] }),
    doc({ held: [held({ id: secretId, a: secretMove, alt: `${secretMove}x` })] }),
    doc({ held: [held({ id: secretId, a: secretMove, why: 7 })] }),
    doc({ teachVersion: `${secretId}/x` }),
  ];
  for (const s of samples) {
    const r = readTeachMeta(s);
    assert.notEqual(r.issue, '');
    assert.ok(!r.issue.includes('secret') && !r.issue.includes(secretMove), r.issue);
  }
  // No enum anywhere: an enum issue would echo the value it received.
  for (const schema of [teachThreatSchema, teachHeldSchema, teachMetaShape]) {
    assert.ok(!JSON.stringify(schema._def, (_k, v) => (typeof v === 'function' ? undefined : v)).includes('ZodEnum'));
  }
});

test('teach contract: never throws on odd input', () => {
  const odd: unknown[] = [0, 1, '', 'x', true, [], [[]], () => 1, { v: 1 }, { v: null }, { v: Number.NaN }, { v: Infinity, cards: [] }, { cards: [], held: [] }, Object.create(null), new Map()];
  for (const o of odd) assert.doesNotThrow(() => readTeachMeta(o));
  assert.equal(readTeachMeta({ v: Infinity }).ok, false);
  assert.equal(readTeachMeta({ v: Number.NaN }).newer, false);
});

test('teach contract: a full-size document fits the store, and the fake store keeps it byte for byte', async () => {
  // 850 entries of the greatest length the format allows (8 plies, a target and a pin) stay under the 150 KiB the
  // builder keeps to, and well under the store limit.
  const cards = Array.from({ length: 850 }, (_, i) => threat({ id: `pack-1000000${String(i).padStart(4, '0')}:10`, t: Array.from({ length: 8 }, () => 'd5a5'), pin: 'e8', r: 'pinned' }));
  const big = doc({ cards, held: [] }) as unknown as TeachMetaDoc;
  const bytes = docBytes(big);
  assert.ok(bytes < TEACH_MAX_BYTES, `${bytes} bytes`);
  const r = readTeachMeta(big);
  assert.deepEqual([r.ok, r.cards.length, r.skipped], [true, 850, 0]);
  const store = createFakeStore();
  await store.set(TEACH_META_PATH, big as unknown as Record<string, unknown>);
  const back = await store.get(TEACH_META_PATH);
  assert.deepEqual(back?.data, big);
  assert.equal(readTeachMeta(back?.data).cards.length, 850);
});
