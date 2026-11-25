/**
 * Grading a wrong try (brief M3 section 9.1, builder G): one pure function decides every case.
 *
 * Input: the card kind, the try's SAN, the answer's SAN, the solver's side (for copy) and exactly one source:
 * - bank, pack, punish, agent cards: `check`, a `TryCheck` from `checkTry`, or `null` when the engine is missing,
 *   failed, was aborted or missed the page's deadline;
 * - endgame drills (`tech-*`, never the engine): `teach`, the `teachTry` result plus the drill goal (`endgameGoal`).
 *
 * Classes come from the ROUNDED whole-number Win% only (half rounds up; `check.verdict`, which uses tenths, is
 * never read). With t = round(tryWin), b = round(bestWin) and gap = b - t:
 *   also-good  t >= max(65, b - 5)
 *   close      not also-good and gap <= 5
 *   strong     t >= 65 and gap > 5
 *   worse      35 <= t < 65 and gap > 5
 *   losing     t < 35 and gap > 5
 * A result is trusted at depth >= 10, and at depth 0, which `checkTry` reports only when both positions were
 * already finished (mate, stalemate, dead draw), so the numbers are exact without a search.
 *
 * What happens (copy from brief 9.1, 8.1, 8.2, 8.10 and 9.11.2 (p), word for word):
 * - pack, punish, agent: no check -> ERROR, 8.1 copy. Untrusted: also-good or close -> SOFT "could not finish",
 *   otherwise ERROR with 8.1 copy, both without numbers. Trusted: strong -> SOFT (8.10), worse or losing -> ERROR
 *   with the numbers intro. "That lets your opponent off the hook." is used only on punish cards whose best move
 *   keeps 65% or more (8.1: only when the analysis shows it). Version 7.1 (brief m31 4.6, F3): when that try itself
 *   still keeps 55% or more (rounded), the message is "That keeps only a small edge. There is a clearly stronger
 *   move." instead; the class, the action (ERROR, a counted miss), the intro and the numbers are the same.
 * - pack, punish, agent, trusted also-good or close (brief 9.11.2 (p), which replaced 9.1's ACCEPT): SOFT, never
 *   ACCEPT. One live depth-12 check never books another move as correct: the analysis that picked every pack card
 *   and every graded punish card put the second-best move at least 10 Win% points below the card's move (depth 18,
 *   else 14). The copy has no numbers and never the answer: pack and punish "The quick engine check likes {try} too,
 *   but the analysis that picked this card found one clearly better move. Try again."; agent "The engine likes {try}
 *   too, but this card is after a different move. Try again." `tryVerdict` is 'strong', `showNumbers` false, and
 *   there is no intro, so the depth-12 pair is never shown (one reproduced case had the try above the answer). An
 *   own-game card whose line is a short engine scan (`engineScan`, a position the Site app saved or this page made)
 *   was not picked by that analysis, so it gets the agent words.
 * - bank: always ERROR (counted at once). Trusted also-good or close -> "The engine likes {try} too ...".
 * - endgame: words only, never a percentage. The goal kept -> SOFT; a slower mate on a mate-in-N drill -> SOFT;
 *   worse than the goal -> ERROR ("This only draws." / "This loses."); no result -> ERROR, generic copy.
 *
 * Neither `message` nor `intro` ever names the answer (8.2); an endgame note that names the answer's SAN is dropped.
 * `gradeTry` never returns ACCEPT since 9.11.2 (p); the action stays in `GradeAction` for its callers.
 *
 * Output: `cls` is the computed class, kebab-case: the five classes above (kept even when the depth is too shallow
 * to trust, where `tryVerdict` says `unchecked`, and kept for the SOFT near try above, where `tryVerdict` says
 * `strong`), `unchecked` (nothing usable), or for drills `goal-kept`, `slower-mate`, `goal-lost`. `tryVerdict` is
 * what the coach input gets. `tryWin`/`bestWin` are the rounded numbers, present exactly when `showNumbers` is true.
 *
 * Pure: type-only imports, no React, no engine, no store. The caller does the identity check (card, step, try)
 * before grading; when `tryUci` is given, a check or listed try for another move is ignored as well.
 */
import type { TeachResult, TeachTry } from '@/lib/endgameTeach';
import type { TryCheck } from './tryMove';

export type GradeKind = 'bank' | 'pack' | 'punish' | 'agent' | 'endgame';
/** The kinds graded with the in-page engine. */
export type EngineKind = Exclude<GradeKind, 'endgame'>;
export type WinClass = 'also-good' | 'close' | 'strong' | 'worse' | 'losing';
/** Sent to the coach (brief 9.2). */
export type TryVerdict = WinClass | 'unchecked';
export type GradeClass = WinClass | 'unchecked' | 'goal-kept' | 'slower-mate' | 'goal-lost';
/** `accept` is never returned since brief 9.11.2 (p); it stays in the type so callers that test for it still compile. */
export type GradeAction = 'accept' | 'soft' | 'error';
type Side = 'w' | 'b';

/** Win% at or above this counts as winning: the also-good and strong floor, and the "off the hook" gate. */
export const WIN_FLOOR = 65;
/** The largest gap (whole points) that still counts as about as good. */
export const CLOSE_GAP = 5;
/** Below this Win% a try with a gap over 5 is `losing`. */
export const LOSING_BELOW = 35;
/** The shallowest search a class is trusted from (depth 0 = finished positions, exact). */
export const TRUSTED_DEPTH = 10;
/**
 * Brief m31 4.6, F3: from this rounded Win% a try still keeps an edge (the lesson's line between "about level" and "a
 * small edge"), so on a punish card it is not said to let the opponent off the hook.
 */
export const KEEPS_EDGE_FROM = 55;

/** What a technique drill asks for: win (optionally mate in N) or hold the draw. */
export interface DrillGoal { result: 'win' | 'draw'; mateIn?: number }
/** `teachTry(id, fen, uci)` plus the drill's goal. */
export interface TeachGrade { result: TeachResult | null; tryLine?: TeachTry; goal: DrillGoal }

interface GradeCommon {
  trySan: string;
  /** The card's move at this step. Never named in the copy; an endgame note that names it is dropped. */
  answerSan: string;
  /** The side to move before the try, for "the engine gives White ...". */
  solver: Side;
  /** Optional: when given, a check or listed try for another move is ignored. */
  tryUci?: string;
}
export interface EngineGradeInput extends GradeCommon {
  kind: EngineKind;
  check: TryCheck | null;
  teach?: never;
  /**
   * Optional, default off (brief 9.11.2 (p)): true for an own-game card whose line is a short engine scan, a position
   * the Site app saved or this page made (source `personal`; Trainer's `isEngineScanCard`). The analysis that picked
   * pack and punish cards did not pick it, so a trusted also-good or close try gets the agent words, which make no
   * claim about that analysis. Absent or false: the words follow `kind`. No effect on bank cards.
   */
  engineScan?: boolean;
}
export interface EndgameGradeInput extends GradeCommon { kind: 'endgame'; teach: TeachGrade | null; check?: never }
export type GradeInput = EngineGradeInput | EndgameGradeInput;

export interface Grade {
  action: GradeAction;
  cls: GradeClass;
  message: string;
  /** One sentence for the try viewer; absent when there is nothing computed to say. */
  intro?: string;
  tryVerdict: TryVerdict;
  showNumbers: boolean;
  /** Rounded Win% of the try and of the best move, present exactly when `showNumbers`. */
  tryWin?: number;
  bestWin?: number;
}

/**
 * The 9.1 class of a try from its Win% and the best move's Win%, both rounded to whole numbers first.
 * Null when either number is missing or not finite.
 */
export function classifyWin(tryWin: number, bestWin: number | null): WinClass | null {
  if (bestWin === null || !Number.isFinite(tryWin) || !Number.isFinite(bestWin)) return null;
  const t = Math.round(tryWin), b = Math.round(bestWin);
  if (t >= Math.max(WIN_FLOOR, b - CLOSE_GAP)) return 'also-good';
  if (b - t <= CLOSE_GAP) return 'close';
  if (t >= WIN_FLOOR) return 'strong';
  return t < LOSING_BELOW ? 'losing' : 'worse';
}

/** The goal of a technique drill from its themes: `planb` holds the draw; a `mateInN` theme asks for mate in N. */
export function endgameGoal(themes: readonly string[]): DrillGoal {
  if (themes.includes('planb')) return { result: 'draw' };
  for (const theme of themes) {
    const m = /^mateIn([1-9]\d*)$/.exec(theme);
    if (m) return { result: 'win', mateIn: Number(m[1]) };
  }
  return { result: 'win' };
}

const STORED_LINE = 'That is not the move from the stored line.';
const NOT_THIS_CARD = 'That is not the move this card is after.';
const OFF_THE_HOOK = 'That lets your opponent off the hook.';
/** Brief m31 4.6, F3: a punish try that falls short of the best move but still keeps `KEEPS_EDGE_FROM` or more. */
const SMALL_EDGE_KEPT = 'That keeps only a small edge. There is a clearly stronger move.';
const ONLY_DRAWS = 'This only draws.';
const LOSES = 'This loses.';
const ALSO_WINS = 'That also wins, but this drill practises a different move. Try again.';
const ALSO_HOLDS = 'That also holds the draw, but this drill practises a different move. Try again.';
/** 9.11.2 (p), pack and punish cards: a trusted also-good or close try (no numbers, never the answer). */
const quickCheckLikes = (trySan: string) => `The quick engine check likes ${trySan} too, but the analysis that picked this card found one clearly better move. Try again.`;
/** 9.11.2 (p), Claude's drills (and a card whose line is a short engine scan): a trusted also-good or close try. */
const engineLikes = (trySan: string) => `The engine likes ${trySan} too, but this card is after a different move. Try again.`;
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

const sideName = (side: Side) => (side === 'b' ? 'Black' : 'White');
const inWords = (n: number) => NUMBER_WORDS[n] ?? String(n);
const sameUci = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** 8.1 honest copy when nothing analysed shows more. */
const plainCopy = (kind: GradeKind) => (kind === 'pack' || kind === 'punish' ? STORED_LINE : NOT_THIS_CARD);
const trusted = (depth: number) => depth === 0 || depth >= TRUSTED_DEPTH;

/** True when `text` names the move `san` as a whole token (check and mate signs ignored). */
function namesMove(text: string, san: string): boolean {
  const core = san.trim().replace(/[+#]+$/, '');
  if (!core) return false;
  const pattern = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9=-])${pattern}(?![A-Za-z0-9=-])`).test(text);
}

function grade(action: GradeAction, cls: GradeClass, message: string, tryVerdict: TryVerdict, extra: Partial<Grade> = {}): Grade {
  return { action, cls, message, ...extra, tryVerdict, showNumbers: extra.showNumbers ?? false };
}

function gradeEngine(input: EngineGradeInput): Grade {
  const { kind, trySan, solver } = input;
  const plain = plainCopy(kind);
  const check = input.check;
  const usable = !!check && (input.tryUci === undefined || sameUci(check.tryUci, input.tryUci));
  const cls = usable ? classifyWin(check.tryWin, check.bestWin) : null;
  if (!check || !cls || check.bestWin === null) return grade('error', 'unchecked', plain, 'unchecked');

  const t = Math.round(check.tryWin), b = Math.round(check.bestWin);
  const near = cls === 'also-good' || cls === 'close';
  const sure = trusted(check.depth);
  const numbers = { showNumbers: true, tryWin: t, bestWin: b };
  // 8.2: while solving, the result of the try only, never the answer's SAN.
  const solving = `After ${trySan} the engine gives ${sideName(solver)} ${t}% to win; the best move keeps ${b}%.`;

  if (kind === 'bank') {
    if (!sure) return grade('error', cls, plain, 'unchecked');
    const message = near ? `The engine likes ${trySan} too, but this puzzle is after a different idea.` : plain;
    return grade('error', cls, message, cls, { intro: solving, ...numbers });
  }
  if (!sure) {
    return near
      ? grade('soft', cls, `The engine could not finish checking ${trySan}. This card is after a different move. Try again.`, 'unchecked')
      : grade('error', cls, plain, 'unchecked');
  }
  if (near) {
    // Brief 9.11.2 (p): never ACCEPT on these kinds. Not counted, the move is not played, he tries again. No numbers
    // and no intro: the depth-12 pair can put the try above the card's move. The coach gets 'strong' and a plain note.
    const message = kind === 'agent' || input.engineScan === true ? engineLikes(trySan) : quickCheckLikes(trySan);
    return grade('soft', cls, message, 'strong');
  }
  if (cls === 'strong') {
    return grade('soft', cls, `Good idea, but there is a stronger move: after ${trySan} the engine gives you ${t}% to win, the best move keeps ${b}%. Try again.`, cls, {
      intro: solving, ...numbers,
    });
  }
  // worse or losing: the try falls below 65 and more than 5 points under the best move.
  // F3 (brief m31 4.6): on a punish card whose best move keeps 65 or more, a try that still keeps 55 or more has not
  // let the opponent off the hook. Only the words differ; the miss is counted as before.
  const message = kind === 'punish' && b >= WIN_FLOOR ? (t >= KEEPS_EDGE_FROM ? SMALL_EDGE_KEPT : OFF_THE_HOOK) : plain;
  return grade('error', cls, message, cls, { intro: solving, ...numbers });
}

function gradeEndgame(input: EndgameGradeInput): Grade {
  const teach = input.teach;
  if (!teach || !teach.result) return grade('error', 'unchecked', NOT_THIS_CARD, 'unchecked');
  const { result, goal } = teach;
  const listed = teach.tryLine && (input.tryUci === undefined || sameUci(teach.tryLine.uci, input.tryUci)) ? teach.tryLine : undefined;
  const note = listed?.note.trim();
  const extra = note && !namesMove(note, input.answerSan) ? { intro: note } : {};

  const holds = goal.result === 'draw';
  if (result === 'win' || (result === 'draw' && holds)) {
    const mateIn = !holds && Number.isInteger(goal.mateIn) && (goal.mateIn ?? 0) > 0 ? goal.mateIn! : null;
    // The caller accepts a mating try before grading, and every other winning move in the four mate drills mates
    // more slowly (tests/m3_grade.test.ts checks this against the tablebase cache).
    if (mateIn !== null) return grade('soft', 'slower-mate', `That also mates, but not in ${inWords(mateIn)}. Try again.`, 'strong', extra);
    return grade('soft', 'goal-kept', holds ? ALSO_HOLDS : ALSO_WINS, 'also-good', extra);
  }
  return result === 'loss'
    ? grade('error', 'goal-lost', LOSES, 'losing', extra)
    : grade('error', 'goal-lost', ONLY_DRAWS, 'worse', extra);
}

/** Decides a wrong try (brief 9.1). Never throws; never reads `check.verdict`. */
export function gradeTry(input: GradeInput): Grade {
  return input.kind === 'endgame' ? gradeEndgame(input) : gradeEngine(input);
}
