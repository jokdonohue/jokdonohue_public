/**
 * Version 7.1 (brief m31, sections 4.3 to 4.8), writer W3: the page side.
 *
 * - A (4.3): `hintLadderFor` applies H1 and H2 at step 0; the paragraph P in `SolvedNotes`; the viewer V in
 *   `SolvedViewers`; the lesson option `threat` at the three call sites (`lessonFor`, PunishStudy's lesson, the coach
 *   input), each through `lessonThreat`, so the page and the coach read one lesson (4.7).
 * - C (4.4): `gameMoveView`, the viewer of his game move with its two titles, hidden when the try slot shows that move;
 *   the words only where the line shows a loss or a mate.
 * - D (4.5): the list "More than one good reply"; the four held-list sites.
 * - E1, F2 (the lead and the hint head), F3 (the viewer title).
 * - 4.8: P, L, V and both parts of C exist only in the Trainer's `complete` branches; before that the only thing that
 *   differs between a card with a document entry and the same card without one is rungs 1 and 2 at step 0.
 *
 * The page has no DOM test renderer (a server render of <Trainer> shows "Loading"), so the Trainer is covered through
 * its exported pieces and the wiring is pinned by reading Trainer.tsx, as the M3 trainer tests do.
 * Every position is invented for these tests (a few pieces, round move numbers); none comes from a game.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chess } from 'chess.js';
import {
  afterCardNotes, answerMovesFrom, answerViewerVerdict, cardTitleOf, engineTryText, failsBadly, gameMoveView, gameMoveViewer, gameMoveWords,
  gradeCardTry, highlightedMove, hintLadderFor, HintLadder, justPlayedAt, lessonFor, NotHeldSiblings, notHeldSiblingIds, punishLead, SolvedNotes,
  SolvedViewers, solvingTryLine, storedNumbersIntro, storedTryText, threatParagraph, threatViewerOf, tryKey, TrySlot, tryViewOf, type TryView,
} from '../components/Trainer';
import PunishStudy, { MORE_THAN_ONE_HEADING, moreThanOneIntro } from '../components/PunishStudy';
import LineViewer, { lineNarration } from '../components/LineViewer';
import { buildPools, isPunish, type TrainerItem } from '../components/pools';
import { loadTeach, type LoadedPack } from '../components/model';
import { buildAskInput, explainInput, lessonThreat, staticExplanation } from '../components/coachInput';
import { readTeachMeta, type TeachHeld, type TeachThreat } from '../src/contract/teachDocs';
import { buildHints } from '../src/teach/hints';
import { KEEPS_EDGE_FROM } from '../src/teach/grade';
import { playedLabel, punishLesson } from '../src/teach/punish';
import { applyThreatHints, QUIET_BARE, threatFacts, threatSay } from '../src/teach/threat';
import type { TryCheck } from '../src/teach/tryMove';
import { ARTIFACT_DIR } from './b3_paths';

const src = readFileSync(join(ARTIFACT_DIR, 'components/Trainer.tsx'), 'utf8');
const study = readFileSync(join(ARTIFACT_DIR, 'components/PunishStudy.tsx'), 'utf8');
const coachSrc = readFileSync(join(ARTIFACT_DIR, 'components/coachInput.ts'), 'utf8');
const css = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const count = (text: string, s: string) => text.split(s).length - 1;
/** Where a function declared in Trainer.tsx starts and ends (parameter list and body matched by bracket counting). */
function body(name: string, text = src): string {
  const m = new RegExp(`function ${name}\\(`).exec(text);
  assert.ok(m, `${name} found`);
  let i = m.index + m[0].length, depth = 1;
  for (; depth > 0; i++) depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0;
  i = text.indexOf('{', i);
  for (depth = 1, i++; depth > 0; i++) depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0;
  return text.slice(m.index, i);
}
/** The source without its comments (block comments, JSX comments and line comments), for "this name is used only here". */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function after(fen: string, uci: string): string {
  const b = new Chess(fen);
  b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return b.fen();
}
const san = (fen: string, uci: string) => new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
const texts = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'g'))].map(m => m[1]);

// ---------------------------------------------------------------- fixtures (invented)

/** Q: White's queen goes to e4; with the bishop on d3 behind it, Qxh7 is then mate. His game move Qe8 loses the queen. */
const Q_FEN = '5rk1/5ppp/1n6/8/8/3B4/4QPPP/6K1 w - - 0 1';
const Q_TEACH: TeachThreat = { id: 'pack-q1', a: 'e2e4', t: ['e4h7'], k: 'mate', pre: false };
const quietMistake = (teach: TeachThreat | null = Q_TEACH, pack: Record<string, unknown> = {}): TrainerItem => ({
  id: 'pack-q1', fen: Q_FEN, moves: ['e2e4'], rating: 1000, themes: ['personal', 'middlegame'], gameUrl: '', source: 'pack', kind: 'mistake',
  pack: { playedSan: 'Qe8', playedUci: 'e2e8', pvUci: ['e2e4', 'g7g6'], refutationPvUci: ['f8e8'], winBefore: 88, winAfter: 3, ...pack },
  ...(teach ? { teach } : {}),
});
/** E: the knight on e5 is pinned to its king by the rook on e1 and attacked by the pawn on f4; the answer is the quiet
 *  h3, and fxe5 is already legal on the card ("prepares"). His game move Rxe5+ gives the rook for the knight. */
const E_FEN = '4k3/6pp/3p4/4n3/5P2/8/6PP/4R1K1 w - - 0 1';
const E_TEACH: TeachThreat = { id: 'pack-q3', a: 'h2h3', t: ['f4e5', 'd6e5', 'e1e5'], k: 'capture', pre: true, sq: 'e5', r: 'pinned', pin: 'e8' };
const pinMistake = (teach: TeachThreat | null = E_TEACH): TrainerItem => ({
  id: 'pack-q3', fen: E_FEN, moves: ['h2h3'], rating: 1000, themes: ['personal', 'endgame'], gameUrl: '', source: 'pack', kind: 'mistake',
  pack: { playedSan: 'Rxe5+', playedUci: 'e1e5', pvUci: ['h2h3'], refutationPvUci: ['d6e5', 'f4e5'], winBefore: 80, winAfter: 30 },
  ...(teach ? { teach } : {}),
});
/** A: the rook goes to d5 and attacks the loose knight on a5. Version 7's first hint already says so (not the bare
 *  "quiet move" sentence), so the hints of this card never change; the threat shows after the card only. */
const A_FEN = '6k1/5pp1/7p/n7/8/8/5PPP/3R2K1 w - - 0 1';
const A_TEACH: TeachThreat = { id: 'pack-q2', a: 'd1d5', t: ['d5a5'], k: 'capture', pre: false, sq: 'a5', r: 'undefended' };
const looseMistake = (teach: TeachThreat | null = A_TEACH): TrainerItem => ({
  id: 'pack-q2', fen: A_FEN, moves: ['d1d5'], rating: 1000, themes: ['personal', 'endgame'], gameUrl: '', source: 'pack', kind: 'mistake',
  pack: { playedSan: 'Kf1', playedUci: 'g1f1', pvUci: ['d1d5'], refutationPvUci: ['a5c4'], winBefore: 80, winAfter: 60 },
  ...(teach ? { teach } : {}),
});
/** P: a punish card, Black solves. His game move Nb3 (from d2) lets the queen go to e5, where Qxh2 is then mate. */
const P_SRC = '6k1/4qppp/3b4/8/8/8/3N1PPP/5RK1 w - - 0 1';
const P_FEN = after(P_SRC, 'd2b3');
const P_TEACH: TeachThreat = { id: 'punish-q9', a: 'e7e5', t: ['e5h2'], k: 'mate', pre: false };
const quietPunish = (teach: TeachThreat | null = P_TEACH, winAfter = 20): TrainerItem => ({
  id: 'punish-q9', fen: P_FEN, moves: ['e7e5'], rating: 1000, themes: ['personal', 'punish', 'middlegame'], gameUrl: '', source: 'pack', kind: 'punish',
  pack: { playedSan: 'Nb3', playedUci: 'd2b3', sourceFen: P_SRC, pvUci: ['e7e5', 'g2g3'], rowId: 'q9', winAfter, solverColor: 'b' },
  ...(teach ? { teach } : {}),
});
/** The sibling of P: his own mistake card at the position before Nb3 (the answer there is h3). */
const punishSibling = (): TrainerItem => ({
  id: 'pack-q9', fen: P_SRC, moves: ['h2h3'], rating: 1000, themes: ['personal'], gameUrl: '', source: 'pack', kind: 'mistake',
  pack: { playedSan: 'Nb3', playedUci: 'd2b3', pvUci: ['h2h3'], refutationPvUci: ['e7e5', 'g2g3'], winBefore: 55, winAfter: 20 },
});
/** S: his Rxb5 (the rook from b1) and the solver's Rxb5 (the rook from b8) share one SAN. */
const S_SRC = '1r4k1/5ppp/8/1p6/8/8/5PPP/1R4K1 w - - 0 1';
const sharedSan = (): TrainerItem => ({
  id: 'punish-s1', fen: after(S_SRC, 'b1b5'), moves: ['b8b5'], rating: 1000, themes: ['personal', 'punish', 'endgame'], gameUrl: '', source: 'pack', kind: 'punish',
  pack: { playedSan: 'Rxb5', playedUci: 'b1b5', sourceFen: S_SRC, pvUci: ['b8b5'], rowId: 's1', winAfter: 4, solverColor: 'b' },
});
/** D: after his Qd4 both the bishop and the rook can take the queen. Held as 'not-unique'. */
const D_SRC = '3r2k1/5ppp/5b2/8/8/8/5PPP/R2Q2K1 w - - 0 1';
const D_HELD: TeachHeld = { id: 'punish-d1', a: 'f6d4', why: 'not-unique', alt: 'd8d4' };
const twoReplies = (held: TeachHeld | null = D_HELD, id = 'punish-d1'): TrainerItem => ({
  id, fen: after(D_SRC, 'd1d4'), moves: ['f6d4'], rating: 1000, themes: ['personal', 'punish', 'middlegame'], gameUrl: '', source: 'pack', kind: 'punish',
  title: 'Punish it · Rapid · move 24',
  pack: { playedSan: 'Qd4', playedUci: 'd1d4', sourceFen: D_SRC, pvUci: ['f6d4', 'a1d1'], rowId: id.slice('punish-'.length), winAfter: 3, solverColor: 'b', date: '2026-01-05', timeClass: 'rapid', moveNumber: 24 },
  ...(held ? { teachHeld: { ...held, id } } : {}),
});
/** A mistake card for item C, on a position with nothing else going on; `pack` gives his game move and the stored reply. */
const gameMove = (fen: string, pack: Record<string, unknown>, id = 'pack-c1'): TrainerItem => ({
  id, fen, moves: ['h2h3'], rating: 1000, themes: ['personal', 'endgame'], gameUrl: '', source: 'pack', kind: 'mistake', pack: { pvUci: ['h2h3'], ...pack },
});
/** His knight takes a knight that a pawn defends; the pawn takes back: an even trade. */
const TRADE_FEN = '6k1/5ppp/3p4/4n3/8/5N2/5PPP/6K1 w - - 0 1';
const trade = () => gameMove(TRADE_FEN, { playedUci: 'f3e5', playedSan: 'Nxe5', refutationPvUci: ['d6e5'], winBefore: 50, winAfter: 20 });
/** His rook leaves the first rank; Re1 is mate. */
const BACK_FEN = '4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
const backRank = () => gameMove(BACK_FEN, { playedUci: 'd1d7', playedSan: 'Rd7', refutationPvUci: ['e8e1'], winBefore: 50, winAfter: 0 }, 'pack-c2');
/** His rook takes a pawn; the stored reply is one quiet king move, so the count ends with him a pawn up. */
const GRAB_FEN = '6k1/p4ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const pawnGrab = (winAfter = 20) => gameMove(GRAB_FEN, { playedUci: 'a1a7', playedSan: 'Rxa7', refutationPvUci: ['g8f8'], winBefore: 80, winAfter }, 'pack-c3');
const quietReply = (winAfter = 60) => gameMove(GRAB_FEN, { playedUci: 'g1f1', playedSan: 'Kf1', refutationPvUci: ['g8f8'], winBefore: 80, winAfter }, 'pack-c4');
/** A Lichess puzzle, a drill from Claude and a short-scan position, for "nothing changes elsewhere". */
const FRENCH = 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6 0 3';
const bank = (): TrainerItem => ({ id: 'bank-french', fen: FRENCH, moves: ['b1c3', 'g8f6', 'c1g5'], rating: 1400, themes: ['opening', 'advantage'], gameUrl: '', source: 'bank' });
const agent = (): TrainerItem => ({ id: 'agent-1', fen: Q_FEN, moves: ['e2e4'], rating: 900, themes: ['quiet'], gameUrl: '', source: 'agent', title: 'A quiet queen move' });
const scan = (): TrainerItem => ({ id: 'personal-scan1', fen: Q_FEN, moves: ['e2e4'], rating: 1000, themes: ['personal'], gameUrl: '', source: 'personal', pack: { playedUci: 'e2e8', refutationPvUci: ['f8e8'], winBefore: 88, winAfter: 3 } });
const check = (o: Partial<TryCheck> & Pick<TryCheck, 'tryUci' | 'trySan' | 'replyLine' | 'tryWin'>): TryCheck => ({ bestWin: null, verdict: 'worse', depth: 12, ms: 5, ...o });
/** The try view the page makes for a try at the card's own position. */
const tryAt = (item: TrainerItem, uci: string, c: TryCheck | null): TryView =>
  tryViewOf(tryKey(item.id, 0, uci), item.fen, uci, answerMovesFrom(item, item.fen, 0), gradeCardTry(item, item.fen, uci, 0, c))!;

// The exact texts of table 4.3 for the fixtures above (computed by threat.ts; written out here once, by hand, from the table).
const Q_H1 = 'The right move is a quiet one, but it threatens checkmate.';
const Q_H2 = 'Target: the black king on g8. The right move threatens checkmate.';
const Q_P = 'Qe4 threatens checkmate. If Black made no move in reply: Qxh7#.';
const E_H1 = 'The right move is a quiet one. It prepares a capture that wins material.';
const E_H2 = 'Target: the knight on e5. It is pinned to the king on e8. The right move prepares to win it. Playing the capture at once is not the move.';
const E_P = 'h3 prepares fxe5. The knight on e5 is pinned to the king on e8. If Black made no move in reply: fxe5 dxe5 Rxe5+. White wins a knight.';
const P_HEAD = 'The move just played, Nb3, was yours in the game. ';
const P_H2 = 'Target: the white king on g1. The right move threatens checkmate.';
const P_CLAUSE = 'It threatens checkmate. If White made no move in reply: Qxh2#.';

// ---------------------------------------------------------------- A: the hints (H1, H2)

test('A, hints: at step 0 a card with a stored threat gets H1 in place of the bare quiet sentence and H2 as rung 2; rungs 3 and 4 stay', () => {
  for (const [name, withTeach, without, h1, h2, square] of [
    ['mistake, mate', quietMistake(), quietMistake(null), Q_H1, Q_H2, 'g8'],
    ['mistake, a capture already legal, pinned target', pinMistake(), pinMistake(null), E_H1, E_H2, 'e5'],
    ['punish, mate: the head stays, the king has its colour', quietPunish(), quietPunish(null), `${P_HEAD}${Q_H1}`, P_H2, 'g1'],
  ] as const) {
    const v7 = hintLadderFor(without, without.fen, 0), now = hintLadderFor(withTeach, withTeach.fen, 0);
    assert.ok(v7[0].text.endsWith(QUIET_BARE), `${name}: version 7's rung 1 ends with the bare quiet sentence`);
    assert.equal(now.length, 4, name);
    assert.deepEqual(now.map(h => h.level), [1, 2, 3, 4], name);
    assert.equal(now[0].text, h1, name);
    assert.deepEqual(now[1], { level: 2, text: h2, square }, `${name}: the target's square, no arrow`);
    assert.deepEqual(now.slice(2), v7.slice(2), `${name}: rungs 3 and 4 are version 7's`);
    assert.deepEqual({ ...now[0], text: '' }, { ...v7[0], text: '' }, `${name}: rung 1 keeps every other field`);
    // The page's ladder is the module's function over version 7's ladder, so the sweeps and the builder read the same.
    assert.deepEqual(now, applyThreatHints(v7, threatFacts(withTeach), isPunish(withTeach)), name);
    // 4.3: H1 and H2 name neither the answer nor the first threat move, nor their squares.
    const facts = threatFacts(withTeach)!;
    const answer = withTeach.moves[0], first = withTeach.teach!.t[0];
    for (const h of now.slice(0, 2)) {
      for (const word of [facts.answerSan, facts.firstSan, answer.slice(0, 2), answer.slice(2, 4), first.slice(0, 2)]) {
        assert.ok(!new RegExp(`(?<![A-Za-z0-9])${word.replace(/[+#]/g, '')}(?![0-9])`).test(h.text), `${name}: "${word}" is not in "${h.text}"`);
      }
      assert.ok(![answer.slice(0, 2), answer.slice(2, 4), first.slice(0, 2)].includes(h.square ?? ''), `${name}: no mark on an answer square`);
      assert.equal(h.arrow, undefined, name);
    }
  }
});

test('A, hints: every other ladder is version 7\'s: a later step, another position, a first hint that is not the bare sentence, a stale entry, other kinds', () => {
  // The same card without an entry: the function returns version 7's ladder object for object.
  const plain = quietMistake(null);
  const v7 = buildHints({ fen: plain.fen, line: ['e2e4', 'g7g6'], themes: plain.themes, kind: 'pack', ply: 0 });
  assert.deepEqual(hintLadderFor(plain, plain.fen, 0), v7);
  // A later step of a card with an entry (a two-step card; the entry is about its first move).
  const twoStep: TrainerItem = { ...quietMistake(), moves: ['e2e4', 'g7g6', 'e4e7'], pack: { ...quietMistake().pack, pvUci: ['e2e4', 'g7g6', 'e4e7'] } };
  const at2 = after(after(Q_FEN, 'e2e4'), 'g7g6');
  const bare2: TrainerItem = { ...twoStep, teach: undefined };
  assert.deepEqual(hintLadderFor(twoStep, at2, 2), hintLadderFor(bare2, at2, 2), 'step 2');
  assert.notDeepEqual(hintLadderFor(twoStep, twoStep.fen, 0), hintLadderFor(bare2, bare2.fen, 0), 'step 0 of the same card does change');
  // Step 0 asked for with another position than the card's own.
  assert.deepEqual(hintLadderFor(twoStep, at2, 0), hintLadderFor(bare2, at2, 0), 'not the card\'s position');
  // A first hint that already says something: nothing changes, though the entry is valid.
  const loose = looseMistake();
  assert.ok(threatFacts(loose), 'the entry is valid');
  assert.ok(!hintLadderFor(looseMistake(null), A_FEN, 0)[0].text.endsWith(QUIET_BARE));
  assert.deepEqual(hintLadderFor(loose, A_FEN, 0), hintLadderFor(looseMistake(null), A_FEN, 0));
  // An entry for another answer, a line that does not replay, a kind the page reads differently: version 7.
  for (const bad of [{ ...Q_TEACH, a: 'e2e3' }, { ...Q_TEACH, t: ['e4h8'] }, { ...Q_TEACH, k: 'capture' }, { ...Q_TEACH, pre: true }, { ...Q_TEACH, t: [] }]) {
    assert.deepEqual(hintLadderFor(quietMistake(bad as TeachThreat), Q_FEN, 0), v7, JSON.stringify(bad));
  }
  // Kinds that never carry an entry are untouched by construction (no `teach`), and stay so with one planted.
  for (const item of [bank(), agent(), scan()]) {
    const planted = { ...item, teach: { ...Q_TEACH, id: item.id, a: item.moves[0] } };
    const base = hintLadderFor(item, item.fen, 0);
    if (item.source === 'bank') assert.deepEqual(hintLadderFor(planted, item.fen, 0), base, 'a puzzle\'s first hint is not the bare sentence');
    assert.deepEqual(hintLadderFor(item, item.fen, 0), base);
  }
  // Wiring: applied inside hintLadderFor, at step 0, on the card's own position, only with an entry; the memo is as before.
  assert.match(body('hintLadderFor'), /return index === 0 && item\.teach && fenKey\(fen\) === fenKey\(item\.fen\) \? applyThreatHints\(ladder, threatFacts\(item\), isPunish\(item\)\) : ladder;/);
  assert.match(src, /useMemo\(\(\) => \(active && shownNow > 0 \? hintLadderFor\(active, fen, index\) : null\)/);
});

// ---------------------------------------------------------------- A: after the card (P, V, L)

test('A, P: after a mistake card the threat is the last paragraph of the notes; a punish card says it in its lesson instead', () => {
  assert.equal(threatParagraph(quietMistake()), Q_P);
  assert.equal(threatParagraph(pinMistake()), E_P);
  assert.equal(threatParagraph(looseMistake()), 'Rd5 threatens Rxa5. The knight on a5 is undefended. If Black made no move in reply: Rxa5. White wins a knight.');
  assert.equal(threatParagraph(quietMistake()), threatSay(quietMistake())!.paragraph, 'the module\'s paragraph, unchanged');
  for (const none of [quietMistake(null), quietPunish(), bank(), agent(), scan(), quietMistake({ ...Q_TEACH, a: 'e2e3' })]) assert.equal(threatParagraph(none), null, none.id);
  // In the notes: his game move's words first (item C), then P, last.
  const html = renderToStaticMarkup(<SolvedNotes item={quietMistake()}/>);
  assert.deepEqual(texts(html, 'p'), ['In your game you played Qe8. That allowed Rxe8, which takes the queen on e8. Black wins the queen.', esc(Q_P)]);
  assert.match(html, /<p class="threat-words">Qe4 threatens checkmate\. If Black made no move in reply: Qxh7#\.<\/p><\/div>$/);
  // Without the entry the paragraph is gone and nothing else moves.
  assert.deepEqual(texts(renderToStaticMarkup(<SolvedNotes item={quietMistake(null)}/>), 'p'), ['In your game you played Qe8. That allowed Rxe8, which takes the queen on e8. Black wins the queen.']);
  // A punish card: one paragraph, the lesson, with the threat inside it.
  const punish = renderToStaticMarkup(<SolvedNotes item={quietPunish()} sibling={punishSibling()}/>);
  assert.deepEqual(texts(punish, 'p'), [`In your game you played Nb3. Black&#x27;s best reply is Qe5. ${P_CLAUSE} After your move the engine gives Black about 80% to win. Better was h3.`]);
});

test('A, V: the threat viewer sits right after the answer viewer, one press away, from the pass position, with no figure', () => {
  const v = threatViewerOf(quietMistake())!;
  assert.deepEqual(v, { fen: '5rk1/5ppp/1n6/8/4Q3/3B4/5PPP/6K1 w - - 2 2', line: ['e4h7'], title: 'What Qe4 threatens', toggle: 'Show what it threatens', intro: 'Qe4 has been played. If Black made no move in reply, this would follow.' });
  assert.deepEqual(threatViewerOf(pinMistake()), { fen: '4k3/6pp/3p4/4n3/5P2/7P/6P1/4R1K1 w - - 1 2', line: ['f4e5', 'd6e5', 'e1e5'], title: 'What h3 prepares', toggle: 'Show what it prepares', intro: 'h3 has been played. If Black made no move in reply, this would follow.' });
  assert.equal(threatViewerOf(quietPunish())!.title, 'What Qe5 threatens');
  for (const none of [quietMistake(null), quietPunish(null), bank(), agent(), scan()]) assert.equal(threatViewerOf(none), null, none.id);
  // Closed whatever `assisted` is: the answer viewer is open (one section), the threat viewer is a button.
  for (const assisted of [true, false]) {
    const html = renderToStaticMarkup(<SolvedViewers item={quietMistake()} assisted={assisted}/>);
    assert.equal(count(html, '<section'), assisted ? 1 : 0, `assisted ${assisted}`);
    const buttons = texts(html, 'button').filter(t => t.startsWith('Show'));
    assert.deepEqual(buttons, [...(assisted ? [] : ['Show why it works']), 'Show what it threatens', 'Show what Qe8 allowed'], `assisted ${assisted}: answer, threat, game move`);
    assert.ok(!html.includes('What Qe4 threatens') && !html.includes('If Black made no move'), 'nothing of the line before he opens it');
    assert.match(html, /<div class="teach-more"><button type="button" class="secondary line-viewer-toggle" aria-expanded="false">Show what it threatens<\/button><\/div>/);
  }
  // On a punish card: the answer, the threat, then what he could have played.
  const punish = renderToStaticMarkup(<SolvedViewers item={quietPunish()} sibling={punishSibling()} assisted={false}/>);
  assert.deepEqual(texts(punish, 'button'), ['Show why it works', 'Show what it threatens', 'Show what you could have played']);
  // Opened, it is an ordinary line viewer over those props: the title, the first caption, and at the end the narrator's
  // closing sentence for the shown line (none for a mate, whose last caption says it).
  const pin = threatViewerOf(pinMistake())!;
  const open = renderToStaticMarkup(<LineViewer title={pin.title} startFen={pin.fen} line={pin.line} orientation="w" intro={pin.intro} noChangeSentence={false}/>);
  assert.match(open, />What h3 prepares<\/h3>/);
  assert.ok(open.includes(`<p class="line-viewer-caption" aria-live="polite">${esc(pin.intro)}</p>`));
  assert.equal(lineNarration(pin.fen, pin.line, undefined, { verdict: null, omit: null, noChangeSentence: false }).summary, 'White wins a knight.', 'the closing the paragraph quotes');
  const atEnd = renderToStaticMarkup(<LineViewer title={pin.title} startFen={pin.fen} line={pin.line} orientation="w" intro={pin.intro} noChangeSentence={false} initialStep={3}/>);
  assert.match(atEnd, /<p class="line-viewer-summary">White wins a knight\.<\/p>/);
  assert.ok(!/%/.test(atEnd), 'no figure in the threat viewer');
  // Wiring: its own block after the answer viewer, never `assisted`, no verdict.
  const tag = /<div className="teach-more"><LineViewer key=\{`threat-\$\{item\.id\}`\}[^>]*\/><\/div>/.exec(body('SolvedViewers'))?.[0] ?? '';
  assert.match(tag, /title=\{threat\.title\} startFen=\{threat\.fen\} line=\{threat\.line\} orientation=\{sideOf\(item\.fen\)\}\s+intro=\{threat\.intro\} noChangeSentence=\{false\} defaultOpen=\{false\} toggleLabel=\{threat\.toggle\} onOpen=\{onOpen\}/);
  assert.ok(!tag.includes('verdict') && !tag.includes('assisted'));
  const order = ['key={`answer-', 'key={`threat-', 'key={`game-', 'key={`allowed-'].map(k => body('SolvedViewers').indexOf(k));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'answer, threat, game line, game move');
  assert.ok(order.every(i => i > 0));
});

test('A, L and 4.7: one lesson for the page, the reading lists and the coach, with the threat from one definition', async () => {
  const item = quietPunish(), sib = punishSibling();
  const clause = threatSay(item)!.clause;
  assert.deepEqual(clause, { full: P_CLAUSE, fullNoClosing: P_CLAUSE, short: 'It threatens checkmate.' });
  assert.deepEqual(lessonThreat(item), clause, 'the one definition');
  // The page.
  const page = lessonFor(item, sib)!;
  assert.equal(page, `In your game you played Nb3. Black's best reply is Qe5. ${P_CLAUSE} After your move the engine gives Black about 80% to win. Better was h3.`);
  assert.equal(page, punishLesson(item, sib, { threat: clause }));
  assert.equal(lessonFor(quietPunish(null), sib), 'In your game you played Nb3. Black\'s best reply is Qe5. After your move the engine gives Black about 80% to win. Better was h3.', 'without the entry: version 7\'s lesson');
  // The coach, explain input (no live figure): the same text.
  const wrong = { fen: item.fen, uci: 'h7h6', index: 0 };
  const explain = explainInput(item, wrong, 'pack', { sibling: sib })!;
  assert.equal(explain.lesson, page, 'the coach reads the page\'s lesson');
  // With a live figure for the answer the coach's lesson leaves out its engine sentence (R5-5), and nothing else.
  const live = explainInput(item, wrong, 'pack', { sibling: sib, check: check({ tryUci: 'h7h6', trySan: 'h6', replyLine: ['g2g3'], tryWin: 40, bestWin: 82 }) })!;
  assert.equal(live.lesson, punishLesson(item, sib, { engineFigure: false, threat: clause }));
  assert.equal(live.lesson, `In your game you played Nb3. Black's best reply is Qe5. ${P_CLAUSE} Better was h3.`);
  // The coach, ask input.
  const ask = await buildAskInput(item, 'pack', 'Why not h6?', new AbortController().signal, { sibling: sib, check: async () => null });
  assert.equal(ask!.lesson, page);
  // No entry: the coach's lesson is version 7's too.
  assert.equal(explainInput(quietPunish(null), wrong, 'pack', { sibling: sib })!.lesson, lessonFor(quietPunish(null), sib));
  // The reading lists: the same lesson without "Better was" (the sibling may still be served).
  const listed = renderToStaticMarkup(<PunishStudy items={[]} edges={[{ card: quietPunish(P_TEACH, 40), sibling: sib }]}/>);
  assert.ok(listed.includes(esc(`In your game you played Nb3. Black's best reply is Qe5. ${P_CLAUSE} After your move the engine gives Black about 60% to win, only a small edge.`)));
  assert.ok(!listed.includes('Better was'));
  // Never on a missed-win card (the lead's rulings of 01:16 and 03:06), never without a valid entry, never on other kinds.
  assert.equal(lessonThreat(quietPunish(P_TEACH, 60)), undefined, 'missed win: his side is still better');
  assert.equal(lessonFor(quietPunish(P_TEACH, 60), sib), lessonFor(quietPunish(null, 60), sib));
  assert.deepEqual(lessonThreat(quietPunish(P_TEACH, 40)), clause, 'a small edge: listed, with the threat');
  for (const none of [quietPunish(null), quietPunish({ ...P_TEACH, a: 'e7e6' }), quietMistake(), bank()]) assert.equal(lessonThreat(none), undefined, none.id);
  // Wiring: the three call sites pass `lessonThreat` of their own card, and nothing else builds a punish lesson with a threat.
  assert.match(src, /punishLesson\(item, sibling \?\? null, \{ threat: lessonThreat\(item\) \}\)/);
  assert.match(study, /punishLesson\(edge\.card, edge\.sibling \?\? null, \{ betterMove: false, threat: lessonThreat\(edge\.card\) \}\)/);
  assert.match(coachSrc, /punishLesson\(card, sibling \?\? null, \{ engineFigure: opts\.lessonFigure !== false, threat: lessonThreat\(card\) \}\)/);
  assert.deepEqual([count(code(src), 'threat: lessonThreat('), count(code(study), 'threat: lessonThreat('), count(code(coachSrc), 'threat: lessonThreat(')], [1, 1, 1], 'three call sites');
  assert.deepEqual([count(code(src), 'punishLesson('), count(code(study), 'punishLesson('), count(code(coachSrc), 'punishLesson(')], [2, 1, 1], 'and one more lesson, his game move\'s (item C), built without the option');
  // The words about his game move (item C) carry no threat sentence: that lesson is built without the option.
  assert.match(body('gameMoveWords'), /punishLesson\(f\.view, null, \{ betterMove: false, engineFigure: false \}\)/);
});

// ---------------------------------------------------------------- C: what his game move allowed

test('C, gameMoveView: his game move on a mistake card as its own punish card; null on every other card', () => {
  const view = gameMoveView(quietMistake())!;
  assert.deepEqual(view, {
    fen: after(Q_FEN, 'e2e8'), moves: ['f8e8'], kind: 'punish', themes: ['personal', 'punish'],
    pack: { sourceFen: Q_FEN, playedUci: 'e2e8', playedSan: 'Qe8', pvUci: ['f8e8'], winAfter: 3 },
  });
  assert.ok(!('teach' in view) && !('id' in view), 'nothing from the document can be read for it');
  assert.equal(lessonThreat(view), undefined);
  const same = quietMistake();
  assert.equal(gameMoveView(same), gameMoveView(same), 'cached per card object');
  // His SAN is computed on the card (a stored `playedSan` that does not fit is not printed).
  assert.equal(gameMoveView(quietMistake(null, { playedSan: 'Qe7' }))!.pack.playedSan, 'Qe8');
  assert.equal('winAfter' in gameMoveView(quietMistake(null, { winAfter: undefined }))!.pack, false);
  for (const [name, item] of [
    ['a punish card', quietPunish()], ['a short engine scan', scan()], ['a Lichess puzzle', bank()], ['Claude\'s drill', agent()],
    ['no stored reply', quietMistake(null, { refutationPvUci: undefined })], ['an empty stored reply', quietMistake(null, { refutationPvUci: [] })],
    ['no game move', quietMistake(null, { playedUci: undefined })], ['his game move is the answer', quietMistake(null, { playedUci: 'e2e4' })],
    ['his game move is not legal', quietMistake(null, { playedUci: 'e2e9' })], ['the reply is not legal after it', quietMistake(null, { refutationPvUci: ['f8f1'] })],
    ['a stored reply that is not a list of moves', quietMistake(null, { refutationPvUci: [1, 2] })],
  ] as const) {
    assert.equal(gameMoveView(item), null, name);
    assert.equal(gameMoveViewer(item), null, name);
    assert.equal(gameMoveWords(item), null, name);
  }
});

test('C, the viewer: his game move and the stored reply from the card, the stored figure and pair; "allowed" only when all three conditions hold', () => {
  const item = quietMistake();
  const viewer = gameMoveViewer(item)!;
  assert.deepEqual(viewer, {
    fen: Q_FEN, line: ['e2e8', 'f8e8'], title: 'What your game move Qe8 allowed', toggle: 'Show what Qe8 allowed',
    intro: 'After Qe8 the engine gives White 3% to win; the best move keeps 88%.', verdict: { side: 'w', win: 3 }, allowed: true,
  });
  assert.equal(viewer.intro, storedTryText(item, item.fen, 'e2e8', 0)!.intro, 'the stored-pair sentence the try viewer builds');
  // The three conditions, one at a time.
  const neutral = (v: ReturnType<typeof gameMoveViewer>, x: string, why: string) => {
    assert.deepEqual([v!.title, v!.toggle, v!.allowed], [`The engine's line after your game move ${x}`, `Show the line after ${x}`, false], why);
  };
  assert.equal(gameMoveViewer(quietMistake(null, { winAfter: 35 }))!.allowed, true, 'his opponent at exactly 65%');
  neutral(gameMoveViewer(quietMistake(null, { winAfter: 35.1 })), 'Qe8', 'his opponent under 65% (64.9)');
  neutral(gameMoveViewer(quietReply(60)), 'Kf1', 'his opponent at 40%');
  neutral(gameMoveViewer(quietMistake(null, { winAfter: undefined })), 'Qe8', 'no stored figure');
  assert.equal(gameMoveViewer(quietMistake(null, { winAfter: undefined }))!.verdict, null);
  assert.equal(gameMoveViewer(quietMistake(null, { winAfter: undefined }))!.intro, undefined, 'no pair without both figures');
  neutral(gameMoveViewer(pawnGrab(20)), 'Rxa7', 'the line ends with him a pawn up, though the engine gives his opponent 80%');
  neutral(gameMoveViewer(item, null, true), 'Qe8', 'the punish sibling is held as not-held');
  assert.equal(gameMoveViewer(trade())!.allowed, true, 'an even trade is not "ahead"');
  assert.equal(gameMoveViewer(backRank())!.title, 'What your game move Rd7 allowed');
  // Hidden when the try slot already shows a line for his game move: from the stored line, or from a live check.
  const stored = tryAt(item, 'e2e8', null);
  assert.deepEqual(stored.line, ['e2e8', 'f8e8']);
  assert.equal(gameMoveViewer(item, stored), null);
  const liveSame = tryAt(item, 'e2e8', check({ tryUci: 'e2e8', trySan: 'Qe8', replyLine: ['f8e8'], tryWin: 2, bestWin: 90 }));
  assert.equal(gameMoveViewer(item, liveSame), null);
  // Shown after any other try, after no try, after a try at another step or of another card, and while a check runs.
  const other = tryAt(item, 'e2e3', check({ tryUci: 'e2e3', trySan: 'Qe3', replyLine: ['g7g6'], tryWin: 50, bestWin: 90 }));
  for (const latest of [undefined, null, other, { ...stored, key: tryKey(item.id, 2, 'e2e8') }, { ...stored, key: tryKey('pack-other', 0, 'e2e8') }, { ...stored, status: 'checking' as const }]) {
    assert.deepEqual(gameMoveViewer(item, latest), viewer);
  }
  // On the page: last, one press away whatever `assisted` is, opening on his move (step 1) with the stored figure.
  const html = renderToStaticMarkup(<SolvedViewers item={item} assisted/>);
  assert.match(html, /<div class="teach-more"><button type="button" class="secondary line-viewer-toggle" aria-expanded="false">Show what Qe8 allowed<\/button><\/div><\/div>$/);
  assert.ok(!html.includes('your game move Qe8 allowed'), 'the title shows only once he opens it');
  assert.ok(!renderToStaticMarkup(<SolvedViewers item={item} assisted latest={stored}/>).includes('Qe8 allowed'), 'hidden beside the try viewer of his game move');
  assert.ok(renderToStaticMarkup(<SolvedViewers item={item} assisted latest={other}/>).includes('Show what Qe8 allowed'));
  assert.ok(!renderToStaticMarkup(<SolvedViewers item={quietPunish()} sibling={punishSibling()} assisted/>).includes('allowed'), 'never on a punish card');
  const opened = renderToStaticMarkup(<LineViewer title={viewer.title} startFen={viewer.fen} line={viewer.line} orientation="w" intro={viewer.intro} initialStep={1} verdict={viewer.verdict} noChangeSentence={false}/>);
  assert.match(opened, />What your game move Qe8 allowed<\/h3>/);
  assert.match(opened, /<strong>1\. Qe8<\/strong>/, 'it opens on his move');
  const tag = /<div className="teach-more"><LineViewer key=\{`allowed-\$\{item\.id\}`\}[^>]*\/><\/div>/.exec(body('SolvedViewers'))?.[0] ?? '';
  assert.match(tag, /title=\{allowed\.title\} startFen=\{allowed\.fen\} line=\{allowed\.line\} orientation=\{sideOf\(item\.fen\)\}\s+intro=\{allowed\.intro\} initialStep=\{1\} verdict=\{allowed\.verdict\} noChangeSentence=\{false\} defaultOpen=\{false\} toggleLabel=\{allowed\.toggle\} onOpen=\{onOpen\}/);
});

test('C, the words: one paragraph, only where the stored line ends in mate by his opponent or leaves him behind by both counts', () => {
  // A loss: the punish lesson of his game move, without a figure and without "Better was".
  const item = quietMistake();
  const words = gameMoveWords(item)!;
  assert.equal(words, 'In your game you played Qe8. That allowed Rxe8, which takes the queen on e8. Black wins the queen.');
  assert.equal(words, punishLesson(gameMoveView(item)!, null, { betterMove: false, engineFigure: false }));
  // A mate.
  assert.equal(gameMoveWords(backRank()), 'In your game you played Rd7. That allowed Re1#, which is checkmate.');
  // He gave a rook for a knight: behind by both counts; his own capture keeps the material sentence out.
  assert.equal(gameMoveWords(pinMistake()), 'In your game you played Rxe5+. Black\'s best reply is dxe5, which takes the rook on e5.');
  // An even trade: narrated from the position after his move the reply "wins a knight", but counted from the card with his
  // own capture included nothing is lost. No words (the smaller set). The viewer is still offered.
  const even = trade();
  assert.equal(punishLesson(gameMoveView(even)!, null, { betterMove: false, engineFigure: false }), 'In your game you played Nxe5. That allowed dxe5, which takes the knight on e5.', 'what the looser rule would print');
  assert.equal(gameMoveWords(even), null);
  assert.ok(gameMoveViewer(even));
  // No loss and no mate in the stored line; a line that leaves him ahead.
  assert.equal(gameMoveWords(quietReply()), null);
  assert.equal(gameMoveWords(pawnGrab()), null);
  assert.equal(gameMoveWords(looseMistake()), null);
  // The punish sibling held as not-held: no words, whatever the line shows.
  assert.equal(gameMoveWords(item, true), null);
  assert.equal(gameMoveWords(backRank(), true), null);
  // Shape: at most 300 characters, no engine figure, no "Better was", never the bare "That allowed {move}." of a quiet reply.
  for (const c of [quietMistake(), backRank(), pinMistake()]) {
    const w = gameMoveWords(c)!;
    assert.ok(w.length <= 300 && !/%|Better was|engine/.test(w), w);
    assert.ok(!/That allowed [^ ,.]+\.( |$)/.test(w) || /#\./.test(w) === false, w);
  }
  // In the notes: after the stored explanation (which the solved panel prints above the notes) and before the threat.
  assert.deepEqual(afterCardNotes(item), { gameMove: words, threat: Q_P });
  assert.deepEqual(afterCardNotes(item, true), { gameMove: null, threat: Q_P }, 'the threat paragraph does not depend on the sibling');
  assert.deepEqual(afterCardNotes(quietPunish()), { gameMove: null, threat: null });
  assert.equal(renderToStaticMarkup(<SolvedNotes item={quietReply()}/>), '', 'a mistake card with neither: no notes block, as in version 7');
  assert.match(src, /\{active\.explanation && solvedTexts\.explanation && <p className="small">\{active\.explanation\}<\/p>\}\s*<SolvedNotes item=\{active\} sibling=\{sibling\} lesson=\{lesson\}\/>/);
});

test('C, the not-held sibling reaches the notes and the viewers through the pools, with the call sites unchanged', () => {
  // A pack: the mistake card q1 and its punish sibling, which the document holds as not-held.
  const mistake = { ...quietMistake(null), id: 'pack-r1' }, mate = { ...backRank(), id: 'pack-r2' };
  const sib = (row: string, fen: string): TrainerItem => ({ id: `punish-${row}`, fen, moves: [new Chess(fen).moves({ verbose: true })[0].lan], rating: 1000, themes: ['personal', 'punish'], gameUrl: '', source: 'pack', kind: 'punish', pack: { rowId: row, winAfter: 5 } });
  const p1 = sib('r1', after(Q_FEN, 'e2e8')), p2 = sib('r2', after(BACK_FEN, 'd1d7'));
  const pack = { version: 'v', meta: {} as LoadedPack['meta'], study: [], punishStudy: [], cards: [mistake, mate] as never, punish: [p1, p2] as never } as unknown as LoadedPack;
  const teach = loadTeach(readTeachMeta({ v: 1, teachVersion: 't1', packVersion: 'v', at: 1, cards: [], held: [{ id: p1.id, a: p1.moves[0], why: 'not-held' }, { id: p2.id, a: p2.moves[0], why: 'not-unique', alt: p2.moves[0] }] }));
  const pools = buildPools({ bank: [], endgames: [], pack, personal: [], drills: [], teach });
  assert.deepEqual(pools.notHeld.map(c => c.id), ['punish-r1']);
  assert.deepEqual(pools.notUnique.map(c => c.id), ['punish-r2']);
  const ids = notHeldSiblingIds(pools);
  assert.deepEqual([...ids], ['pack-r1'], 'only the sibling of the not-held card; a not-unique sibling changes nothing');
  assert.deepEqual([...notHeldSiblingIds({})], []);
  const card = pools.byId.get('pack-r1')!, other = pools.byId.get('pack-r2')!;
  // Without the provider (and for every card whose sibling is not held): the words and the "allowed" title.
  assert.ok(renderToStaticMarkup(<SolvedNotes item={card}/>).includes('That allowed Rxe8'));
  assert.ok(renderToStaticMarkup(<SolvedViewers item={card} assisted={false}/>).includes('Show what Qe8 allowed'));
  // With it: no words, and the neutral title.
  const notes = renderToStaticMarkup(<NotHeldSiblings.Provider value={ids}><SolvedNotes item={card}/><SolvedNotes item={other}/></NotHeldSiblings.Provider>);
  assert.ok(!notes.includes('Qe8'), 'no words under the card whose sibling is not-held');
  assert.ok(notes.includes('That allowed Re1#'), 'the other card keeps its words');
  const viewers = renderToStaticMarkup(<NotHeldSiblings.Provider value={ids}><SolvedViewers item={card} assisted={false}/><SolvedViewers item={other} assisted={false}/></NotHeldSiblings.Provider>);
  assert.ok(viewers.includes('Show the line after Qe8') && !viewers.includes('Qe8 allowed'));
  assert.ok(viewers.includes('Show what Rd7 allowed'));
  // Wiring: the Trainer provides the ids from the pools; the two components read them by the card's id.
  assert.match(src, /const notHeldSiblings = useMemo\(\(\) => notHeldSiblingIds\(pools\), \[pools\]\);/);
  assert.match(src, /return <NotHeldSiblings\.Provider value=\{notHeldSiblings\}><div className="app-shell">/);
  for (const name of ['SolvedNotes', 'SolvedViewers']) assert.match(body(name), /const siblingNotHeld = useContext\(NotHeldSiblings\)\.has\(item\.id\);/);
  assert.equal(count(src, '<SolvedNotes item={active} sibling={sibling} lesson={lesson}/>'), 1);
  assert.equal(count(src, '<SolvedViewers item={active} sibling={sibling} assisted={assisted} onOpen={cancelAdvance} latest={tryView}/>'), 1);
});

// ---------------------------------------------------------------- D: held cards and the new list

test('D, the list "More than one good reply": above the smaller edges, each card with its lesson, the other move and the line viewer', () => {
  const held = twoReplies(), second = twoReplies(D_HELD, 'punish-d2');
  const edge = { ...quietPunish(null, 40), id: 'punish-e1' };
  const one = renderToStaticMarkup(<PunishStudy items={[]} edges={[]} notUnique={[{ card: held }]}/>);
  assert.equal(MORE_THAN_ONE_HEADING, 'More than one good reply');
  assert.match(one, /^<section class="surface punish-study" aria-label="Punish it: positions to read"><div class="study-list punish-edges punish-also"><h2>More than one good reply<\/h2>/);
  assert.ok(one.includes(`<p class="small">${esc('In this position the engine\'s reply was not clearly the only good one. Read what your move allowed. Then step through the engine\'s line. These are for reading, not scored.')}</p>`));
  assert.equal(moreThanOneIntro(2), 'In these 2 positions the engine\'s reply was not clearly the only good one. Read what your move allowed. Then step through the engine\'s line. These are for reading, not scored.');
  // Per card: the date line, the lesson without "Better was", the other move, the viewer's button.
  const item = /<li class="study-item">(.*?)<\/li>/.exec(one)![1];
  assert.equal(item,
    '<p class="small"><strong>Rapid · 2026-01-05 · move 24</strong></p>'
    + '<p>In your game you played Qd4. That allowed Bxd4, which takes the queen on d4 and pins the pawn on f2 to the king. Black wins the queen.</p>'
    + '<p class="almost-line">The engine rates Rxd4 almost as highly.</p>'
    + '<button type="button" class="secondary line-viewer-toggle" aria-expanded="false">Show the line</button>');
  assert.ok(!/Better was|small edge|about level/.test(one), 'no "Better was"; no small-edge words over a card at 65% or more');
  // Both lists: the new one first; the count in each intro is its own list's.
  const both = renderToStaticMarkup(<PunishStudy items={[]} edges={[{ card: edge }]} notUnique={[{ card: held }, { card: second }]}/>);
  assert.ok(both.indexOf('More than one good reply') > 0 && both.indexOf('More than one good reply') < both.indexOf('Smaller edges from your games'));
  assert.ok(both.includes('In these 2 positions the engine&#x27;s reply was not clearly the only good one.'));
  assert.ok(both.includes('In this position your move gave your opponent a small edge at most.'));
  assert.equal(count(both, 'almost as highly'), 2, 'only in the new list');
  // Under the worked examples the headings are h3; the smaller edges alone render exactly as in version 7.
  const example = { id: 'study-1', fen: D_SRC, playedSan: 'Qd4', playedUci: 'd1d4', replyUci: 'd8d7', replySan: 'Rd7' };
  const nested = renderToStaticMarkup(<PunishStudy items={[example]} edges={[{ card: edge }]} notUnique={[{ card: held }]}/>);
  assert.deepEqual(texts(nested, 'h3'), ['More than one good reply', 'Smaller edges from your games']);
  const v7 = renderToStaticMarkup(<PunishStudy items={[]} edges={[{ card: edge }]}/>);
  assert.equal(renderToStaticMarkup(<PunishStudy items={[]} edges={[{ card: edge }]} notUnique={[]}/>), v7);
  assert.match(v7, /^<section class="surface punish-study" aria-label="Punish it: smaller edges"><div class="study-list punish-edges"><h2>Smaller edges from your games<\/h2>/);
  assert.ok(!v7.includes('almost as highly'));
  assert.equal(renderToStaticMarkup(<PunishStudy items={[]} edges={[]} notUnique={[]}/>), '');
  // A held row without a usable other move: the card is listed without that line. Five cards at first, then five more.
  const noAlt = renderToStaticMarkup(<PunishStudy items={[]} notUnique={[{ card: twoReplies({ ...D_HELD, alt: 'd8d9' }) }]}/>);
  assert.ok(noAlt.includes('That allowed Bxd4') && !noAlt.includes('almost as highly'));
  const many = renderToStaticMarkup(<PunishStudy items={[]} notUnique={[1, 2, 3, 4, 5, 6, 7].map(n => ({ card: twoReplies(D_HELD, `punish-d${n}`) }))}/>);
  assert.equal(count(many, '<li class="study-item">'), 5);
  assert.ok(many.includes('In these 7 positions') && many.includes('Show 2 more'));
});

test('D, the page: held cards are in no pool, counted nowhere, and every held-list site knows both new lists', () => {
  const served = { ...quietPunish(null), id: 'punish-k1', pack: { ...quietPunish(null).pack, rowId: 'k1' } };
  const unique = twoReplies(null, 'punish-k2'), notHeld = { ...twoReplies(null, 'punish-k3'), title: 'Punish it · Blitz · move 9' };
  const pack = { version: 'v', meta: {} as LoadedPack['meta'], study: [], punishStudy: [], cards: [] as never, punish: [served, unique, notHeld] as never } as unknown as LoadedPack;
  const doc = { v: 1, teachVersion: 't1', packVersion: 'v', at: 1, cards: [], held: [{ ...D_HELD, id: 'punish-k2' }, { id: 'punish-k3', a: 'f6d4', why: 'not-held' }] };
  const pools = buildPools({ bank: [], endgames: [], pack, personal: [], drills: [], teach: loadTeach(readTeachMeta(doc)) });
  const v7 = buildPools({ bank: [], endgames: [], pack, personal: [], drills: [] });
  assert.deepEqual(pools.own.map(c => c.id), ['punish-k1']);
  assert.deepEqual(v7.own.map(c => c.id), ['punish-k1', 'punish-k2', 'punish-k3']);
  assert.deepEqual([pools.notUnique.map(c => c.id), pools.notHeld.map(c => c.id)], [['punish-k2'], ['punish-k3']]);
  for (const id of ['punish-k2', 'punish-k3']) assert.ok(!pools.byId.has(id) && !pools.all.some(c => c.id === id) && !pools.bySource.pack.some(c => c.id === id), `${id} is never served`);
  // `punishClasses` keeps version 7's count (3); what the page prints counts the pools (1 graded card here).
  assert.deepEqual(pools.punishClasses, v7.punishClasses);
  assert.equal(pools.punishClasses.punish, 3);
  assert.equal(count(code(src), 'punishClasses'), 0, 'the page prints no number from punishClasses');
  assert.equal(count(code(study), 'punishClasses'), 0);
  // The three numbers the page prints about his own positions count `pools.own`: what is served.
  assert.equal(count(src, '{pools.own.length}'), 3);
  assert.match(src, /<strong>\{pools\.own\.length\} personal positions<\/strong>/);
  assert.match(src, /<strong>\{pools\.own\.length\}<\/strong><span>Positions from your games<\/span>/);
  assert.match(src, /\$\{pools\.own\.length\} positions from your games are in your practice\./);
  assert.match(src, /\.\.\.\(pools\.own\.some\(isPunish\) \? \[\[PUNISH, 'Punish it \(your games\)'\]/, 'the punish focus is offered only when a graded punish card is served');
  assert.match(src, /if \(nextTheme === PUNISH\) pool = pl\.own\.filter\(isPunish\);/);
  // 1. A note on a held card keeps its title.
  const titleOf = cardTitleOf(pools);
  assert.equal(titleOf('punish-k2'), 'Punish it · Rapid · move 24');
  assert.equal(titleOf('punish-k3'), 'Punish it · Blitz · move 9');
  assert.equal(cardTitleOf({ byId: pools.byId, smallEdge: [], missedWin: [] })('punish-k2'), null, 'the two lists are what finds them');
  assert.match(src, /const titleOf = useMemo\(\(\) => cardTitleOf\(pools\), \[pools\]\);/);
  // 2. Pack coverage in the read model, 3. the PGN import's known positions, 4. the reading list's props.
  assert.match(src, /packIds: \[\.\.\.pl\.own, \.\.\.pl\.smallEdge, \.\.\.pl\.missedWin, \.\.\.pl\.notUnique, \.\.\.pl\.notHeld\]\.filter\(p => p\.source === 'pack'\)\.map\(p => p\.id\),/);
  assert.match(src, /knownCards=\{\[\.\.\.pools\.own, \.\.\.pools\.smallEdge, \.\.\.pools\.missedWin, \.\.\.pools\.notUnique, \.\.\.pools\.notHeld\]\.map\(p => \(\{ id: p\.id, fen: p\.fen \}\)\)\}/);
  assert.match(src, /const punishAlso = useMemo\(\(\) => pools\.notUnique\.map\(card => \(\{ card, sibling: pools\.byId\.get\(punishSiblingId\(card\) \?\? ''\) \}\)\), \[pools\]\);/);
  assert.match(src, /<PunishStudy items=\{punishStudy\} edges=\{punishEdges\} notUnique=\{punishAlso\}\/>/);
  // Cards held as 'not-held' are listed nowhere: the reading list gets `notUnique` alone and never names the other list.
  assert.equal(count(study, 'notHeld'), 0);
  assert.equal(count(src, '<PunishStudy '), 1);
  // The pools get the document, and are rebuilt when it changes.
  assert.match(src, /buildPools\(\{ bank: puzzles, endgames: endgameDrills, pack: view\.pack, personal: view\.personal, drills: view\.drills, teach: view\.teach \}\), \[view\.pack, view\.personal, view\.drills, view\.teach\]\);/);
});

// ---------------------------------------------------------------- E1

test('E1: the answer viewer\'s figure is the stored one wherever the card stores one; a live check only where none is stored', () => {
  const mistake = quietMistake(null), punish = quietPunish(null);
  const liveOn = (item: TrainerItem, uci: string, trySan: string) => tryAt(item, uci, check({ tryUci: uci, trySan, replyLine: [], tryWin: 30, bestWin: 71.4 }));
  const m = liveOn(mistake, 'e2e3', 'Qe3'), p = liveOn(punish, 'h7h6', 'h6');
  assert.ok(m.numbers && p.numbers, 'both checks showed numbers (the case version 7 took the live figure in)');
  assert.deepEqual(answerViewerVerdict(mistake, m), { side: 'w', win: 88 }, 'a mistake card: pack.winBefore');
  assert.deepEqual(answerViewerVerdict(punish, p), { side: 'b', win: 80 }, 'a punish card: 100 - pack.winAfter');
  assert.deepEqual(answerViewerVerdict(mistake), { side: 'w', win: 88 });
  assert.deepEqual(answerViewerVerdict(punish), { side: 'b', win: 80 });
  // No stored figure: the live check, as in version 7; with neither, none.
  const bareMistake = quietMistake(null, { winBefore: undefined });
  const barePunish: TrainerItem = { ...punish, pack: { ...punish.pack, winAfter: undefined } };
  assert.deepEqual(answerViewerVerdict(bareMistake, liveOn(bareMistake, 'e2e3', 'Qe3')), { side: 'w', win: 71.4 });
  assert.deepEqual(answerViewerVerdict(barePunish, liveOn(barePunish, 'h7h6', 'h6')), { side: 'b', win: 71.4 });
  assert.equal(answerViewerVerdict(bareMistake), null);
  assert.equal(answerViewerVerdict(barePunish), null);
  // A short engine scan keeps version 7's order (the live check, else its stored figure if it has one); puzzles and drills as before.
  const s = scan();
  assert.deepEqual(answerViewerVerdict(s, liveOn(s, 'e2e3', 'Qe3')), { side: 'w', win: 71.4 });
  assert.deepEqual(answerViewerVerdict(s), { side: 'w', win: 88 });
  assert.deepEqual(answerViewerVerdict(bank()), { side: 'w', winning: true });
  const a = agent();
  assert.deepEqual(answerViewerVerdict(a, liveOn(a, 'e2e3', 'Qe3')), { side: 'w', win: 71.4 });
  assert.equal(answerViewerVerdict(a), null);
  // One figure for the answer inside the viewer: the first caption prints the stored 88, and the figure the closing
  // sentence may use is that same 88, not the live 71.
  assert.equal(storedNumbersIntro(mistake, m), 'After Qe4 the engine gives you 88% to win; your game move Qe8 left 3%.');
  assert.equal(Math.round((answerViewerVerdict(mistake, m) as { win: number }).win), 88);
});

// ---------------------------------------------------------------- F2

test('F2: where the solver could play the same SAN, the lead and the first hint\'s head name his move with its piece and from-square', () => {
  const shared = sharedSan(), plain = quietPunish(null);
  assert.equal(playedLabel(shared), 'Rxb5 (the rook from b1)');
  assert.equal(san(shared.fen, 'b8b5'), 'Rxb5', 'the answer has the same SAN as his game move');
  // The lead: one bracket, with "highlighted".
  assert.equal(highlightedMove(shared, 'Rxb5'), 'Rxb5 (the rook from b1; highlighted)');
  assert.equal(punishLead(shared), 'In your game you played Rxb5 (the rook from b1; highlighted). Now play Black, your opponent’s side: find the move that makes it cost.');
  assert.equal(highlightedMove(plain, 'Nb3'), 'Nb3 (highlighted)');
  assert.equal(punishLead(plain), 'In your game you played Nb3 (highlighted). Now play Black, your opponent’s side: find the move that makes it cost.', 'no shared SAN: version 7\'s lead');
  // The hint input: `label` only with a shared SAN; `san` stays the bare SAN.
  assert.deepEqual(justPlayedAt(shared, 0), { uci: 'b1b5', san: 'Rxb5', byLearner: true, fenBefore: S_SRC, label: 'Rxb5 (the rook from b1)' });
  assert.deepEqual(justPlayedAt(plain, 0), { uci: 'd2b3', san: 'Nb3', byLearner: true, fenBefore: P_SRC }, 'no `label` key at all');
  // The ladder: only the head of rung 1 differs from the ladder built without the label.
  const ladder = hintLadderFor(shared, shared.fen, 0);
  const { label: _label, ...bare } = justPlayedAt(shared, 0)!;
  const v7 = buildHints({ fen: shared.fen, line: ['b8b5'], themes: shared.themes, kind: 'punish', ply: 0, justPlayed: bare });
  assert.equal(ladder[0].text, 'The move just played, Rxb5 (the rook from b1), was yours in the game. It put the white rook where a black rook can take it.');
  assert.equal(v7[0].text, 'The move just played, Rxb5, was yours in the game. It put the white rook where a black rook can take it.');
  assert.deepEqual(ladder.slice(1), v7.slice(1));
  assert.deepEqual({ ...ladder[0], text: '' }, { ...v7[0], text: '' });
  // A card without a shared SAN: the very ladder version 7 builds.
  assert.deepEqual(hintLadderFor(plain, plain.fen, 0), buildHints({ fen: plain.fen, line: ['e7e5', 'g2g3'], themes: plain.themes, kind: 'punish', ply: 0, justPlayed: justPlayedAt(plain, 0) }));
  // The lesson's first sentence (W2) and the reading list's fallback sentence use the same label.
  assert.ok(lessonFor(shared)!.startsWith('In your game you played Rxb5 (the rook from b1). That allowed Rxb5, which takes the rook on b5.'));
  assert.match(study, /`In your game you played \$\{playedLabel\(card\) \|\| played\}\.`/);
  assert.match(src, /punish \? punishLead\(active\)/);
});

// ---------------------------------------------------------------- F3

test('F3: a try viewer is titled "Why {try} doesn\'t work" only under 55%; from 55 it is "What could follow {try}"', () => {
  assert.equal(KEEPS_EDGE_FROM, 55);
  assert.deepEqual([failsBadly('worse', 54.4), failsBadly('worse', 54.5), failsBadly('worse', 60), failsBadly('losing', 20)], [true, false, false, true]);
  assert.deepEqual([failsBadly('strong', 40), failsBadly('close', 40), failsBadly('also-good', 40), failsBadly(null, 10)], [false, false, false, false]);
  const title = (tryWin: number, bestWin: number) => engineTryText({ trySan: 'h6', tryWin, bestWin, depth: 12 }, 'b').title;
  assert.equal(title(54.4, 90), 'Why h6 doesn\'t work');
  assert.equal(title(54.5, 90), 'What could follow h6', 'the printed figure is 55');
  assert.equal(title(64, 90), 'What could follow h6');
  assert.equal(title(13.7, 99.6), 'Why h6 doesn\'t work');
  assert.equal(title(50, 99.6), 'Why h6 doesn\'t work');
  assert.equal(title(96.4, 99.6), 'What could follow h6', 'a close try, as before');
  assert.equal(engineTryText({ trySan: 'h6', tryWin: 20, bestWin: 90, depth: 6 }, 'b').title, 'What could follow h6', 'an untrusted search, as before');
  // The intro is unchanged by F3.
  assert.equal(engineTryText({ trySan: 'h6', tryWin: 60, bestWin: 90, depth: 12 }, 'b').intro, 'After h6 the engine gives Black 60% to win; the best move keeps 90%.');
  // On the page: a punish miss that keeps 60 reads "small edge" by the board (W2) and "What could follow" over the line.
  const punish = quietPunish(null);
  const kept = gradeCardTry(punish, punish.fen, 'h7h6', 0, check({ tryUci: 'h7h6', trySan: 'h6', replyLine: ['g2g3'], tryWin: 60, bestWin: 90 }));
  assert.deepEqual([kept.grade.action, kept.grade.message, kept.text!.title], ['error', 'That keeps only a small edge. There is a clearly stronger move.', 'What could follow h6']);
  const lost = gradeCardTry(punish, punish.fen, 'h7h6', 0, check({ tryUci: 'h7h6', trySan: 'h6', replyLine: ['g2g3'], tryWin: 40, bestWin: 90 }));
  assert.deepEqual([lost.grade.action, lost.grade.message, lost.text!.title], ['error', 'That lets your opponent off the hook.', 'Why h6 doesn\'t work']);
  // The stored line of his game move on a mistake card follows the same rule.
  const stored = (winAfter: number) => storedTryText(quietMistake(null, { winAfter }), Q_FEN, 'e2e8', 0)!.title;
  assert.equal(stored(3), 'Why Qe8 doesn\'t work');
  assert.equal(stored(54.4), 'Why Qe8 doesn\'t work');
  assert.equal(stored(54.5), 'What could follow Qe8');
  assert.equal(stored(60), 'What could follow Qe8', 'his game move left him 60%: it was "doesn\'t work" in version 7');
  assert.equal(stored(86), 'What could follow Qe8', 'close to the best move, as before');
});

// ---------------------------------------------------------------- 4.8: spoilers and cost

test('4.8: P, L, V and both parts of C are built and rendered only in the Trainer\'s complete branches', () => {
  // The two components that carry them are rendered once each, inside `complete ? … : null`.
  assert.equal(count(src, '<SolvedNotes '), 1);
  assert.equal(count(src, '<SolvedViewers '), 1);
  const solvedAt = src.indexOf('solved: complete ? <>'), solvedEnd = src.indexOf('</> : null,', solvedAt);
  assert.ok(solvedAt > 0 && solvedEnd > solvedAt);
  assert.ok(src.indexOf('<SolvedNotes ') > solvedAt && src.indexOf('<SolvedNotes ') < solvedEnd, 'the notes are inside the complete branch');
  assert.match(src, /viewers: complete \? <SolvedViewers item=\{active\} sibling=\{sibling\} assisted=\{assisted\} onOpen=\{cancelAdvance\} latest=\{tryView\}\/> : null,/);
  // The lesson (L) is made once the card is complete.
  assert.match(src, /const lesson = useMemo\(\(\) => \(active && complete \? lessonFor\(active, sibling\) : null\), \[active, sibling, complete\]\);/);
  // Who calls what (comments left out). `threatSay` narrates: only the paragraph and the viewer read it here.
  const c = code(src);
  assert.equal(count(c, 'threatSay('), 2);
  assert.match(body('threatParagraph'), /threatSay\(item\)\?\.paragraph/);
  assert.match(body('threatViewerOf'), /threatSay\(item\)\?\.viewer/);
  // The after-card functions are called only by the after-card components.
  assert.equal(count(c, 'threatParagraph('), 2, 'its declaration and afterCardNotes');
  assert.equal(count(c, 'threatViewerOf('), 2, 'its declaration and SolvedViewers');
  assert.equal(count(c, 'gameMoveWords('), 2, 'its declaration and afterCardNotes');
  assert.equal(count(c, 'gameMoveViewer('), 2, 'its declaration and SolvedViewers');
  assert.equal(count(c, 'afterCardNotes('), 2, 'its declaration and SolvedNotes');
  assert.match(body('SolvedNotes'), /afterCardNotes\(item, siblingNotHeld\)/);
  assert.match(body('SolvedViewers'), /threatViewerOf\(item\)/);
  assert.match(body('SolvedViewers'), /gameMoveViewer\(item, latest, siblingNotHeld\)/);
  assert.equal(count(c, 'lessonFor('), 2, 'the complete-gated memo and the fallback inside SolvedNotes');
  assert.equal(count(c, 'lessonThreat('), 1, 'inside lessonFor');
  // The hint path reads the checked facts only (no narration), in one place.
  assert.equal(count(c, 'threatFacts('), 1);
  assert.equal(count(c, 'applyThreatHints('), 1);
  assert.ok(body('hintLadderFor').includes('threatFacts(item)'));
  // Nothing else in the page reads the entry: `.teach` appears in the hint gate, the two after-card readers and the pools input.
  assert.deepEqual([...c.matchAll(/[a-zA-Z.]*\.teach\b/g)].map(m => m[0]).sort(), ['item.teach', 'item.teach', 'item.teach', 'view.teach', 'view.teach']);
  assert.equal(count(code(study), '.teach'), 0);
  // The stylesheet block is appended and only lays out.
  const at = css.indexOf('/* ---- Part 13: version 7.1');
  assert.ok(at > css.indexOf('/* ---- Part 12: M3 fix round 3 (FX2e'), 'Part 13 after Part 12');
  const rules = css.slice(css.indexOf('*/', at) + 2).trim().split('\n');
  assert.deepEqual(rules, ['.teach-more{display:grid;margin:8px 0}', '.study-item .almost-line{margin:6px 0 10px}']);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgb|var\(|,/.test(rules.join('')), 'no colour, no token, no comma selector');
});

test('4.8: while he solves, a card with a document entry shows nothing but H1 and H2 that the same card without one does not', () => {
  for (const [name, withTeach, without, sib] of [
    ['mistake', quietMistake(), quietMistake(null), undefined],
    ['mistake, pinned target', pinMistake(), pinMistake(null), undefined],
    ['punish', quietPunish(), quietPunish(null), punishSibling()],
  ] as const) {
    const answer = withTeach.moves[0];
    const tries = new Chess(withTeach.fen).moves({ verbose: true }).map(m => m.lan).filter(u => u !== answer).slice(0, 6);
    const played = withTeach.pack?.playedUci as string;
    if (!isPunish(withTeach) && !tries.includes(played)) tries.push(played);
    const checks: Array<(uci: string) => TryCheck | null> = [
      () => null,
      uci => check({ tryUci: uci, trySan: san(withTeach.fen, uci), replyLine: [], tryWin: 30, bestWin: 90 }),
      uci => check({ tryUci: uci, trySan: san(withTeach.fen, uci), replyLine: [], tryWin: 60, bestWin: 90 }),
      uci => check({ tryUci: uci, trySan: san(withTeach.fen, uci), replyLine: [], tryWin: 88, bestWin: 90 }),
    ];
    /** Everything the page renders for a card that is not complete, with `shown` hints open and `uci` tried. */
    const solving = (item: TrainerItem, shown: number, uci: string | null, c: TryCheck | null) => {
      const ladder = shown > 0 ? hintLadderFor(item, item.fen, 0) : null;
      const graded = uci ? gradeCardTry(item, item.fen, uci, 0, c) : null;
      const view = uci && graded ? tryViewOf(tryKey(item.id, 0, uci), item.fen, uci, answerMovesFrom(item, item.fen, 0), graded) : null;
      return renderToStaticMarkup(<>
        <p className="lead">{isPunish(item) ? punishLead(item) : 'Before moving, ask what changed and what your opponent is threatening.'}</p>
        <div className="feedback">{graded?.grade.message ?? ''}</div>
        {ladder && <HintLadder hints={ladder} shown={shown}/>}
        <TrySlot view={view} solving/>
        <span>{view ? solvingTryLine(view).join(' ') : ''}</span>
      </>);
    };
    // With no hint asked for: identical markup, whatever he tries.
    assert.equal(solving(withTeach, 0, null, null), solving(without, 0, null, null), name);
    for (const uci of tries) for (const make of checks) assert.equal(solving(withTeach, 0, uci, make(uci)), solving(without, 0, uci, make(uci)), `${name} ${uci}`);
    // With hints: the markup differs only in the first two hint boxes; boxes 3 and 4 are identical.
    for (const shown of [1, 2, 3, 4]) {
      const a = solving(withTeach, shown, tries[0], null), b = solving(without, shown, tries[0], null);
      const boxes = (html: string) => texts(html, 'li');
      assert.deepEqual(boxes(a).slice(2), boxes(b).slice(2), `${name}: rungs 3 and 4`);
      assert.notEqual(boxes(a)[0], boxes(b)[0], `${name}: rung 1 is H1`);
      const strip = (html: string) => html.replace(/<ol class="hint-ladder".*?<\/ol>/, '');
      assert.equal(strip(a), strip(b), `${name}: nothing outside the hint ladder differs (${shown} shown)`);
    }
    // None of the after-card texts is in anything shown while he solves, with every hint open.
    const say = threatSay(withTeach)!;
    const shownAll = [solving(withTeach, 4, tries[0], null), ...tries.map(u => solving(withTeach, 4, u, checks[1](u)))].join('\n');
    const afterCard = [say.paragraph, say.clause.full, say.clause.short, say.viewer.title, say.viewer.toggle, say.viewer.intro, 'made no move in reply',
      ...(isPunish(withTeach) ? [] : [gameMoveWords(withTeach)!, gameMoveViewer(withTeach)!.title, gameMoveViewer(withTeach)!.toggle, 'allowed'])];
    for (const text of afterCard) assert.ok(text && !shownAll.includes(esc(text)), `${name}: "${text}" is not shown while he solves`);
    // The coach's explain input is built at a wrong try, before the card is complete, and its lesson carries the threat
    // on a punish card (4.7). Nothing of it is printed before the reveal: the panel's own text is the same with and
    // without the entry, and the input differs in `lesson` alone.
    const wrong = { fen: withTeach.fen, uci: tries[0], index: 0 };
    const withInput = explainInput(withTeach, wrong, 'pack', { sibling: sib })!, plainInput = explainInput(without, wrong, 'pack', { sibling: sib })!;
    assert.deepEqual(staticExplanation(withInput), staticExplanation(plainInput), name);
    const differing = Object.keys(withInput).filter(k => JSON.stringify((withInput as never)[k]) !== JSON.stringify((plainInput as never)[k]));
    assert.deepEqual(differing, isPunish(withTeach) ? ['lesson'] : [], `${name}: the explain input`);
    assert.ok(!JSON.stringify(staticExplanation(withInput)).includes('threatens'), name);
  }
  // The explain button reveals the card before the request goes out, so that lesson is never read on an unfinished card.
  assert.match(src, /onAsk=\{\(\) => \{ cancelAdvance\(\); coached\.current = true; if \(!complete\) reveal\(\); \}\}/);
});
