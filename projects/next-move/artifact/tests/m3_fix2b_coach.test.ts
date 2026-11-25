/**
 * M3 fix round 2, stage 2 (brief 9.11.3), writer FX4b: punish lessons and the coach.
 * - R3-4: no "That allowed" for a piece the level-1 hint calls still loose; R3-5: a mate is said once.
 * - R5-1 mate markers from `mateInN` themes and the drill goal counted from the board; R5-2 citable numbers from the
 *   figure sentences only, "40-point" and "+4" checked; R5-3 the ask instruction; R5-4 "at least as good";
 *   R5-5 one figure per move (stored figures out beside a finished live check; the lesson's figure out beside a live one;
 *   "still a good move" never beside a drop); R5-6 an unfinished asked line says so.
 * - The (p) note for questions (FX4a's open question 1, widened 10:24) and the no-change lesson (FX1b's open issue).
 * Positions are textbook (the French after 1.e4 e6 2.d4 d5, the page's own drills) or invented and checked with chess.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { buildHintsWithRules } from '../src/teach/hints';
import { narrateLine } from '../src/teach/narrate';
import { leftStillPiece, punishLesson, type PunishLike } from '../src/teach/punish';
import { buildAskInput, drillGoalFrom, explainInput, staticExplanation, type AskContext, type CoachCard } from '../components/coachInput';
import { buildAskPrompt, buildExplainPrompt, themeMateDistances, UNFINISHED_LINE_LABEL } from '../src/coach/prompts';
import { givenInText, groundCheck, mateMarker } from '../src/coach/ground';
import { checkedLines } from '../components/CoachPanel';
import { drillGoalAt, gradeCardTry } from '../components/Trainer';
import type { TrainerItem } from '../components/pools';
import { endgameDrills } from '../lib/endgames';
import { drillTeach } from '../lib/endgameTeach';
import type { CoachAskInput } from '../src/contract/coach';
import type { TryCheck } from '../src/teach/tryMove';

const at = (text: string, s: string) => assert.ok(text.includes(s), `missing: ${s}\n--- in ---\n${text}`);
const play = (fen: string, uci: string) => {
  const b = new Chess(fen);
  const m = b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return { fen: b.fen(), san: m.san };
};
const fenAfter = (fen: string, line: string[]) => line.reduce((f, u) => play(f, u).fen, fen);
const check = (o: Partial<TryCheck> & Pick<TryCheck, 'tryUci' | 'tryWin'>): TryCheck =>
  ({ trySan: o.tryUci, replyLine: [], bestWin: null, verdict: 'worse', depth: 12, ms: 5, ...o });
const signal = () => new AbortController().signal;

// ---------------------------------------------------------------- invented punish cards (his game move, then the line)

/** A punish card as the pack stores it: the position after his game move; the solver is his opponent. */
function punishCard(id: string, before: string, playedUci: string, pv: string[], winAfter: number): CoachCard & PunishLike {
  const g = play(before, playedUci);
  return {
    id, fen: g.fen, moves: [pv[0]], themes: ['personal', 'punish'], kind: 'punish', title: 'Punish it · Rapid · move 30',
    pack: { playedSan: g.san, playedUci, sourceFen: before, pvUci: pv, rowId: `${id}-row`, winAfter, timeClass: 'rapid', date: '2026-01-05' },
  };
}
/** Black's knight on e5 is already loose (Bc3 attacks it, nothing defends it); his move h6 leaves it; Bxe5 takes it. */
const STILL_BEFORE = '6k1/5ppp/8/4n3/8/2B5/6PP/6K1 b - - 0 1';
const stillTakes = () => punishCard('fx4b-still-takes', STILL_BEFORE, 'h7h6', ['c3e5'], 10);
/** Black's knight on a5 is already loose (Ra1); after his h6 the line starts with the check Qd5+ and takes it later. */
const LATER_BEFORE = '6k1/6pp/8/n7/8/8/6PP/R2Q2K1 b - - 0 1';
const stillLater = () => punishCard('fx4b-still-later', LATER_BEFORE, 'h7h6', ['d1d5', 'g8h7', 'a1a5'], 5);
/** The pawn on d6 defends the knight on e5; his d5 takes that away (the knight is newly loose): "That allowed". */
const NEW_BEFORE = '6k1/5ppp/3p4/4n3/8/2B5/6PP/6K1 b - - 0 1';
const leftNew = (winAfter = 10) => punishCard('fx4b-left-new', NEW_BEFORE, 'd6d5', ['c3e5'], winAfter);
/** His Ra7 leaves the back rank: Rb1 mates at once. */
const MATE_BEFORE = '1r4k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const mateInOne = () => punishCard('fx4b-mate-one', MATE_BEFORE, 'a1a7', ['b8b1'], 0);

/** The level-1 rule for a punish card at its start, built as the page builds it (`hintLadderFor` at step 0). */
const levelOneRule = (c: CoachCard & PunishLike) => {
  const p = c.pack as Record<string, string>;
  return buildHintsWithRules({ fen: c.fen, line: c.pack ? (c.pack as { pvUci: string[] }).pvUci : c.moves, themes: c.themes, kind: 'punish', ply: 0, justPlayed: { uci: p.playedUci, san: p.playedSan, byLearner: true, fenBefore: p.sourceFen } });
};

// ---------------------------------------------------------------- textbook coach cards

/** The French after 1.e4 e6 2.d4 d5, White to move. */
const FRENCH = 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6 0 3';
/** An own-game mistake card (invented figures): his game move exd5 (stored reply exd5 Nc3); the engine's move Nc3. */
const frenchMistake = (o: Record<string, unknown> = {}): CoachCard => ({
  id: 'fx4b-pack-french', fen: FRENCH, moves: ['b1c3'], themes: ['personal', 'opening'], kind: 'mistake', title: 'Blitz · move 3',
  pack: { playedSan: 'exd5', playedUci: 'e4d5', pvUci: ['b1c3', 'g8f6'], refutationPvUci: ['e6d5', 'b1c3'], winBefore: 60.4, winAfter: 35.2, cpBefore: 40, cpAfter: -60, timeClass: 'blitz', date: '2026-01-02', ...o },
});
/** A Lichess-style bank card at the French (invented line). */
const frenchBank = (moves = ['b1c3', 'g8f6', 'c1g5']): CoachCard => ({ id: 'fx4b-bank-french', fen: FRENCH, moves, rating: 1400, themes: ['opening', 'advantage'] });
/** The page's drill as a card. */
const drill = (id: string): CoachCard & TrainerItem => {
  const d = endgameDrills.find(x => x.id === id);
  if (!d) throw new Error(id);
  return { ...d, id: d.id, fen: d.fen, moves: [...d.moves], themes: [...d.themes], source: 'endgame' } as unknown as CoachCard & TrainerItem;
};
/** The page's own KRK mate-in-two position served as a bank puzzle tagged mateIn2 (R5's fixture). */
const mateBank = (): CoachCard => {
  const d = drill('tech-krk-mate-in-two-king-step');
  return { id: 'fx4b-bank-mate2', fen: d.fen, moves: [...d.moves], rating: 1100, themes: ['endgame', 'mate', 'mateIn2', 'short'] };
};
/** The page's own KRK mate-in-three position served as a bank puzzle tagged mateIn3. */
const mate3Bank = (): CoachCard => {
  const d = drill('tech-krk-mate-in-three');
  return { id: 'fx4b-bank-mate3', fen: d.fen, moves: [...d.moves], rating: 1300, themes: ['mate', 'mateIn3'] };
};

test('fixtures: every line and try below is legal from its position', () => {
  for (const [fen, line] of [
    [STILL_BEFORE, ['h7h6', 'c3e5']], [LATER_BEFORE, ['h7h6', 'd1d5', 'g8h7', 'a1a5']], [NEW_BEFORE, ['d6d5', 'c3e5']], [MATE_BEFORE, ['a1a7', 'b8b1']],
    [FRENCH, ['b1c3', 'g8f6', 'c1g5']], [FRENCH, ['e4d5', 'e6d5', 'b1c3']], [FRENCH, ['f1b5']],
  ] as Array<[string, string[]]>) assert.doesNotThrow(() => fenAfter(fen, line), `${line.join(' ')} from ${fen}`);
  assert.ok(new Chess(fenAfter(MATE_BEFORE, ['a1a7', 'b8b1'])).isCheckmate(), 'Rb1 is mate');
  for (const c of [mateBank(), mate3Bank()]) assert.doesNotThrow(() => fenAfter(c.fen, c.moves));
  assert.ok(new Chess(fenAfter(mate3Bank().fen, mate3Bank().moves)).isCheckmate(), 'the mate-in-three line ends in mate');
});

// ---------------------------------------------------------------- R3-4 and R3-5: the punish lesson

test('R3-4: a piece the level-1 hint calls still loose is "left to be taken", never "allowed"; the reply that takes it says so', () => {
  const c = stillTakes();
  const rule = levelOneRule(c);
  assert.equal(rule.rules.idea, 'punish/left-still');
  assert.match(rule.hints[0].text, /After it, a black knight is still undefended\.$/);
  assert.deepEqual(leftStillPiece(c), { piece: 'n', square: 'e5' });
  const lesson = punishLesson(c, { fen: STILL_BEFORE, moves: ['g7g6'] })!;
  assert.equal(lesson, 'In your game you played h6. Your move left the knight on e5 to be taken: Bxe5, which takes it. White wins a knight. Better was g6.');
  assert.doesNotMatch(lesson, /That allowed/);
});

test('R3-4: when the line takes that piece later (the reply is a check first), the reply is plain "best reply", never "allowed"', () => {
  const c = stillLater();
  assert.equal(levelOneRule(c).rules.idea, 'punish/left-still');
  assert.deepEqual(leftStillPiece(c), { piece: 'n', square: 'a5' });
  const lesson = punishLesson(c, null)!;
  assert.match(lesson, /^In your game you played h6\. White's best reply is Qd5\+, which [^.]+\. Then Rxa5 takes the knight on a5\. White wins a knight\.$/);
  assert.doesNotMatch(lesson, /That allowed|Your move left/);
});

test('R3-4: a piece his move newly left loose keeps "That allowed"; leftStillPiece is null for any other rule', () => {
  const c = leftNew();
  assert.equal(levelOneRule(c).rules.idea, 'punish/left-new');
  assert.equal(leftStillPiece(c), null);
  assert.equal(punishLesson(c, { fen: NEW_BEFORE, moves: ['g7g6'] }), 'In your game you played d5. That allowed Bxe5, which takes the knight on e5. White wins a knight. Better was g6.');
  for (const bad of [{ ...c, pack: undefined }, { ...c, fen: 'bad' }, { ...c, pack: { ...(c.pack as object), sourceFen: undefined } }]) assert.equal(leftStillPiece(bad as PunishLike), null);
});

test('R3-4 invariant over seeded random games: left-still never reads "That allowed", and "Your move left" only with left-still', () => {
  let seed = 20261113;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  let cards = 0, still = 0, left = 0;
  for (let g = 0; g < 12; g++) {
    const b = new Chess();
    for (let i = 0; i < 60 && !b.isGameOver(); i++) {
      const moves = b.moves({ verbose: true });
      const caps = moves.filter(m => m.captured);
      b.move(caps.length && rand() < 0.35 ? caps[Math.floor(rand() * caps.length)] : moves[Math.floor(rand() * moves.length)]);
    }
    const hist = b.history({ verbose: true });
    for (let k = 4; k + 3 < hist.length; k += 5) {
      const playedUci = `${hist[k].from}${hist[k].to}${hist[k].promotion ?? ''}`;
      const pv = hist.slice(k + 1, k + 7).map(m => `${m.from}${m.to}${m.promotion ?? ''}`);
      const c = punishCard(`rand-${g}-${k}`, hist[k].before, playedUci, pv, Math.round(rand() * 1000) / 10);
      const rule = levelOneRule(c).rules.idea;
      const lesson = punishLesson(c, null)!;
      const where = `game ${g} ply ${k} (${rule}): ${lesson}`;
      assert.ok(lesson && lesson.length <= 300, where);
      cards++;
      if (rule === 'punish/left-still') { still++; assert.doesNotMatch(lesson, /That allowed/, where); assert.ok(leftStillPiece(c), where); }
      if (/Your move left the /.test(lesson)) { left++; assert.equal(rule, 'punish/left-still', where); }
      if (rule !== 'punish/left-still' && cards % 4 === 0) assert.equal(leftStillPiece(c), null, where);
    }
  }
  // About 130 cards, 19 left-still, 6 of them with the reply taking the piece (13 Nov, counted while FX1c edited narrate.ts).
  assert.ok(cards >= 100 && still >= 5 && left >= 1, `cards ${cards}, left-still ${still}, "Your move left" ${left}`);
});

test('R3-5: a reply that mates at once says the mate once (no closing "The line ends in checkmate")', () => {
  const c = mateInOne();
  const lesson = punishLesson(c, { fen: MATE_BEFORE, moves: ['h2h3'] })!;
  assert.equal(lesson, 'In your game you played Ra7. That allowed Rb1#, which is checkmate. Better was h3.');
  assert.equal(lesson.match(/checkmate/g)?.length, 1);
  // A mate later in the line still closes the lesson as before (the key move names it).
  const two = punishCard('fx4b-mate-two', '1r4k1/5ppp/8/8/8/8/5PPP/2R3K1 w - - 0 1', 'c1c7', ['b8b1', 'c7c1', 'b1c1'], 1);
  assert.match(punishLesson(two, null)!, /^In your game you played Rc7\. That allowed Rb1\+, which gives check\. Then Rxc1# takes the rook on c1 with checkmate\.$/);
});

test('R5-5 (lesson): engineFigure false leaves out every engine sentence; the default keeps it', () => {
  const small = leftNew(40); // White's chances 60: a small edge, so the lesson ends on the engine's number
  const sib = { fen: NEW_BEFORE, moves: ['g7g6'] };
  assert.equal(punishLesson(small, sib), 'In your game you played d5. That allowed Bxe5, which takes the knight on e5. After your move the engine gives White about 60% to win, only a small edge. Better was g6.');
  assert.equal(punishLesson(small, sib, { engineFigure: false }), 'In your game you played d5. That allowed Bxe5, which takes the knight on e5. Better was g6.');
  assert.equal(punishLesson(small, sib, { engineFigure: true }), punishLesson(small, sib));
  // Missed win (his side still better): no figure and no "still better" without it.
  const missed = leftNew(70);
  assert.match(punishLesson(missed, sib)!, /Black is still better \(about 70% to win\)\./);
  const plain = punishLesson(missed, sib, { engineFigure: false })!;
  assert.doesNotMatch(plain, /%|still better|about level/);
  assert.match(plain, /^In your game you played d5\. White's best reply is Bxe5, which takes the knight on e5\. Better was g6\.$/);
  // A settled material result is not an engine figure: it stays.
  assert.match(punishLesson(stillTakes(), null, { engineFigure: false })!, /White wins a knight\.$/);
});

// ---------------------------------------------------------------- R5-1: mate markers

test('R5-1: themeMateDistances counts from the try\'s step; a mateInN theme makes "mate in N" citable in explain and ask', async () => {
  assert.deepEqual(themeMateDistances(['mate', 'mateIn3', 'mateIn3', 'mateIn1', 'mateInX', 7]), [3, 1]);
  assert.deepEqual([themeMateDistances(['mateIn3'], 2), themeMateDistances(['mateIn3'], 3), themeMateDistances(['mateIn2'], 4)], [[2], [2], []]);
  // Explain at step 0 (R5's repro): "mate in 2" is grounded, another distance is not.
  const card = mateBank();
  const input = explainInput(card, { fen: card.fen, uci: 'a7a8', index: 0 }, 'bank', { check: check({ tryUci: 'a7a8', trySan: 'Ra8+', tryWin: 70, bestWin: 100 }) })!;
  const built = buildExplainPrompt(input);
  at(built.prompt, 'Themes: endgame, mate, mateIn2, short.');
  assert.ok(built.squares?.includes(mateMarker(2)));
  assert.equal(groundCheck(`${input.bestSan} is the start of a mate in 2.`, built, 'explain').grounded, true);
  assert.deepEqual(groundCheck('It is a mate in 3.', built, 'explain').misses, ['mate in 3']);
  // Ask: the input carries the themes, and the prompt states them.
  const ask = (await buildAskInput(card, 'bank', 'Why is Kg6 so strong?', signal(), { check: async () => null }))!;
  assert.deepEqual(ask.themes, ['endgame', 'mate', 'mateIn2', 'short']);
  const askBuilt = buildAskPrompt(ask);
  at(askBuilt.prompt, 'Themes: endgame, mate, mateIn2, short.');
  assert.equal(groundCheck('Kg6 starts a mate in 2.', askBuilt, 'ask').grounded, true);
  assert.deepEqual(groundCheck('Kg6 starts a mate in 2.', buildAskPrompt({ ...ask, themes: undefined }), 'ask').misses, ['mate in 2'], 'the marker comes from the themes');
  assert.ok(!buildAskPrompt({ ...ask, themes: undefined }).prompt.includes('Themes:'));
});

test('R5-1: at a later step the theme counts what is left: mate in 2 at the second move of a mate in three (bank and drill)', () => {
  const bank = mate3Bank();
  const step2 = fenAfter(bank.fen, bank.moves.slice(0, 2));
  const tryMove = new Chess(step2).moves({ verbose: true }).find(m => `${m.from}${m.to}` !== bank.moves[2] && !m.san.includes('#'))!;
  const input = explainInput(bank, { fen: step2, uci: `${tryMove.from}${tryMove.to}${tryMove.promotion ?? ''}`, index: 2 }, 'bank', {})!;
  const built = buildExplainPrompt(input);
  at(built.prompt, 'Themes: mate, mateIn3.');
  at(built.prompt, "From this position the card's line is a mate in 2.");
  assert.equal(groundCheck('From here it is mate in 2.', built, 'explain').grounded, true);
  assert.deepEqual(groundCheck('From here it is mate in 3.', built, 'explain').misses, ['mate in 3']);
  assert.ok(!buildExplainPrompt({ ...input, step: 0 }).prompt.includes('From this position'), 'at the start the theme line says it');

  // The drill: its goal is worded from the board shown, as the page's message ("not in two"); its title ("mate in three")
  // is no fact about this position, so the stale distance stays flagged (R5-1b).
  const d = drill('tech-krk-mate-in-three');
  const st = drillTeach(d.id)!.steps.find(s => s.step === 2)!;
  const mv = new Chess(st.fen).moves({ verbose: true }).find(m => `${m.from}${m.to}` !== d.moves[2] && !m.san.includes('#'))!;
  const uci = `${mv.from}${mv.to}${mv.promotion ?? ''}`;
  const di = explainInput(d, { fen: st.fen, uci, index: 2 }, 'endgame')!;
  assert.equal(di.objective, 'find the mate in 2');
  assert.match(di.framing!, /\(find the mate in 2\)/);
  const dp = buildExplainPrompt(di);
  assert.equal(groundCheck('From here it is mate in 2.', dp, 'explain').grounded, true);
  assert.deepEqual(groundCheck('From here it is mate in 3.', dp, 'explain').misses, ['mate in 3']);
  assert.equal(gradeCardTry(d, st.fen, uci, 2, null).grade.message, 'That also mates, but not in two. Try again.', 'the page says the same distance');
  // At the start the goal is the drill's own N.
  assert.equal(explainInput(d, { fen: d.fen, uci: new Chess(d.fen).moves({ verbose: true }).map(m => `${m.from}${m.to}`).find(u => u !== d.moves[0])!, index: 0 }, 'endgame')!.objective, 'find the mate in 3');
  // Every mate drill at every solver step: the goal is the distance left, it is grounded, one more is flagged.
  let checked = 0;
  for (const m of endgameDrills.filter(x => x.themes.some(t => /^mateIn\d+$/.test(t)))) {
    const card = drill(m.id);
    for (const s of drillTeach(card.id)?.steps ?? []) {
      if (s.step % 2) continue;
      const left = drillGoalAt(card, s.step).mateIn!;
      const t = new Chess(s.fen).moves({ verbose: true }).find(x => `${x.from}${x.to}${x.promotion ?? ''}` !== card.moves[s.step] && !x.san.includes('#'));
      if (!t) continue;
      const inp = explainInput(card, { fen: s.fen, uci: `${t.from}${t.to}${t.promotion ?? ''}`, index: s.step }, 'endgame')!;
      const built = buildExplainPrompt(inp);
      const where = `${card.id} step ${s.step}`;
      assert.equal(inp.objective, `find the mate in ${left}`, where);
      assert.equal(groundCheck(`From here it is mate in ${left}.`, built, 'explain').grounded, true, where);
      assert.deepEqual(groundCheck(`From here it is mate in ${left + 1}.`, built, 'explain').misses, [`mate in ${left + 1}`], where);
      checked++;
    }
  }
  assert.ok(checked >= 6, String(checked));
  // The drill's own explanation says "mate in two" about its start: at step 2 that lesson grounds no distance.
  const king = drill('tech-krk-mate-in-two-king-step');
  const k2 = drillTeach(king.id)!.steps.find(s => s.step === 2)!;
  const kt = new Chess(k2.fen).moves({ verbose: true }).find(x => `${x.from}${x.to}` !== king.moves[2] && !x.san.includes('#'))!;
  const kp = buildExplainPrompt(explainInput(king, { fen: k2.fen, uci: `${kt.from}${kt.to}`, index: 2 }, 'endgame')!);
  assert.match(kp.prompt, /Card lesson: [^\n]*mate in two/, 'fixture: the lesson says it');
  assert.deepEqual(groundCheck('It is mate in 2.', kp, 'explain').misses, ['mate in 2']);
  const u0 = new Chess(king.fen).moves({ verbose: true }).map(m => `${m.from}${m.to}`).find(u => u !== king.moves[0])!;
  const k0 = buildExplainPrompt(explainInput(king, { fen: king.fen, uci: u0, index: 0 }, 'endgame')!);
  assert.equal(groundCheck('It is mate in 2.', k0, 'explain').grounded, true, 'at the start it is true and grounded');
});

test('R5-1: drillGoalFrom equals the page\'s drillGoalAt for every drill and step; the coach class equals the page\'s on every drill try', () => {
  let steps = 0;
  for (const d of endgameDrills) for (let i = 0; i <= d.moves.length + 1; i++) { assert.deepEqual(drillGoalFrom(d.themes, i), drillGoalAt(d as unknown as TrainerItem, i), `${d.id} ${i}`); steps++; }
  assert.ok(steps > 26);
  let tries = 0;
  for (const d0 of endgameDrills) {
    const d = drill(d0.id);
    for (const s of drillTeach(d.id)?.steps ?? []) {
      for (const m of new Chess(s.fen).moves({ verbose: true })) {
        const uci = `${m.from}${m.to}${m.promotion ?? ''}`;
        if (uci === d.moves[s.step] || m.san.includes('#')) continue;
        tries++;
        assert.equal(explainInput(d, { fen: s.fen, uci, index: s.step }, 'endgame')?.tryVerdict, gradeCardTry(d, s.fen, uci, s.step, null).grade.tryVerdict, `${d.id} step ${s.step} ${m.san}`);
      }
    }
  }
  assert.ok(tries > 400, String(tries));
});

// ---------------------------------------------------------------- R5-2: citable numbers

test('R5-2: invented figures from the title, the date and the framing are flagged; "40-point" and "+4" are checked', () => {
  const input = explainInput(frenchMistake(), { fen: FRENCH, uci: 'e4d5', index: 0 }, 'pack', { check: null })!;
  const built = buildExplainPrompt(input);
  at(built.prompt, 'Card title: Blitz · move 3.');
  at(built.prompt, '(2026-01-02)');
  assert.deepEqual([...new Set(built.numbers)].sort((a, b) => a - b), [25, 35, 60], 'only the figure sentence: 60, 35 and the drop 25');
  const g = (t: string) => groundCheck(t, built, 'explain');
  assert.deepEqual(g('exd5 drops 2 points.').misses, ['2 points']);
  assert.deepEqual(g('After exd5 you keep only 3%.').misses, ['3%']);
  assert.deepEqual(g('exd5 is a 40-point drop.').misses, ['40-point']);
  assert.deepEqual(g('The engine rates exd5 at +4 for Black.').misses, ['+4']);
  assert.deepEqual(g('That is −2 for you.').misses, ['−2']);
  // The real figures pass in every form; a result, a range and castling are not signed numbers.
  for (const ok of ['exd5 is a 25-point drop.', 'Your chances fell from 60% to 35%.', 'That is +25 points against you.', 'A drop of 25 percentage points.', 'That is −25.', 'The game ended 1-0 after 2-3 more moves.'])
    assert.deepEqual(g(ok), { grounded: true, misses: [] }, ok);
});

test('R5-2: a lesson\'s Win% figure stays citable, its other numbers do not; givenInText options', () => {
  const c = leftNew(40);
  const input = explainInput(c, { fen: c.fen, uci: 'h2h3', index: 0 }, 'pack', { sibling: { id: 'pack-x', fen: NEW_BEFORE, moves: ['g7g6'], themes: [] } })!;
  at(input.lesson!, 'about 60% to win');
  const built = buildExplainPrompt(input);
  assert.ok(built.numbers.includes(60) && !built.numbers.includes(30), 'the lesson\'s 60% yes, the title\'s "move 30" no');
  assert.equal(groundCheck('After his move you have about 60% to win.', built, 'explain').grounded, true);
  assert.deepEqual(groundCheck('Move 30 cost him 30%.', built, 'explain').misses, ['30%']);
  // The helper.
  const text = 'Rapid · move 30 (2026-01-05): about 85% to win, Qxf7 is mate in 2, then mate in one.';
  assert.deepEqual(givenInText(text).numbers, [30, 2026, 1, 5, 85, 2]);
  assert.deepEqual(givenInText(text, { numbers: 'percent' }).numbers, [85]);
  assert.deepEqual(givenInText(text, { numbers: 'none' }).numbers, []);
  assert.deepEqual(givenInText(text).squares.filter(s => s.startsWith('mate')), [mateMarker(1), mateMarker(2)], 'words and digits');
  assert.deepEqual(givenInText(text, { mates: false }).squares.filter(s => s.startsWith('mate')), []);
  assert.deepEqual(givenInText(text, { numbers: 'none', mates: false }).sans, ['Qxf7']);
});

// ---------------------------------------------------------------- R5-3: the ask instruction

test('R5-3: the ask prompt asks for "did not check" without the move; that answer is grounded, naming the move is not', async () => {
  const c = mateInOne();
  const input = (await buildAskInput(c, 'pack', 'Why not Qh4 here?', signal(), { check: async () => null }))!;
  assert.deepEqual(input.askedLines, [], 'Black has no queen: nothing to check');
  const built = buildAskPrompt(input);
  at(built.prompt, 'If the question is about a move that is not in these lines, say that this page did not check that move, without writing the move, and do not judge it.');
  at(built.prompt, 'The page found no move in the question that it could check.');
  assert.deepEqual(groundCheck('This page did not check that move, so I cannot judge it.', built, 'ask'), { grounded: true, misses: [] });
  assert.deepEqual(groundCheck('This page did not check Qh4, so I cannot judge it.', built, 'ask').misses, ['Qh4']);
});

// ---------------------------------------------------------------- R5-4: at least as good

test('R5-4: a try the numbers rate at least as high as the answer is "at least as good", never "about" or "nearly"', () => {
  const bank = frenchBank();
  const p = (uci: string, tryWin: number, bestWin: number) => {
    const input = explainInput(bank, { fen: FRENCH, uci, index: 0 }, 'bank', { check: check({ tryUci: uci, tryWin, bestWin, replyLine: [] }) })!;
    return { verdict: input.tryVerdict, prompt: buildExplainPrompt(input).prompt };
  };
  const above = p('e4e5', 90, 60);
  assert.equal(above.verdict, 'also-good');
  at(above.prompt, 'By these numbers e5 is at least as good as Nc3. Say so, then explain the idea of Nc3 and its line. Do not invent a fault in e5.');
  const level = p('g1f3', 55, 50);
  assert.equal(level.verdict, 'close');
  at(level.prompt, 'By these numbers Nf3 is at least as good as Nc3. Compare the two lines: say how Nf3 and Nc3 differ. Do not say that Nf3 fails or loses.');
  const equal = p('g1f3', 80, 80);
  at(equal.prompt, 'By these numbers Nf3 is at least as good as Nc3.');
  for (const x of [above, level, equal]) assert.doesNotMatch(x.prompt, /about as good|nearly as good/);
  // Below the answer the wording is as before.
  at(p('g1f3', 52, 55).prompt, 'By these numbers Nf3 is nearly as good as Nc3. Compare the two lines: say what Nc3 does that Nf3 does not.');
  at(p('g1f3', 79, 80).prompt, 'By these numbers Nf3 is about as good as Nc3.');
  // Without the numbers as basis (the page's class alone) nothing is claimed about which is higher.
  const input = explainInput(bank, { fen: FRENCH, uci: 'g1f3', index: 0 }, 'bank', { check: check({ tryUci: 'g1f3', tryWin: 90, bestWin: 60 }) })!;
  at(buildExplainPrompt({ ...input, tryWin: undefined, bestWin: undefined }).prompt, "By the page's check Nf3 is about as good as Nc3.");
});

// ---------------------------------------------------------------- R5-5: one figure per move

test('R5-5: his game move with a finished live check: no stored figures, cp values or reply line; one Win% for the move', () => {
  const c = check({ tryUci: 'e4d5', trySan: 'exd5', replyLine: ['e6d5', 'b1c3'], tryWin: 66, bestWin: 75 });
  const input = explainInput(frenchMistake(), { fen: FRENCH, uci: 'e4d5', index: 0 }, 'pack', { check: c })!;
  assert.deepEqual([input.tryVerdict, input.tryWin, input.bestWin], ['strong', 66, 75]);
  assert.deepEqual([input.winBefore, input.winAfter, input.cpBefore, input.cpAfter, input.refutationSan], [undefined, undefined, undefined, undefined, []]);
  assert.deepEqual([input.trySource, input.tryLineSan], ['engine', ['exd5', 'exd5', 'Nc3']]);
  const p = buildExplainPrompt(input).prompt;
  assert.ok(!p.includes('Stored winning chances') && !/35%|60%/.test(p), 'no stored figure');
  at(p, '75% after Nc3, 66% after exd5, a difference of 9 points.');
  assert.equal((p.match(/% after exd5/g) ?? []).length, 1, 'one Win% for exd5');
  // The static panel reads the same input: nothing stored to show.
  assert.deepEqual(staticExplanation(input), { playedSan: 'exd5', bestLineSan: ['Nc3', 'Nf6'], refutationSan: [], numbers: null });
  // Any finished class does the same (a worse try with numbers, a depth-0 result); an unfinished one keeps the stored pair.
  for (const fin of [check({ tryUci: 'e4d5', tryWin: 30, bestWin: 75 }), check({ tryUci: 'e4d5', tryWin: 30, bestWin: 75, depth: 0 })])
    assert.deepEqual([explainInput(frenchMistake(), { fen: FRENCH, uci: 'e4d5', index: 0 }, 'pack', { check: fin })!.winBefore], [undefined]);
  const shallow = explainInput(frenchMistake(), { fen: FRENCH, uci: 'e4d5', index: 0 }, 'pack', { check: { ...c, depth: 9 } })!;
  assert.deepEqual([shallow.winBefore, shallow.winAfter, shallow.refutationSan, shallow.trySource], [60, 35, ['exd5', 'Nc3'], 'stored']);
});

test('R5-5: "still a good move" never stands beside a stored drop', () => {
  // Stored figures alone (no check): 90 before, 80 after his move is a strong class with a 10-point drop.
  const input = explainInput(frenchMistake({ winBefore: 90, winAfter: 80 }), { fen: FRENCH, uci: 'e4d5', index: 0 }, 'pack', { check: null })!;
  assert.equal(input.tryVerdict, 'strong');
  const p = buildExplainPrompt(input).prompt;
  at(p, 'a drop of 10 points');
  at(p, 'Nc3 is stronger.');
  at(p, 'Do not say that exd5 fails or loses.');
  assert.doesNotMatch(p, /still a good move/);
  // Without a drop the wording is as before.
  at(buildExplainPrompt({ ...input, winBefore: undefined, winAfter: undefined }).prompt, 'exd5 is still a good move: do not say that it fails or loses.');
});

test('R5-5: the punish lesson leaves out its engine figure beside a live figure for the answer (explain bestWin, ask answerWin)', async () => {
  const c = leftNew(40);
  const sibling: CoachCard = { id: 'pack-x', fen: NEW_BEFORE, moves: ['g7g6'], themes: [] };
  const withFigure = punishLesson(c, sibling)!, without = punishLesson(c, sibling, { engineFigure: false })!;
  assert.notEqual(withFigure, without);
  // A worse try: the live pair is in the input, so the lesson has no figure.
  const worse = explainInput(c, { fen: c.fen, uci: 'h2h3', index: 0 }, 'pack', { sibling, check: check({ tryUci: 'h2h3', tryWin: 40, bestWin: 90, replyLine: ['e5c4'] }) })!;
  assert.deepEqual([worse.tryVerdict, worse.bestWin, worse.lesson], ['worse', 90, without]);
  assert.ok(!buildExplainPrompt(worse).numbers.includes(60), 'the stored 60% is not citable beside the live 90%');
  // The (p) soft try carries the note and no pair: the lesson keeps its figure. No check: as before.
  const near = explainInput(c, { fen: c.fen, uci: 'h2h3', index: 0 }, 'pack', { sibling, check: check({ tryUci: 'h2h3', tryWin: 88, bestWin: 90 }) })!;
  assert.deepEqual([near.tryVerdict, near.bestWin, near.lesson], ['strong', undefined, withFigure]);
  assert.equal(explainInput(c, { fen: c.fen, uci: 'h2h3', index: 0 }, 'pack', { sibling })!.lesson, withFigure);
  // Ask: a named move makes the page search the answer (answerWin), so the lesson loses its figure; no move named, no search.
  const engine: AskContext['check'] = async (_fen, uci) => check({ tryUci: uci, tryWin: uci === 'c3e5' ? 90 : 40 });
  const asked = (await buildAskInput(c, 'pack', 'Why not h3?', signal(), { sibling, check: engine }))!;
  assert.deepEqual([asked.answerWin, asked.lesson], [90, without]);
  const plain = (await buildAskInput(c, 'pack', 'What was the idea?', signal(), { sibling, check: engine }))!;
  assert.deepEqual([plain.answerWin, plain.lesson], [undefined, withFigure]);
  // The page's own lesson keeps the figure (Trainer and PunishStudy call punishLesson without the option).
  assert.match(withFigure, /about 60% to win/);
});

// ---------------------------------------------------------------- R5-6: an unfinished asked line

test('R5-6: an asked move whose search did not finish says so in the prompt and the panel, with no Win%', async () => {
  // Nc3 (the answer) 70, Bb5+ 40 (a pair: more than 5 points apart), Bd3 from a search that stopped at depth 9.
  const engine: AskContext['check'] = async (_fen, uci) =>
    check({ tryUci: uci, tryWin: uci === 'b1c3' ? 70 : 40, depth: uci === 'f1d3' ? 9 : 12, replyLine: uci === 'f1d3' ? ['d5e4', 'd3e4'] : ['g8f6'] });
  const input = (await buildAskInput(frenchMistake(), 'pack', 'What about Bd3? And Bb5+?', signal(), { check: engine }))!;
  const [bd3, bb5] = input.askedLines;
  assert.deepEqual([bd3.san, bd3.finished, bd3.win, 'finished' in bb5, bb5.win], ['Bd3', false, undefined, false, 40], 'only the unfinished line is marked');
  const p = buildAskPrompt(input).prompt;
  at(p, `Checked move Bd3. Its line (${UNFINISHED_LINE_LABEL}): Bd3 dxe4 Bxe4.`);
  at(p, 'Checked move Bb5+. Its line (engine line, searched in this page)');
  assert.equal(UNFINISHED_LINE_LABEL, 'engine line, from a search that did not finish');
  assert.deepEqual(checkedLines(input).slice(0, 1), [`Bd3 dxe4 Bxe4 (${UNFINISHED_LINE_LABEL})`]);
  // A Win% that came along anyway is never shown for an unfinished line.
  const forced: CoachAskInput = { ...input, askedLines: [{ ...bd3, win: 55 }] };
  assert.ok(!buildAskPrompt(forced).prompt.includes('55%') && !checkedLines(forced)[0].includes('55%'));
});

// ---------------------------------------------------------------- the (p) note for questions

test('ask note: on a pack card a named move within 5 points of the card\'s move gets the plain note instead of its pair', async () => {
  const wins: Record<string, number> = { b1c3: 60, g1f3: 57, f1d3: 50 };
  const calls: string[] = [];
  const engine: AskContext['check'] = async (_fen, uci) => { calls.push(uci); return check({ tryUci: uci, tryWin: wins[uci] ?? 30 }); };
  const input = (await buildAskInput(frenchMistake(), 'pack', 'What about Nf3, Bd3 or Nc3?', signal(), { check: engine }))!;
  assert.deepEqual(calls, ['b1c3', 'g1f3', 'f1d3']);
  const NOTE = "A quick engine check in this page rated Nf3 close to the card's move, but the analysis that picked this card found one clearly better move.";
  assert.deepEqual(input.askedLines.map(a => [a.san, a.win, a.checkNote]), [['Nf3', undefined, NOTE], ['Bd3', 50, undefined], ['Nc3', 60, undefined]]);
  assert.equal(input.answerWin, 60);
  const built = buildAskPrompt(input);
  at(built.prompt, `Note on Nf3: ${NOTE}`);
  at(built.prompt, 'Winning chances for White as the engine scales them: 50% after Bd3, 60% after Nc3, a difference of 10 points.');
  assert.ok(!built.prompt.includes('57%') && !built.numbers.includes(57) && !built.numbers.includes(3), 'no depth-12 pair for Nf3');
  assert.deepEqual(groundCheck('Nf3 has 57% here.', built, 'ask').misses, ['57%']);
  // The panel shows no figure for it either.
  assert.deepEqual(checkedLines(input).map(l => l.replace(/^\S+ /, '').replace(/^.*\(/, '(')), ['(engine line)', '(engine line; winning chances for White 50%)', '(engine line; winning chances for White 60%)']);
  // Above the card's move counts too (also-good), and his soft try reused from the page's check gets the note.
  const above = (await buildAskInput(frenchMistake(), 'pack', 'Nf3?', signal(), { check: async (_f, uci) => check({ tryUci: uci, tryWin: uci === 'g1f3' ? 75 : 60 }) }))!;
  assert.deepEqual([above.askedLines[0].win, above.askedLines[0].checkNote], [undefined, NOTE]);
  const known = { fen: FRENCH, check: check({ tryUci: 'g1f3', trySan: 'Nf3', tryWin: 66, bestWin: 64, replyLine: ['b8c6'] }) };
  const reused = (await buildAskInput(frenchMistake(), 'pack', 'Why not Nf3?', signal(), { known, check: async () => { throw new Error('not called'); } }))!;
  assert.deepEqual([reused.answerWin, reused.askedLines[0].win, reused.askedLines[0].checkNote], [64, undefined, NOTE]);
});

test('ask note: punish cards get it; Claude\'s drills, short-scan positions and puzzles keep their pairs; unfinished checks get none', async () => {
  const near: AskContext['check'] = async (_fen, uci) => check({ tryUci: uci, tryWin: uci === 'b1c3' || uci === 'c3e5' ? 60 : 58 });
  const punish = leftNew(10);
  const p = (await buildAskInput(punish, 'pack', 'What about h3?', signal(), { check: near }))!;
  assert.match(p.askedLines[0].checkNote ?? '', /^A quick engine check in this page rated h3 close to the card's move, but the analysis that picked this card found one clearly better move\.$/);
  assert.equal(p.askedLines[0].win, undefined);
  for (const [card, source] of [[frenchMistake(), 'personal'], [{ ...frenchBank(['b1c3']), id: 'fx4b-agent' }, 'agent'], [frenchBank(), 'bank']] as const) {
    const input = (await buildAskInput(card, source, 'What about Nf3?', signal(), { check: near }))!;
    assert.deepEqual([input.askedLines[0].win, input.askedLines[0].checkNote], [58, undefined], source);
    at(buildAskPrompt(input).prompt, '58% after Nf3, 60% after Nc3, a difference of 2 points.');
  }
  // No finished figure for the answer, or an unfinished check of the move: nothing to compare, no note.
  const noAnswer = (await buildAskInput(frenchMistake(), 'pack', 'Nf3?', signal(), { check: async (_f, uci) => (uci === 'b1c3' ? null : check({ tryUci: uci, tryWin: 58 })) }))!;
  assert.deepEqual([noAnswer.answerWin, noAnswer.askedLines[0].win, noAnswer.askedLines[0].checkNote], [undefined, 58, undefined]);
  const shallow = (await buildAskInput(frenchMistake(), 'pack', 'Nf3?', signal(), { check: async (_f, uci) => check({ tryUci: uci, tryWin: 58, depth: uci === 'g1f3' ? 9 : 12 }) }))!;
  assert.deepEqual([shallow.askedLines[0].finished, shallow.askedLines[0].win, shallow.askedLines[0].checkNote], [false, undefined, undefined]);
  // A note on a non-engine line is ignored by the prompt.
  const stored: CoachAskInput = { ...shallow, askedLines: [{ san: 'Nf3', lineSan: ['Nf3'], source: 'stored', checkNote: 'Other.' }] };
  assert.ok(!buildAskPrompt(stored).prompt.includes('Note on Nf3'));
});

// ---------------------------------------------------------------- FX1b's open issue: the no-change lesson

test('a narrated summary that says no material changes hands is no lesson for a puzzle; a change of material is', () => {
  const quiet = frenchBank(['f1b5']); // Bb5+ only: no capture, Black in check at the end
  const n = narrateLine(FRENCH, ['f1b5'], { maxPlies: 32 });
  assert.equal(n.material.net, 0, 'fixture: no material changes hands');
  assert.match(n.summary, /no material changes hands/);
  const input = explainInput(quiet, { fen: FRENCH, uci: 'g1f3', index: 0 }, 'bank')!;
  assert.equal(input.lesson, undefined);
  assert.ok(!buildExplainPrompt(input).prompt.includes('Card lesson'));
  // The settled form is left out too (as before), and a puzzle line that wins material keeps its summary as the lesson.
  const settled = frenchBank(['g1f3']);
  assert.equal(explainInput(settled, { fen: FRENCH, uci: 'f1d3', index: 0 }, 'bank')!.lesson, undefined);
  const knight = { id: 'fx4b-bank-knight', fen: '6k1/5ppp/8/4n3/8/2B5/6PP/6K1 w - - 0 1', moves: ['c3e5'], rating: 1000, themes: ['hangingPiece'] };
  const won = explainInput(knight, { fen: knight.fen, uci: 'h2h3', index: 0 }, 'bank')!;
  assert.deepEqual([won.lesson, won.objective], ['White wins a knight.', 'win material']);
  // An own explanation always wins.
  assert.equal(explainInput({ ...quiet, explanation: 'Bb5+ develops with tempo.' }, { fen: FRENCH, uci: 'g1f3', index: 0 }, 'bank')!.lesson, 'Bb5+ develops with tempo.');
});
