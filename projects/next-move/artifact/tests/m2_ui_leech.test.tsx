import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFakeStore, createMemoryKv } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { createTrainerModel } from '../components/model';
import { buildProgress } from '../components/progress';
import { computeSnapshot } from '../components/snapshot';
import { dailyCounts } from '../components/daily';
import { sessionAttemptSchema, type SessionAttempt } from '../src/contract/docs';
import { isPutBack, leechIds, leechState, putBackAttempt, putBackTimes, startOfNextDay, withPutBacks, LEECH_LAPSES } from '../components/leech';
import StudyList from '../components/StudyList';
import * as v4 from './fixtures/v4_docs';

// Invented ids and positions only.
const FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const DAY = 86_400_000;
const T0 = new Date(2100, 0, 1, 12, 0, 0).getTime(); // local noon, so +/- a few hours stays on the day
const miss = (id: string, at: number): SessionAttempt => ({ puzzleId: id, themes: ['fork'], correct: false, unassisted: false, hints: 0, revealed: false, durationMs: 1000, at, source: 'bank' });
const hit = (id: string, at: number): SessionAttempt => ({ ...miss(id, at), correct: true, unassisted: true });

test('D7 (fix pass): a leech = 4 lapse days among the last 6 attempt days; same-day retries count once', () => {
  const sameDay = [0, 1, 2, 3, 4].map(i => miss('p1', T0 + i * 10 * 60_000));
  assert.equal(leechState(sameDay, new Map()).get('p1')?.lapseDays, 1);
  const fourDays = [0, 1, 2, 3].map(i => miss('p2', T0 + i * DAY));
  const st = leechState([...fourDays, hit('p2', T0 + 5 * DAY), ...[0, 1, 2].map(i => miss('p3', T0 + i * DAY))], new Map());
  assert.deepEqual({ ...st.get('p2') }, { lapseDays: LEECH_LAPSES, windowDays: 5, leeched: true, putBackAt: null }, 'one later clean day does not undo four lapse days');
  // Old misses followed by clean days stop counting: 4 lapse days, then 3 clean days -> last 6 hold 3 lapses.
  const recovered = [...[0, 1, 2, 3].map(i => miss('p5', T0 + i * DAY)), ...[4, 5, 6].map(i => hit('p5', T0 + i * DAY))];
  assert.deepEqual({ ...leechState(recovered, new Map()).get('p5') }, { lapseDays: 3, windowDays: 6, leeched: false, putBackAt: null });
  // 4 lapses among the last 6 days, with clean days in between and older days outside the window.
  const mixed = [hit('p6', T0), hit('p6', T0 + DAY), miss('p6', T0 + 2 * DAY), hit('p6', T0 + 3 * DAY), miss('p6', T0 + 4 * DAY), miss('p6', T0 + 5 * DAY), hit('p6', T0 + 6 * DAY), miss('p6', T0 + 7 * DAY)];
  assert.deepEqual({ ...leechState(mixed, new Map()).get('p6') }, { lapseDays: 4, windowDays: 6, leeched: true, putBackAt: null });
  // A day with a miss and a later clean retry is a lapse day.
  assert.equal(leechState([miss('p7', T0), hit('p7', T0 + 60_000)], new Map()).get('p7')?.lapseDays, 1);
  assert.equal(st.get('p3')?.leeched, false);
  assert.deepEqual([...leechIds(st)], ['p2']);
  const help = { ...hit('p4', T0), unassisted: false, hints: 1 };
  assert.equal(leechState([help], new Map()).get('p4')?.lapseDays, 1, 'a hinted success is a lapse day');
  const safe = [0, 1, 2, 3, 4].map(i => miss('judge-g1:4', T0 + i * DAY));
  assert.equal(leechState(safe, new Map()).size, 0, '"Safe or not?" cards are exempt');
});

test('D7 put back: the marker resets lapse days, the card is due at the start of the next day', () => {
  const att = [0, 1, 2, 3].map(i => miss('p2', T0 + i * DAY));
  const marker = putBackAttempt('p2', 'bank', T0 + 4 * DAY);
  assert.ok(sessionAttemptSchema.safeParse(marker).success, 'the marker is an ordinary valid attempt');
  assert.equal(isPutBack(marker), true);
  const pb = putBackTimes([marker]);
  const st = leechState(att, pb);
  assert.deepEqual({ ...st.get('p2') }, { lapseDays: 0, windowDays: 0, leeched: false, putBackAt: T0 + 4 * DAY });
  const progress = buildProgress(att, { rating: 1000, sessionLength: 10 }, t => t);
  const cards = withPutBacks(progress.cards, pb);
  assert.equal(cards.p2.lapses, 0);
  assert.equal(cards.p2.due, startOfNextDay(T0 + 4 * DAY));
  assert.ok(cards.p2.due > T0 + 4 * DAY && cards.p2.due <= T0 + 5 * DAY);
  const later = [...att, miss('p2', T0 + 6 * DAY)];
  assert.equal(withPutBacks(buildProgress(later, { rating: 1000, sessionLength: 10 }, t => t).cards, pb).p2.lapses > 0, true, 'after a new attempt the ordinary schedule applies');
  assert.equal(leechState(later, pb).get('p2')?.lapseDays, 1, 'lapse days count again after the put-back');
});

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
test('D7 both devices: the marker travels in the session docs; it never counts as an answer', async () => {
  const store = createFakeStore({});
  const sessA = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'phone', events: null, debounceMs: 1 });
  const a = createTrainerModel({ store, sessions: sessA, deviceId: 'phone', readyTimeoutMs: 500 });
  await tick(20);
  const now = Date.now();
  assert.equal(a.record(miss('p9', now - 2)), true);
  assert.equal(a.record(putBackAttempt('p9', 'bank', now)), true);
  assert.deepEqual(a.get().attempts.map(x => x.puzzleId), ['p9']);
  assert.deepEqual(a.get().putBacks.map(x => x.puzzleId), ['putback:p9']);
  assert.equal(dailyCounts(a.get().attempts, now).new, 1, 'the marker takes no place in the daily caps');
  await tick(60);
  const sessB = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'laptop', events: null, debounceMs: 1 });
  const b = createTrainerModel({ store, sessions: sessB, deviceId: 'laptop', readyTimeoutMs: 500 });
  await tick(30);
  assert.deepEqual(b.get().putBacks.map(x => x.puzzleId), ['putback:p9'], 'the other device sees the put-back');
  assert.deepEqual(b.get().attempts.map(x => x.puzzleId), ['p9']);
  a.dispose(); b.dispose(); sessA.dispose(); sessB.dispose();
});

test('D7 snapshot: leeches listed; markers are not attempts in lastSession', () => {
  const att = [0, 1, 2, 3].map(i => miss('p2', T0 + i * DAY));
  const progress = buildProgress(att, { rating: 1000, sessionLength: 10 }, t => t);
  const marker = putBackAttempt('p7', 'bank', T0 + 4 * DAY);
  const snap = computeSnapshot({ attempts: att, progress, themesOf: t => t, priors: null, servableIds: [], packIds: [], session: { id: 's-1-d', attempts: [...att, marker] }, deviceId: 'd1', now: T0 + 5 * DAY, leeches: ['p2'] });
  assert.deepEqual(snap.leeches, { count: 1, ids: ['p2'] });
  assert.equal(snap.lastSession?.attempts, 4);
  assert.equal(snap.due.count, 0, 'leeches are not servable, so not due');
});

test('D7 "Study these": position, stored line and explanation behind a toggle; Put it back', () => {
  const item = { id: 'p2', fen: FEN, moves: ['a1a8'], rating: 1000, themes: ['backRankMate'], gameUrl: '', explanation: 'Invented note.', source: 'bank' as const };
  const html = renderToStaticMarkup(<StudyList entries={[{ item, lapseDays: 4, windowDays: 6 }]} onPutBack={() => undefined}/>);
  assert.match(html, /Study these/);
  assert.match(html, /Went wrong on 4 of the last 6 days you practised it/);
  assert.match(html, /1 position went wrong on at least 4 of the last 6 days you practised it, so it is out/);
  assert.match(html, /Put it back/);
  assert.match(html, /aria-expanded="false"/);
  assert.equal(renderToStaticMarkup(<StudyList entries={[]} onPutBack={() => undefined}/>), '');
});

test('version 4 (frozen fixture, D14) reads a session holding a put-back marker', () => {
  const doc = { device: 'd1', startedAt: T0, attempts: [miss('p2', T0), putBackAttempt('p2', 'bank', T0 + 1)] };
  assert.equal(v4.readDoc<{ attempts: unknown[] }>('sessions/s-1-d1', doc)?.attempts.length, 2);
});
