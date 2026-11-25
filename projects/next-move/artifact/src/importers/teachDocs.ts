/**
 * Engine pass rows -> the document `teach/meta` (brief m31, sections 3.3 to 3.6). `scripts/teach-to-docs.mjs` does the
 * file IO. OFFLINE ONLY: the page never imports this file, so nothing here reaches the page bundle (a test walks the
 * page's import graph, and the check searches the bundle for `TEACH_BUILDER_MARK`).
 *
 * Pure and deterministic: the same rows, pack and `at` give the same document, byte for byte. No wall clock.
 *
 * Inputs
 * - `rows18`, `rows22`: the rows of `reviews/claude/tools/m31/teach_pass.mjs` at depth 18 and at depth 22 (the row
 *   format is in that file's header). The LAST row per card id and kind counts. A row that names another answer than
 *   the card's move, or another pack version than the pack given, is not a row of this card.
 * - `pack`: the pack as the page loads it (`assemblePack`). The cards are the ones the page serves or lists:
 *   mistake cards (class `pack`), graded punish cards (class `punish`) and small-edge cards, exactly as `buildPools`
 *   sorts them.
 *
 * THE FROZEN RULE (`reviews/claude/logs/m31_rule_frozen.md`, the authority; `threatGates` below, one gate per name).
 * F = the card position; a = the answer; P = the pass position (`passFen`); T = the threat row's line from P; L = the
 * card's stored answer line as the page shows it (`punishAnswerLine`); net = the narrator's `material.net` for the
 * solver, narrated as a line viewer narrates (`narrateAsViewer`); m(row) = centipawns from the solver's view, a forced
 * mate counting +1000 for the solver and -1000 against.
 * - T0 usable: a is quiet; the threat row exists and is not `skipped`; both rows reached depth 16 or more and neither
 *   is capped; the after row is not a forced mate for the solver.
 * - T1 no zugzwang ground: the side that passes has a knight, bishop, rook or queen.
 * - T2 forcing start: T[0] is a capture, a check or a promotion, or the shown line is mate by the solver.
 * - T3 concrete: the WHOLE line T ends in mate by the solver, or settled with a net of at least 1. The shown line is
 *   the first prefix of T that is mate by the solver, or settled with a net g, 1 <= g <= net(T).
 * - T4 worth a move: the threat row is a forced mate for the solver, or m(threat) - m(after) >= 100; both rows from
 *   the same run at the same depth.
 * - T5 more than the stored line: the shown line is mate, or net(shown) >= net(L) + 1.
 * - Both depths: a threat is stored only if T0 to T5 pass on the depth-18 rows AND on the depth-22 rows of the same
 *   card. The stored line and its facts come from the depth-22 rows. A capped depth-22 row is never a failure: the
 *   card gets no threat and is counted as "unconfirmed".
 * Not gates: a "can take" clause in a sentence, a Win% margin, a score test on the closing sentence.
 *
 * The facts stored (3.4), each computed with the page's own functions: `k` and `pre` by `readThreat`; `sq` = the most
 * valuable enemy piece the shown line wins net after trades cancel (`replayLine`, `netWonCaptures`), on its square in
 * the card position; `r` and `pin` by `targetReason`, read on the card position AND on the pass position.
 *
 * The reason (brief section 10, 17:14, finding F-1; it replaces 3.4's "read on F, never on P"): `r` and `pin` are
 * stored only when `targetReason` gives the SAME reason on F and on P: the same `r`, and for 'pinned' the same king
 * square. Otherwise both are left out and `sq` stays. The page states a stored reason in a hint, on the card, and in
 * the paragraph after the card, where the answer has been played, so it has to be true in both positions. A reason
 * the answer creates (a pin it makes) is never stored; a reason the answer undoes (a pin line it closes, a defender
 * it lets through) is not stored either.
 *
 * Uniqueness (3.5, item D), from the depth-18 `uniq` row of each graded punish card, by the producer's own rule
 * (`lineWin`, `UNIQUE_GAP`, imported from `packDocs.ts`): the card's move is not the engine's first -> held,
 * 'not-held'; the gap between the first two moves is under 10 -> held, 'not-unique', `alt` = the second move; one
 * legal move -> unique. No verdict (the card would be served unchecked): a capped row, one under depth 16 or without a
 * depth, or the card's move as the only line while the row's `legal` is not 1 (`uniqShallow`); no row, a `skipped`
 * row or a row without moves (`uniqMissing`). Both counts must be 0 (stop rule s6). Small-edge cards get no verdict.
 * A depth-22 row never changes a verdict.
 *
 * Every entry is dry-run through the page module (`threatFacts`, `applyThreatHints`, `threatSay`); an entry the page
 * would not use as stored is left out and counted (stop rule s4). The finished document is then read by the page's
 * reader and joined by the page's own pools (`readTeachMeta`, `loadTeach`, `buildPools`): every entry must reach its
 * card, every held card must leave every pool, and the Win% classes must keep their counts (s4 as well).
 *
 * Stop rules (`summary.stops`; the CLI then exits 1 and writes no document): s1 more than 110 held; s2 of the cards
 * that pass T0 to T5 at depth 18 with a margin of 150 or more or a mate threat, more than 3% fail T4 at depth 22;
 * s3 the document is over 150 KiB; s4 the page module rejects an entry; s5 a row file is incomplete (a missing or
 * capped depth-18 row, a depth-22 candidate without both rows); s6 a graded punish card has no uniqueness verdict
 * (`uniqShallow` or `uniqMissing` above 0). s5 does not see a `uniq` row that is there and not capped but shallow,
 * single-line, `skipped` or without moves; a graded card's missing or capped `uniq` row fires both.
 *
 * Privacy: `doc`, `sentences` and `decisions` hold card ids and moves from the owner's games; `summary` holds counts
 * only. Nothing here prints.
 */
import { createHash } from 'node:crypto';
import { Chess, type Square } from 'chess.js';
import { docBytes } from '../contract/docs';
import {
  readTeachMeta, TEACH_FORMAT, TEACH_MAX_BYTES, teachHeldSchema, teachThreatSchema, type TeachHeld, type TeachMetaDoc, type TeachThreat,
} from '../contract/teachDocs';
import { lineWin, UNIQUE_GAP } from './packDocs';
import { buildPools, isPunish, type TrainerItem } from '../../components/pools';
import { loadTeach, type LoadedPack } from '../../components/model';
import { hintLadderFor } from '../../components/Trainer';
import { netWonCaptures, replayLine } from '../teach/hints';
import { playUci } from '../teach/narrate';
import { punishAnswerLine } from '../teach/punish';
import { PIECE_VALUE, type PieceType, type Side } from '../teach/values';
import {
  almostAsHighly, applyThreatHints, narrateAsViewer, passFen, readThreat, targetReason, threatFacts, threatSay, THREAT_MAX_PLIES, type ThreatKind,
} from '../teach/threat';

/** A string only this file holds. The check searches the page bundle for it: it must not be there. */
export const TEACH_BUILDER_MARK = 'next-move-teach-builder-7f3a91c2: offline only, never in the page bundle';

/** T0: the lowest depth a row may have reached. */
export const MIN_DEPTH = 16;
/** T4: the margin, in centipawns. */
export const MARGIN_CP = 100;
/** s2: a "strong" depth-18 pass has this margin or a mate threat. */
export const STRONG_MARGIN_CP = 150;
/** s2: the share of strong depth-18 passes that may fail T4 at depth 22. */
export const MAX_LOST_SHARE = 0.03;
/** s1: the most cards that may be held. */
export const MAX_HELD = 110;

/** One row of the engine pass (`teach_pass.mjs`, row format 1). Only `id` and `kind` are always there. */
export interface PassRow {
  id: string;
  /** 'uniq' | 'after' | 'threat' */
  kind: string;
  v?: number; cls?: string; pack?: string; engine?: string;
  depthAsked?: number; depthReached?: number; ms?: number; nodes?: number;
  capped?: boolean; skipped?: string; terminal?: string | null;
  solver?: string; ans?: string; ansSan?: string;
  /** after and threat: the engine's line (UCI), its score from the SOLVER's view (cp or mate) and Win%. */
  line?: string[]; lineSan?: string[]; lineCut?: boolean; cp?: number | null; mate?: number | null; win?: number;
  quietWhy?: unknown;
  /** uniq: the top moves, best first, each with its score for the side to move. */
  multipv?: number; legal?: number;
  top?: Array<{ uci: string; san?: string; cp?: number | null; mate?: number | null; win?: number }>;
  ansRank?: number | null; gap?: number | null; gapApp?: number | null; gapRule?: number | null;
}

type Cls = 'pack' | 'punish' | 'small-edge';
const GATES = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5'] as const;
/** The order a card's first failure is reported in. `replay`: the row's line is not legal from the pass position. */
const FAIL_ORDER = ['T0', 'T1', 'replay', 'T2', 'T3', 'T4', 'T5'] as const;
type Fail = (typeof FAIL_ORDER)[number];
const KINDS: ThreatKind[] = ['mate', 'check', 'capture', 'promotion'];

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const round2 = (x: number) => Math.round(x * 100) / 100;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const other = (c: Side): Side => (c === 'w' ? 'b' : 'w');
function load(fen: string): Chess | null {
  try { return new Chess(fen); } catch { return null; }
}

/** JSON with every object's keys in code-unit order and no white space: one text per value. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort(cmp).map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
/** `t<yyyymmdd>-<first 8 hex of the sha256 of the canonical JSON of { cards, held }>`; the day is `at` in UTC. */
export function teachVersionOf(at: number, cards: readonly TeachThreat[], held: readonly TeachHeld[]): string {
  const day = new Date(at).toISOString().slice(0, 10).replace(/-/g, '');
  return `t${day}-${createHash('sha256').update(canonicalJson({ cards, held })).digest('hex').slice(0, 8)}`;
}

/** m(row): centipawns from the solver's view; a forced mate counts +1000 for the solver and -1000 against. */
export function rowScore(row: PassRow | undefined): number | null {
  if (!row) return null;
  if (row.terminal === 'checkmate') return 1000;
  if (num(row.mate)) return row.mate > 0 ? 1000 : -1000;
  return num(row.cp) ? row.cp : null;
}
const forcedMate = (row: PassRow | undefined) => !!row && (row.terminal === 'checkmate' || (num(row.mate) && row.mate > 0));

/** Is the answer legal and quiet, by the driver's definition: no capture (en passant included), no promotion, no check? */
function quietAnswer(fen: string, uci: string): boolean {
  const board = load(fen);
  const mv = board ? playUci(board, uci) : null;
  return !!board && !!mv && !mv.captured && !mv.promotion && !board.isCheck();
}

export interface GateResult {
  T0: boolean; T1: boolean; T2: boolean; T3: boolean; T4: boolean; T5: boolean;
  /** Every gate passed and the line replays. */
  pass: boolean;
  /** The first failure in the order T0, T1, replay, T2, T3, T4, T5; null when everything passed. */
  fail: Fail | null;
  /** Why T0 failed (a fixed code), when it did. */
  t0?: string;
  /** m(threat) - m(after); null without both scores. */
  margin: number | null;
  /** The threat row is a forced mate for the solver. */
  mateThreat: boolean;
  /** The row's whole line is legal from the pass position. */
  replays: boolean;
  /** Plies in T, and in the shown line. */
  plies: number; shownPlies: number;
  netT: number | null; netShown: number | null; netL: number | null;
  /** The shown line (UCI) when T3 passes. */
  shown: string[] | null;
  /** The shown line ends in mate by the solver. */
  shownMate: boolean;
}

/**
 * The frozen rule on one card at one depth: `after` and `threat` are that depth's two rows of the card (header
 * comment). Each gate is judged on its own where it can be, so a decision record shows every gate's result.
 */
export function threatGates(card: { fen: string; moves: readonly string[]; pack?: object | null }, after: PassRow | undefined, threat: PassRow | undefined): GateResult {
  const a = card.moves[0];
  const pass = typeof a === 'string' ? passFen(card.fen, a) : null;
  const board = pass ? load(pass) : null;
  const solver = (board?.turn() ?? 'w') as Side;
  const depthOk = (r: PassRow) => num(r.depthReached) && r.depthReached >= MIN_DEPTH;

  // T0 usable.
  let t0: string | undefined;
  if (!pass || !board) t0 = 'not-quiet';
  else if (!threat) t0 = 'no-threat-row';
  else if (threat.skipped) t0 = 'skipped';
  else if (!after) t0 = 'no-after-row';
  else if (after.skipped) t0 = 'after-skipped';
  else if (threat.capped || after.capped) t0 = 'capped';
  else if (!depthOk(threat) || !depthOk(after)) t0 = 'shallow';
  else if (forcedMate(after)) t0 = 'mate-anyway';
  const T0 = !t0;

  // T1 no zugzwang ground: the side that passes has a knight, bishop, rook or queen.
  const T1 = !!board && board.board().some(rank => rank.some(p => !!p && p.color !== solver && p.type !== 'k' && p.type !== 'p'));

  // The line T (up to 8 plies, solver first), narrated from P as a line viewer narrates it.
  const T = pass && threat && !threat.skipped && Array.isArray(threat.line) ? threat.line.filter((u): u is string => typeof u === 'string').slice(0, THREAT_MAX_PLIES) : [];
  const whole = pass && T.length ? narrateAsViewer(pass, T) : null;
  const replays = !!whole && whole.plies.length === T.length;
  const mateBy = (n: NonNullable<typeof whole>) => n.result === 'mate' && n.plies[n.plies.length - 1]?.color === solver;
  const netT = replays ? whole!.material.net : null;

  // T3 concrete, on the whole line; then the shown line: the first prefix that is mate, or settled with 1 <= g <= net(T).
  let shown: string[] | null = null, shownMate = false, netShown: number | null = null;
  const wholeOk = replays && (mateBy(whole!) || (whole!.material.settled && whole!.material.net >= 1));
  if (wholeOk && pass) {
    for (let k = 1; k <= T.length && !shown; k++) {
      const n = k === T.length ? whole! : narrateAsViewer(pass, T.slice(0, k));
      if (n.plies.length !== k) break;
      const mate = mateBy(n);
      if (mate || (n.material.settled && n.material.net >= 1 && n.material.net <= (netT as number))) {
        shown = T.slice(0, k); shownMate = mate; netShown = n.material.net;
      }
    }
  }
  const T3 = wholeOk && !!shown;

  // T2 forcing start: T[0] is a capture, a check or a promotion, or the shown line is mate by the solver.
  let forcing = false;
  if (replays && pass) {
    const b = load(pass);
    const mv = b ? playUci(b, T[0]) : null;
    forcing = !!b && !!mv && (!!mv.captured || !!mv.promotion || b.isCheck());
  }
  const T2 = forcing || (!!shown && shownMate);

  // T4 worth a move: a forced mate for the solver, or a margin of 100 centipawns; both rows from one run.
  const mt = rowScore(threat), ma = rowScore(after);
  const margin = mt !== null && ma !== null && !threat?.skipped ? mt - ma : null;
  const mateThreat = !!threat && !threat.skipped && forcedMate(threat);
  const sameRun = !!threat && !!after && threat.depthAsked === after.depthAsked;
  const T4 = sameRun && (mateThreat || (margin !== null && margin >= MARGIN_CP));

  // T5 more than the stored line: the shown line is mate, or net(shown) >= net(L) + 1.
  const L = punishAnswerLine(card);
  const netL = L.length ? narrateAsViewer(card.fen, L).material.net : 0;
  const T5 = !!shown && (shownMate || (netShown as number) >= netL + 1);

  const gates = { T0, T1, T2, T3, T4, T5 };
  const fail: Fail | null = !T0 ? 'T0' : !T1 ? 'T1' : !replays ? 'replay' : !T2 ? 'T2' : !T3 ? 'T3' : !T4 ? 'T4' : !T5 ? 'T5' : null;
  return {
    ...gates, pass: fail === null, fail, ...(t0 ? { t0 } : {}), margin, mateThreat, replays, plies: T.length, shownPlies: shown?.length ?? 0,
    netT, netShown, netL, shown, shownMate,
  };
}

/**
 * The entry of a card for a shown line, with the facts of 3.4 and the reason by the rule of section 10, 17:14 (header
 * comment: the same on the card and after the answer); null when the page cannot read the line.
 */
export function threatEntry(card: { id: string; fen: string; moves: readonly string[] }, shown: readonly string[]): TeachThreat | null {
  const a = card.moves[0];
  const read = readThreat(card.fen, a, shown);
  if (!read) return null;
  let sq: string | undefined, r: string | undefined, pin: string | undefined;
  if (read.k !== 'mate') {
    // The most valuable enemy piece the shown line wins net, after trades cancel, on its square at the start of the
    // line (the pass position), which is its square on the card: a quiet answer moves no enemy piece.
    const won = netWonCaptures(replayLine(narrateAsViewer(read.passFen, read.line)).captures, read.solver);
    const best = [...won].sort((x, y) => PIECE_VALUE[y.piece] - PIECE_VALUE[x.piece] || x.ply - y.ply)[0];
    const there = best ? load(card.fen)?.get(best.origin as Square) : undefined;
    if (best && there && there.color === other(read.solver) && there.type !== 'k' && there.type === best.piece && !read.answerSquares.includes(best.origin)) {
      sq = best.origin;
      // The reason, read on the card position and on the pass position (the answer played, the move handed back).
      // Stored only when both readings are the same: the same `r`, and for 'pinned' the same king square. So a reason
      // the answer makes (not on the card) and a reason the answer undoes (not after it) both stay out; `sq` stays.
      const onCard = targetReason(card.fen, sq), afterAnswer = targetReason(read.passFen, sq);
      if (onCard && afterAnswer && onCard.r === afterAnswer.r) {
        if (onCard.r !== 'pinned') r = onCard.r;
        else if (afterAnswer.r === 'pinned' && onCard.pin === afterAnswer.pin) { r = onCard.r; pin = onCard.pin; }
      }
    }
  }
  return { id: card.id, a, t: read.line, k: read.k, ...(sq ? { sq } : {}), ...(r ? { r } : {}), ...(pin ? { pin } : {}), pre: read.pre };
}

/** Does the page module read this entry exactly as it is stored (the dry run of 3.6)? */
function pageAccepts(item: TrainerItem, entry: TeachThreat): boolean {
  if (!teachThreatSchema.safeParse(entry).success) return false;
  const card = { ...item, teach: entry };
  const f = threatFacts(card), say = threatSay(card);
  if (!f || !say) return false;
  if (f.k !== entry.k || f.pre !== entry.pre || !same(f.line, entry.t) || !same(say.viewer.line, entry.t) || say.viewer.fen !== f.passFen) return false;
  if (entry.k === 'mate' ? !f.target || f.target.piece !== 'k' : (f.target?.square ?? undefined) !== entry.sq) return false;
  if (entry.r === 'pinned') return f.reason?.kind === 'pinned' && f.reason.to === entry.pin;
  return entry.r === 'undefended' ? f.reason?.kind === 'undefended' : !f.reason;
}

/** The material balance on the board for `side`, in pawns (kings count nothing). */
function balance(board: Chess, side: Side): number {
  let n = 0;
  for (const rank of board.board()) for (const p of rank) if (p) n += (p.color === side ? 1 : -1) * PIECE_VALUE[p.type as PieceType];
  return n;
}
const WORD_COUNT: Record<string, number> = { a: 1, the: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
const NAME_VALUE: Record<string, number> = { queen: 9, rook: 5, bishop: 3, knight: 3, pawn: 1 };
/**
 * What a settled closing sentence states, in pawns for the side it names: "White wins the queen and a pawn for a
 * bishop." = 9 + 1 - 3; "White promotes a pawn to a queen for a knight." = 8 - 3; "..., though Black promotes a pawn
 * to a queen" = - 8. Null when the sentence is not of that form. Reads the sentence only: no board, no narrator.
 */
export function statedNet(sentence: string): { side: 'White' | 'Black'; net: number } | null {
  const m = /^(White|Black) (wins|promotes) (.+)\.$/.exec(sentence);
  if (!m) return null;
  const pieces = (text: string, promoted: boolean) => {
    let n = 0;
    for (const p of text.matchAll(/\b(a|the|two|three|four|five|six|seven|eight) (queen|rook|bishop|knight|pawn)s?\b/g)) n += WORD_COUNT[p[1]] * (NAME_VALUE[p[2]] - (promoted ? 1 : 0));
    return n;
  };
  // "promotes {pawns} to {new pieces}": only the part after " to " counts, each new piece less the pawn it was.
  const clause = (text: string): number | null => {
    let n = 0;
    for (const part of text.split(/\b(?=wins |for |promotes )/)) {
      if (part.startsWith('wins ')) n += pieces(part, false);
      else if (part.startsWith('for ')) n -= pieces(part, false);
      else if (part.startsWith('promotes ') && part.includes(' to ')) n += pieces(part.slice(part.indexOf(' to ') + 4), true);
      else if (part.trim()) return null;
    }
    return n;
  };
  const [own, theirs] = `${m[2]} ${m[3]}`.split(/, though (?:White|Black) /);
  const mine = clause(own), against = theirs === undefined ? 0 : clause(theirs.replace(/^also /, ''));
  if (mine === null || against === null) return null;
  return { side: m[1] as 'White' | 'Black', net: mine - against };
}

/** The closing sentence of a stored line against the board: does it state what the pieces say? */
function closingAgrees(pass: string, entry: TeachThreat, solver: Side): boolean {
  const board = load(pass);
  if (!board) return false;
  const before = balance(board, solver);
  for (const u of entry.t) if (!playUci(board, u)) return false;
  const summary = narrateAsViewer(pass, entry.t).summary;
  const name = solver === 'w' ? 'White' : 'Black';
  if (entry.k === 'mate') return board.isCheckmate() && board.turn() !== solver && summary === `The line ends in checkmate by ${name}.`;
  const stated = statedNet(summary);
  return !!stated && stated.side === name && stated.net >= 1 && stated.net === balance(board, solver) - before;
}

export interface TeachBuild {
  doc: TeachMetaDoc;
  /** Counts only. `stops` lists the stop rules that fired. */
  summary: Record<string, unknown> & { stops: string[] };
  /** One row per card and sentence the page can show from the document: [card id, slot, text]. */
  sentences: string[][];
  /** One record per quiet card (every gate at both depths) and per graded punish card (the verdict). */
  decisions: Array<Record<string, unknown>>;
}

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map(k => [k, 0])) as Record<K, number>;
const band = (g: GateResult) => (g.mateThreat ? 'mate' : (g.margin as number) >= 300 ? '300+' : (g.margin as number) >= STRONG_MARGIN_CP ? '150-299' : '100-149');
const BANDS = ['100-149', '150-299', '300+', 'mate'] as const;

/** Rows -> the document, the counts, the sentences and the decisions (header comment). */
export function buildTeachDocs(input: { rows18: PassRow[]; rows22: PassRow[]; pack: LoadedPack; at: number }): TeachBuild {
  const { pack, at } = input;
  if (!num(at) || at < 0) throw new TypeError('buildTeachDocs: `at` must be a time in epoch milliseconds.');

  // ---- the cards the page serves or lists, as the engine pass planned them
  const pools = buildPools({ bank: [], endgames: [], pack, personal: [], drills: [] });
  const cards: Array<{ item: TrainerItem; cls: Cls; quiet: boolean }> = [
    ...pools.own.filter(p => !isPunish(p)).map(item => ({ item, cls: 'pack' as Cls })),
    ...pools.own.filter(isPunish).map(item => ({ item, cls: 'punish' as Cls })),
    ...pools.smallEdge.map(item => ({ item, cls: 'small-edge' as Cls })),
  ].map(c => ({ ...c, quiet: quietAnswer(c.item.fen, c.item.moves[0]) }));
  const byId = new Map(cards.map(c => [c.item.id, c]));

  // ---- rows: the last one per id and kind; a row for another answer or another pack is not this card's row
  const index = (rows: readonly PassRow[]) => {
    const last = new Map<string, PassRow>();
    let lines = 0, repeated = 0, stale = 0, extra = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.kind !== 'string') continue;
      lines++;
      const key = `${r.kind}\t${r.id}`;
      if (last.has(key)) repeated++;
      last.set(key, r);
    }
    for (const [key, r] of [...last]) {
      const card = byId.get(r.id);
      if (!card) { extra++; last.delete(key); continue; }
      if ((typeof r.ans === 'string' && r.ans !== card.item.moves[0]) || (typeof r.pack === 'string' && r.pack !== pack.version)) { stale++; last.delete(key); }
    }
    return { get: (kind: string, id: string) => last.get(`${kind}\t${id}`), size: last.size, lines, repeated, stale, extra };
  };
  const r18 = index(input.rows18), r22 = index(input.rows22);

  // ---- depth 18: which rows the plan expects, and which are there
  const expected = { uniq: 0, after: 0, threat: 0 }, found = { uniq: 0, after: 0, threat: 0 };
  let missing18 = 0, capped18 = 0, lowest18: number | null = null, lowest22: number | null = null;
  const need = (kind: 'uniq' | 'after' | 'threat', id: string) => {
    expected[kind]++;
    const r = r18.get(kind, id);
    if (!r) { missing18++; return; }
    found[kind]++;
    if (r.capped) capped18++;
    if (!r.skipped && !r.terminal && num(r.depthReached)) lowest18 = lowest18 === null ? r.depthReached : Math.min(lowest18, r.depthReached);
  };
  for (const c of cards) {
    need('after', c.item.id);
    if (c.quiet) need('threat', c.item.id);
    if (c.cls !== 'pack') need('uniq', c.item.id);
  }

  // ---- item A: the rule at both depths
  const decisions: Array<Record<string, unknown>> = [];
  const sentences: string[][] = [];
  const entries: TeachThreat[] = [];
  const reasons: Record<string, number> = {};
  const g18 = { cards: 0, passEach: zero(GATES), passAll: 0, firstFail: zero(FAIL_ORDER), t0: {} as Record<string, number> };
  const g22 = { cards: 0, passEach: zero(GATES), passAll: 0, firstFail: zero(FAIL_ORDER), t0: {} as Record<string, number> };
  const tally = (into: typeof g18, g: GateResult) => {
    into.cards++;
    for (const k of GATES) if (g[k]) into.passEach[k]++;
    if (g.pass) into.passAll++; else into.firstFail[g.fail as Fail]++;
    if (g.t0) into.t0[g.t0] = (into.t0[g.t0] ?? 0) + 1;
  };
  const hist18 = zero(BANDS), hist22 = zero(BANDS), lost = zero(FAIL_ORDER);
  const kCount = zero(KINDS), byClass = zero(['pack', 'punish', 'small-edge'] as const);
  let candidates = 0, withBoth22 = 0, missing22 = 0, capped22 = 0, pass18 = 0, unconfirmed = 0, rejected = 0, notReplaying = 0, closingOff = 0;
  let strong = 0, strongLostT4 = 0, infoB = 0, preTrue = 0, withSq = 0, pinned = 0, undefendedN = 0, rung1 = 0, rung2 = 0, quiet = 0;
  const entryOf = new Map<string, TeachThreat>();
  const record = (g: GateResult) => ({
    T0: g.T0, T1: g.T1, T2: g.T2, T3: g.T3, T4: g.T4, T5: g.T5, pass: g.pass, fail: g.fail, ...(g.t0 ? { t0: g.t0 } : {}),
    margin: g.margin, mateThreat: g.mateThreat, replays: g.replays, plies: g.plies, shownPlies: g.shownPlies, netT: g.netT, netShown: g.netShown, netL: g.netL,
  });

  for (const c of cards) {
    if (!c.quiet) continue;
    quiet++;
    const { item } = c, id = item.id;
    const d18 = threatGates(item, r18.get('after', id), r18.get('threat', id));
    tally(g18, d18);
    let reason: string | null = d18.pass ? null : `d18:${d18.fail}`;
    // A depth-22 candidate passes T0 and T4 at depth 18 (the rule the confirmation run was planned with).
    const candidate = d18.T0 && d18.T4;
    let d22: GateResult | null = null, d22State = candidate ? 'rows' : 'not-a-candidate';
    if (candidate) {
      candidates++;
      const a22 = r22.get('after', id), t22 = r22.get('threat', id);
      if (!a22 || !t22) { missing22++; d22State = 'missing'; }
      else {
        withBoth22++;
        for (const r of [a22, t22]) if (!r.skipped && !r.terminal && num(r.depthReached)) lowest22 = lowest22 === null ? r.depthReached : Math.min(lowest22, r.depthReached);
        if (a22.capped || t22.capped) { capped22++; d22State = 'capped'; }
        else { d22 = threatGates(item, a22, t22); tally(g22, d22); }
      }
    }
    if (d18.pass) {
      pass18++;
      hist18[band(d18)]++;
      const isStrong = d18.mateThreat || (d18.margin as number) >= STRONG_MARGIN_CP;
      if (isStrong) strong++;
      if (d22State === 'missing') reason = 'd22:missing';
      else if (d22State === 'capped') { reason = 'd22:unconfirmed'; unconfirmed++; }
      else if (d22 && !d22.pass) { reason = `d22:${d22.fail}`; lost[d22.fail as Fail]++; }
      if (isStrong && d22 && !d22.T4) strongLostT4++;
    }
    if (!d18.pass && d18.margin !== null && d18.margin >= 50 && d18.margin < MARGIN_CP) infoB++;
    if (d18.pass && d22?.pass && d22.shown) {
      const entry = threatEntry(item, d22.shown);
      if (!entry || !pageAccepts(item, entry)) { reason = 'dry-run'; rejected++; }
      else { entries.push(entry); entryOf.set(id, entry); hist22[band(d22)]++; }
    }
    if (reason) reasons[reason] = (reasons[reason] ?? 0) + 1;
    decisions.push({ id, cls: c.cls, type: 'threat', a: item.moves[0], d18: record(d18), d22: d22 ? record(d22) : d22State, result: reason ?? 'threat' });
  }

  // ---- item D: uniqueness, from the depth-18 uniq row of each graded punish card
  const held: TeachHeld[] = [];
  const heldWhy = { 'not-unique': 0, 'not-held': 0 };
  let graded = 0, uniqShallow = 0, uniqMissing = 0, oneLegal = 0, gapOff = 0, rankOff = 0, smallEdgeUnder = 0;
  const heldOf = new Map<string, TeachHeld>();
  for (const c of cards) {
    if (c.cls === 'pack') continue;
    const id = c.item.id, a = c.item.moves[0], row = r18.get('uniq', id);
    const top = Array.isArray(row?.top) ? row.top.filter(t => !!t && typeof t.uci === 'string') : [];
    const rank = top.findIndex(t => t.uci === a);
    const ansRank = rank < 0 ? null : rank + 1;
    // The producer's own number: Win% of the first line minus the second, a mate as +/-1000 cp, two decimals.
    const gap = top.length >= 2 ? round2(lineWin(top[0]) - lineWin(top[1])) : null;
    if (c.cls === 'small-edge') { if (row && !row.skipped && gap !== null && gap < UNIQUE_GAP) smallEdgeUnder++; continue; }
    graded++;
    let verdict: string;
    if (!row || row.skipped || !top.length) { verdict = 'no-row'; uniqMissing++; }
    else if (row.capped || !num(row.depthReached) || row.depthReached < MIN_DEPTH) { verdict = 'shallow'; uniqShallow++; }
    else if (ansRank !== 1) verdict = 'not-held';
    else if (gap === null) { verdict = row.legal === 1 ? 'unique' : 'shallow'; if (verdict === 'unique') oneLegal++; else uniqShallow++; }
    else verdict = gap < UNIQUE_GAP ? 'not-unique' : 'unique';
    if (row && !row.skipped && top.length) {
      if ((row.ansRank ?? null) !== ansRank) rankOff++;
      if (num(row.gapRule) ? gap === null || Math.abs(row.gapRule - gap) > 1e-9 : gap !== null) gapOff++;
    }
    if (verdict === 'not-held' || verdict === 'not-unique') {
      const h: TeachHeld = { id, a, why: verdict, ...(verdict === 'not-unique' ? { alt: top[1].uci } : {}) };
      if (teachHeldSchema.safeParse(h).success) { held.push(h); heldOf.set(id, h); heldWhy[verdict]++; }
      else { rejected++; verdict = 'dry-run'; }
    }
    decisions.push({ id, cls: c.cls, type: 'uniq', a, verdict, gapRule: gap, ansRank, legal: row?.legal ?? null, depth: row?.depthReached ?? null, top: top.map(t => ({ uci: t.uci, san: t.san ?? null, cp: t.cp ?? null, mate: t.mate ?? null })) });
  }

  // ---- the sentences the page can show from the document, built by the page module itself
  let almostMissing = 0;
  for (const c of cards) {
    const { item } = c, id = item.id;
    const entry = entryOf.get(id), row = heldOf.get(id);
    const card: TrainerItem | null = entry ? { ...item, teach: entry } : null;
    const facts = card ? threatFacts(card) : null, say = card ? threatSay(card) : null;
    if (entry && card && facts && say) {
      byClass[c.cls]++; kCount[entry.k as ThreatKind]++;
      if (entry.pre) preTrue++;
      if (entry.sq) withSq++;
      if (entry.r === 'pinned') pinned++; else if (entry.r === 'undefended') undefendedN++;
      // The shown line against the board, independently of the page module: it replays, and its closing adds up.
      const replay = load(facts.passFen);
      const solver = (replay?.turn() ?? 'w') as Side;
      if (!replay || entry.t.some(u => !playUci(replay, u))) notReplaying++;
      if (!closingAgrees(facts.passFen, entry, solver)) closingOff++;
      // Hints: only a card that is served can show them. `hintLadderFor` is the page's own ladder at step 0; the
      // version 7 ladder is the one of the same card without its entry.
      if (c.cls === 'pack' || (c.cls === 'punish' && !row)) {
        const v7 = hintLadderFor(item, item.fen, 0);
        const now = applyThreatHints(hintLadderFor(card, card.fen, 0), facts, isPunish(card));
        if (now[0] && now[0].text !== v7[0]?.text) { sentences.push([id, 'rung1', now[0].text]); rung1++; }
        if (now[1] && JSON.stringify(now[1]) !== JSON.stringify(v7[1])) { sentences.push([id, 'rung2', now[1].text]); rung2++; }
      }
      const closing = narrateAsViewer(say.viewer.fen, say.viewer.line).summary;
      if (c.cls === 'pack') sentences.push([id, 'paragraph', say.paragraph]);
      else if (!row || row.why === 'not-unique') {
        sentences.push([id, 'clause.full', say.clause.full], [id, 'clause.fullNoClosing', say.clause.fullNoClosing], [id, 'clause.short', say.clause.short]);
      }
      if (c.cls === 'pack' || (c.cls === 'punish' && !row)) {
        sentences.push([id, 'viewer.title', say.viewer.title], [id, 'viewer.toggle', say.viewer.toggle], [id, 'viewer.intro', say.viewer.intro]);
        if (closing) sentences.push([id, 'viewer.closing', closing]);
      }
    }
    if (row?.why === 'not-unique') {
      const line = almostAsHighly({ ...item, teachHeld: row });
      if (line) sentences.push([id, 'almost', line]); else almostMissing++;
    }
  }

  // ---- the document
  entries.sort((x, y) => cmp(x.id, y.id));
  held.sort((x, y) => cmp(x.id, y.id));
  const doc: TeachMetaDoc = { v: TEACH_FORMAT, teachVersion: teachVersionOf(at, entries, held), packVersion: pack.version, at, cards: entries, held };
  const bytes = docBytes(doc);
  const read = readTeachMeta(JSON.parse(JSON.stringify(doc)));
  const readerOk = read.ok && read.skipped === 0 && read.cards.length === entries.length && read.held.length === held.length;

  // ---- the join, by the page's own pools: every entry reaches its card, and a held card is in no pool
  const withDoc = buildPools({ bank: [], endgames: [], pack, personal: [], drills: [], teach: read.ok ? loadTeach(read) : null });
  const joinedEntries = [...withDoc.own, ...withDoc.smallEdge, ...withDoc.notUnique, ...withDoc.notHeld].filter(p => !!p.teach).length;
  const kept = withDoc.own.filter(isPunish).length;
  const heldListed = { 'not-unique': withDoc.notUnique.length, 'not-held': withDoc.notHeld.length };
  const heldInPools = held.filter(h => withDoc.byId.has(h.id) || [...withDoc.all, ...withDoc.own, ...Object.values(withDoc.bySource).flat()].some(p => p.id === h.id)).length;
  const classesKept = JSON.stringify(withDoc.punishClasses) === JSON.stringify(pools.punishClasses);
  const joinOk = joinedEntries === entries.length && heldListed['not-unique'] === heldWhy['not-unique'] && heldListed['not-held'] === heldWhy['not-held']
    && heldInPools === 0 && classesKept && graded === kept + held.length;

  // ---- the identities the stage reads, and the stop rules
  const sumReasons = Object.values(reasons).reduce((x, y) => x + y, 0);
  if (quiet !== entries.length + sumReasons) throw new Error('buildTeachDocs: quiet cards do not equal threats plus reasons.');
  const heldTotal = held.length, share = strong ? strongLostT4 / strong : 0;
  const stops: string[] = [];
  if (heldTotal > MAX_HELD) stops.push(`s1: ${heldTotal} cards held, more than ${MAX_HELD}`);
  if (share > MAX_LOST_SHARE) stops.push(`s2: ${strongLostT4} of ${strong} strong depth-18 threats fail T4 at depth 22, more than ${MAX_LOST_SHARE * 100}%`);
  if (bytes > TEACH_MAX_BYTES) stops.push(`s3: the document is ${bytes} bytes, over ${TEACH_MAX_BYTES}`);
  if (rejected || !readerOk || !joinOk) stops.push(`s4: the page module rejects ${rejected} ${rejected === 1 ? 'entry' : 'entries'}${readerOk ? '' : '; the page reader does not read the document whole'}${joinOk ? '' : '; the page pools do not join the document as built'}`);
  if (missing18 || capped18 || missing22) stops.push(`s5: rows incomplete: depth 18 missing ${missing18}, capped ${capped18}; depth-22 candidates without both rows ${missing22}`);
  if (uniqShallow || uniqMissing) stops.push(`s6: graded punish cards without a uniqueness verdict: shallow ${uniqShallow}, no row ${uniqMissing}`);

  const slots: Record<string, number> = {};
  for (const s of sentences) slots[s[1]] = (slots[s[1]] ?? 0) + 1;
  const sorted = (o: Record<string, number>) => Object.fromEntries(Object.keys(o).sort(cmp).map(k => [k, o[k]]));
  const summary = {
    madeBy: TEACH_BUILDER_MARK,
    v: TEACH_FORMAT, teachVersion: doc.teachVersion, packVersion: pack.version, at,
    bytes, limitBytes: TEACH_MAX_BYTES,
    cards: { served: cards.length, pack: cards.filter(c => c.cls === 'pack').length, punish: graded, smallEdge: cards.filter(c => c.cls === 'small-edge').length, quiet },
    rows: {
      d18: { expected: { ...expected, total: expected.uniq + expected.after + expected.threat }, found: { ...found, total: found.uniq + found.after + found.threat }, missing: missing18, capped: capped18, notThisCard: r18.stale, forOtherCards: r18.extra, read: r18.lines, repeated: r18.repeated, lowestDepth: lowest18 },
      d22: { candidates, withBothRows: withBoth22, missing: missing22, capped: capped22, notThisCard: r22.stale, forOtherCards: r22.extra, read: r22.lines, repeated: r22.repeated, lowestDepth: lowest22 },
    },
    gates: { d18: { ...g18, t0: sorted(g18.t0) }, d22: { ...g22, t0: sorted(g22.t0) } },
    threats: {
      passDepth18: pass18, stored: entries.length, unconfirmed, lostAtDepth22: { ...lost, total: Object.values(lost).reduce((x, y) => x + y, 0) },
      byClass, noThreat: sorted(reasons),
      identity: { quiet, withThreat: entries.length, sumOfReasons: sumReasons, holds: quiet === entries.length + sumReasons },
    },
    marginHistogram: { depth18PassAll: hist18, depth22Stored: hist22 },
    strong: { depth18: strong, failT4AtDepth22: strongLostT4, share: Math.round(share * 10000) / 10000, limit: MAX_LOST_SHARE },
    k: kCount, pre: { true: preTrue, false: entries.length - preTrue }, withSq, withR: { pinned, undefended: undefendedN, total: pinned + undefendedN },
    held: { ...heldWhy, total: heldTotal, limit: MAX_HELD },
    // Counted on the pools the page builds WITH the document: graded cards still served, and the two held lists.
    graded: { total: graded, kept, held: heldListed['not-unique'] + heldListed['not-held'], holds: graded === kept + heldListed['not-unique'] + heldListed['not-held'] },
    join: { entries: entries.length, joined: joinedEntries, heldListed, heldInPools, classesKept, ok: joinOk },
    uniq: { shallow: uniqShallow, noRow: uniqMissing, oneLegalMove: oneLegal, gapDiffersFromRow: gapOff, rankDiffersFromRow: rankOff, smallEdgeUnder10: smallEdgeUnder },
    dryRun: { rejected, readerOk, shownNotReplaying: notReplaying, closingMismatches: closingOff, almostMissing },
    hints: { rung1Changed: rung1, rung2Changed: rung2 },
    sentences: { rows: sentences.length, bySlot: sorted(slots) },
    itemB: { quietNoThreatMargin50to99: infoB },
    stops,
  };
  return { doc, summary, sentences, decisions };
}
