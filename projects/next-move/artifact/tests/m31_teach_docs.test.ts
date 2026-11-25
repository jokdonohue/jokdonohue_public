import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  buildTeachDocs, canonicalJson, MARGIN_CP, MAX_HELD, MAX_LOST_SHARE, MIN_DEPTH, rowScore, statedNet, STRONG_MARGIN_CP, TEACH_BUILDER_MARK,
  teachVersionOf, threatEntry, threatGates, type GateResult, type PassRow,
} from '../src/importers/teachDocs';
import { lineWin, UNIQUE_GAP } from '../src/importers/packDocs';
import { docBytes, MAX_DOC_BYTES } from '../src/contract/docs';
import { readTeachMeta, TEACH_MAX_BYTES, TEACH_META_PATH, type TeachMetaDoc } from '../src/contract/teachDocs';
import { loadTeach, type LoadedPack } from '../components/model';
import { buildPools, isPunish } from '../components/pools';
import { hintLadderFor } from '../components/Trainer';
import { lineNarration } from '../components/LineViewer';
import { almostAsHighly, applyThreatHints, passFen, QUIET_BARE, targetReason, threatFacts, threatSay } from '../src/teach/threat';
import { ARTIFACT_DIR } from './b3_paths';

// Version 7.1 (brief m31, sections 3.3 to 3.6): the builder of `teach/meta` and its command line.
// Every position, id and row below is invented for these tests (a few pieces, round move numbers, engine scores
// written by hand); none comes from a game or from an engine run.

// ---------------------------------------------------------------- invented positions

type Pos = { fen: string; a: string; t: string[] };
/** White's rook goes to d5 and then takes the loose knight on a5. */
const A: Pos = { fen: '6k1/5pp1/7p/n7/8/8/5PPP/3R2K1 w - - 0 1', a: 'd1d5', t: ['d5a5'] };
/** White's knight goes to d5; from there Ne7+ forks the king and the queen on c8. */
const B: Pos = { fen: '2q3k1/2p2pp1/7p/8/8/2N5/5PPP/6K1 w - - 0 1', a: 'c3d5', t: ['d5e7', 'g8h7', 'e7c8'] };
/** The knight already stands on d5, so the check is legal on the card: the answer only "prepares" it. */
const B_PRE: Pos = { fen: '2q3k1/2p2pp1/7p/3N4/8/8/5PPP/6K1 w - - 0 1', a: 'g2g3', t: ['d5e7', 'g8h7', 'e7c8'] };
/** The queen goes to e4; with the bishop behind it, Qxh7 is then mate. */
const C: Pos = { fen: '5rk1/5ppp/1n6/8/8/3B4/4QPPP/6K1 w - - 0 1', a: 'e2e4', t: ['e4h7'] };
/** A pawn steps to b7 and can then promote. D_PRE: it already stands on b7. */
const D: Pos = { fen: '8/8/1P4k1/8/8/8/6K1/n7 w - - 0 1', a: 'b6b7', t: ['b7b8q'] };
const D_PRE: Pos = { fen: '8/1P6/6k1/8/8/8/6K1/n7 w - - 0 1', a: 'g2f3', t: ['b7b8q'] };
/** The pawn promotes, the rook on a8 takes the new queen, and White's rook takes back. */
const DR: Pos = { fen: 'r7/8/1P4k1/8/8/8/6K1/1R6 w - - 0 1', a: 'b6b7', t: ['b7b8q', 'a8b8', 'b1b8'] };
/** The knight on e5 is pinned to its king by the rook on e1 and attacked by the pawn on f4. */
const E: Pos = { fen: '4k3/6pp/3p4/4n3/5P2/8/6PP/4R1K1 w - - 0 1', a: 'h2h3', t: ['f4e5', 'd6e5', 'e1e5'] };
/** The same with the rook on d1: the answer Re1 itself makes the pin. */
const F: Pos = { fen: '4k3/6pp/3p4/4n3/5P2/8/6PP/3R2K1 w - - 0 1', a: 'd1e1', t: ['f4e5', 'd6e5', 'e1e5'] };
/** Black to move: the rook goes to d4 and then takes the loose knight on a4. */
const G: Pos = { fen: '3r2k1/5ppp/8/8/N7/7P/5PP1/6K1 b - - 3 30', a: 'd8d4', t: ['d4a4'] };
/** Rxd7 wins the queen, but the knight forks king and rook: the line is settled only after four plies, a rook down. */
const H: Pos = { fen: '6k1/3q1ppp/8/8/5n2/8/5PPP/2RR2K1 w - - 0 1', a: 'h2h3', t: ['d1d7', 'f4e2', 'g1f1', 'e2c1'] };
/** A quiet move first, then mate in two: the threat is "mate", although its first move is quiet. */
const M2: Pos = { fen: '7k/p5pp/8/8/8/1n6/5PPP/4R1K1 w - - 0 1', a: 'g2g3', t: ['h2h4', 'a7a6', 'e1e8'] };
/** The pawn promotes with check and nothing is captured: a check with no piece to point at. */
const QCHK: Pos = { fen: '6k1/1P6/8/8/8/8/6K1/n7 w - - 0 1', a: 'g2f3', t: ['b7b8q'] };
/** The side that passes has only its king (or only pawns): no ground for "if you made no move". */
const BARE: Pos = { fen: '8/8/1P4k1/8/8/8/6K1/8 w - - 0 1', a: 'b6b7', t: ['b7b8q'] };
const PAWNS_ONLY: Pos = { fen: '8/8/1P4k1/7p/8/8/6K1/8 w - - 0 1', a: 'b6b7', t: ['b7b8q'] };
/** The knight takes the queen and can be taken back by the rook: not settled until the rook has taken. */
const UNSETTLED: Pos = { fen: 'r1q3k1/2p2pp1/7p/8/8/2N4P/5PP1/6K1 w - - 0 1', a: 'c3d5', t: ['d5e7', 'g8h7', 'e7c8'] };
/** Rook takes rook, rook takes back: nothing is won. */
const EVEN: Pos = { fen: '3rr1k1/5pp1/7p/8/8/8/5PPP/3R2K1 w - - 0 1', a: 'h2h3', t: ['d1d8', 'e8d8'] };
/** The rook goes to d5 and then takes a pawn on a5 (the knight on b8 only gives the passing side a piece). */
const PAWN: Pos = { fen: '1n4k1/5pp1/7p/p7/8/8/5PPP/3R2K1 w - - 0 1', a: 'd1d5', t: ['d5a5'] };

// The same positions as "punish it" cards: the position after an invented game move, the other side to move.
const C_P: Pos = { ...C, fen: '5rk1/5ppp/1n6/8/8/3B4/4QPPP/6K1 w - - 1 2' };
const A_P: Pos = { ...A, fen: '6k1/5pp1/7p/n7/8/8/5PPP/3R2K1 w - - 1 2' };
const B_P: Pos = { ...B, fen: '2q3k1/2p2pp1/7p/8/8/2N5/5PPP/6K1 w - - 0 2' };
/** A punish position whose answer is a capture (so no threat is looked for), with another legal capture. */
const TAKE = { fen: '4k3/6pp/3p4/4n3/5P2/8/6PP/4R1K1 w - - 1 2', a: 'f4e5', alt: 'e1e5' };
/** A punish position with one legal move. */
const ONLY = { fen: '6k1/8/8/8/8/8/6PP/5rK1 w - - 1 2', a: 'g1f1' };

// ---------------------------------------------------------------- cards, rows, packs

const PACK_V = 'p-test';
const AT = Date.UTC(2026, 10, 14, 6, 30);
type Card = { id: string; fen: string; moves: string[]; rating: number; themes: string[]; kind?: string; pack?: Record<string, unknown> };
const mistake = (id: string, pos: { fen: string; a: string }, detail: Record<string, unknown> = {}): Card => ({ id, fen: pos.fen, moves: [pos.a], rating: 1200, themes: ['quiet'], pack: detail });
/** A punish card whose solver Win% after the game move is `solverWin` (65 or more: graded; 50 to 64: small edge; under 50: not shown). */
const punishCard = (id: string, pos: { fen: string; a: string }, solverWin: number, detail: Record<string, unknown> = {}): Card =>
  ({ id, fen: pos.fen, moves: [pos.a], rating: 1200, themes: ['punish'], kind: 'punish', pack: { winAfter: 100 - solverWin, ...detail } });
const packOf = (cards: Card[], punish: Card[] = [], version = PACK_V): LoadedPack => ({ version, meta: {} as never, cards: cards as never, punish: punish as never, study: [], punishStudy: [] });

const base = (kind: string, id: string, a: string, depth: number): PassRow => ({ v: 1, id, kind, pack: PACK_V, engine: 'test', depthAsked: depth, depthReached: depth, ms: 1, nodes: 1, ans: a });
/** The search of the position after the answer; the score is from the solver's view. */
const afterRow = (id: string, a: string, depth = 18, cp = 100, x: Partial<PassRow> = {}): PassRow => ({ ...base('after', id, a, depth), line: [], cp, mate: null, ...x });
/** The search of the pass position. */
const threatRow = (id: string, a: string, line: string[], depth = 18, cp = 400, x: Partial<PassRow> = {}): PassRow => ({ ...base('threat', id, a, depth), line, cp, mate: null, ...x });
type PairOpt = { line?: string[]; margin?: number; mate?: number; after?: Partial<PassRow>; threat?: Partial<PassRow> };
/** Both rows of a card at one depth: the after row at +100, the threat row `margin` (300) above it or a forced mate. */
const pair = (id: string, pos: Pos, depth: number, o: PairOpt = {}): PassRow[] => [
  afterRow(id, pos.a, depth, 100, o.after),
  threatRow(id, pos.a, o.line ?? pos.t, depth, 100 + (o.margin ?? 300), { ...(o.mate ? { cp: null, mate: o.mate } : {}), ...o.threat }),
];
const round2 = (x: number) => Math.round(x * 100) / 100;
/** The MultiPV row of a punish card: the top moves, best first, with the rank and gap fields the driver writes. */
const uniqRow = (id: string, a: string, top: Array<{ uci: string; cp?: number | null; mate?: number | null }>, x: Partial<PassRow> = {}): PassRow => {
  const rank = top.findIndex(t => t.uci === a);
  const gap = top.length >= 2 ? round2(lineWin(top[0]) - lineWin(top[1])) : null;
  return { ...base('uniq', id, a, 18), multipv: 3, legal: 20, top: top.map(t => ({ cp: null, mate: null, ...t })), ansRank: rank < 0 ? null : rank + 1, gap, gapApp: gap, gapRule: gap, ...x };
};
const UNIQUE = (a: string, other2: string) => [{ uci: a, cp: 500 }, { uci: other2, cp: 50 }];

type Scenario = { pack: LoadedPack; rows18: PassRow[]; rows22: PassRow[] };
const run = (s: Scenario, at = AT) => buildTeachDocs({ rows18: s.rows18, rows22: s.rows22, pack: s.pack, at });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sum = (b: { summary: unknown }) => b.summary as Record<string, any>;

/**
 * The main scenario: 25 mistake cards, 3 graded punish cards, 1 small-edge card and 1 card that is not shown.
 * 16 threats are stored; every other quiet card has exactly one reason.
 */
function mainScenario(): Scenario {
  const mistakes: Card[] = [], punish: Card[] = [], rows18: PassRow[] = [], rows22: PassRow[] = [];
  /** A mistake card. Depth 22 repeats depth 18 unless `d22` is given; `d22: null` writes no depth-22 rows. */
  const add = (id: string, pos: Pos, o: { detail?: Record<string, unknown>; d18?: PairOpt; d22?: PairOpt | null } = {}) => {
    mistakes.push(mistake(id, pos, o.detail));
    rows18.push(...pair(id, pos, 18, o.d18));
    if (o.d22 !== null) rows22.push(...pair(id, pos, 22, o.d22 ?? o.d18));
  };
  // Stored: every kind, pre true and false, with and without a target, both reasons.
  add('pack-cap', A);
  add('pack-chk', B, { d18: { margin: 200 }, d22: { margin: 200, line: ['d5e7', 'g8f8', 'e7c8'] } });   // another line at depth 22
  add('pack-chkpre', B_PRE);
  add('pack-mate', C, { d18: { mate: 1 } });
  add('pack-promo', D);
  add('pack-promopre', D_PRE);
  add('pack-promosq', DR);
  add('pack-pin', E);
  add('pack-pinmade', F);
  add('pack-prefix', H);
  add('pack-mate2', M2, { d18: { mate: 2 } });
  add('pack-chknosq', QCHK);
  // No threat, decided at depth 18.
  mistakes.push(mistake('pack-noisy', { fen: E.fen, a: 'f4e5' }));                                        // a capture: not a quiet answer
  rows18.push(afterRow('pack-noisy', 'f4e5'));
  add('pack-skip', A, { d18: { threat: { skipped: 'no-search', line: [] } }, d22: null });
  add('pack-mateanyway', A, { d18: { after: { cp: null, mate: 3 } }, d22: null });
  add('pack-shallow', A, { d18: { threat: { depthReached: 15 } }, d22: null });
  add('pack-t1', BARE);
  add('pack-t2', A, { d18: { line: ['h2h3', 'g8h7', 'd5a5'] }, d22: {} });                                // depth 22 alone would pass
  add('pack-t3', UNSETTLED);
  add('pack-t4', A, { d18: { margin: 99 }, d22: null });
  add('pack-t5', A, { detail: { pvUci: ['d1d5', 'g8h7', 'd5a5'] } });                                     // the stored line wins the knight already
  add('pack-replay', A, { d18: { line: ['d5a5', 'g8g1'] } });
  // Passes at depth 18, decided at depth 22.
  add('pack-lost-t4', A, { d18: { margin: 120 }, d22: { margin: 60 } });
  add('pack-lost-t3', B, { d22: { line: ['d5e7', 'g8h7'] } });
  add('pack-capped22', A, { d22: { threat: { capped: true } } });
  // Punish cards: graded and unique; graded but not unique; graded but not the engine's first; small edge; not shown.
  const both = (id: string, pos: Pos, o: PairOpt = {}) => { rows18.push(...pair(id, pos, 18, o)); rows22.push(...pair(id, pos, 22, o)); };
  punish.push(punishCard('punish-mate', C_P, 80, { sourceFen: '5rk1/3n1ppp/8/8/8/3B4/4QPPP/6K1 b - - 0 1', playedUci: 'd7b6', playedSan: 'Nb6' }));
  both('punish-mate', C_P, { mate: 1 });
  rows18.push(uniqRow('punish-mate', C_P.a, UNIQUE(C_P.a, 'e2e3')));
  punish.push(punishCard('punish-nu', G, 75, { sourceFen: '3r2k1/5ppp/8/8/8/2N4P/5PP1/6K1 w - - 2 30', playedUci: 'c3a4', playedSan: 'Na4' }));
  both('punish-nu', G);
  rows18.push(uniqRow('punish-nu', G.a, [{ uci: 'd8d4', cp: 300 }, { uci: 'd8a8', cp: 280 }, { uci: 'g8f8', cp: 0 }]));
  punish.push(punishCard('punish-nh', A_P, 70, { sourceFen: '6k1/5pp1/2n4p/8/8/8/5PPP/3R2K1 b - - 0 1', playedUci: 'c6a5', playedSan: 'Na5' }));
  both('punish-nh', A_P);
  rows18.push(uniqRow('punish-nh', A_P.a, [{ uci: 'd1d8', cp: 400 }, { uci: 'd1d5', cp: 100 }]));
  punish.push(punishCard('punish-se', B_P, 60, { sourceFen: '2q3k1/2p2ppp/8/8/8/2N5/5PPP/6K1 b - - 0 1', playedUci: 'h7h6', playedSan: 'h6' }));
  both('punish-se', B_P);
  rows18.push(uniqRow('punish-se', B_P.a, [{ uci: 'c3d5', cp: 60 }, { uci: 'c3e4', cp: 50 }]));
  punish.push(punishCard('punish-mw', A_P, 40));
  rows18.push(afterRow('punish-mw', A_P.a), uniqRow('punish-mw', A_P.a, UNIQUE(A_P.a, 'd1d8')));         // rows for a card that is not shown
  return { pack: packOf(mistakes, punish), rows18, rows22 };
}
const STORED = ['pack-cap', 'pack-chk', 'pack-chknosq', 'pack-chkpre', 'pack-mate', 'pack-mate2', 'pack-pin', 'pack-pinmade', 'pack-prefix', 'pack-promo', 'pack-promopre', 'pack-promosq', 'punish-mate', 'punish-nh', 'punish-nu', 'punish-se'];

// ---------------------------------------------------------------- the frozen rule, gate by gate

const GATE_NAMES = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5'] as const;
const failed = (g: GateResult) => GATE_NAMES.filter(k => !g[k]).join(' ');
/** The gates on one position with hand-written rows: the after row at +100, the threat row at +400. */
const gates = (pos: { fen: string; a: string }, line: string[], o: { after?: Partial<PassRow>; threat?: Partial<PassRow>; pv?: string[] } = {}) =>
  threatGates({ fen: pos.fen, moves: [pos.a], ...(o.pv ? { pack: { pvUci: o.pv } } : {}) }, afterRow('x', pos.a, 18, 100, o.after), threatRow('x', pos.a, line, 18, 400, o.threat));

test('gates: the constants of the frozen rule', () => {
  assert.deepEqual([MIN_DEPTH, MARGIN_CP, STRONG_MARGIN_CP, MAX_LOST_SHARE, MAX_HELD, UNIQUE_GAP], [16, 100, 150, 0.03, 110, 10]);
});

test('gates: a quiet answer with a threat passes T0 to T5', () => {
  for (const pos of [A, B, B_PRE, C, D, D_PRE, DR, E, F, G, H, M2, QCHK, PAWN]) {
    const g = gates(pos, pos.t);
    assert.equal(failed(g), '', pos.fen);
    assert.deepEqual([g.pass, g.fail, g.replays, g.t0], [true, null, true, undefined], pos.fen);
  }
  const g = gates(A, A.t);
  assert.deepEqual(
    { margin: g.margin, mateThreat: g.mateThreat, plies: g.plies, shownPlies: g.shownPlies, netT: g.netT, netShown: g.netShown, netL: g.netL, shown: g.shown, shownMate: g.shownMate },
    { margin: 300, mateThreat: false, plies: 1, shownPlies: 1, netT: 3, netShown: 3, netL: 0, shown: ['d5a5'], shownMate: false },
  );
});

test('gates T0: the answer is quiet, both rows are there, deep enough and not capped, and the answer is no forced mate', () => {
  const after = afterRow('x', A.a), threat = threatRow('x', A.a, A.t);
  const card = (pos: { fen: string; a: string }) => ({ fen: pos.fen, moves: [pos.a] });
  const cases: Array<[string, GateResult, string]> = [
    ['the answer captures', threatGates(card({ fen: E.fen, a: 'f4e5' }), after, threat), 'not-quiet'],
    ['the answer gives check', threatGates(card({ fen: A.fen, a: 'd1d8' }), after, threat), 'not-quiet'],
    ['the answer promotes', threatGates(card({ fen: D_PRE.fen, a: 'b7b8q' }), after, threat), 'not-quiet'],
    ['the answer is not legal', threatGates(card({ fen: A.fen, a: 'a1a2' }), after, threat), 'not-quiet'],
    ['no answer', threatGates({ fen: A.fen, moves: [] }, after, threat), 'not-quiet'],
    ['no threat row', threatGates(card(A), after, undefined), 'no-threat-row'],
    ['the threat row was skipped', threatGates(card(A), after, { ...threat, skipped: 'no-search' }), 'skipped'],
    ['no after row', threatGates(card(A), undefined, threat), 'no-after-row'],
    ['the after row was skipped', threatGates(card(A), { ...after, skipped: 'no-search' }, threat), 'after-skipped'],
    ['the threat row is capped', threatGates(card(A), after, { ...threat, capped: true }), 'capped'],
    ['the after row is capped', threatGates(card(A), { ...after, capped: true }, threat), 'capped'],
    ['the threat row reached depth 15', threatGates(card(A), after, { ...threat, depthReached: 15 }), 'shallow'],
    ['the after row reached depth 15', threatGates(card(A), { ...after, depthReached: 15 }, threat), 'shallow'],
    ['a row has no depth', threatGates(card(A), after, { ...threat, depthReached: undefined }), 'shallow'],
    ['the answer is a forced mate', threatGates(card(A), { ...after, cp: null, mate: 3 }, threat), 'mate-anyway'],
    ['the answer mates', threatGates(card(A), { ...after, cp: null, mate: null, terminal: 'checkmate' }, threat), 'mate-anyway'],
  ];
  for (const [name, g, code] of cases) assert.deepEqual([g.T0, g.pass, g.fail, g.t0], [false, false, 'T0', code], name);
  // Depth 16 is enough. A forced mate AGAINST the solver after the answer is not T0's business.
  assert.equal(gates(A, A.t, { after: { depthReached: 16 }, threat: { depthReached: 16 } }).pass, true);
  const lost = gates(A, A.t, { after: { cp: null, mate: -4 } });
  assert.deepEqual([lost.T0, lost.margin, lost.pass], [true, 1400, true]);
});

test('gates T1: the side that passes has a knight, bishop, rook or queen', () => {
  for (const pos of [BARE, PAWNS_ONLY]) {
    const g = gates(pos, pos.t);
    assert.deepEqual([failed(g), g.fail], ['T1', 'T1'], pos.fen);
  }
  // The solver's own pieces do not count: a white rook, a bare black king.
  assert.equal(gates({ fen: '8/8/1P4k1/8/8/8/6K1/R7 w - - 0 1', a: 'b6b7' }, ['b7b8q']).T1, false);
  for (const piece of ['n', 'b', 'r', 'q']) assert.equal(gates({ fen: `8/8/1P4k1/8/8/8/6K1/${piece}7 w - - 0 1`, a: 'g2f3' }, ['b6b7']).T1, true, piece);
});

test('gates T2: the threat starts with a capture, a check or a promotion, or the shown line is mate', () => {
  const quietFirst = gates(A, ['h2h3', 'g8h7', 'd5a5']);
  assert.deepEqual([failed(quietFirst), quietFirst.fail, quietFirst.netShown], ['T2', 'T2', 3], 'a settled gain behind a quiet first move is not a threat');
  assert.equal(gates(A, A.t).T2, true, 'capture');
  assert.equal(gates(B, B.t).T2, true, 'check');
  assert.equal(gates(D, D.t).T2, true, 'promotion');
  const mate = gates(M2, M2.t);
  assert.deepEqual([mate.T2, mate.shownMate, mate.shown], [true, true, M2.t], 'a quiet first move passes when the shown line is mate');
});

test('gates T3: the whole line is mate or settled with a gain, and the shown line is its first such prefix', () => {
  const open = gates(UNSETTLED, UNSETTLED.t);
  assert.deepEqual([failed(open), open.fail, open.shown, open.netShown], ['T3 T5', 'T3', null, null], 'the rook can still take back');
  const closed = gates(UNSETTLED, [...UNSETTLED.t, 'a8c8']);
  assert.deepEqual([closed.pass, closed.netT, closed.netShown, closed.shownPlies], [true, 6, 6, 4], 'settled once the rook has taken back');
  const even = gates(EVEN, EVEN.t);
  assert.deepEqual([failed(even), even.netT, even.shown], ['T3 T5', 0, null], 'an even trade wins nothing');
  // The first settled prefix is shown, not the whole line.
  const long = gates(A, ['d5a5', 'g8h7', 'a5a7']);
  assert.deepEqual([long.pass, long.plies, long.shown], [true, 3, ['d5a5']]);
  // A prefix that looks better than the whole line ends is not shown: after Rxd7 the fork wins the rook back.
  const fork = gates(H, H.t);
  assert.deepEqual([fork.pass, fork.netT, fork.netShown, fork.shown], [true, 4, 4, H.t]);
  // Mate: the line up to the mate.
  const mate = gates(C, C.t);
  assert.deepEqual([mate.pass, mate.shownMate, mate.shown], [true, true, ['e4h7']]);
  // At most 8 plies of the row's line are read.
  const nine = gates(A, ['d5a5', 'g8h7', 'a5a7', 'h7g8', 'a7a8', 'g8h7', 'a8a7', 'h7g8', 'a7a8', 'g8h7']);
  assert.deepEqual([nine.plies, nine.replays, nine.shown], [8, true, ['d5a5']]);
});

test('gates T4: a forced mate for the solver, or 100 centipawns more than the answer keeps', () => {
  const at = (margin: number) => gates(A, A.t, { threat: { cp: 100 + margin } });
  assert.deepEqual([failed(at(99)), at(99).fail, at(99).margin], ['T4', 'T4', 99]);
  assert.deepEqual([at(100).pass, at(100).margin], [true, 100]);
  // A mate threat passes whatever the answer keeps; a high score alone does not ("900 or more" is no rule).
  const mate = gates(C, C.t, { after: { cp: 950 }, threat: { cp: null, mate: 1 } });
  assert.deepEqual([mate.T4, mate.mateThreat, mate.margin], [true, true, 50]);
  const high = gates(A, A.t, { after: { cp: 900 }, threat: { cp: 950 } });
  assert.deepEqual([high.T4, high.margin], [false, 50]);
  // A mate against the solver in the pass position, rows of two runs, and a row without a score all fail.
  assert.equal(gates(A, A.t, { threat: { cp: null, mate: -3 } }).T4, false);
  assert.equal(gates(A, A.t, { threat: { depthAsked: 22, depthReached: 22 } }).T4, false, 'both rows come from one run');
  const blank = gates(A, A.t, { threat: { cp: null } });
  assert.deepEqual([blank.T4, blank.margin], [false, null]);
});

test('gates T5: the shown line wins at least a pawn more than the stored line, or is mate', () => {
  const same = gates(A, A.t, { pv: ['d1d5', 'g8h7', 'd5a5'] });
  assert.deepEqual([failed(same), same.fail, same.netShown, same.netL], ['T5', 'T5', 3, 3], 'the stored line wins the knight already');
  const more = gates(A, A.t, { pv: ['d1d5', 'h6h5', 'd5h5'] });
  assert.deepEqual([more.pass, more.netShown, more.netL], [true, 3, 1]);
  // One pawn more is enough; the same pawn count is not.
  const pawn = gates(PAWN, PAWN.t);
  assert.deepEqual([pawn.pass, pawn.netShown, pawn.netL], [true, 1, 0]);
  const level = gates(PAWN, PAWN.t, { pv: ['d1d5', 'h6h5', 'd5h5'] });
  assert.deepEqual([failed(level), level.netShown, level.netL], ['T5', 1, 1]);
  // Mate passes whatever the stored line wins.
  const mate = gates(C, C.t, { pv: ['e2e4', 'b6d5', 'e4d5'] });
  assert.deepEqual([mate.T5, mate.shownMate, mate.netL], [true, true, 3]);
  // A stored line that does not start with the card's move is not the card's line: the card's own moves count.
  assert.equal(gates(A, A.t, { pv: ['d1d4', 'g8h7', 'd4a4'] }).netL, 0);
});

test('gates: a line that is not legal from the pass position is no threat', () => {
  const g = gates(A, ['d5a5', 'g8g1']);
  assert.deepEqual([g.pass, g.fail, g.replays, g.shown], [false, 'replay', false, null]);
  const empty = gates(A, []);
  assert.deepEqual([empty.pass, empty.fail, empty.plies], [false, 'replay', 0]);
  // The line is read from the PASS position: a move of the card position that the answer made impossible fails.
  assert.equal(gates(A, ['d1a1']).fail, 'replay');
});

test('rowScore: centipawns from the solver\'s view, a forced mate as +1000 or -1000', () => {
  const r = (x: Partial<PassRow>): PassRow => ({ id: 'x', kind: 'after', ...x });
  assert.equal(rowScore(r({ cp: 37, mate: null })), 37);
  assert.equal(rowScore(r({ cp: -250, mate: null })), -250);
  assert.equal(rowScore(r({ cp: null, mate: 5 })), 1000);
  assert.equal(rowScore(r({ cp: null, mate: -1 })), -1000);
  assert.equal(rowScore(r({ cp: 20, mate: 2 })), 1000, 'a mate wins over a score');
  assert.equal(rowScore(r({ terminal: 'checkmate' })), 1000);
  assert.equal(rowScore(r({ cp: null, mate: null })), null);
  assert.equal(rowScore(undefined), null);
});

// ---------------------------------------------------------------- the stored facts (3.4)

test('threatEntry: kind, target square, reason and "already legal" for every case', () => {
  const entry = (pos: Pos, shown = pos.t) => threatEntry({ id: 'card', fen: pos.fen, moves: [pos.a] }, shown);
  const want = (pos: Pos, k: string, pre: boolean, extra: Record<string, string> = {}, shown = pos.t) => ({ id: 'card', a: pos.a, t: shown, k, ...extra, pre });
  // capture: the piece taken, loose on the card.
  assert.deepEqual(entry(A), want(A, 'capture', false, { sq: 'a5', r: 'undefended' }));
  assert.deepEqual(entry(G), want(G, 'capture', false, { sq: 'a4', r: 'undefended' }), 'Black to move');
  // check: the queen the fork wins; pre when the knight already stands on d5.
  assert.deepEqual(entry(B), want(B, 'check', false, { sq: 'c8', r: 'undefended' }));
  assert.deepEqual(entry(B_PRE), want(B_PRE, 'check', true, { sq: 'c8', r: 'undefended' }));
  // The queen is defended by the rook that takes back: the target is still the queen, with no reason.
  assert.deepEqual(entry(UNSETTLED, [...UNSETTLED.t, 'a8c8']), want(UNSETTLED, 'check', false, { sq: 'c8' }, [...UNSETTLED.t, 'a8c8']));
  // mate: no square; pre when the first move of the line is already legal.
  assert.deepEqual(entry(C), want(C, 'mate', false));
  assert.deepEqual(entry(M2), want(M2, 'mate', true));
  // promotion: no piece is won; with the rook that takes the new queen and is taken back, that rook.
  assert.deepEqual(entry(D), want(D, 'promotion', false));
  assert.deepEqual(entry(D_PRE), want(D_PRE, 'promotion', true));
  assert.deepEqual(entry(DR), want(DR, 'promotion', false, { sq: 'a8', r: 'undefended' }));
  // A check that wins no piece (a promotion with check): no square to point at.
  assert.deepEqual(entry(QCHK), want(QCHK, 'check', true));
  // pinned ON THE CARD: the reason and the king's square.
  assert.deepEqual(entry(E), want(E, 'capture', true, { sq: 'e5', r: 'pinned', pin: 'e8' }));
  // A pin the answer itself makes is not true of the card: the square stays, the reason goes (a pawn defends it).
  assert.deepEqual(entry(F), want(F, 'capture', true, { sq: 'e5' }));
  // The most valuable piece won net: the queen, although the rook is lost for it.
  assert.deepEqual(entry(H), want(H, 'capture', true, { sq: 'd7', r: 'undefended' }));
  // A line the page cannot read gives no entry.
  assert.equal(entry(A, ['d5a5', 'g8g1']), null);
  assert.equal(entry(A, []), null);
  assert.equal(threatEntry({ id: 'card', fen: E.fen, moves: ['f4e5'] }, ['e1e5']), null, 'the answer is not quiet');
});

// ---------------------------------------------------------------- the reason: the same on the card and after the answer

// Brief m31, section 10 (17:14), finding F-1. The page states a stored reason twice: in a hint, on the card, and in
// the paragraph after the card, where the answer has been played. So the builder stores `r` (and `pin`) only when
// the page's `targetReason` reads the SAME reason on the card position and on the pass position; otherwise both are
// left out and `sq` stays. The six positions below are invented for these tests, as every position in this file is:
// legal, both kings on the board, a few pieces, from no game and from no engine run.

/** The rook on e1 pins the knight on e5 to its king; a pawn on d6 defends it. Ne4 steps onto the e-file and closes the pin line. */
const SHUT: Pos = { fen: '4k3/6pp/3p4/4n3/5P2/2N5/6PP/4R1K1 w - - 0 1', a: 'c3e4', t: ['f4e5', 'd6e5'] };
/** The same card with an answer that leaves the e-file open: the pin holds after it. */
const KEPT: Pos = { fen: SHUT.fen, a: 'h2h3', t: ['f4e5', 'd6e5', 'e1e5'] };
/** Black to move. The knight on b5 is loose: the rook on h5 would defend it, but Black's own pawn on e5 stands between them. e4 takes that pawn off the rank. */
const UNMASK: Pos = { fen: '6k1/6pp/p4p2/1N2p2R/8/8/5PPP/6K1 b - - 0 1', a: 'e5e4', t: ['a6b5', 'h5b5'] };
/** The same card with an answer that leaves the pawn on e5: the knight is still loose after it. */
const MASKED: Pos = { fen: UNMASK.fen, a: 'h7h6', t: ['a6b5'] };
/** SHUT with no pawn on d6: pinned on the card; after Ne4 no longer pinned, and loose. */
const SHUT_LOOSE: Pos = { fen: '4k3/6pp/8/4n3/5P2/2N5/6PP/4R1K1 w - - 0 1', a: 'c3e4', t: ['f4e5'] };
/** A loose knight that the answer Re1 pins: loose on the card, pinned after it. */
const MADE_LOOSE: Pos = { fen: '4k3/6pp/8/4n3/5P2/8/6PP/3R2K1 w - - 0 1', a: 'd1e1', t: ['f4e5'] };

const PINNED_E8 = { r: 'pinned', pin: 'e8' }, LOOSE = { r: 'undefended' };
/** What the page's own `targetReason` reads for the piece on `sq`: on the card position, and on the pass position. */
const reasonOnCardAndAfter = (pos: Pos, sq: string) => [targetReason(pos.fen, sq), targetReason(passFen(pos.fen, pos.a)!, sq)];
const entryFor = (pos: Pos) => threatEntry({ id: 'card', fen: pos.fen, moves: [pos.a] }, pos.t);

test('threatEntry, F-1 (a): a pin that the answer itself closes is not stored; the square stays', () => {
  // The premise, read by the page's own function: pinned on the card, no reason once the white knight stands on e4.
  assert.deepEqual(reasonOnCardAndAfter(SHUT, 'e5'), [PINNED_E8, null]);
  assert.deepEqual(entryFor(SHUT), { id: 'card', a: 'c3e4', t: ['f4e5', 'd6e5'], k: 'capture', sq: 'e5', pre: true });
});

test('threatEntry, F-1 (b): "undefended" is not stored when the answer moves the solver\'s own piece out of a defender\'s way', () => {
  // Loose on the card; once the pawn has left e5 the rook on h5 defends the knight along the fifth rank.
  assert.deepEqual(reasonOnCardAndAfter(UNMASK, 'b5'), [LOOSE, null]);
  assert.deepEqual(entryFor(UNMASK), { id: 'card', a: 'e5e4', t: ['a6b5', 'h5b5'], k: 'capture', sq: 'b5', pre: true });
});

test('threatEntry, F-1 (c), controls: a reason that holds on the card and after the answer is stored; a pin the answer makes is not', () => {
  // The cards of (a) and (b) with an answer that leaves the line alone: the same reason in both positions.
  assert.deepEqual(reasonOnCardAndAfter(KEPT, 'e5'), [PINNED_E8, PINNED_E8]);
  assert.deepEqual(entryFor(KEPT), { id: 'card', a: 'h2h3', t: ['f4e5', 'd6e5', 'e1e5'], k: 'capture', sq: 'e5', r: 'pinned', pin: 'e8', pre: true });
  assert.deepEqual(reasonOnCardAndAfter(MASKED, 'b5'), [LOOSE, LOOSE]);
  assert.deepEqual(entryFor(MASKED), { id: 'card', a: 'h7h6', t: ['a6b5'], k: 'capture', sq: 'b5', r: 'undefended', pre: true });
  // Position A: the rook goes to d5, far from the knight on a5, which is loose before and after.
  assert.deepEqual(reasonOnCardAndAfter(A, 'a5'), [LOOSE, LOOSE]);
  assert.deepEqual(entryFor(A), { id: 'card', a: 'd1d5', t: ['d5a5'], k: 'capture', sq: 'a5', r: 'undefended', pre: false });
  // Position F: the answer Re1 itself makes the pin (on the card a pawn defends the knight). Never stored, and not now.
  assert.deepEqual(reasonOnCardAndAfter(F, 'e5'), [null, PINNED_E8]);
  assert.deepEqual(entryFor(F), { id: 'card', a: 'd1e1', t: ['f4e5', 'd6e5', 'e1e5'], k: 'capture', sq: 'e5', pre: true });
});

// The two readings must be the SAME reason. `targetReason` names a pin before "undefended", so a piece that is loose in
// both positions and pinned in one of them reads 'pinned' there and 'undefended' in the other. By the rule as the
// brief writes it ("the same `r`") the readings differ, and nothing is stored, although "undefended" is true in both.
test('threatEntry, F-1: pinned on the card and only loose after the answer are two reasons: nothing is stored', () => {
  // (a) with no pawn on d6: after Ne4 the knight is no longer pinned, and nothing defends it.
  assert.deepEqual(reasonOnCardAndAfter(SHUT_LOOSE, 'e5'), [PINNED_E8, LOOSE]);
  assert.deepEqual(entryFor(SHUT_LOOSE), { id: 'card', a: 'c3e4', t: ['f4e5'], k: 'capture', sq: 'e5', pre: true });
});

test('threatEntry, F-1: loose on the card and pinned by the answer are two reasons: nothing is stored', () => {
  // The pin is the answer's own (Re1) and is not stored; the card's 'undefended' is not stored either.
  assert.deepEqual(reasonOnCardAndAfter(MADE_LOOSE, 'e5'), [LOOSE, PINNED_E8]);
  assert.deepEqual(entryFor(MADE_LOOSE), { id: 'card', a: 'd1e1', t: ['f4e5'], k: 'capture', sq: 'e5', pre: true });
});

test('builder, F-1: a reason reaches the document and a sentence only when it holds on the card and after the answer', () => {
  const cases: Array<[string, Pos, string]> = [
    ['pack-kept', KEPT, 'e5'], ['pack-madeloose', MADE_LOOSE, 'e5'], ['pack-masked', MASKED, 'b5'],
    ['pack-shut', SHUT, 'e5'], ['pack-shutloose', SHUT_LOOSE, 'e5'], ['pack-unmask', UNMASK, 'b5'],
  ];
  const b = run({
    pack: packOf(cases.map(([id, pos]) => mistake(id, pos))),
    rows18: cases.flatMap(([id, pos]) => pair(id, pos, 18)),
    rows22: cases.flatMap(([id, pos]) => pair(id, pos, 22)),
  });
  assert.deepEqual([sum(b).stops, sum(b).dryRun.rejected, sum(b).threats.stored], [[], 0, 6]);
  // Every card keeps its threat and its target square; only the two controls keep a reason.
  assert.deepEqual(b.doc.cards.map(c => [c.id, c.sq, c.r ?? null, c.pin ?? null]), [
    ['pack-kept', 'e5', 'pinned', 'e8'], ['pack-madeloose', 'e5', null, null], ['pack-masked', 'b5', 'undefended', null],
    ['pack-shut', 'e5', null, null], ['pack-shutloose', 'e5', null, null], ['pack-unmask', 'b5', null, null],
  ]);
  assert.deepEqual([sum(b).withSq, sum(b).withR], [6, { pinned: 1, undefended: 1, total: 2 }]);
  // The measure of the ruling: a stored reason that is false on the card or after the answer: 0.
  for (const [id, pos, sq] of cases) {
    const c = b.doc.cards.find(x => x.id === id)!;
    if (!c.r) continue;
    const stored = c.r === 'pinned' ? { r: c.r, pin: c.pin } : { r: c.r };
    assert.deepEqual(reasonOnCardAndAfter(pos, sq), [stored, stored], id);
  }
  // The sentences are the page's own. A reason is printed for the two controls only, in the hint and in the paragraph.
  const stating = (id: string) => b.sentences.filter(r => r[0] === id && /pinned|undefended/.test(r[2])).map(r => r[1]);
  assert.deepEqual(cases.map(([id]) => [id, stating(id)]), [
    ['pack-kept', ['rung2', 'paragraph']], ['pack-madeloose', []], ['pack-masked', ['rung2', 'paragraph']],
    ['pack-shut', []], ['pack-shutloose', []], ['pack-unmask', []],
  ]);
  const paragraph = (id: string) => b.sentences.filter(r => r[0] === id && r[1] === 'paragraph').map(r => r[2]);
  // The paragraph is read after the answer: with the knight on e4 the pin is gone, and the sentence about it with it.
  assert.deepEqual(paragraph('pack-shut'), ['Ne4 prepares fxe5. If Black made no move in reply: fxe5 dxe5. White wins a knight for a pawn.']);
  assert.deepEqual(paragraph('pack-kept'), ['h3 prepares fxe5. The knight on e5 is pinned to the king on e8. If Black made no move in reply: fxe5 dxe5 Rxe5+. White wins a knight.']);
  assert.deepEqual(paragraph('pack-unmask'), ['e4 prepares axb5. If White made no move in reply: axb5 Rxb5. Black wins a knight for a pawn.']);
  assert.deepEqual(paragraph('pack-masked'), ['h6 prepares axb5. The knight on b5 is undefended. If White made no move in reply: axb5. Black wins a knight.']);
});

test('statedNet: what a settled closing sentence says, in pawns', () => {
  const cases: Array<[string, { side: string; net: number } | null]> = [
    ['White wins a knight.', { side: 'White', net: 3 }],
    ['White wins the queen and a pawn for a bishop.', { side: 'White', net: 7 }],
    ['Black wins two pawns.', { side: 'Black', net: 2 }],
    ['White wins a rook for a pawn.', { side: 'White', net: 4 }],
    ['White promotes a pawn to a queen.', { side: 'White', net: 8 }],
    ['White promotes a pawn to a queen for a knight.', { side: 'White', net: 5 }],
    ['White wins a rook and promotes a pawn to a queen.', { side: 'White', net: 13 }],
    ['White wins the queen and a rook, though Black promotes a pawn to a queen.', { side: 'White', net: 6 }],
    ['White promotes two pawns to a queen and a rook, though Black also promotes a pawn to a knight.', { side: 'White', net: 10 }],
    ['The trades are even.', null],
    ['No material changes hands.', null],
    ['So far in this line White has won a pawn.', null],
    ['The line ends in checkmate by White.', null],
    ['', null],
  ];
  for (const [sentence, want] of cases) assert.deepEqual(statedNet(sentence), want, sentence);
  // The narrator's own closings for the fixtures add up to what the board says.
  for (const [pos, net] of [[A, 3], [B, 9], [DR, 4], [H, 4], [E, 3], [QCHK, 8], [PAWN, 1]] as const) {
    const say = threatSay({ fen: pos.fen, moves: [pos.a], teach: threatEntry({ id: 'card', fen: pos.fen, moves: [pos.a] }, pos.t) })!;
    const closing = lineNarration(say.viewer.fen, say.viewer.line, undefined, { noChangeSentence: false }).summary;
    assert.deepEqual(statedNet(closing), { side: 'White', net }, closing);
  }
});

// ---------------------------------------------------------------- the version name

test('canonicalJson and teachVersionOf: one text per value, the day of `at` in UTC, 8 hex of the sha256', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: null, c: 'x' }, 2], e: undefined }), '{"a":[{"c":"x","d":null},2],"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]), 'array order is kept');
  const cards = [{ id: 'x', a: 'd1d5', t: ['d5a5'], k: 'capture', pre: false }];
  const text = '{"cards":[{"a":"d1d5","id":"x","k":"capture","pre":false,"t":["d5a5"]}],"held":[]}';
  assert.equal(canonicalJson({ cards, held: [] }), text);
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 8);
  assert.equal(teachVersionOf(AT, cards, []), `t20261114-${hash}`);
  assert.equal(teachVersionOf(Date.UTC(2026, 10, 14, 23, 59, 59, 999), cards, []), `t20261114-${hash}`);
  assert.equal(teachVersionOf(Date.UTC(2026, 10, 15), cards, []), `t20261115-${hash}`);
  assert.notEqual(teachVersionOf(AT, cards, [{ id: 'y', a: 'd1d5', why: 'not-held' }]), `t20261114-${hash}`);
  assert.match(teachVersionOf(AT, [], []), /^t\d{8}-[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------- the builder on the main scenario

test('builder: the document holds the confirmed threats and the held cards, and nothing else', () => {
  const s = mainScenario();
  const { doc } = run(s);
  assert.deepEqual(Object.keys(doc).sort(), ['at', 'cards', 'held', 'packVersion', 'teachVersion', 'v']);
  assert.deepEqual([doc.v, doc.packVersion, doc.at], [1, PACK_V, AT]);
  assert.equal(doc.teachVersion, teachVersionOf(AT, doc.cards, doc.held));
  assert.deepEqual(doc.cards.map(c => c.id), STORED, 'sorted by id');
  const byId = new Map(doc.cards.map(c => [c.id, c]));
  assert.deepEqual(byId.get('pack-cap'), { id: 'pack-cap', a: 'd1d5', t: ['d5a5'], k: 'capture', sq: 'a5', r: 'undefended', pre: false });
  assert.deepEqual(byId.get('pack-pin'), { id: 'pack-pin', a: 'h2h3', t: ['f4e5', 'd6e5', 'e1e5'], k: 'capture', sq: 'e5', r: 'pinned', pin: 'e8', pre: true });
  assert.deepEqual(byId.get('pack-pinmade'), { id: 'pack-pinmade', a: 'd1e1', t: ['f4e5', 'd6e5', 'e1e5'], k: 'capture', sq: 'e5', pre: true });
  assert.deepEqual(byId.get('pack-mate'), { id: 'pack-mate', a: 'e2e4', t: ['e4h7'], k: 'mate', pre: false });
  assert.deepEqual(byId.get('pack-mate2'), { id: 'pack-mate2', a: 'g2g3', t: ['h2h4', 'a7a6', 'e1e8'], k: 'mate', pre: true });
  assert.deepEqual(byId.get('pack-promopre'), { id: 'pack-promopre', a: 'g2f3', t: ['b7b8q'], k: 'promotion', pre: true });
  assert.deepEqual(byId.get('pack-promosq'), { id: 'pack-promosq', a: 'b6b7', t: ['b7b8q', 'a8b8', 'b1b8'], k: 'promotion', sq: 'a8', r: 'undefended', pre: false });
  assert.deepEqual(byId.get('pack-chknosq'), { id: 'pack-chknosq', a: 'g2f3', t: ['b7b8q'], k: 'check', pre: true });
  assert.deepEqual(byId.get('punish-nu'), { id: 'punish-nu', a: 'd8d4', t: ['d4a4'], k: 'capture', sq: 'a4', r: 'undefended', pre: false });
  // Both depths: the stored line is the depth-22 row's, not the depth-18 row's.
  assert.deepEqual(byId.get('pack-chk')?.t, ['d5e7', 'g8f8', 'e7c8']);
  // Held cards, sorted by id; `alt` only with 'not-unique'.
  assert.deepEqual(doc.held, [{ id: 'punish-nh', a: 'd1d5', why: 'not-held' }, { id: 'punish-nu', a: 'd8d4', why: 'not-unique', alt: 'd8a8' }]);
  // No score, depth, margin or gap is stored: only the fields of the contract.
  for (const c of doc.cards) assert.deepEqual(Object.keys(c).filter(k => !['id', 'a', 't', 'k', 'sq', 'r', 'pin', 'pre'].includes(k)), [], c.id);
  for (const h of doc.held) assert.deepEqual(Object.keys(h).filter(k => !['id', 'a', 'why', 'alt'].includes(k)), [], h.id);
  assert.doesNotMatch(JSON.stringify(doc), /cp|depth|margin|gap|win|mate"\s*:|nodes|engine/i);
  // The page's reader takes it whole, and it is small.
  const read = readTeachMeta(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual([read.ok, read.skipped, read.issue, read.cards.length, read.held.length], [true, 0, '', 16, 2]);
  assert.equal(sum(run(s)).bytes, docBytes(doc));
  assert.ok(docBytes(doc) < TEACH_MAX_BYTES && TEACH_MAX_BYTES === 153_600 && TEACH_MAX_BYTES < MAX_DOC_BYTES);
});

test('builder: a threat is stored only when it passes at depth 18 and at depth 22; every other quiet card has one reason', () => {
  const b = run(mainScenario());
  const s = sum(b);
  assert.deepEqual(s.stops, []);
  assert.deepEqual(s.cards, { served: 29, pack: 25, punish: 3, smallEdge: 1, quiet: 28 });
  assert.deepEqual(s.threats.noThreat, {
    'd18:T0': 3, 'd18:T1': 1, 'd18:T2': 1, 'd18:T3': 1, 'd18:T4': 1, 'd18:T5': 1, 'd18:replay': 1,
    'd22:T3': 1, 'd22:T4': 1, 'd22:unconfirmed': 1,
  });
  assert.deepEqual(s.threats.identity, { quiet: 28, withThreat: 16, sumOfReasons: 12, holds: true });
  assert.deepEqual([s.threats.passDepth18, s.threats.stored, s.threats.unconfirmed], [19, 16, 1]);
  assert.deepEqual(s.threats.lostAtDepth22, { T0: 0, T1: 0, replay: 0, T2: 0, T3: 1, T4: 1, T5: 0, total: 2 });
  assert.deepEqual(s.threats.byClass, { pack: 12, punish: 3, 'small-edge': 1 });
  // Cards per gate and depth.
  assert.deepEqual([s.gates.d18.cards, s.gates.d18.passAll, s.gates.d18.passEach.T0], [28, 19, 25]);
  assert.deepEqual(s.gates.d18.firstFail, { T0: 3, T1: 1, replay: 1, T2: 1, T3: 1, T4: 1, T5: 1 });
  assert.deepEqual(s.gates.d18.t0, { 'mate-anyway': 1, shallow: 1, skipped: 1 });
  // Depth 22 judges the 24 candidates (T0 and T4 at depth 18) whose rows are not capped. The card that fails only T2
  // at depth 18 passes there, and still gets no threat.
  assert.deepEqual([s.gates.d22.cards, s.gates.d22.passAll], [23, 17]);
  assert.deepEqual(s.gates.d22.firstFail, { T0: 0, T1: 1, replay: 1, T2: 0, T3: 2, T4: 1, T5: 1 });
  const decision = (id: string) => b.decisions.find(d => d.id === id && d.type === 'threat') as Record<string, any>;
  assert.deepEqual([decision('pack-t2').result, decision('pack-t2').d18.fail, decision('pack-t2').d22.pass], ['d18:T2', 'T2', true]);
  assert.deepEqual([decision('pack-lost-t4').result, decision('pack-lost-t4').d18.margin, decision('pack-lost-t4').d22.margin], ['d22:T4', 120, 60]);
  assert.deepEqual([decision('pack-capped22').result, decision('pack-capped22').d22], ['d22:unconfirmed', 'capped']);
  assert.deepEqual([decision('pack-t4').result, decision('pack-t4').d22], ['d18:T4', 'not-a-candidate']);
  assert.deepEqual([decision('pack-cap').result, decision('pack-cap').d18.pass, decision('pack-cap').d22.pass], ['threat', true, true]);
  for (const key of ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'margin', 'netT', 'netShown', 'netL']) assert.ok(key in decision('pack-cap').d18 && key in decision('pack-cap').d22, key);
  assert.equal(b.decisions.filter(d => d.type === 'threat').length, 28, 'one record per quiet card');
  assert.equal(b.decisions.some(d => d.id === 'pack-noisy'), false, 'a card whose answer is not quiet has no threat record');
});

test('builder: the counts the stage reads', () => {
  const s = sum(run(mainScenario()));
  assert.deepEqual(s.rows.d18.expected, { uniq: 4, after: 29, threat: 28, total: 61 });
  assert.deepEqual(s.rows.d18.found, s.rows.d18.expected);
  assert.deepEqual(
    [s.rows.d18.missing, s.rows.d18.capped, s.rows.d18.notThisCard, s.rows.d18.forOtherCards, s.rows.d18.read, s.rows.d18.repeated, s.rows.d18.lowestDepth],
    [0, 0, 0, 2, 63, 0, 15],
  );
  assert.deepEqual(
    [s.rows.d22.candidates, s.rows.d22.withBothRows, s.rows.d22.missing, s.rows.d22.capped, s.rows.d22.read, s.rows.d22.lowestDepth],
    [24, 24, 0, 1, 48, 22],
  );
  assert.deepEqual(s.marginHistogram, {
    depth18PassAll: { '100-149': 1, '150-299': 1, '300+': 14, mate: 3 },
    depth22Stored: { '100-149': 0, '150-299': 1, '300+': 12, mate: 3 },
  });
  assert.deepEqual(s.strong, { depth18: 18, failT4AtDepth22: 0, share: 0, limit: 0.03 });
  assert.deepEqual(s.k, { mate: 3, check: 4, capture: 6, promotion: 3 });
  assert.deepEqual(s.pre, { true: 7, false: 9 });
  assert.deepEqual([s.withSq, s.withR], [10, { pinned: 1, undefended: 8, total: 9 }]);
  assert.deepEqual(s.held, { 'not-unique': 1, 'not-held': 1, total: 2, limit: 110 });
  assert.deepEqual(s.graded, { total: 3, kept: 1, held: 2, holds: true });
  assert.deepEqual(s.join, { entries: 16, joined: 16, heldListed: { 'not-unique': 1, 'not-held': 1 }, heldInPools: 0, classesKept: true, ok: true });
  assert.deepEqual(s.uniq, { shallow: 0, noRow: 0, oneLegalMove: 0, gapDiffersFromRow: 0, rankDiffersFromRow: 0, smallEdgeUnder10: 1 });
  assert.deepEqual(s.dryRun, { rejected: 0, readerOk: true, shownNotReplaying: 0, closingMismatches: 0, almostMissing: 0 });
  assert.deepEqual(s.itemB, { quietNoThreatMargin50to99: 1 });
  assert.deepEqual([s.v, s.packVersion, s.at, s.limitBytes, s.madeBy], [1, PACK_V, AT, 153_600, TEACH_BUILDER_MARK]);
  // Counts only: no card id, no move and no sentence anywhere in the summary.
  const text = JSON.stringify(s);
  for (const id of [...STORED, 'pack-t4', 'punish-mw']) assert.ok(!text.includes(id), id);
  assert.doesNotMatch(text, /[a-h][1-8][a-h][1-8]|threatens|prepares|Target/);
});

test('builder: the sentences are the page module\'s own, for every place the page can show one', () => {
  const s = mainScenario();
  const b = run(s);
  const teach = loadTeach(readTeachMeta(JSON.parse(JSON.stringify(b.doc))))!;
  const without = buildPools({ bank: [], endgames: [], pack: s.pack, personal: [], drills: [] });
  const pools = buildPools({ bank: [], endgames: [], pack: s.pack, personal: [], drills: [], teach });
  // What the 7.1 page shows from the document, card by card, built here from the joined pools.
  const want: string[][] = [];
  for (const item of pools.own) {
    if (!item.teach) continue;
    const facts = threatFacts(item)!, say = threatSay(item)!;
    const v7 = hintLadderFor(without.byId.get(item.id)!, item.fen, 0);
    const now = applyThreatHints(hintLadderFor(item, item.fen, 0), facts, isPunish(item));
    if (now[0].text !== v7[0].text) want.push([item.id, 'rung1', now[0].text]);
    if (JSON.stringify(now[1]) !== JSON.stringify(v7[1])) want.push([item.id, 'rung2', now[1].text]);
    assert.deepEqual(now.slice(2), v7.slice(2), `${item.id}: rungs 3 and 4 never change`);
    if (isPunish(item)) want.push([item.id, 'clause.full', say.clause.full], [item.id, 'clause.fullNoClosing', say.clause.fullNoClosing], [item.id, 'clause.short', say.clause.short]);
    else want.push([item.id, 'paragraph', say.paragraph]);
    want.push([item.id, 'viewer.title', say.viewer.title], [item.id, 'viewer.toggle', say.viewer.toggle], [item.id, 'viewer.intro', say.viewer.intro]);
    want.push([item.id, 'viewer.closing', lineNarration(say.viewer.fen, say.viewer.line, undefined, { noChangeSentence: false }).summary]);
  }
  for (const item of [...pools.smallEdge, ...pools.notUnique]) {
    const say = item.teach ? threatSay(item) : null;
    if (say) want.push([item.id, 'clause.full', say.clause.full], [item.id, 'clause.fullNoClosing', say.clause.fullNoClosing], [item.id, 'clause.short', say.clause.short]);
  }
  for (const item of pools.notUnique) want.push([item.id, 'almost', almostAsHighly(item)!]);
  const sorted = (rows: string[][]) => rows.map(r => r.join('\t')).sort();
  assert.deepEqual(sorted(b.sentences), sorted(want));
  assert.deepEqual(sum(b).sentences.rows, b.sentences.length);
  // Exact texts for a few (the wording itself is pinned in tests/m31_threat.test.ts).
  const text = (id: string, slot: string) => b.sentences.filter(r => r[0] === id && r[1] === slot).map(r => r[2]);
  assert.deepEqual(text('pack-mate', 'rung1'), ['The right move is a quiet one, but it threatens checkmate.']);
  assert.deepEqual(text('pack-mate', 'rung2'), ['Target: the black king on g8. The right move threatens checkmate.']);
  assert.deepEqual(text('pack-pin', 'rung1'), ['The right move is a quiet one. It prepares a capture that wins material.']);
  assert.deepEqual(text('pack-pin', 'rung2'), ['Target: the knight on e5. It is pinned to the king on e8. The right move prepares to win it. Playing the capture at once is not the move.']);
  assert.deepEqual(text('pack-promopre', 'rung1'), ['The right move is a quiet one. It prepares the promotion of a pawn.']);
  assert.deepEqual(text('pack-promopre', 'rung2'), [], 'a promotion keeps version 7\'s rung 2');
  assert.deepEqual(text('pack-mate', 'paragraph'), ['Qe4 threatens checkmate. If Black made no move in reply: Qxh7#.']);
  assert.deepEqual(text('pack-cap', 'paragraph'), ['Rd5 threatens Rxa5. The knight on a5 is undefended. If Black made no move in reply: Rxa5. White wins a knight.']);
  assert.deepEqual(text('pack-cap', 'viewer.title'), ['What Rd5 threatens']);
  assert.deepEqual(text('pack-cap', 'viewer.closing'), ['White wins a knight.']);
  // A ladder whose rung 1 is not the bare quiet sentence is not touched: no hint rows for that card.
  assert.notEqual(hintLadderFor(pools.byId.get('pack-cap')!, A.fen, 0)[0].text, QUIET_BARE);
  assert.deepEqual([text('pack-cap', 'rung1'), text('pack-cap', 'rung2')], [[], []]);
  // On a punish card the target is named with its colour, and the lesson gets the three clauses.
  assert.match(text('punish-mate', 'rung1')[0], /The right move is a quiet one, but it threatens checkmate\.$/);
  assert.deepEqual(text('punish-mate', 'rung2'), ['Target: the black king on g8. The right move threatens checkmate.']);
  assert.deepEqual(text('punish-mate', 'clause.short'), ['It threatens checkmate.']);
  // Held as not-unique: read in a list, so the clauses and the "almost as highly" line, but no hint and no viewer.
  assert.deepEqual(b.sentences.filter(r => r[0] === 'punish-nu').map(r => r[1]), ['clause.full', 'clause.fullNoClosing', 'clause.short', 'almost']);
  assert.deepEqual(text('punish-nu', 'almost'), ['The engine rates Ra8 almost as highly.']);
  // Held as not-held: listed nowhere, so no sentence at all. Small edge: read in a list, the clauses only.
  assert.deepEqual(b.sentences.filter(r => r[0] === 'punish-nh'), []);
  assert.deepEqual(b.sentences.filter(r => r[0] === 'punish-se').map(r => r[1]), ['clause.full', 'clause.fullNoClosing', 'clause.short']);
  // No hint row spoils the answer: neither its SAN nor the first move of the threat is in rung 1 or 2.
  for (const [id, slot, sentence] of b.sentences) {
    if (slot !== 'rung1' && slot !== 'rung2') continue;
    const item = pools.byId.get(id)!, facts = threatFacts(item)!;
    assert.ok(!sentence.includes(facts.answerSan) && !sentence.includes(facts.firstSan), `${id} ${slot}`);
  }
});

test('builder: pure and deterministic', () => {
  const s = mainScenario();
  const before = JSON.stringify(s);
  const one = run(s), two = run(mainScenario());
  assert.equal(JSON.stringify(s), before, 'the input is not changed');
  assert.deepEqual(two, one);
  assert.equal(JSON.stringify(two.doc), JSON.stringify(one.doc), 'byte for byte');
  // The order of the rows and of the cards does not matter (one row per id and kind here).
  const shuffled = run({ pack: packOf([...(s.pack.cards as never as Card[])].reverse(), [...(s.pack.punish as never as Card[])].reverse()), rows18: [...s.rows18].reverse(), rows22: [...s.rows22].reverse() });
  assert.equal(JSON.stringify(shuffled.doc), JSON.stringify(one.doc));
  assert.deepEqual(shuffled.summary, one.summary);
  assert.deepEqual(shuffled.sentences.map(r => r.join('\t')).sort(), one.sentences.map(r => r.join('\t')).sort());
  // `at` is passed in: the same day gives the same version name, another day another name with the same hash.
  const later = run(s, AT + 1), nextDay = run(s, AT + 86_400_000);
  assert.deepEqual([later.doc.teachVersion, later.doc.at], [one.doc.teachVersion, AT + 1]);
  assert.equal(nextDay.doc.teachVersion, one.doc.teachVersion.replace('t20261114-', 't20261115-'));
  assert.match(one.doc.teachVersion, /^t20261114-[0-9a-f]{8}$/);
  assert.throws(() => run(s, Number.NaN), TypeError);
  assert.throws(() => run(s, -1), TypeError);
});

// ---------------------------------------------------------------- rows

/** Two mistake cards (one with a threat, one whose margin is too small) and one graded punish card. */
function tiny(): Scenario {
  return {
    pack: packOf([mistake('pack-yes', A), mistake('pack-no', A)], [punishCard('punish-one', TAKE, 80)]),
    rows18: [...pair('pack-yes', A, 18), ...pair('pack-no', A, 18, { margin: 40 }), afterRow('punish-one', TAKE.a), uniqRow('punish-one', TAKE.a, UNIQUE(TAKE.a, TAKE.alt))],
    rows22: pair('pack-yes', A, 22),
  };
}

test('builder rows: the last row per id and kind counts', () => {
  const s = tiny();
  const good = run(s);
  assert.deepEqual([good.doc.cards.map(c => c.id), sum(good).stops], [['pack-yes'], []]);
  // An earlier capped or shallow row followed by the real one: the real one counts.
  const rerun = run({ ...s, rows18: [threatRow('pack-yes', A.a, [], 18, 0, { capped: true, depthReached: 9 }), ...s.rows18], rows22: [threatRow('pack-yes', A.a, ['d5d8'], 22, 0), ...s.rows22] });
  assert.equal(JSON.stringify(rerun.doc), JSON.stringify(good.doc));
  assert.deepEqual([sum(rerun).rows.d18.repeated, sum(rerun).rows.d22.repeated, sum(rerun).rows.d18.capped, sum(rerun).stops], [1, 1, 0, []]);
  // The other way round, the last row is the capped one: the file is incomplete (s5).
  const capped = run({ ...s, rows18: [...s.rows18, threatRow('pack-yes', A.a, [], 18, 0, { capped: true, depthReached: 9 })] });
  assert.deepEqual([capped.doc.cards.length, sum(capped).rows.d18.capped, sum(capped).stops.length], [0, 1, 1]);
  assert.match(sum(capped).stops[0], /^s5: /);
  // Lines that are not rows are ignored.
  const junk = run({ ...s, rows18: [null, 7, 'x', {}, { id: 'pack-yes' }, { kind: 'after' }, ...s.rows18] as never });
  assert.equal(JSON.stringify(junk.doc), JSON.stringify(good.doc));
});

test('builder rows: a row computed for another answer or another pack is not this card\'s row', () => {
  const s = tiny();
  // The card's move changed since the pass (a pack refresh): its rows name the old answer.
  const moved = run({ ...s, pack: packOf([mistake('pack-yes', { fen: A.fen, a: 'd1d4' }), mistake('pack-no', A)], [punishCard('punish-one', TAKE, 80)]) });
  assert.deepEqual(moved.doc.cards, []);
  assert.deepEqual([sum(moved).rows.d18.notThisCard, sum(moved).rows.d18.missing, sum(moved).rows.d22.notThisCard], [2, 2, 2]);
  assert.match(sum(moved).stops.join('\n'), /^s5: /m);
  // Rows of another pack version.
  const otherPack = run({ ...s, pack: packOf([mistake('pack-yes', A), mistake('pack-no', A)], [punishCard('punish-one', TAKE, 80)], 'p-next') });
  assert.deepEqual([otherPack.doc.cards, otherPack.doc.held, otherPack.doc.packVersion], [[], [], 'p-next']);
  assert.equal(sum(otherPack).rows.d18.notThisCard, 6);
  assert.match(sum(otherPack).stops.join('\n'), /^s5: /m);
  // The uniqueness row too: a verdict for another answer never holds a card.
  const staleUniq = run({ ...s, rows18: [...s.rows18.filter(r => r.kind !== 'uniq'), uniqRow('punish-one', 'e1e5', [{ uci: 'f4e5', cp: 300 }, { uci: 'e1e5', cp: 295 }])] });
  assert.deepEqual([staleUniq.doc.held, sum(staleUniq).uniq.noRow], [[], 1]);
});

// ---------------------------------------------------------------- uniqueness (3.5)

test('builder uniqueness: the producer\'s rule on the depth-18 row of each graded punish card', () => {
  // Two scores whose Win% gap is just under and just over 10 points, found with the producer's own function.
  let under = 0, over = 0;
  for (let cp = 299; cp > 0; cp--) {
    const gap = round2(lineWin({ cp: 300 }) - lineWin({ cp }));
    if (gap < 10) under = cp; else { over = cp; break; }
  }
  assert.ok(under > 0 && over === under - 1 && round2(lineWin({ cp: 300 }) - lineWin({ cp: under })) < UNIQUE_GAP && round2(lineWin({ cp: 300 }) - lineWin({ cp: over })) >= UNIQUE_GAP);
  const cases: Array<[string, PassRow | null, string]> = [
    ['punish-unique', uniqRow('punish-unique', TAKE.a, UNIQUE(TAKE.a, TAKE.alt)), 'unique'],
    ['punish-over', uniqRow('punish-over', TAKE.a, [{ uci: TAKE.a, cp: 300 }, { uci: TAKE.alt, cp: over }]), 'unique'],
    ['punish-under', uniqRow('punish-under', TAKE.a, [{ uci: TAKE.a, cp: 300 }, { uci: TAKE.alt, cp: under }]), 'not-unique'],
    ['punish-mates', uniqRow('punish-mates', TAKE.a, [{ uci: TAKE.a, mate: 2 }, { uci: TAKE.alt, cp: 800 }]), 'not-unique'],       // a mate counts as 1000 cp
    ['punish-second', uniqRow('punish-second', TAKE.a, [{ uci: TAKE.alt, cp: 900 }, { uci: TAKE.a, cp: 100 }]), 'not-held'],
    ['punish-third', uniqRow('punish-third', TAKE.a, [{ uci: TAKE.alt, cp: 300 }, { uci: 'g1f2', cp: 299 }, { uci: TAKE.a, cp: 298 }]), 'not-held'],
    ['punish-unlisted', uniqRow('punish-unlisted', TAKE.a, [{ uci: TAKE.alt, cp: 300 }, { uci: 'g1f2', cp: 0 }]), 'not-held'],
    ['punish-shallow', uniqRow('punish-shallow', TAKE.a, [{ uci: TAKE.a, cp: 300 }, { uci: TAKE.alt, cp: 295 }], { depthReached: 15 }), 'shallow'],
    ['punish-fieldsoff', uniqRow('punish-fieldsoff', TAKE.a, UNIQUE(TAKE.a, TAKE.alt), { gapRule: 3, ansRank: 2 }), 'unique'],       // the verdict comes from the moves, not from the row's own fields
  ];
  const punish = [...cases.map(([id]) => punishCard(id, TAKE, 80)), punishCard('punish-only', ONLY, 90), punishCard('punish-edge', TAKE, 55)];
  const rows18 = [
    ...punish.map(c => afterRow(c.id, c.moves[0])), ...cases.map(c => c[1]!),
    uniqRow('punish-only', ONLY.a, [{ uci: ONLY.a, cp: 600 }], { legal: 1 }),
    uniqRow('punish-edge', TAKE.a, [{ uci: TAKE.a, cp: 60 }, { uci: TAKE.alt, cp: 55 }]),
  ];
  const b = run({ pack: packOf([], punish), rows18, rows22: [] });
  const verdict = (id: string) => (b.decisions.find(d => d.id === id && d.type === 'uniq') as Record<string, any> | undefined)?.verdict;
  for (const [id, , want] of cases) assert.equal(verdict(id), want, id);
  assert.equal(verdict('punish-only'), 'unique', 'one legal move');
  assert.equal(verdict('punish-edge'), undefined, 'a small-edge card gets no verdict');
  assert.deepEqual(b.doc.held, [
    { id: 'punish-mates', a: TAKE.a, why: 'not-unique', alt: TAKE.alt },
    { id: 'punish-second', a: TAKE.a, why: 'not-held' },
    { id: 'punish-third', a: TAKE.a, why: 'not-held' },
    { id: 'punish-under', a: TAKE.a, why: 'not-unique', alt: TAKE.alt },
    { id: 'punish-unlisted', a: TAKE.a, why: 'not-held' },
  ]);
  const s = sum(b);
  assert.deepEqual(s.held, { 'not-unique': 2, 'not-held': 3, total: 5, limit: 110 });
  assert.deepEqual(s.graded, { total: 10, kept: 5, held: 5, holds: true });
  assert.deepEqual(s.uniq, { shallow: 1, noRow: 0, oneLegalMove: 1, gapDiffersFromRow: 1, rankDiffersFromRow: 1, smallEdgeUnder10: 1 });
  // 'punish-shallow' gets no verdict, and that stops the build (stop rule s6; before s6 this scenario gave no stop).
  assert.deepEqual([s.stops, s.threats.identity], [['s6: graded punish cards without a uniqueness verdict: shallow 1, no row 0'], { quiet: 0, withThreat: 0, sumOfReasons: 0, holds: true }]);
  // Each record carries the verdict, the gap and the top moves (private output).
  const rec = b.decisions.find(d => d.id === 'punish-under') as Record<string, any>;
  assert.deepEqual([rec.type, rec.verdict, rec.ansRank, rec.top.map((t: { uci: string }) => t.uci)], ['uniq', 'not-unique', 1, [TAKE.a, TAKE.alt]]);
  assert.ok(rec.gapRule < 10 && rec.gapRule > 9);
  assert.equal(b.sentences.filter(r => r[1] === 'almost').length, 2);
  // A depth-22 row never changes a verdict: uniq rows in the depth-22 file are not read at all.
  const with22 = run({ pack: packOf([], punish), rows18, rows22: [{ ...uniqRow('punish-under', TAKE.a, UNIQUE(TAKE.a, TAKE.alt)), depthAsked: 22, depthReached: 22 }] });
  assert.equal(JSON.stringify(with22.doc), JSON.stringify(b.doc));
});

// ---------------------------------------------------------------- stop rules

/** The line of stop rule s6, with its two counts: one graded punish card without a verdict, either way. */
const S6_SHALLOW = 's6: graded punish cards without a uniqueness verdict: shallow 1, no row 0';
const S6_NO_ROW = 's6: graded punish cards without a uniqueness verdict: shallow 0, no row 1';

test('stop rule s1: more than 110 cards held', () => {
  const held = (n: number) => {
    const punish = Array.from({ length: n }, (_, i) => punishCard(`punish-h${i}`, TAKE, 80));
    const rows18 = punish.flatMap(c => [afterRow(c.id, TAKE.a), uniqRow(c.id, TAKE.a, [{ uci: TAKE.a, cp: 300 }, { uci: TAKE.alt, cp: 295 }])]);
    return run({ pack: packOf([], [...punish, punishCard('punish-kept', TAKE, 80)]), rows18: [...rows18, afterRow('punish-kept', TAKE.a), uniqRow('punish-kept', TAKE.a, UNIQUE(TAKE.a, TAKE.alt))], rows22: [] });
  };
  const at110 = held(110), at111 = held(111);
  assert.deepEqual([sum(at110).held.total, sum(at110).stops], [110, []]);
  assert.deepEqual([sum(at111).held.total, sum(at111).stops.length], [111, 1]);
  assert.match(sum(at111).stops[0], /^s1: 111 cards held, more than 110$/);
  assert.deepEqual(sum(at111).graded, { total: 112, kept: 1, held: 111, holds: true });
});

test('stop rule s2: more than 3% of the strong depth-18 threats fail T4 at depth 22', () => {
  /** `n` strong passes at depth 18, of which `lost` fall under the margin at depth 22; plus cards that must not count. */
  const strong = (n: number, lost: number) => {
    const cards: Card[] = [], rows18: PassRow[] = [], rows22: PassRow[] = [];
    for (let i = 0; i < n; i++) {
      cards.push(mistake(`pack-s${i}`, A));
      rows18.push(...pair(`pack-s${i}`, A, 18, { margin: i % 2 ? 150 : 400 }));
      rows22.push(...pair(`pack-s${i}`, A, 22, { margin: i < lost ? 99 : 150 }));
    }
    // A weak pass (under 150) that fails T4 at depth 22, a strong one that fails another gate there, and a strong
    // one whose depth-22 row is capped: none of them counts for s2.
    cards.push(mistake('pack-weak', A), mistake('pack-othergate', B), mistake('pack-capped', A));
    rows18.push(...pair('pack-weak', A, 18, { margin: 149 }), ...pair('pack-othergate', B, 18), ...pair('pack-capped', A, 18));
    rows22.push(...pair('pack-weak', A, 22, { margin: 10 }), ...pair('pack-othergate', B, 22, { line: ['d5e7', 'g8h7'] }), ...pair('pack-capped', A, 22, { margin: 0, threat: { capped: true } }));
    return sum(run({ pack: packOf(cards), rows18, rows22 }));
  };
  const ok = strong(34, 1);     // 1 of 36 strong passes
  assert.deepEqual([ok.strong.depth18, ok.strong.failT4AtDepth22, ok.stops], [36, 1, []]);
  assert.ok(ok.strong.share <= 0.03);
  assert.deepEqual(ok.threats.lostAtDepth22, { T0: 0, T1: 0, replay: 0, T2: 0, T3: 1, T4: 2, T5: 0, total: 3 });
  const bad = strong(31, 1);    // 1 of 33
  assert.deepEqual([bad.strong.depth18, bad.strong.failT4AtDepth22, bad.stops.length], [33, 1, 1]);
  assert.match(bad.stops[0], /^s2: 1 of 33 strong depth-18 threats fail T4 at depth 22, more than 3%$/);
  assert.equal(strong(40, 0).stops.length, 0);
  assert.match(strong(2, 2).stops[0], /^s2: 2 of 4 /);
});

test('stop rule s3: the document is over 150 KiB', () => {
  /** 640 held cards; with ids of 200 characters the document passes 150 KiB (s1 fires in both, by the count). */
  const many = (idOf: (i: number) => string) => {
    const punish = Array.from({ length: 640 }, (_, i) => punishCard(idOf(i), TAKE, 80));
    const rows18 = punish.flatMap(c => [afterRow(c.id, TAKE.a), uniqRow(c.id, TAKE.a, [{ uci: TAKE.a, cp: 300 }, { uci: TAKE.alt, cp: 295 }])]);
    return run({ pack: packOf([], punish), rows18, rows22: [] });
  };
  const long = many(i => `punish-${'x'.repeat(189)}${String(i).padStart(4, '0')}`), short = many(i => `punish-${i}`);
  assert.equal(long.doc.held[0].id.length, 200);
  assert.ok(sum(long).bytes > TEACH_MAX_BYTES && sum(long).bytes === docBytes(long.doc) && sum(long).bytes < MAX_DOC_BYTES);
  assert.deepEqual(sum(long).stops.map((line: string) => line.slice(0, 3)), ['s1:', 's3:']);
  assert.equal(sum(long).stops[1], `s3: the document is ${sum(long).bytes} bytes, over 153600`);
  assert.ok(sum(short).bytes < TEACH_MAX_BYTES);
  assert.deepEqual(sum(short).stops.map((line: string) => line.slice(0, 3)), ['s1:']);
});

test('stop rule s4: the page module rejects an entry', () => {
  // An id that is no path segment: the page's reader would skip the entry, so the builder leaves it out and stops.
  const s = tiny();
  const bad = run({
    pack: packOf([mistake('bad id', A), mistake('pack-no', A)], [punishCard('bad/held', TAKE, 80)]),
    rows18: [...pair('bad id', A, 18), ...pair('pack-no', A, 18, { margin: 40 }), afterRow('bad/held', TAKE.a), uniqRow('bad/held', TAKE.a, [{ uci: TAKE.a, cp: 300 }, { uci: TAKE.alt, cp: 295 }])],
    rows22: pair('bad id', A, 22),
  });
  assert.deepEqual([bad.doc.cards, bad.doc.held], [[], []]);
  assert.deepEqual([sum(bad).dryRun.rejected, sum(bad).threats.noThreat, sum(bad).threats.identity.holds], [2, { 'd18:T4': 1, 'dry-run': 1 }, true]);
  assert.deepEqual(sum(bad).stops, ['s4: the page module rejects 2 entries']);
  assert.equal((bad.decisions.find(d => d.id === 'bad/held') as Record<string, any>).verdict, 'dry-run');
  assert.deepEqual(sum(run(s)).stops, []);
});

test('stop rule s5: a row file is incomplete', () => {
  const s = tiny();
  const without = (rows: PassRow[], kind: string, id: string) => rows.filter(r => !(r.kind === kind && r.id === id));
  const stops = (x: Scenario) => sum(run(x)).stops as string[];
  // Depth 18: every planned row must be there and not capped.
  assert.deepEqual(stops({ ...s, rows18: without(s.rows18, 'after', 'pack-no') }), ['s5: rows incomplete: depth 18 missing 1, capped 0; depth-22 candidates without both rows 0']);
  assert.deepEqual(stops({ ...s, rows18: without(s.rows18, 'threat', 'pack-no') }), ['s5: rows incomplete: depth 18 missing 1, capped 0; depth-22 candidates without both rows 0']);
  // A missing uniq row also leaves its graded card without a verdict, so stop rule s6 fires beside s5 (here and
  // where every row is missing).
  assert.deepEqual(stops({ ...s, rows18: without(s.rows18, 'uniq', 'punish-one') }), ['s5: rows incomplete: depth 18 missing 1, capped 0; depth-22 candidates without both rows 0', S6_NO_ROW]);
  assert.deepEqual(stops({ ...s, rows18: s.rows18.map(r => (r.kind === 'after' && r.id === 'punish-one' ? { ...r, capped: true } : r)) }), ['s5: rows incomplete: depth 18 missing 0, capped 1; depth-22 candidates without both rows 0']);
  assert.deepEqual(stops({ ...s, rows18: [] }), ['s5: rows incomplete: depth 18 missing 6, capped 0; depth-22 candidates without both rows 0', S6_NO_ROW]);
  // Depth 22: a candidate (T0 and T4 at depth 18) needs both rows.
  for (const kind of ['after', 'threat']) {
    const b = run({ ...s, rows22: without(s.rows22, kind, 'pack-yes') });
    assert.deepEqual(sum(b).stops, ['s5: rows incomplete: depth 18 missing 0, capped 0; depth-22 candidates without both rows 1'], kind);
    assert.deepEqual([b.doc.cards, sum(b).threats.noThreat], [[], { 'd18:T4': 1, 'd22:missing': 1 }], kind);
  }
  // Not incomplete: a capped depth-22 row (the card is "unconfirmed"), no depth-22 rows for a card that is no
  // candidate, and rows for cards the pack does not hold.
  const capped = run({ ...s, rows22: s.rows22.map(r => (r.kind === 'after' ? { ...r, capped: true } : r)) });
  assert.deepEqual([sum(capped).stops, capped.doc.cards, sum(capped).threats.unconfirmed, sum(capped).threats.noThreat], [[], [], 1, { 'd18:T4': 1, 'd22:unconfirmed': 1 }]);
  assert.deepEqual(stops({ ...s, rows18: [...s.rows18, ...pair('pack-gone', A, 18)], rows22: [...s.rows22, ...pair('pack-gone', A, 22)] }), []);
  // The builder still returns its counts and decisions when a stop rule fires; the command line then writes no document.
  const stopped = run({ ...s, rows22: [] });
  assert.equal(stopped.decisions.length, 3);
  assert.equal(sum(stopped).rows.d22.missing, 1);
});

// Stop rule s6: every graded punish card needs a uniqueness verdict. In each test below the card's after row and uniq
// row are there and not capped, so stop rule s5 has nothing to report: before s6 the builder gave `stops: []` for all
// four and the command line wrote the document, with the card served unchecked.

/** Two graded punish cards on the invented position TAKE: 'punish-odd' with the given uniq row, 'punish-sound' with a sound one. */
const withUniq = (uniq: PassRow) => run({
  pack: packOf([], [punishCard('punish-odd', TAKE, 80), punishCard('punish-sound', TAKE, 80)]),
  rows18: [afterRow('punish-odd', TAKE.a), uniq, afterRow('punish-sound', TAKE.a), uniqRow('punish-sound', TAKE.a, UNIQUE(TAKE.a, TAKE.alt))],
  rows22: [],
});
/** s6 is the only stop; 'punish-odd' has no verdict and is not held; every planned row is there and none is capped. */
function stopsOnS6Alone(b: ReturnType<typeof run>, line: string, verdict: 'shallow' | 'no-row', label: string) {
  const s = sum(b);
  assert.deepEqual(s.stops, [line], label);
  assert.equal((b.decisions.find(d => d.id === 'punish-odd' && d.type === 'uniq') as Record<string, any>).verdict, verdict, label);
  assert.deepEqual([s.uniq.shallow, s.uniq.noRow], verdict === 'shallow' ? [1, 0] : [0, 1], label);
  assert.deepEqual([s.rows.d18.expected.uniq, s.rows.d18.found.uniq, s.rows.d18.missing, s.rows.d18.capped, s.rows.d22.missing], [2, 2, 0, 0, 0], `${label}: nothing for s5`);
  assert.deepEqual([b.doc.held, s.graded], [[], { total: 2, kept: 2, held: 0, holds: true }], `${label}: not held, so it would be served`);
}

test('stop rule s6: a uniq row that stopped under depth 16, not capped, gives no verdict', () => {
  // The second move is within 10 Win% points of the card's move: with a verdict, the card would be held as not unique.
  const close = [{ uci: TAKE.a, cp: 300 }, { uci: TAKE.alt, cp: 295 }];
  stopsOnS6Alone(withUniq(uniqRow('punish-odd', TAKE.a, close, { depthReached: 15 })), S6_SHALLOW, 'shallow', 'depth 15');
  stopsOnS6Alone(withUniq(uniqRow('punish-odd', TAKE.a, close, { depthReached: undefined })), S6_SHALLOW, 'shallow', 'no depth');
  // Depth 16 is enough: the verdict is there, the card is held, and nothing stops.
  const deep = withUniq(uniqRow('punish-odd', TAKE.a, close, { depthReached: 16 }));
  assert.deepEqual([sum(deep).stops, deep.doc.held], [[], [{ id: 'punish-odd', a: TAKE.a, why: 'not-unique', alt: TAKE.alt }]]);
  // A capped row is an incomplete row file as well: s5 and s6 both fire.
  const capped = sum(withUniq(uniqRow('punish-odd', TAKE.a, close, { capped: true, depthReached: 12 })));
  assert.deepEqual(capped.stops, ['s5: rows incomplete: depth 18 missing 0, capped 1; depth-22 candidates without both rows 0', S6_SHALLOW]);
});

test('stop rule s6: the card\'s move as the only line, with more than one legal move, gives no verdict', () => {
  const single = [{ uci: TAKE.a, cp: 300 }];
  stopsOnS6Alone(withUniq(uniqRow('punish-odd', TAKE.a, single, { legal: 2 })), S6_SHALLOW, 'shallow', 'two legal moves');
  stopsOnS6Alone(withUniq(uniqRow('punish-odd', TAKE.a, single)), S6_SHALLOW, 'shallow', 'twenty legal moves');
  stopsOnS6Alone(withUniq(uniqRow('punish-odd', TAKE.a, single, { legal: undefined })), S6_SHALLOW, 'shallow', 'no count of legal moves');
});

test('stop rule s6: a skipped uniq row gives no verdict', () => {
  // A reason code and no moves.
  stopsOnS6Alone(withUniq({ ...base('uniq', 'punish-odd', TAKE.a, 18), skipped: 'answer-illegal' }), S6_NO_ROW, 'no-row', 'skipped, no moves');
  // `skipped` decides, whatever else the row holds: a deep row with two moves far apart is still no verdict.
  stopsOnS6Alone(withUniq(uniqRow('punish-odd', TAKE.a, UNIQUE(TAKE.a, TAKE.alt), { skipped: 'answer-illegal' })), S6_NO_ROW, 'no-row', 'skipped, with moves');
});

test('stop rule s6: a uniq row without moves gives no verdict', () => {
  stopsOnS6Alone(withUniq(uniqRow('punish-odd', TAKE.a, [])), S6_NO_ROW, 'no-row', 'an empty top');
  stopsOnS6Alone(withUniq({ ...base('uniq', 'punish-odd', TAKE.a, 18), multipv: 3, legal: 20 }), S6_NO_ROW, 'no-row', 'no top');
  stopsOnS6Alone(withUniq(uniqRow('punish-odd', TAKE.a, [{ cp: 300 }, { cp: 50 }] as never)), S6_NO_ROW, 'no-row', 'a top that names no move');
});

test('stop rule s6, control: sound uniq rows give every graded card a verdict, and nothing stops', () => {
  // One graded card per verdict, each row at the lowest depth that counts: unique by the gap; unique as the one legal
  // move (a single line, `legal: 1`); not unique; not the engine's first.
  const cases: Array<[string, { fen: string; a: string }, PassRow, string]> = [
    ['punish-gap', TAKE, uniqRow('punish-gap', TAKE.a, UNIQUE(TAKE.a, TAKE.alt), { depthReached: 16 }), 'unique'],
    ['punish-forced', ONLY, uniqRow('punish-forced', ONLY.a, [{ uci: ONLY.a, cp: 600 }], { legal: 1, depthReached: 16 }), 'unique'],
    ['punish-close', TAKE, uniqRow('punish-close', TAKE.a, [{ uci: TAKE.a, cp: 300 }, { uci: TAKE.alt, cp: 295 }], { depthReached: 16 }), 'not-unique'],
    ['punish-other', TAKE, uniqRow('punish-other', TAKE.a, [{ uci: TAKE.alt, cp: 900 }, { uci: TAKE.a, cp: 100 }], { depthReached: 16 }), 'not-held'],
  ];
  const b = run({ pack: packOf([], cases.map(([id, pos]) => punishCard(id, pos, 80))), rows18: cases.flatMap(([id, pos, row]) => [afterRow(id, pos.a), row]), rows22: [] });
  const s = sum(b);
  assert.deepEqual(s.stops, []);
  for (const [id, , , want] of cases) assert.equal((b.decisions.find(d => d.id === id && d.type === 'uniq') as Record<string, any>).verdict, want, id);
  assert.deepEqual([s.uniq.shallow, s.uniq.noRow, s.uniq.oneLegalMove], [0, 0, 1]);
  assert.deepEqual([s.held, s.graded], [{ 'not-unique': 1, 'not-held': 1, total: 2, limit: 110 }, { total: 4, kept: 2, held: 2, holds: true }]);
  // The scenario of the four tests above with a sound row for 'punish-odd' too: no stop either.
  assert.deepEqual(sum(withUniq(uniqRow('punish-odd', TAKE.a, UNIQUE(TAKE.a, TAKE.alt)))).stops, []);
});

// ---------------------------------------------------------------- the command line

const SCRIPT = 'scripts/teach-to-docs.mjs';
/** Writes a scenario as the files the command line reads: a pack folder (meta and two chunks) and two row files. */
function writeInputs(dir: string, s: Scenario): { rows: string; rows22: string; pack: string } {
  const packDir = join(dir, 'pack');
  mkdirSync(packDir, { recursive: true });
  const meta = {
    packVersion: PACK_V, importedAt: 1_760_000_000_000, counts: { cards: s.pack.cards.length, punish: s.pack.punish.length }, priors: {},
    chunks: { cards: [`${PACK_V}-cards-01`], special: [], punish: [`${PACK_V}-punish-01`] },
  };
  writeFileSync(join(packDir, 'meta.json'), JSON.stringify(meta));
  writeFileSync(join(packDir, `${PACK_V}-cards-01.json`), JSON.stringify({ packVersion: PACK_V, part: 'cards', cards: s.pack.cards }));
  writeFileSync(join(packDir, `${PACK_V}-punish-01.json`), JSON.stringify({ packVersion: PACK_V, part: 'punish', cards: s.pack.punish }));
  const lines = (rows: PassRow[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(dir, 'rows18.jsonl'), lines(s.rows18));
  writeFileSync(join(dir, 'rows22.jsonl'), `${lines(s.rows22)}\nnot json\n`);
  return { rows: join(dir, 'rows18.jsonl'), rows22: join(dir, 'rows22.jsonl'), pack: packDir };
}
const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], { cwd: ARTIFACT_DIR, encoding: 'utf8', timeout: 300_000 });

test('command line: writes the five files, verifies them, and prints counts only', () => {
  const s = mainScenario();
  const dir = mkdtempSync(join(tmpdir(), 'm31-teach-'));
  const input = writeInputs(dir, s);
  const out = join(dir, 'seed_teach');
  const args = ['--rows', input.rows, '--rows22', input.rows22, '--pack', input.pack, '--out', out];
  const made = cli([...args, '--at', String(AT)]);
  assert.equal(made.status, 0, made.stderr);
  const expected = run(s);
  const read = (name: string) => readFileSync(join(out, name), 'utf8');
  // The folder: the README marks every file private.
  assert.deepEqual(readdirSync(out).sort(), ['.gitignore', 'README.txt', 'batches.json', 'decisions.private.jsonl', 'sentences.private.tsv', 'summary.json', 'teach']);
  assert.deepEqual(readdirSync(join(out, 'teach')), ['meta.json']);
  assert.equal(read('README.txt').split('\n')[0], 'PRIVATE');
  assert.equal(read('.gitignore'), '*\n');
  // teach/meta.json is the document, as compact JSON; the pack came through the page's loader.
  assert.equal(read('teach/meta.json'), JSON.stringify(expected.doc));
  // batches.json: one batch, one write, the path teach/meta.
  const batches = JSON.parse(read('batches.json'));
  assert.deepEqual([batches.packVersion, batches.teachVersion, batches.batches.length], [PACK_V, expected.doc.teachVersion, 1]);
  const bytes = statSync(join(out, 'teach', 'meta.json')).size;
  // The write names its file relative to the folder that holds batches.json, never by an absolute path.
  assert.deepEqual(batches.batches[0], { writes: [{ op: 'set', collection: 'teach', doc_id: 'meta', file_path: 'teach/meta.json', bytes }], bytes });
  assert.equal(`${batches.batches[0].writes[0].collection}/${batches.batches[0].writes[0].doc_id}`, TEACH_META_PATH);
  assert.ok(!('if_version' in batches.batches[0].writes[0]), 'a first seed can only create');
  // summary.json: the builder's counts, and that the document was written.
  const { written, forced, ...counts } = JSON.parse(read('summary.json'));
  assert.deepEqual([written, forced], [true, false]);
  assert.deepEqual(counts, JSON.parse(JSON.stringify(expected.summary)));
  // The private files: the sentences and the decisions of the build.
  assert.equal(read('sentences.private.tsv'), `id\tslot\ttext\n${expected.sentences.map(r => r.join('\t')).join('\n')}\n`);
  assert.deepEqual(read('decisions.private.jsonl').trim().split('\n').map(l => JSON.parse(l)), JSON.parse(JSON.stringify(expected.decisions)));
  // Printed: counts only. No card id, no move, no sentence.
  const printed = (made.stdout + made.stderr).split(dir).join('<dir>');   // the folder's own path is not output about a card
  assert.match(printed, /threats: pass at depth 18 19, stored 16, lost at depth 22 2, unconfirmed 1/);
  assert.match(printed, /depth 22 48 read \(1 unparsable lines\)/);
  for (const c of [...s.pack.cards, ...s.pack.punish]) assert.ok(!printed.includes(c.id), c.id);
  assert.doesNotMatch(printed, /\b[a-h][1-8][a-h][1-8][qrbn]?\b|Rxa5|Qxh7|threatens|prepares|Target:/);

  // --verify: rebuilds with the staged `at` and finds no difference; it writes nothing.
  const before = readdirSync(out).map(f => `${f}:${statSync(join(out, f)).mtimeMs}`).join('|');
  const same = cli([...args.slice(0, 6), '--verify', out]);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.match(same.stdout, /meta 0, batches 0, sentences 0, decisions 0, summary 0 -> 0 differences/);
  assert.equal(readdirSync(out).map(f => `${f}:${statSync(join(out, f)).mtimeMs}`).join('|'), before);
  // A staged file that was changed by hand is found: one entry of the document, one count of the summary.
  const metaText = read('teach/meta.json'), summaryText = read('summary.json');
  writeFileSync(join(out, 'teach', 'meta.json'), metaText.replace('"sq":"a5"', '"sq":"a6"'));
  writeFileSync(join(out, 'summary.json'), summaryText.replace('"quiet": 28', '"quiet": 27'));
  const differs = cli([...args.slice(0, 6), '--verify', out]);
  assert.equal(differs.status, 1, differs.stdout);
  assert.match(differs.stdout, /meta 1, batches 0, sentences 0, decisions 0, summary 1 -> 2 differences/);
  writeFileSync(join(out, 'teach', 'meta.json'), metaText);
  writeFileSync(join(out, 'summary.json'), summaryText);

  // A stop rule: exit 1, counts and decisions written, NO document; the one from the earlier run is renamed aside.
  writeFileSync(input.rows22, s.rows22.filter(r => r.id !== 'pack-cap').map(r => JSON.stringify(r)).join('\n'));
  const stopped = cli([...args, '--at', String(AT)]);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stdout, /STOP s5: rows incomplete: depth 18 missing 0, capped 0; depth-22 candidates without both rows 1/);
  assert.match(stopped.stderr, /NOT WRITTEN: 1 stop rule fired/);
  assert.equal(existsSync(join(out, 'teach', 'meta.json')), false);
  assert.equal(existsSync(join(out, 'batches.json')), false);
  assert.equal(existsSync(join(out, 'sentences.private.tsv')), false);
  assert.equal(readdirSync(join(out, 'teach')).filter(f => /^meta\.json\.superseded-/.test(f)).length, 1);
  assert.equal(readdirSync(out).filter(f => /^(batches\.json|sentences\.private\.tsv)\.superseded-/.test(f)).length, 2);
  const stoppedSummary = JSON.parse(read('summary.json'));
  assert.deepEqual([stoppedSummary.written, stoppedSummary.forced, stoppedSummary.stops.length, stoppedSummary.threats.noThreat['d22:missing']], [false, false, 1, 1]);
  assert.equal(read('decisions.private.jsonl').trim().split('\n').length, expected.decisions.length);
  // --verify against the stopped folder also fails: the stop rule fires on the rebuild.
  assert.equal(cli([...args, '--at', String(AT), '--verify', out]).status, 1);
  // --force-stop-rules (the lead's only) writes the document anyway and says so.
  const forcedRun = cli([...args, '--at', String(AT), '--force-stop-rules']);
  assert.equal(forcedRun.status, 0, forcedRun.stderr);
  assert.match(forcedRun.stdout, /FORCED past the stop rules/);
  const forcedSummary = JSON.parse(read('summary.json'));
  assert.deepEqual([forcedSummary.written, forcedSummary.forced, existsSync(join(out, 'teach', 'meta.json'))], [true, true, true]);
  assert.equal(JSON.parse(read('teach/meta.json')).cards.some((c: { id: string }) => c.id === 'pack-cap'), false);
});

test('command line: a usage or input problem exits 2 and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm31-teach-'));
  const input = writeInputs(dir, tiny());
  const out = join(dir, 'out');
  const usage = cli([]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^usage: node --import tsx scripts\/teach-to-docs\.mjs --rows /);
  const cases: string[][] = [
    ['--rows', input.rows, '--rows22', input.rows22, '--out', out],                                              // no --pack
    ['--rows', join(dir, 'absent.jsonl'), '--rows22', input.rows22, '--pack', input.pack, '--out', out],        // no such rows file
    ['--rows', input.rows, '--rows22', input.rows22, '--pack', join(dir, 'nopack'), '--out', out],              // no pack meta
    ['--rows', input.rows, '--rows22', input.rows22, '--pack', input.pack, '--out', out, '--at', 'yesterday'],  // not a time
    ['--rows', input.rows, '--rows22', input.rows22, '--pack', input.pack, '--verify'],                         // --verify needs a folder
  ];
  for (const args of cases) assert.equal(cli(args).status, 2, args.join(' '));
  assert.equal(existsSync(out), false);
  // --verify of a folder that holds no document: exit 1, nothing written.
  const none = cli(['--rows', input.rows, '--rows22', input.rows22, '--pack', input.pack, '--verify', out]);
  assert.equal(none.status, 1);
  assert.equal(existsSync(out), false);
});

test('command line: stop rule s6 exits 1 and writes no document', () => {
  // tiny(), with the uniq row of its graded punish card skipped: every planned row is there and none is capped, so
  // s5 has nothing to report.
  const s = tiny();
  const dir = mkdtempSync(join(tmpdir(), 'm31-teach-'));
  const input = writeInputs(dir, { ...s, rows18: s.rows18.map(r => (r.kind === 'uniq' ? { ...r, skipped: 'answer-illegal' } : r)) });
  const out = join(dir, 'seed_teach');
  const stopped = cli(['--rows', input.rows, '--rows22', input.rows22, '--pack', input.pack, '--out', out, '--at', String(AT)]);
  assert.equal(stopped.status, 1, stopped.stdout + stopped.stderr);
  assert.deepEqual(stopped.stdout.split('\n').filter(line => line.startsWith('STOP ')), [`STOP ${S6_NO_ROW}`]);
  assert.match(stopped.stderr, /NOT WRITTEN: 1 stop rule fired/);
  assert.equal(existsSync(join(out, 'teach', 'meta.json')), false);
  assert.equal(existsSync(join(out, 'batches.json')), false);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.deepEqual([summary.written, summary.forced, summary.stops, summary.uniq.noRow, summary.rows.d18.missing, summary.rows.d18.capped], [false, false, [S6_NO_ROW], 1, 0, 0]);
});

test('command line: batches.json names its file relative to its own folder, so a moved seed folder verifies clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm31-teach-'));
  const input = writeInputs(dir, tiny());
  const args = ['--rows', input.rows, '--rows22', input.rows22, '--pack', input.pack];
  // Built as seed_teach/next, as scripts/ingest.md section D does for a replacement.
  const next = join(dir, 'seed_teach', 'next');
  const made = cli([...args, '--out', next, '--at', String(AT)]);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  const text = readFileSync(join(next, 'batches.json'), 'utf8');
  const w = JSON.parse(text).batches[0].writes[0] as { file_path: string; bytes: number };
  assert.equal(w.file_path, 'teach/meta.json');
  assert.ok(!isAbsolute(w.file_path) && !text.includes(dir), 'no absolute path: batches.json holds nothing of the folder it was built in');
  assert.equal(statSync(join(next, w.file_path)).size, w.bytes, 'joined to the folder of batches.json, it is the document');
  // Moved: no file is edited, and --verify of the folder in its new place finds no difference.
  const moved = join(dir, 'moved', 'seed_teach');
  mkdirSync(dirname(moved), { recursive: true });
  renameSync(next, moved);
  assert.equal(existsSync(next), false);
  assert.equal(readFileSync(join(moved, 'batches.json'), 'utf8'), text);
  const verified = cli([...args, '--verify', moved]);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.match(verified.stdout, /meta 0, batches 0, sentences 0, decisions 0, summary 0 -> 0 differences/);
  assert.equal(statSync(join(moved, w.file_path)).size, w.bytes);
});

// ---------------------------------------------------------------- the builder stays out of the page bundle

/** Import, export-from, dynamic import and require specifiers of a source file (comments removed first). */
function specifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"\n]+)['"]/g)) found.add(m[1]);
  for (const m of text.matchAll(/\b(?:import|require)\(\s*['"]([^'"\n]+)['"]\s*\)/g)) found.add(m[1]);
  return [...found];
}
/** The file a relative or `@/` specifier names, or null for a package. Throws when a local import cannot be found. */
function resolveLocal(from: string, spec: string): string | null {
  const start = spec.startsWith('@/') ? join(ARTIFACT_DIR, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  if (!start) return null;
  for (const tail of ['', '.ts', '.tsx', '.js', '.mjs', '.json', '/index.ts', '/index.tsx']) {
    const candidate = start + tail;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${relative(ARTIFACT_DIR, from)} imports ${spec}, which was not found`);
}
/** Every local source file reachable from `entry` through imports (type-only imports included: the wider set). */
function reach(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>(), packages = new Set<string>(), queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
    for (const spec of specifiers(file)) {
      const target = resolveLocal(file, spec);
      if (target) queue.push(target); else packages.add(spec);
    }
  }
  return { files, packages };
}
const rel = (file: string) => relative(ARTIFACT_DIR, file);
const BUILDER = join(ARTIFACT_DIR, 'src', 'importers', 'teachDocs.ts');

test('bundle: nothing the page imports reaches the builder', () => {
  // scripts/build.mjs bundles from src/main.tsx (the frozen build script names it as its entry point).
  assert.match(readFileSync(join(ARTIFACT_DIR, 'scripts', 'build.mjs'), 'utf8'), /entryPoints: \['src\/main\.tsx'\]/);
  const page = reach(join(ARTIFACT_DIR, 'src', 'main.tsx'));
  const names = [...page.files].map(rel);
  // The walk is real: it reaches the page's own modules, the 7.1 contract among them.
  for (const expected of ['components/Trainer.tsx', 'components/model.ts', 'components/pools.ts', 'src/contract/docs.ts', 'src/contract/teachDocs.ts', 'src/teach/hints.ts', 'src/teach/narrate.ts']) {
    assert.ok(names.includes(expected), `the page reaches ${expected}`);
  }
  assert.ok(names.length > 30);
  // The builder, and the importer folder's teach file under any spelling, are not among them.
  assert.equal(page.files.has(BUILDER), false);
  assert.deepEqual(names.filter(n => /(^|\/)importers\/teachDocs\./.test(n)), []);
  for (const file of page.files) {
    if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
    for (const spec of specifiers(file)) assert.doesNotMatch(spec, /importers\/teachDocs/, `${rel(file)} imports the builder`);
  }
  // No page file imports the builder's script either.
  assert.deepEqual(names.filter(n => n.startsWith('scripts/')), []);
});

test('bundle: only the command line and the tests import the builder; the page modules of 7.1 need nothing from Node', () => {
  // Every source file under components/, src/, lib/ and scripts/: who names the builder?
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) sources.push(full);
    }
  };
  for (const dir of ['components', 'src', 'lib', 'scripts']) if (existsSync(join(ARTIFACT_DIR, dir))) walk(join(ARTIFACT_DIR, dir));
  const importers = sources.filter(f => f !== BUILDER && specifiers(f).some(spec => { try { return resolveLocal(f, spec) === BUILDER; } catch { return false; } }));
  assert.deepEqual(importers.map(rel), ['scripts/teach-to-docs.mjs']);
  // The marker is a string of the builder alone, so finding it in a bundle would prove the builder got in.
  assert.match(TEACH_BUILDER_MARK, /^next-move-teach-builder-[0-9a-f]{8}: /);
  assert.deepEqual(sources.filter(f => readFileSync(f, 'utf8').includes(TEACH_BUILDER_MARK.slice(0, 32))).map(rel), ['src/importers/teachDocs.ts']);
  // The two modules the page does import are browser code: no Node module, no importer, no component, and the
  // module graph the brief pins (hints.ts and punish.ts do not import threat.ts).
  for (const name of ['src/teach/threat.ts', 'src/contract/teachDocs.ts']) {
    const graph = reach(join(ARTIFACT_DIR, name));
    assert.deepEqual([...graph.packages].filter(p => p.startsWith('node:') || ['fs', 'path', 'crypto', 'child_process', 'os'].includes(p)), [], name);
    assert.deepEqual([...graph.files].map(rel).filter(n => /^src\/importers\/|^components\/|^scripts\//.test(n)), [], name);
  }
  for (const name of ['src/teach/hints.ts', 'src/teach/punish.ts']) {
    const graph = reach(join(ARTIFACT_DIR, name));
    assert.equal(graph.files.has(join(ARTIFACT_DIR, 'src', 'teach', 'threat.ts')), false, `${name} does not import threat.ts`);
  }
});
