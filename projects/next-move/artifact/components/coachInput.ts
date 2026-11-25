/**
 * Inputs for the coach ("Why does my move fail?" and, from M3, the question box) and the static panel shown without
 * any model call (port plan section 4; M3 lead decision L6, brief sections 7, 8.4, 8.11 and 9.2).
 *
 * Nothing here evaluates a position. Every line, note, result and number comes from the card (its stored lines and
 * figures), the narrator (chess.js facts, `src/teach/narrate.ts`), the endgame drills' tablebase data
 * (`lib/endgameTeach.ts`), or an engine check (`checkTry`, A4): the one the page already ran for the try, or one run
 * through the checker the page injects for a question. Every Win% is a whole number.
 *
 * M3 stage (b) (brief 9.6). The explain input carries the 9.2 fields: the card (title, framing per kind, goal, where
 * the answer comes from), the WHOLE answer line from the try's step with narrator notes, the try's whole line (the
 * engine's check, the stored line of his game move, or the drill's tablebase line) with notes and its source, and
 * the page's class for the try (`tryVerdict`, from `gradeTry`, so the coach and the grading never disagree). On punish
 * cards it also carries his game move and the better move from the sibling card with its line.
 * Brief 9.11.2 (p): a try the page's quick check (depth 12) rated also-good or close on a pack, punish or agent card is
 * a soft retry with `tryVerdict` 'strong'. Its input carries no depth-12 pair as figures, only the plain note
 * `tryCheckNote` (`quickCheckNote` below). The page needs no extra wiring: `explainInput` grades the same check again.
 * The ask input (a free question once the card is complete) finds up to three moves the question names that are
 * legal at the card position and checks each: the tablebase data on endgame drills (never the engine), otherwise
 * the injected engine checker, with the abort signal honoured after every step.
 * Fix round 2, stage 2 (brief 9.11.3; no new Trainer wiring needed):
 * - R5-1: a drill's goal (and its grade) counts the mate from the step shown (`drillGoalFrom`, equal to the page's
 *   `drillGoalAt`); the ask input carries the card's `themes`.
 * - R5-5: a finished live check of his own game move leaves out the stored Win% pair, cp values and reply line; with a
 *   live figure for the answer (explain `bestWin`, ask `answerWin`) the punish lesson leaves out its engine figure.
 * - R5-6: an asked move whose search did not finish carries `finished: false` (and no Win%).
 * - The (p) note for questions: on pack and punish cards (not short-scan positions), a named move that the quick check
 *   puts within 5 points of the card's move carries `checkNote` instead of its Win%.
 * - A narrated summary with no change of material (settled or "so far") is no lesson for a puzzle or Claude's drill.
 * Fix round 3 (brief 9.12.2, items 7 and 8; no new Trainer wiring needed):
 * - V3-1 with V3-2: the coach lesson of a card from his games leaves out the stored-drop sentence
 *   (`lessonWithoutStoredDrop`); his game move keeps its stored pair.
 * - V3-5: a question that names the card's move gives its line the input's `answerWin`, so that move has one figure.
 * Version 7.1 (brief m31 4.7; no contract or prompt change): the punish lesson is built with the page's own threat
 * option (`lessonThreat`, the one definition the page's lesson and the reading lists use too), so the lesson the coach
 * reads is the lesson the page prints. The coach learns of a threat only through that lesson, on punish cards.
 */
import { Chess } from 'chess.js';
import type { AttemptSource } from '@/src/contract/docs';
import {
  COACH_LIMITS, type CoachAnswerSource, type CoachAskedLine, type CoachAskInput, type CoachExplainInput, type CoachLineSource, type CoachTryVerdict,
} from '@/src/contract/coach';
import { resultWords, tablebaseCard } from '@/src/coach/prompts';
import { boardText, narrateLine, type NarratedLine } from '@/src/teach/narrate';
import { betterMoveSan, punishAnswerLine, punishLesson } from '@/src/teach/punish';
import { classifyPunish, type PunishLessonOptions } from '@/src/teach/punish';
import { threatSay } from '@/src/teach/threat';
import type { TeachThreat } from '@/src/contract/teachDocs';
import { classifyWin, endgameGoal, gradeTry, TRUSTED_DEPTH, type DrillGoal } from '@/src/teach/grade';
import type { TryCheck } from '@/src/teach/tryMove';
import { drillTeach, teachTry } from '@/lib/endgameTeach';
import { isEndgameDrill } from '@/lib/endgames';
import { isPunish, positionKey } from './pools';

type Side = 'w' | 'b';
const move = (board: Chess, uci: string) => board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

/** SAN for a UCI line from `fen`, stopping at the first move that does not apply. */
export function sanLine(fen: string, line: readonly string[]): string[] {
  const out: string[] = [];
  let board: Chess;
  try { board = new Chess(fen); } catch { return out; }
  for (const uci of line) {
    try { out.push(move(board, uci).san); } catch { break; }
  }
  return out;
}

/**
 * The card fields the coach can use (a TrainerItem has all of them). `pack` is the pack detail block, when the card
 * came from his games; `kind` is `punish` for a punish card.
 */
export interface CoachCard {
  id: string;
  fen: string;
  moves: string[];
  themes: string[];
  pack?: object | null;
  refutationPvUci?: string[];
  kind?: string;
  title?: string;
  explanation?: string;
  rating?: number;
  /** Version 7.1: the card's entry in `teach/meta` (a TrainerItem carries it when the pools joined one). Read only by
   *  `lessonThreat`. Not a coach contract field: it never goes into an input. */
  teach?: TeachThreat | null;
}
/** A wrong move the learner played: the position it was played from, the move, and the step (ply index) of the card. */
export interface WrongMove { fen: string; uci: string; index: number }

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : '');
const uciList = (x: unknown): string[] => (Array.isArray(x) && x.every(m => typeof m === 'string') ? [...x] : []);
const sideName = (s: Side) => (s === 'w' ? 'White' : 'Black');
/** A trusted engine result (brief 9.1, `grade.ts`): depth 10 and more, or depth 0 (both positions already finished). */
const trustedDepth = (depth: number) => depth === 0 || depth >= TRUSTED_DEPTH;
const sameUci = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** Notes per line: the prompt keeps notes for the first 12 plies only. */
const NOTE_PLIES = COACH_LIMITS.notes;

/** SAN of `uci` at `fen`, or '' when it is not a legal move there. */
function sanAt(fen: string, uci: unknown): string {
  if (typeof uci !== 'string' || !uci) return '';
  try { return move(new Chess(fen), uci).san; } catch { return ''; }
}

/** The narrator's sentence for each ply of `line` from `fen` (the first 12 plies). */
function notesFor(fen: string, line: readonly string[]): string[] {
  return narrateLine(fen, line, { maxPlies: NOTE_PLIES }).plies.map(p => p.text);
}

export type CardKind = 'bank' | 'pack' | 'punish' | 'endgame' | 'agent';
/** The card kind the teaching modules use (brief §2): drill, punish, Lichess puzzle, Claude's drill, else own game. */
export function cardKind(card: { themes: string[]; kind?: string }, source: AttemptSource): CardKind {
  if (isEndgameDrill(card)) return 'endgame';
  if (isPunish(card)) return 'punish';
  if (source === 'bank') return 'bank';
  if (source === 'agent') return 'agent';
  return 'pack';
}

/**
 * The line that explains the card from step `index`, solver first (brief §2, 9.3): `pack.pvUci` (when it starts with
 * the card's move) while it agrees with the card's own moves up to and including that step, else the card's moves.
 */
export function answerLineFrom(card: { fen: string; moves: string[]; pack?: object | null }, index: number): string[] {
  const full = punishAnswerLine(card);
  const upTo = Math.min(index + 1, card.moves.length);
  const agrees = full.length > index && card.moves.slice(0, upTo).every((m, i) => full[i] === m);
  return agrees ? full.slice(index) : card.moves.slice(index);
}

/** His game move in SAN: `pack.playedSan`, else computed from where it was played (`pack.sourceFen` on punish cards). */
function gameMoveSan(card: CoachCard, kind: CardKind): string {
  const p = rec(card.pack);
  const given = str(p.playedSan);
  if (given) return given;
  const from = kind === 'punish' ? str(p.sourceFen) : card.fen;
  return from ? sanAt(from, p.playedUci) : '';
}

/**
 * R5-1 (brief 9.11.3): a drill's goal at step `index`, counted from the board shown, exactly as the page's
 * `drillGoalAt(item, index)` (components/Trainer.tsx, which imports this file, so the rule is repeated here and a test
 * pins the two equal): a mate-in-N drill keeps N minus the moves he has played.
 */
export function drillGoalFrom(themes: readonly string[], index: number): DrillGoal {
  const goal = endgameGoal(themes);
  if (!goal.mateIn) return goal;
  const left = goal.mateIn - Math.floor(Math.max(0, index) / 2);
  return left > 0 ? { ...goal, mateIn: left } : { result: goal.result };
}

/**
 * Section 8.11: the card's goal in words, only when it is known or computed; else undefined. Lichess puzzles and
 * Claude's drills take it from their narrated answer line (`full`), never from theme names.
 */
function objectiveOf(kind: CardKind, goal: DrillGoal | null, full: NarratedLine | null): string | undefined {
  if (kind === 'punish') return 'exploit the move just played';
  if (kind === 'pack') return "find the engine's move from your game";
  if (kind === 'endgame' && goal) {
    // The mate left from the board shown (R5-1). The prompt makes its "mate in N" citable as a mate marker (R5-2:
    // the goal's digit is no figure), so an answer may say "mate in 2" at step 2 of a mate in three.
    return goal.result === 'draw' ? 'hold the draw' : goal.mateIn ? `find the mate in ${goal.mateIn}` : 'win the endgame';
  }
  if (!full) return undefined;
  const last = full.plies[full.plies.length - 1];
  if (full.result === 'mate' && last && last.color === full.material.pov) return 'find the mate';
  if (full.material.settled && full.material.net > 0) return 'win material';
  return undefined;
}
/** The side to move at `fen`, read from the FEN text (White when it cannot be read). */
const turnOf = (fen: string): Side => (fen.trim().split(/\s+/)[1] === 'b' ? 'b' : 'w');

/** The card identity fields shared by the explain and ask inputs (9.2), and the punish game context. */
type CardFields = Pick<CoachExplainInput, 'framing' | 'lesson' | 'title' | 'objective' | 'answerSource' | 'gameFen' | 'gameMoveSan' | 'betterMoveSan' | 'betterLineSan'>;

const ANSWER_SOURCE: Partial<Record<CardKind, CoachAnswerSource>> = { bank: 'puzzle', pack: 'game-engine', punish: 'game-engine', endgame: 'tablebase', agent: 'drill' };

/**
 * Brief 9.12.2 item 7 (V3-1 with V3-2): the sentence an own-game card's explanation ends with, "By the engine's estimate,
 * your move lowered your winning chances by about N points out of 100." (written by lib/personal-pack.ts,
 * src/importers/packDocs.ts and src/analysis/docs.ts). It is left out of the coach lesson: its figure is not a figure
 * sentence the prompt can cite (R5-2), so an answer that repeats it is flagged, and beside a finished live check of his
 * move it is a second drop next to "still a good move" (R5-5). His game move keeps its stored pair (`winBefore`,
 * `winAfter`), and the page still prints the explanation whole after the card.
 */
const STORED_DROP_SENTENCE = /\s*By the engine's estimate, your move lowered your winning chances by about \d+(?:\.\d+)? points out of 100\./g;
/** The text without the stored-drop sentence (see `STORED_DROP_SENTENCE`), trimmed; any other text is kept as it is. */
export function lessonWithoutStoredDrop(text: string): string {
  return text.replace(STORED_DROP_SENTENCE, '').trim();
}

/**
 * Version 7.1 (brief m31 4.3 row L and 4.7): the threat sentences a punish lesson carries (`PunishLessonOptions.threat`).
 * One definition for the three places that build a punish lesson: the page after the card (`lessonFor` in Trainer.tsx),
 * the reading lists (`lessonOf` in PunishStudy.tsx) and the coach input (`cardFields` below). So all three read the
 * same lesson. Undefined (the lesson is then version 7's) unless the card is a punish card, is not a missed win (the
 * lead's rulings of 01:16 and 03:06: no threat sentence there) and carries a stored threat that passes the page's own
 * checks (`threatSay` in threat.ts: null for a card without an entry, a stale one, or one the page reads differently).
 */
export function lessonThreat(card: { fen: string; moves: readonly string[]; kind?: string; pack?: object | null; teach?: TeachThreat | null }): PunishLessonOptions['threat'] {
  if (!isPunish(card) || !card.teach || classifyPunish(card) === 'missed-win') return undefined;
  return threatSay(card)?.clause;
}

/** Options for `cardFields`. */
interface CardFieldOptions {
  /** The step (ply index) the input is about: a drill's goal counts the mate from there (R5-1). Default 0. */
  index?: number;
  /** R5-5: false leaves the engine's figure out of the punish lesson (the input carries a live one). Default true. */
  lessonFigure?: boolean;
}

function cardFields(card: CoachCard, source: AttemptSource, kind: CardKind, sibling: CoachCard | null | undefined, opts: CardFieldOptions = {}): CardFields {
  const out: CardFields = {};
  const p = rec(card.pack);
  const title = str(card.title);
  if (title) out.title = title;
  // Site-imported and page-made personal positions keep the prompt's own label ("a short engine scan's candidate
  // line"): "the engine's best line" would claim more than that scan shows.
  const answerSource = source === 'personal' ? undefined : ANSWER_SOURCE[kind];
  if (answerSource) out.answerSource = answerSource;
  const goal = kind === 'endgame' ? drillGoalFrom(card.themes, opts.index ?? 0) : null;
  // Lichess puzzles and Claude's drills: the whole answer line narrated once, for the goal and the lesson.
  const full = kind === 'bank' || kind === 'agent' ? narrateLine(card.fen, answerLineFrom(card, 0), { maxPlies: COACH_LIMITS.line }) : null;
  const objective = objectiveOf(kind, goal, full);
  if (objective) out.objective = objective;
  const solver = sideName(turnOf(card.fen));
  const answerSan = sanAt(card.fen, card.moves[0]);
  const played = kind === 'pack' || kind === 'punish' ? gameMoveSan(card, kind) : '';

  if (kind === 'bank') {
    const rating = num(card.rating);
    out.framing = `A Lichess puzzle${rating !== undefined ? ` rated ${Math.round(rating)}` : ''}. The learner plays ${solver}; the puzzle line is forced.`;
  } else if (kind === 'pack') {
    // Section 7 text; a part the card does not carry (time class, date, his move) is left out, never left blank.
    const timeClass = str(p.timeClass), date = str(p.date);
    const game = `A position from the learner's own ${timeClass ? `${timeClass} ` : ''}game${date ? ` (${date})` : ''}.`;
    const moves = played && answerSan ? `He played ${played} there; the engine's move was ${answerSan}.`
      : played ? `He played ${played} there.` : answerSan ? `The engine's move was ${answerSan}.` : '';
    out.framing = source === 'personal'
      ? `${game} The card asks for the move a short engine scan found there.`
      : [game, moves, "The card asks for the engine's move."].filter(Boolean).join(' ');
  } else if (kind === 'punish') {
    const better = betterMoveSan(card, sibling ?? null);
    out.framing = `A position from the learner's own game, right after his move${played ? ` ${played}` : ''}. He now plays his opponent's side (${solver}) to find how to exploit that move.`
      + (better && played ? ` Instead of ${played}, the better move in his game was ${better}.` : '');
    // The game context: the position before his move, his move, the sibling's better move and its whole line.
    const gameFen = str(p.sourceFen);
    if (gameFen && played) {
      out.gameFen = gameFen; out.gameMoveSan = played;
      if (better && sibling) {
        out.betterMoveSan = better;
        const line = sanLine(gameFen, punishAnswerLine(sibling));
        if (line[0] === better) out.betterLineSan = line;
      }
    }
  } else if (kind === 'endgame') {
    const goalWords = objective ?? 'win the endgame';
    const base = `A textbook endgame drill${title ? `: ${title}` : ''} (${goalWords}). Results come from the endgame tablebase.`;
    const idea = str(drillTeach(card.id)?.idea);
    const withIdea = idea ? `${base} Idea: ${idea}` : base;
    // The prompt cuts a framing at 400 characters: the idea moves to the lesson rather than being cut.
    const fits = withIdea.length <= COACH_LIMITS.text;
    out.framing = fits ? withIdea : base;
    const lesson = fits ? str(card.explanation) : idea;
    if (lesson) out.lesson = lesson;
  } else {
    out.framing = `A practice line set by Claude${title ? `: ${title}` : ''}.`;
  }

  if (kind === 'punish') {
    // Brief m31 4.7: the page's own threat option, so this is the lesson the page prints (its engine figure aside, R5-5).
    const lesson = punishLesson(card, sibling ?? null, { engineFigure: opts.lessonFigure !== false, threat: lessonThreat(card) }) ?? str(card.explanation);
    if (lesson) out.lesson = lesson;
  } else if (kind !== 'endgame') {
    // The card's own explanation. A Lichess puzzle or a drill from Claude without one gets the narrator's summary of
    // its line when that says something: a mate, a stalemate or a change of material. Brief 9.11.3 (FX1b's open issue):
    // a summary with no change ("No material changes hands." or "So far in this line no material changes hands, but
    // …", likewise "the trades are even") is not a lesson, so it stays out.
    // Brief 9.12.2 item 7: a card from his games (pack, page-made or imported) loses its stored-drop sentence here.
    const says = full && full.summary && (full.result || full.material.net !== 0);
    const own = kind === 'pack' ? lessonWithoutStoredDrop(str(card.explanation)) : str(card.explanation);
    const lesson = own || (says ? full.summary : '');
    if (lesson) out.lesson = lesson;
  }
  return out;
}

/** What the page knows about a try: its whole line from the position before it (the try first), where the line comes
 *  from, the page's class for it, and the numbers or tablebase results that go with it. */
interface TryFacts {
  line: string[];
  source?: CoachLineSource;
  verdict: CoachTryVerdict;
  tryWin?: number; bestWin?: number;
  tryResult?: CoachExplainInput['tryResult']; bestResult?: CoachExplainInput['bestResult'];
  /** 9.11.2 (p): the quick check rated the try also-good or close, and `gradeTry` made it a soft retry ('strong'). */
  quickClose?: boolean;
}

/**
 * Brief 9.11.2 (p): the note an explain input carries instead of the depth-12 pair, for a try the quick check rated
 * also-good or close (`TryFacts.quickClose`). Pack and punish cards were picked by an analysis that put the
 * second-best move at least 10 Win% points below the card's move (`pickedByAnalysis`); Claude's drills and positions
 * from a short engine scan were not, so their note claims only what the page says to them.
 */
function quickCheckNote(trySan: string, pickedByAnalysis: boolean): string {
  const why = pickedByAnalysis ? 'the analysis that picked this card found one clearly better move' : 'this card is after a different move';
  return `A quick engine check in this page rated ${trySan} close to the card's move, but ${why}.`;
}

function tryFacts(card: CoachCard, kind: CardKind, wrong: WrongMove, trySan: string, answerUci: string, answerSan: string, side: Side,
  check: TryCheck | null, stored: { line: string[]; winAfter?: number; winBefore?: number } | null, engineScan = false): TryFacts {
  if (kind === 'endgame') {
    // Drills: the tablebase data, never the engine (9.1). The class is gradeTry's (goal kept, slower mate, draw, loss).
    const teach = teachTry(card.id, wrong.fen, wrong.uci);
    const best = teachTry(card.id, wrong.fen, answerUci).result;
    // The goal from the board shown, as the page grades it (`drillGoalAt`; R5-1).
    const g = gradeTry({ kind: 'endgame', trySan, answerSan, solver: side, tryUci: wrong.uci, teach: { ...teach, goal: drillGoalFrom(card.themes, wrong.index) } });
    return {
      line: teach.tryLine ? [wrong.uci, ...teach.tryLine.lineUci] : [], ...(teach.tryLine ? { source: 'tablebase' as const } : {}),
      verdict: g.tryVerdict, ...(teach.result ? { tryResult: teach.result } : {}), ...(best ? { bestResult: best } : {}),
    };
  }
  const usable = check && sameUci(check.tryUci, wrong.uci) ? check : null;
  const g = usable ? gradeTry({ kind, trySan, answerSan, solver: side, tryUci: wrong.uci, check: usable, ...(engineScan ? { engineScan } : {}) }) : null;
  // A finished engine check of this try: its line, its class and (rounded) numbers when the page shows them. A try the
  // quick check rated also-good or close on a pack, punish or agent card is a soft retry (9.11.2 p): no numbers.
  if (usable && g && g.tryVerdict !== 'unchecked') {
    const quickClose = g.action === 'soft' && (g.cls === 'also-good' || g.cls === 'close');
    return {
      line: [wrong.uci, ...usable.replyLine], source: 'engine', verdict: g.tryVerdict,
      ...(g.showNumbers ? { tryWin: g.tryWin, bestWin: g.bestWin } : {}), ...(quickClose ? { quickClose } : {}),
    };
  }
  // His own game move on a mistake card: the line and figures the engine pass over his games stored for exactly this
  // move (L4's fallback). The class is the one the try viewer titles it with (`storedTryText`).
  if (stored && stored.line.length) {
    const cls = stored.winAfter !== undefined && stored.winBefore !== undefined ? classifyWin(stored.winAfter, stored.winBefore) : null;
    return { line: [wrong.uci, ...stored.line], source: 'stored', verdict: cls ?? 'unchecked' };
  }
  // A search that stopped short: its line, labelled as unfinished by the prompt, and no class or numbers (9.1).
  if (usable) return { line: [wrong.uci, ...usable.replyLine], source: 'engine', verdict: 'unchecked' };
  return { line: [], verdict: 'unchecked' };
}

/** Optional context for `explainInput`. */
export interface ExplainContext {
  /** The engine's check of this try (`checkTry`, A4), when the page has one; used only when it is for `wrong.uci`. */
  check?: TryCheck | null;
  /** Punish cards: the sibling mistake card `pack-<rowId>`, what he should have played in his game. */
  sibling?: CoachCard | null;
}

/**
 * Build the explain input for the latest wrong try. The M2 fields keep their meaning: the answer line `bestLineSan`
 * (now whole, from the try's step), the stored refutation `refutationSan` (the reply alone) and the stored figures,
 * both only when the try is his own game move from the card's position (never on punish cards). The M3 fields are
 * filled from the card and `ctx`. `spoilersAllowed` is always true: the request goes out after the click that
 * reveals the answer, with the input built before it.
 */
export function explainInput(card: CoachCard, wrong: WrongMove, source: AttemptSource, ctx: ExplainContext = {}): CoachExplainInput | null {
  let board: Chess;
  try { board = new Chess(wrong.fen); } catch { return null; }
  const side = board.turn();
  const playedSan = sanAt(wrong.fen, wrong.uci);
  if (!playedSan) return null;
  const kind = cardKind(card, source);
  const rest = answerLineFrom(card, wrong.index);
  const bestUci = rest[0];
  if (!bestUci) return null;
  const bestLineSan = sanLine(wrong.fen, rest);
  if (!bestLineSan.length) return null;
  const bestSan = bestLineSan[0];
  const pack = rec(card.pack);
  const sameAsGame = kind !== 'punish' && wrong.index === 0 && wrong.fen === card.fen && pack.playedUci === wrong.uci;
  const refutation = sameAsGame ? uciList(pack.refutationPvUci) : [];
  const winBefore = sameAsGame ? num(pack.winBefore) : undefined, winAfter = sameAsGame ? num(pack.winAfter) : undefined;
  // A position from a short engine scan (source 'personal', graded as 'pack') was not picked by the pack analysis.
  const engineScan = source === 'personal';
  const t = tryFacts(card, kind, wrong, playedSan, bestUci, bestSan, side, ctx.check ?? null,
    refutation.length ? { line: refutation, winAfter, winBefore } : null, engineScan);
  // R5-5 (brief 9.11.3): a finished live check of the try (its class, any class) replaces what the engine pass over his
  // games stored for his game move: no stored Win% before and after, no stored reply line, so one move never gets two
  // figures. The static panel reads the same fields. Without a finished check the stored figures stay, as before.
  const useStored = sameAsGame && !(t.source === 'engine' && t.verdict !== 'unchecked');
  const input: CoachExplainInput = {
    kind: 'explain', itemId: card.id, source, fen: wrong.fen, side, playedUci: wrong.uci, playedSan, bestUci, bestSan,
    bestLineSan, refutationSan: useStored && refutation.length ? sanLine(wrong.fen, [wrong.uci, ...refutation]).slice(1) : [], themes: card.themes,
  };
  if (useStored) {
    if (winBefore !== undefined && winAfter !== undefined) { input.winBefore = Math.round(winBefore); input.winAfter = Math.round(winAfter); }
    const cpBefore = num(pack.cpBefore), cpAfter = num(pack.cpAfter);
    if (cpBefore !== undefined) input.cpBefore = cpBefore;
    if (cpAfter !== undefined) input.cpAfter = cpAfter;
  }

  // R5-5: with the live figure for the answer in the input (`bestWin`), the punish lesson leaves out its stored figure.
  const liveBest = t.tryWin !== undefined && t.bestWin !== undefined;
  Object.assign(input, cardFields(card, source, kind, ctx.sibling, { index: wrong.index, lessonFigure: !liveBest }));
  const pieces = boardText(wrong.fen);
  if (pieces) input.boardText = pieces;
  input.bestLineNotes = notesFor(wrong.fen, rest);
  const tryLineSan = sanLine(wrong.fen, t.line);
  if (tryLineSan.length) {
    input.tryLineSan = tryLineSan;
    input.tryLineNotes = notesFor(wrong.fen, t.line);
    if (t.source) input.trySource = t.source;
  }
  if (t.tryWin !== undefined && t.bestWin !== undefined) { input.tryWin = t.tryWin; input.bestWin = t.bestWin; }
  if (t.tryResult) input.tryResult = t.tryResult;
  if (t.bestResult) input.bestResult = t.bestResult;
  if (t.quickClose) input.tryCheckNote = quickCheckNote(playedSan, kind !== 'agent' && !engineScan);
  input.tryVerdict = t.verdict;
  input.step = wrong.index;
  input.spoilersAllowed = true;
  return input;
}

/** What the static panel shows: always available, no model involved. */
export interface StaticExplanation { playedSan: string; bestLineSan: string[]; refutationSan: string[]; numbers: string | null }
/**
 * The panel prints `refutationSan` as "the engine's reply line", so only the stored engine reply goes there: never a
 * tablebase line, and nothing on an endgame drill. A drill's tablebase results are given in words, never as a Win%.
 */
export function staticExplanation(input: CoachExplainInput): StaticExplanation {
  const tablebase = tablebaseCard(input) || input.trySource === 'tablebase' || !!input.tryResult || !!input.bestResult;
  const parts: string[] = [];
  if (!tablebase && input.winBefore !== undefined && input.winAfter !== undefined) parts.push(`Stored win chance for you: ${Math.round(input.winBefore)}% before, ${Math.round(input.winAfter)}% after.`);
  const results = [
    input.tryResult ? `after ${input.playedSan}, ${resultWords(input.tryResult, input.side)}` : '',
    input.bestResult ? `after ${input.bestSan}, ${resultWords(input.bestResult, input.side)}` : '',
  ].filter(Boolean);
  if (results.length) parts.push(`Tablebase result with best play: ${results.join('; ')}.`);
  return { playedSan: input.playedSan, bestLineSan: input.bestLineSan, refutationSan: tablebase ? [] : input.refutationSan, numbers: parts.length ? parts.join(' ') : null };
}

// ---------------------------------------------------------------- the question box (L6, kind `ask`)

/** A move named in a question: UCI ("g1f3") or SAN ("Nf3", "exd5", "O-O", "e8=Q"), with any check, mate or ?! marks. */
const NAMED_RE = /(?<![A-Za-z0-9])(?:([a-h][1-8][a-h][1-8][qrbnQRBN]?)|(O-O-O|O-O|0-0-0|0-0|[KQRBNkqrn][a-h]?[1-8]?x?[a-h][1-8](?:=?[QRBNqrbn])?|[a-h](?:x[a-h])?[1-8](?:=?[QRBNqrbn])?))(?:[+#]|[!?]{1,2})*(?![A-Za-z0-9-])/g;
/** "the knight on d5", "at f7", "from e2", "of e4": a bare square after these words names a square, not a pawn move. */
const SQUARE_WORD_RE = /\b(?:on|at|from|of)\s+$/i;
/** "instead of e5" names a move (brief 9.10 k): there "of" is a move cue, not a square word. */
const MOVE_CUE_RE = /\binstead\s+of\s+$/i;
/** True when the text before a bare square reads it as a square ("on e5"), not as a pawn move ("instead of e5"). */
const squareWordBefore = (before: string) => SQUARE_WORD_RE.test(before) && !MOVE_CUE_RE.test(before);

/**
 * The moves a question names that are legal at `fen`, in the order he wrote them, each once, at most 3 (L6): UCI
 * or SAN (a lowercase piece letter other than b is read as the piece, castling may use zeros). Each comes back in
 * chess.js's SAN and UCI. A bare square after "on", "at", "from" or "of" is a square, except after "instead of",
 * so "Why not Nc3 instead of e5?" names both moves and "Is the pawn on e5 strong?" names none.
 */
export function movesNamed(fen: string, question: string, max: number = COACH_LIMITS.asked): Array<{ uci: string; san: string }> {
  let start: Chess;
  try { start = new Chess(fen); } catch { return []; }
  const out: Array<{ uci: string; san: string }> = [];
  for (const m of question.matchAll(NAMED_RE)) {
    if (out.length >= max) break;
    let found: { uci: string; san: string } | null = null;
    if (m[1]) {
      const t = m[1].toLowerCase();
      const legal = start.moves({ verbose: true }).find(x => x.from === t.slice(0, 2) && x.to === t.slice(2, 4) && (x.promotion ?? '') === (t[4] ?? ''));
      if (legal) found = { uci: `${legal.from}${legal.to}${legal.promotion ?? ''}`, san: legal.san };
    } else if (m[2]) {
      let token = m[2];
      if (/^[a-h][1-8]$/.test(token) && squareWordBefore(question.slice(0, m.index))) continue;
      if (/^0/.test(token)) token = token.replace(/0/g, 'O');
      else {
        if (/^[kqrn]/.test(token)) token = token.charAt(0).toUpperCase() + token.slice(1);
        token = token.replace(/([1-8])=?([QRBNqrbn])$/, (_, rank: string, piece: string) => `${rank}=${piece.toUpperCase()}`);
      }
      try {
        const legal = new Chess(start.fen()).move(token);
        found = { uci: `${legal.from}${legal.to}${legal.promotion ?? ''}`, san: legal.san };
      } catch { found = null; }
    }
    if (found && !out.some(x => x.uci === found!.uci)) out.push(found);
  }
  return out;
}

/** Context for `buildAskInput`. */
export interface AskContext {
  /** Punish cards: the sibling mistake card. */
  sibling?: CoachCard | null;
  /** The engine check the page already has for a try from the card position: reused, never searched again. */
  known?: { fen: string; check: TryCheck } | null;
  /**
   * Checks one move at `fen` with the engine (the page's deadline and the shared engine). Resolves null when it could
   * not (no engine, a failure, the deadline, or a stop). Never called on endgame drills.
   */
  check: (fen: string, uci: string, answerUci: string | null, signal: AbortSignal) => Promise<TryCheck | null>;
  /** False once the card on screen is no longer this card: the input is then dropped. */
  isCurrent?: () => boolean;
}

/**
 * The ask input for a question about the card (L6, 9.2): the card fields, the whole answer line from the card
 * position with notes, and up to 3 moves named in the question that are legal there, each checked:
 * - endgame drills: the tablebase result of the move and its listed line (`teachTry`), never the engine;
 * - other cards: the engine checker, the answer once and each move once (an earlier check of the same try is reused);
 *   a Win% only from a finished search (depth 0, or 10 and more), as a whole number; a move the engine could not
 *   check falls back to the stored line of his game move (mistake cards), else it is left out.
 * Resolves null when no input can be made, when `signal` aborts, or when the card changed meanwhile.
 */
export async function buildAskInput(card: CoachCard, source: AttemptSource, question: string, signal: AbortSignal, ctx: AskContext): Promise<CoachAskInput | null> {
  const text = question.trim().slice(0, COACH_LIMITS.question);
  if (!text || signal.aborted) return null;
  let board: Chess;
  try { board = new Chess(card.fen); } catch { return null; }
  const side = board.turn();
  const kind = cardKind(card, source);
  const line = answerLineFrom(card, 0);
  const answerLineSan = sanLine(card.fen, line);
  if (!answerLineSan.length) return null;
  const answerUci = line[0];
  const input: CoachAskInput = {
    kind: 'ask', itemId: card.id, source, fen: card.fen, side, question: text,
    ...cardFields(card, source, kind, ctx.sibling), answerLineSan, answerNotes: notesFor(card.fen, line), askedLines: [],
  };
  // R5-1: the card's themes, so a `mateInN` theme lets an answer cite "mate in N".
  const themes = Array.isArray(card.themes) ? card.themes.filter(t => typeof t === 'string' && t.trim()) : [];
  if (themes.length) input.themes = themes;
  const pieces = boardText(card.fen);
  if (pieces) input.boardText = pieces;
  const named = movesNamed(card.fen, text);
  const asked: CoachAskedLine[] = [];

  if (kind === 'endgame') {
    const answerResult = teachTry(card.id, card.fen, answerUci).result;
    if (answerResult) input.answerResult = answerResult;
    for (const m of named) {
      const t = teachTry(card.id, card.fen, m.uci);
      if (!t.result) continue;
      const moves = t.tryLine ? [m.uci, ...t.tryLine.lineUci] : [m.uci];
      asked.push({ san: m.san, lineSan: sanLine(card.fen, moves), notes: notesFor(card.fen, moves), result: t.result, source: 'tablebase' });
    }
    input.askedLines = asked;
    return input;
  }

  const live = () => !signal.aborted && (ctx.isCurrent?.() ?? true);
  const run = async (uci: string): Promise<TryCheck | null> => {
    try { return await ctx.check(card.fen, uci, null, signal); } catch { return null; }
  };
  const checks = new Map<string, TryCheck | null>();
  const known = ctx.known && positionKey(ctx.known.fen) === positionKey(card.fen) ? ctx.known.check : null;
  if (known) checks.set(known.tryUci, known);
  let answerWin = known && known.bestWin !== null && trustedDepth(known.depth) ? Math.round(known.bestWin) : undefined;
  // The answer is searched once, first, when a named move is to be compared with it.
  if (named.length && answerWin === undefined) {
    const a = await run(answerUci);
    if (!live()) return null;
    checks.set(answerUci, a);
    if (a && trustedDepth(a.depth)) answerWin = Math.round(a.tryWin);
  }
  // Brief 9.11.3 (FX4a's open question, widened 10:24): on pack and punish cards, a move other than the card's move that
  // the quick check puts within 5 points of it (also-good or close, as `gradeTry` classes it: the (p) soft retry
  // included) gets the plain note instead of its depth-12 pair. Claude's drills and short-scan positions keep their pairs.
  const noteCard = (kind === 'pack' || kind === 'punish') && source !== 'personal';
  for (const m of named) {
    let c = checks.get(m.uci);
    if (c === undefined) {
      c = await run(m.uci);
      if (!live()) return null;
      checks.set(m.uci, c);
    }
    if (c && sameUci(c.tryUci, m.uci)) {
      const moves = [m.uci, ...c.replyLine];
      const finished = trustedDepth(c.depth);
      const cls = finished && answerWin !== undefined ? classifyWin(c.tryWin, answerWin) : null;
      const near = noteCard && !sameUci(m.uci, answerUci) && (cls === 'also-good' || cls === 'close');
      // Brief 9.12.2 item 8 (V3-5): the card's own move keeps one figure. When the input already carries `answerWin`
      // (from the try's check, or from the search of the card's move above), its line reuses that figure instead of the
      // fresh search's, which can differ by a point or two; the fresh search still gives the line. Unfinished: no figure.
      const win = sameUci(m.uci, answerUci) && answerWin !== undefined ? answerWin : Math.round(c.tryWin);
      asked.push({
        san: m.san, lineSan: sanLine(card.fen, moves), notes: notesFor(card.fen, moves),
        ...(finished && !near ? { win } : {}), source: 'engine',
        // R5-6: only an unfinished search is marked, so the inputs of finished ones keep their hash.
        ...(finished ? {} : { finished: false }),
        ...(near ? { checkNote: quickCheckNote(m.san, true) } : {}),
      });
      continue;
    }
    // No engine result: the stored line of his own game move on a mistake card (no figure), else nothing.
    const pack = rec(card.pack);
    const stored = kind === 'pack' && source === 'pack' && pack.playedUci === m.uci ? uciList(pack.refutationPvUci) : [];
    if (stored.length) {
      const moves = [m.uci, ...stored];
      asked.push({ san: m.san, lineSan: sanLine(card.fen, moves), notes: notesFor(card.fen, moves), source: 'stored' });
    }
  }
  if (!live()) return null;
  if (answerWin !== undefined) {
    input.answerWin = answerWin;
    // R5-5: beside the live figure for the answer, the punish lesson leaves out its stored engine figure.
    if (kind === 'punish') {
      const lesson = cardFields(card, source, kind, ctx.sibling, { lessonFigure: false }).lesson;
      if (lesson) input.lesson = lesson; else delete input.lesson;
    }
  }
  input.askedLines = asked;
  return input;
}
