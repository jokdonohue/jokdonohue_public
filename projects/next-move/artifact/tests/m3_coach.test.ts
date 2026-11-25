// M3 coach (task A3, lead decisions L6 and L10): new explain fields, the `ask` kind, grounding over every line
// given, the prompt version in inputsHash, the ask cache path, and the question box in CoachPanel.
// Positions are textbook ones (1.e4 e5 2.Nf3 Nc6 3.Ng5?, a back-rank mate, a king and pawn ending).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFakeStore } from '../src/contract/store';
import { readDoc } from '../src/contract/docs';
import {
  COACH_LIMITS, CoachError, type CoachAskInput, type CoachClient, type CoachExplainInput, type CoachInput, type CoachResult, type SampleFn,
} from '../src/contract/coach';
import {
  buildAskPrompt, buildExplainPrompt, cachePath, createCoach, groundCheck, inputsHash, verdictFromWin, COACH_PROMPT_VERSION, COOLDOWN_MS,
} from '../src/coach/index';
import { canonicalJson, stableId } from '../src/coach/hash';
import { memoryKv } from '../src/coach/rateLimit';
import CoachPanel, { askLabel, checkedLines, runAsk, RequestGate, ASK_DEFAULT_HINT, ASK_PARTIAL } from '../components/CoachPanel';

// After 1.e4 e5 2.Nf3 Nc6 3.Ng5?: Black to move (a punish card). The answer 3...Qxg5 takes the loose knight;
// the try 3...Nf6? allows 4.Nxf7, forking the queen on d8 and the rook on h8. Better for White was 3.Bb5.
const FEN = 'r1bqkbnr/pppp1ppp/2n5/4p1N1/4P3/8/PPPP1PPP/RNBQKB1R b KQkq - 3 3';
/** The position before 3.Ng5 (the punish card's `pack.sourceFen`). */
const GAME_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
const BOARD = 'White: Ke1, Qd1, Ra1, Rh1, Bc1, Bf1, Nb1, Ng5; pawns a2, b2, c2, d2, e4, f2, g2, h2. Black: Ke8, Qd8, Ra8, Rh8, Bc8, Bf8, Nc6, Ng8; pawns a7, b7, c7, d7, e5, f7, g7, h7. Black to move.';
const explain: CoachExplainInput = {
  kind: 'explain', itemId: 'punish-test-1', source: 'pack', fen: FEN, side: 'b', playedUci: 'g8f6', playedSan: 'Nf6',
  bestUci: 'd8g5', bestSan: 'Qxg5', bestLineSan: ['Qxg5', 'd4', 'Qg6', 'dxe5'], refutationSan: [], themes: ['punish', 'opening'],
  framing: 'In your game White played Ng5 and left the knight on g5 undefended. Find the move that makes it cost.',
  boardText: BOARD,
  lesson: 'In your game you played Ng5. That allowed Qxg5: the queen takes the undefended knight on g5. Better was Bb5.',
  bestLineNotes: ['The queen takes the knight on g5.', 'The pawn attacks the pawn on e5.', 'The queen steps back to g6.', 'The pawn takes the pawn on e5.'],
  tryLineSan: ['Nf6', 'Nxf7'],
  tryLineNotes: ['The knight moves to f6.', 'The knight takes the pawn on f7 and attacks the queen on d8 and the rook on h8.'],
  trySource: 'engine', tryWin: 30.4, bestWin: 94.8,
  gameFen: GAME_FEN, gameMoveSan: 'Ng5', betterMoveSan: 'Bb5', betterLineSan: ['Bb5', 'a6', 'Ba4', 'Nf6'],
};
const ask: CoachAskInput = {
  kind: 'ask', itemId: 'punish-test-1', source: 'pack', fen: FEN, side: 'b', question: 'Why not Nf6 first? Or d5?',
  framing: explain.framing, lesson: explain.lesson, answerLineSan: explain.bestLineSan, answerNotes: explain.bestLineNotes, answerWin: 94.8,
  gameFen: GAME_FEN, gameMoveSan: 'Ng5', betterMoveSan: 'Bb5', betterLineSan: ['Bb5', 'a6', 'Ba4', 'Nf6'],
  askedLines: [
    { san: 'Nf6', lineSan: ['Nf6', 'Nxf7'], notes: ['The knight moves to f6.', 'The knight takes the pawn on f7 and attacks the queen on d8 and the rook on h8.'], win: 30.4, source: 'engine' },
    // Section 9.2 (F2): an asked line is always the whole line, the move first (A3 sent the reply alone here).
    { san: 'd5', lineSan: ['d5', 'exd5'], notes: ['The pawn moves to d5.', 'The pawn takes the pawn on d5.'], win: 41, source: 'engine' },
  ],
};
/** The version-6 page's hash (no prompt version). */
const v6Hash = (input: CoachInput) => `h${stableId(canonicalJson(input))}`;
const at = (prompt: string, s: string) => { const i = prompt.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };

test('explain prompt (M3): framing first, then the answer line with notes, the try line with notes, then the numbers', () => {
  const built = buildExplainPrompt(explain);
  const { prompt } = built;
  const lines = prompt.split('\n');
  assert.equal(lines[0], 'You are a chess coach for an adult rated about 1000.');
  assert.ok(lines[1].startsWith('What this card teaches: In your game White played Ng5'), 'the framing opens the data');
  const order = ['What this card teaches', 'Position (FEN): ' + FEN + '. Black to move.', 'Pieces: White: Ke1', 'Card lesson:', 'His move Ng5 led to this position',
    'Answer line (the engine\'s best line): Qxg5 d4 Qg6 dxe5.', '- Qxg5 (Black): The queen takes the knight on g5.',
    'Line after the learner\'s try (engine line, searched in this page): Nf6 Nxf7.', '- Nxf7 (White): The knight takes the pawn on f7',
    'Winning chances for Black as the engine scales them, from the search in this page: 95% after Qxg5, 30% after Nf6, a difference of 65 points.',
    'Using ONLY'].map(s => at(prompt, s));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'framing, position, lesson, game context, answer, try, numbers, instructions');
  for (const s of ['where he played White', 'on this card he plays Black', 'the better move for White was Bb5. Its engine line from there: Bb5 a6 Ba4 Nf6.',
    'at most 120 words', 'addressed as "you"', 'naming the reply Nxf7', 'Then explain the idea of Qxg5', 'Do not give any evaluation, move or line that is not listed above',
    'If the lines do not show the reason, say so.', 'No exclamation marks.']) at(prompt, s);
  assert.ok(!prompt.includes('Stored'), 'no stored figures were given');
  assert.deepEqual([...built.numbers].sort((a, b) => a - b), [30, 65, 95]);
  for (const s of ['Qxg5', 'd4', 'Qg6', 'dxe5', 'Nf6', 'Nxf7', 'Ng5', 'Bb5', 'a6', 'Ba4', 'Ke8', 'Qd8']) assert.ok(built.sans.includes(s), s);
  for (const s of ['f7', 'd8', 'h8', 'g6']) assert.ok(built.squares?.includes(s), s);
});

test('explain prompt (9.2): tryLineSan is the whole line, try first; a line that starts with another move is left out, never re-read', () => {
  // F2 changed this A3 test: A3 read ['Nxf7'] as the reply only and put the try in front. Section 9.2 drops that
  // heuristic (Codex P1): the line does not start with the try, so it is not used, and the refutation is not either.
  const built = buildExplainPrompt({ ...explain, tryLineSan: ['Nxf7'], tryLineNotes: ['The knight takes the pawn on f7.'], refutationSan: ['Bc4'] });
  assert.ok(!built.prompt.includes("Line after the learner's"), 'no try line');
  assert.ok(!built.prompt.includes('naming the reply'), 'no reply is claimed');
  assert.ok(!built.prompt.includes('Nxf7') && !built.sans.includes('Nxf7'), 'a line that was left out is not citable');
  assert.ok(!built.prompt.includes('Bc4') && !built.sans.includes('Bc4'), 'tryLineSan given: refutationSan is never used as well');
  // The whole line: its first note is about the try itself.
  const whole = buildExplainPrompt(explain);
  at(whole.prompt, "Line after the learner's try (engine line, searched in this page): Nf6 Nxf7.");
  at(whole.prompt, '- Nf6 (Black): The knight moves to f6.');
  at(whole.prompt, '- Nxf7 (White): The knight takes the pawn on f7');
  // With neither a try line nor a refutation, nothing claims a reply; the numbers (30 against 95) still show a losing try.
  const bare = buildExplainPrompt({ ...explain, tryLineSan: undefined, tryLineNotes: undefined });
  assert.ok(!bare.prompt.includes('naming the reply'));
  at(bare.prompt, 'First say what goes wrong after Nf6, if these lines show it.');
});

test('explain prompt (9.2, Codex P1): the same-SAN recapture keeps every ply, for refutationSan and for tryLineSan', () => {
  // 1.e4 e6 2.d4 d5, White to move: 3.exd5 exd5 4.Nc3 is legal, and both captures are written "exd5".
  const fen = 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3';
  const base: CoachExplainInput = {
    kind: 'explain', itemId: 'french-textbook', source: 'pack', fen, side: 'w', playedUci: 'e4d5', playedSan: 'exd5',
    bestUci: 'b1c3', bestSan: 'Nc3', bestLineSan: ['Nc3'], refutationSan: [], themes: ['opening'],
  };
  // M2 refutationSan is ALWAYS the reply alone: the try goes in front, so the line has three plies.
  const m2 = buildExplainPrompt({ ...base, refutationSan: ['exd5', 'Nc3'] });
  at(m2.prompt, "Line after the learner's move (stored engine reply line): exd5 exd5 Nc3.");
  at(m2.prompt, 'naming the reply exd5');
  assert.ok(!m2.prompt.includes('naming the reply Nc3'), 'Nc3 is White\'s move, not Black\'s reply');
  // A one-ply same-SAN reply survives.
  const one = buildExplainPrompt({ ...base, refutationSan: ['exd5'] });
  at(one.prompt, '(stored engine reply line): exd5 exd5.');
  at(one.prompt, 'naming the reply exd5');
  // M3 tryLineSan is ALWAYS the whole line: it gains no move, and each note keeps its ply and colour.
  const m3 = buildExplainPrompt({
    ...base, tryLineSan: ['exd5', 'exd5', 'Nc3'], trySource: 'engine', tryVerdict: 'worse',
    tryLineNotes: ['The pawn takes the pawn on d5.', 'The pawn takes back on d5.', 'The knight comes out to c3.'],
  });
  at(m3.prompt, "Line after the learner's try (engine line, searched in this page): exd5 exd5 Nc3.");
  at(m3.prompt, '- exd5 (White): The pawn takes the pawn on d5.');
  at(m3.prompt, '- exd5 (Black): The pawn takes back on d5.');
  at(m3.prompt, '- Nc3 (White): The knight comes out to c3.');
  at(m3.prompt, 'naming the reply exd5');
  assert.ok(!m3.prompt.includes('exd5 exd5 exd5'), 'no extra move');
  // A reply-only array sent in tryLineSan by mistake is read as the whole line; chess.js stops it at Black's "Nc3".
  const wrong = buildExplainPrompt({ ...base, tryLineSan: ['exd5', 'Nc3'], trySource: 'engine', tryVerdict: 'worse' });
  at(wrong.prompt, "Line after the learner's try (engine line, searched in this page): exd5.");
  assert.ok(!wrong.prompt.includes('naming the reply'), 'an illegal ply is never named as the reply');
});

test('explain prompt: the answer label follows the card source, and an also-good try is not given a fault', () => {
  // Back-rank mate two ways: Ra8# is the puzzle's move, Rd8# mates too (L4 "also good"; bank puzzles still ask for Ra8#).
  const two = '6k1/5ppp/8/8/8/8/5PPP/R2R2K1 w - - 0 1';
  const bank = buildExplainPrompt({
    kind: 'explain', itemId: '00test', source: 'bank', fen: two, side: 'w', playedUci: 'd1d8', playedSan: 'Rd8#', bestUci: 'a1a8', bestSan: 'Ra8#',
    bestLineSan: ['Ra8#'], refutationSan: [], themes: ['backRankMate', 'mateIn1'], tryLineSan: ['Rd8#'], trySource: 'engine', tryWin: 100, bestWin: 100,
  });
  at(bank.prompt, 'Answer line (the puzzle\'s solution): Ra8#.');
  // FX4b (brief 9.11.3, R5-4): 100 against 100 is "at least as good" (as 9.9.2 d on the page); this read "about as good".
  at(bank.prompt, 'By these numbers Rd8# is at least as good as Ra8#.');
  at(bank.prompt, 'Do not invent a fault in Rd8#.');
  assert.ok(!bank.prompt.includes("engine's best") && !bank.prompt.includes('naming the reply'));
  // F2 changed this A3 assertion: section 9.1 classifies from the ROUNDED whole numbers, so 64.6 (shown as 65)
  // against 66 is also good; 64 against 66 is close (gap 2): compared, never called a fault.
  at(buildExplainPrompt({ ...explain, tryWin: 64.6, bestWin: 66 }).prompt, 'By these numbers Nf6 is about as good as Qxg5.');
  const close = buildExplainPrompt({ ...explain, tryWin: 64, bestWin: 66 }).prompt;
  at(close, 'By these numbers Nf6 is nearly as good as Qxg5.');
  assert.ok(!close.includes('what goes wrong') && !close.includes('about as good'));
  at(buildExplainPrompt({ ...explain, tryWin: 65, bestWin: 66 }).prompt, 'By these numbers Nf6 is about as good as Qxg5.');
  // Endgame drill: tablebase labels, and results in words. F2 changed this A3 case (Codex F3): it sent a draw as
  // tryWin 50 and expected "50%"; a draw is not a 50% chance to win, so results are categorical and no Win% shows.
  const kp = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
  const drill = buildExplainPrompt({
    kind: 'explain', itemId: 'tech-test', source: 'endgame', fen: kp, side: 'w', playedUci: 'e2e4', playedSan: 'e4', bestUci: 'e1d2', bestSan: 'Kd2',
    bestLineSan: ['Kd2'], refutationSan: [], themes: ['endgame-tech'], tryLineSan: ['e4', 'Kd7'], trySource: 'tablebase', tryResult: 'draw', bestResult: 'win',
  });
  at(drill.prompt, "Answer line (the drill's line, checked with the tablebase): Kd2.");
  at(drill.prompt, "Line after the learner's try (tablebase line): e4 Kd7.");
  at(drill.prompt, 'Tablebase result with best play from both sides: after Kd2, White wins; after e4, the game is a draw.');
  at(drill.prompt, 'First say what goes wrong after e4, naming the reply Kd7.');
  assert.ok(!drill.prompt.includes('%') && !drill.prompt.includes('Winning chances'), 'no percentage for a tablebase result');
  for (const [source, label] of [['agent', "the drill's line"], ['personal', "a short engine scan's candidate line"]] as const) {
    at(buildExplainPrompt({ ...explain, source }).prompt, `Answer line (${label}): Qxg5`);
  }
});

test('explain prompt: the game context is stated only when the game move, played from gameFen, reaches the card position', () => {
  // After 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nd4, White to move. Black's 3...Nd4 led here; 4.Bxf7+ is a move FROM here.
  const before = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
  const fen = 'r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const base: CoachExplainInput = {
    kind: 'explain', itemId: 'punish-test-2', source: 'pack', fen, side: 'w', playedUci: 'b1c3', playedSan: 'Nc3', bestUci: 'f3d4', bestSan: 'Nxd4',
    bestLineSan: ['Nxd4', 'exd4'], refutationSan: [], themes: ['punish'],
  };
  const right = buildExplainPrompt({ ...base, gameFen: before, gameMoveSan: 'Nd4', betterMoveSan: 'Nf6', betterLineSan: ['Nf6', 'Ng5', 'Qxf3'] });
  at(right.prompt, 'where he played Black. His move Nd4 led to this position; on this card he plays White.');
  at(right.prompt, 'the better move for Black was Nf6. Its engine line from there: Nf6 Ng5.');
  assert.ok(right.sans.includes('Nf6') && right.sans.includes('Ng5'));
  assert.ok(!right.prompt.includes('Qxf3') && !right.sans.includes('Qxf3'), 'the better line stops at its first illegal move');
  const dropped = (over: Partial<CoachExplainInput>, why: string) => {
    const built = buildExplainPrompt({ ...base, betterMoveSan: 'Nf6', betterLineSan: ['Nf6'], ...over });
    assert.ok(!built.prompt.includes('own game'), `${why}: no game context`);
    assert.ok(!built.sans.includes('Nf6'), `${why}: nothing from the dropped context is citable`);
  };
  dropped({ gameMoveSan: 'Nd4' }, 'no gameFen');
  dropped({ gameFen: fen, gameMoveSan: 'Bxf7+' }, 'a move from the card position (own-game card misuse)');
  dropped({ gameFen: before, gameMoveSan: 'Nf6' }, 'a legal move that does not reach the card position');
  dropped({ gameFen: before, gameMoveSan: 'Qh5' }, 'an illegal move');
  dropped({ gameFen: 'not a fen', gameMoveSan: 'Nd4' }, 'a bad gameFen');
  // A same-SAN recapture is stated too: after 1.e4 e6 2.d4 d5 3.exd5, Black can also play exd5.
  const french = buildExplainPrompt({
    kind: 'explain', itemId: 'punish-test-3', source: 'pack', fen: 'rnbqkbnr/ppp2ppp/4p3/3P4/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3', side: 'b',
    playedUci: 'd8d5', playedSan: 'Qxd5', bestUci: 'e6d5', bestSan: 'exd5', bestLineSan: ['exd5'], refutationSan: [], themes: ['punish'],
    gameFen: 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3', gameMoveSan: 'exd5',
  });
  at(french.prompt, 'His move exd5 led to this position; on this card he plays Black.');
});

test('explain prompt: long or odd optional fields are cut, never an error', () => {
  const built = buildExplainPrompt({
    ...explain, framing: 'x'.repeat(1000), lesson: 42 as unknown as string,
    bestLineNotes: Array.from({ length: 20 }, (_, i) => `Note ${i} ${'y'.repeat(300)}`), tryWin: 150, bestWin: Number.NaN,
    tryLineNotes: [7 as unknown as string, 'The knight takes the pawn on f7.'],
  });
  assert.ok(built.prompt.includes('x'.repeat(COACH_LIMITS.text)) && !built.prompt.includes('x'.repeat(COACH_LIMITS.text + 1)));
  assert.ok(!built.prompt.includes('Card lesson'), 'a non-string lesson is dropped');
  assert.ok(!built.prompt.includes('y'.repeat(COACH_LIMITS.note)), 'notes are cut at 200 characters');
  assert.ok(!built.prompt.includes('Note 4 '), 'only the notes of plies in the line are shown');
  at(built.prompt, 'Winning chances for Black as the engine scales them, from the search in this page: 100% after Nf6.');
  at(built.prompt, '- Nxf7 (White): The knight takes the pawn on f7.');
  assert.ok(!built.prompt.includes('- Nf6 (Black)'), 'a non-string note is skipped');
});

test('grounding (M3): every move in every line given and every Win% rendered pass; inventions are still flagged', () => {
  const built = buildExplainPrompt(explain);
  const honest = 'After Nf6, White plays Nxf7. The knight on f7 attacks your Qd8 and the rook on h8. Your winning chances drop to 30%, against 95% after Qxg5, a difference of 65 points. '
    + 'Qxg5 takes the knight White left on g5; after d4 Qg6 dxe5 you are a piece up. In the game, Bb5 was better for White, as in Bb5 a6 Ba4 Nf6.';
  assert.deepEqual(groundCheck(honest, built, 'explain'), { grounded: true, misses: [] });
  assert.deepEqual(groundCheck('After Nf6, White has Qh4 and then h5 wins; you keep 40%.', built, 'explain').misses.sort(), ['40%', 'Qh4', 'h5']);
  // The ask kind follows the same rules, over its own lines (answer, game context, checked moves).
  const askBuilt = buildAskPrompt(ask);
  assert.equal(groundCheck('After d5, White takes with exd5 and your chances are 41%, 54 points below Qxg5 at 95%. Nf6 allows Nxf7.', askBuilt, 'ask').grounded, true);
  // The learner's own words are never a source: a move he named that the page did not check is flagged.
  const unchecked = buildAskPrompt({ ...ask, question: 'Is Qh4 better?', askedLines: [] });
  at(unchecked.prompt, 'The page found no move in the question that it could check.');
  assert.deepEqual(groundCheck('This page did not check Qh4, so I cannot judge it.', unchecked, 'ask').misses, ['Qh4']);
});

test('grounding: a square digit is not a figure ("the d3 pawn", "the bishop on b2 points at g7")', () => {
  // White: Kg1, Bb2, pawn d3; Black: Kg8, pawn g7. The M2 check read "d3 pawn" as "3 pawn" (one cached M2 answer was flagged for it).
  const fen = '6k1/6p1/8/8/8/3P4/1B6/6K1 w - - 0 1';
  const built = { sans: [] as string[], numbers: [12], fen };
  assert.deepEqual(groundCheck('The d3 pawn is weak, and the bishop on b2 points at g7.', built, 'explain'), { grounded: true, misses: [] });
  assert.deepEqual(groundCheck('That costs 3 pawns and 2 points.', built, 'explain').misses.sort(), ['2 points', '3 pawns']);
  assert.deepEqual(groundCheck('You keep 12%.', built, 'ask').misses, []);
});

test('inputsHash covers every M3 field and the prompt version', () => {
  const base = inputsHash(explain);
  const changes: Array<Partial<CoachExplainInput>> = [
    { framing: 'Other.' }, { boardText: 'Other.' }, { lesson: 'Other.' }, { bestLineNotes: ['Other.'] }, { tryLineSan: ['Nf6'] }, { tryLineNotes: ['Other.'] },
    { trySource: 'stored' }, { tryWin: 31 }, { bestWin: 90 }, { gameFen: FEN }, { gameMoveSan: 'Bb5' }, { betterMoveSan: 'Nf3' }, { betterLineSan: ['Bb5'] },
    // Section 9.2 fields (F2).
    { title: 'Other.' }, { objective: 'win material' }, { answerSource: 'game-engine' }, { step: 0 }, { spoilersAllowed: true }, { spoilersAllowed: false },
    { tryVerdict: 'losing' }, { tryResult: 'draw' }, { bestResult: 'win' },
    // Fix round 2 (brief 9.11.2 p, FX4a).
    { tryCheckNote: 'Other.' },
  ];
  for (const c of changes) assert.notEqual(inputsHash({ ...explain, ...c }), base, JSON.stringify(c));
  const askBase = inputsHash(ask);
  for (const c of [{ question: 'Why not d5?' }, { answerWin: 90 }, { askedLines: ask.askedLines.slice(0, 1) }, { answerNotes: [] },
    { title: 'Other.' }, { objective: 'win material' }, { answerSource: 'game-engine' }, { answerResult: 'win' },
    { askedLines: [{ ...ask.askedLines[0], result: 'draw' }, ask.askedLines[1]] },
    // Fix round 2, stage 2 (brief 9.11.3, FX4b): the ask input's themes and an asked line's `finished` and `checkNote`.
    { themes: ['mateIn2'] }, { askedLines: [{ ...ask.askedLines[0], finished: false }, ask.askedLines[1]] },
    { askedLines: [{ ...ask.askedLines[0], checkNote: 'Other.' }, ask.askedLines[1]] }] as Array<Partial<CoachAskInput>>) {
    assert.notEqual(inputsHash({ ...ask, ...c }), askBase, JSON.stringify(c));
  }
  // Stable for identical inputs (F2, item 7): key order and absent optional fields do not change it.
  const reordered = Object.fromEntries(Object.entries(explain).reverse()) as unknown as CoachExplainInput;
  assert.equal(inputsHash(reordered), base);
  assert.equal(inputsHash({ ...explain, title: undefined, step: undefined, tryVerdict: undefined }), base);
  assert.equal(inputsHash(structuredClone(ask)), askBase);
  assert.equal(COACH_PROMPT_VERSION, 'm3-1');
  // An M2-shaped input never hashes as the version-6 page hashed it.
  const m2: CoachExplainInput = { kind: 'explain', itemId: 'punish-test-1', source: 'pack', fen: FEN, side: 'b', playedUci: 'g8f6', playedSan: 'Nf6', bestUci: 'd8g5', bestSan: 'Qxg5', bestLineSan: ['Qxg5'], refutationSan: [], themes: ['punish', 'opening'] };
  assert.notEqual(inputsHash(m2), v6Hash(m2));
  assert.match(inputsHash(m2), /^h[0-9a-f]{16}$/);
});

function harness(sampleImpl?: SampleFn, seed?: Record<string, Record<string, unknown>>) {
  let clock = new Date(2026, 10, 12, 9, 0, 0).getTime();
  const prompts: string[] = [];
  const sample: SampleFn = sampleImpl ?? (async () => ({ text: 'After Nf6, Nxf7 attacks the queen on d8 and the rook on h8. Qxg5 wins the knight on g5.', truncated: false }));
  const store = createFakeStore(seed ? { seed } : {});
  const coach = createCoach({ sample: async (i, o) => { prompts.push(String(i)); return sample(i, o); }, permissions: null, store, deviceId: 'd1', storage: memoryKv(), now: () => clock });
  return { coach, store, prompts, tick: (ms: number) => { clock += ms; } };
}
const settle = () => new Promise(r => setTimeout(r, 5)); // cache writes are not awaited by ask

test('coach: a version-6 cached answer for the same input is not served', async () => {
  // The three M2 non-answers were cached for M2-shaped punish inputs; this is the same situation with a textbook card.
  const m2: CoachExplainInput = { kind: 'explain', itemId: 'punish-test-1', source: 'pack', fen: FEN, side: 'b', playedUci: 'g8f6', playedSan: 'Nf6', bestUci: 'd8g5', bestSan: 'Qxg5', bestLineSan: ['Qxg5'], refutationSan: [], themes: ['punish', 'opening'] };
  const path = 'explanations/punish-test-1__g8f6';
  const h = harness(undefined, { [path]: { text: 'The lines given do not show why Nf6 fails.', at: 1, grounded: true, inputsHash: v6Hash(m2), itemId: m2.itemId, playedUci: 'g8f6' } });
  const r = await h.coach.ask(m2);
  assert.equal(r.cached, false);
  assert.equal(h.prompts.length, 1, 'a fresh model call');
  await settle();
  assert.equal(h.store.dump()[path].inputsHash, inputsHash(m2), 'the stale document is replaced');
  // An M3 explain answer is cached at the same explain path and grounded over the M3 lines.
  const h2 = harness();
  const m3 = await h2.coach.ask(explain);
  assert.equal(m3.grounded, true);
  await settle();
  assert.equal(h2.store.dump()[path].inputsHash, inputsHash(explain));
});

test('coach: ask answers are cached at explanations/<id>__ask-<hash> without playedUci, and reused', async () => {
  const h = harness(async () => ({ text: 'Nf6 allows Nxf7, which hits the queen on d8 and the rook on h8. After d5 exd5 your chances are 41%.', truncated: false }));
  const first = await h.coach.ask(ask);
  assert.equal(first.grounded, true);
  assert.equal(first.cached, false);
  assert.match(h.prompts[0], /The learner's question: “Why not Nf6 first\? Or d5\?”/);
  await settle();
  const path = `explanations/punish-test-1__ask-${first.inputsHash}`;
  assert.equal(cachePath(ask, first.inputsHash), path);
  const doc = h.store.dump()[path];
  assert.ok(doc, 'the ask answer is cached');
  assert.equal(doc.playedUci, undefined);
  assert.equal(doc.itemId, 'punish-test-1');
  assert.ok(readDoc(path, doc), 'the document passes the explanations schema');
  h.tick(COOLDOWN_MS + 1);
  const again = await h.coach.ask(ask);
  assert.equal(again.cached, true);
  assert.equal(h.prompts.length, 1, 'reused without a call');
  h.tick(COOLDOWN_MS + 1);
  const other = await h.coach.ask({ ...ask, question: 'What does d4 do?' });
  assert.equal(other.cached, false);
  assert.equal(h.prompts.length, 2);
  await settle();
  assert.equal(Object.keys(h.store.dump()).filter(p => p.startsWith('explanations/punish-test-1__ask-')).length, 2);
  // Summaries are still never cached.
  assert.equal(cachePath({ kind: 'summary', session: [], weakest: [], focus: [] }, 'h0'), null);
});

test('coach: ask inputs are validated before anything is sent', async () => {
  const h = harness();
  const invalid = (e: CoachError) => e.failure.code === 'invalid_request' && e.failure.action === 'tell';
  await assert.rejects(h.coach.ask({ ...ask, question: '   ' }), invalid);
  await assert.rejects(h.coach.ask({ ...ask, askedLines: [{ san: 'Nf6', lineSan: ['Nf6'], source: 'guess' as 'engine' }] }), invalid);
  await assert.rejects(h.coach.ask({ ...ask, answerLineSan: undefined as unknown as string[] }), invalid);
  await assert.rejects(h.coach.ask({ ...ask, kind: 'nope' } as unknown as CoachInput), invalid);
  assert.equal(h.prompts.length, 0);
});

test('ask prompt: answer line, then each checked move with its line, notes and Win%, then the quoted question', () => {
  const built = buildAskPrompt(ask);
  const order = ['What this card teaches', 'His move Ng5 led to this position', 'Answer line (the engine\'s best line): Qxg5 d4 Qg6 dxe5.',
    'Winning chances for Black as the engine scales them, after Qxg5: 95%.', 'Moves from the question that the page checked:',
    'Checked move Nf6. Its line (engine line, searched in this page): Nf6 Nxf7.', '30% after Nf6, 95% after Qxg5, a difference of 65 points.',
    'Checked move d5. Its line (engine line, searched in this page): d5 exd5.', '- exd5 (White): The pawn takes the pawn on d5.',
    '41% after d5, 95% after Qxg5, a difference of 54 points.', 'The learner\'s question: “Why not Nf6 first? Or d5?”', 'Using ONLY'].map(s => at(built.prompt, s));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // FX4b (brief 9.11.3, R5-3): the sentence is asked for without the move written out (it read "…that move, and do not judge it.").
  at(built.prompt, 'say that this page did not check that move, without writing the move, and do not judge it.');
  at(built.prompt, 'at most 120 words');
  assert.deepEqual([...new Set(built.numbers)].sort((a, b) => a - b), [30, 41, 54, 65, 95]);
  assert.equal(built.modelTier, 'default');
  assert.ok(!buildAskPrompt({ ...ask, question: 'Line one\nLine two' }).prompt.includes('Line one\nLine two'), 'the question stays on one line');
});

// ---------------------------------------------------------------- CoachPanel question box

const result = (over: Partial<CoachResult> = {}): CoachResult => ({ text: 'Nf6 allows Nxf7.', grounded: true, misses: [], cached: false, truncated: false, at: 1, inputsHash: 'h1', ...over });
function fakeCoach(over: Partial<CoachClient> = {}) {
  const sent: CoachInput[] = [];
  const coach: CoachClient = {
    availability: async () => 'granted',
    limits: () => ({ remainingToday: 20, cooldownUntil: 0 }),
    ask: async input => { sent.push(input); return result(); },
    ...over,
  };
  return { coach, sent };
}
const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(CoachPanel, props as Parameters<typeof CoachPanel>[0]));

test('panel: the question box shows only when the parent passes askInput, never while the answer is hidden, with the same consent rule', () => {
  const { coach } = fakeCoach();
  const build = () => ask;
  const html = render({ coach, askInput: build, initialAvailability: 'granted' });
  assert.match(html, /<textarea[^>]*maxLength="300"|<textarea[^>]*maxlength="300"/);
  assert.match(html, /Ask Claude about this position/);
  assert.match(html, />Ask Claude<\/button>/);
  assert.ok(html.includes(ASK_DEFAULT_HINT));
  assert.doesNotMatch(html, /Why does my move fail\?/, 'no wrong move, no explain button');
  assert.doesNotMatch(render({ coach, initialAvailability: 'granted' }), /<textarea/, 'no builder, no box');
  assert.doesNotMatch(render({ coach, askInput: build, initialAvailability: 'granted', revealsAnswer: true }), /<textarea/, 'never before the card is finished');
  assert.doesNotMatch(render({ coach: null, askInput: build, initialAvailability: 'granted' }), /<textarea/);
  for (const state of ['denied', 'unavailable', 'unknown'] as const) assert.doesNotMatch(render({ coach, askInput: build, initialAvailability: state }), /<textarea/, state);
  assert.match(render({ coach, askInput: build, initialAvailability: 'prompt' }), /Ask Claude \(asks permission once\)/);
  assert.equal(askLabel(coach, 'granted'), 'Ask Claude');
  assert.equal(askLabel(null, 'granted'), null);
  // With a wrong move too, both controls show; the parent's hint replaces the default.
  const input: CoachExplainInput = { ...explain };
  const both = render({ coach, input, askInput: build, askHint: 'Moves you name are checked with the tablebase.', initialAvailability: 'granted' });
  assert.match(both, /Why does my move fail\?/);
  assert.match(both, /Moves you name are checked with the tablebase\./);
  assert.match(both, /You played Nf6\./);
});

test('panel: runAsk checks the limits before building, stops on Stop, and maps failures', async () => {
  const noBuild = () => { throw new Error('must not build'); };
  const started: string[] = [];
  const signal = new AbortController().signal;
  // Refusals happen before anything runs.
  assert.deepEqual(await runAsk({ coach: fakeCoach().coach, question: '  ', build: noBuild, signal }), { status: 'refused', message: 'Write a question first.' });
  assert.equal((await runAsk({ coach: fakeCoach().coach, question: 'x'.repeat(301), build: noBuild, signal })).status, 'refused');
  const capped = await runAsk({ coach: fakeCoach({ limits: () => ({ remainingToday: 0, cooldownUntil: 0 }) }).coach, question: 'Why?', build: noBuild, signal, onStart: q => started.push(q) });
  assert.equal(capped.status, 'refused');
  assert.match((capped as { message: string }).message, /used up/);
  const cooling = await runAsk({ coach: fakeCoach({ limits: () => ({ remainingToday: 5, cooldownUntil: 15_000 }) }).coach, question: 'Why?', build: noBuild, signal, now: 10_000 });
  assert.deepEqual(cooling, { status: 'refused', message: 'Ask again in 5 s.' });
  assert.equal(started.length, 0, 'onStart only once the question will be sent');
  // A builder that gives nothing: nothing is sent.
  const nothing = fakeCoach();
  const none = await runAsk({ coach: nothing.coach, question: 'Why?', build: () => null, signal, onStart: q => started.push(q) });
  assert.equal(none.status, 'failed');
  assert.equal(nothing.sent.length, 0);
  assert.deepEqual(started, ['Why?']);
  // Stop while the page is checking moves: the builder is aborted and nothing is sent.
  const stopping = fakeCoach();
  const controller = new AbortController();
  const pending = runAsk({ coach: stopping.coach, question: 'Why not d5?', signal: controller.signal,
    build: (_q, s) => new Promise((_, reject) => s.addEventListener('abort', () => reject(new DOMException('Analysis stopped.', 'AbortError')))) });
  controller.abort();
  assert.deepEqual(await pending, { status: 'stopped' });
  assert.equal(stopping.sent.length, 0);
  // Success: phases in order, streamed text forwarded, the built input returned for the "checked" list.
  const phases: string[] = [], texts: string[] = [];
  const ok = fakeCoach({ ask: async (_i, o) => { o?.onText?.('Nf6'); return result(); } });
  const answered = await runAsk({ coach: ok.coach, question: ' Why not Nf6? ', build: async q => ({ ...ask, question: q }), signal, onPhase: p => phases.push(p), onText: t => texts.push(t) });
  assert.equal(answered.status, 'answered');
  assert.equal((answered as { input: CoachAskInput }).input.question, 'Why not Nf6?', 'the question is trimmed');
  assert.deepEqual(phases, ['checking', 'asking']);
  assert.deepEqual(texts, ['Nf6']);
  // Coach failures: hide, tell with a partial answer, cancelled.
  const fail = (failure: ConstructorParameters<typeof CoachError>[0]) => runAsk({ coach: fakeCoach({ ask: async () => { throw new CoachError(failure); } }).coach, question: 'Why?', build: () => ask, signal });
  assert.deepEqual(await fail({ code: 'not_granted', action: 'hide', message: 'Claude is not available for this page.' }), { status: 'failed', hide: true, message: 'Claude is not available for this page.' });
  assert.deepEqual(await fail({ code: 'upstream_error', action: 'tell', message: 'Claude could not be reached.', partial: 'Nf6 al' }), { status: 'failed', hide: false, message: 'Claude could not be reached.', partial: 'Nf6 al' });
  assert.deepEqual(await fail({ code: 'cancelled', action: 'cancelled', message: 'Stopped.' }), { status: 'stopped' });
  const thrown = await runAsk({ coach: fakeCoach().coach, question: 'Why?', build: () => { throw new Error('engine failed'); }, signal });
  assert.equal(thrown.status, 'failed');
  assert.ok(ASK_PARTIAL.length > 0);
});

test('panel: checkedLines lists each checked move with its line, source and Win% (or tablebase result in words)', () => {
  assert.deepEqual(checkedLines(ask), [
    'Nf6 Nxf7 (engine line; winning chances for Black 30%)',
    'd5 exd5 (engine line; winning chances for Black 41%)',
  ]);
  // F2 changed this A3 case: it listed Kd2 at the 3.Ng5 position, where Kd2 is not legal; the panel now shows only
  // what the prompt gave Claude (legal moves, whole lines) and a tablebase result in words, never a percentage.
  const kp = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
  assert.deepEqual(checkedLines({
    ...ask, fen: kp, side: 'w', answerLineSan: ['Kd2'], askedLines: [
      { san: 'Kd2', lineSan: [], source: 'tablebase', result: 'win' },
      { san: 'e4', lineSan: ['e4', 'Kd7'], source: 'tablebase', result: 'draw', win: 50 },
      { san: 'Kf2', lineSan: [], source: 'tablebase' },
    ],
  }), ['Kd2 (tablebase line; White wins with best play)', 'e4 Kd7 (tablebase line; the game is a draw with best play)', 'Kf2 (tablebase line)']);
  assert.deepEqual(checkedLines({ ...ask, askedLines: [{ san: 'Kd2', lineSan: [], source: 'engine', win: 40 }] }), [], 'a move not legal at the card position is not listed');
});

// ---------------------------------------------------------------- fix pass F2 (brief section 9.2 and section 8 items 4, 5, 11-14)

/** The textbook French position after 1.e4 e6 2.d4 d5 (White to move), as in Codex's follow-up probe. */
const FRENCH = 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3';
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** A legal 40-ply Ruy Lopez (Breyer) line from the start position; its first 13 plies are the probe's line. */
const RUY_40 = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O', 'h3', 'Nb8', 'd4', 'Nbd7',
  'Nbd2', 'Bb7', 'Bc2', 'Re8', 'Nf1', 'Bf8', 'Ng3', 'g6', 'a4', 'c5', 'd5', 'c4', 'Bg5', 'h6', 'Be3', 'Nc5', 'Qd2', 'h5', 'Bg5', 'Be7'];
/** Textbook king and pawn ending (White: Ke1, e2; Black: Ke8): Kd2 or Kf2 wins, e4 only draws. */
const KP = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
/** Textbook defence (public drill tech-kpk-defender-keeps-opposition): Kd7 holds the draw; Ke8 loses to Ke6. */
const OPPOSITION = '8/4k3/8/3K4/4P3/8/8/8 b - - 0 1';

test("Codex follow-up probe, reversed: all four findings are fixed", () => {
  const input: CoachExplainInput = {
    kind: 'explain', itemId: 'french-textbook', source: 'pack', fen: FRENCH, side: 'w', playedUci: 'e4d5', playedSan: 'exd5', bestUci: 'b1c3', bestSan: 'Nc3',
    bestLineSan: ['Nc3'], refutationSan: ['exd5', 'Nc3'], themes: ['opening'],
  };
  // F1 / P1: the same-SAN recapture keeps its ply, and Nc3 is never called Black's reply.
  const collision = buildExplainPrompt(input).prompt;
  at(collision, 'stored engine reply line): exd5 exd5 Nc3.');
  assert.ok(!collision.includes('naming the reply Nc3'));
  // F2: 70% against 95% is a strong try, compared and never given a fault.
  const soft = buildExplainPrompt({ ...input, tryLineSan: ['exd5', 'exd5', 'Nc3'], trySource: 'engine', tryWin: 70, bestWin: 95 }).prompt;
  at(soft, '95% after Nc3, 70% after exd5');
  assert.ok(!soft.includes('what goes wrong'));
  at(soft, 'By these numbers exd5 keeps a good game, but Nc3 is stronger.');
  // C4 / 8.12: the legal 13-ply line is shown whole, Bb3 included, with no notice needed.
  assert.equal(COACH_LIMITS.line, 32);
  const long = buildExplainPrompt({ ...input, source: 'agent', fen: START, playedUci: 'd2d4', playedSan: 'd4', bestUci: 'e2e4', bestSan: 'e4', bestLineSan: RUY_40.slice(0, 13), refutationSan: [] });
  assert.ok(long.sans.includes('Bb3'));
  at(long.prompt, `: ${RUY_40.slice(0, 13).join(' ')}.`);
  assert.ok(!/shorten|truncat/i.test(long.prompt));
  // F3: a tablebase line never turns a Win% into "winning chances".
  const tablebase = buildExplainPrompt({ ...input, source: 'endgame', trySource: 'tablebase', tryWin: 50 }).prompt;
  assert.ok(!tablebase.includes('50%') && !tablebase.includes('Winning chances'));
});

test('explain prompt (9.2): the instruction follows tryVerdict; also-good, close and strong compare the lines and never call the try a fault', () => {
  const v = (over: Partial<CoachExplainInput>) => buildExplainPrompt({ ...explain, ...over }).prompt;
  // Codex F2 (section 8.10): a searched try at 70% against 95% is strong, with or without the page's class.
  for (const p of [v({ tryWin: 70, bestWin: 95 }), v({ tryWin: 70, bestWin: 95, tryVerdict: 'strong' })]) {
    at(p, 'By these numbers Nf6 keeps a good game, but Qxg5 is stronger. Compare the two lines: say what Qxg5 gains over Nf6.');
    at(p, 'Nf6 is still a good move: do not say that it fails or loses.');
    assert.ok(!p.includes('what goes wrong') && !p.includes('naming the reply'));
  }
  // 100 against 100: also good (A3's branch, kept). FX4b (brief 9.11.3, R5-4): a try rated at least as high as the answer
  // is "at least as good" (this read "about as good"); just below the answer it stays "about as good".
  at(v({ tryWin: 100, bestWin: 100 }), 'By these numbers Nf6 is at least as good as Qxg5. Say so, then explain the idea of Qxg5 and its line. Do not invent a fault in Nf6.');
  at(v({ tryWin: 99, bestWin: 100 }), 'By these numbers Nf6 is about as good as Qxg5. Say so, then explain the idea of Qxg5 and its line. Do not invent a fault in Nf6.');
  // Close: compared, no fault.
  const close = v({ tryWin: 50, bestWin: 54, tryVerdict: 'close' });
  at(close, 'By these numbers Nf6 is nearly as good as Qxg5. Compare the two lines: say what Qxg5 does that Nf6 does not. Do not say that Nf6 fails or loses.');
  assert.ok(!close.includes('what goes wrong'));
  // Worse and losing may say what goes wrong, from the given line, with or without a reply.
  at(v({ tryWin: 40, bestWin: 95, tryVerdict: 'worse' }), 'First say what goes wrong after Nf6, naming the reply Nxf7. Then explain the idea of Qxg5 and its line.');
  at(v({ tryVerdict: 'losing' }), 'First say what goes wrong after Nf6, naming the reply Nxf7.');
  at(v({ tryVerdict: 'losing', tryLineSan: undefined, tryLineNotes: undefined }), 'First say what goes wrong after Nf6, if these lines show it.');
  // Without numbers the comparison rests on the page's check, never on "these numbers".
  const none = { tryWin: undefined, bestWin: undefined };
  at(v({ ...none, tryVerdict: 'also-good' }), "By the page's check Nf6 is about as good as Qxg5.");
  at(v({ ...none, tryVerdict: 'strong' }), "By the page's check Nf6 keeps a good game, but Qxg5 is stronger.");
  // Numbers that do not support the page's class are not cited as its basis.
  at(v({ tryVerdict: 'also-good' }), "By the page's check Nf6 is about as good as Qxg5.");
  // The derived classes use the section 9.1 boundaries on whole numbers.
  assert.deepEqual([[65, 70], [64, 70], [64, 69], [65, 71], [70, 76], [35, 41], [34, 41], [64.6, 70], [100, 100], [50, 40]].map(([t, b]) => verdictFromWin(Math.round(t), b)),
    ['also-good', 'worse', 'close', 'strong', 'strong', 'worse', 'losing', 'also-good', 'also-good', 'close']);
});

test('explain prompt (9.2, 8.4): unchecked asks how the moves differ, without a failure claim, and drops the live numbers', () => {
  // The page's `unchecked` (the search stopped short) with a reply line and numbers: neutral, numbers dropped.
  const p = buildExplainPrompt({ ...explain, tryVerdict: 'unchecked' });
  at(p.prompt, 'Say how Nf6 and Qxg5 differ, using only these lines. Do not claim that Nf6 fails or loses.');
  at(p.prompt, "Line after the learner's try (engine line from a search in this page that did not finish): Nf6 Nxf7.");
  assert.ok(!p.prompt.includes('what goes wrong') && !p.prompt.includes('naming the reply'));
  assert.ok(!p.prompt.includes('%') && !p.numbers.includes(30) && !p.numbers.includes(95), 'no numbers from an unfinished search');
  // Unchecked with a stored reply line and no numbers.
  const stored = buildExplainPrompt({ ...explain, tryVerdict: 'unchecked', trySource: 'stored', tryWin: undefined, bestWin: undefined });
  at(stored.prompt, "Line after the learner's try (line stored with the card): Nf6 Nxf7.");
  at(stored.prompt, 'Say how Nf6 and Qxg5 differ, using only these lines.');
  // An unknown class is read as unchecked: never the fault wording.
  at(buildExplainPrompt({ ...explain, tryVerdict: 'great' as CoachExplainInput['tryVerdict'] }).prompt, 'Say how Nf6 and Qxg5 differ');
  // With no class from the page and no answer figure (bestWin missing), the prompt is neutral, keeps the try's
  // figure, and does not call a finished search unfinished.
  const derived = buildExplainPrompt({ ...explain, bestWin: undefined }).prompt;
  at(derived, 'Say how Nf6 and Qxg5 differ');
  at(derived, "Line after the learner's try (engine line, searched in this page): Nf6 Nxf7.");
  at(derived, 'from the search in this page: 30% after Nf6.');
  // No analysis at all (Codex C3): a practice line set by Claude expects 1.e4; the learner tried 1.d4.
  const agent = buildExplainPrompt({
    kind: 'explain', itemId: 'agent-test', source: 'agent', fen: START, side: 'w', playedUci: 'd2d4', playedSan: 'd4', bestUci: 'e2e4', bestSan: 'e4',
    bestLineSan: ['e4', 'e5', 'Nf3'], refutationSan: [], themes: ['opening'], title: 'Central control', answerSource: 'drill',
  });
  at(agent.prompt, 'Answer line (a practice line set by Claude): e4 e5 Nf3.');
  at(agent.prompt, 'Say how d4 and e4 differ, using only these lines. Do not claim that d4 fails or loses.');
  assert.ok(!agent.prompt.split('Using ONLY')[0].toLowerCase().includes('engine'), 'nothing says an engine chose e4');
  // M2 (no class, no numbers): the stored engine reply to his own game move still gets the fault wording (b3 input shape).
  at(buildExplainPrompt({ ...explain, tryLineSan: undefined, tryLineNotes: undefined, tryWin: undefined, bestWin: undefined, refutationSan: ['Nxf7'] }).prompt,
    'First say what goes wrong after Nf6, naming the reply Nxf7.');
});

test('tablebase results (9.2, Codex F3): words, never a percentage, even when a Win% comes along; grounding accepts the words', () => {
  const drill: CoachExplainInput = {
    kind: 'explain', itemId: 'tech-test', source: 'endgame', fen: KP, side: 'w', playedUci: 'e2e4', playedSan: 'e4', bestUci: 'e1d2', bestSan: 'Kd2',
    bestLineSan: ['Kd2'], refutationSan: [], themes: ['endgame-tech'], answerSource: 'tablebase', tryResult: 'draw', bestResult: 'win',
  };
  // A result with no stored line is still stated, and no line is invented; a Win% that came along is never shown.
  const bare = buildExplainPrompt({ ...drill, tryWin: 50, bestWin: 100 });
  at(bare.prompt, "Answer line (the drill's line, checked with the endgame tablebase): Kd2.");
  at(bare.prompt, 'Tablebase result with best play from both sides: after Kd2, White wins; after e4, the game is a draw.');
  at(bare.prompt, 'First say what goes wrong after e4, if these lines show it.');
  assert.ok(!bare.prompt.includes("Line after the learner's"));
  assert.ok(!bare.prompt.includes('%') && bare.numbers.length === 0);
  assert.deepEqual(groundCheck('After e4 the game is a draw with best play. After Kd2 White wins.', bare, 'explain'), { grounded: true, misses: [] });
  assert.deepEqual(groundCheck('After e4 you keep only 50%.', bare, 'explain').misses, ['50%']);
  // A drill never shows a percentage, even with no result field and no tablebase line source (drills never use the
  // engine, section 9.1): a live Win%, stored figures, the ask answer's Win% and an asked "engine" line on a drill.
  const noResult: CoachExplainInput = { ...drill, answerSource: undefined, tryResult: undefined, bestResult: undefined };
  for (const over of [{ tryWin: 50 }, { tryWin: 50, bestWin: 100, trySource: 'engine' as const }, { winBefore: 90, winAfter: 50 }]) {
    const p = buildExplainPrompt({ ...noResult, ...over });
    assert.ok(!p.prompt.includes('%') && p.numbers.length === 0, JSON.stringify(over));
  }
  const drillAsk: CoachAskInput = { kind: 'ask', itemId: 'tech-test', source: 'endgame', fen: KP, side: 'w', question: 'Why not Kf2?', answerLineSan: ['Kd2'],
    answerWin: 50, askedLines: [{ san: 'Kf2', lineSan: [], source: 'engine', win: 40 }] };
  assert.ok(!buildAskPrompt(drillAsk).prompt.includes('%') && buildAskPrompt(drillAsk).numbers.length === 0);
  assert.deepEqual(checkedLines(drillAsk), ['Kf2 (engine line)']);
  // The same result as the answer: also good, in words (Kf2 wins like Kd2).
  at(buildExplainPrompt({ ...drill, playedUci: 'e1f2', playedSan: 'Kf2', tryResult: 'win' }).prompt,
    'By the tablebase, Kf2 also wins, like Kd2. Say so, then explain the idea of Kd2 and its line. Do not invent a fault in Kf2.');
  // A slower mate (gradeTry: tryVerdict 'strong', both results 'win'): it keeps the goal and is never a fault.
  // King and rook against king (textbook): Rh8# mates at once; Rh7 still wins, more slowly.
  const krk = buildExplainPrompt({
    kind: 'explain', itemId: 'tech-test-3', source: 'endgame', fen: '1k6/8/1K6/8/8/8/8/7R w - - 0 1', side: 'w', playedUci: 'h1h7', playedSan: 'Rh7',
    bestUci: 'h1h8', bestSan: 'Rh8#', bestLineSan: ['Rh8#'], refutationSan: [], themes: ['endgame-tech'], objective: 'mate in one',
    tryVerdict: 'strong', tryResult: 'win', bestResult: 'win',
  }).prompt;
  at(krk, 'By the tablebase, Rh7 also wins, like Rh8#, but this card asks for Rh8#.');
  at(krk, 'Rh7 is still a good move: do not say that it fails or loses.');
  assert.ok(!krk.includes('what goes wrong') && !krk.includes('%'));
  // A draw drill (Codex C3 "planb" case): the goal says draw, and a losing try is named with the tablebase line's reply.
  const hold = buildExplainPrompt({
    kind: 'explain', itemId: 'tech-test-2', source: 'endgame', fen: OPPOSITION, side: 'b', playedUci: 'e7e8', playedSan: 'Ke8', bestUci: 'e7d7', bestSan: 'Kd7',
    bestLineSan: ['Kd7'], refutationSan: [], themes: ['endgame-tech', 'planb'], objective: 'hold the draw', answerSource: 'tablebase',
    tryLineSan: ['Ke8', 'Ke6', 'Kd8', 'Kd6', 'Kc8', 'e5', 'Kd8', 'e6', 'Ke8', 'e7', 'Kf7'], trySource: 'tablebase', tryResult: 'loss', bestResult: 'draw',
  });
  at(hold.prompt, 'Goal of this card: hold the draw.');
  at(hold.prompt, "Line after the learner's try (tablebase line): Ke8 Ke6 Kd8 Kd6 Kc8 e5 Kd8 e6 Ke8 e7 Kf7.");
  at(hold.prompt, 'after Kd7, the game is a draw; after Ke8, Black loses.');
  at(hold.prompt, 'First say what goes wrong after Ke8, naming the reply Ke6.');
  assert.ok(!hold.prompt.includes('%'));
});

test('lines (8.12): up to 32 plies are shown; a longer line says "line shortened to N of M plies"; notes stop after 12 plies', () => {
  const notes = RUY_40.map((_, i) => `Ply ${i + 1} note.`);
  const built = buildExplainPrompt({
    kind: 'explain', itemId: 'agent-long', source: 'agent', fen: START, side: 'w', playedUci: 'd2d4', playedSan: 'd4', bestUci: 'e2e4', bestSan: 'e4',
    bestLineSan: RUY_40, bestLineNotes: notes, refutationSan: [], themes: ['opening'],
  });
  at(built.prompt, `Answer line (the drill's line): ${RUY_40.slice(0, 32).join(' ')}.`);
  at(built.prompt, 'Note: line shortened to 32 of 40 plies; the moves after that are not shown.');
  assert.ok(!built.sans.includes('Qd2') && !built.prompt.includes('Qd2'), 'ply 37 is not shown');
  assert.ok(!built.numbers.includes(40), 'N and M are not figures an answer may cite');
  at(built.prompt, '- b5 (Black): Ply 12 note.');
  assert.ok(!built.prompt.includes('Ply 13 note.'), 'only the first 12 plies carry notes');
  // The try counts as a ply: a try plus 32 more plies is "32 of 33".
  const tryLong = buildExplainPrompt({
    kind: 'explain', itemId: 'agent-long', source: 'agent', fen: START, side: 'w', playedUci: 'e2e4', playedSan: 'e4', bestUci: 'd2d4', bestSan: 'd4',
    bestLineSan: ['d4'], refutationSan: [], themes: ['opening'], tryLineSan: RUY_40.slice(0, 33), trySource: 'engine', tryVerdict: 'close',
  });
  at(tryLong.prompt, 'line shortened to 32 of 33 plies');
  // The ask prompt and the question box follow the same rule.
  const askLong: CoachAskInput = { kind: 'ask', itemId: 'agent-long', source: 'agent', fen: START, side: 'w', question: 'Why e4?', answerLineSan: RUY_40,
    askedLines: [{ san: 'e4', lineSan: RUY_40, source: 'stored' }] };
  assert.equal(buildAskPrompt(askLong).prompt.split('line shortened to 32 of 40 plies').length, 3, 'answer line and checked line');
  assert.deepEqual(checkedLines(askLong), [`${RUY_40.slice(0, 32).join(' ')} (stored line)`]);
});

test('lesson identity (8.11, 9.2): title, goal, provenance and step add a sentence only when given; different goals give different prompts and hashes', () => {
  const plain = buildExplainPrompt(explain).prompt;
  for (const s of ['Card title', 'Goal of this card', 'first move on the card', 'his move ']) assert.ok(!plain.includes(s), s);
  const full = buildExplainPrompt({ ...explain, title: 'Punish the loose knight', objective: 'exploit the move just played', answerSource: 'game-engine', step: 0 });
  const lines = full.prompt.split('\n');
  assert.equal(lines[1], 'Card title: Punish the loose knight.');
  assert.ok(lines[2].startsWith('What this card teaches:'));
  assert.equal(lines[3], 'Goal of this card: exploit the move just played.');
  at(full.prompt, "Answer line (the engine's best line, in a position from the learner's own game): Qxg5 d4 Qg6 dxe5.");
  at(full.prompt, 'This was his first move on the card.');
  at(buildExplainPrompt({ ...explain, step: 2 }).prompt, 'This was his move 2 on the card, after the first 2 plies of its line.');
  assert.ok(!buildExplainPrompt({ ...explain, step: -1 }).prompt.includes('on the card'), 'a bad step is ignored');
  for (const [answerSource, label] of [['puzzle', "the Lichess puzzle's solution"], ['tablebase', "the drill's line, checked with the endgame tablebase"], ['drill', 'a practice line set by Claude']] as const) {
    at(buildExplainPrompt({ ...explain, answerSource }).prompt, `Answer line (${label}): Qxg5`);
  }
  // An unknown provenance (even a prototype key) falls back to the label from the card source.
  at(buildExplainPrompt({ ...explain, answerSource: 'constructor' as CoachExplainInput['answerSource'] }).prompt, "Answer line (the engine's best line): Qxg5");
  // Two lessons on the same board and line with different goals (Codex C3).
  const a = { ...explain, objective: 'win material' }, b = { ...explain, objective: 'find the mate' };
  assert.notEqual(buildExplainPrompt(a).prompt, buildExplainPrompt(b).prompt);
  assert.notEqual(inputsHash(a), inputsHash(b));
  // The title is the page's own text: its squares are citable.
  assert.ok(buildExplainPrompt({ ...explain, title: 'The knight on g5' }).squares?.includes('g5'));
  // The answer's style rules (L11) are in every explain and ask prompt.
  for (const p of [plain, buildAskPrompt(ask).prompt]) at(p, 'one idea per sentence. Name pieces with their squares. No praise words. No exclamation marks.');
});

test('spoilersAllowed false: the answer, its line, the lesson and any text that names the answer stay out of the prompt', () => {
  const built = buildExplainPrompt({ ...explain, spoilersAllowed: false, title: 'Qxg5 wins a piece', objective: 'exploit the move just played' });
  for (const s of ['Qxg5', 'Qg6', 'dxe5', 'Card lesson', 'Card title', 'Answer line']) assert.ok(!built.prompt.includes(s), s);
  assert.ok(!built.sans.includes('Qxg5'), 'the answer is not citable');
  at(built.prompt, "The learner tried Nf6. He is still solving: the card's answer (the engine's best line) is not given here.");
  at(built.prompt, "95% after the card's answer, 30% after Nf6, a difference of 65 points.");
  at(built.prompt, 'Say what goes wrong after Nf6, naming the reply Nxf7.');
  at(built.prompt, 'He is still solving this card: do not name or hint at its answer, and do not suggest any move to play.');
  at(built.prompt, 'Goal of this card: exploit the move just played.');
  at(built.prompt, 'What this card teaches: In your game White played Ng5');
  // FX4b (brief 9.11.3, R5-4): 95 against 95 is "at least as good" (this read "about as good").
  at(buildExplainPrompt({ ...explain, spoilersAllowed: false, tryWin: 95, bestWin: 95 }).prompt,
    "By these numbers Nf6 is at least as good as the card's answer. Say so, then say what the line after Nf6 shows, if one is given.");
  // true (or absent) keeps the prompt as it was.
  assert.equal(buildExplainPrompt({ ...explain, spoilersAllowed: true }).prompt, buildExplainPrompt(explain).prompt);
});

test('ask prompt (9.2): title, goal and provenance; tablebase results in words for the answer and each checked move, never a percentage', () => {
  const tb: CoachAskInput = {
    kind: 'ask', itemId: 'tech-test-2', source: 'endgame', fen: OPPOSITION, side: 'b', question: 'Why not Ke8? And Kf6?',
    title: 'Keep the opposition', objective: 'hold the draw', answerSource: 'tablebase', answerLineSan: ['Kd7'], answerResult: 'draw', answerWin: 50,
    askedLines: [
      { san: 'Ke8', lineSan: ['Ke8', 'Ke6', 'Kd8', 'Kd6'], result: 'loss', win: 0, source: 'tablebase' },
      { san: 'Kf6', lineSan: [], result: 'loss', source: 'tablebase' },
    ],
  };
  const built = buildAskPrompt(tb);
  for (const s of ['Card title: Keep the opposition.', 'Goal of this card: hold the draw.', "Answer line (the drill's line, checked with the endgame tablebase): Kd7.",
    'Tablebase result with best play from both sides, after Kd7: the game is a draw.', 'Checked move Ke8. Its line (tablebase line): Ke8 Ke6 Kd8 Kd6.',
    'after Ke8, Black loses; after Kd7, the game is a draw.', 'Checked move Kf6. Its line (tablebase line): Kf6.', 'after Kf6, Black loses']) at(built.prompt, s);
  assert.ok(!built.prompt.includes('%') && built.numbers.length === 0);
  assert.equal(groundCheck('Ke8 loses: after Ke6 the white king takes the opposition. Kd7 holds the draw.', built, 'ask').grounded, true);
  assert.deepEqual(checkedLines(tb), ['Ke8 Ke6 Kd8 Kd6 (tablebase line; Black loses with best play)', 'Kf6 (tablebase line; Black loses with best play)']);
  // An asked line that does not start with its move shows the move alone; an illegal move is left out.
  const odd = buildAskPrompt({ ...ask, askedLines: [{ san: 'd5', lineSan: ['exd5'], win: 41, source: 'engine' }, { san: 'Kd2', lineSan: [], win: 10, source: 'engine' }] });
  at(odd.prompt, 'Checked move d5. Its line (engine line, searched in this page): d5.');
  assert.ok(!odd.prompt.includes('exd5') && !odd.prompt.includes('Kd2'));
});

test('coach (8.13): Stop during the cache read wins over a saved answer', async () => {
  const path = 'explanations/punish-test-1__g8f6';
  const seed = { [path]: { text: 'Saved answer.', at: 1, grounded: true, inputsHash: inputsHash(explain), itemId: explain.itemId, playedUci: 'g8f6' } };
  const prompts: string[] = [];
  const coach = createCoach({
    sample: async i => { prompts.push(String(i)); return { text: 'x', truncated: false }; },
    permissions: null, store: createFakeStore({ seed, latencyMs: 30 }), deviceId: 'd1', storage: memoryKv(),
  });
  assert.equal((await coach.ask(explain)).cached, true, 'without Stop the saved answer is reused');
  const controller = new AbortController();
  const pending = coach.ask(explain, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, (e: CoachError) => e.failure.code === 'cancelled' && e.failure.action === 'cancelled');
  assert.equal(prompts.length, 0, 'no model call either');
});

test('panel (8.13, 8.5): runAsk drops an answer that arrives after Stop; RequestGate lets only the current request paint', async () => {
  const controller = new AbortController();
  const late = fakeCoach({ ask: async () => { controller.abort(); return result({ cached: true }); } });
  assert.deepEqual(await runAsk({ coach: late.coach, question: 'Why?', build: () => ask, signal: controller.signal }), { status: 'stopped' });
  const gate = new RequestGate();
  const a = gate.start();
  assert.equal(a.live(), true);
  gate.stop(); // the Stop button
  assert.equal(a.signal.aborted, true);
  assert.equal(a.live(), true, 'a stopped request stays current, so its failure can clear the busy state');
  gate.finish(a);
  assert.equal(a.live(), false);
  const b = gate.start();
  gate.reset(); // a new card or move
  assert.equal(b.signal.aborted, true);
  assert.equal(b.live(), false, 'its late answer cannot attach to the new card');
  const c = gate.start(), d = gate.start(); // a second request replaces the first
  assert.equal(c.signal.aborted, true);
  assert.equal(c.live(), false);
  gate.finish(c);
  assert.equal(d.live(), true, 'finishing a replaced request changes nothing');
});

test('documents (L10): answers built from every 9.2 field are written in the unchanged explanations schema', async () => {
  const h = harness(async () => ({ text: 'After Nf6, Nxf7 attacks the queen on d8 and the rook on h8. Qxg5 wins the knight on g5.', truncated: false }));
  const full: CoachExplainInput = { ...explain, title: 'Punish the loose knight', objective: 'exploit the move just played', answerSource: 'game-engine', step: 0, spoilersAllowed: true, tryVerdict: 'losing' };
  assert.equal((await h.coach.ask(full)).grounded, true);
  await settle();
  const path = 'explanations/punish-test-1__g8f6';
  const doc = h.store.dump()[path];
  assert.ok(readDoc(path, doc));
  assert.deepEqual(Object.keys(doc).sort(), ['at', 'grounded', 'inputsHash', 'itemId', 'misses', 'playedUci', 'text']);
  h.tick(COOLDOWN_MS + 1);
  const tbAsk: CoachAskInput = { kind: 'ask', itemId: 'tech-test-2', source: 'endgame', fen: OPPOSITION, side: 'b', question: 'Why not Ke8?', answerLineSan: ['Kd7'],
    answerResult: 'draw', answerSource: 'tablebase', objective: 'hold the draw', askedLines: [{ san: 'Ke8', lineSan: ['Ke8', 'Ke6'], result: 'loss', source: 'tablebase' }] };
  const r = await h.coach.ask(tbAsk);
  await settle();
  const askPath = `explanations/tech-test-2__ask-${r.inputsHash}`;
  assert.ok(readDoc(askPath, h.store.dump()[askPath]));
  assert.equal(h.store.dump()[askPath].playedUci, undefined);
});
