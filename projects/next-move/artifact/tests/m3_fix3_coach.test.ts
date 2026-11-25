/**
 * M3 fix round 3 (brief 9.12.2), writer FX2e, the coach input:
 * - item 7 (V3-1 with V3-2): the coach lesson of a card from his games leaves out the stored-drop sentence ("By the
 *   engine's estimate, your move lowered your winning chances by about N points out of 100."); his game move keeps its
 *   stored pair; no figure the prompt gives is flagged by the grounding check; "still a good move" never stands beside a
 *   stored drop;
 * - item 8 (V3-5): a question that names the card's move gives that move one figure, the input's `answerWin`.
 *
 * The own-game card is made by the pack generator itself (`cardFromRow`, lib/personal-pack.ts), so its explanation is the
 * real template every card from his games carries (no fixture had it before, which is how V3-1 slipped through). Positions
 * are textbook (the French after 1.e4 e6 2.d4 d5) with an invented row and invented TryCheck values. No owner game data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { buildAskInput, explainInput, lessonWithoutStoredDrop, type AskContext, type CoachCard } from '../components/coachInput';
import { buildAskPrompt, buildExplainPrompt, buildPrompt } from '../src/coach/prompts';
import { groundCheck } from '../src/coach/ground';
import { checkedLines } from '../components/CoachPanel';
import { cardFromRow, type PositionRow } from '../lib/personal-pack';
import type { CoachAskInput, CoachExplainInput } from '../src/contract/coach';
import type { TryCheck } from '../src/teach/tryMove';

/** The French after 1.e4 e6 2.d4 d5, White to move. */
const FRENCH = 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6 0 3';
const DROP_RE = /lowered your winning chances|points out of 100/;
const check = (o: Partial<TryCheck> & Pick<TryCheck, 'tryUci' | 'tryWin'>): TryCheck =>
  ({ trySan: o.tryUci, replyLine: [], bestWin: null, verdict: 'worse', depth: 12, ms: 5, ...o });
const signal = () => new AbortController().signal;

/**
 * An own-game mistake card from the pack generator (invented row at the French): his game move exd5 (stored reply exd5
 * Nc3), the engine's move Nc3, stored Win% 60.4 before and 34.8 after, a stored drop of 25.6. The explanation then says
 * "about 26 points out of 100" while the prompt's stored-pair sentence says 60 - 35 = 25 (V3-1b).
 */
function frenchPackCard(): CoachCard & { source: 'pack' } {
  const row: PositionRow = {
    id: 'fx2e-row-1', gameUrl: 'https://www.chess.com/game/live/100000003', date: '2026-01-02', timeClass: 'blitz', ownerColor: 'w', ply: 5, moveNumber: 3,
    fen: FRENCH, playedSan: 'exd5', playedUci: 'e4d5', bestSan: 'Nc3', bestUci: 'b1c3', pvUci: ['b1c3', 'g8f6'], winBefore: 60.4, winAfter: 34.8,
    drop: 25.6, judgement: 'mistake', phase: 'opening', motifs: [], drillable: true, refutationPvUci: ['e6d5', 'b1c3'],
  };
  const c = cardFromRow(row, [], { depth: 14, confirmDepth: 18 });
  // The installed pack also carries the stored pair on the detail block (as his cards do).
  return { ...c, pack: { ...c.pack, winBefore: 60.4, winAfter: 34.8, cpBefore: 40, cpAfter: -60 }, kind: 'mistake', source: 'pack' } as unknown as CoachCard & { source: 'pack' };
}
const EXPLANATION = "You played exd5. The engine preferred Nc3, and it stayed clearly best on a deeper check (depth 18). By the engine's estimate, your move lowered your winning chances by about 26 points out of 100.";
const LESSON = 'You played exd5. The engine preferred Nc3, and it stayed clearly best on a deeper check (depth 18).';

/** Every data line of a built prompt fed back to the grounding check (V3's echo test): the figures it flags. */
function echoMisses(input: CoachExplainInput | CoachAskInput): string[] {
  const built = buildPrompt(input);
  const lines = built.prompt.split('\n');
  const end = lines.findIndex(l => l.startsWith('Using ONLY') || l.startsWith('The learner\'s question'));
  return lines.slice(1, end === -1 ? undefined : end).filter(l => !l.startsWith('Position (FEN):'))
    .flatMap(l => groundCheck(l, built, input.kind === 'ask' ? 'ask' : 'explain').misses);
}

test('fixtures: the French lines below are legal, and the generator writes the real explanation with its drop sentence', () => {
  for (const line of [['e4d5', 'e6d5', 'b1c3'], ['b1c3', 'g8f6'], ['g1f3'], ['f1d3']]) {
    const b = new Chess(FRENCH);
    for (const u of line) assert.doesNotThrow(() => b.move({ from: u.slice(0, 2), to: u.slice(2, 4) }), line.join(' '));
  }
  assert.equal(frenchPackCard().explanation, EXPLANATION);
});

// ---------------------------------------------------------------- item 7: the stored-drop sentence out of the lesson

test('item 7: lessonWithoutStoredDrop removes the sentence the three producers write and keeps every other sentence', () => {
  assert.equal(lessonWithoutStoredDrop(EXPLANATION), LESSON);
  // The page-made form (src/analysis/docs.ts) and the producer's form (src/importers/packDocs.ts) end the same way.
  const pageMade = "You played Nxe5. The engine preferred Nxd4, and it was clearly best at depth 12 (checked in this page). By the engine's estimate, your move lowered your winning chances by about 7 points out of 100.";
  assert.equal(lessonWithoutStoredDrop(pageMade), 'You played Nxe5. The engine preferred Nxd4, and it was clearly best at depth 12 (checked in this page).');
  // Text without the sentence is kept as it is (trimmed); an explanation that is only the sentence leaves nothing.
  for (const keep of ['White wins a knight.', 'In your game you played h6. Better was g6.', '']) assert.equal(lessonWithoutStoredDrop(keep), keep);
  assert.equal(lessonWithoutStoredDrop("By the engine's estimate, your move lowered your winning chances by about 40 points out of 100."), '');
  // Another wording that only looks alike stays: the rule removes the generator's sentence, nothing else.
  assert.equal(lessonWithoutStoredDrop('Your winning chances drop to 30%.'), 'Your winning chances drop to 30%.');
});

test('item 7: another move (finished worse check): the lesson has no drop, the card text is unchanged, and no given figure is flagged', () => {
  const card = frenchPackCard();
  const input = explainInput(card, { fen: FRENCH, uci: 'g1f3', index: 0 }, 'pack', { check: check({ tryUci: 'g1f3', replyLine: ['d5e4'], tryWin: 31, bestWin: 77 }) })!;
  assert.equal(input.lesson, LESSON);
  assert.equal(card.explanation, EXPLANATION, 'the page still prints the explanation whole after the card');
  const p = buildExplainPrompt(input).prompt;
  assert.ok(!DROP_RE.test(p), 'no stored drop in the prompt');
  assert.match(p, /77% after Nc3, 31% after Nf3, a difference of 46 points/);
  assert.deepEqual(echoMisses(input), [], 'every true figure grounds (V3-1a: "26 points" was flagged)');
  // An answer that repeats the lesson's old figure is no longer backed by the prompt.
  assert.deepEqual(groundCheck('Your move cost about 26 points.', buildExplainPrompt(input), 'explain').misses, ['26 points']);
});

test('item 7: his game move keeps its stored pair (one drop figure, 25), and the lesson\'s 26 is gone', () => {
  const input = explainInput(frenchPackCard(), { fen: FRENCH, uci: 'e4d5', index: 0 }, 'pack', { check: null })!;
  assert.deepEqual([input.winBefore, input.winAfter, input.lesson], [60, 35, LESSON]);
  assert.deepEqual(input.refutationSan, ['exd5', 'Nc3'], 'the stored reply line stays');
  const p = buildExplainPrompt(input).prompt;
  assert.match(p, /Stored winning chances for White as the engine scales them: 60% before exd5 and 35% after it, a drop of 25 points\./);
  assert.ok(!DROP_RE.test(p));
  assert.deepEqual(echoMisses(input), [], 'V3-1b: the lesson\'s rounding no longer gives a second, flagged drop');
});

test('item 7 (V3-2): his game move with a finished live strong check: "still a good move" with no stored drop anywhere', () => {
  const live = check({ tryUci: 'e4d5', replyLine: ['e6d5', 'b1c3'], tryWin: 66, bestWin: 75, verdict: 'also-good' });
  const input = explainInput(frenchPackCard(), { fen: FRENCH, uci: 'e4d5', index: 0 }, 'pack', { check: live })!;
  assert.equal(input.tryVerdict, 'strong');
  assert.deepEqual([input.winBefore, input.winAfter, input.lesson], [undefined, undefined, LESSON], 'R5-5: the live check replaces the stored pair');
  const p = buildExplainPrompt(input).prompt;
  assert.match(p, /exd5 is still a good move: do not say that it fails or loses\./);
  assert.ok(!DROP_RE.test(p) && !/Stored winning chances/.test(p), 'no stored drop beside "still a good move"');
  assert.match(p, /75% after Nc3, 66% after exd5, a difference of 9 points/, 'one figure pair for his move');
  assert.deepEqual(echoMisses(input), []);
});

test('item 7: the ask input on the same card gets the same lesson; puzzles and Claude\'s drills keep their own text', async () => {
  const ctx: AskContext = { check: async () => null };
  const asked = (await buildAskInput(frenchPackCard(), 'pack', 'What is the idea here?', signal(), ctx))!;
  assert.equal(asked.lesson, LESSON);
  assert.ok(!DROP_RE.test(buildAskPrompt(asked).prompt));
  // A Site-imported or page-made position from his games ("personal") is a card from his games too.
  const personal = { ...frenchPackCard(), themes: ['personal', 'opening'], source: 'personal' } as unknown as CoachCard;
  assert.equal(explainInput(personal, { fen: FRENCH, uci: 'g1f3', index: 0 }, 'personal', { check: null })!.lesson, LESSON);
  // Other kinds keep their explanation as it is.
  const agent: CoachCard = { id: 'fx2e-agent', fen: FRENCH, moves: ['b1c3', 'g8f6'], themes: ['opening'], title: 'Develop with tempo', explanation: 'Nc3 develops and defends e4.' };
  assert.equal(explainInput(agent, { fen: FRENCH, uci: 'g1f3', index: 0 }, 'agent')!.lesson, 'Nc3 develops and defends e4.');
});

// ---------------------------------------------------------------- item 8: one figure for the card's move in a question

/** A Lichess-style bank card at the French (invented line), the page's try check of Nf3 (the answer at 85 there), and a
 *  checker whose fresh search of the card's move Nc3 says 83 (a different depth-12 search of the same move). */
const frenchBank = (): CoachCard => ({ id: 'fx2e-bank-french', fen: FRENCH, moves: ['b1c3', 'g8f6', 'c1g5'], rating: 1400, themes: ['opening', 'advantage'] });
const tryCheckNf3 = check({ tryUci: 'g1f3', replyLine: ['d5e4'], tryWin: 40, bestWin: 85 });
function checker(nc3: Partial<TryCheck>): { ctx: AskContext; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ctx: {
      known: { fen: FRENCH, check: tryCheckNf3 },
      check: async (_fen, uci) => {
        asked.push(uci);
        return uci === 'b1c3' ? check({ tryUci: 'b1c3', replyLine: ['g8f6', 'c1g5'], tryWin: 83, ...nc3 }) : uci === 'g1f3' ? tryCheckNf3 : null;
      },
    },
  };
}
const figuresFor = (prompt: string, san: string) => [...new Set([...prompt.matchAll(new RegExp(`(\\d+)% after ${san}(?![\\w])|after ${san}: (\\d+)%`, 'g'))].map(m => m[1] ?? m[2]))];

test('item 8 (V3-5): naming the card\'s move after a try: its line reuses answerWin (85), not the fresh search (83)', async () => {
  const { ctx, asked } = checker({});
  const input = (await buildAskInput(frenchBank(), 'bank', 'Why is Nc3 better than Nf3?', signal(), ctx))!;
  assert.equal(input.answerWin, 85, 'the answer\'s figure from the try\'s check');
  assert.deepEqual(asked, ['b1c3'], 'the card\'s move is still searched once, for its line');
  const nc3 = input.askedLines.find(l => l.san === 'Nc3')!, nf3 = input.askedLines.find(l => l.san === 'Nf3')!;
  assert.deepEqual([nc3.win, nc3.lineSan, nc3.finished], [85, ['Nc3', 'Nf6', 'Bg5'], undefined], 'the fresh line, the one figure');
  assert.equal(nf3.win, 40, 'another move keeps its own figure');
  const p = buildAskPrompt(input).prompt;
  assert.deepEqual(figuresFor(p, 'Nc3'), ['85'], 'one figure for the card\'s move in the prompt');
  assert.ok(!p.includes('83%'));
  // The panel's "Checked on this page" lines, in the order the question names the moves: Nc3 with the one figure.
  assert.deepEqual(checkedLines(input), ['Nc3 Nf6 Bg5 (engine line; winning chances for White 85%)', 'Nf3 dxe4 (engine line; winning chances for White 40%)']);
  assert.deepEqual(echoMisses(input), []);
});

test('item 8: an unfinished search of the card\'s move gives no figure; with no earlier figure the search\'s own is the one', async () => {
  const shallow = checker({ depth: 9 });
  const input = (await buildAskInput(frenchBank(), 'bank', 'Why is Nc3 better than Nf3?', signal(), shallow.ctx))!;
  const nc3 = input.askedLines.find(l => l.san === 'Nc3')!;
  assert.deepEqual([input.answerWin, nc3.win, nc3.finished], [85, undefined, false], 'unfinished: no figure, as before');
  assert.deepEqual(figuresFor(buildAskPrompt(input).prompt, 'Nc3'), ['85']);
  // No try was checked before the question: the card's move is searched first, and that figure is answerWin and its line's.
  const fresh: AskContext = { check: async (_f, uci) => (uci === 'b1c3' ? check({ tryUci: 'b1c3', replyLine: ['g8f6'], tryWin: 83 }) : null) };
  const solo = (await buildAskInput(frenchBank(), 'bank', 'What does Nc3 do?', signal(), fresh))!;
  assert.deepEqual([solo.answerWin, solo.askedLines.map(l => [l.san, l.win])], [83, [['Nc3', 83]]]);
  assert.deepEqual(figuresFor(buildAskPrompt(solo).prompt, 'Nc3'), ['83']);
});
