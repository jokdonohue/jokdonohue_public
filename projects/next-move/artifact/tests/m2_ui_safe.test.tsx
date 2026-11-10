import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFakeStore, createMemoryKv, type DocData } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { createTrainerModel } from '../components/model';
import { computeSnapshot } from '../components/snapshot';
import { buildProgress } from '../components/progress';
import { sessionAttemptSchema, type SafeCardDoc, type SessionAttempt } from '../src/contract/docs';
import {
  chooseSafe, describeMove, isSafeAttempt, pickWithSafe, safeAttempt, safePool, safeQuestion, safeSchedule, safeScore, takeSafe,
  SAFE_RETIRE_DAYS, SAFE_RETURN_DAYS,
} from '../components/safe';
import { SafeAnswerPanel, SafeQuestionPanel, SafeScoreLine } from '../components/SafeCard';
import { HAVE_SEED, HAVE_SEED_M2, loadSeedDocs, SEED_DIR, SEED_M2_DIR } from './m2_ui_seed';

// Invented positions and ids only.
const FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
const DAY = 86_400_000;
const T0 = 4_102_444_800_000; // 2100-01-01
const card = (id: string, kind: 'safe' | 'unsafe', extra: Partial<SafeCardDoc> = {}): SafeCardDoc => ({
  id, kind, fen: FEN, moves: ['f1c4'], rating: 1000, themes: ['personal', 'safety', 'opening'], title: 'Safe or not? · Rapid · 2100-01-01 · move 3',
  question: { playedUci: 'f1c4', playedSan: 'Bc4', side: 'w' },
  reveal: { explanation: kind === 'safe' ? 'Safe. Invented explanation A.' : 'Not safe. Invented explanation B.', bestSan: 'Bb5', replyLineSan: ['Nd4', 'Nxd4'], replyLineUci: ['c6d4', 'f3d4'], gameUrl: 'https://example.invalid/g/1' },
  ...extra,
});
const ans = (id: string, at: number, correct: boolean, verdict?: 'safe' | 'unsafe'): SessionAttempt =>
  ({ puzzleId: id, themes: ['personal', 'safety'], correct, unassisted: correct, hints: 0, revealed: false, durationMs: 1000, at, source: 'pack', ...(verdict ? { verdict } : {}) });

test('safeQuestion keeps only pre-answer fields and skips an illegal move', () => {
  const q = safeQuestion(card('judge-g1:5', 'unsafe'))!;
  assert.deepEqual(Object.keys(q).sort(), ['fen', 'id', 'playedUci', 'side', 'themes', 'title']);
  assert.equal(q.side, 'w');
  assert.equal(safeQuestion(card('judge-g1:6', 'safe', { moves: ['a1a8'] })), null);
  assert.equal(safeQuestion(card('judge-g1:7', 'safe', { fen: 'not a fen at all, really' })), null);
});

test('describeMove names the move in words', () => {
  assert.equal(describeMove(FEN, 'f1c4'), 'Bc4: your bishop from f1 to c4');
  assert.equal(describeMove(FEN, 'f3e5'), 'Nxe5: your knight from f3 to e5, taking the pawn');
  assert.equal(describeMove('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1'), 'O-O: you castle on the king’s side');
  assert.match(describeMove('4k3/8/8/8/8/8/8/4K2R w - - 0 1', 'h1h8'), /with check$/);
});

test('D4: the attempt records the verdict; "Not sure" has none and is not correct', () => {
  const q = safeQuestion(card('judge-g1:5', 'unsafe'))!;
  const a = safeAttempt(q, 'unsafe', 'unsafe', T0, T0 + 4000);
  assert.equal(a.correct, true); assert.equal(a.verdict, 'unsafe'); assert.equal(a.source, 'pack'); assert.equal(a.durationMs, 4000);
  const b = safeAttempt(q, 'unsafe', 'safe', T0, T0 + 1);
  assert.equal(b.correct, false); assert.equal(b.verdict, 'safe');
  const c = safeAttempt(q, 'unsafe', 'unsure', T0, T0 + 1);
  assert.equal(c.correct, false); assert.equal('verdict' in c, false);
  for (const x of [a, b, c]) assert.ok(sessionAttemptSchema.safeParse(x).success);
});

test('D5: correct retires for 90 days; wrong returns once after 7 days; a second wrong retires', () => {
  const s1 = safeSchedule([ans('judge-a:1', T0, true, 'safe'), ans('judge-b:1', T0, false, 'safe'), ans('pack-x', T0, false)]);
  assert.equal(s1['judge-a:1'].due, T0 + SAFE_RETIRE_DAYS * DAY);
  assert.equal(s1['judge-b:1'].due, T0 + SAFE_RETURN_DAYS * DAY);
  assert.equal(s1['pack-x'], undefined, 'ordinary cards are not in this fold');
  const s2 = safeSchedule([ans('judge-b:1', T0, false), ans('judge-b:1', T0 + 7 * DAY, false, 'safe')]);
  assert.equal(s2['judge-b:1'].due, T0 + 7 * DAY + SAFE_RETIRE_DAYS * DAY, 'the one return is used up');
  const s3 = safeSchedule([ans('judge-c:1', T0, true, 'unsafe'), ans('judge-c:1', T0 + 90 * DAY, false)]);
  assert.equal(s3['judge-c:1'].due, T0 + 97 * DAY, 'a wrong answer after a correct one gets its return');
});

test('D5 caps: a first showing needs a new place, a return needs a review place', () => {
  const qs = ['judge-a:1', 'judge-b:1', 'judge-c:1'].map(id => safeQuestion(card(id, 'safe'))!);
  const sched = safeSchedule([ans('judge-a:1', T0, false), ans('judge-b:1', T0, true, 'safe')]);
  const now = T0 + 8 * DAY;
  const ids = (caps: { reviewsLeft: number; newLeft: number; done: boolean } | null, flagged = new Set<string>()) => safePool(qs, sched, caps, now, flagged).map(q => q.id);
  assert.deepEqual(ids({ reviewsLeft: 1, newLeft: 1, done: false }), ['judge-a:1', 'judge-c:1']);
  assert.deepEqual(ids({ reviewsLeft: 0, newLeft: 1, done: false }), ['judge-c:1']);
  assert.deepEqual(ids({ reviewsLeft: 1, newLeft: 0, done: false }), ['judge-a:1']);
  assert.deepEqual(ids(null), ['judge-a:1', 'judge-c:1'], 'free practice: unseen or due, no caps');
  assert.deepEqual(ids(null, new Set(['judge-a:1'])), ['judge-c:1'], 'flagged "wrong" is skipped');
  assert.equal(chooseSafe(safePool(qs, sched, null, now, new Set()), sched, [])!.id, 'judge-a:1', 'returns first');
  assert.equal(chooseSafe(safePool(qs, sched, null, now, new Set()), sched, ['judge-a:1'])!.id, 'judge-c:1', 'recent ids skipped');
});

test('D3: share absent 0.15, 0 off, capped at 0.5; no cards, no pool', () => {
  assert.equal(takeSafe(undefined, 5, 0.149), true);
  assert.equal(takeSafe(undefined, 5, 0.151), false);
  assert.equal(takeSafe(0, 5, 0), false);
  assert.equal(takeSafe(0.9, 5, 0.499), true);
  assert.equal(takeSafe(0.9, 5, 0.501), false);
  assert.equal(takeSafe(0.5, 0, 0), false);
  // Over a uniform spread of draws the safe share is exactly 0.3; the rest go to pickNext unchanged.
  let safeN = 0; const N = 1000;
  for (let i = 0; i < N; i++) if (takeSafe(0.3, 1, (i + 0.5) / N)) safeN++;
  assert.equal(safeN, 300);
});

test('D6: two numbers over the last 50; "Not sure" counts against its half; unknown cards are left out', () => {
  const kinds = new Map([['judge-u:1', 'unsafe'], ['judge-u:2', 'unsafe'], ['judge-s:1', 'safe']] as const);
  const kindOf = (id: string) => kinds.get(id as never);
  const list = [ans('judge-u:1', T0 + 1, true, 'unsafe'), ans('judge-u:2', T0 + 2, false), ans('judge-s:1', T0 + 3, false, 'unsafe'), ans('judge-gone:1', T0 + 4, true, 'safe'), ans('pack-x', T0 + 5, true)];
  const s = safeScore(list, kindOf);
  assert.deepEqual(s, { caught: { k: 1, n: 2 }, trusted: { k: 0, n: 1 }, unknown: 1 });
  const many = Array.from({ length: 60 }, (_, i) => ans('judge-u:1', T0 + i, i >= 10, i >= 10 ? 'unsafe' : 'safe'));
  assert.deepEqual(safeScore(many, kindOf).caught, { k: 50, n: 50 }, 'only the last 50 count');
  const html = renderToStaticMarkup(<SafeScoreLine score={s}/>);
  assert.match(html, /blunders caught 1 of 2 · sound moves trusted 0 of 1/);
  assert.doesNotMatch(html, /%/, 'never one combined percentage');
});

test('D4: the question markup is byte-identical whatever the answer key says, and names none of it', () => {
  const a = card('judge-g1:5', 'unsafe');
  const b = card('judge-g1:5', 'safe', { reveal: { explanation: 'Completely different words.', bestSan: 'Qh5' } });
  const render = (c: SafeCardDoc) => renderToStaticMarkup(<SafeQuestionPanel question={safeQuestion(c)!} onAnswer={() => undefined}/>);
  const ha = render(a), hb = render(b);
  assert.equal(ha, hb);
  for (const leak of ['Invented explanation', 'Bb5', 'Nd4', 'example.invalid', 'unsafe', 'Not safe', 'kind']) assert.ok(!ha.includes(leak), `question leaks ${leak}`);
  assert.match(ha, /Safe<\/button>/); assert.match(ha, /It loses something<\/button>/); assert.match(ha, /Not sure<\/button>/);
  assert.match(ha, /Bc4: your bishop from f1 to c4/);
  assert.match(ha, /class="board-arrow"/);
});

test('D4: after the answer: verdict, explanation, best move, a "Show the reply" toggle and the game link', () => {
  const c = card('judge-g1:5', 'unsafe');
  const q = safeQuestion(c)!;
  const html = renderToStaticMarkup(<SafeAnswerPanel question={q} card={c} choice="unsure" score={null} onNext={() => undefined} nextLabel="Next position"/>);
  assert.match(html, /Here is the answer\./);
  assert.match(html, /This move lost something\./);
  assert.match(html, /Invented explanation B/);
  assert.match(html, /The engine’s choice: <\/strong>Bb5/);
  assert.match(html, /Show the reply/);
  assert.doesNotMatch(html, /Their reply/, 'the reply line stays folded until asked');
  const right = renderToStaticMarkup(<SafeAnswerPanel question={q} card={c} choice="unsafe" score={null} onNext={() => undefined} nextLabel="Next"/>);
  assert.match(right, /Right\./);
  const noReply = renderToStaticMarkup(<SafeAnswerPanel question={q} card={card('judge-g1:6', 'safe', { reveal: { explanation: 'Safe.' } })} choice="safe" score={null} onNext={() => undefined} nextLabel="Next"/>);
  assert.doesNotMatch(noReply, /Show the reply/);
});

test('safe answers stay out of the ordinary schedule, skills and snapshot rates', () => {
  const attempts = [ans('judge-a:1', T0, false), ans('judge-a:1', T0 + 1, false), ans('judge-a:1', T0 + 2, false), ans('judge-a:1', T0 + 3, false),
    { ...ans('bank-1', T0 + 4, true), source: 'bank' as const, themes: ['fork'] }];
  assert.equal(attempts.filter(isSafeAttempt).length, 4);
  const practice = attempts.filter(a => !isSafeAttempt(a));
  const progress = buildProgress(practice, { rating: 1000, sessionLength: 10 }, t => t);
  assert.equal(progress.cards['judge-a:1'], undefined);
  assert.equal(progress.skills.safety, undefined);
  const snap = computeSnapshot({ attempts, progress, themesOf: t => t, priors: null, servableIds: ['bank-1'], packIds: [], session: { id: 's-1-d', attempts }, deviceId: 'd1', now: T0 + 10,
    safe: { caught: { k: 0, n: 4 }, trusted: { k: 0, n: 0 }, unknown: 0 } });
  assert.equal(snap.attemptsTotal, 5);
  assert.equal(snap.last7d.firstTryRate, 1, 'first-try rate over ordinary practice only');
  assert.equal(snap.lastSession?.firstTryRate, 1);
  assert.deepEqual(snap.safe, { answers: 4, caught: { k: 0, n: 4 }, trusted: { k: 0, n: 0 } });
  assert.equal(snap.today?.new, 2, 'a first showing counts against the new cap');
});

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function model(seed: Record<string, DocData>) {
  const store = createFakeStore({ seed });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'laptop', events: null, debounceMs: 1 });
  const m = createTrainerModel({ store, sessions, deviceId: 'laptop', readyTimeoutMs: 1000, packRetryMs: 5 });
  await tick(30);
  return { m, store, done: () => { m.dispose(); sessions.dispose(); } };
}

test('model: safe/meta + chunks load; absent means no feature, no banner, ready unaffected', async () => {
  const none = await model({});
  assert.equal(none.m.get().ready, true);
  assert.equal(none.m.get().safe, null);
  assert.equal(none.m.get().error, '');
  none.done();
  const ver = 'v20990101a';
  const with2 = await model({
    'safe/meta': { packVersion: ver, chunks: [`${ver}-00`, `${ver}-01`], counts: { safeCards: 1, unsafeCards: 1 } },
    [`safe/${ver}-00`]: { cards: [card('judge-g1:5', 'unsafe')] },
    [`safe/${ver}-01`]: { cards: [card('judge-g2:9', 'safe'), { id: 'judge-bad', kind: 'maybe' }] },
  });
  const v = with2.m.get();
  assert.equal(v.safe?.cards.length, 1, 'an invalid chunk is skipped as a whole');
  assert.equal(v.error, '');
  assert.deepEqual(v.docErrors.map(e => e.path), [`safe/${ver}-01`]);
  assert.match(v.docErrors[0].issue, /kind/);
  assert.equal(v.pack, null, 'pack/meta is not touched');
  with2.done();
});

test('seeds: seed/ alone has no safe cards and no unreadable documents; seed/ + seed_m2/ loads without a banner', { skip: !HAVE_SEED }, async () => {
  const docs = (dir: string) => Object.fromEntries(loadSeedDocs(dir).map(d => [d.path, d.data]));
  const a = await model(docs(SEED_DIR));
  await tick(50);
  assert.equal(a.m.get().safe, null);
  assert.deepEqual(a.m.get().docErrors, []);
  assert.equal(a.m.get().error, '');
  a.done();
  if (!HAVE_SEED_M2) return;
  const b = await model({ ...docs(SEED_DIR), ...docs(SEED_M2_DIR) });
  await tick(80);
  const v = b.m.get();
  assert.equal(v.error, '');
  assert.deepEqual(v.docErrors, []);
  const hasSafeMeta = 'safe/meta' in docs(SEED_M2_DIR);
  if (hasSafeMeta) assert.ok((v.safe?.cards.length ?? 0) > 0, 'safe cards load from safe/*');
  // Old layout (safe chunks listed in pack/meta): the pack skips them, as version 4 does.
  assert.ok((v.pack?.cards ?? []).every(c => c.kind !== 'safe' && c.kind !== 'unsafe'));
  console.log(`seed_m2 layout: ${hasSafeMeta ? 'safe/*' : 'pack chunks'}; safe cards loaded ${v.safe?.cards.length ?? 0}`);
  b.done();
});

test('D3 pick: share decides first; an empty ordinary pick falls back to a safe card unless the share is 0', () => {
  const qs = ['judge-a:1', 'judge-b:1'].map(id => safeQuestion(card(id, 'safe'))!);
  const rest = (item: string | null) => () => ({ item, reason: item ? 'picked' : 'empty' });
  const base = { safePool: qs, schedule: {}, recent: [] as string[] };
  assert.deepEqual(pickWithSafe({ ...base, mixSafe: undefined, r: 0.1, pickRest: rest('bank-1') }), { safe: qs[0] });
  assert.deepEqual(pickWithSafe({ ...base, mixSafe: undefined, r: 0.2, pickRest: rest('bank-1') }), { rest: { item: 'bank-1', reason: 'picked' } });
  assert.deepEqual(pickWithSafe({ ...base, mixSafe: undefined, r: 0.9, pickRest: rest(null) }), { safe: qs[0] });
  assert.deepEqual(pickWithSafe({ ...base, mixSafe: 0, r: 0, pickRest: rest(null) }), { rest: { item: null, reason: 'empty' } });
  assert.deepEqual(pickWithSafe({ ...base, safePool: [], mixSafe: 0.5, r: 0, pickRest: rest('bank-1') }), { rest: { item: 'bank-1', reason: 'picked' } }, 'no cards, no change');
});

test('P2-4: when the answer was not saved, the panel says so plainly', () => {
  const c = card('judge-g1:5', 'unsafe');
  const q = safeQuestion(c)!;
  const notSaved = renderToStaticMarkup(<SafeAnswerPanel question={q} card={c} choice="unsafe" saved={false} score={null} onNext={() => undefined} nextLabel="Next"/>);
  assert.match(notSaved, /This answer was not saved/);
  assert.match(notSaved, /role="alert"/);
  const saved = renderToStaticMarkup(<SafeAnswerPanel question={q} card={c} choice="unsafe" score={null} onNext={() => undefined} nextLabel="Next"/>);
  assert.doesNotMatch(saved, /not saved/);
});
