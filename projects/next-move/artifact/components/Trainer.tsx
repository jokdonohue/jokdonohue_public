/**
 * Next Move trainer, artifact version. Ported from the Site app's `components/Trainer.tsx`
 * (source hash in the B2 build log): practice, hints, reveal and rehearsal are unchanged; storage is the
 * artifact database through `useArtifactState`; there is no Chess.com fetch, no server sync route and no
 * in-page game analysis (PGN import and analysis are M2).
 *
 * Opening the page lands on today's first position (item c): a daily set capped at 20 reviews and
 * 10 new positions, weighted by Claude's plan. Every position has feedback buttons (item d), the board
 * faces the side to move, and a clean answer to a Lichess puzzle moves on after 1.2 s (item f; M3 8.7: only
 * bank puzzles move on by themselves).
 *
 * M3 "teach the why", stage (a) (brief 9.6): a four-level hint ladder built from the answer line; a line viewer
 * for a wrong try (filled by a background engine check, or the tablebase data on endgame drills), for the answer
 * once the card is complete, and on punish cards for the move he could have played in his game; the punish
 * framing and lesson. Wrong tries are still counted as in version 6; viewers and replays record nothing.
 *
 * Stage (b) (brief 9.6, L6, L7, 8.3): the coach gets the enriched explain input (`coachInput.ts`: the card, the whole
 * answer line, the try's line and the page's class for it); once the card is complete the panel also holds the
 * question box (moves named in the question are checked by the engine, or the tablebase data on drills); a note from
 * the page points at the latest try; Claude's answers to his notes show on the card and in the From Claude area.
 *
 * Stage (c) (brief 9.1, 8.6, 8.18): every move that is not the card's move is graded by `gradeTry`. Endgame drills
 * at once from the tablebase data; a Lichess puzzle counts the error at once and checks the try in the background;
 * on his own games, punish cards and Claude's drills the board waits ("Checking …") for the engine, at most 6 s, and
 * then the try is offered as a soft retry or counted as an error (9.11.2 p: an engine check never accepts it). Lichess
 * puzzles are aimed at the bank level (`bankLevel`). On a phone the hint and reveal controls sit directly under the
 * board; the checklist is one press away.
 *
 * Fix pass (brief 9.10 f, g, h, i, m, n): after a punish card his game move is named once; a drill's verdict shows once,
 * in the message line; the hint and reveal buttons come before the hints shown; on a phone a try line that is one press
 * away sits right under the message; a short engine scan's line is titled "The line after …"; while he solves, a try
 * line cut down to his try alone is not shown. Repair 1 (the lead's 02:00 ruling on 9.10 h): on a phone a Lichess
 * puzzle's miss is one press away under the message too; at wider widths it stays open where it was.
 *
 * Fix round 2, stage 1 (brief 9.11.2, writer FX2b): (p) no engine check books another move as correct on his games,
 * punish cards or Claude's drills (`gradeTry` grades a near try SOFT, without numbers; the page no longer has an accept
 * branch); (q) leaving a card while "Checking …" books the try as a miss, as version 6 did; (r) every viewer gets the
 * page's engine figure for its line (`verdict`), never "No material changes hands.", and an answer viewer on his own
 * game's card opens with the stored numbers once; (s) while the card on the board is unsolved, "Answers to your notes"
 * shows its heading and count only, until he asks; (t) the answer is found in a try line by move identity, and while he
 * solves the try viewer leaves out every sentence that describes the answer (`omit`; FXR2b1, brief 9.11.8: every move of
 * the answer still to find, not only the one at this step).
 *
 * Fix round 2, stage 2 (brief 9.11.3, writer FX2c): a note from the page points at his latest try on the card, a try still
 * being checked or another mate included (R1-2); a check stopped while it runs lets the next own-game card warm the engine
 * again (R2-1); a try graded with no result keeps that grade for the rest of the card visit (R2-2); a clean solve does not
 * move on while Claude's answer to his note shows on the card (R4-3); after a drill the stored explanation shows without
 * "The idea" (R4-6); the hint button keeps the focus during the 2 s guard (R6-2); a try viewer opens on his try (R6-3);
 * on a phone every finished try sits one press away under the message line (9.10 h extended); the game-line viewer and the
 * small-edge viewers get their figures ((r) 3); the stored-numbers intro is left out whenever the try viewer shows figures
 * for his game move ((r) 5).
 *
 * Version 7.1 (brief m31, sections 4.3 to 4.8; writer W3). Everything new is a pure exported function; the page's own
 * functions keep their names and call sites.
 * - A, what a quiet answer threatens (the document `teach/meta`, joined by the pools as `item.teach`): hint rungs 1 and 2
 *   at step 0 (`hintLadderFor`, H1 and H2, the only thing from the document shown while he solves); once the card is
 *   complete, the paragraph under a mistake card (`afterCardNotes`), the sentences inside a punish lesson (`lessonFor`,
 *   through `lessonThreat`) and a closed viewer of the threat line (`threatViewerOf`).
 * - C, what his game move allowed, on a mistake card once it is complete: a closed viewer over his game move and the
 *   stored reply (`gameMoveViewer`) and, where that line shows a loss or a mate, one paragraph (`gameMoveWords`).
 * - D: the pools get `view.teach`; held punish cards are in no pool, the 'not-unique' ones are listed on the Games tab
 *   (`PunishStudy`), and the four held-list sites know both new lists.
 * - E1: the answer viewer's figure is the stored one where the card stores one (`answerViewerVerdict`).
 * - F2: his game move is named with its piece and from-square where the solver could play the same SAN (`punishLead`,
 *   and the first hint's head through `justPlayedAt`). F3: "Why {try} doesn't work" needs the try under 55%.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Chess } from 'chess.js';
import { ArrowRight, BookOpen, ChartNoAxesCombined, Check, Flag, GraduationCap, Lightbulb, RefreshCw, RotateCcw, Target, X } from 'lucide-react';
import Chessboard, { pieceArt, PIECE_VIEWBOX } from './Chessboard';
import LineViewer, { sentenceAfterMove, type ViewerNarrateOptions } from './LineViewer';
import Learn from './Learn';
import PersonalPackSummary from './PersonalPackSummary';
import CoachPanel from './CoachPanel';
import FeedbackBar from './FeedbackBar';
import BackupPanel from './BackupPanel';
import PunishStudy, { usablePunishStudy } from './PunishStudy';
import { answeredNotes, AnswersPanel, CardAnswer, ConnectionBanner, DailyDone, DocErrorLine, MAX_ANSWERS_SHOWN, PlanAndNotes, saveLabel, TodayStrip, type AnsweredNote } from './HomePanels';
import { useArtifactState } from './useArtifactState';
import { activePlan, capState, dailyCounts, focusPriors, pickNext } from './daily';
import { buildPools, fallbackPool, isPunish, type Pools, type TrainerItem } from './pools';
import { buildProgress, type Progress } from './progress';
import { packForSummary } from './packAdapter';
import { answerLineFrom, buildAskInput, cardKind, explainInput, lessonThreat, sanLine as sanFrom, type WrongMove } from './coachInput';
import { backupFilename, buildBackup } from './backup';
import { computeSnapshot } from './snapshot';
import { SafeAnswerPanel, SafeQuestionPanel, SafeScoreLine } from './SafeCard';
import StudyList from './StudyList';
import PgnImport from './pgn/PgnImport';
import { OpeningAccidents, TransferCard } from './GameReadouts';
import { colorName, type OpeningRow } from './insights';
import { leechIds, leechState, putBackAttempt, putBackTimes, withPutBacks } from './leech';
import { chooseSafe, isSafeAttempt, pickWithSafe, safeAttempt, safePool, safeQuestion, safeSchedule, safeScore, type SafeChoice, type SafeQuestion } from './safe';
import { paths, type SafeCardDoc, type SessionAttempt } from '@/src/contract/docs';
import { bankLevel } from './bankLevel';
import { puzzles } from '@/lib/puzzles';
import { endgameDrills, isEndgameDrill } from '@/lib/endgames';
import { selectPuzzle, getSkillStats, trainingThemes, type Progress as SchedulerProgress } from '@/lib/scheduler.js';
import { withThemePriors, packDetailOf, sanMoves, fenAfter } from '@/lib/personal-pack';
import { setupMove } from '@/lib/puzzle-setup';
import { drillGoal, recentExclusion } from '@/lib/practice';
import type { TrainerProps } from '@/src/contract/store';
import { parseState, type PersonalPuzzle } from '@/lib/training-state';
import { applySiteImport, idMapFromPackChunks, planSiteImport } from '@/src/importers/siteBackup';
import { buildHints, type Hint, type HintInput } from '@/src/teach/hints';
import { moveRefOf, narrateLine, sameMove, type LineVerdict, type MoveRef } from '@/src/teach/narrate';
import { PIECE_NAME } from '@/src/teach/values';
import { betterMoveSan, punishAnswerLine, punishLesson, punishSiblingId, solverWinAfter } from '@/src/teach/punish';
import { playedLabel, PUNISH_MIN_WIN } from '@/src/teach/punish';
import { applyThreatHints, threatFacts, threatSay, type ThreatSay } from '@/src/teach/threat';
import { checkTry, getSharedEngine, searchOnce, type TryCheck } from '@/src/teach/tryMove';
import { classifyWin, endgameGoal, gradeTry, KEEPS_EDGE_FROM, TRUSTED_DEPTH, type DrillGoal, type Grade } from '@/src/teach/grade';
import type { AnalysisEngine } from '@/src/analysis/engine';
import { drillTeach, teachTry } from '@/lib/endgameTeach';
import { BOARD_THEMES, boardThemeFrom, type BoardTheme } from './boardTheme';

const move = (board: Chess, uci: string) => board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
const THEMES: Array<[string, string]> = [
  ['all', 'Mixed practice'], ['review', 'Due for review'], ['personal', 'From my games'], ['hangingPiece', 'Loose pieces'], ['fork', 'Forks'],
  ['pin', 'Pins'], ['discoveredAttack', 'Discovered attacks'], ['mateIn1', 'Mate in one'], ['mateIn2', 'Mate in two'],
  ['defensiveMove', 'Defensive resources'], ['equality', 'Get back into the game'], ['endgame', 'Endgames'], ['endgame-tech', 'Endgame technique'],
  ['planb', 'Hold the draw (Plan B)'], ['pawnEndgame', 'Pawn endings'], ['rookEndgame', 'Rook endings'], ['promotion', 'Promotion'],
];
// One name per theme in the focus menu, the tags and Progress (QA P2-5).
const LABELS: Record<string, string> = Object.fromEntries(THEMES.filter(([id]) => !['all', 'review', 'personal', 'equality'].includes(id)));
const pretty = (s: string) => LABELS[s] ?? s.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
// Shown only when the pack contains these sets.
const PACK_SETS = [['pack-stalemate', 'stalemate', 'Avoid stalemate (your games)'], ['pack-conversion', 'conversion', 'Convert the win (your games)']] as const;
const PUNISH = 'pack-punish';
/** M2 (item b): the "Safe or not?" focus; its cards never enter the ordinary pools. */
const SAFE = 'pack-safe';
/** M2 (D8): extra practice over one opening's positions; outside the daily caps. */
const EXTRA = 'extra-opening';
const POOL_FILTERS = ['all', 'personal', 'review', PUNISH, SAFE, EXTRA, ...PACK_SETS.map(([id]) => id)];
/** Item f: pause after a clean answer before the next position (judgement call). */
export const AUTO_ADVANCE_MS = 1200;
/** `derived/snapshot` is recomputed this long after the last attempt recorded on this page. */
const SNAPSHOT_DELAY_MS = 5000;
function clock(seconds: number) { const s = Math.max(0, Math.round(seconds)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
const solutionSan = (p: TrainerItem) => sanFrom(p.fen, p.moves).join('  ');
const toSchedulerProgress = (p: Progress) => p as unknown as SchedulerProgress;

// ---------------------------------------------------------------- M3 stage (a): what the panel teaches
// Pure helpers and small components, exported for tests/m3_trainer_a.test.tsx (the page has no DOM test renderer, so
// the Trainer's click paths are covered through these pieces). None of them records anything.

type Side = 'w' | 'b';
const sideOf = (fen: string): Side => (fen.trim().split(/\s+/)[1] === 'b' ? 'b' : 'w');
const sideName = (s: Side) => (s === 'w' ? 'White' : 'Black');
const fenKey = (fen: string) => fen.trim().split(/\s+/).slice(0, 4).join(' ');
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** SAN of `uci` at `fen`, or '' when it is not a legal move there. */
export function sanAt(fen: string, uci: string | undefined): string {
  if (!uci) return '';
  try { return move(new Chess(fen), uci).san; } catch { return ''; }
}

/** The practice board after `line` from `fen`, played as the board plays moves (castling as the king's two-square move,
 *  promotion as the fifth letter), stopping before the first move that does not apply. Used by "Reveal solution". */
export function playLine(fen: string, line: readonly string[]): { fen: string; last: string | null; played: number } {
  const board = new Chess(fen);
  let last: string | null = null, played = 0;
  for (const uci of line) { try { move(board, uci); last = uci; played++; } catch { break; } }
  return { fen: board.fen(), last, played };
}

/** Positions along `line` from `fen`: [start, after ply 1, ...], cut before the first move that does not apply. */
export function positionsAlong(fen: string, line: readonly string[]): string[] {
  let board: Chess;
  try { board = new Chess(fen); } catch { return []; }
  const out = [board.fen()];
  for (const uci of line) { try { move(board, uci); } catch { break; } out.push(board.fen()); }
  return out;
}

export type TeachKind = HintInput['kind'];
/** The card kind the teaching modules use (brief §2): drill, punish, Lichess puzzle, Claude's drill, else own game.
 *  One definition, shared with the coach input (`coachInput.ts` `cardKind`). */
export function teachKind(item: Pick<TrainerItem, 'source' | 'kind' | 'themes'>): TeachKind {
  return cardKind(item, item.source);
}

/** The line that explains the card (brief §2): `pack.pvUci` when it starts with the card's first move, else `moves`. */
export const answerLineOf = (item: Pick<TrainerItem, 'fen' | 'moves' | 'pack'>): string[] => punishAnswerLine(item);

/** The answer line from step `index`, solver first: the explaining line while it agrees with the card's moves up to
 *  and including this step, else the card's own moves from there. One definition with the coach input
 *  (`coachInput.ts` `answerLineFrom`), so the hints and the coach explain the same line. */
export function lineFromStep(item: Pick<TrainerItem, 'fen' | 'moves' | 'pack'>, index: number): string[] {
  return answerLineFrom(item, index);
}

/** The move that led to the position at step `index` (brief 9.3): the previous ply, with the position before it, at
 *  any later step of any kind; his game move from `pack.sourceFen` at the start of a punish card; else none. */
export function justPlayedAt(item: TrainerItem, index: number): HintInput['justPlayed'] {
  if (index > 0) {
    const positions = positionsAlong(item.fen, item.moves.slice(0, index));
    if (positions.length !== index + 1) return undefined;
    const fenBefore = positions[index - 1], uci = item.moves[index - 1];
    const san = sanAt(fenBefore, uci);
    return san ? { uci, san, byLearner: false, fenBefore } : undefined;
  }
  if (!isPunish(item)) return undefined;
  const p = item.pack ?? {};
  const uci = typeof p.playedUci === 'string' ? p.playedUci : '';
  const fenBefore = typeof p.sourceFen === 'string' ? p.sourceFen : '';
  const san = typeof p.playedSan === 'string' && p.playedSan ? p.playedSan : fenBefore ? sanAt(fenBefore, uci) : '';
  if (!uci || !san) return undefined;
  // F2 (brief m31 4.6): where the solver could play the same SAN, the first hint's head names his move with its piece
  // and from-square (`playedLabel`). `san` stays the bare SAN; a card without a shared SAN gets no `label` key at all.
  const label = playedLabel(item);
  return { uci, san, byLearner: true, ...(fenBefore ? { fenBefore } : {}), ...(label && label !== san ? { label } : {}) };
}

/** The four-level ladder for the position at step `index` (brief L3, 9.3). Built only when he asks for a hint.
 *  Version 7.1 (brief m31 4.3, H1 and H2): at step 0, on the card's own position, a card with a stored threat that
 *  passes the page's checks (`threatFacts`; it replays at most 8 plies and narrates nothing) gets the threat idea in
 *  place of the bare "quiet move" sentence and the target as rung 2 (`applyThreatHints`). Every other ladder, and
 *  rungs 3 and 4 of that one, are version 7's. The sweeps and the builder read the page's ladder through this function. */
export function hintLadderFor(item: TrainerItem, fen: string, index: number): Hint[] {
  const kind = teachKind(item);
  const teach = kind === 'endgame' ? drillTeach(item.id) : null;
  const justPlayed = justPlayedAt(item, index);
  const ladder = buildHints({
    fen, line: lineFromStep(item, index), themes: item.themes, kind, ply: index,
    ...(justPlayed ? { justPlayed } : {}),
    ...(teach ? { idea: teach.idea, ...(teach.keySquares?.length ? { keySquares: teach.keySquares } : {}) } : {}),
  });
  return index === 0 && item.teach && fenKey(fen) === fenKey(item.fen) ? applyThreatHints(ladder, threatFacts(item), isPunish(item)) : ladder;
}

export const HINT_LABELS = ['Idea', 'Target', 'Piece', 'Move'] as const;
/** 8.16: the last level (the move itself) can be asked for this long after level 3 was shown. */
export const MOVE_HINT_DELAY_MS = 2000;

/** The hint button at a step: `shown` levels shown there, `level3At` when level 3 appeared, `now` the clock.
 *  Null once all four levels are shown. */
export function hintButton(shown: number, level3At: number | null, now: number): { label: string; disabled: boolean } | null {
  if (shown >= HINT_LABELS.length) return null;
  if (shown <= 0) return { label: 'Show a hint', disabled: false };
  if (shown === 3 && level3At !== null && now - level3At < MOVE_HINT_DELAY_MS) return { label: 'Ready in a moment', disabled: true };
  return { label: `Next hint (${shown + 1} of ${HINT_LABELS.length})`, disabled: false };
}

/** Board marks for the newest hint shown: its square as `hintSquare`; level 4 as an arrow. Version 7.3: a hint that
 *  names several squares (an endgame drill's key squares) rings every one of them (`hintSquares`). */
export function hintMarks(ladder: readonly Hint[] | null, shown: number): { hintSquare?: string; hintSquares?: readonly string[]; arrow?: string } {
  const newest = ladder && shown > 0 ? ladder[Math.min(shown, ladder.length) - 1] : undefined;
  if (!newest) return {};
  return {
    ...(newest.square ? { hintSquare: newest.square } : {}), ...(newest.squares && newest.squares.length > 1 ? { hintSquares: newest.squares } : {}),
    ...(newest.level === 4 && newest.arrow ? { arrow: newest.arrow } : {}),
  };
}

/**
 * Version 7.3: once an endgame drill is complete, its key squares are ringed on the board, so the explanation's "guards
 * b6 and c6" can be read off the position. Only then: while he solves, the squares appear with the second hint, as any
 * hint does. Empty for every other card and for a drill without key squares.
 */
export function drillKeySquares(item: Pick<TrainerItem, 'id' | 'themes'> | null | undefined, complete: boolean): readonly string[] {
  if (!item || !complete || !isEndgameDrill(item)) return [];
  return drillTeach(item.id)?.keySquares ?? [];
}

/** The hint text under its label: a leading "Target:" or "Targets:" is dropped, the label already says it. */
export function hintBody(h: Hint): string {
  const label = HINT_LABELS[h.level - 1] ?? '';
  const lead = label ? new RegExp(`^${label}s?:\\s*`).exec(h.text) : null;
  if (!lead) return h.text;
  const rest = h.text.slice(lead[0].length);
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : h.text;
}

/** Every hint shown at this step stays listed, each with its level label. */
export function HintLadder({ hints, shown }: { hints: readonly Hint[]; shown: number }) {
  const list = hints.slice(0, Math.max(0, shown));
  if (!list.length) return null;
  return <ol className="hint-ladder" aria-label="Hints" aria-live="polite">
    {list.map(h => <li key={h.level} className="hint-box"><Lightbulb size={18} aria-hidden="true"/><p><strong>{`${HINT_LABELS[h.level - 1]}:`}</strong>{` ${hintBody(h)}`}</p></li>)}
  </ol>;
}

/** 9.1: a background check of a try ends this long after the try, with or without a result. */
export const TRY_DEADLINE_MS = 6000;
/** The identity of a try (9.1: same card, step and try): the try view's key, matched by the coach input. */
export const tryKey = (id: string, index: number, uci: string) => `${id}|${index}|${uci}`;

/** What the panel shows for the latest wrong try: "Checking …" while the engine works, then a viewer of the try and
 *  the reply line (`line` from `fenBefore`, the try first), or the result in words when there is no line.
 *  `source` says where the line came from; `check` is the engine's raw result (unrounded), kept for the coach input
 *  and the grading of stages (b) and (c). */
export interface TryView {
  key: string; status: 'checking' | 'done'; trySan: string; fenBefore: string; line: string[]; title: string; intro?: string;
  /** The card's moves still to find at that step, by identity with their SAN (9.11.2 t, `answerMovesFrom`): while he
   *  solves, the viewer stops before any of them, and its sentences leave out every one of them (`omit`, 9.11.8). */
  answers: AnswerMove[];
  /** 9.11.2 (r) 3: the page's figure for the try's line (the try's Win% for the solver), when the page shows one. */
  verdict?: LineVerdict;
  /** The rounded pair the intro shows (the try's Win% and the best move's), when it shows one. */
  numbers?: { tryWin: number; bestWin: number };
  source?: 'engine' | 'stored' | 'tablebase'; check?: TryCheck;
  /** Stage (c), 9.1: the board waits for this check (own-game kinds); the message line says "Checking …", the slot nothing. */
  blocking?: boolean;
  /** Stage (c), 9.1: a soft retry: the line is one press away instead of open. A counted miss is open here; on a phone
   *  the page shows every finished try one press away (`tryCollapsedOnPhone`, 9.10 h, extended by 9.11.3). */
  collapsed?: boolean;
}
type TryText = Pick<TryView, 'line' | 'title' | 'intro'>;

/** The card's own moves still to find from step `at` (the solver's moves: at, at + 2, ...), as SAN from `fenBefore`. */
export function answerSansFrom(item: Pick<TrainerItem, 'moves'>, fenBefore: string, at: number): string[] {
  return sanFrom(fenBefore, item.moves.slice(at)).filter((_, i) => i % 2 === 0);
}
const sanCore = (san: string) => san.trim().replace(/[+#]+$/, '');
/** True when `text` names one of `sans` as a whole move (check and mate signs ignored). */
export function namesAnyMove(text: string, sans: readonly string[]): boolean {
  return sans.map(sanCore).filter(Boolean).some(core =>
    new RegExp(`(^|[^A-Za-z0-9=-])${core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9=-])`).test(text));
}
/** The answer moves a drill note (free text, SAN) must not name: all of them except the try's own name (already on
 *  screen). Try lines use move identity instead (`cutBeforeAnswer`). */
export const hiddenAnswers = (answerSans: readonly string[], trySan: string) => answerSans.filter(s => sanCore(s) !== sanCore(trySan));

/** A move still to find: its identity (9.11.2 t 1: the piece that moves, its two squares, the new piece) and, optional,
 *  its SAN at its own step, the name 8.2 keeps off the screen while he solves. */
export type AnswerMove = MoveRef & { san?: string };
/** The card's own moves still to find from step `at` (the solver's moves: at, at + 2, ...), each by identity with its SAN
 *  at its own step. The list ends at a move that does not replay. */
export function answerMovesFrom(item: Pick<TrainerItem, 'moves'>, fenBefore: string, at: number): AnswerMove[] {
  const rest = item.moves.slice(Math.max(0, at));
  const positions = positionsAlong(fenBefore, rest);
  const answers: AnswerMove[] = [];
  for (let k = 0; k < rest.length; k += 2) {
    const ref = k < positions.length ? moveRefOf(positions[k], rest[k]) : null;
    if (!ref) break;
    answers.push({ ...ref, san: sanAt(positions[k], rest[k]) });
  }
  return answers;
}

/** 9.11.2 (r) and (t): the narrator options a try viewer reads its line with: the try's figure, and while he solves the
 *  answer as `omit`; never "No material changes hands.". The cut reads the line the same way. FXR2b1 (brief 9.11.8):
 *  `omit` is the whole `answers` list (every move still to find, an empty list when none replays), not only the move at
 *  this step; null once the card is complete. */
export function tryViewerOptions(view: Pick<TryView, 'answers' | 'verdict'>, solving: boolean): ViewerNarrateOptions {
  return { verdict: view.verdict ?? null, omit: solving ? view.answers : null, noChangeSentence: false };
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** How a sentence points at the piece that makes the move `a`: "the knight on f3", or "the king". */
const moverWords = (a: MoveRef) => (a.piece === 'k' ? 'the king' : `the ${PIECE_NAME[a.piece]} on ${a.from}`);
/** The SAN of the move `a` in `fen` when that very move is legal there, else ''. */
function sanOfRef(fen: string, a: MoveRef): string {
  const uci = `${a.from}${a.to}${a.promotion ?? ''}`;
  return sameMove(fen, uci, a) ? sanAt(fen, uci) : '';
}
/** The move a SAN stands for in `fen` (the narrator's mate-in-one fact), or null. */
function moveOfSan(fen: string, san: string): MoveRef | null {
  try {
    const m = new Chess(fen).move(san);
    return { from: m.from, to: m.to, piece: m.piece as MoveRef['piece'], ...(m.promotion ? { promotion: m.promotion as MoveRef['promotion'] } : {}) };
  } catch { return null; }
}

/**
 * Do the sentences a try viewer shows for `line` (read with `opts`, the viewer's own narrator options) describe one of
 * `hidden`, by move identity (9.11.2 t 1)? A move counts as named by:
 * - its SAN, where that very move is legal: the position after a move for that move's caption, the end of the line for
 *   the summary;
 * - a caption's hanging clause whose capture is that move (that piece, from its square, taking on its square), or its
 *   "it allows mate in one" when that mate is that move (the viewer leaves the mating move unnamed, not unsaid);
 * - a caption's threat by a piece that has just moved onto that move's square ("… attacks the queen on d7");
 * - the summary's words for that piece and its squares: "the knight on f3 can take the bishop on g5", "the knight on
 *   e5 attacks … on d7", "White's pawn on b7 can promote", a take-back on its square or a new piece taken there.
 * `omit` already keeps the answer's moves out of the clauses it covers (every move still to find since 9.11.8, FXR2b1);
 * this finds the rest (and those, should a clause slip through). 8.2 guard: no sentence prints `names`, the answers' own SAN (the try's own name aside), whichever
 * move it would stand for there, as in fix 1 ("White can mate in one: Qg7#" while Qg7# is the answer).
 */
function narrationNames(fenBefore: string, line: readonly string[], hidden: readonly MoveRef[], names: readonly string[], opts: ViewerNarrateOptions): boolean {
  if ((!hidden.length && !names.length) || !line.length) return false;
  const n = narrateLine(fenBefore, line, { maxPlies: line.length, nameMate: false, verdict: opts.verdict ?? null, omit: opts.omit ?? null, noChangeSentence: opts.noChangeSentence ?? false });
  const sansIn = (fen: string) => [...names, ...hidden.map(a => sanOfRef(fen, a)).filter(Boolean)];
  for (const p of n.plies) {
    const caption = sentenceAfterMove(p.text, p.san);
    if (namesAnyMove(caption, sansIn(p.fenAfter))) return true;
    for (const h of p.facts.leftHanging) {
      const target = h.piece === 'k' ? 'the king' : `the ${PIECE_NAME[h.piece]} on ${h.square}`;
      if (caption.includes(`take ${target}`) && hidden.some(a => a.piece === h.by.piece && a.from === h.by.square && a.to === h.square)) return true;
    }
    const mate = p.facts.allowsMate ? moveOfSan(p.fenAfter, p.facts.allowsMate) : null;
    if (mate && caption.includes('mate in one') && hidden.some(a => a.piece === mate.piece && a.from === mate.from && a.to === mate.to)) return true;
    const moved = moveRefOf(p.fenBefore, p.uci);
    if (moved && hidden.some(a => a.from === moved.to && a.piece === (moved.promotion ?? moved.piece)
      && new RegExp(`\\b(?:attacks|forks|pins)\\b[^.]*\\bon ${a.to}\\b`).test(caption))) return true;
  }
  const s = n.summary;
  if (!s) return false;
  const last = n.plies[n.plies.length - 1];
  const endFen = last ? last.fenAfter : fenBefore;
  if (namesAnyMove(s, sansIn(endFen))) return true;
  return hidden.some(a => {
    const who = reEscape(moverWords(a));
    if (new RegExp(`\\b${who} (?:can )?take the [a-z]+ on ${a.to}\\b`).test(s)) return true;
    if (new RegExp(`\\b${who} attacks [^.]*\\bon ${a.to}\\b`).test(s)) return true;
    if (a.piece === 'p' && new RegExp(`\\bpawn on ${a.from} can promote\\b`).test(s)) return true;
    const legalAtEnd = sanOfRef(endFen, a) !== '';
    if (legalAtEnd && new RegExp(`\\bcan take back on ${a.to}\\b`).test(s)) return true;
    return legalAtEnd && !!last && last.uci.slice(2, 4) === a.to && /\bthe new [a-z]+ can be taken\b/.test(s);
  });
}

/**
 * 8.2 while he solves, by move identity (9.11.2 t 1): a try line stops before its first later move that IS one of the
 * answer's moves (the same piece from the same square to the same square, the same new piece when both promote),
 * whatever its SAN (Nxf3+ and Nf3+ are one move; another piece reaching that square is not), and is shortened further
 * while a caption or the summary of what is left describes one (`narrationNames`, read with the viewer's own options
 * `opts`), so an open viewer never shows the answer. A later answer that is the try's own move is already on screen and
 * hides nothing. The try itself stays, unless even its own sentences describe the answer: then there is no line.
 * 8.2 guard, kept from fix 1: a later move of his side (the try's side) printed with an answer's own SAN stops the line
 * too, though it is another piece (2.Qf7+ Kh8 3.Qg7# while the answer is Qe7-g7#), and so does a sentence printing it.
 * An opponent's move with that SAN (Black's ...Rd8 while the answer is White's Rd8+) names nothing of his.
 */
export function cutBeforeAnswer(fenBefore: string, line: readonly string[], answers: readonly AnswerMove[], opts: ViewerNarrateOptions = {}): string[] {
  const tryUci = line[0];
  const hidden = answers.filter(a => !tryUci || !sameMove(fenBefore, tryUci, a));
  const trySan = tryUci ? sanAt(fenBefore, tryUci) : '';
  const names = answers.map(a => a.san ?? '').filter(s => s && sanCore(s) !== sanCore(trySan));
  if (!hidden.length && !names.length) return [...line];
  const nameSet = new Set(names.map(sanCore));
  const positions = positionsAlong(fenBefore, line);
  const cut = line.findIndex((uci, i) => i > 0 && i < positions.length
    && (hidden.some(a => sameMove(positions[i], uci, a)) || (i % 2 === 0 && nameSet.has(sanCore(sanAt(positions[i], uci))))));
  let shown = cut === -1 ? [...line] : line.slice(0, cut);
  while (shown.length > 0 && narrationNames(fenBefore, shown, hidden, names, opts)) shown = shown.slice(0, -1);
  return shown;
}

/** F3 (brief m31 4.6): a try viewer is titled "Why {try} doesn't work" only when the try is classed worse or losing
 *  AND keeps less than `KEEPS_EDGE_FROM` (55) for the solver, on the figure the page prints (rounded). A try that still
 *  keeps 55 or more gets "What could follow {try}", on every kind of card. */
export function failsBadly(cls: ReturnType<typeof classifyWin> | null, tryWin: number): boolean {
  return (cls === 'worse' || cls === 'losing') && Math.round(tryWin) < KEEPS_EDGE_FROM;
}

/** Title and intro for an engine check while the card is not solved: the try's result only, never the answer's SAN
 *  (8.2). Numbers only from a search deep enough to trust (9.1: depth 0, a finished position, or 10 and more).
 *  F3: the title says "doesn't work" only under 55% (`failsBadly`). */
export function engineTryText(check: Pick<TryCheck, 'trySan' | 'tryWin' | 'bestWin' | 'depth'>, solver: Side): { title: string; intro?: string } {
  const trusted = check.depth === 0 || check.depth >= TRUSTED_DEPTH;
  const cls = trusted ? classifyWin(check.tryWin, check.bestWin) : null;
  if (!cls || check.bestWin === null) return { title: `What could follow ${check.trySan}` };
  return {
    title: failsBadly(cls, check.tryWin) ? `Why ${check.trySan} doesn't work` : `What could follow ${check.trySan}`,
    intro: `After ${check.trySan} the engine gives ${sideName(solver)} ${Math.round(check.tryWin)}% to win; the best move keeps ${Math.round(check.bestWin)}%.`,
  };
}

/** L4's stored fallback, only for a mistake card from his games (not punish) at its first step when the try is his
 *  game move: the line the engine check of his game stored after that move, with that check's numbers. */
export function storedTryText(item: TrainerItem, fenBefore: string, tryUci: string, index: number): TryText | null {
  if (teachKind(item) !== 'pack' || index !== 0 || item.pack?.playedUci !== tryUci || fenKey(fenBefore) !== fenKey(item.fen)) return null;
  const reply = item.pack?.refutationPvUci;
  const trySan = sanAt(fenBefore, tryUci);
  if (!Array.isArray(reply) || !reply.length || !trySan) return null;
  // `winAfter` and `winBefore` are his view, and he is the solver on these cards; before his move = after the best move.
  const after = item.pack?.winAfter, before = item.pack?.winBefore;
  const cls = finite(after) && finite(before) ? classifyWin(after, before) : null;
  return {
    line: [tryUci, ...reply],
    title: finite(after) && failsBadly(cls, after) ? `Why ${trySan} doesn't work` : `What could follow ${trySan}`,
    ...(cls && finite(after) && finite(before) ? { intro: `After ${trySan} the engine gives ${sideName(sideOf(fenBefore))} ${Math.round(after)}% to win; the best move keeps ${Math.round(before)}%.` } : {}),
  };
}

/** 9.12.2 item 6 (V2-1): true when `text` names one of `squares` ("d4"), alone or inside a move ("(d4 to h8)", "Kxd4"):
 *  the square's two characters with no digit right before or after them. */
export function namesAnySquare(text: string, squares: readonly string[]): boolean {
  return squares.some(sq => /^[a-h][1-8]$/.test(sq) && new RegExp(`(?<![0-9])${sq}(?![0-9])`).test(text));
}
/** 9.12.2 item 6 (V2-1): the squares a drill note shown while he solves must not name: the destination square of every
 *  move still to find (`answers`, from `answerMovesFrom` at the try's step), except the try's own destination square,
 *  which his try already shows. */
export function hiddenAnswerSquares(answers: readonly Pick<MoveRef, 'to'>[], tryUci: string): string[] {
  const own = tryUci.slice(2, 4);
  return [...new Set(answers.map(a => a.to))].filter(sq => sq !== own);
}

/** Endgame drills (never the engine, 9.1): the tablebase result in words, and the listed try line with its note. The
 *  words come from `gradeTry`, which also drops a note that names the answer. Null when the move has no result. */
export function drillTryText(item: TrainerItem, fenBefore: string, tryUci: string, index: number): TryText | null {
  const trySan = sanAt(fenBefore, tryUci);
  const t = trySan ? teachTry(item.id, fenBefore, tryUci) : { result: null };
  if (!trySan || !t.result) return null;
  const g = gradeTry({ kind: 'endgame', trySan, answerSan: sanAt(fenBefore, item.moves[index]), solver: sideOf(fenBefore), tryUci, teach: { ...t, goal: drillGoalAt(item, index) } });
  // `gradeTry` drops a note that names this step's answer; a note that names a later step's answer is dropped here, and
  // so is a note that names the destination square of any move still to find, the try's own square aside (9.12.2 item 6,
  // V2-1: "(d4 to h8)" gives Kd4). The message ("This loses." / "This only draws.") stays.
  const note = g.intro && !namesAnyMove(g.intro, hiddenAnswers(answerSansFrom(item, fenBefore, index), trySan))
    && !namesAnySquare(g.intro, hiddenAnswerSquares(answerMovesFrom(item, fenBefore, index), tryUci)) ? g.intro : '';
  return {
    line: t.tryLine ? [tryUci, ...t.tryLine.lineUci] : [],
    title: g.cls === 'goal-lost' ? `Why ${trySan} doesn't work` : `What could follow ${trySan}`,
    intro: [g.message, note].filter(Boolean).join(' '),
  };
}

/** One background check at a time: a new try, a step change or a new card stops the old one, so its result is dropped. */
export interface TryGate { start(): { token: number; signal: AbortSignal }; stop(): void; owns(token: number): boolean; finish(token: number): void; pending(): boolean }
export function createTryGate(): TryGate {
  let live: { token: number; ctrl: AbortController } | null = null, next = 0;
  const stop = () => { live?.ctrl.abort(); live = null; };
  return {
    start() { stop(); const ctrl = new AbortController(); live = { token: ++next, ctrl }; return { token: live.token, signal: ctrl.signal }; },
    stop,
    owns: token => live?.token === token,
    finish(token) { if (live?.token === token) live = null; },
    pending: () => live !== null,
  };
}

/** `checkTry` (A4) with a deadline counted from the try. Null when the engine fails, the check is stopped or the
 *  deadline passes: the caller then uses the stored line where L4 allows one, or shows nothing. */
export async function checkTryWithin(engine: AnalysisEngine, fenBefore: string, tryUci: string, answerUci: string | null, signal: AbortSignal, deadlineMs = TRY_DEADLINE_MS): Promise<TryCheck | null> {
  if (signal.aborted) return null;
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, deadlineMs);
  try { return await checkTry(engine, fenBefore, tryUci, answerUci, { signal: ctrl.signal }); } catch { return null; } finally {
    clearTimeout(timer); signal.removeEventListener('abort', stop);
  }
}

/** Stage (b): the engine check of one move named in a question (L6), with the same deadline as a try. The shared
 *  engine is created here at the first question when no wrong try created it earlier (section 7: never at page
 *  load). Null without an engine (no Web Worker), on a failure, past the deadline or when the question is stopped. */
export function questionCheck(fenBefore: string, uci: string, answerUci: string | null, signal: AbortSignal): Promise<TryCheck | null> {
  const engine = getSharedEngine();
  return engine ? checkTryWithin(engine, fenBefore, uci, answerUci, signal) : Promise.resolve(null);
}

/** Starts a check through `gate` and hands its result (null: none) to `apply`, unless the gate was stopped or
 *  restarted first (a newer try, a step change, a new card or leaving the page). */
export function backgroundCheck(gate: TryGate, engine: AnalysisEngine, fenBefore: string, tryUci: string, answerUci: string | null,
  apply: (check: TryCheck | null) => void, deadlineMs = TRY_DEADLINE_MS): Promise<void> {
  const { token, signal } = gate.start();
  return checkTryWithin(engine, fenBefore, tryUci, answerUci, signal, deadlineMs).then(check => {
    if (!gate.owns(token)) return;
    gate.finish(token);
    apply(check);
  });
}

/** 9.10 (n): the try line shown while he solves: `cutBeforeAnswer`'s line (read as the viewer reads it while he solves,
 *  `tryViewerOptions`), or none when that cut leaves his try alone (a move without its reply shows nothing; the slot
 *  then prints the result in words). A line that was his try alone before any cut (no reply to show, as after a
 *  stalemating try) is kept. */
export function solvingTryLine(view: Pick<TryView, 'fenBefore' | 'line' | 'answers' | 'verdict'>): string[] {
  const cut = cutBeforeAnswer(view.fenBefore, view.line, view.answers, tryViewerOptions(view, true));
  return cut.length === 1 && view.line.length > 1 ? [] : cut;
}

/** 9.10 (h), the lead's 02:00 ruling and 9.11.3: true while the try slot sits right under the message line on a phone
 *  (`PracticeColumns`). Its line then starts one press away, every counted miss included, so the toggle is on the first
 *  screen; at wider widths a counted miss stays open where it is. False outside `PracticeColumns`. */
const TryByBoard = createContext(false);

/** The label of a try line that starts one press away (9.10 h, 9.11.3): "See the engine's reply" for an engine or stored
 *  line; on a drill, "See the line" for a counted miss (9.11.3) and "See the tablebase line" for a soft retry (as built
 *  in stage 1; the ruling names the counted miss only). */
export function tryToggleLabel(view: Pick<TryView, 'source' | 'collapsed'>): string {
  if (view.source !== 'tablebase') return "See the engine's reply";
  return view.collapsed ? 'See the tablebase line' : 'See the line';
}

/** The latest try: "Checking …", then its viewer, or the result in words. The viewer is open after a counted miss and
 *  one press away after a soft retry, or when the slot sits under the message line on a phone (`TryByBoard`). While he
 *  solves (`solving`), the line stops before any move of the answer, a line cut down to his try alone is not shown, and
 *  no sentence describes a move of the answer (`omit`, 9.11.2 t 2 and 9.11.8); once the card is complete it is shown whole. The
 *  viewer gets the try's figure (`verdict`, 9.11.2 r 3) and never closes on "No material changes hands.". It opens on his
 *  try (`initialStep` 1, 9.11.3 R6-3), so its first request is to guess the reply; the intro (the try's figures, or a
 *  drill's note) is the caption one step back, at the start. */
export function TrySlot({ view, solving }: { view: TryView | null; solving: boolean }) {
  const byBoard = useContext(TryByBoard);
  // The cut narrates the line, so it runs once per try and state, not on every render of the page.
  const line = useMemo(() => (view?.status !== 'done' ? [] : solving ? solvingTryLine(view) : view.line), [view, solving]);
  if (!view) return null;
  // Stage (c): while the board waits for the grade, the message line already says "Checking …".
  if (view.status === 'checking') return view.blocking ? null : <p className="try-check small" role="status">{`Checking ${view.trySan}…`}</p>;
  if (line.length) {
    // 9.1: after a soft retry the line is one press away; after a counted miss it is open, except under the message
    // line on a phone (9.10 h, extended by 9.11.3 to every counted miss), where it is one press away too.
    const closed = view.collapsed || byBoard ? { defaultOpen: false, toggleLabel: tryToggleLabel(view) } : {};
    const { verdict, omit } = tryViewerOptions(view, solving);
    // 7.3: an endgame drill's own note is the reason the try fails (authored, and already cleared of every move still
    // to find: `drillTryText`). It stands above the line, in plain sight. Until 7.3 it was only the viewer's caption
    // one step back from where the viewer opens, so it was read only by pressing Back.
    const note = view.source === 'tablebase' && view.intro ? view.intro : '';
    return <div className="try-check">{note && <p className="try-note small">{note}</p>}<LineViewer key={view.key} title={view.title} startFen={view.fenBefore} line={line} orientation={sideOf(view.fenBefore)} intro={note ? undefined : view.intro}
      initialStep={1} verdict={verdict} omit={omit} noChangeSentence={false} {...closed}/></div>;
  }
  return view.intro ? <p className="try-check small">{view.intro}</p> : null;
}

const playedSanOf = (item: TrainerItem): string => {
  const p = item.pack ?? {};
  if (typeof p.playedSan === 'string' && p.playedSan) return p.playedSan;
  return typeof p.sourceFen === 'string' && typeof p.playedUci === 'string' ? sanAt(p.sourceFen, p.playedUci) : '';
};

/** F2 (brief m31 4.6): his game move as a punish card's lead names it: "Nxd5 (highlighted)"; and where the solver could
 *  play the same SAN (`playedLabel` adds the piece and its from-square), "Nxd5 (the knight from f6; highlighted)". */
export function highlightedMove(item: TrainerItem, played: string): string {
  const label = playedLabel(item);
  const note = label.startsWith(`${played} (`) && label.endsWith(')') ? label.slice(played.length + 2, -1) : '';
  return note ? `${played} (${note}; highlighted)` : `${played} (highlighted)`;
}

/** L8 / section 7: a punish card's lead while he solves it (his game move is the highlighted last move). */
export function punishLead(item: TrainerItem): string {
  const played = playedSanOf(item);
  if (played && typeof item.pack?.playedUci === 'string') {
    return `In your game you played ${highlightedMove(item, played)}. Now play ${sideName(sideOf(item.fen))}, your opponent’s side: find the move that makes it cost.`;
  }
  return 'This is the position after your move in one of your games. Play your opponent’s side and find the move that takes advantage of it.';
}

/** Section 7: after a punish card, the move he played and the move he should have played (sibling card; guards in
 *  `betterMoveSan`). No sibling: the first sentence only. */
export function PunishGameLine({ item, sibling }: { item: TrainerItem; sibling?: TrainerItem }) {
  const played = playedSanOf(item);
  if (!played) return null;
  const better = betterMoveSan(item, sibling ?? null);
  return <p className="punish-game-line"><strong>In your game</strong>{` you played ${played}.${better ? ` Better was ${better}.` : ''}`}</p>;
}

/** L5: a punish card's lesson; null on other kinds and when the card has no usable line or game move.
 *  Version 7.1 (brief m31 4.3, row L): with what its quiet reply threatens, when the card has a stored threat
 *  (`lessonThreat`, the one definition the reading lists and the coach input use too). */
export const lessonFor = (item: TrainerItem, sibling?: TrainerItem): string | null =>
  (teachKind(item) === 'punish' ? punishLesson(item, sibling ?? null, { threat: lessonThreat(item) }) : null);

/** 9.10 (f): after a punish card his game move is named once. The lesson opens "In your game you played X." and ends
 *  "Better was Y.", so with a lesson neither the corrected line (`PunishGameLine`) nor the stored explanation shows.
 *  Without a lesson the stored explanation is the fallback, and the corrected line shows only when there is no stored
 *  explanation either (a punish card's stored text opens "In your game you played X here." too). Other kinds keep
 *  their stored explanation and have no corrected line. */
export function solvedTextsOf(item: Pick<TrainerItem, 'kind' | 'explanation'>, lesson: string | null): { gameLine: boolean; explanation: boolean } {
  const stored = !!item.explanation;
  if (!isPunish(item)) return { gameLine: false, explanation: stored };
  if (lesson) return { gameLine: false, explanation: false };
  return { gameLine: !stored, explanation: stored };
}

// ---------------------------------------------------------------- Version 7.1: after the card (brief m31 4.3, 4.4, 4.8)
// Pure functions for what a finished card adds. Each names the answer or narrates a line, so the page reads them only
// once the card is complete (`SolvedNotes` and `SolvedViewers`, which the Trainer renders in its `complete` branches).

/** Brief m31 4.4: the ids of the mistake cards whose punish sibling is held as 'not-held' (for the position after his
 *  game move, the engine's first move is not the stored reply). For those the page does not say what his move "allowed". */
export function notHeldSiblingIds(pools: Partial<Pick<Pools, 'notHeld'>>): Set<string> {
  const ids = new Set<string>();
  for (const p of pools.notHeld ?? []) { const id = punishSiblingId(p); if (id) ids.add(id); }
  return ids;
}
/** `notHeldSiblingIds` for the card components (`SolvedNotes`, `SolvedViewers`), whose call sites keep their props. Empty
 *  where nothing provides it (tests, a page without the document). */
export const NotHeldSiblings = createContext<ReadonlySet<string>>(new Set<string>());

/** His game move on a mistake card, read as its own punish card (brief m31 4.4 and section 10, 01:16). */
export interface GameMoveView {
  /** The position after his game move. */ fen: string;
  /** The stored reply's first move. */ moves: string[];
  kind: 'punish'; themes: string[];
  pack: { /** The card's position. */ sourceFen: string; playedUci: string; playedSan: string; /** `pack.refutationPvUci`. */ pvUci: string[]; /** His Win% after his move. */ winAfter?: number };
}
function gameMoveViewOf(item: TrainerItem): GameMoveView | null {
  if (teachKind(item) !== 'pack' || isEngineScanCard(item)) return null;
  const p = item.pack ?? {};
  const playedUci = typeof p.playedUci === 'string' ? p.playedUci : '';
  const reply = Array.isArray(p.refutationPvUci) && p.refutationPvUci.every(m => typeof m === 'string') ? p.refutationPvUci : [];
  if (!playedUci || !reply.length || playedUci === item.moves[0]) return null;
  const positions = positionsAlong(item.fen, [playedUci]);
  const playedSan = sanAt(item.fen, playedUci);
  if (positions.length !== 2 || !playedSan || !sanAt(positions[1], reply[0])) return null;
  const after = p.winAfter;
  return {
    fen: positions[1], moves: [reply[0]], kind: 'punish', themes: ['personal', 'punish'],
    pack: { sourceFen: item.fen, playedUci, playedSan, pvUci: [...reply], ...(finite(after) ? { winAfter: after } : {}) },
  };
}
const GAME_MOVE_VIEWS = new WeakMap<object, GameMoveView | null>();
/**
 * Brief m31 4.4 (NEW, section 10 at 01:16): his game move on a mistake card as its own punish card: `fen` is the position
 * after `pack.playedUci`, `moves` the stored reply's first move, `pack.pvUci` the stored reply line
 * (`pack.refutationPvUci`), `pack.sourceFen` the card's position, and `pack.winAfter` his Win% after that move (what a
 * punish card stores, so `classifyPunish` reads it). It carries no id and no `teach`: nothing from the document is read
 * for it. Null unless the card is a mistake card from his games (not a punish card, not a short engine scan) with a
 * legal game move other than the answer and a stored reply whose first move is legal after it. Cached per card object.
 */
export function gameMoveView(item: TrainerItem): GameMoveView | null {
  if (!item || typeof item !== 'object') return null;
  const hit = GAME_MOVE_VIEWS.get(item);
  if (hit !== undefined) return hit;
  let view: GameMoveView | null = null;
  try { view = gameMoveViewOf(item); } catch { view = null; }
  GAME_MOVE_VIEWS.set(item, view);
  return view;
}

/** What the stored line after his game move shows, read with the narrator (twice, once per card; cached). */
interface GameMoveFacts {
  view: GameMoveView;
  /** His game move, then the stored reply line, from the card's position: the viewer's line. */
  line: string[];
  /** The material count at the end of that line for him, in pawns, his own move's capture included (above 0: he is ahead). */
  netForHim: number;
  /** The stored reply line ends in mate by his opponent. */
  mate: boolean;
  /** The line is settled with him behind in material, counted both ways: from the position after his move (as a punish
   *  lesson counts) and from the card's position with his move included (so a piece he took and lost again is no loss). */
  loss: boolean;
}
const GAME_MOVE_FACTS = new WeakMap<object, GameMoveFacts | null>();
function gameMoveFacts(item: TrainerItem): GameMoveFacts | null {
  const view = gameMoveView(item);
  if (!view) return null;
  const hit = GAME_MOVE_FACTS.get(item);
  if (hit !== undefined) return hit;
  let facts: GameMoveFacts | null = null;
  try {
    const line = [view.pack.playedUci, ...view.pack.pvUci];
    // From the card's position, his move first (the count the viewer's closing sentence makes; the first mover is him).
    const whole = narrateLine(item.fen, line, { maxPlies: line.length });
    // From the position after his move, as a punish lesson reads the line (the first mover is his opponent).
    const reply = narrateLine(view.fen, view.pack.pvUci, { maxPlies: 32 });
    const last = reply.plies[reply.plies.length - 1];
    facts = {
      view, line, netForHim: whole.material.net,
      mate: reply.result === 'mate' && !!last && last.color === reply.material.pov,
      loss: reply.material.settled && reply.material.net > 0 && whole.material.settled && whole.material.net < 0,
    };
  } catch { facts = null; }
  GAME_MOVE_FACTS.set(item, facts);
  return facts;
}

/**
 * Brief m31 4.4, the words: one paragraph about what his game move allowed, after a mistake card. It is the punish lesson
 * of `gameMoveView(item)` with no engine figure and no "Better was": "In your game you played X. That allowed A, which …".
 * Only when the stored reply line ends in mate by his opponent, or is settled with him behind in material (`loss`
 * above: by both counts), and the punish sibling is not held as 'not-held' (`siblingNotHeld`). Null otherwise, on every
 * other kind and on a short engine scan. No document data is used. Narrates: read only once the card is complete.
 */
export function gameMoveWords(item: TrainerItem, siblingNotHeld = false): string | null {
  if (siblingNotHeld) return null;
  const f = gameMoveFacts(item);
  if (!f || !(f.mate || f.loss)) return null;
  return punishLesson(f.view, null, { betterMove: false, engineFigure: false });
}

/** The line viewer of his game move (brief m31 4.4). */
export interface GameMoveViewer {
  /** The card's position, and from it his game move followed by the stored reply line. */ fen: string; line: string[];
  title: string; toggle: string;
  /** The stored pair for his game move, as the try viewer words it (`storedTryText`); absent without both figures. */ intro?: string;
  /** The figure for the line: his Win% after his game move. */ verdict: LineVerdict | null;
  /** True when the title says what his move "allowed". */ allowed: boolean;
}
/**
 * Brief m31 4.4, the viewer: on every mistake card from his games that is not a short engine scan and has a stored
 * reply (`gameMoveView`), a viewer over `[pack.playedUci, ...pack.refutationPvUci]` from the card's position, with the
 * stored figure `{ side: solver, win: pack.winAfter }` and the stored-pair sentence as its first caption. The page shows
 * it last, closed, opening on his move (step 1).
 * Titled "What your game move {X} allowed" (toggle "Show what {X} allowed") only when all three hold: his opponent
 * stands at 65% or more after his move (`100 - pack.winAfter`, the line that makes a punish card); the line does not
 * end with him ahead in material (his move's own capture counted; settled or not); and the punish sibling is not held
 * as 'not-held' (`siblingNotHeld`). Otherwise "The engine's line after your game move {X}" (toggle "Show the line after {X}").
 * Null (hidden) when the try slot already shows a line for his game move (`latest`: his game move tried at the card's
 * own position, from the stored line or a live check), so one move is not stepped through twice with two figures.
 */
export function gameMoveViewer(item: TrainerItem, latest?: TryView | null, siblingNotHeld = false): GameMoveViewer | null {
  const f = gameMoveFacts(item);
  if (!f) return null;
  const { playedUci, playedSan, winAfter } = f.view.pack;
  const at = tryAtStart(item, latest);
  if (at && at.line.length > 0 && (at.check?.tryUci ?? at.line[0]) === playedUci) return null;
  const allowed = finite(winAfter) && 100 - winAfter >= PUNISH_MIN_WIN && !(f.netForHim > 0) && !siblingNotHeld;
  const intro = storedTryText(item, item.fen, playedUci, 0)?.intro;
  return {
    fen: item.fen, line: f.line,
    title: allowed ? `What your game move ${playedSan} allowed` : `The engine's line after your game move ${playedSan}`,
    toggle: allowed ? `Show what ${playedSan} allowed` : `Show the line after ${playedSan}`,
    ...(intro ? { intro } : {}), verdict: finite(winAfter) ? { side: sideOf(item.fen), win: winAfter } : null, allowed,
  };
}

/** Brief m31 4.3, row P: what the quiet answer of a mistake card threatens, as the last paragraph of its notes (a punish
 *  card says it inside its lesson, `lessonFor`). Null without a stored threat that passes the page's checks. It narrates
 *  the threat line (`threatSay`, cached per card): read only once the card is complete. */
export function threatParagraph(item: TrainerItem): string | null {
  if (!item.teach || teachKind(item) !== 'pack') return null;
  return threatSay(item)?.paragraph ?? null;
}

/** Brief m31 4.3, row V: the threat viewer of a mistake or punish card: from the pass position (the answer played, the
 *  move handed back), the stored threat line, with its title, toggle and first caption. No verdict and no figure. Null
 *  without a stored threat that passes the page's checks. Read only once the card is complete. */
export function threatViewerOf(item: TrainerItem): ThreatSay['viewer'] | null {
  const kind = teachKind(item);
  if (!item.teach || (kind !== 'pack' && kind !== 'punish')) return null;
  return threatSay(item)?.viewer ?? null;
}

/** What `SolvedNotes` adds under a finished mistake card, in this order. */
export interface AfterCardNotes {
  /** Brief m31 4.4: the words about what his game move allowed. */ gameMove: string | null;
  /** Brief m31 4.3, row P: what the quiet answer threatens. */ threat: string | null;
}
/** The words about his game move (brief m31 4.4), then what the answer threatens (4.3, row P). Each is null when the card
 *  has none; both are null on every kind but a mistake card from his games. */
export function afterCardNotes(item: TrainerItem, siblingNotHeld = false): AfterCardNotes {
  return { gameMove: gameMoveWords(item, siblingNotHeld), threat: threatParagraph(item) };
}

/** After a card: an endgame drill's idea (L9), a punish card's lesson (L5). `lesson`, when given, is the lesson the
 *  page already made (`lessonFor`), so the line is narrated once; without it the lesson is made here. 9.11.3 (R4-6): a
 *  drill with a stored explanation shows that explanation (the solved panel prints it) and not "The idea", which says
 *  the same thing; the idea is the fallback for a drill without one.
 *  Version 7.1 (brief m31 4.4 and 4.3): after a mistake card, one paragraph about what his game move allowed (only
 *  where its line shows a loss or a mate), then, last, what the quiet answer threatens (`afterCardNotes`). */
export function SolvedNotes({ item, sibling, lesson: given }: { item: TrainerItem; sibling?: TrainerItem; lesson?: string | null }) {
  const kind = teachKind(item);
  const lesson = useMemo(() => (given !== undefined ? given : lessonFor(item, sibling)), [item, sibling, given]);
  const idea = kind === 'endgame' && !item.explanation ? drillTeach(item.id)?.idea ?? null : null;
  const siblingNotHeld = useContext(NotHeldSiblings).has(item.id);
  const more = useMemo(() => afterCardNotes(item, siblingNotHeld), [item, siblingNotHeld]);
  if (!lesson && !idea && !more.gameMove && !more.threat) return null;
  return <div className="teach-notes">
    {idea && <p><strong>The idea: </strong>{idea}</p>}
    {lesson && <p>{lesson}</p>}
    {more.gameMove && <p className="game-move-words">{more.gameMove}</p>}
    {more.threat && <p className="threat-words">{more.threat}</p>}
  </div>;
}

/** The sibling card's line from `pack.sourceFen`, when `betterMoveSan`'s guards pass (legal there, same position, not
 *  his game move). */
export function gameLineOf(item: TrainerItem, sibling?: TrainerItem): { fen: string; line: string[] } | null {
  const fen = item.pack?.sourceFen;
  if (typeof fen !== 'string' || !sibling || !betterMoveSan(item, sibling)) return null;
  const line = answerLineOf(sibling);
  return line.length ? { fen, line } : null;
}

/** 9.11.3 ((r) 3, added 08:09): the figure for "What you could have played in the game": his side (to move at
 *  `pack.sourceFen`) and the sibling card's stored Win% after that move (`pack.winBefore`, his view: before his game
 *  move). None without that line or that figure. */
export function gameLineVerdict(item: TrainerItem, sibling?: TrainerItem): LineVerdict | null {
  const game = gameLineOf(item, sibling);
  const w = sibling?.pack?.winBefore;
  return game && finite(w) ? { side: sideOf(game.fen), win: w } : null;
}

/** 9.10 (m): a position from his games that the Site app saved or this page made (source 'personal'; both tag it with the
 *  'personal' theme, though a Site backup may hold one without it): its line is a short engine scan, so its viewer names
 *  the line and does not claim why the move works. Pack and punish cards carry the 'personal' theme too; their lines
 *  come from the offline engine pass. */
export const isEngineScanCard = (item: Pick<TrainerItem, 'source'>) => item.source === 'personal';

/** The latest try's view when it is a try at the card's own position (step 0): the answer viewer starts there. */
function tryAtStart(item: Pick<TrainerItem, 'id' | 'fen'>, latest: TryView | null | undefined): TryView | null {
  return latest && latest.status === 'done' && latest.key.startsWith(tryKey(item.id, 0, '')) && fenKey(latest.fenBefore) === fenKey(item.fen) ? latest : null;
}

/**
 * 9.11.2 (r) 3: the figure the answer viewer ("Why {answer} works", from the card's position) gets for its line, `win`
 * being the solver's Win% after the answer:
 * - E1 (brief m31 4.6), first: his own game's card that stores a figure for the answer: that stored figure
 *   (`pack.winBefore` on a mistake card that is not a short engine scan; `solverWinAfter` on a punish card). The viewer's
 *   first caption prints the same stored figure, so the answer has one figure inside this viewer;
 * - else a finished engine check of a try at this step whose numbers the page showed: its figure for the answer;
 * - else a short engine scan's card with a stored `pack.winBefore`: that figure (as before 7.1);
 * - else a Lichess puzzle: winning for the solver (a Lichess solution wins by construction), unless its themes include
 *   `equality`;
 * - drills, Claude's drills and anything else: none.
 */
export function answerViewerVerdict(item: TrainerItem, latest?: TryView | null): LineVerdict | null {
  const solver = sideOf(item.fen);
  const kind = teachKind(item);
  if (kind === 'pack' && !isEngineScanCard(item)) { const w = item.pack?.winBefore; if (finite(w)) return { side: solver, win: w }; }
  if (kind === 'punish') { const w = solverWinAfter(item); if (w !== null) return { side: solver, win: w }; }
  const at = tryAtStart(item, latest);
  if (at?.source === 'engine' && at.numbers && at.check && finite(at.check.bestWin)) return { side: solver, win: at.check.bestWin };
  if (kind === 'pack') { const w = item.pack?.winBefore; return finite(w) ? { side: solver, win: w } : null; }
  if (kind === 'bank') return item.themes.includes('equality') ? null : { side: solver, winning: true };
  return null;
}

/**
 * 9.11.2 (r) 5 (R4-5): the answer viewer on a card from his games (not punish, not a short engine scan) opens at its
 * stored position with the stored numbers: "After {answer} the engine gives you {winBefore}% to win; your game move
 * {played} left {winAfter}%." Shown once: left out whenever the try viewer on the page shows figures for his game move
 * (his game move tried at this step, with the stored pair or a live check's numbers; 9.11.3, the 08:09 addition, which
 * replaced "the same rounded pair").
 */
export function storedNumbersIntro(item: TrainerItem, latest?: TryView | null): string | undefined {
  if (teachKind(item) !== 'pack' || isEngineScanCard(item)) return undefined;
  const p = item.pack ?? {};
  const before = p.winBefore, after = p.winAfter, playedUci = typeof p.playedUci === 'string' ? p.playedUci : '';
  const line = answerLineOf(item);
  const answer = sanAt(item.fen, line[0]), played = playedUci && playedUci !== line[0] ? sanAt(item.fen, playedUci) : '';
  if (!finite(before) || !finite(after) || !answer || !played) return undefined;
  const at = tryAtStart(item, latest);
  if (at && (at.check?.tryUci ?? at.line[0]) === playedUci && at.numbers) return undefined;
  return `After ${answer} the engine gives you ${Math.round(before)}% to win; your game move ${played} left ${Math.round(after)}%.`;
}

/** After a card: "Why {answer} works" ("The line after {answer}" on a short engine scan, 9.10 m) over the whole answer
 *  line from the card's position and, on punish cards, the line he could have played in his game, facing his side. Open
 *  after a miss, a hint or a reveal; one press away after an unaided solve (8.15). Display only: stepping through them
 *  records nothing. 9.11.2 (r): the answer viewer gets its figure (`answerViewerVerdict`) and, on his own game's card,
 *  the stored numbers as its first caption (`storedNumbersIntro`; `latest` is the try view on the page); the game line
 *  gets the sibling card's stored figure for his side (`gameLineVerdict`, 9.11.3); neither closes on "No material
 *  changes hands.".
 *  Version 7.1 (brief m31 4.3 row V, 4.4): right after the answer viewer, on a card with a stored threat, the threat
 *  viewer (`threatViewerOf`: from the pass position, no figure); and last, on a mistake card, the viewer of his game move
 *  and the stored reply (`gameMoveViewer`, hidden when the try slot shows that move's line). Both start one press away
 *  whatever `assisted` is, so neither is narrated before he asks. */
export function SolvedViewers({ item, sibling, assisted, onOpen, latest }: { item: TrainerItem; sibling?: TrainerItem; assisted: boolean; onOpen?: () => void; latest?: TryView | null }) {
  const siblingNotHeld = useContext(NotHeldSiblings).has(item.id);
  const threat = useMemo(() => threatViewerOf(item), [item]);
  const allowed = useMemo(() => gameMoveViewer(item, latest, siblingNotHeld), [item, latest, siblingNotHeld]);
  const line = answerLineOf(item);
  const answerSan = sanAt(item.fen, line[0]);
  const game = isPunish(item) ? gameLineOf(item, sibling) : null;
  if (!answerSan && !game) return null;
  const scan = isEngineScanCard(item);
  return <div className="teach-viewers">
    {answerSan && <LineViewer key={`answer-${item.id}-${assisted}`} title={scan ? `The line after ${answerSan}` : `Why ${answerSan} works`} startFen={item.fen} line={line} orientation={sideOf(item.fen)}
      intro={storedNumbersIntro(item, latest)} verdict={answerViewerVerdict(item, latest)} noChangeSentence={false}
      defaultOpen={assisted} toggleLabel={scan ? 'Show the line' : 'Show why it works'} onOpen={onOpen}/>}
    {threat && <div className="teach-more"><LineViewer key={`threat-${item.id}`} title={threat.title} startFen={threat.fen} line={threat.line} orientation={sideOf(item.fen)}
      intro={threat.intro} noChangeSentence={false} defaultOpen={false} toggleLabel={threat.toggle} onOpen={onOpen}/></div>}
    {game && <LineViewer key={`game-${item.id}-${assisted}`} title="What you could have played in the game" startFen={game.fen} line={game.line} orientation={sideOf(game.fen)}
      verdict={gameLineVerdict(item, sibling)} noChangeSentence={false} defaultOpen={assisted} toggleLabel="Show what you could have played" onOpen={onOpen}/>}
    {allowed && <div className="teach-more"><LineViewer key={`allowed-${item.id}`} title={allowed.title} startFen={allowed.fen} line={allowed.line} orientation={sideOf(item.fen)}
      intro={allowed.intro} initialStep={1} verdict={allowed.verdict} noChangeSentence={false} defaultOpen={false} toggleLabel={allowed.toggle} onOpen={onOpen}/></div>}
  </div>;
}

/** 8.7: only a Lichess puzzle solved cleanly moves on by itself. Own-game cards, Claude's drills and endgame drills
 *  (whose idea now shows on completion) wait for the Next button. */
export const advancesAfterCleanSolve = (item: Pick<TrainerItem, 'source'> | null | undefined) => item?.source === 'bank';

/** 9.11.3 (R4-3), 8.7: a clean solve moves on by itself only where `advancesAfterCleanSolve` allows it, and not while
 *  Claude's answer to his note shows on the card (`answers`: the card's answered notes; `CardAnswer` shows them once the
 *  card is complete). */
export function movesOnAfterCleanSolve(item: Pick<TrainerItem, 'source'> | null | undefined, answers: ReadonlyArray<AnsweredNote>): boolean {
  return advancesAfterCleanSolve(item) && answeredNotes(answers).length === 0;
}

// ---------------------------------------------------------------- M3 stage (b): the coach, notes and answers

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
/** 8.3: what a note sent from the page points at. With a try on the card: the position the latest try was played from
 *  and that try (same fields as version 6); otherwise the card's own position. The page passes its latest try, set on
 *  every try (9.11.3 R1-2: a try still being checked and another mate included). */
export function feedbackPosition(card: Pick<TrainerItem, 'fen'>, wrong: WrongMove | null): { fen: string; playedUci?: string } {
  return wrong && UCI_MOVE.test(wrong.uci) ? { fen: wrong.fen, playedUci: wrong.uci } : { fen: card.fen };
}

/** L7: Claude's answers to his notes about one card. The page shows them once the card is complete: a reply may name
 *  the answer. */
export const answersFor = (items: ReadonlyArray<AnsweredNote>, id: string | undefined): AnsweredNote[] =>
  (id ? items.filter(f => f.doc.itemId === id) : []);

/**
 * 9.11.2 (s): "Answers to your notes" in the From Claude area. While the card on the board is unsolved (`solving`) the
 * panel shows only its heading, the count and "Shown when you finish this position." with a "Show them now" button: a
 * reply may name the answer of this card, of its punish sibling or of a held card's sibling, which no filter by card
 * catches. Pressing it is his request (8.2), as is finishing the card; then the panel shows in full (`AnswersPanel`).
 * The "N notes from Claude" chip leads here, so it follows the same rule. The root keeps `plan-notes`, so the practice
 * page's order rules place it as before.
 */
export function AnswersArea({ items, titleOf, solving, onShow }: {
  items: ReadonlyArray<AnsweredNote>; titleOf: (itemId: string) => string | null; solving: boolean; onShow: () => void;
}) {
  const count = answeredNotes(items).slice(0, MAX_ANSWERS_SHOWN).length;
  if (!count) return null;
  if (!solving) return <AnswersPanel items={items} titleOf={titleOf}/>;
  return <section className="surface plan-notes answers-panel answers-held" aria-label="Answers to your notes">
    <div className="notes">
      <h2>Answers to your notes</h2>
      <p className="small">{`${count} ${count === 1 ? 'answer' : 'answers'}. Shown when you finish this position.`}</p>
      <button type="button" className="secondary" onClick={onShow}>Show them now</button>
    </div>
  </section>;
}

/** The title an answered note shows in the From Claude area: the card's title from every card the pools hold, the
 *  punish cards the curation holds back included (his notes may be about them); a Lichess puzzle by its id.
 *  Version 7.1 (brief m31 4.5): also the punish cards the document holds (`notUnique`, `notHeld`), so a note on a card
 *  that left the board keeps its title. */
export function cardTitleOf(pools: Pick<Pools, 'byId' | 'smallEdge' | 'missedWin'> & Partial<Pick<Pools, 'notUnique' | 'notHeld'>>): (itemId: string) => string | null {
  const held = new Map([...pools.smallEdge, ...pools.missedWin, ...(pools.notUnique ?? []), ...(pools.notHeld ?? [])].map(p => [p.id, p] as const));
  return itemId => {
    const card = pools.byId.get(itemId) ?? held.get(itemId);
    if (!card) return null;
    return card.title || (card.source === 'bank' ? `Lichess puzzle ${card.id}` : null);
  };
}

/** The line under the question box on an endgame drill (moves are looked up in the tablebase, never the engine). */
export const DRILL_ASK_HINT = 'Claude answers from the lines on this page. Name a move, like Kd2, and the page looks up its tablebase result.';

// ---------------------------------------------------------------- M3 stage (c): grading a try (9.1), the attempt, the layout (8.6)

/** Own-game kinds (his games, punish cards, Claude's drills): the board waits for the engine before a try counts (9.1). */
export const waitsForEngine = (item: Pick<TrainerItem, 'source' | 'kind' | 'themes'>) => { const k = teachKind(item); return k === 'pack' || k === 'punish' || k === 'agent'; };

/** A drill's goal from the board at step `index`: a mate-in-N drill counts the mate from the position shown (N minus
 *  the moves he has played), so "That also mates, but not in N" is true of the board he sees. At every solver step of
 *  the four mate drills the answer mates in exactly that many moves (tablebase cache), and every other winning move
 *  mates more slowly (G's check). The lead may prefer the drill's total: then this returns `endgameGoal(item.themes)`. */
export function drillGoalAt(item: Pick<TrainerItem, 'themes'>, index: number): DrillGoal {
  const goal = endgameGoal(item.themes);
  if (!goal.mateIn) return goal;
  const left = goal.mateIn - Math.floor(Math.max(0, index) / 2);
  return left > 0 ? { ...goal, mateIn: left } : { result: goal.result };
}

/** What the page does with a try that is not the card's move: G's grade (`action` soft or error since 9.11.2 p, and the
 *  message), the try's line for the viewer (null: none) and where the line came from; 9.11.2 (r) 3: the figure for the
 *  try's line and the rounded pair its intro shows, when the page shows numbers for it. */
export interface GradedTry { grade: Grade; text: TryText | null; source: NonNullable<TryView['source']>; check?: TryCheck; verdict?: LineVerdict; numbers?: { tryWin: number; bestWin: number } }

/** Text without a leading `message` (the message line by the board already says it). */
function withoutMessage(text: TryText, message: string): TryText {
  const { intro, ...rest } = text;
  const left = intro?.startsWith(message) ? intro.slice(message.length).trim() : intro;
  return left ? { ...rest, intro: left } : rest;
}

/**
 * 9.1, one decision for every kind (the page calls it for the try at once and again when the engine has answered):
 * - endgame drills: the tablebase result against the drill's goal (`teachTry`), never the engine;
 * - Lichess puzzles, his games, punish cards, Claude's drills: the engine's check of this very try (null: no engine,
 *   a failure, the 6 s deadline or a stop), else the stored line where L4 allows one.
 * Every text keeps to the try's own result (8.2); since 9.11.2 (p) no grade completes the card. A grade without numbers
 * (a search too shallow to trust, or 9.11.2 (p)'s near try, whose depth-12 pair is never shown) gets a viewer titled
 * "What could follow {try}" with no intro and no figure. A position from a short engine scan gets the agent words for a
 * near try (`engineScan`): no analysis picked it.
 */
export function gradeCardTry(item: TrainerItem, fenBefore: string, tryUci: string, index: number, check: TryCheck | null): GradedTry {
  const trySan = sanAt(fenBefore, tryUci), answerSan = sanAt(fenBefore, item.moves[index]), solver = sideOf(fenBefore);
  const kind = teachKind(item);
  if (kind === 'endgame') {
    const t = trySan ? teachTry(item.id, fenBefore, tryUci) : { result: null };
    const grade = gradeTry({ kind: 'endgame', trySan, answerSan, solver, tryUci, teach: { ...t, goal: drillGoalAt(item, index) } });
    const text = drillTryText(item, fenBefore, tryUci, index);
    // 9.10 (g): the verdict shows once, in the message line by the board. The viewer's intro (or, with no line to step
    // through, the words the slot prints) keeps only what the message does not say: the listed note.
    return { grade, text: text ? withoutMessage(text, grade.message) : null, source: 'tablebase' };
  }
  const usable = check && check.tryUci === tryUci ? check : null;
  const grade = gradeTry({ kind, trySan, answerSan, solver, tryUci, check: usable, ...(isEngineScanCard(item) ? { engineScan: true } : {}) });
  if (!usable) {
    // L4's stored line (his game move at a mistake card's first step), with the stored figures (9.11.2 r 3).
    const text = storedTryText(item, fenBefore, tryUci, index);
    const after = item.pack?.winAfter, before = item.pack?.winBefore;
    return {
      grade, text, source: 'stored',
      ...(text && finite(after) ? { verdict: { side: solver, win: after } } : {}),
      ...(text?.intro && finite(after) && finite(before) ? { numbers: { tryWin: Math.round(after), bestWin: Math.round(before) } } : {}),
    };
  }
  const line = [usable.tryUci, ...usable.replyLine];
  if (!grade.showNumbers) return { grade, text: { line, title: `What could follow ${trySan || usable.trySan}` }, source: 'engine', check: usable };
  const text: TryText = { line, ...engineTryText(usable, solver) };
  return {
    grade, text, source: 'engine', check: usable, verdict: { side: solver, win: usable.tryWin },
    ...(finite(grade.tryWin) && finite(grade.bestWin) ? { numbers: { tryWin: grade.tryWin, bestWin: grade.bestWin } } : {}),
  };
}

/** The try view for a graded try: open after a counted miss, one press away after a soft retry. On a phone a Lichess
 *  puzzle's miss is shown one press away too (`tryCollapsedOnPhone`). `answers`: `answerMovesFrom` at the try's step. */
export function tryViewOf(key: string, fenBefore: string, tryUci: string, answers: AnswerMove[], g: GradedTry): TryView | null {
  if (!g.text) return null;
  return {
    key, status: 'done', trySan: sanAt(fenBefore, tryUci), fenBefore, answers, ...g.text, source: g.source,
    ...(g.check ? { check: g.check } : {}), ...(g.verdict ? { verdict: g.verdict } : {}), ...(g.numbers ? { numbers: g.numbers } : {}),
    ...(g.grade.action === 'error' ? {} : { collapsed: true }),
  };
}

/** 9.11.2 (q): the try to book as a miss when he leaves while it is being checked: the UCI of a try the board waits for
 *  (an own-game card's blocking check), or null (no try, a finished grade, a Lichess puzzle's background check). */
export function pendingMissOf(view: TryView | null | undefined): string | null {
  if (!view || view.status !== 'checking' || !view.blocking) return null;
  const uci = view.key.slice(view.key.lastIndexOf('|') + 1);
  return UCI_MOVE.test(uci) ? uci : null;
}

/** 9.10 (h), the lead's 02:00 ruling and 9.11.3 (extended): on a phone, does the try's line start one press away, right
 *  under the message line (`PracticeColumns`)? Yes for every finished try: a soft retry, and every counted miss (a
 *  Lichess puzzle's, a drill's and his own game's); at wider widths a counted miss stays open where it is. A check still
 *  running never moves. `item` is kept for the callers; since 9.11.3 the kind no longer decides. */
export function tryCollapsedOnPhone(item: Pick<TrainerItem, 'source' | 'kind' | 'themes'>, view: TryView | null): boolean {
  return view?.status === 'done';
}

/** 9.1: the engine's check of a try through `gate` (6 s from the try; a newer try, a step change or a new card stops
 *  it, and then nothing arrives), graded by `gradeCardTry`. Without an engine the null grade arrives at once. */
export function gradeAfterCheck(gate: TryGate, engine: AnalysisEngine | null, item: TrainerItem, fenBefore: string, tryUci: string, index: number,
  apply: (g: GradedTry) => void, deadlineMs = TRY_DEADLINE_MS): Promise<void> {
  if (!engine) { gate.stop(); apply(gradeCardTry(item, fenBefore, tryUci, index, null)); return Promise.resolve(); }
  return backgroundCheck(gate, engine, fenBefore, tryUci, item.moves[index] ?? null, check => apply(gradeCardTry(item, fenBefore, tryUci, index, check)), deadlineMs);
}

/** 9.1: when the first own-game card is shown, one depth-1 search starts the engine's worker, so the first try's check
 *  does not spend its 6 s starting it. Never at page load; outside the try gate; a failure is ignored. */
export function warmEngine(fen: string): void {
  const engine = getSharedEngine();
  if (engine) void searchOnce(engine, fen, { depth: 1 }).catch(() => undefined);
}

/** Which practice layout the stylesheet shows: one column up to 650 px ('phone'), two columns with the narrowest coach
 *  panel from 651 to 1000 px ('mid'), two wider columns above ('wide'). The same breakpoints as styles/app.css. */
export type PracticeLayout = 'phone' | 'mid' | 'wide';
export const LAYOUT_QUERIES = { phone: '(max-width: 650px)', mid: '(min-width: 651px) and (max-width: 1000px)' } as const;
/** The layout now; 'wide' where there is no window or `matchMedia` (tests, server rendering). */
export function layoutNow(): PracticeLayout {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'wide';
  try {
    if (window.matchMedia(LAYOUT_QUERIES.phone).matches) return 'phone';
    if (window.matchMedia(LAYOUT_QUERIES.mid).matches) return 'mid';
  } catch { /* an unusable matchMedia keeps the wide layout */ }
  return 'wide';
}
/** The layout, read at once (no first render in the wrong place) and again when the window crosses a breakpoint. */
function usePracticeLayout(): PracticeLayout {
  const [layout, setLayout] = useState<PracticeLayout>(layoutNow);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const update = () => setLayout(layoutNow());
    let lists: MediaQueryList[] = [];
    try { lists = [window.matchMedia(LAYOUT_QUERIES.phone), window.matchMedia(LAYOUT_QUERIES.mid)]; } catch { return; }
    for (const l of lists) { if (typeof l.addEventListener === 'function') l.addEventListener('change', update); else l.addListener(update); }
    update();
    return () => { for (const l of lists) { if (typeof l.removeEventListener === 'function') l.removeEventListener('change', update); else l.removeListener(update); } };
  }, []);
  return layout;
}

/** The parts of the practice panel; `PracticeColumns` renders each exactly once, where the layout wants it. */
export interface PracticeParts {
  /** Turn line, board and caption. */ board: ReactNode;
  /** The message about his last move ("Checking …", the grade, "Good. Your opponent replies …"). */ feedback: ReactNode;
  /** Hint and reveal buttons while he solves. */ controls: ReactNode;
  /** The hints shown at this step. */ ladder: ReactNode;
  /** "Next position in a moment." */ advance: ReactNode;
  /** Coach heading, lead and "How to look". */ head: ReactNode;
  /** The Ask Claude panel: never moves, so a layout change never cancels its request. */ coach: ReactNode;
  /** The complete panel up to Next and Rehearse. */ solved: ReactNode;
  /** "Why … works" and the game line, once complete. */ viewers: ReactNode;
  /** The try's line. */ trySlot: ReactNode;
  /** Notes for Claude and the footnote. */ foot: ReactNode;
}

/**
 * Where each part goes (8.6, A5). Wide: the board alone on the left, everything else in the coach panel. Mid
 * (651-1000 px), where the coach panel is narrowest: the line viewers move under the board, so their boards are not
 * squeezed. In both, the hint and reveal buttons follow the message about his last move and come before the hints shown
 * (9.10 i), so "Reveal solution" stays on the first screen however many hints are open. Phone (one column): the hint and
 * reveal buttons, then the message, then the hints shown go directly under the board, so they are on the first screen
 * with it and "Checking …" sits next to the board that waits. `tryCollapsed` (`tryCollapsedOnPhone`: every finished
 * try, a soft retry or a counted miss of any kind): on a phone that slot sits right under the message and its line
 * starts one press away (9.10 h, the lead's 02:00 ruling and 9.11.3, through `TryByBoard`); a background "Checking …"
 * stays in the coach panel, so the hints shown stay by the board. Every part is rendered once, in one place per layout.
 * Only these leaf parts move; the Ask Claude panel, the notes for Claude and Next never do.
 */
export function PracticeColumns({ layout, parts: p, tryCollapsed = false }: { layout: PracticeLayout; parts: PracticeParts; tryCollapsed?: boolean }) {
  const phone = layout === 'phone', mid = layout === 'mid';
  const tryByBoard = phone && tryCollapsed;
  return <TryByBoard.Provider value={tryByBoard}><div className="practice-layout">
    <div className="board-column">
      {p.board}
      {phone && <div className="board-help">{p.controls}{p.feedback}{tryByBoard && p.trySlot}{p.ladder}</div>}
      {p.advance}
      {mid && <div className="board-viewers">{p.viewers}{p.trySlot}</div>}
    </div>
    <aside className="coach-panel">
      {p.head}
      {!phone && p.feedback}
      {!phone && p.controls}
      {!phone && p.ladder}
      {p.coach}
      {p.solved}
      {!mid && p.viewers}
      {!mid && !tryByBoard && p.trySlot}
      {p.foot}
    </aside>
  </div></TryByBoard.Provider>;
}

/** 8.6 (phone layout): on phones the generic three-step checklist waits behind a "How to look" toggle, so the controls
 *  stay on the first screen. At other widths it stays open, exactly as in version 6. */
export function HowToLook({ collapsed = true }: { collapsed?: boolean }) {
  const steps = <div className="thinking-steps"><p><span>1</span>Look for checks, captures, and threats.</p><p><span>2</span>Test your candidate against their best reply.</p><p><span>3</span>Check what you leave unprotected.</p></div>;
  return collapsed ? <details className="how-to-look"><summary>How to look</summary>{steps}</details> : steps;
}

/** The attempt the page records when a card ends (8.8: once per card). L10: the version-6 fields only; another mate is a
 *  correct answer like any other (9.1; since 9.11.2 p no engine check makes a try correct), and `playedUci` stays his
 *  first move counted as an error (9.11.2 q: or the try being checked when he left). */
export function attemptFor(o: { item: Pick<TrainerItem, 'id' | 'themes' | 'source'>; revealed: boolean; clean: boolean; hints: number; startedAt: number; now: number; playedUci?: string; coached?: boolean }): SessionAttempt {
  const correct = !o.revealed && o.clean;
  return {
    puzzleId: o.item.id, themes: [...new Set(o.item.themes)].slice(0, 30), correct, unassisted: correct && o.hints === 0 && !o.revealed,
    hints: o.hints, revealed: o.revealed, durationMs: Math.max(0, o.now - o.startedAt), at: o.now, source: o.item.source,
    ...(o.playedUci ? { playedUci: o.playedUci } : {}), ...(o.coached ? { coached: true } : {}),
  };
}

export default function Trainer({ store, deviceId, sessions, coach, saveFile }: TrainerProps) {
  const { view, model } = useArtifactState(store, sessions, deviceId);
  const [tab, setTab] = useState('practice'), [theme, setTheme] = useState('all');
  /** `today`: the capped daily set; `free`: practice beyond it or with a chosen focus. */
  const [mode, setMode] = useState<'today' | 'free'>('today');
  const [dailyDone, setDailyDone] = useState(false);
  const [active, setActive] = useState<TrainerItem | null>(null), [fen, setFen] = useState(''), [index, setIndex] = useState(0), [lastMove, setLastMove] = useState('');
  const [feedback, setFeedback] = useState(''), [complete, setComplete] = useState(false), [hints, setHints] = useState(0), [errors, setErrors] = useState(0), [revealed, setRevealed] = useState(false);
  const [wrong, setWrong] = useState<WrongMove | null>(null);
  /** 9.11.3 (R1-2), 8.3: his latest try on the card (a move that is not the card's move: a soft retry, a counted miss, a
   *  try still being checked, another mate) with the position it was played from: what a note from the page points at.
   *  Set on every try, cleared with each new card or "Safe or not?" question. `wrong` stays the coach's input. */
  const latestTry = useRef<WrongMove | null>(null);
  /** 9.11.3 (R2-2): the tries graded with no result on this card visit (the 6 s deadline, an engine failure, no engine),
   *  by `tryKey`: the same move at the same step keeps that grade until a new card is shown, so one move never reads two
   *  verdicts. Cleared by `startPuzzle`. */
  const noResult = useRef(new Map<string, GradedTry>());
  /** 9.11.2 (s): he pressed "Show them now" for the card on the board (reset with every new card). */
  const [notesAsked, setNotesAsked] = useState(false);
  /** M3 hint ladder: levels shown at the current step (`hints` stays the card's total, the number recorded). */
  const [hintStep, setHintStep] = useState({ index: 0, shown: 0, at: 0 });
  const [, setHintClock] = useState(0);
  /** M3: the latest wrong try's line, filled by a background engine check (or the drill's tablebase data). */
  const [tryView, setTryView] = useState<TryView | null>(null);
  const [tryGate] = useState(createTryGate);
  /** Stage (c), 9.1: the board waits for the engine's check of the last try (own-game kinds). A reveal, a step change,
   *  a new card and the check's own end (result, failure or the 6 s deadline) all clear the view, so it cannot stick. */
  const locked = !!active && tryView?.status === 'checking' && !!tryView.blocking;
  /** 9.1: the engine is warmed at the first own-game card shown, and again at the next one after a running check was
   *  stopped (9.11.3 R2-1: a search stopped while it runs ends the engine's worker; `stopCheck`). */
  const warmed = useRef(false);
  /** 8.6 and A5: which parts sit under the board (`PracticeColumns`). */
  const layout = usePracticeLayout();
  /** The latest render's `settleTry`: a check that ends after other state changed (a hint, a reveal) is judged by the
   *  state now on screen, never by the state of the render that made the try. */
  const settleLatest = useRef(settleTry);
  settleLatest.current = settleTry;
  const [advancing, setAdvancing] = useState(false);
  const [recordCount, setRecordCount] = useState(0);
  const recorded = useRef(false), started = useRef(0), rehearsing = useRef(false), coached = useRef(false), firstWrong = useRef<string | undefined>(undefined);
  const recent = useRef<string[]>([]);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSources, setShowSources] = useState(false);
  /** M2 (D13): the PGN import is mounted only once he opens it (its engine starts only on an import). */
  const [pgnOpen, setPgnOpen] = useState(false);
  /** M2 "Safe or not?": the question shown (no answer key), then his choice with the card looked up at answer time. */
  const [safeQ, setSafeQ] = useState<{ q: SafeQuestion; startedAt: number } | null>(null);
  const [safeAns, setSafeAns] = useState<{ choice: SafeChoice; card: SafeCardDoc; saved: boolean } | null>(null);
  /** D8: the opening chosen for extra practice and its position ids. */
  const extra = useRef<{ label: string; ids: string[] } | null>(null);

  // "Safe or not?" answers train a habit, not recall: they stay out of the ordinary schedule and skills (D5).
  const practiceAttempts = useMemo(() => view.attempts.filter(a => !isSafeAttempt(a)), [view.attempts]);
  // D7: "Put it back" markers reset a card's lapse days and make it due tomorrow; leeches leave the queue.
  const putBacks = useMemo(() => putBackTimes(view.putBacks), [view.putBacks]);
  const progress = useMemo(() => {
    const built = buildProgress(practiceAttempts, view.settings, trainingThemes);
    return putBacks.size ? { ...built, cards: withPutBacks(built.cards, putBacks) } : built;
  }, [practiceAttempts, view.settings, putBacks]);
  const leechInfo = useMemo(() => leechState(practiceAttempts, putBacks), [practiceAttempts, putBacks]);
  const leeched = useMemo(() => leechIds(leechInfo), [leechInfo]);
  const safeQuestions = useMemo(() => (view.safe?.cards ?? []).map(safeQuestion).filter((q): q is SafeQuestion => !!q), [view.safe]);
  const safeKinds = useMemo(() => new Map((view.safe?.cards ?? []).map(c => [c.id, c.kind] as const)), [view.safe]);
  const safeSched = useMemo(() => safeSchedule(view.attempts), [view.attempts]);
  const safeNow = useMemo(() => (safeKinds.size ? safeScore(view.attempts, id => safeKinds.get(id)) : null), [view.attempts, safeKinds]);
  // Version 7.1 (brief m31 4.2): `view.teach` joins the threat entries and holds the punish cards the document lists.
  const pools = useMemo(() => buildPools({ bank: puzzles, endgames: endgameDrills, pack: view.pack, personal: view.personal, drills: view.drills, teach: view.teach }), [view.pack, view.personal, view.drills, view.teach]);
  /** Brief m31 4.4: the mistake cards whose punish sibling is held as 'not-held' (`NotHeldSiblings`). */
  const notHeldSiblings = useMemo(() => notHeldSiblingIds(pools), [pools]);
  const summaryPack = useMemo(() => packForSummary(view.pack), [view.pack]);
  const punishStudy = useMemo(() => usablePunishStudy(view.pack?.punishStudy ?? []), [view.pack]);
  const nowMs = Date.now();
  const plan = activePlan(view.plan, nowMs);
  const caps = { reviewCap: view.settings.dailyReviewCap, newCap: view.settings.dailyNewCap };
  const counts = dailyCounts(view.attempts, nowMs);
  const capsNow = capState(counts, caps);
  const themeOptions = useMemo(() => [
    ...THEMES,
    ...(pools.own.some(isPunish) ? [[PUNISH, 'Punish it (your games)'] as [string, string]] : []),
    ...(safeQuestions.length ? [[SAFE, 'Safe or not? (your games)'] as [string, string]] : []),
    ...PACK_SETS.filter(([, set]) => pools.own.some(c => c.pack?.sets?.includes(set))).map(([id, , label]) => [id, label] as [string, string]),
  ], [pools, safeQuestions.length]);

  // 8.18: the level Lichess puzzles are aimed at, folded from his first tries at bank puzzles (nothing stored). Open
  // "wrong" flags are skipped, as in selection.
  const bankRating = useMemo(() => new Map(puzzles.map(p => [p.id, p.rating] as const)), []);
  const level = useMemo(() => bankLevel(view.attempts, id => bankRating.get(id), view.settings.rating, view.flaggedWrong), [bankRating, view.attempts, view.settings.rating, view.flaggedWrong]);

  const latest = useRef({ view, progress, pools, mode, theme, active, errors, hints, complete, safeQuestions, safeSched, safeNow, leeched, bankTarget: level.level });
  latest.current = { view, progress, pools, mode, theme, active, errors, hints, complete, safeQuestions, safeSched, safeNow, leeched, bankTarget: level.level };

  const cancelAdvance = useCallback(() => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    advanceTimer.current = null; setAdvancing(false);
  }, []);
  useEffect(() => cancelAdvance, [cancelAdvance]);
  // Leaving the page stops a running try check (its result would have nowhere to go).
  useEffect(() => () => tryGate.stop(), [tryGate]);
  /** Stops the try check that is running, if any. 9.11.3 (R2-1): a search stopped while it runs ends the engine's worker,
   *  so the next own-game card shown warms the engine again (one depth-1 search), and his next try's 6 s are not spent
   *  starting a worker. A check that was only queued ends nothing; warming again then costs one short search. */
  function stopCheck() {
    if (tryGate.pending()) warmed.current = false;
    tryGate.stop();
  }
  /** A new card or a "Safe or not?" question: no try line and no running check carry over. */
  function clearTry() { stopCheck(); setTryView(null); }
  /** 9.11.2 (q): leaving an own-game card while the board waits for its try's check books that try as a miss, as version
   *  6 did (correct false; the try is `playedUci` unless an error came first). Every leave path calls this before it
   *  stops the check (Another position, the focus select, Next, a new card of any kind); a rehearsal stays unrecorded. */
  function bookPendingMiss() {
    const uci = active && !recorded.current && tryView?.key.startsWith(tryKey(active.id, index, '')) ? pendingMissOf(tryView) : null;
    if (!uci) return;
    if (!firstWrong.current) firstWrong.current = uci;
    finish(false, false);
  }

  function finish(wasRevealed = false, wasClean = errors === 0) {
    if (!active || recorded.current) return;
    recorded.current = true; setComplete(true);
    // A rehearsal replays a line just seen; recording it would book a clean recall (audit A1 F1).
    if (rehearsing.current) return;
    model.record(attemptFor({
      item: active, revealed: wasRevealed, clean: wasClean, hints, startedAt: started.current, now: Date.now(),
      ...(firstWrong.current ? { playedUci: firstWrong.current } : {}), ...(coached.current ? { coached: true } : {}),
    }));
    setRecordCount(n => n + 1);
  }

  function startPuzzle(p: TrainerItem, rehearse = false) {
    cancelAdvance();
    bookPendingMiss();
    if (active && !recorded.current && (errors > 0 || hints > 0)) finish(false, false);
    if (!rehearse) recent.current = [...recent.current.filter(id => id !== p.id), p.id].slice(-5);
    rehearsing.current = rehearse;
    setSafeQ(null); setSafeAns(null);
    setActive(p); setFen(p.fen); setIndex(0);
    setLastMove(setupMove(p.id) ?? (isPunish(p) && typeof p.pack?.playedUci === 'string' ? p.pack.playedUci : ''));
    setFeedback(''); setComplete(false); setHints(0); setErrors(0); setRevealed(false); setWrong(null); setDailyDone(false); setNotesAsked(false);
    setHintStep({ index: 0, shown: 0, at: 0 }); clearTry();
    recorded.current = false; coached.current = false; firstWrong.current = undefined; started.current = Date.now();
    latestTry.current = null; noResult.current = new Map();
    // 9.1: the first own-game card shown starts the engine (one depth-1 search), so his first try is checked in time.
    if (!warmed.current && waitsForEngine(p)) { warmed.current = true; warmEngine(p.fen); }
  }

  function startSafe(q: SafeQuestion) {
    cancelAdvance();
    bookPendingMiss();
    clearTry();
    if (active && !recorded.current && (errors > 0 || hints > 0)) finish(false, false);
    recent.current = [...recent.current.filter(id => id !== q.id), q.id].slice(-5);
    setActive(null); setFeedback(''); setDailyDone(false); setSafeAns(null); setNotesAsked(false);
    latestTry.current = null;
    setSafeQ({ q, startedAt: Date.now() });
  }
  /** Record his verdict (D4). The answer key is looked up only now, from the loaded cards. */
  function answerSafe(choice: SafeChoice) {
    if (!safeQ || safeAns) return;
    const card = latest.current.view.safe?.cards.find(c => c.id === safeQ.q.id);
    if (!card) { setFeedback('This position is no longer available.'); setSafeQ(null); return; }
    // Fix pass P2-4: check the result, as `putBack` does; the panel says so when the answer was not saved.
    const saved = model.record(safeAttempt(safeQ.q, card.kind, choice, safeQ.startedAt, Date.now()));
    setSafeAns({ choice, card, saved });
    if (saved) setRecordCount(n => n + 1);
  }

  function choose(nextTheme = theme, nextMode = mode) {
    cancelAdvance();
    bookPendingMiss();
    clearTry();
    const { view: v, progress: prog, pools: pl, safeQuestions: sq, safeSched: sched, leeched: leechedNow, bankTarget } = latest.current;
    // 8.18: Lichess puzzles are measured against the bank level; every other card keeps the starting level.
    const targetOf = (p: TrainerItem) => (p.source === 'bank' ? bankTarget : undefined);
    // Leaving a position after help or an incorrect move is still practice evidence.
    if (active && !recorded.current && (errors > 0 || hints > 0)) finish(false, false);
    const now = Date.now();
    const planNow = activePlan(v.plan, now);
    const priors = focusPriors(v.pack?.meta.priors, planNow);
    // Open "wrong" flags and leeches (D7) are both kept out of selection.
    const flagged = leechedNow.size ? new Set([...v.flaggedWrong, ...leechedNow]) : v.flaggedWrong;
    const filter = POOL_FILTERS.includes(nextTheme) ? 'all' : nextTheme;
    if (nextTheme === SAFE) {
      const q = chooseSafe(safePool(sq, sched, null, now, flagged), sched, recent.current);
      if (q) { startSafe(q); return; }
      setActive(null); setSafeQ(null); setSafeAns(null);
      setFeedback('No “Safe or not?” positions are waiting. Answered ones return later.');
      return;
    }
    if (nextTheme === 'all') {
      const capsHere = nextMode === 'today' ? capState(dailyCounts(v.attempts, now), { reviewCap: v.settings.dailyReviewCap, newCap: v.settings.dailyNewCap }) : null;
      // D3: a fifth pool with its own share; the other sources keep their proportions within the rest.
      const safeHere = capsHere?.done ? [] : safePool(sq, sched, capsHere, now, flagged);
      const both = pickWithSafe({
        safePool: safeHere, schedule: sched, recent: recent.current, mixSafe: planNow?.mix.safe, r: Math.random(),
        pickRest: () => pickNext<TrainerItem>({
          pools: pl.bySource, progress: prog, plan: v.plan, priors: v.pack?.meta.priors, flagged, caps: capsHere, excludeIds: recent.current, now,
          rand: Math.random, select: (pool, p, o) => selectPuzzle(pool, p as unknown as SchedulerProgress, { ...o, targetOf }),
          withPriors: (p, pr) => withThemePriors(p, pr), fallback: (byS, p) => fallbackPool(byS, p.attempts.length),
        }),
      });
      if ('safe' in both) { startSafe(both.safe); return; }
      const pick = both.rest;
      if (pick.item) { startPuzzle(pick.item); return; }
      setActive(null); setSafeQ(null); setSafeAns(null);
      if (pick.reason === 'daily-done') { setDailyDone(true); return; }
      setFeedback('Nothing is available to practise right now.');
      return;
    }
    let pool = pl.all;
    if (nextTheme === EXTRA) pool = (extra.current?.ids ?? []).map(id => pl.byId.get(id)).filter((p): p is TrainerItem => !!p);
    if (nextTheme === 'personal') pool = pl.own;
    if (nextTheme === 'review') pool = pl.all.filter(p => (prog.cards[p.id]?.due ?? Infinity) <= now);
    if (nextTheme === PUNISH) pool = pl.own.filter(isPunish);
    const packSet = PACK_SETS.find(([id]) => id === nextTheme);
    if (packSet) pool = pl.own.filter(p => !isPunish(p) && p.pack?.sets?.includes(packSet[1]));
    pool = pool.filter(p => !flagged.has(p.id));
    const selected = selectPuzzle(pool, toSchedulerProgress(withThemePriors(prog, priors)), { theme: filter, now, excludeIds: recentExclusion(pool, filter, recent.current, active?.id), targetOf });
    if (selected) startPuzzle(selected);
    else {
      setActive(null); setSafeQ(null); setSafeAns(null);
      setFeedback(nextTheme === 'review' ? 'No reviews are due. Try mixed practice, or return after your next review is scheduled.'
        : nextTheme === 'personal' ? 'Positions from your games appear here once Claude adds them from your recent games.'
        : nextTheme === EXTRA ? 'No positions from this opening are available right now.'
        : 'No positions match this focus yet.');
    }
  }

  // Land on today's first position once the data is in, without resetting an attempt in progress.
  const landed = useRef(false);
  useEffect(() => {
    if (!view.ready || landed.current) return;
    landed.current = true;
    choose('all', 'today');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.ready]);

  // Recompute the agent read model after practice pauses (only after attempts made on this page).
  useEffect(() => {
    // Only from confirmed history on a live connection, so a slow start never overwrites the read model (review P2-3).
    if (!recordCount || !view.synced || view.connection !== 'live') return;
    const timer = setTimeout(() => {
      const { view: v, progress: prog, pools: pl, leeched: lc } = latest.current;
      try {
        const local = sessions.localSessions().find(x => x.id === sessions.sessionId);
        const body = computeSnapshot({
          attempts: v.attempts, progress: prog, themesOf: trainingThemes, priors: v.pack?.meta.priors, servableIds: pl.all.filter(p => !lc.has(p.id)).map(p => p.id),
          // Pack coverage counts every pack card, as in version 6, also punish cards the curation holds back (version
          // 7.1: and the ones the document `teach/meta` holds).
          packIds: [...pl.own, ...pl.smallEdge, ...pl.missedWin, ...pl.notUnique, ...pl.notHeld].filter(p => p.source === 'pack').map(p => p.id),
          session: local ? { id: local.id, attempts: local.doc.attempts, endedAt: local.doc.endedAt } : null, deviceId, now: Date.now(),
          safe: latest.current.safeNow, docErrors: v.docErrors, leeches: [...lc],
        });
        void store.set(paths.snapshot(), body).catch(() => undefined);
      } catch { /* a snapshot that fails validation is skipped; the attempts themselves are saved */ }
    }, SNAPSHOT_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordCount, view.synced, view.connection]);

  function scheduleAdvance() {
    cancelAdvance();
    setAdvancing(true);
    advanceTimer.current = setTimeout(() => { advanceTimer.current = null; setAdvancing(false); choose(); }, AUTO_ADVANCE_MS);
  }

  function play(uci: string) {
    if (!active || complete || locked) return;
    cancelAdvance();
    const board = new Chess(fen);
    try { move(board, uci); } catch { setFeedback('That move is not legal in this position.'); return; }
    const alternateMate = board.isCheckmate();
    if (uci !== active.moves[index] && !alternateMate) {
      // 9.1: any mate is accepted above; every other move that is not the card's move is graded.
      tryOther(active, fen, uci, index);
      return;
    }
    // 9.11.3 (R1-2): another mate is a try the page accepts; a note sent now points at it.
    if (uci !== active.moves[index]) latestTry.current = { fen, uci, index };
    let next = index + 1, reply = ''; setLastMove(uci);
    if (!alternateMate && next < active.moves.length) { reply = move(board, active.moves[next]).san; setLastMove(active.moves[next]); next++; }
    setFen(board.fen()); setIndex(next);
    dropPendingTry();
    if (alternateMate || next >= active.moves.length) {
      const clean = errors === 0 && hints === 0;
      setFeedback(rehearsing.current ? 'Rehearsal complete. Rehearsals are not recorded as new attempts.'
        : alternateMate && uci !== active.moves[index] ? 'Checkmate — another valid finish. The source line below shows a different mating move.'
        : !clean ? 'Line completed. This position will return for another look.'
        : 'Well found. You followed the line all the way through.');
      const wasRehearsal = rehearsing.current;
      finish();
      // 9.11.3 (R4-3): not while Claude's answer to his note shows on the card.
      if (clean && !wasRehearsal && tab === 'practice' && movesOnAfterCleanSolve(active, cardAnswers)) scheduleAdvance();
    } else setFeedback(`Good. Your opponent replies ${reply}. Find your next move.`);
  }

  /** The step changed (a correct move, the last move or a reveal): a check still running for the earlier try no longer
   *  applies, so it stops (9.1 identity rule: same card, step and try). A finished try line stays shown. */
  function dropPendingTry() {
    if (!tryGate.pending()) return;
    stopCheck();
    setTryView(v => (v?.status === 'checking' ? null : v));
  }

  /** A try counted as an error (9.1): one more error on the card; his first such move is kept for the attempt. */
  function countError(uci: string) {
    setErrors(n => n + 1);
    if (!firstWrong.current && UCI_MOVE.test(uci)) firstWrong.current = uci;
  }

  /**
   * 9.1: a move that is not the card's move. Endgame drills are graded at once from the tablebase data, never the
   * engine. A Lichess puzzle counts the error at once, as in version 6, and checks the try in the background for the
   * viewer, the coach input and the message. His games, punish cards and Claude's drills lock the board and say
   * "Checking …" until the engine's grade (or the 6 s deadline) decides: soft retry or error. The same try
   * again at the same step reuses the finished check, so one move never gets two grades; a try graded with no result
   * keeps that grade for the rest of the card visit (9.11.3 R2-2, `noResult`). Every try becomes the latest try a note
   * points at (9.11.3 R1-2), before any check.
   */
  function tryOther(item: TrainerItem, fenBefore: string, uci: string, at: number) {
    const key = tryKey(item.id, at, uci), kind = teachKind(item);
    latestTry.current = { fen: fenBefore, uci, index: at };
    const known = tryView?.status === 'done' && tryView.key === key && tryView.source === 'engine' ? tryView.check ?? null : null;
    const unchecked = noResult.current.get(key) ?? null;
    if (kind === 'endgame') { stopCheck(); settleTry(key, fenBefore, uci, at, gradeCardTry(item, fenBefore, uci, at, null)); return; }
    if (kind === 'bank') {
      countError(uci);
      setWrong({ fen: fenBefore, uci, index: at });
      setFeedback(gradeCardTry(item, fenBefore, uci, at, null).grade.message);
      if (known) { stopCheck(); settleTry(key, fenBefore, uci, at, gradeCardTry(item, fenBefore, uci, at, known)); return; }
      if (unchecked) { stopCheck(); settleTry(key, fenBefore, uci, at, unchecked); return; }
      startTryCheck(item, fenBefore, uci, at, false);
      return;
    }
    setWrong(null);
    if (known) { stopCheck(); settleTry(key, fenBefore, uci, at, gradeCardTry(item, fenBefore, uci, at, known)); return; }
    if (unchecked) { stopCheck(); settleTry(key, fenBefore, uci, at, unchecked); return; }
    setFeedback(`Checking ${sanAt(fenBefore, uci)}…`);
    startTryCheck(item, fenBefore, uci, at, true);
  }

  /**
   * The engine's check of a try (A4's `checkTry` on the shared engine, created here at the first try that needs it,
   * never at page load). `blocking`: the board waits for it (own-game kinds); otherwise it runs in the background
   * (Lichess puzzles) and the slot says "Checking …" until it ends. Its grade reaches `settleTry` only while this is
   * still the latest try on this card and step (`tryGate`). Nothing here records an attempt.
   */
  function startTryCheck(item: TrainerItem, fenBefore: string, uci: string, at: number, blocking: boolean) {
    const key = tryKey(item.id, at, uci);
    // A new check stops one still running (a second try on a Lichess puzzle): as in `stopCheck` (9.11.3 R2-1).
    if (tryGate.pending()) warmed.current = false;
    const engine = getSharedEngine();
    if (engine) setTryView({ key, status: 'checking', trySan: sanAt(fenBefore, uci), fenBefore, answers: answerMovesFrom(item, fenBefore, at), line: [], title: '', ...(blocking ? { blocking: true } : {}) });
    void gradeAfterCheck(tryGate, engine, item, fenBefore, uci, at, g => {
      // 9.11.3 (R2-1), the deadline path: a check with no result was stopped by its own 6 s deadline or failed, which
      // ends a running search's worker as a stop does, so the next own-game card warms the engine again.
      if (engine && g.source === 'stored') warmed.current = false;
      settleLatest.current(key, fenBefore, uci, at, g);
    });
  }

  /**
   * A try's grade is in (9.1). It applies only while the same card, step and try are on the board and the card is not
   * finished (the gate drops a stopped check; this also drops a result that arrives late), otherwise it is dropped
   * with any "Checking …" it left. On a Lichess puzzle the error is already counted: the grade fills the viewer and,
   * when the engine likes the try too, the message. Otherwise: a soft retry (nothing counted, the move is not played)
   * or an error. Since 9.11.2 (p) no grade plays the try or completes the card: there is no accept branch here, so even
   * a grade marked accept would be handled as a soft retry. Called through `settleLatest`, so a late result sees this
   * render's state, not the state of the try.
   */
  function settleTry(key: string, fenBefore: string, uci: string, at: number, g: GradedTry) {
    const item = active;
    if (!item || complete || recorded.current || tryKey(item.id, index, uci) !== key) {
      setTryView(v => (v?.key === key && v.status === 'checking' ? null : v));
      return;
    }
    // 9.11.3 (R2-2): a grade with no engine result (the deadline, a failure, no engine; a stopped check never gets here)
    // stays this try's grade for the rest of the card visit. Drills are graded from the tablebase data, never the engine.
    if (g.source === 'stored') noResult.current.set(key, g);
    setTryView(tryViewOf(key, fenBefore, uci, answerMovesFrom(item, fenBefore, at), g));
    if (teachKind(item) === 'bank') {
      if (g.grade.message !== gradeCardTry(item, fenBefore, uci, at, null).grade.message) setFeedback(g.grade.message);
      return;
    }
    setWrong({ fen: fenBefore, uci, index: at });
    if (g.grade.action === 'error') countError(uci);
    setFeedback(g.grade.message);
  }

  function showHint() {
    if (!active || complete || locked) return;
    cancelAdvance();
    const shown = hintStep.index === index ? hintStep.shown : 0;
    const button = hintButton(shown, shown === 3 ? hintStep.at : null, Date.now());
    if (!button || button.disabled) return;
    setHintStep({ index, shown: shown + 1, at: Date.now() });
    setHints(n => n + 1);
  }

  function reveal() {
    cancelAdvance();
    // Step the board through the rest of the line so the final position is visible (QA P2-10).
    if (active) {
      const shown = playLine(fen, active.moves.slice(index));
      setFen(shown.fen); setIndex(active.moves.length); setLastMove(shown.last ?? lastMove);
    }
    // 9.11.2 (q), version 6: a try still being checked stays his first wrong move in the record, as if counted at once.
    const pending = active && tryView?.key.startsWith(tryKey(active.id, index, '')) ? pendingMissOf(tryView) : null;
    if (pending && !firstWrong.current) firstWrong.current = pending;
    dropPendingTry();
    setRevealed(true);
    setFeedback(rehearsing.current ? 'Line shown. Rehearsals are not recorded.' : active?.themes.includes('personal') ? 'Engine candidate shown. This counts as supported practice and returns soon.' : 'Solution revealed. This counts as supported practice and returns soon.');
    finish(true);
  }

  function goTab(next: string) { cancelAdvance(); setTab(next); }
  function practiseTheme(t: string) { goTab('practice'); setMode('free'); setTheme(t); choose(t, 'free'); }
  function practiseOpening(row: OpeningRow, ids: string[]) {
    extra.current = { label: `${row.opening} as ${colorName(row.color)}`, ids };
    practiseTheme(EXTRA);
  }
  function sendFeedback(kind: Parameters<typeof model.sendFeedback>[0]['kind'], text?: string) {
    cancelAdvance();
    if (safeQ) return model.sendFeedback({ kind, item: { id: safeQ.q.id, source: 'pack', themes: safeQ.q.themes, fen: safeQ.q.fen }, text });
    if (!active) return Promise.resolve(false);
    // 8.3: the latest try and the position it was played from (the attempt still records the first wrong move). 9.11.3
    // (R1-2): the try set on every try, so a try still being checked, or another mate, is not lost.
    const at = feedbackPosition(active, latestTry.current);
    return model.sendFeedback({ kind, item: { id: active.id, source: active.source, themes: active.themes, fen: at.fen }, ...(at.playedUci ? { playedUci: at.playedUci } : {}), text });
  }
  function makeBackup() {
    const now = Date.now();
    const data = buildBackup({ attempts: view.attempts, progress, settings: view.settings, personal: view.personal, plan: view.plan, notes: view.notes, openFeedback: view.openFeedback, packVersion: view.pack?.version ?? null, exportedAt: now });
    return { filename: backupFilename(now), text: JSON.stringify(data) };
  }
  async function importBackup(text: string) {
    const chunks = view.pack ? [{ cards: view.pack.cards as Array<{ id: string; siteId?: unknown }>, study: view.pack.study as Array<{ id: string; siteId?: unknown }> }] : [];
    // Attempts already in this database are skipped, so re-importing an export adds no second copy (review P2-5).
    const plan = await planSiteImport(text, { parse: parseState, idMap: idMapFromPackChunks(chunks), skipKeys: new Set(view.attempts.map(a => `${a.puzzleId}:${a.at}`)) });
    await applySiteImport(store, plan, { deviceId });
    const c = plan.counts;
    const already = c.alreadyStored + c.duplicateAttempts;
    return `Imported ${c.attempts} attempt${c.attempts === 1 ? '' : 's'} and ${c.personalPuzzles} position${c.personalPuzzles === 1 ? '' : 's'} from your games${already ? `; ${already} attempt${already === 1 ? ' was' : 's were'} already here` : ''}.`;
  }

  // Use the pack detail only when the fields rendered below are present (a partial block must not break the page).
  const rawDetail = packDetailOf(active as PersonalPuzzle | null);
  const detail = rawDetail && Array.isArray(rawDetail.pvUci) && Array.isArray(rawDetail.occurrences) && typeof rawDetail.date === 'string' && typeof rawDetail.timeClass === 'string' ? rawDetail : undefined;
  const skills = getSkillStats(toSchedulerProgress(progress), pools.all) as { theme: string; attempts: number; successes: number; accuracy: number | null; label: string; total: number }[];
  const practiced = skills.filter(s => s.attempts > 0).sort((a, b) => (a.accuracy ?? 1) - (b.accuracy ?? 1));
  const attempts = practiceAttempts, clean = attempts.filter(a => a.unassisted).length;
  // Count due cards whose position is still available (a removed pack must not leave reviews that cannot be served).
  const due = pools.all.reduce((n, p) => n + Number(!leeched.has(p.id) && (progress.cards[p.id]?.due ?? Infinity) <= nowMs), 0);
  const studyEntries = pools.all.filter(p => leeched.has(p.id)).map(item => ({ item, lapseDays: leechInfo.get(item.id)?.lapseDays ?? 0, windowDays: leechInfo.get(item.id)?.windowDays ?? 0 }));
  function putBack(item: TrainerItem) { if (model.record(putBackAttempt(item.id, item.source, Date.now()))) setRecordCount(n => n + 1); }
  const unread = view.notes.filter(n => !n.read).length;
  const status = saveLabel(view.connection, view.saveState, sessions.persistent, view.unconfirmed);
  const turn = active ? new Chess(active.fen).turn() : 'w';
  const punish = isPunish(active);
  // M3 stage (a): the ladder for this step, built at the first hint asked for here; its marks and the button.
  const shownNow = active && !complete && hintStep.index === index ? hintStep.shown : 0;
  const ladder = useMemo(() => (active && shownNow > 0 ? hintLadderFor(active, fen, index) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, fen, index, shownNow > 0]);
  const marks = hintMarks(ladder, shownNow);
  const keySquaresNow = drillKeySquares(active, complete);
  const hintBtn = active && !complete ? hintButton(shownNow, shownNow === 3 ? hintStep.at : null, Date.now()) : null;
  // 8.16: re-render when the move hint becomes available.
  useEffect(() => {
    if (shownNow !== 3) return;
    const left = MOVE_HINT_DELAY_MS - (Date.now() - hintStep.at);
    if (left <= 0) return;
    const timer = setTimeout(() => setHintClock(n => n + 1), left + 25);
    return () => clearTimeout(timer);
  }, [shownNow, hintStep.at]);
  // Punish cards: the sibling mistake card (what he should have played); small edges with theirs, once per pool change.
  const sibling = useMemo(() => (active && isPunish(active) ? pools.byId.get(punishSiblingId(active) ?? '') : undefined), [active, pools]);
  // 9.10 (f): the punish lesson, made once the card is complete; it decides which text names his game move.
  const lesson = useMemo(() => (active && complete ? lessonFor(active, sibling) : null), [active, sibling, complete]);
  const solvedTexts = active ? solvedTextsOf(active, lesson) : { gameLine: false, explanation: false };
  const punishEdges = useMemo(() => pools.smallEdge.map(card => ({ card, sibling: pools.byId.get(punishSiblingId(card) ?? '') })), [pools]);
  // Version 7.1 (brief m31 4.5): the punish cards held as 'not-unique', for the reading list "More than one good reply".
  const punishAlso = useMemo(() => pools.notUnique.map(card => ({ card, sibling: pools.byId.get(punishSiblingId(card) ?? '') })), [pools]);
  // M3 stage (b). The explain input for the latest wrong try, with the engine's check of that very try when the page
  // has it (9.1 identity: same card, step and try). Built once per try, check and card: it narrates two lines.
  const coachInput = useMemo(() => {
    if (!active || !wrong) return null;
    const check = tryView?.status === 'done' && tryView.source === 'engine' && tryView.key === tryKey(active.id, wrong.index, wrong.uci) ? tryView.check ?? null : null;
    return explainInput(active, wrong, active.source, { check, sibling });
  }, [active, wrong, tryView, sibling]);
  // The question box (L6, after completion): moves he names are checked at the card position; a check of his latest
  // try from that position is reused; an input for a card no longer on screen is dropped.
  const askInput = useCallback((question: string, signal: AbortSignal) => {
    const card = active;
    if (!card) return null;
    const known = tryView?.status === 'done' && tryView.source === 'engine' && tryView.check ? { fen: tryView.fenBefore, check: tryView.check } : null;
    return buildAskInput(card, card.source, question, signal, { sibling, known, check: questionCheck, isCurrent: () => latest.current.active?.id === card.id });
  }, [active, sibling, tryView]);
  // L7: Claude's answers to his notes, on this card and in the From Claude area.
  const cardAnswers = useMemo(() => answersFor(view.answeredFeedback, active?.id), [view.answeredFeedback, active?.id]);
  const titleOf = useMemo(() => cardTitleOf(pools), [pools]);
  /** 8.15: viewers open after a miss, a hint or a reveal; after an unaided solve they wait one press away. */
  const assisted = errors > 0 || hints > 0 || revealed;
  // 9.11.2 (s): the card on the board (a position, or a "Safe or not?" question) is still to be solved.
  const boardUnsolved = !dailyDone && ((!!active && !complete) || (!!safeQ && !safeAns));
  const notesFocus = useRef(false);
  function showNotesNow() { notesFocus.current = true; setNotesAsked(true); }
  // After "Show them now" the answers take the button's place, so the focus moves to their heading.
  useEffect(() => {
    if (!notesAsked || !notesFocus.current) return;
    notesFocus.current = false;
    const heading = document.querySelector<HTMLElement>('.practice-page .answers-panel h2');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }, [notesAsked]);

  return <NotHeldSiblings.Provider value={notHeldSiblings}><div className="app-shell" data-board={view.board}>
    <aside className="sidebar">
      <a className="brand" href="#" aria-label="Next Move" onClick={e => { e.preventDefault(); goTab('practice'); }}><svg className="brand-piece" viewBox={PIECE_VIEWBOX} aria-hidden="true">{pieceArt('w', 'n')}</svg><span>Next Move<small>Your practice room</small></span></a>
      <nav aria-label="Main navigation">{[{ id: 'practice', label: 'Practice', Icon: Target }, { id: 'games', label: 'My games', Icon: Flag }, { id: 'learn', label: 'Learn', Icon: BookOpen }, { id: 'progress', label: 'Progress', Icon: ChartNoAxesCombined }].map(({ id, label, Icon }) =>
        <button key={id} className={tab === id ? 'nav active' : 'nav'} onClick={() => goTab(id)} aria-current={tab === id ? 'page' : undefined}><Icon size={20}/><span>{label}</span>{id === 'practice' && due > 0 && <b>{due}</b>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="profile-dot"><svg viewBox={PIECE_VIEWBOX} aria-hidden="true">{pieceArt('w', 'k')}</svg></div><p>A little, often.<small>Patterns grow with practice.</small></p></div>
    </aside>
    <main>
      <header className="topbar"><span>{tab === 'practice' ? 'Make the next move count.' : tab === 'games' ? 'Your games are your curriculum.' : tab === 'learn' ? 'Understand the idea. Then rehearse it.' : 'See what your practice is showing.'}</span><span className="save-status"><i/>{view.ready ? status : 'Loading…'}</span></header>
      <ConnectionBanner connection={view.connection} saveState={view.saveState} persistent={sessions.persistent}/>
      {view.error && <div className="notice error" role="alert"><span>{view.error}</span><button onClick={() => model.dismissError()} aria-label="Dismiss message"><X size={18}/></button></div>}
      {!view.ready ? <div className="empty-state">Loading your practice room…</div> : <>
        {tab === 'practice' && <section className="page practice-page">
          <TodayStrip counts={counts} caps={capsNow} cap={caps} plan={plan} unread={unread} pretty={pretty} status={status}
            onNotes={() => document.getElementById('from-claude')?.scrollIntoView({ block: 'start' })}/>
          <DocErrorLine count={view.docErrors.length}/>
          <div className="page-heading"><div><h1>{mode === 'today' && theme === 'all' ? 'Today’s set' : theme === EXTRA && extra.current ? `Extra practice: ${extra.current.label}` : 'Your next position'}</h1><p>Take your time. Find the idea, then calculate the reply.</p></div></div>
          {safeQ && !dailyDone ? (safeAns
            ? <SafeAnswerPanel key={`a-${safeQ.q.id}`} question={safeQ.q} card={safeAns.card} choice={safeAns.choice} saved={safeAns.saved} score={safeNow} layout={layout} onNext={() => choose()} nextLabel={mode === 'today' && theme === 'all' ? 'Next position' : 'Keep practising'}>
                <FeedbackBar itemId={safeQ.q.id} onSend={sendFeedback} onInteract={cancelAdvance}/></SafeAnswerPanel>
            : <SafeQuestionPanel key={`q-${safeQ.q.id}`} question={safeQ.q} onAnswer={answerSafe}>
                <FeedbackBar itemId={safeQ.q.id} onSend={sendFeedback} onInteract={cancelAdvance}/></SafeQuestionPanel>)
          : active && !dailyDone ? <PracticeColumns layout={layout} parts={{
            board: <>
              <div className="board-top"><span className={`turn-dot ${turn}`}/><strong>{punish ? `You play ${turn === 'w' ? 'White' : 'Black'}: punish it` : `${turn === 'w' ? 'White' : 'Black'} to move`}</strong>
                <span>{punish ? 'Your opponent’s side' : active.themes.includes('personal') || active.source === 'pack' ? 'From your game' : active.source === 'agent' ? (active.title ?? 'Set from Claude') : isEndgameDrill(active) ? `${drillGoal(active)} · Estimated difficulty ${active.rating}` : `Puzzle difficulty ${active.rating}`}</span></div>
              <Chessboard key={active.id} fen={fen} orientation={turn} onMove={play} onIllegal={() => { if (!complete) setFeedback('That move is not legal in this position.'); }} disabled={complete || locked}
                lastMove={lastMove} hintSquare={marks.hintSquare} hintSquares={keySquaresNow.length ? keySquaresNow : marks.hintSquares} arrow={marks.arrow}/>
              <div className="board-caption"><span>Tap a piece, then its destination.</span><span>{detail ? `From your ${detail.timeClass} game, ${detail.date}` : active.themes.includes('personal') ? (active.title ? `${active.title} · saved engine candidate` : 'Saved engine candidate') : isEndgameDrill(active) ? 'Tablebase-verified drill' : active.source === 'bank' ? `Lichess ${active.id}` : ''}</span></div>
            </>,
            advance: advancing && <div className="advance-note" role="status"><span>Next position in a moment.</span><button type="button" className="text-button" onClick={cancelAdvance}>Stay here</button></div>,
            head: <>
              <div className="coach-heading"><GraduationCap size={24}/><h2>{complete ? 'Take the idea with you' : punish ? 'What does that allow?' : 'Find the continuation'}</h2></div>
              {/* Punish-it framing: "what does that allow?" (evidence C1, B6). */}
              <p className="lead">{complete ? 'One position, one pattern. What made this work?' : punish ? punishLead(active) : isEndgameDrill(active) ? `${drillGoal(active)}. The replies are fixed; find the move that keeps that result.` : 'Before moving, ask what changed and what your opponent is threatening.'}</p>
              <HowToLook collapsed={layout === 'phone'}/>
            </>,
            feedback: <div className={`feedback ${complete ? 'success' : ''}`} aria-live="polite">{feedback || 'The answer stays hidden until you play or ask for help.'}</div>,
            ladder: ladder && <HintLadder hints={ladder} shown={shownNow}/>,
            // One panel in one place: the explain button for a wrong try, and once the card is complete the question box
            // (a second panel would remount on the reveal and cancel the request the click just started). It never moves.
            coach: <>{(coachInput || (complete && coach)) && <CoachPanel coach={coach} input={coachInput} revealsAnswer={!complete} onAsk={() => { cancelAdvance(); coached.current = true; if (!complete) reveal(); }}
                askInput={complete ? askInput : undefined} askKey={active.id} askHint={isEndgameDrill(active) ? DRILL_ASK_HINT : undefined}
                onAskQuestion={() => { cancelAdvance(); coached.current = true; }} onInteract={cancelAdvance}/>}</>,
            solved: complete ? <>
              <div className="theme-tags">{trainingThemes(active.themes).map(t => <span key={t}>{pretty(t)}</span>)}</div>
              <div className="solution"><strong>{active.themes.includes('personal') ? 'Engine candidate' : revealed ? 'Solution line' : 'Recorded continuation'}</strong><p>{solutionSan(active)}</p></div>
              {/* L8: the move he played and the move he should have played (the sibling card), not the opponent's reply.
                  9.10 (f): only when no lesson and no stored text names his move already (`solvedTextsOf`). */}
              {punish && !detail && solvedTexts.gameLine && <PunishGameLine item={active} sibling={sibling}/>}
              {detail && <div className="pack-lines">
                {punish && solvedTexts.gameLine && <PunishGameLine item={active} sibling={sibling}/>}
                {!punish && detail.pvUci.length > 1 && <p><strong>Engine line: </strong>{sanMoves(active.fen, detail.pvUci).join('  ')}</p>}
                {detail.refutationPvUci && !punish && <p><strong>Engine line after your {detail.playedSan}: </strong>{sanMoves(fenAfter(active.fen, detail.playedUci) ?? active.fen, detail.refutationPvUci).join('  ')}</p>}
                <p className="small">{`${detail.timeClass === 'rapid' ? 'Rapid' : 'Blitz'} · ${detail.date} · move ${detail.moveNumber}${detail.moveSeconds != null ? ` · ${Math.round(detail.moveSeconds)} s on this move` : ''}${detail.clockBefore != null ? ` · ${clock(detail.clockBefore)} on your clock` : ''}${detail.occurrences.length > 1 ? ` · you reached this position in ${detail.occurrences.length} games` : ''}`}</p>
                {active.gameUrl && <a href={active.gameUrl} target="_blank" rel="noreferrer">Open the game on Chess.com</a>}
              </div>}
              {active.explanation && solvedTexts.explanation && <p className="small">{active.explanation}</p>}
              <SolvedNotes item={active} sibling={sibling} lesson={lesson}/>
              <CardAnswer items={cardAnswers}/>
              <button className="primary wide" onClick={() => choose()}>{mode === 'today' && theme === 'all' ? 'Next position' : 'Keep practising'}<ArrowRight size={18}/></button>
              <button className="text-button" onClick={() => startPuzzle(active, true)}><RotateCcw size={16}/>Rehearse this line again</button>
            </> : null,
            viewers: complete ? <SolvedViewers item={active} sibling={sibling} assisted={assisted} onOpen={cancelAdvance} latest={tryView}/> : null,
            controls: complete ? null : <div className="coach-actions">
              {/* 9.11.3 (R6-2): during the 2 s guard the button stays focusable (aria-disabled; `showHint` ignores a press),
                  so the focus does not drop to the page; "Checking …" still disables it. */}
              {hintBtn && <button className="secondary" disabled={locked} aria-disabled={hintBtn.disabled || undefined} onClick={showHint}><Lightbulb size={17}/>{hintBtn.label}</button>}
              <button className="text-button" onClick={reveal}>{active.themes.includes('personal') ? 'Show engine candidate' : 'Reveal solution'}</button>
            </div>,
            trySlot: <TrySlot view={tryView} solving={!complete}/>,
            foot: <>
              <FeedbackBar itemId={active.id} onSend={sendFeedback} onInteract={cancelAdvance}/>
              <div className="coach-footnote">{detail ? 'From an offline engine pass over your games, not a live analysis of this position.' : active.themes.includes('personal') ? 'A short engine scan supplies a candidate, not proof that every alternative is worse.' : isEndgameDrill(active) ? 'Difficulty is an estimate, not a measured rating. The replies are fixed, tablebase-checked moves; they do not adapt to your play.' : active.source === 'agent' ? 'A practice line set by Claude and checked for legal moves on this page.' : 'Puzzle difficulty is from Lichess. It is not your Chess.com playing rating.'}</div>
            </>,
          }} tryCollapsed={tryCollapsedOnPhone(active, tryView)}/> : dailyDone ? <DailyDone counts={counts} onMore={() => { setMode('free'); setTheme('all'); choose('all', 'free'); }}/>
            : <div className="empty-state"><Target size={35}/><h2>{theme === 'personal' ? 'No positions from your games yet' : 'Nothing due right now'}</h2><p>{feedback}</p><button className="primary" onClick={() => { setTheme('all'); choose('all'); }}>Mixed practice</button></div>}
          <div className="practice-toolbar"><label htmlFor="theme">Practice focus</label>
            <select id="theme" value={mode === 'today' && theme === 'all' ? 'today' : theme} onChange={e => { const t = e.target.value; if (t === 'today') { setMode('today'); setTheme('all'); choose('all', 'today'); } else { setMode('free'); setTheme(t); choose(t, 'free'); } }}>
              <option value="today">Today’s set</option>
              {themeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              {theme === EXTRA && extra.current && <option value={EXTRA}>{`Extra practice: ${extra.current.label}`}</option>}
            </select>
            <BoardLook where="practice" value={view.board} unsaved={view.boardUnsaved} saving={view.boardSaving} onChange={b => model.saveBoard(b)}/>
            <button className="text-button" onClick={() => choose()}><RefreshCw size={16}/>Another position</button></div>
          <PlanAndNotes id="from-claude" plan={plan} notes={view.notes} pretty={pretty} onRead={id => void model.markNoteRead(id)}/>
          <AnswersArea items={view.answeredFeedback} titleOf={titleOf} solving={boardUnsolved && !notesAsked} onShow={showNotesNow}/>
          <div className="practice-footer"><div><strong>{(puzzles.length + endgameDrills.length).toLocaleString()} positions</strong><span>Tactics, defence, and endgames</span></div><div><strong>{due} due for review</strong><span>Missed or supported answers return sooner</span></div><div><strong>{pools.own.length} personal positions</strong><span>From games you have completed</span></div></div>
          {studyEntries.length > 0 && <p className="small study-pointer">{`${studyEntries.length} position${studyEntries.length === 1 ? ' is' : 's are'} set aside to study. `}<button type="button" className="link-button" onClick={() => goTab('progress')}>Study these</button></p>}
          {capsNow.done && mode === 'free' && <div className="notice success"><Check size={20}/><span>Today’s set is done. Extra practice still counts.</span><button onClick={() => goTab('progress')}>View progress</button></div>}
        </section>}
        {tab === 'games' && <section className="page"><div className="page-heading"><div><h1>Learn from your games</h1><p>Positions where your games turned, ready to practise.</p></div></div>
          {summaryPack ? <PersonalPackSummary pack={summaryPack} onPractise={() => practiseTheme('personal')}/> : <div className="surface"><h2>Your game positions</h2>
            <p>{pools.own.length ? `${pools.own.length} positions from your games are in your practice.` : 'Positions from your games arrive when Claude analyses your recent games.'}</p>
            {pools.own.length > 0 && <button className="primary" onClick={() => practiseTheme('personal')}>Practise them</button>}</div>}
          <OpeningAccidents doc={view.openings} isAvailable={id => pools.byId.has(id) && !leeched.has(id)} onPractise={practiseOpening}/>
          <PunishStudy items={punishStudy} edges={punishEdges} notUnique={punishAlso}/>
          <div className="surface"><h2>New games</h2><p className="small">Claude adds your newest games from your Chess.com archive in a coaching session. You can also add games here from a PGN file or a paste.</p>
            {!pgnOpen && <button type="button" className="secondary" onClick={() => setPgnOpen(true)}>Import games from a PGN</button>}
            {view.settings.chesscomUser && <a href={`https://www.chess.com/games/archive/${encodeURIComponent(view.settings.chesscomUser)}`} target="_blank" rel="noreferrer">Open your game archive on Chess.com</a>}
            <ChesscomUserForm current={view.settings.chesscomUser ?? ''} onSave={name => model.saveSettings({ chesscomUser: name })}/></div>

        </section>}
        {/* Kept mounted (hidden on other tabs) once opened: leaving My games must not stop a running check (it would save nothing). */}
        {pgnOpen && <div className="page pgn-mount" hidden={tab !== 'games'}><PgnImport store={store} myNames={view.settings.myNames ?? []} chesscomUser={view.settings.chesscomUser}
          saveMyNames={names => model.saveSettings({ myNames: names })} knownCards={[...pools.own, ...pools.smallEdge, ...pools.missedWin, ...pools.notUnique, ...pools.notHeld].map(p => ({ id: p.id, fen: p.fen }))}/></div>}
        {tab === 'learn' && <Learn onTheme={practiseTheme} showSources={showSources} onSourcesShown={() => setShowSources(false)}/>}
        {tab === 'progress' && <section className="page"><div className="page-heading"><div><h1>Your practice, in focus</h1><p>These numbers describe practice. They do not estimate your playing Elo.</p></div></div>
          <div className="stats-row"><div><strong>{attempts.length}</strong><span>Completed attempts</span></div><div><strong>{attempts.length ? `${Math.round(clean / attempts.length * 100)}%` : '—'}</strong><span>Solved without help or errors</span></div><div><strong>{due}</strong><span>Reviews due</span></div><div><strong>{pools.own.length}</strong><span>Positions from your games</span></div></div>
          {safeNow && safeNow.caught.n + safeNow.trusted.n > 0 && <div className="surface safe-progress"><h2>Safe or not?</h2><SafeScoreLine score={safeNow}/>
            <p className="fine-print">Two numbers on purpose: answering “It loses something” every time would catch every blunder and trust no sound move. Over your last 50 answers.</p></div>}
          <TransferCard doc={view.transfer}/>
          <StudyList entries={studyEntries} onPutBack={putBack}/>
          <div className="progress-layout"><div className="surface"><h2>Themes practised</h2>{!practiced.length ? <p>Complete a few positions to start seeing your practice history here. New themes remain in the mix.</p> : <div className="skill-list">{practiced.map(s => <div key={s.theme} className="skill-row"><div><strong>{pretty(s.theme)}</strong><small>{s.attempts} attempt{s.attempts === 1 ? '' : 's'} · {s.label}</small></div><div className="skill-meter" style={s.attempts < 5 ? { visibility: 'hidden' } : undefined}><div style={{ width: `${(s.accuracy ?? 0) * 100}%` }}/></div><span>{s.attempts < 5 ? '—' : `${Math.round((s.accuracy ?? 0) * 100)}%`}</span></div>)}</div>}<p className="fine-print">A miss, reveal, or hint counts as supported practice. Repeating a known position can improve recall without proving transfer to real games.</p></div>
            <aside className="surface"><h2>Shape your practice</h2>
              <label htmlFor="difficulty">Starting level</label>
              <select id="difficulty" value={view.settings.rating} onChange={e => void model.saveSettings({ rating: Number(e.target.value) })}>{[600, 800, 1000, 1200, 1400, 1600, 1800].map(n => <option key={n}>{n}</option>)}</select>
              <p className="fine-print">{`Bank puzzles now: about ${level.level}.`}</p>
              <p className="fine-print">Use Lichess puzzle difficulty as a starting point. It is not mapped to Chess.com Elo.</p>
              <label htmlFor="new-cap">New positions a day</label>
              <select id="new-cap" value={view.settings.dailyNewCap} onChange={e => void model.saveSettings({ dailyNewCap: Number(e.target.value) })}>{[0, 5, 10, 15, 20].map(n => <option key={n}>{n}</option>)}</select>
              <label htmlFor="review-cap">Reviews a day</label>
              <select id="review-cap" value={view.settings.dailyReviewCap} onChange={e => void model.saveSettings({ dailyReviewCap: Number(e.target.value) })}>{[10, 20, 30, 50].map(n => <option key={n}>{n}</option>)}</select>
              <BoardLook where="settings" value={view.board} unsaved={view.boardUnsaved} saving={view.boardSaving} onChange={b => model.saveBoard(b)}/>
              <details><summary>How the practice mix works</summary>
                <p className="small">Each day’s set holds up to {caps.reviewCap} reviews and {caps.newCap} new positions; both numbers are a judgement call, not a validated prescription. When Claude has set a focus, those themes come up more often and positions are drawn from your games, puzzles and endgames in the proportions Claude chose.</p>
                <p className="small">Clean recalls return after 1, 3, 7, 14, 30, then 60 days. Supported answers return after 10 minutes. These intervals and weights are product heuristics, not a validated prescription.</p>
              </details></aside></div>
          <BackupPanel saveFile={saveFile} makeBackup={makeBackup} importBackup={importBackup}/>
        </section>}
      </>}
      <footer className="site-footer"><span>Next Move · Completed-game study and deliberate practice.</span><button onClick={() => { goTab('learn'); setShowSources(true); }}>Sources & approach</button><span>Includes Stockfish, free software under the GNU General Public License v3.</span><a href="COPYING-GPL-3.0.txt" target="_blank" rel="noreferrer">GPL-3.0 licence</a><a href="https://github.com/nmrugg/stockfish.js" target="_blank" rel="noreferrer">Engine source</a></footer>
    </main>
  </div></NotHeldSiblings.Provider>;
}

/** What the board switch says when the database did not take a change (7.3: only what the page really keeps). */
export const BOARD_NOT_SAVED = 'Changed on this page only: it could not be saved just now.';
/** The retry beside that line: a select does not fire again for the option it already shows, so "choose it again" would
 *  have meant choosing another board first. */
export const BOARD_SAVE_AGAIN = 'Try saving again';
/** The retry's label while its write is out: the sign that a press did something, also when it is refused again. */
export const BOARD_SAVING = 'Saving…';
/**
 * Version 7.2: the board switch, under the board ("practice") and in "Shape your practice" ("settings"). The board
 * changes at once; the line under the control is shown only while the board on show is a choice the database refused.
 * Version 7.3: that line is the toolbar's own last row, not inside the switch (where it squeezed the control to a few
 * pixels), and it carries its own retry. Whether the choice is unsaved, and whether a write is out, come from the
 * model (`boardUnsaved`, `boardSaving`): both switches then say the same, the line survives a change of tab, and it
 * goes by itself when the database shows a later write.
 */
export function BoardLook({ value, unsaved = false, saving = false, onChange, where }: {
  value: BoardTheme; unsaved?: boolean; saving?: boolean; onChange: (board: BoardTheme) => Promise<boolean>; where: 'practice' | 'settings';
}) {
  const select = useRef<HTMLSelectElement>(null);
  const id = `board-look-${where}`;
  // The retry leaves with the line when the save goes through: focus then returns to the switch, unless he has moved
  // on to another control meanwhile (review of 7.3, P2-5).
  const again = async (button: HTMLElement) => {
    if (!(await onChange(value))) return;
    const at = document.activeElement;
    if (!at || at === document.body || at === button) select.current?.focus();
  };
  const control = <select ref={select} id={id} value={value} onChange={e => { void onChange(boardThemeFrom(e.target.value)); }}>{BOARD_THEMES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>;
  const status = unsaved ? <p className="small board-look-note" role="status">{BOARD_NOT_SAVED} <button type="button" className="text-button" aria-disabled={saving || undefined} onClick={e => { if (!saving) void again(e.currentTarget); }}>{saving ? BOARD_SAVING : BOARD_SAVE_AGAIN}</button></p> : null;
  if (where === 'settings') return <><label htmlFor={id}>Board colours</label>{control}<p className="fine-print">Green, blue or brown squares. The choice follows you to your other devices.</p>{status}</>;
  return <><div className="board-look"><label htmlFor={id}>Board</label>{control}</div>{status}</>;
}

/** `settings.chesscomUser`: read by Claude's game import (scripts/ingest.md) and used for the archive link (review P2-8). */
export const CHESSCOM_USER_RE = /^[A-Za-z0-9_-]{3,25}$/;
function ChesscomUserForm({ current, onSave }: { current: string; onSave: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState(current), [message, setMessage] = useState('');
  useEffect(() => setName(current), [current]);
  return <form className="chesscom-form" onSubmit={async e => {
    e.preventDefault();
    const value = name.trim();
    if (!CHESSCOM_USER_RE.test(value)) { setMessage('Use 3 to 25 letters, digits, hyphens or underscores.'); return; }
    setMessage((await onSave(value)) ? 'Saved. Claude uses this name to add your new games.' : 'That did not save. Try again in a moment.');
  }}>
    <label htmlFor="chesscom-user">Chess.com username</label>
    <div className="input-row"><input id="chesscom-user" autoComplete="off" value={name} onChange={e => setName(e.target.value)}/><button type="submit" className="secondary">Save</button></div>
    {message && <p className="small" role="status">{message}</p>}
  </form>;
}
