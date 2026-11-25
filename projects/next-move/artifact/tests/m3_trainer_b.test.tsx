/**
 * M3 C-core stage (b) (brief 9.6, 9.2, L6, L7, 8.3): the enriched explain input, the ask input built from a question,
 * the question box after completion, the note the page sends, and Claude's answers on the card and in the From Claude
 * area.
 *
 * Inputs are checked field by field AND through the prompt builders (`buildExplainPrompt`, `buildAskPrompt`), which
 * silently drop a try line that does not start with the try, a game context that does not reach the position, and
 * illegal plies. The page has no DOM test renderer, so the Trainer's wiring is read from Trainer.tsx (as
 * tests/b2_trainer.test.tsx and tests/m3_trainer_a.test.tsx do); its parts are exported and tested here.
 *
 * Positions are textbook or invented, each checked with chess.js; the endgame drills are the page's own textbook
 * drills (data/technical_endgames.json). No owner game data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chess } from 'chess.js';
import {
  answerLineFrom, buildAskInput, cardKind, explainInput, movesNamed, staticExplanation, type AskContext, type CoachCard,
} from '../components/coachInput';
import { answersFor, cardTitleOf, DRILL_ASK_HINT, feedbackPosition, lineFromStep, questionCheck, teachKind, tryKey } from '../components/Trainer';
import CoachPanel from '../components/CoachPanel';
import { AnswersPanel, CardAnswer, type AnsweredNote } from '../components/HomePanels';
import { buildPools, type TrainerItem } from '../components/pools';
import type { LoadedPack } from '../components/model';
import { createTrainerModel } from '../components/model';
import { buildAskPrompt, buildExplainPrompt, COOLDOWN_MS, createCoach, inputsHash } from '../src/coach/index';
import { memoryKv } from '../src/coach/rateLimit';
import type { CoachClient, CoachExplainInput } from '../src/contract/coach';
import { readDoc, type FeedbackDoc } from '../src/contract/docs';
import { createFakeStore, createMemoryKv } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { narrateLine } from '../src/teach/narrate';
import { punishLesson } from '../src/teach/punish';
import { teachTry } from '../lib/endgameTeach';
import type { TryCheck } from '../src/teach/tryMove';
import { endgameDrills } from '../lib/endgames';
import { ARTIFACT_DIR } from './b3_paths';

const src = readFileSync(join(ARTIFACT_DIR, 'components/Trainer.tsx'), 'utf8');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const at = (text: string, s: string) => { const i = text.indexOf(s); assert.ok(i >= 0, `missing: ${s}\n--- in ---\n${text}`); return i; };
function after(fen: string, uci: string) {
  const b = new Chess(fen);
  const m = b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return { fen: b.fen(), san: m.san };
}
const firstReply = (fen: string, uci: string) => { const b = new Chess(after(fen, uci).fen); const m = b.moves({ verbose: true })[0]; return m ? `${m.from}${m.to}${m.promotion ?? ''}` : ''; };
const check = (o: Partial<TryCheck> & Pick<TryCheck, 'tryUci' | 'trySan' | 'replyLine' | 'tryWin'>): TryCheck =>
  ({ bestWin: null, verdict: 'worse', depth: 12, ms: 5, ...o });

// ---------------------------------------------------------------- fixtures (invented)

/** His game (White): Re7 leaves the back rank; Black (the solver) plays Rd1+ Re1 Rxe1#. Better was h3. */
const BEFORE = '3r2k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';
function punishCard(winAfter = 2): TrainerItem {
  const g = after(BEFORE, 'e1e7');
  return {
    id: 'punish-t1', fen: g.fen, moves: ['d8d1'], rating: 1000, themes: ['personal', 'opening'], gameUrl: '', source: 'pack', kind: 'punish',
    title: 'Punish it · Rapid · move 30',
    pack: { playedSan: g.san, playedUci: 'e1e7', sourceFen: BEFORE, pvUci: ['d8d1', 'e7e1', 'd1e1'], rowId: 't1', winAfter, solverColor: 'b', timeClass: 'rapid' },
  };
}
const siblingCard = (): TrainerItem => ({
  id: 'pack-t1', fen: BEFORE, moves: ['h2h3'], rating: 1000, themes: ['personal'], gameUrl: '', source: 'pack', kind: 'mistake',
  title: 'Rapid · move 30', pack: { playedSan: 'Re7', playedUci: 'e1e7', pvUci: ['h2h3', 'd8d1', 'e1d1'] },
});
/** Black's try 1...h6?, and an engine check of it: 2.Kf1 Rd1+ 3.Re1. Win% with decimals (rounded in the input). */
const PUNISH_TRY = { uci: 'h7h6', san: 'h6', reply: ['g1f1', 'd8d1', 'e7e1'] };
const punishCheck = (o: Partial<TryCheck> = {}) => check({ tryUci: 'h7h6', trySan: 'h6', replyLine: PUNISH_TRY.reply, tryWin: 30.4, bestWin: 99.6, verdict: 'losing', ...o });

/** The French after 1.e4 e6 2.d4 d5 (Codex P1's repro): White's try exd5 is answered by the same-SAN recapture exd5. */
const FRENCH = 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6 0 3';
const frenchBank = (): TrainerItem => ({ id: 'bank-french', fen: FRENCH, moves: ['b1c3', 'g8f6', 'c1g5'], rating: 1400, themes: ['opening', 'advantage'], gameUrl: '', source: 'bank' });
/** A mistake card from his games at the same position: his game move was exd5; the stored line after it is exd5 Nc3. */
const frenchMistake = (o: Record<string, unknown> = {}): TrainerItem => ({
  id: 'pack-french', fen: FRENCH, moves: ['b1c3'], rating: 1000, themes: ['personal', 'opening'], gameUrl: '', source: 'pack', kind: 'mistake',
  title: 'Blitz · move 3', explanation: 'Keep the tension: Nc3 develops and defends e4.',
  pack: { playedSan: 'exd5', playedUci: 'e4d5', pvUci: ['b1c3', 'g8f6'], refutationPvUci: ['e6d5', 'b1c3'], winBefore: 60.4, winAfter: 35.2, timeClass: 'blitz', date: '2026-01-02', ...o },
});

const drill = (id: string): TrainerItem => {
  const d = endgameDrills.find(x => x.id === id);
  assert.ok(d, id);
  return { id: d!.id, fen: d!.fen, moves: [...d!.moves], rating: d!.rating, themes: [...d!.themes], gameUrl: '', source: 'endgame', title: d!.title, explanation: d!.explanation };
};

test('fixtures are legal: every line replays with chess.js', () => {
  const lines: Array<[string, string[]]> = [
    [BEFORE, ['e1e7', 'd8d1', 'e7e1', 'd1e1']], [BEFORE, ['h2h3', 'd8d1', 'e1d1']], [punishCard().fen, [PUNISH_TRY.uci, ...PUNISH_TRY.reply]],
    [FRENCH, ['e4d5', 'e6d5', 'b1c3']], [FRENCH, ['b1c3', 'g8f6', 'c1g5']],
  ];
  for (const [fen, line] of lines) { const b = new Chess(fen); for (const u of line) assert.doesNotThrow(() => b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }), `${u} from ${fen}`); }
});

// ---------------------------------------------------------------- the explain input (9.2)

test('explain, punish card: the whole answer line, his game move and the sibling move with its line, the try line, rounded numbers', () => {
  const card = punishCard(), sib = siblingCard();
  const input = explainInput(card, { fen: card.fen, uci: PUNISH_TRY.uci, index: 0 }, card.source, { check: punishCheck(), sibling: sib })!;
  assert.ok(input);
  assert.deepEqual(input.bestLineSan, ['Rd1+', 'Re1', 'Rxe1#'], 'the whole pack.pvUci, not the one-move card line (diagnosis 1)');
  assert.equal(input.bestLineNotes?.length, 3);
  assert.deepEqual(input.tryLineSan, ['h6', 'Kf1', 'Rd1+', 'Re1'], 'the try first, then the engine reply line');
  assert.equal(input.tryLineNotes?.length, 4);
  assert.equal(input.trySource, 'engine');
  assert.deepEqual([input.tryWin, input.bestWin, input.tryVerdict], [30, 100, 'losing'], 'whole numbers; the class from the rounded values');
  assert.deepEqual([input.gameFen, input.gameMoveSan, input.betterMoveSan], [BEFORE, 'Re7', 'h3']);
  assert.deepEqual(input.betterLineSan, ['h3', 'Rd1', 'Rxd1'], "the sibling's whole line from pack.sourceFen");
  assert.deepEqual([input.answerSource, input.objective, input.step, input.spoilersAllowed, input.title], ['game-engine', 'exploit the move just played', 0, true, 'Punish it · Rapid · move 30']);
  assert.equal(input.framing, "A position from the learner's own game, right after his move Re7. He now plays his opponent's side (Black) to find how to exploit that move. Instead of Re7, the better move in his game was h3.");
  assert.equal(input.lesson, punishLesson(card, sib));
  assert.ok(input.boardText?.startsWith('White: Kg1, Re7; pawns f2, g2, h2. Black: Kg8, Rd8'));
  // Never the stored figures on a punish card: they are his view, about another move.
  assert.deepEqual([input.winBefore, input.winAfter, input.refutationSan], [undefined, undefined, []]);
  // The prompt shows every piece: nothing was dropped by its legality checks.
  const { prompt } = buildExplainPrompt(input);
  for (const s of [
    'Card title: Punish it · Rapid · move 30.', 'What this card teaches: A position from the learner', 'Goal of this card: exploit the move just played.',
    "His move Re7 led to this position; on this card he plays Black.", 'the better move for White was h3. Its engine line from there: h3 Rd1 Rxd1.',
    "Answer line (the engine's best line, in a position from the learner's own game): Rd1+ Re1 Rxe1#.",
    "Line after the learner's try (engine line, searched in this page): h6 Kf1 Rd1+ Re1.",
    'from the search in this page: 100% after Rd1+, 30% after h6, a difference of 70 points.', 'This was his first move on the card.',
    'First say what goes wrong after h6, naming the reply Kf1. Then explain the idea of Rd1+ and its line.',
  ]) at(prompt, s);
  // Without the sibling the context keeps his move only; without a check the try has no line and no class.
  const bare = explainInput(card, { fen: card.fen, uci: PUNISH_TRY.uci, index: 0 }, card.source)!;
  assert.deepEqual([bare.betterMoveSan, bare.betterLineSan, bare.tryLineSan, bare.tryVerdict, bare.tryWin], [undefined, undefined, undefined, 'unchecked', undefined]);
  assert.match(bare.framing!, /exploit that move\.$/);
  const plain = buildExplainPrompt(bare).prompt;
  at(plain, 'Say how h6 and Rd1+ differ, using only these lines. Do not claim that h6 fails or loses.');
});

test('explain: the class and numbers come from gradeTry (9.1): rounded first, trusted only at depth 0 or 10 and more', () => {
  const card = punishCard();
  const wrong = { fen: card.fen, uci: PUNISH_TRY.uci, index: 0 };
  // 64.6 against 69.6 rounds to 65 against 70: also good (unrounded it would be "worse"). Fix round 2 (9.11.2 p, FX4a):
  // on a punish card a near try is a soft retry; the coach gets 'strong', no depth-12 pair, and one plain note instead.
  // (This line pinned 'also-good' with the numbers 65 and 70, and the "about as good" prompt, before.)
  const near = explainInput(card, wrong, card.source, { check: punishCheck({ tryWin: 64.6, bestWin: 69.6 }) })!;
  assert.deepEqual([near.tryVerdict, near.tryWin, near.bestWin], ['strong', undefined, undefined]);
  assert.equal(near.tryCheckNote, "A quick engine check in this page rated h6 close to the card's move, but the analysis that picked this card found one clearly better move.");
  const nearPrompt = buildExplainPrompt(near).prompt;
  at(nearPrompt, `Note on the learner's try: ${near.tryCheckNote}`);
  at(nearPrompt, 'Say in plain words what the note on h6 says. Then compare the two lines: say what Rd1+ does that h6 does not. Do not say that h6 fails or loses, and do not say that it is as good as Rd1+.');
  assert.doesNotMatch(nearPrompt, /By these numbers h6 is about as good as Rd1\+/);
  // A strong try (70 against 95) is never told that it fails (Codex F2).
  const strong = explainInput(card, wrong, card.source, { check: punishCheck({ tryWin: 70.2, bestWin: 94.8 }) })!;
  assert.equal(strong.tryVerdict, 'strong');
  assert.doesNotMatch(buildExplainPrompt(strong).prompt, /what goes wrong/);
  // Depth 9: the line is kept and labelled unfinished, with no class and no numbers.
  const shallow = explainInput(card, wrong, card.source, { check: punishCheck({ depth: 9 }) })!;
  assert.deepEqual([shallow.tryVerdict, shallow.tryWin, shallow.bestWin, shallow.trySource], ['unchecked', undefined, undefined, 'engine']);
  const sp = buildExplainPrompt(shallow).prompt;
  at(sp, "Line after the learner's try (engine line from a search in this page that did not finish): h6 Kf1 Rd1+ Re1.");
  assert.doesNotMatch(sp, /%/);
  // Depth 0 (both positions already finished) is exact.
  assert.equal(explainInput(card, wrong, card.source, { check: punishCheck({ depth: 0 }) })!.tryVerdict, 'losing');
  // A check for another move is ignored (identity).
  assert.equal(explainInput(card, wrong, card.source, { check: punishCheck({ tryUci: 'g7g6', trySan: 'g6' }) })!.tryLineSan, undefined);
  // Every Win% the input carries is a whole number; the same try gives the same input (and inputsHash).
  for (const i of [strong]) for (const k of ['tryWin', 'bestWin'] as const) assert.ok(Number.isInteger(i[k]), k);
  assert.equal(inputsHash(near), inputsHash(explainInput(card, wrong, card.source, { check: punishCheck({ tryWin: 64.6, bestWin: 69.6 }) })!));
});

test('explain, Codex P1: a same-SAN recapture stays intact (engine line and stored line); refutationSan stays the reply alone', () => {
  // Engine: 3.exd5 exd5 4.Nc3, from a check of the try on a bank card.
  const bank = frenchBank();
  const live = explainInput(bank, { fen: FRENCH, uci: 'e4d5', index: 0 }, 'bank', { check: check({ tryUci: 'e4d5', trySan: 'exd5', replyLine: ['e6d5', 'b1c3'], tryWin: 40.2, bestWin: 55.4 }) })!;
  assert.deepEqual(live.tryLineSan, ['exd5', 'exd5', 'Nc3']);
  assert.deepEqual(live.refutationSan, [], 'no stored refutation on a puzzle');
  assert.deepEqual([live.answerSource, live.objective, live.tryVerdict], ['puzzle', undefined, 'worse'], 'a puzzle line with no mate and no material: no goal is claimed');
  assert.equal(live.framing, 'A Lichess puzzle rated 1400. The learner plays White; the puzzle line is forced.');
  at(buildExplainPrompt(live).prompt, "Line after the learner's try (engine line, searched in this page): exd5 exd5 Nc3.");
  // Stored: his own game move on a mistake card, no engine result. The whole line goes to tryLineSan; the M2
  // refutationSan stays the reply alone (the prompt puts the try in front of it); the figures are rounded.
  const card = frenchMistake();
  const stored = explainInput(card, { fen: FRENCH, uci: 'e4d5', index: 0 }, 'pack')!;
  assert.deepEqual(stored.tryLineSan, ['exd5', 'exd5', 'Nc3']);
  assert.deepEqual(stored.refutationSan, ['exd5', 'Nc3']);
  assert.deepEqual([stored.trySource, stored.winBefore, stored.winAfter], ['stored', 60, 35]);
  // The stored analysis of exactly this move gives the class the try viewer titles it with (35 after against 60: worse).
  assert.equal(stored.tryVerdict, 'worse');
  assert.equal(stored.framing, "A position from the learner's own blitz game (2026-01-02). He played exd5 there; the engine's move was Nc3. The card asks for the engine's move.");
  assert.deepEqual([stored.objective, stored.lesson, stored.answerSource], ["find the engine's move from your game", 'Keep the tension: Nc3 develops and defends e4.', 'game-engine']);
  const sp = buildExplainPrompt(stored).prompt;
  at(sp, "Line after the learner's try (line stored with the card): exd5 exd5 Nc3.");
  at(sp, 'Stored winning chances for White as the engine scales them: 60% before exd5 and 35% after it');
  at(sp, 'First say what goes wrong after exd5, naming the reply exd5.');
  // The static panel prints refutationSan as "the engine's reply line": here it is the stored engine reply.
  assert.deepEqual(staticExplanation(stored), { playedSan: 'exd5', bestLineSan: ['Nc3', 'Nf6'], refutationSan: ['exd5', 'Nc3'], numbers: 'Stored win chance for you: 60% before, 35% after.' });
  // A personal card keeps the prompt's own label ("a short engine scan's candidate line"), not "the engine's best line".
  const personalCard: TrainerItem = { ...card, source: 'personal' };
  const personal = explainInput(personalCard, { fen: FRENCH, uci: 'f1d3', index: 0 }, 'personal')!;
  assert.equal(personal.answerSource, undefined);
  at(buildExplainPrompt(personal).prompt, "Answer line (a short engine scan's candidate line): Nc3 Nf6.");
});

test('explain, endgame drills: tablebase results in words and the listed line, never a percentage, never the engine', () => {
  const kpk = drill('tech-kpk-take-the-opposition');
  const input = explainInput(kpk, { fen: kpk.fen, uci: 'e3e4', index: 0 }, 'endgame', { check: check({ tryUci: 'e3e4', trySan: 'e4', replyLine: [], tryWin: 50.2, bestWin: 99.9 }) })!;
  assert.deepEqual([input.tryResult, input.bestResult, input.tryVerdict, input.trySource], ['draw', 'win', 'worse', 'tablebase']);
  assert.deepEqual([input.tryWin, input.bestWin], [undefined, undefined], 'an engine check passed by mistake is ignored on a drill');
  assert.equal(input.tryLineSan?.[0], 'e4');
  assert.ok((input.tryLineSan?.length ?? 0) > 2);
  assert.deepEqual([input.answerSource, input.objective], ['tablebase', 'win the endgame']);
  assert.match(input.framing!, /^A textbook endgame drill: Take the opposition \(win the endgame\)\. Results come from the endgame tablebase\. Idea: .{20,}$/);
  assert.equal(input.lesson, kpk.explanation);
  const { prompt } = buildExplainPrompt(input);
  at(prompt, 'Tablebase result with best play from both sides: after Ke4, White wins; after e4, the game is a draw.');
  at(prompt, "Line after the learner's try (tablebase line):");
  assert.doesNotMatch(prompt, /%/);
  // The static panel never prints a tablebase line as "the engine's reply line"; the results come in words.
  assert.deepEqual(staticExplanation({ ...input, refutationSan: ['Kd6'] }).refutationSan, []);
  assert.equal(staticExplanation(input).numbers, 'Tablebase result with best play: after e4, the game is a draw; after Ke4, White wins.');
  // A slower mate keeps the goal: "also wins, like Kg6, but this card asks for Kg6" (and the count is a digit, which grounding accepts).
  const krk = drill('tech-krk-mate-in-two-king-step');
  const ra8 = explainInput(krk, { fen: krk.fen, uci: 'a7a8', index: 0 }, 'endgame')!;
  assert.deepEqual([ra8.tryVerdict, ra8.tryResult, ra8.bestResult, ra8.objective], ['strong', 'win', 'win', 'find the mate in 2']);
  const rp = buildExplainPrompt(ra8).prompt;
  at(rp, 'By the tablebase, Ra8+ also wins, like Kg6, but this card asks for Kg6.');
  at(rp, 'Ra8+ is still a good move: do not say that it fails or loses.');
  assert.doesNotMatch(rp, /%|what goes wrong/);
  // Every drill's framing fits the prompt's 400 characters with its idea.
  for (const d of endgameDrills) {
    const item = drill(d.id);
    const legal = new Chess(item.fen).moves({ verbose: true }).find(m => `${m.from}${m.to}` !== item.moves[0])!;
    const i = explainInput(item, { fen: item.fen, uci: `${legal.from}${legal.to}${legal.promotion ?? ''}`, index: 0 }, 'endgame')!;
    assert.ok(i.framing!.length <= 400 && i.framing!.includes(' Idea: '), d.id);
    assert.doesNotMatch(JSON.stringify(i), /"(tryWin|bestWin|winBefore|winAfter)"/, d.id);
  }
});

test('explain, later steps and kinds: the answer line from the step; the step; the kind shared with the hint ladder', () => {
  // A three-ply puzzle line from the French: at step 2 the answer line is Bg5 (the line from that step).
  const bank = frenchBank();
  const pos2 = after(after(FRENCH, 'b1c3').fen, 'g8f6').fen;
  const input = explainInput(bank, { fen: pos2, uci: 'f1d3', index: 2 }, 'bank')!;
  assert.deepEqual([input.bestSan, input.bestLineSan, input.step], ['Bg5', ['Bg5'], 2]);
  at(buildExplainPrompt(input).prompt, 'This was his move 2 on the card, after the first 2 plies of its line.');
  // One definition of the line from a step (hints and coach) and of the card kind.
  assert.deepEqual(lineFromStep(bank, 2), answerLineFrom(bank, 2));
  assert.deepEqual(answerLineFrom({ ...bank, pack: { pvUci: ['b1c3', 'g8f6', 'f1d3'] } }, 2), ['c1g5'], 'a stored line that leaves the card at this step is not used');
  assert.deepEqual(answerLineFrom({ ...bank, pack: { pvUci: ['b1c3', 'g8f6', 'c1g5', 'f8e7'] } }, 2), ['c1g5', 'f8e7']);
  for (const item of [bank, frenchMistake(), punishCard(), drill('tech-kpk-take-the-opposition'), { ...bank, source: 'agent' as const }, { ...frenchMistake(), source: 'personal' as const }]) {
    assert.equal(teachKind(item), cardKind(item, item.source), item.id);
  }
  // Claude's drill: the framing names its title; a line that mates gives the goal "find the mate".
  const agent: TrainerItem = { id: 'agent-mate', fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', moves: ['a1a8'], rating: 900, themes: ['mateIn1'], gameUrl: '', source: 'agent', title: 'Back rank' };
  const a = explainInput(agent, { fen: agent.fen, uci: 'h2h3', index: 0 }, 'agent')!;
  assert.deepEqual([a.framing, a.objective, a.answerSource], ['A practice line set by Claude: Back rank.', 'find the mate', 'drill']);
  assert.equal(a.lesson, narrateLine(agent.fen, agent.moves).summary, "no explanation: the narrator's summary of its line");
  assert.match(a.lesson!, /checkmate/);
  // The b2 fixture's minimal card (no title, date or time class) gets no empty slot.
  const minimal = explainInput({ id: 'pack-0000000000000001', fen: agent.fen, moves: ['a1a8'], themes: ['backRankMate'], pack: { playedUci: 'g1f1' } }, { fen: agent.fen, uci: 'g1f1', index: 0 }, 'pack')!;
  assert.equal(minimal.framing, "A position from the learner's own game. He played Kf1 there; the engine's move was Ra8#. The card asks for the engine's move.");
  assert.doesNotMatch(JSON.stringify(minimal), /\( *\)|  |undefined|null/);
});

test('explain input in the Trainer: one per try, the check matched by card, step and try; the reveal keeps its identity', () => {
  assert.equal(tryKey('punish-t1', 0, 'h7h6'), 'punish-t1|0|h7h6');
  assert.match(src, /const key = tryKey\(item\.id, at, uci\);/, 'the try view is keyed the same way');
  assert.match(src, /tryView\?\.status === 'done' && tryView\.source === 'engine' && tryView\.key === tryKey\(active\.id, wrong\.index, wrong\.uci\) \? tryView\.check \?\? null : null;/);
  assert.match(src, /return explainInput\(active, wrong, active\.source, \{ check, sibling \}\);\s*\}, \[active, wrong, tryView, sibling\]\);/);
  // F2: the request goes out with the input built before the reveal; a rebuilt input must keep itemId, playedUci and
  // fen (the panel's reset keys). A finished or dropped check changes the line, never those three.
  const card = punishCard();
  const wrong = { fen: card.fen, uci: PUNISH_TRY.uci, index: 0 };
  const before = explainInput(card, wrong, card.source)!, withCheck = explainInput(card, wrong, card.source, { check: punishCheck(), sibling: siblingCard() })!;
  assert.deepEqual([before.itemId, before.playedUci, before.fen], [withCheck.itemId, withCheck.playedUci, withCheck.fen]);
  assert.equal(before.spoilersAllowed, true, 'the click that sends it reveals the answer');
});

// ---------------------------------------------------------------- the ask input (L6)

test('ask: moves named in the question that are legal at the card position (SAN, UCI, lowercase pieces, castling with zeros), at most 3', () => {
  assert.deepEqual(movesNamed(FRENCH, 'Why not exd5, or nc3? b1c3 again? What about Qh8, Kf7 and the pawn on h3?'),
    [{ uci: 'e4d5', san: 'exd5' }, { uci: 'b1c3', san: 'Nc3' }], 'illegal Qh8 and Kf7 are ignored; b1c3 is Nc3 again; "on h3" is a square');
  assert.deepEqual(movesNamed(FRENCH, 'exd5? Nc3! Push h3. And Bb5+?').map(m => m.san), ['exd5', 'Nc3', 'h3'], 'three at most, in his order');
  assert.deepEqual(movesNamed('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'Is 0-0 better than O-O-O?').map(m => m.san), ['O-O', 'O-O-O']);
  assert.deepEqual(movesNamed('8/4P3/8/8/8/8/k7/7K w - - 0 1', 'e8=Q, e8q or e7e8n?').map(m => m.san), ['e8=Q', 'e8=N']);
  assert.deepEqual(movesNamed(FRENCH, 'What is the idea here? Why is the bishop on c1 bad?'), [], 'no move named');
  assert.deepEqual(movesNamed('not a fen', 'e4'), []);
});

/** A stub of the page's engine checker: a legal first reply, the Win% from `wins` (60 by default), depth 12 unless listed. */
function stubChecker(wins: Record<string, number> = {}, shallow: string[] = []) {
  const calls: string[] = [];
  const fn: AskContext['check'] = async (fen, uci) => {
    calls.push(uci);
    return check({ tryUci: uci, trySan: after(fen, uci).san, replyLine: [firstReply(fen, uci)].filter(Boolean), tryWin: wins[uci] ?? 60, depth: shallow.includes(uci) ? 9 : 12 });
  };
  return { calls, fn };
}

test('ask: each legal move is checked once (the answer first), Win% rounded and only from a finished search; illegal moves never reach the engine', async () => {
  const bank = frenchBank();
  const engine = stubChecker({ b1c3: 55.4, e4d5: 40.6 }, ['h2h3']);
  const input = (await buildAskInput(bank, 'bank', 'Why not exd5? And nc3 or h3? Qh8?', new AbortController().signal, { check: engine.fn }))!;
  assert.deepEqual(engine.calls, ['b1c3', 'e4d5', 'h2h3'], 'the answer once, first (Nc3 is the answer: reused), then each other move');
  assert.deepEqual(input.askedLines.map(a => [a.san, a.lineSan[0], a.win, a.source]), [['exd5', 'exd5', 41, 'engine'], ['Nc3', 'Nc3', 55, 'engine'], ['h3', 'h3', undefined, 'engine']]);
  assert.equal(input.answerWin, 55);
  assert.deepEqual([input.fen, input.side, input.answerLineSan, input.answerSource, input.itemId], [FRENCH, 'w', ['Nc3', 'Nf6', 'Bg5'], 'puzzle', 'bank-french']);
  const { prompt } = buildAskPrompt(input);
  at(prompt, 'Moves from the question that the page checked:');
  at(prompt, 'Winning chances for White as the engine scales them: 41% after exd5, 55% after Nc3, a difference of 14 points.');
  assert.doesNotMatch(prompt.split("The learner's question")[0], /Qh8/, 'an illegal move is not given as checked');
  // His latest try from the card position was already checked: nothing is searched again.
  const again = stubChecker();
  const known = { fen: FRENCH, check: check({ tryUci: 'e4d5', trySan: 'exd5', replyLine: ['e6d5', 'b1c3'], tryWin: 40.6, bestWin: 55.4 }) };
  const reused = (await buildAskInput(bank, 'bank', 'Why not exd5?', new AbortController().signal, { check: again.fn, known }))!;
  assert.deepEqual(again.calls, []);
  assert.deepEqual([reused.askedLines[0].lineSan, reused.askedLines[0].win, reused.answerWin], [['exd5', 'exd5', 'Nc3'], 41, 55]);
  // No move named: no search at all, and the prompt says so.
  const none = stubChecker();
  const plain = (await buildAskInput(bank, 'bank', 'What is the plan here?', new AbortController().signal, { check: none.fn }))!;
  assert.deepEqual([none.calls, plain.askedLines, plain.answerWin], [[], [], undefined]);
  at(buildAskPrompt(plain).prompt, 'The page found no move in the question that it could check.');
});

test('ask, punish card: the game context and the card fields come along; without an engine the stored line of his game move only', async () => {
  const card = punishCard(), sib = siblingCard();
  const engine = stubChecker();
  const input = (await buildAskInput(card, 'pack', 'Why not h6 first?', new AbortController().signal, { check: engine.fn, sibling: sib }))!;
  assert.deepEqual([input.gameFen, input.gameMoveSan, input.betterMoveSan, input.betterLineSan], [BEFORE, 'Re7', 'h3', ['h3', 'Rd1', 'Rxd1']]);
  assert.deepEqual([input.answerLineSan, input.objective, input.answerSource, input.lesson], [['Rd1+', 'Re1', 'Rxe1#'], 'exploit the move just played', 'game-engine', punishLesson(card, sib)]);
  const { prompt } = buildAskPrompt(input);
  at(prompt, 'His move Re7 led to this position');
  at(prompt, 'Checked move h6. Its line (engine line, searched in this page): h6');
  // His own game move named on a mistake card, with no engine result: the stored line, without a figure; any other
  // move the engine could not check is left out (never sent under an engine label).
  const noEngine: AskContext['check'] = async () => null;
  const mistake = frenchMistake();
  const stored = (await buildAskInput(mistake, 'pack', 'Why was exd5 bad? And Nc3?', new AbortController().signal, { check: noEngine }))!;
  assert.deepEqual(stored.askedLines, [{ san: 'exd5', lineSan: ['exd5', 'exd5', 'Nc3'], notes: stored.askedLines[0].notes, source: 'stored' }]);
  assert.equal(stored.answerWin, undefined);
  // In this test runner there is no Web Worker, so the page's checker has no engine and gives null.
  assert.equal(await questionCheck(FRENCH, 'e4d5', null, new AbortController().signal), null);
});

test('ask, endgame drills: the tablebase data only (the engine is never called), results in words', async () => {
  const kpk = drill('tech-kpk-take-the-opposition');
  const engine = stubChecker();
  // The king already stands on d4 and cannot reach f2: Kd4 and Kf2 are not legal here and are ignored.
  const input = (await buildAskInput(kpk, 'endgame', 'What about e4, or Kd4? Kc4? And Ke4? Or Kf2?', new AbortController().signal, { check: engine.fn }))!;
  assert.deepEqual(engine.calls, [], 'never the engine on a drill');
  assert.equal(input.answerResult, 'win');
  assert.deepEqual(input.askedLines.map(a => [a.san, a.result, a.source]),
    [['e4', 'draw', 'tablebase'], ['Kc4', teachTry(kpk.id, kpk.fen, 'd4c4').result, 'tablebase'], ['Ke4', 'win', 'tablebase']]);
  for (const a of input.askedLines) assert.equal(a.win, undefined);
  assert.ok(input.askedLines[0].lineSan.length > 2, 'the listed line after e4');
  const { prompt } = buildAskPrompt(input);
  at(prompt, 'Tablebase result with best play from both sides: after e4, the game is a draw; after Ke4, White wins.');
  assert.doesNotMatch(prompt, /%/);
});

test('ask: Stop aborts at once and nothing more is searched; an input for a card no longer on screen is dropped', async () => {
  const bank = frenchBank();
  const calls: string[] = [];
  const waiting: AskContext['check'] = (_fen, uci, _a, signal) => {
    calls.push(uci);
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }));
  };
  const stop = new AbortController();
  const pending = buildAskInput(bank, 'bank', 'exd5 or h3?', stop.signal, { check: waiting });
  await new Promise(r => setTimeout(r, 5));
  stop.abort();
  assert.equal(await pending, null);
  assert.deepEqual(calls, ['b1c3'], 'stopped during the first search');
  const stopped = new AbortController(); stopped.abort();
  assert.equal(await buildAskInput(bank, 'bank', 'exd5?', stopped.signal, { check: waiting }), null);
  // The card changed while the engine worked: the input is dropped (the panel drops it too: askKey = card id).
  let current = true;
  const engine = stubChecker();
  const switching: AskContext['check'] = async (...args) => { const r = await engine.fn(...args); current = false; return r; };
  assert.equal(await buildAskInput(bank, 'bank', 'exd5 or h3?', new AbortController().signal, { check: switching, isCurrent: () => current }), null);
  assert.deepEqual(engine.calls, ['b1c3']);
});

test('ask and explain inputs pass the coach client (validation, cache path) and the answer is grounded on the given lines', async () => {
  const prompts: string[] = [];
  let clock = 1_000_000;
  const coach = createCoach({
    sample: async i => { prompts.push(String(i)); return { text: 'After h6, Kf1 and Rd1+ follow, then Re1. Rd1+ first wins: Rd1+ Re1 Rxe1#.', truncated: false }; },
    permissions: null, store: createFakeStore(), deviceId: 'd1', storage: memoryKv(), now: () => clock,
  });
  const card = punishCard(), sib = siblingCard();
  const explain = explainInput(card, { fen: card.fen, uci: PUNISH_TRY.uci, index: 0 }, card.source, { check: punishCheck(), sibling: sib })!;
  const r1 = await coach.ask(explain);
  assert.equal(r1.grounded, true, r1.misses.join(', '));
  const ask = (await buildAskInput(card, 'pack', 'Why not h6 first?', new AbortController().signal, { check: stubChecker().fn, sibling: sib }))!;
  clock += COOLDOWN_MS + 1; // the page's own cooldown between two questions
  const r2 = await coach.ask(ask);
  assert.equal(r2.cached, false);
  assert.equal(prompts.length, 2);
});

// ---------------------------------------------------------------- the question box after completion (L6, 8.7)

test('question box wiring: one panel in one place; the box only once complete; askKey is the card id; asking pauses the advance', () => {
  assert.equal((src.match(/<CoachPanel /g) ?? []).length, 1, 'one panel: a second one would remount on the reveal and cancel its request');
  assert.match(src, /\{\(coachInput \|\| \(complete && coach\)\) && <CoachPanel coach=\{coach\} input=\{coachInput\} revealsAnswer=\{!complete\} onAsk=\{\(\) => \{ cancelAdvance\(\); coached\.current = true; if \(!complete\) reveal\(\); \}\}/);
  assert.match(src, /askInput=\{complete \? askInput : undefined\} askKey=\{active\.id\} askHint=\{isEndgameDrill\(active\) \? DRILL_ASK_HINT : undefined\}/);
  assert.match(src, /onAskQuestion=\{\(\) => \{ cancelAdvance\(\); coached\.current = true; \}\} onInteract=\{cancelAdvance\}\/>\}/);
  assert.match(src, /buildAskInput\(card, card\.source, question, signal, \{ sibling, known, check: questionCheck, isCurrent: \(\) => latest\.current\.active\?\.id === card\.id \}\)/);
  // The panel as the Trainer renders it after a clean solve: no wrong move, the question box, the drill hint on drills.
  const coach: CoachClient = { availability: async () => 'granted', ask: async () => { throw new Error('not called'); }, limits: () => ({ remainingToday: 20, cooldownUntil: 0 }) };
  const html = renderToStaticMarkup(<CoachPanel coach={coach} input={null} initialAvailability="granted" askInput={() => null} askKey="bank-french"/>);
  assert.match(html, /<form class="coach-ask feedback-note">/);
  assert.match(html, /Ask Claude about this position/);
  assert.doesNotMatch(html, /Why does my move fail\?/);
  const drillHtml = renderToStaticMarkup(<CoachPanel coach={coach} input={null} initialAvailability="granted" askInput={() => null} askKey="d" askHint={DRILL_ASK_HINT}/>);
  assert.ok(drillHtml.includes(esc(DRILL_ASK_HINT)));
  assert.doesNotMatch(DRILL_ASK_HINT, /!|—/);
});

// ---------------------------------------------------------------- feedback from the page (8.3)

test('feedback: a note points at the latest try and the position it was played from; else the card; the doc stays a version-6 document', async () => {
  const card = frenchBank();
  const pos2 = after(after(FRENCH, 'b1c3').fen, 'g8f6').fen;
  assert.deepEqual(feedbackPosition(card, null), { fen: FRENCH });
  assert.deepEqual(feedbackPosition(card, { fen: pos2, uci: 'f1d3', index: 2 }), { fen: pos2, playedUci: 'f1d3' }, 'the latest try, at step 2');
  assert.deepEqual(feedbackPosition(card, { fen: pos2, uci: 'not-a-move', index: 2 }), { fen: FRENCH }, 'never a field the schema would refuse');
  // FX2c (9.11.3 R1-2): the page passes its latest try, set on every try (it passed `wrong`, which a try being checked
  // cleared); tests/m3_fix2b_trainer.test.tsx pins where it is set and cleared.
  assert.match(src, /const at = feedbackPosition\(active, latestTry\.current\);\s*return model\.sendFeedback\(\{ kind, item: \{ id: active\.id, source: active\.source, themes: active\.themes, fen: at\.fen \}, \.\.\.\(at\.playedUci \? \{ playedUci: at\.playedUci \} : \{\}\), text \}\);/);
  assert.match(src, /\.\.\.\(firstWrong\.current \? \{ playedUci: firstWrong\.current \} : \{\}\)/, 'the attempt still records his first wrong move');
  // Through the model and the store: the document parses with the frozen contract (src/contract/docs.ts = version 6).
  const store = createFakeStore();
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'd1', events: null });
  const model = createTrainerModel({ store, sessions, deviceId: 'd1' });
  try {
    const target = feedbackPosition(card, { fen: pos2, uci: 'f1d3', index: 2 });
    assert.equal(await model.sendFeedback({ kind: 'comment', item: { id: card.id, source: card.source, themes: card.themes, fen: target.fen }, playedUci: target.playedUci, text: 'invented note' }), true);
    const dump = store.dump();
    const path = Object.keys(dump).find(p => p.startsWith('feedback/'))!;
    const doc = readDoc<FeedbackDoc>(path, dump[path]);
    assert.ok(doc);
    assert.deepEqual([doc!.fen, doc!.playedUci, doc!.itemId, doc!.status], [pos2, 'f1d3', 'bank-french', 'open']);
  } finally { model.dispose(); sessions.dispose(); }
});

// ---------------------------------------------------------------- Claude's answers to his notes (L7)

const note = (id: string, itemId: string, source: FeedbackDoc['source'], at: number, reply: string | undefined, o: Partial<FeedbackDoc> = {}): AnsweredNote =>
  ({ id, doc: { at, kind: 'comment', itemId, source, themes: [], fen: FRENCH, sessionId: 's', status: reply ? 'done' : 'open', ...(reply ? { reply } : {}), ...o } });

test('answers: on the card once it is complete, and in the From Claude area with each card\'s title (held punish cards too)', () => {
  const answers = [
    note('f1', 'punish-held', 'pack', 3_000, 'Your move left the back rank open.', { text: 'What is the lesson here?' }),
    note('f2', 'bank-french', 'bank', 2_000, 'The puzzle line is correct.', { kind: 'wrong', text: undefined }),
    note('f3', 'tech-kpk-take-the-opposition', 'endgame', 1_000, 'Ke4 keeps the opposition.'),
    note('f4', 'bank-french', 'bank', 4_000, undefined, { text: 'still open' }),
  ];
  // On the card: only this card's answered notes (an open one is not an answer).
  const mine = answersFor(answers, 'bank-french');
  assert.deepEqual(mine.map(a => a.id), ['f2', 'f4']);
  const onCard = renderToStaticMarkup(<CardAnswer items={mine}/>);
  assert.match(onCard, /Claude&#x27;s answer to your note/);
  assert.ok(onCard.includes('The puzzle line is correct.') && !onCard.includes('still open'));
  assert.deepEqual(answersFor(answers, undefined), []);
  // Titles: a held punish card (small edge) is still found; a Lichess puzzle by its id; a drill by its title.
  const held = { ...punishCard(55), id: 'punish-held', title: 'Punish it · Rapid · move 12' };
  const pack = { version: 'v', meta: {} as LoadedPack['meta'], study: [], punishStudy: [], cards: [], punish: [held as never] } as unknown as LoadedPack;
  const pools = buildPools({ bank: [frenchBank()], endgames: [drill('tech-kpk-take-the-opposition')], pack, personal: [], drills: [] });
  assert.equal(pools.byId.has('punish-held'), false, 'held back by the curation');
  const titleOf = cardTitleOf(pools);
  assert.deepEqual(['punish-held', 'bank-french', 'tech-kpk-take-the-opposition', 'gone'].map(titleOf), ['Punish it · Rapid · move 12', 'Lichess puzzle bank-french', 'Take the opposition', null]);
  const panel = renderToStaticMarkup(<AnswersPanel items={answers} titleOf={titleOf}/>);
  assert.ok(panel.indexOf('Punish it · Rapid · move 12') < panel.indexOf('Lichess puzzle bank-french'), 'newest first');
  assert.ok(panel.includes('Your move left the back rank open.') && panel.includes('Take the opposition'));
  assert.ok(!panel.includes('still open'), 'only answered notes');
  // Wiring: the card's answers inside the complete branch after the drill idea or lesson; the panel right after the plan and notes.
  // Stage (c) (Cc, 8.6): the complete branch is now the `solved` part of the panel (PracticeColumns places the parts).
  const done = src.indexOf('solved: complete ? <>'), actions = src.indexOf('<div className="coach-actions">');
  assert.ok(done > 0, 'the complete branch is found');
  const notes = src.indexOf('<SolvedNotes', done), card = src.indexOf('<CardAnswer items={cardAnswers}/>', done), next = src.indexOf('<button className="primary wide"', done);
  assert.ok(done < notes && notes < card && card < next && next < actions, 'CardAnswer in the complete branch, after SolvedNotes, before Next');
  // Fix round 2 (9.11.2 s): the panel right after the plan and notes is AnswersArea, which holds the replies back while the
  // card on the board is unsolved (tests/m3_fix2a_trainer.test.tsx). This line pinned the bare AnswersPanel before.
  assert.match(src, /<PlanAndNotes id="from-claude" [^\n]*\/>\n\s*<AnswersArea items=\{view\.answeredFeedback\} titleOf=\{titleOf\} solving=\{boardUnsolved && !notesAsked\} onShow=\{showNotesNow\}\/>/);
  assert.match(src, /const cardAnswers = useMemo\(\(\) => answersFor\(view\.answeredFeedback, active\?\.id\), \[view\.answeredFeedback, active\?\.id\]\);/);
  assert.match(src, /const titleOf = useMemo\(\(\) => cardTitleOf\(pools\), \[pools\]\);/);
});
