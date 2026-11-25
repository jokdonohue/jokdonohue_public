/**
 * M3 C-core stage (c) (brief 9.6, L10): every document the M3 page writes is a version-6 document.
 *
 * `src/contract/docs.ts` is frozen for M3: its sha256 is pinned below to the version-6 value (the list of the live
 * version-6 tree taken before M3), so `readDoc` and the schemas imported here ARE the version-6 contract. The
 * documents come from the page's own write paths: the attempt `finish()` builds (`attemptFor`) through the model and
 * the session writer, notes through `model.sendFeedback` with the position `feedbackPosition` picks, explain and ask
 * answers through the coach client (`createCoach`, stub sampler), and settings through `model.saveSettings`.
 *
 * zod drops keys it does not know when a document is written (`prepareWrite`, `model.record`), so re-reading the store
 * alone could never show a new field. Each check compares what the page built with what was stored, field for field.
 *
 * Positions are invented (the drills are the page's own textbook drills). No owner game data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { attemptFor, feedbackPosition, gradeCardTry } from '../components/Trainer';
import type { TrainerItem } from '../components/pools';
import { createTrainerModel } from '../components/model';
import { buildAskInput, explainInput } from '../components/coachInput';
import { COOLDOWN_MS, createCoach } from '../src/coach/index';
import { memoryKv } from '../src/coach/rateLimit';
import { ATTEMPT_SOURCES, FEEDBACK_KINDS, explanationDoc, feedbackDoc, readDoc, sessionAttemptSchema, settingsDoc, type SessionAttempt, type SessionDoc } from '../src/contract/docs';
import { createFakeStore, createMemoryKv, type DocData } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import type { TryCheck } from '../src/teach/tryMove';
import { endgameDrills } from '../lib/endgames';
import { ARTIFACT_DIR } from './b3_paths';

/** sha256 of `src/contract/docs.ts` in version 6 (`./src/contract/docs.ts` in the version-6 tree list, 2026-11-10). */
const V6_DOCS_SHA256 = '52f5d1909dadc01dc4666ef718dce90f23a3c407787465c467425c5d42207257';
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
function after(fen: string, uci: string) {
  const b = new Chess(fen);
  const m = b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return { fen: b.fen(), san: m.san };
}
/** The keys a version-6 object schema knows. */
const keysOf = (schema: { shape: Record<string, unknown> }) => new Set(Object.keys(schema.shape));
function onlyKnownKeys(doc: Record<string, unknown>, known: Set<string>, what: string) {
  for (const k of Object.keys(doc)) assert.ok(known.has(k), `${what}: "${k}" is not a version-6 field`);
}
/** Every document a flow wrote is in a collection version 6 reads with these schemas, and parses there. */
function onlyV6Collections(dump: Record<string, DocData>) {
  for (const [path, data] of Object.entries(dump)) {
    assert.match(path, /^(settings|sessions|feedback|explanations)\//, path);
    assert.ok(readDoc(path, data), `${path} parses under version 6`);
  }
}

// ---------------------------------------------------------------- invented cards

/** His game (White): Re7 leaves the back rank; Black (the solver) plays Rd1+ Re1 Rxe1#. Better was h3. */
const BEFORE = '3r2k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';
const PUNISH_FEN = after(BEFORE, 'e1e7').fen;
const punish: TrainerItem = {
  id: 'punish-t1', fen: PUNISH_FEN, moves: ['d8d1'], rating: 1000, themes: ['personal', 'opening'], gameUrl: '', source: 'pack', kind: 'punish',
  title: 'Punish it · Rapid · move 30',
  pack: { playedSan: 'Re7', playedUci: 'e1e7', sourceFen: BEFORE, pvUci: ['d8d1', 'e7e1', 'd1e1'], rowId: 't1', winAfter: 2, solverColor: 'b' },
};
const sibling: TrainerItem = { id: 'pack-t1', fen: BEFORE, moves: ['h2h3'], rating: 1000, themes: ['personal'], gameUrl: '', source: 'pack', kind: 'mistake', pack: { playedSan: 'Re7', playedUci: 'e1e7', pvUci: ['h2h3', 'd8d1', 'e1d1'] } };
const FRENCH = 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6 0 3';
const bank: TrainerItem = { id: 'bank-french', fen: FRENCH, moves: ['b1c3', 'g8f6', 'c1g5'], rating: 1400, themes: ['opening', 'advantage'], gameUrl: '', source: 'bank' };
const agent: TrainerItem = { id: 'agent-back-rank', fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', moves: ['a1a8'], rating: 900, themes: ['mateIn1'], gameUrl: '', source: 'agent', title: 'Back rank' };
const personal: TrainerItem = { ...agent, id: 'personal-1', source: 'personal', themes: ['personal'], title: undefined };
const kpkSource = endgameDrills.find(d => d.id === 'tech-kpk-take-the-opposition')!;
const kpk: TrainerItem = { id: kpkSource.id, fen: kpkSource.fen, moves: [...kpkSource.moves], rating: kpkSource.rating, themes: [...kpkSource.themes], gameUrl: '', source: 'endgame', title: kpkSource.title };
/** An engine check of Black's 1...h6 on the punish card that rates it about as highly as the card's move (also good).
 *  Fix round 2 (9.11.2 p): the page grades it as a soft retry; it is never accepted. */
const alsoGood: TryCheck = { tryUci: 'h7h6', trySan: 'h6', replyLine: ['g1f1', 'd8d1', 'e7e1'], tryWin: 96.4, bestWin: 99.6, verdict: 'also-good', depth: 12, ms: 40 };
const strong: TryCheck = { ...alsoGood, tryWin: 75.1, verdict: 'worse' };

test('src/contract/docs.ts is the version-6 contract (sha256 pinned)', () => {
  const sha = createHash('sha256').update(readFileSync(join(ARTIFACT_DIR, 'src/contract/docs.ts'))).digest('hex');
  assert.equal(sha, V6_DOCS_SHA256, 'docs.ts changed: M3 must not change the contract a version-6 page reads (L10)');
  // The closed lists M3 writes into, as version 6 has them.
  assert.deepEqual([...ATTEMPT_SOURCES], ['bank', 'pack', 'endgame', 'agent', 'personal']);
  assert.deepEqual([...FEEDBACK_KINDS], ['wrong', 'more', 'less', 'too-hard', 'too-easy', 'comment']);
});

test('session attempts the M3 page records (a soft retry on an also-good try among them) are version-6 attempts, stored exactly as built', async () => {
  // Fix round 2 (9.11.2 p): this line pinned 'accept'. A near try is a soft retry now; the records below are unchanged.
  assert.equal(gradeCardTry(punish, PUNISH_FEN, 'h7h6', 0, alsoGood).grade.action, 'soft', 'the fixture is a soft retry, never accepted');
  assert.equal(gradeCardTry(punish, PUNISH_FEN, 'h7h6', 0, strong).grade.action, 'soft');
  let t = 1_794_400_000_000;
  const at = () => (t += 7_000);
  // What finish() records at the end of each card (`attemptFor`), one per card (8.8).
  const built: SessionAttempt[] = [
    // A soft retry on an also-good try, then the card's move, unaided: a correct, clean answer with no new field (L10).
    attemptFor({ item: punish, revealed: false, clean: true, hints: 0, startedAt: t, now: at() }),
    // A soft retry (counted nothing), then the card's move: the same record as an unaided solve.
    attemptFor({ item: punish, revealed: false, clean: true, hints: 0, startedAt: t, now: at() }),
    // The card's move after two hints from the ladder: correct, assisted.
    attemptFor({ item: agent, revealed: false, clean: true, hints: 2, startedAt: t, now: at() }),
    // A counted error, then solved: his first error is kept.
    attemptFor({ item: bank, revealed: false, clean: false, hints: 0, startedAt: t, now: at(), playedUci: 'e4d5' }),
    // All four hint levels, then the move.
    attemptFor({ item: bank, revealed: false, clean: true, hints: 4, startedAt: t, now: at() }),
    // A reveal after an error; a reveal through the coach.
    attemptFor({ item: personal, revealed: true, clean: false, hints: 1, startedAt: t, now: at(), playedUci: 'g1f1' }),
    attemptFor({ item: punish, revealed: true, clean: true, hints: 0, startedAt: t, now: at(), coached: true }),
    // A drill: a soft retry (goal kept) then the move; and leaving after an error (supported practice).
    attemptFor({ item: kpk, revealed: false, clean: true, hints: 0, startedAt: t, now: at() }),
    attemptFor({ item: kpk, revealed: false, clean: false, hints: 0, startedAt: t, now: at(), playedUci: 'e3e4' }),
  ];
  const known = new Set([...keysOf(sessionAttemptSchema.innerType() as never)]);
  for (const a of built) {
    onlyKnownKeys(a as unknown as Record<string, unknown>, known, `attempt ${a.puzzleId}`);
    assert.deepEqual(sessionAttemptSchema.parse(a), a, 'nothing dropped, nothing changed');
    assert.ok((ATTEMPT_SOURCES as readonly string[]).includes(a.source!), 'source in the closed list');
  }
  assert.deepEqual([built[0].correct, built[0].unassisted, 'playedUci' in built[0]], [true, true, false]);
  // Through the real model and session writer, into the store, and back through the version-6 reader.
  const store = createFakeStore();
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'd1', events: null, debounceMs: 1 });
  const model = createTrainerModel({ store, sessions, deviceId: 'd1' });
  try {
    for (const a of built) assert.equal(model.record(a), true, `recorded ${a.puzzleId}`);
    await sessions.flush();
    await tick(10);
    const dump = store.dump();
    const paths = Object.keys(dump).filter(p => p.startsWith('sessions/'));
    assert.equal(paths.length, 1);
    const doc = readDoc<SessionDoc>(paths[0], dump[paths[0]]);
    assert.ok(doc, 'the session document parses under version 6');
    assert.deepEqual(doc!.attempts, built, 'stored exactly as the page built them');
    assert.deepEqual(doc, dump[paths[0]], 'and read back unchanged');
    onlyV6Collections(dump);
  } finally { model.dispose(); sessions.dispose(); }
});

test('notes from the M3 page (a try, a later step, no try, an accepted card) are version-6 feedback documents', async () => {
  const store = createFakeStore();
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'd1', events: null });
  const model = createTrainerModel({ store, sessions, deviceId: 'd1' });
  const step2 = after(after(FRENCH, 'b1c3').fen, 'g8f6').fen;
  // [card, latest try (null: none, as after an accept), kind, text]
  const notes: Array<[TrainerItem, { fen: string; uci: string; index: number } | null, (typeof FEEDBACK_KINDS)[number], string | undefined]> = [
    [punish, { fen: PUNISH_FEN, uci: 'h7h6', index: 0 }, 'comment', 'Why is h6 only a soft retry?'],
    [bank, { fen: step2, uci: 'f1d3', index: 2 }, 'wrong', undefined],
    [kpk, null, 'too-hard', undefined],
    [punish, null, 'more', 'invented note'],
  ];
  try {
    const sent: Array<Record<string, unknown>> = [];
    for (const [card, wrong, kind, text] of notes) {
      const where = feedbackPosition(card, wrong);
      sent.push({ kind, itemId: card.id, source: card.source, fen: where.fen, ...(where.playedUci ? { playedUci: where.playedUci } : {}), ...(text ? { text } : {}) });
      assert.equal(await model.sendFeedback({ kind, item: { id: card.id, source: card.source, themes: card.themes, fen: where.fen }, ...(where.playedUci ? { playedUci: where.playedUci } : {}), text }), true);
    }
    const dump = store.dump();
    const paths = Object.keys(dump).filter(p => p.startsWith('feedback/')).sort();
    assert.equal(paths.length, notes.length);
    const known = keysOf(feedbackDoc);
    paths.forEach((path, i) => {
      const stored = dump[path] as Record<string, unknown>;
      const doc = readDoc<Record<string, unknown>>(path, stored);
      assert.ok(doc, `${path} parses under version 6`);
      assert.deepEqual(doc, stored, 'read back unchanged');
      onlyKnownKeys(stored, known, path);
      for (const [k, v] of Object.entries(sent[i])) assert.deepEqual(stored[k], v, `${path}.${k} as the page built it`);
      assert.equal(stored.status, 'open');
    });
    assert.deepEqual([dump[paths[0]].fen, dump[paths[0]].playedUci], [PUNISH_FEN, 'h7h6'], 'the latest try and the position it was played from (8.3)');
    assert.deepEqual([dump[paths[1]].fen, dump[paths[1]].playedUci], [step2, 'f1d3'], 'a try at a later step');
    assert.equal(dump[paths[3]].playedUci, undefined, 'no try: the card position only');
    onlyV6Collections(dump);
  } finally { model.dispose(); sessions.dispose(); }
});

test('explain and ask answers the M3 page caches are version-6 explanation documents, at paths a version-6 page never lists', async () => {
  const store = createFakeStore();
  let clock = 1_794_400_000_000;
  const prompts: string[] = [];
  const coach = createCoach({
    sample: async p => { prompts.push(String(p)); return { text: 'After h6, Kf1 follows. Rd1+ first wins at once: Rd1+ Re1 Rxe1#.', truncated: false }; },
    permissions: null, store, deviceId: 'd1', storage: memoryKv(), now: () => clock,
  });
  // A soft retry on the punish card (the class and the numbers from the page's grade), a drill try in words, and a
  // question after the card naming his try.
  const soft = explainInput(punish, { fen: PUNISH_FEN, uci: 'h7h6', index: 0 }, punish.source, { check: strong, sibling })!;
  assert.equal(soft.tryVerdict, 'strong');
  const drillTry = explainInput(kpk, { fen: kpk.fen, uci: 'e3e4', index: 0 }, kpk.source)!;
  assert.equal(drillTry.tryResult, 'draw');
  const ask = (await buildAskInput(punish, punish.source, 'Why not h6 first?', new AbortController().signal, { sibling, known: { fen: PUNISH_FEN, check: strong }, check: async () => null }))!;
  assert.ok(ask);
  for (const input of [soft, drillTry, ask]) {
    const r = await coach.ask(input);
    assert.equal(r.cached, false);
    clock += COOLDOWN_MS + 1;
  }
  assert.equal(prompts.length, 3);
  await tick(10); // the coach writes its cache without holding back the answer (`void remember(...)`)
  const dump = store.dump();
  const expected = ['explanations/punish-t1__h7h6', 'explanations/tech-kpk-take-the-opposition__e3e4'];
  for (const path of expected) assert.ok(path in dump, `${path} written (a failed cache write would be swallowed, so its presence is checked)`);
  const askPaths = Object.keys(dump).filter(p => /^explanations\/punish-t1__ask-/.test(p));
  assert.equal(askPaths.length, 1, 'the ask answer under <cardId>__ask-<inputsHash>');
  assert.doesNotMatch(askPaths[0].split('__')[1], /^[a-h][1-8][a-h][1-8][qrbn]?$/, 'never a UCI move: a version-6 page only reads explanations/<id>__<its try>');
  const known = keysOf(explanationDoc);
  for (const path of [...expected, ...askPaths]) {
    const stored = dump[path] as Record<string, unknown>;
    const doc = readDoc<Record<string, unknown>>(path, stored);
    assert.ok(doc, `${path} parses under version 6`);
    assert.deepEqual(doc, stored, 'read back unchanged');
    onlyKnownKeys(stored, known, path);
  }
  assert.equal((dump[askPaths[0]] as Record<string, unknown>).playedUci, undefined, 'an ask document carries no try');
  onlyV6Collections(dump);
});

test('settings the M3 page saves ("Starting level", the daily caps) are version-6 settings; the bank level itself is never stored', async () => {
  const store = createFakeStore({ seed: { 'settings/main': { rating: 1000, sessionLength: 10, updatedAt: 1, device: 'd0', dailyNewCap: 10 } } });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'd1', events: null });
  const model = createTrainerModel({ store, sessions, deviceId: 'd1', readyTimeoutMs: 1000 });
  try {
    await tick(20);
    // One control at a time, as on the page (the model builds each save on the settings it has seen stored).
    assert.equal(await model.saveSettings({ rating: 1200 }), true);
    await tick(20);
    assert.equal(await model.saveSettings({ dailyNewCap: 5 }), true);
    await tick(20);
    const stored = (await store.get('settings/main'))!.data as DocData;
    const doc = readDoc<Record<string, unknown>>('settings/main', stored);
    assert.ok(doc, 'parses under version 6');
    assert.deepEqual(doc, stored);
    onlyKnownKeys(stored as Record<string, unknown>, keysOf(settingsDoc), 'settings/main');
    assert.deepEqual([stored.rating, stored.dailyNewCap], [1200, 5]);
    onlyV6Collections(store.dump());
  } finally { model.dispose(); sessions.dispose(); }
});
