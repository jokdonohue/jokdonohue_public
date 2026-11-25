import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeStore } from '../src/contract/store';
import { CoachError, type CoachExplainInput, type CoachSummaryInput, type SampleFn } from '../src/contract/coach';
import {
  buildExplainPrompt, buildSummaryPrompt, createCoach, explainInputFromPackCard, explainInputFromPuzzle, groundCheck, inputsHash, staticPanel,
  COOLDOWN_MS, DAILY_LIMIT,
} from '../src/coach/index';
import { memoryKv } from '../src/coach/rateLimit';

// 1.e4 e5 2.Nf3 Nc6, White to move. Ng5?? allows Qxg5; the "engine" prefers Bb5.
const FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
const explain: CoachExplainInput = {
  kind: 'explain', itemId: 'pack-123:5', source: 'pack', fen: FEN, side: 'w', playedUci: 'f3g5', playedSan: 'Ng5',
  bestUci: 'f1b5', bestSan: 'Bb5', bestLineSan: ['Bb5', 'a6', 'Ba4'], refutationSan: ['Qxg5', 'd4'],
  winBefore: 67.3, winAfter: 18.6, cpBefore: 40, cpAfter: -310, themes: ['personal', 'opening', 'hangingPiece'],
};
const summary: CoachSummaryInput = {
  kind: 'summary',
  session: [{ theme: 'fork', attempts: 5, correct: 3, rate: 0.6 }],
  weakest: [{ theme: 'pin', rate: 0.23, attempts: 19 }],
  focus: [{ theme: 'hangingPiece', weight: 1.5, reason: 'missed material 123 times' }],
};

test('explain prompt uses only CoachInput fields', () => {
  const { prompt, modelTier, sans, numbers } = buildExplainPrompt(explain);
  assert.equal(modelTier, 'default');
  for (const s of [FEN, 'Ng5', 'Bb5 a6 Ba4', 'Qxg5 d4', '67%', '19%', 'a drop of 48 points', 'hangingPiece', 'White to move']) assert.ok(prompt.includes(s), s);
  // Every move and every number in the data sentences comes from the input.
  assert.deepEqual(new Set(sans), new Set(['Ng5', 'Bb5', 'a6', 'Ba4', 'Qxg5', 'd4']));
  assert.deepEqual([...new Set(numbers)].sort((a, b) => a - b), [19, 48, 67]);
  // cp values are not rendered, so an answer may not cite them.
  assert.ok(!prompt.includes('-310') && !prompt.includes('310'));
  // Changing a field changes the prompt; nothing else reaches it.
  assert.notEqual(buildExplainPrompt({ ...explain, bestLineSan: ['Bb5'] }).prompt, prompt);
  const bank = buildExplainPrompt({ ...explain, winBefore: undefined, winAfter: undefined, refutationSan: [] });
  assert.ok(!/evaluation|reply line/.test(bank.prompt.split('Using ONLY')[0]), 'bank puzzles drop the evaluation and reply sentences');
});

test('summary prompt uses only CoachInput fields', () => {
  const { prompt, modelTier, numbers } = buildSummaryPrompt(summary);
  assert.equal(modelTier, 'quick');
  for (const s of ['fork 3/5 correct (60%)', 'pin 23% over 19 attempts', 'hangingPiece (weight 1.5): missed material 123 times', 'three bullets']) assert.ok(prompt.includes(s), s);
  assert.deepEqual([...new Set(numbers)].sort((a, b) => a - b), [1.5, 3, 5, 19, 23, 60, 123]);
});

test('grounding flags an invented move and an invented number; an honest answer passes', () => {
  const built = buildExplainPrompt(explain);
  const honest = 'Ng5 attacks f7, but it leaves the knight on g5 undefended: Qxg5 simply takes it, and after d4 White has lost a piece. The engine-scaled chance fell from 67% to 19%, a drop of 48 points. Bb5 instead develops and pins the knight on c6 idea-wise, as in Bb5 a6 Ba4.';
  assert.deepEqual(groundCheck(honest, built, 'explain'), { grounded: true, misses: [] });
  const inventedMove = groundCheck('After Ng5 Black plays Qxg5 and then Qxg2 wins more.', built, 'explain');
  assert.equal(inventedMove.grounded, false);
  assert.deepEqual(inventedMove.misses, ['Qxg2']);
  const inventedNumber = groundCheck('Ng5 drops the evaluation to -3.1 and your chance falls to 18%.', built, 'explain');
  assert.equal(inventedNumber.grounded, false);
  assert.deepEqual(inventedNumber.misses.sort(), ['-3.1', '18%']);
  assert.equal(groundCheck('Castling with O-O was safer.', built, 'explain').grounded, false);
  // Bare squares: an invented quiet pawn move is flagged; squares occupied at the FEN or named in a given move pass.
  assert.deepEqual(groundCheck('After Ng5, then h4 wins for White.', built, 'explain').misses, ['h4']);
  assert.equal(groundCheck('The pawn on f7 and the knight on c6 matter; Qxg5 lands on g5.', built, 'explain').grounded, true);
  // Unsigned decimals and mate distances are never in an explain prompt.
  assert.deepEqual(groundCheck('The engine says 3.1 for Black.', built, 'explain').misses, ['3.1']);
  assert.deepEqual(groundCheck('Black has mate in 3 after Qxg5.', built, 'explain').misses, ['mate in 3']);
  const sumBuilt = buildSummaryPrompt(summary);
  assert.equal(groundCheck('- Practise pins: 23% over 19 attempts.\n- Forks: 3 of 5.\n- Hanging pieces: missed 123 times.', sumBuilt, 'summary').grounded, true);
  assert.deepEqual(groundCheck('1. Pins: 23%.\n2. Do 12 forks a day.', sumBuilt, 'summary').misses, ['12']);
});

test('pack card input: refutation and "after" evaluation only for the move played in the game', () => {
  const card = {
    id: 'pack-123:5', fen: FEN, moves: ['f1b5'], themes: ['personal', 'opening'], kind: 'mistake',
    pack: { playedUci: 'f3g5', pvUci: ['f1b5', 'a7a6', 'b5a4'], refutationPvUci: ['d8g5', 'd2d4'], winBefore: 67.3, winAfter: 18.6, cpBefore: 40, cpAfter: -310 },
  };
  const same = explainInputFromPackCard(card, 'f3g5')!;
  assert.deepEqual(same.refutationSan, ['Qxg5', 'd4']);
  assert.equal(same.winAfter, 18.6);
  assert.deepEqual(same.bestLineSan, ['Bb5', 'a6', 'Ba4']);
  const other = explainInputFromPackCard(card, 'b1c3')!;
  assert.equal(other.playedSan, 'Nc3');
  assert.deepEqual(other.refutationSan, []);
  assert.equal(other.winAfter, undefined);
  assert.equal(other.winBefore, 67.3);
  assert.equal(explainInputFromPackCard(card, 'e1e3'), null, 'illegal move');
  assert.equal(explainInputFromPackCard(card, 'f1b5'), null, 'the answer itself');
  const punish = explainInputFromPackCard({ ...card, kind: 'punish' }, 'f3g5')!;
  assert.equal(punish.winBefore, undefined, 'punish cards pass no evaluation (stored from the other side)');
  const puzzle = explainInputFromPuzzle({ id: 'abc', moves: ['g1f3', 'b8c6', 'f1b5'], themes: ['opening'] }, 2, FEN, 'f3g5')!;
  assert.deepEqual(puzzle.bestLineSan, ['Bb5']);
  assert.equal(puzzle.winBefore, undefined);
  const panel = staticPanel(same).rows.map(r => r.text);
  assert.ok(panel.includes('Bb5 a6 Ba4') && panel.includes('Qxg5 d4') && panel.includes('67% before your move, 19% after'));
});

function harness(sampleImpl?: SampleFn) {
  let clock = new Date(2026, 10, 10, 9, 0, 0).getTime();
  const calls: string[] = [];
  const sample: SampleFn = sampleImpl ?? (async () => { return { text: 'Ng5 loses the knight to Qxg5. Bb5 develops.', truncated: false }; });
  const store = createFakeStore();
  const storage = memoryKv();
  const coach = createCoach({ sample: async (i, o) => { calls.push(String(i)); return sample(i, o); }, permissions: null, store, deviceId: 'd1', storage, now: () => clock });
  return { coach, store, calls, storage, tick: (ms: number) => { clock += ms; } };
}

test('coach: answer is grounded-checked, cached in explanations/*, and reused without a call', async () => {
  const h = harness();
  const first = await h.coach.ask(explain);
  await new Promise(r => setTimeout(r, 5)); // the cache write is not awaited by ask
  assert.equal(first.grounded, true);
  assert.equal(first.cached, false);
  assert.equal(first.inputsHash, inputsHash(explain));
  const doc = h.store.dump()['explanations/pack-123:5__f3g5'];
  assert.equal(doc.inputsHash, first.inputsHash);
  h.tick(COOLDOWN_MS + 1);
  const again = await h.coach.ask(explain);
  assert.equal(again.cached, true);
  assert.equal(h.calls.length, 1, 'one model call');
  // A different input hash ignores the cached doc.
  h.tick(COOLDOWN_MS + 1);
  await h.coach.ask({ ...explain, winAfter: 10 });
  assert.equal(h.calls.length, 2);
});

test('coach: one call in flight, 10 s cooldown, 20 per day', async () => {
  let release!: () => void;
  const h = harness(() => new Promise(r => { release = () => r({ text: 'Bb5.', truncated: false }); }));
  const pending = h.coach.ask(explain);
  await new Promise(r => setTimeout(r, 5));
  await assert.rejects(h.coach.ask({ ...explain, itemId: 'other' }), (e: CoachError) => e.failure.code === 'busy');
  release(); await pending;
  await assert.rejects(h.coach.ask({ ...explain, itemId: 'other' }), (e: CoachError) => e.failure.code === 'cooldown' && e.failure.action === 'tell');
  assert.ok(h.coach.limits().cooldownUntil > 0);
  const h2 = harness();
  for (let i = 0; i < DAILY_LIMIT; i++) { await h2.coach.ask({ ...explain, itemId: `i${i}` }); h2.tick(COOLDOWN_MS + 1); }
  assert.equal(h2.coach.limits().remainingToday, 0);
  await assert.rejects(h2.coach.ask({ ...explain, itemId: 'one-more' }), (e: CoachError) => e.failure.code === 'daily_limit');
  h2.tick(24 * 3600_000);
  assert.equal(h2.coach.limits().remainingToday, DAILY_LIMIT, 'resets the next local day');
});

test('coach: platform errors map to hide / tell / cancelled; rate_limited stops for the day', async () => {
  const fail = (code: string, text?: string) => harness(async () => { throw { code, message: 'x', ...(text ? { text } : {}) }; });
  const hide = fail('not_granted');
  await assert.rejects(hide.coach.ask(explain), (e: CoachError) => e.failure.action === 'hide');
  const up = fail('upstream_error', 'partial answer');
  await assert.rejects(up.coach.ask(explain), (e: CoachError) => e.failure.action === 'tell' && e.failure.partial === 'partial answer');
  const cancel = fail('cancelled');
  await assert.rejects(cancel.coach.ask(explain), (e: CoachError) => e.failure.action === 'cancelled');
  const odd = fail('something_new');
  await assert.rejects(odd.coach.ask(explain), (e: CoachError) => e.failure.code === 'upstream_error');
  const limited = fail('rate_limited');
  await assert.rejects(limited.coach.ask(explain), (e: CoachError) => e.failure.code === 'rate_limited' && typeof e.failure.retryAt === 'number');
  limited.tick(COOLDOWN_MS + 1);
  await assert.rejects(limited.coach.ask({ ...explain, itemId: 'x2' }), (e: CoachError) => e.failure.code === 'rate_limited');
  assert.equal(limited.calls.length, 1, 'no second model call after rate_limited');
  const ctl = new AbortController(); ctl.abort();
  const h = harness();
  await assert.rejects(h.coach.ask(explain, { signal: ctl.signal }), (e: CoachError) => e.failure.action === 'cancelled');
  assert.equal(h.calls.length, 0, 'an aborted signal sends nothing');
});

test('coach: ungrounded answer is flagged and stored grounded:false; cache write failure never fails ask', async () => {
  const h = harness(async () => ({ text: 'Ng5 is bad because of Qh4 and the evaluation is -5.0.', truncated: false }));
  h.store.failNextWrites(1);
  const r = await h.coach.ask(explain);
  assert.equal(r.grounded, false);
  assert.deepEqual(r.misses.sort(), ['-5.0', 'Qh4']);
  const h2 = harness(async () => ({ text: 'Qh4!', truncated: false }));
  await h2.coach.ask(explain);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(h2.store.dump()['explanations/pack-123:5__f3g5'].grounded, false);
});

test('coach: availability reads permissions without prompting; null permissions means prompt', async () => {
  const store = createFakeStore();
  const sample: SampleFn = async () => ({ text: '', truncated: false });
  assert.equal(await createCoach({ sample, permissions: null, store, deviceId: 'd' }).availability(), 'prompt');
  assert.equal(await createCoach({ sample, permissions: { state: async () => 'denied' }, store, deviceId: 'd' }).availability(), 'denied');
  await assert.rejects(createCoach({ sample, permissions: null, store, deviceId: 'd' }).ask(explain), (e: CoachError) => e.failure.code === 'empty_completion');
});

test('coach: streaming passes the whole answer so far', async () => {
  const seen: string[] = [];
  const h = harness(async (_i, o) => { o?.onText?.({ text: 'Bb5', delta: 'Bb5' }); o?.onText?.({ text: 'Bb5 develops.', delta: ' develops.' }); return { text: 'Bb5 develops.', truncated: false }; });
  await h.coach.ask(explain, { onText: t => seen.push(t) });
  assert.deepEqual(seen, ['Bb5', 'Bb5 develops.']);
});
