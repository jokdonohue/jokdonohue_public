/**
 * Version 7.1 (brief m31, sections 3.2, 4.2 and 5; writer W3): what 7.1 leaves exactly as it was.
 *
 * Version 7.1 adds ONE document, `teach/meta`, in a collection of its own, and the page only reads it. So:
 * 1. the contract a version 6 or version 7 page reads (`src/contract/docs.ts`) keeps its hash, and so do the other
 *    frozen files the page side leans on;
 * 2. the new path is in no collection an open page lists whole, is no pack chunk, and has no schema in that contract;
 * 3. the 7.1 page writes nothing under `teach/`: checked on the page's own write paths over a store that holds the
 *    document, and by reading the page's sources for any other use of the path;
 * 4. with the document absent, malformed, of a later format (`v` 2) or stale, the model gives the pools and the page
 *    gives the hints, lessons, notes and viewers of a page with no document, with no docError (one line for a malformed
 *    one, which is still not a banner).
 *
 * Positions and cards are invented. No owner game data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Chess } from 'chess.js';
import {
  afterCardNotes, attemptFor, cardTitleOf, feedbackPosition, gameMoveViewer, hintLadderFor, lessonFor, notHeldSiblingIds, threatViewerOf,
} from '../components/Trainer';
import { buildPools, isPunish, type Pools, type TrainerItem } from '../components/pools';
import { createTrainerModel, type TrainerModel } from '../components/model';
import { buildProgress } from '../components/progress';
import { computeSnapshot } from '../components/snapshot';
import { explainInput } from '../components/coachInput';
import { COLLECTIONS, packChunkIds, paths, readDoc, type PackMetaDoc } from '../src/contract/docs';
import { createFakeStore, createMemoryKv, type DocData, type FakeStore, type Store } from '../src/contract/store';
import { TEACH_META_PATH } from '../src/contract/teachDocs';
import { createSessionWriter } from '../src/store/sessionWriter';
import { punishSiblingId } from '../src/teach/punish';
import { ARTIFACT_DIR } from './b3_paths';

/**
 * sha256 of the files 7.1 must not change, as version 7 has them (the version 7 tree list of 2026-11-13; the first is
 * also the version 6 value pinned in tests/m3_v6_frozen.test.ts). Brief m31 rule 1.3 and section 10 (03:06).
 *
 * Version 7.2 (24 Nov 2026) changes two of the page files on purpose and leaves the contract alone:
 * `components/Chessboard.tsx` (every piece a drawn shape from `pieceSet.ts`) and `components/Learn.tsx` (the piece
 * artwork credit and licence on the Sources panel). Those two moved to CHANGED_IN_72, which pins their 7.2 bytes so
 * that a later accidental edit still shows. The three contract files and the other page files are as version 7 had them.
 */
const FROZEN: Record<string, string> = {
  'src/contract/docs.ts': '52f5d1909dadc01dc4666ef718dce90f23a3c407787465c467425c5d42207257',
  'src/contract/store.ts': 'c28f9dc73ca2d4da176a4bc2bc4a19ff99ea209eaee5676bc7964752f6396a13',
  'src/contract/coach.ts': '58176263de3e6f45e331311b3c63641aaea530755d3d64078e1b28e55514b5b4',
  'components/LineViewer.tsx': 'c20de49564985096f0c6440d9cc557c05b16a6023d0b6f0bb00d070ed544159f',
  'components/CoachPanel.tsx': '0571615b162c796e5716a2b41388e88d59d7b1e759e3491c31e0bf214372330e',
  'src/teach/narrate.ts': '69c7f049b22a9be99939f0c2332d42d2a64c63387750d22ef4993da498c1001c',
};
/**
 * The two page files version 7.2 changed, at their 7.2 bytes. Their version 7 values were
 * 1f591e6c600003540f465eaa17d2509ae2783aafea971e9b448c625015d371ab (Chessboard.tsx) and
 * bd0300d57ead91703f5f93343dec50a2964d87bbe3f7f7389ef8d6ee443ade7f (Learn.tsx).
 * `reviews/claude/tools/pin72.py` rewrites the two values from the files; run it only for a change that is meant.
 * Version 7.3 (24 Nov 2026) changed both again on purpose, and the pins are their 7.3 bytes: `Chessboard.tsx` takes
 * `hintSquares` (an endgame drill's key squares, ringed together), and `Learn.tsx` shows the licence one line per
 * paragraph and credits the brown board's colours. Their 7.2 values were bb0ca9fd0c65fcc9… and b9822f572ba9fb33….
 */
const CHANGED_IN_72: Record<string, string> = {
  'components/Chessboard.tsx': 'cb6e5f72d630256e51d4387afd1ea9500b41978a2ae91adbb5a41b5e793a4892',
  'components/Learn.tsx': '10dd34ae4e0290a4fa27c7c879e77410b314d6af5518e082e541cac4832809ac',
};
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const after = (fen: string, uci: string) => { const b = new Chess(fen); b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); return b.fen(); };

// ---------------------------------------------------------------- an invented pack and its document

/** A mistake card with a quiet answer: the queen goes to e4 and Qxh7 is then mate. His game move Qe8 loses the queen. */
const Q_FEN = '5rk1/5ppp/1n6/8/8/3B4/4QPPP/6K1 w - - 0 1';
const mistake = { id: 'pack-q1', fen: Q_FEN, moves: ['e2e4'], rating: 1000, themes: ['personal', 'middlegame'], kind: 'mistake',
  pack: { playedSan: 'Qe8', playedUci: 'e2e8', pvUci: ['e2e4', 'g7g6'], refutationPvUci: ['f8e8'], winBefore: 88, winAfter: 3 } };
/** Its punish sibling (the position after Qe8; the rook takes the queen). The document may hold it. */
const afterQe8 = { id: 'punish-q1', fen: after(Q_FEN, 'e2e8'), moves: ['f8e8'], rating: 1000, themes: ['personal', 'punish'], kind: 'punish',
  pack: { playedSan: 'Qe8', playedUci: 'e2e8', sourceFen: Q_FEN, pvUci: ['f8e8'], rowId: 'q1', winAfter: 3, solverColor: 'b' } };
/** A punish card with a quiet answer, Black to solve: after his Nb3 the queen goes to e5 and Qxh2 is then mate. */
const P_SRC = '6k1/4qppp/3b4/8/8/8/3N1PPP/5RK1 w - - 0 1';
const quietPunish = { id: 'punish-q9', fen: after(P_SRC, 'd2b3'), moves: ['e7e5'], rating: 1000, themes: ['personal', 'punish', 'middlegame'], kind: 'punish',
  pack: { playedSan: 'Nb3', playedUci: 'd2b3', sourceFen: P_SRC, pvUci: ['e7e5', 'g2g3'], rowId: 'q9', winAfter: 20, solverColor: 'b' } };
/** A punish card where two replies win the queen. The document may hold it as not-unique. */
const D_SRC = '3r2k1/5ppp/5b2/8/8/8/5PPP/R2Q2K1 w - - 0 1';
const twoReplies = { id: 'punish-d1', fen: after(D_SRC, 'd1d4'), moves: ['f6d4'], rating: 1000, themes: ['personal', 'punish'], kind: 'punish', title: 'Punish it · Rapid · move 24',
  pack: { playedSan: 'Qd4', playedUci: 'd1d4', sourceFen: D_SRC, pvUci: ['f6d4', 'a1d1'], rowId: 'd1', winAfter: 3, solverColor: 'b' } };

const threat = { id: 'pack-q1', a: 'e2e4', t: ['e4h7'], k: 'mate', pre: false };
const punishThreat = { id: 'punish-q9', a: 'e7e5', t: ['e5h2'], k: 'mate', pre: false };
const teachDoc = (extra: DocData = {}): DocData => ({
  v: 1, teachVersion: 't20261114-0000aaaa', packVersion: 'v1', at: 1_794_000_000_000,
  cards: [threat, punishThreat],
  held: [{ id: 'punish-d1', a: 'f6d4', why: 'not-unique', alt: 'd8d4' }, { id: 'punish-q1', a: 'f8e8', why: 'not-held' }],
  ...extra,
});
const PACK_META: DocData = { packVersion: 'v1', importedAt: '2026-11-10T00:00:00Z', counts: { cards: 1 }, priors: {}, chunks: { cards: ['v1-cards-00'], special: [], punish: ['v1-punish-00'] }, profile: null };
function seed(): Record<string, DocData> {
  return {
    'settings/main': { rating: 1100, sessionLength: 12, updatedAt: 5, device: 'phone' },
    'pack/meta': PACK_META,
    'pack/v1-cards-00': { cards: [mistake] },
    'pack/v1-punish-00': { cards: [afterQe8, quietPunish, twoReplies] },
    'plan/current': { updatedAt: 1, author: 'claude', expires: '2099-01-01T00:00:00Z', focus: [], mix: { bank: 0.5, pack: 0.5, endgame: 0, agent: 0 } },
    'notes/n-1': { text: 'An invented note.', createdAt: 1_794_000_000_000 },
  };
}

interface Setup { store: FakeStore; model: TrainerModel; reads: string[]; listed: string[]; done: () => void }
/** The model over a fake store whose reads are recorded: every path read, and every document path a listing returned. */
async function setup(extra: Record<string, DocData> = {}): Promise<Setup> {
  const store = createFakeStore({ seed: { ...seed(), ...extra } });
  const reads: string[] = [], listed: string[] = [];
  const note = <T extends { path: string }>(docs: T[]) => { for (const d of docs) listed.push(d.path); return docs; };
  const recording = {
    ...store,
    get: (path: string) => { reads.push(`get ${path}`); return store.get(path); },
    query: (spec: { collection: string }) => { reads.push(`query ${spec.collection}`); return store.query(spec as never).then(note); },
    subscribe: (path: string, next: never, error?: never) => { reads.push(`subscribe ${path}`); return store.subscribe(path, next, error); },
    subscribeQuery: (spec: { collection: string }, next: (docs: Array<{ path: string }>, meta: never) => void, error?: never) => {
      reads.push(`subscribeQuery ${spec.collection}`);
      return store.subscribeQuery(spec as never, ((docs: Array<{ path: string }>, meta: never) => next(note(docs), meta)) as never, error);
    },
  } as unknown as Store;
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'laptop', events: null, debounceMs: 1 });
  const model = createTrainerModel({ store: recording, sessions, deviceId: 'laptop', readyTimeoutMs: 2000 });
  await tick(25);
  return { store, model, reads, listed, done: () => { model.dispose(); sessions.dispose(); } };
}
/** The pools as the Trainer builds them from the view (`components/Trainer.tsx`), without the bank and the drills. */
const poolsOf = (model: TrainerModel): Pools => { const v = model.get(); return buildPools({ bank: [], endgames: [], pack: v.pack, personal: v.personal, drills: v.drills, teach: v.teach }); };
/** Everything the page says about the own-game cards that the document could change, as plain data. */
function pageSays(pools: Pools) {
  const notHeld = notHeldSiblingIds(pools);
  return pools.own.map(item => {
    const sibling = isPunish(item) ? pools.byId.get(punishSiblingId(item) ?? '') : undefined;
    const explain = explainInput(item, { fen: item.fen, uci: new Chess(item.fen).moves({ verbose: true }).map(m => m.lan).find(u => u !== item.moves[0])!, index: 0 }, item.source, { sibling });
    return {
      id: item.id, hints: hintLadderFor(item, item.fen, 0), lesson: lessonFor(item, sibling), notes: afterCardNotes(item, notHeld.has(item.id)),
      threatViewer: threatViewerOf(item), gameMove: gameMoveViewer(item, null, notHeld.has(item.id)), coachLesson: explain?.lesson ?? null,
    };
  });
}

// ---------------------------------------------------------------- 1. hashes

test('7.1 keeps the contract and the other frozen page files byte for byte (sha256 pinned)', () => {
  for (const [file, sha] of Object.entries(CHANGED_IN_72)) {
    assert.equal(createHash('sha256').update(readFileSync(join(ARTIFACT_DIR, file))).digest('hex'), sha, `${file} is not the pinned file (version 7.3 bytes): pin the new bytes here if the change is meant`);
  }
  for (const [file, sha] of Object.entries(FROZEN)) {
    assert.equal(createHash('sha256').update(readFileSync(join(ARTIFACT_DIR, file))).digest('hex'), sha, `${file} changed: version 7.1 must not change it (brief m31 rule 1.3)`);
  }
});

// ---------------------------------------------------------------- 2. where the path is not

test('teach/meta is in no collection of the contract, is no pack chunk, and has no schema an older page could read it with', () => {
  assert.equal(TEACH_META_PATH, 'teach/meta');
  const [collection, docId] = TEACH_META_PATH.split('/');
  assert.ok(!(Object.values(COLLECTIONS) as string[]).includes(collection), 'outside COLLECTIONS, as selftest/* is');
  assert.ok(!Object.keys(COLLECTIONS).includes(collection));
  // No schema: the contract's reader gives null for it, whatever the body.
  assert.equal(readDoc(TEACH_META_PATH, teachDoc()), null);
  // A pack chunk lives under pack/; no chunk id, not even "meta" or "teach", can name the new document.
  const meta = readDoc<PackMetaDoc>('pack/meta', PACK_META)!;
  assert.ok(meta, 'the invented pack meta is a contract document');
  for (const id of [...packChunkIds(meta), docId, collection, 'teach-meta']) {
    assert.ok(paths.packChunkById(id).startsWith('pack/'), id);
    assert.notEqual(paths.packChunkById(id), TEACH_META_PATH);
  }
  assert.throws(() => paths.packChunkById('../teach/meta'));
  assert.ok(!packChunkIds(meta).some(id => id.includes('teach')));
});

test('an open 7.1 page reads teach/meta once, by its own path, and no listing it makes returns anything under teach/', async () => {
  const { model, reads, listed, done } = await setup({ [TEACH_META_PATH]: teachDoc() });
  try {
    assert.equal(model.get().ready, true);
    assert.deepEqual(reads.filter(r => / teach(\/|$)/.test(r)), [`subscribe ${TEACH_META_PATH}`]);
    const lists = [...new Set(reads.filter(r => /^(query|subscribeQuery) /.test(r)).map(r => r.split(' ')[1]))].sort();
    assert.deepEqual(lists, ['drills', 'feedback', 'notes', 'personal', 'sessions', 'summaries'], 'the collections the page lists whole');
    assert.ok(!lists.includes('teach'));
    assert.ok(listed.length > 0, 'the listings did return documents');
    assert.deepEqual(listed.filter(p => p.startsWith('teach/')), []);
    // The pack chunks it fetched are the ones the meta lists, under pack/.
    assert.deepEqual(reads.filter(r => r.startsWith('get pack/')).sort(), ['get pack/v1-cards-00', 'get pack/v1-punish-00']);
  } finally { done(); }
});

// ---------------------------------------------------------------- 3. no write under teach/

test('the 7.1 page writes nothing under teach/: an attempt, a note, settings, a read note and the read model, over a store that holds the document', async () => {
  for (const withDoc of [true, false]) {
    const { model, store, done } = await setup(withDoc ? { [TEACH_META_PATH]: teachDoc() } : {});
    try {
      const pools = poolsOf(model);
      const card = pools.byId.get('pack-q1')!;
      assert.ok(card, 'the mistake card is served');
      assert.equal(!!card.teach, withDoc);
      // The page's own writes, built as the Trainer builds them.
      const now = 1_794_500_000_000;
      const attempt = attemptFor({ item: card, revealed: false, clean: false, hints: 2, startedAt: now - 9000, now, playedUci: 'e2e8' });
      assert.equal(model.record(attempt), true);
      const at = feedbackPosition(card, { fen: card.fen, uci: 'e2e8', index: 0 });
      assert.equal(await model.sendFeedback({ kind: 'comment', item: { id: card.id, source: card.source, themes: card.themes, fen: at.fen }, playedUci: at.playedUci, text: 'An invented note about a quiet move.' }), true);
      assert.equal(await model.saveSettings({ rating: 1150 }), true);
      await model.markNoteRead('n-1');
      const v = model.get();
      const progress = buildProgress(v.attempts, v.settings, t => t);
      const body = computeSnapshot({
        attempts: v.attempts, progress, themesOf: t => t, priors: v.pack?.meta.priors, servableIds: pools.all.map(p => p.id),
        packIds: [...pools.own, ...pools.smallEdge, ...pools.missedWin, ...pools.notUnique, ...pools.notHeld].filter(p => p.source === 'pack').map(p => p.id),
        session: null, deviceId: 'laptop', now, docErrors: v.docErrors,
      });
      await store.set(paths.snapshot(), body);
      await tick(30);
      // Pack coverage counts every pack card, held or not, with or without the document.
      assert.deepEqual([...computeSnapshotIds(pools)].sort(), ['pack-q1', 'punish-d1', 'punish-q1', 'punish-q9']);
      const written = [...store.writeCounts.keys()].sort();
      assert.ok(written.some(p => p.startsWith('sessions/')) && written.some(p => p.startsWith('feedback/')) && written.includes('settings/main') && written.includes('notes/n-1') && written.includes(paths.snapshot()), `the page wrote its documents: ${written.join(', ')}`);
      assert.deepEqual(written.filter(p => p.startsWith('teach')), []);
      assert.deepEqual(Object.keys(store.dump()).filter(p => p.startsWith('teach')), withDoc ? [TEACH_META_PATH] : []);
      if (withDoc) assert.deepEqual(store.dump()[TEACH_META_PATH], teachDoc(), 'the stored document is untouched');
      // Every document it wrote is one the frozen contract reads (the page wrote no new kind of document).
      for (const path of written) assert.ok(readDoc(path, store.dump()[path]), `${path} parses under the frozen contract`);
    } finally { done(); }
  }
});
/** The ids the Trainer hands to the read model as the pack's cards (`packIds` in components/Trainer.tsx). */
function computeSnapshotIds(pools: Pools): Set<string> {
  return new Set([...pools.own, ...pools.smallEdge, ...pools.missedWin, ...pools.notUnique, ...pools.notHeld].filter(p => p.source === 'pack').map(p => p.id));
}

test('no page source names the path except the contract file that declares it and the model\'s one subscription', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full); else if (/\.(ts|tsx|js|mjs)$/.test(name)) files.push(full);
    }
  };
  for (const dir of ['components', 'src', 'lib', 'page']) walk(join(ARTIFACT_DIR, dir));
  assert.ok(files.length > 60, `${files.length} page source files read`);
  /** Without block comments, JSX comments and whole-line comments. */
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const naming: Record<string, number> = {}, literal: string[] = [];
  for (const file of files) {
    const rel = relative(ARTIFACT_DIR, file).split('\\').join('/');
    const text = code(readFileSync(file, 'utf8'));
    const n = text.split('TEACH_META_PATH').length - 1;
    if (n) naming[rel] = n;
    if (/['"`]teach(\/|['"`])/.test(text)) literal.push(rel);
  }
  // The constant: declared in the contract file; read by the model (import, the subscription, its error line); and by
  // the offline builder, which no page file imports (tests/m31_teach_docs.test.ts pins that).
  assert.deepEqual(Object.keys(naming).sort(), ['components/model.ts', 'src/contract/teachDocs.ts']);
  assert.equal(naming['components/model.ts'], 3);
  const model = code(readFileSync(join(ARTIFACT_DIR, 'components/model.ts'), 'utf8'));
  assert.equal(model.split('store.subscribe(TEACH_META_PATH').length - 1, 1, 'one subscription');
  assert.equal(model.split('noteDocError(TEACH_META_PATH').length - 1, 1, 'and its one error line');
  for (const call of ['set(TEACH_META_PATH', 'update(TEACH_META_PATH', 'delete(TEACH_META_PATH', 'get(TEACH_META_PATH']) assert.ok(!model.includes(call), call);
  // The path as a string literal: only where the constant is declared.
  assert.deepEqual(literal, ['src/contract/teachDocs.ts']);
});

// ---------------------------------------------------------------- 4. absent, malformed, a later format, stale

test('with the document absent, malformed, at v 2 or stale, the pools and what the page says are those of a page with no document', async () => {
  const none = await setup();
  const v7pools = poolsOf(none.model), v7says = pageSays(v7pools);
  assert.deepEqual(none.model.get().docErrors, []);
  assert.equal(none.model.get().teach, null);
  none.done();
  assert.deepEqual(v7pools.own.map(c => c.id), ['pack-q1', 'punish-q1', 'punish-q9', 'punish-d1'], 'every punish card is graded');
  assert.deepEqual([v7pools.notUnique, v7pools.notHeld], [[], []]);
  assert.ok(v7says.find(s => s.id === 'pack-q1')!.hints[0].text.endsWith('The right move is a quiet one: no capture and no check.'));
  assert.equal(v7says.find(s => s.id === 'pack-q1')!.gameMove!.title, 'What your game move Qe8 allowed');

  const states: Array<[string, DocData | null, number]> = [
    // name, the stored document (null: none), docError lines
    ['absent', null, 0],
    ['malformed: cards is not a list', teachDoc({ cards: 'nope' }), 1],
    ['malformed: no teachVersion', teachDoc({ teachVersion: undefined as never }), 1],
    ['malformed: not an object of this shape', { hello: 'world' }, 1],
    ['a later format, v 2', teachDoc({ v: 2 }), 0],
    ['a later format with another shape', { v: 2, lessons: [{ id: 'pack-q1', text: 'x' }] }, 0],
    ['stale: every entry and row is for another answer', teachDoc({
      cards: [{ ...threat, a: 'e2e3' }, { ...punishThreat, a: 'e7e6' }],
      held: [{ id: 'punish-d1', a: 'd8d4', why: 'not-unique', alt: 'f6d4' }, { id: 'punish-q1', a: 'g8h8', why: 'not-held' }],
    }), 0],
    ['about cards this pack does not hold', teachDoc({ cards: [{ ...threat, id: 'pack-zz' }], held: [{ id: 'punish-zz', a: 'f6d4', why: 'not-held' }] }), 0],
  ];
  for (const [name, data, errors] of states) {
    const { model, done } = await setup(data ? { [TEACH_META_PATH]: data } : {});
    try {
      const v = model.get();
      assert.equal(v.ready, true, name);
      assert.equal(v.error, '', `${name}: no banner`);
      assert.equal(v.docErrors.length, errors, `${name}: docError lines`);
      if (errors) assert.equal(v.docErrors[0].path, TEACH_META_PATH, name);
      const pools = poolsOf(model);
      assert.deepEqual(pools, v7pools, `${name}: the pools`);
      assert.deepEqual(pageSays(pools), v7says, `${name}: hints, lessons, notes, viewers and the coach's lesson`);
      assert.deepEqual([...notHeldSiblingIds(pools)], [], name);
      assert.equal(cardTitleOf(pools)('punish-d1'), 'Punish it · Rapid · move 24', `${name}: a note on that card keeps its title`);
    } finally { done(); }
  }
});

test('the same pack with a good document: the control for the test above (the document does change the page)', async () => {
  const { model, done } = await setup({ [TEACH_META_PATH]: teachDoc() });
  try {
    assert.deepEqual(model.get().docErrors, []);
    const pools = poolsOf(model);
    assert.deepEqual(pools.own.map(c => c.id), ['pack-q1', 'punish-q9'], 'the two held cards left the board');
    assert.deepEqual([pools.notUnique.map(c => c.id), pools.notHeld.map(c => c.id)], [['punish-d1'], ['punish-q1']]);
    assert.deepEqual([...notHeldSiblingIds(pools)], ['pack-q1']);
    const says = pageSays(pools);
    const m = says.find(s => s.id === 'pack-q1')!, p = says.find(s => s.id === 'punish-q9')!;
    assert.equal(m.hints[0].text, 'The right move is a quiet one, but it threatens checkmate.');
    assert.equal(m.notes.threat, 'Qe4 threatens checkmate. If Black made no move in reply: Qxh7#.');
    assert.equal(m.notes.gameMove, null, 'its punish sibling is held as not-held: no words');
    assert.equal(m.gameMove!.title, 'The engine\'s line after your game move Qe8');
    assert.equal(m.threatViewer!.title, 'What Qe4 threatens');
    assert.ok(p.lesson!.includes('It threatens checkmate. If White made no move in reply: Qxh2#.'));
    assert.equal(p.coachLesson, p.lesson, 'the coach reads the page\'s lesson');
    assert.equal(cardTitleOf(pools)('punish-d1'), 'Punish it · Rapid · move 24');
  } finally { done(); }
});
