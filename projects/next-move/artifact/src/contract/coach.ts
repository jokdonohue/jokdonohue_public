/**
 * Coach contract (port plan section 4). B3 implements it in `src/coach/` and exports
 * `createCoach(deps: CoachDeps): CoachClient` from `src/coach/index.ts`; `main.tsx` calls it once
 * `claude.use("sample")` resolves non-null, and passes the client to the Trainer (B2).
 *
 * Frozen after milestone M-a; change only by agreement between B1, B2 and B3.
 * M3 (lead decisions L6, L10): optional "teach the why" fields on the explain input, and a new kind `ask`
 * (a free question after the card is solved or revealed). Every new field is optional, so an M2-shaped
 * input stays valid; the prompt drops each sentence whose field is absent.
 * M3 fix pass (brief section 9.2): lesson identity (`title`, `objective`, `answerSource`, `step`,
 * `spoilersAllowed`), the page's class for the try (`tryVerdict`), tablebase results in words (`tryResult`,
 * `bestResult`, `answerResult`, asked-line `result`), fixed line semantics and lines up to 32 plies.
 * M3 fix round 2 (brief 9.11.2 (p)): `tryCheckNote`, a plain note that replaces the numbers for a try the page's
 * quick check rated close on a card from his games or from Claude (optional, like every M3 field).
 * Fix round 2, stage 2 (brief 9.11.3; additive optional fields, 9.11.6): `CoachAskInput.themes` (R5-1), and on
 * `CoachAskedLine` the flag `finished` (R5-6) and the plain note `checkNote` (the (p) note for questions).
 *
 * Line semantics (section 9.2): every M3 line (`tryLineSan`, asked-line `lineSan`) is the WHOLE line from
 * `fen`, its move first; a line whose first move is not that move is left out, never re-read. The M2 field
 * `refutationSan` is ALWAYS the reply alone: the prompt puts `playedSan` in front of it. The prompt keeps each
 * line only up to its first move that is not legal (checked with chess.js), and at most `COACH_LIMITS.line`
 * plies; a longer line gets the sentence "Note: line shortened to N of M plies; the moves after that are not shown."
 */
import type { AttemptSource } from './docs';
import type { PermissionState, Store } from './store';

/**
 * Where a line came from: `engine` = the bundled engine searched it in this page; `stored` = a line saved
 * with the card (pack engine pass, puzzle solution, drill script); `tablebase` = the Lichess tablebase (endgame drills).
 */
export type CoachLineSource = 'engine' | 'stored' | 'tablebase';

/**
 * Where the card's answer comes from (section 8.4): `puzzle` = a Lichess puzzle's solution; `game-engine` =
 * the engine's line in a position from the learner's own game (pack and punish cards); `tablebase` = an
 * endgame drill checked with the tablebase; `drill` = a practice line set by Claude (agent cards).
 */
export type CoachAnswerSource = 'puzzle' | 'game-engine' | 'tablebase' | 'drill';

/**
 * The page's class for a wrong try (section 9.1, `gradeTry` in `src/teach/grade.ts`), from whole-number Win%
 * for `side` (gap = bestWin - tryWin): `also-good` tryWin >= max(65, bestWin - 5); `close` not also-good and
 * gap <= 5; `strong` tryWin >= 65 and gap > 5; `worse` 35 <= tryWin < 65 and gap > 5; `losing` tryWin < 35 and
 * gap > 5; `unchecked` = no finished analysis (engine missing, failed, stopped, past the deadline, or too shallow).
 */
export type CoachTryVerdict = 'also-good' | 'close' | 'strong' | 'worse' | 'losing' | 'unchecked';
export const COACH_TRY_VERDICTS: readonly CoachTryVerdict[] = ['also-good', 'close', 'strong', 'worse', 'losing', 'unchecked'];

/** A tablebase result for `side`, with best play from both sides. Never turned into a percentage. */
export type CoachTablebaseResult = 'win' | 'draw' | 'loss';

/**
 * Size limits of the M3 fields. Longer values are cut when the prompt is built (never an error), so a
 * slightly long text cannot cost the learner his answer; the question box itself stops at `question`.
 */
export const COACH_LIMITS = {
  /** `framing`, `boardText`, `lesson`. */
  text: 400,
  /** `title`, `objective`. */
  label: 200,
  /** Each note in `bestLineNotes`, `tryLineNotes`, `answerNotes`, asked-line `notes`. */
  note: 200,
  /** Plies shown of any line (section 8.12); a longer line is cut with a "Note: line shortened to N of M plies" sentence. */
  line: 32,
  /** Notes per line: only the first 12 plies of a line carry a note. */
  notes: 12,
  /** `CoachAskInput.question`. */
  question: 300,
  /** `CoachAskInput.askedLines`. */
  asked: 3,
} as const;

/**
 * "Why does my move fail?" (modelTier "default"). Every prompt field comes from here and nowhere else.
 *
 * Point of view: `side` is the side to move at `fen`, the side the learner plays on this card (on a punish
 * card that is his game opponent's side). Every Win% below is for `side`.
 */
export interface CoachExplainInput {
  kind: 'explain';
  /** Card or puzzle id; with `playedUci` it keys `explanations/<itemId>__<playedUci>`. */
  itemId: string;
  source: AttemptSource;
  fen: string;
  /** Side to move at `fen` (the learner). */
  side: 'w' | 'b';
  playedUci: string;
  playedSan: string;
  bestUci: string;
  bestSan: string;
  /** The card's answer line from `fen`, in SAN, starting with `bestSan` (whole; up to 32 plies are shown). */
  bestLineSan: string[];
  /**
   * Stored engine reply line after the played move, in SAN: ALWAYS the reply only, without `playedSan` (the
   * prompt puts `playedSan` in front); empty when not stored. M2 field: when `tryLineSan` is given the prompt
   * uses that instead and never shows both.
   */
  refutationSan: string[];
  /**
   * Stored Win% (0-100) for `side` before and after `playedUci`. Pass them only when `playedUci` is the
   * learner's own game move from `fen` (own-game mistake cards); never on punish cards, where the stored
   * figures are from the other side and about a different move. Absent: the sentence is dropped.
   */
  winBefore?: number;
  winAfter?: number;
  /** Stored centipawns from the learner's view, when the source has them (games, pack). Never rendered. */
  cpBefore?: number | null;
  cpAfter?: number | null;
  themes: string[];

  // ---- M3 (L6), all optional ----
  /** What the card teaches, in one or two plain sentences (cut at 400 chars). The prompt opens with it. */
  framing?: string;
  /** The pieces in words, e.g. `boardText(fen)` from `src/teach/narrate.ts` (cut at 400 chars). */
  boardText?: string;
  /** The card's lesson: the punish lesson (L5), the drill idea (L9) or the card's explanation (cut at 400 chars). */
  lesson?: string;
  /** One computed sentence per ply of `bestLineSan`, same order (narrator `plies[i].text`); notes for the first 12 plies, 200 chars each. */
  bestLineNotes?: string[];
  /**
   * The try's line from `fen` in SAN: ALWAYS the whole line, `playedSan` FIRST, then the reply (the same array
   * the line viewer plays, L2). A line whose element 0 is not `playedSan` is left out (never read as a reply).
   * Up to 32 plies are shown.
   */
  tryLineSan?: string[];
  /** One computed sentence per ply of `tryLineSan`, same order (element 0 is about the try); first 12 plies. */
  tryLineNotes?: string[];
  /** Where the try's line came from (live engine L4, stored line, or tablebase L9). */
  trySource?: CoachLineSource;
  /**
   * Win% (0-100, whole numbers; C rounds) for `side` after the try and after the answer, from the same search
   * (L4 `tryWin`/`bestWin`). Never rendered for a tablebase line, with a tablebase result, or when `tryVerdict`
   * is `unchecked`.
   */
  tryWin?: number;
  bestWin?: number;

  // ---- M3 fix pass (section 9.2), all optional ----
  /** The card's title (cut at 200 chars). */
  title?: string;
  /**
   * The card's goal in words (section 8.11), e.g. "win material", "find the mate", "hold the draw" (draw drills),
   * "exploit the move just played" (punish), "find the engine's move from your game" (pack); cut at 200 chars.
   */
  objective?: string;
  /** Where the answer comes from; names the answer line in the prompt. Absent: the label follows `source`. */
  answerSource?: CoachAnswerSource;
  /** Ply index of the try in the card's line: 0 = the learner's first move on the card. */
  step?: number;
  /**
   * True once the card is complete or he asked (which reveals). False while he is still solving: the prompt
   * then leaves out the answer, its line and notes, and the card lesson, and names no move to play. Absent:
   * as true.
   */
  spoilersAllowed?: boolean;
  /**
   * The page's class for the try (section 9.1). It decides the instruction: `also-good`, `close` and `strong`
   * compare the two lines and never say the try fails; `worse` and `losing` may say what goes wrong, from the
   * given lines only; `unchecked` (and any unknown value) asks how the try and the answer differ, without a
   * failure claim, and drops `tryWin`/`bestWin`. Absent: derived from the tablebase results, else from
   * `tryWin`/`bestWin` (the section 9.1 classes), else `worse` for the M2 stored refutation of his game move,
   * else `unchecked`. Since brief 9.11.2 (p) the page also sends `strong` for a try its quick check rated
   * also-good or close on a pack, punish or agent card (a soft retry, never accepted); that input carries
   * `tryCheckNote` and no `tryWin`/`bestWin`.
   */
  tryVerdict?: CoachTryVerdict;
  /**
   * Brief 9.11.2 (p): one plain note from the page, sent instead of numbers, for a try that the page's quick engine
   * check (depth 12) rated also-good or close on a card from his games or from Claude. `gradeTry` grades that try as
   * a soft retry with `tryVerdict` `strong`. On pack and punish cards the note says that a quick check rated the try
   * close to the card's move, and the analysis that picked the card found one clearly better move; on Claude's drills
   * and on positions from a short engine scan, that the card is after a different move. The input then has no
   * `tryWin`/`bestWin`. The prompt uses the note only with `tryVerdict` `also-good`, `close` or `strong`, and never on
   * an endgame drill: it states the note (cut at 400 chars), leaves out `tryWin`/`bestWin`, and its instruction starts
   * from the note and says neither that the try fails nor that it is as good as the answer. Otherwise it is ignored.
   */
  tryCheckNote?: string;
  /**
   * Tablebase results for `side` after the try and after the answer (endgame drills). When present the prompt
   * states them in words ("White wins", "the game is a draw"), never as a percentage, and leaves out
   * `tryWin`/`bestWin` (send them absent).
   */
  tryResult?: CoachTablebaseResult;
  bestResult?: CoachTablebaseResult;
  /**
   * Punish cards only. `gameFen`: the position one ply BEFORE `fen` (`pack.sourceFen`). `gameMoveSan`: the
   * move the learner made there in his game (by the side NOT to move at `fen`), which led to `fen`.
   * `betterMoveSan`: what he should have played there (the sibling card's answer). `betterLineSan`: its line
   * from `gameFen`, starting with `betterMoveSan` (up to 32 plies shown).
   * The prompt states this context only when playing `gameMoveSan` from `gameFen` reaches `fen` (checked with
   * chess.js), and keeps the better line only up to its first move that is not legal from `gameFen`; without
   * `gameFen` the four fields are left out.
   */
  gameFen?: string;
  gameMoveSan?: string;
  betterMoveSan?: string;
  betterLineSan?: string[];
}

/** One move the learner named in his question, checked by the page (L6). */
export interface CoachAskedLine {
  /** The move, in SAN, legal at `fen` (an entry whose move is not legal there is left out). */
  san: string;
  /**
   * Its line from `fen` in SAN: ALWAYS the whole line, `san` first, then the reply (up to 32 plies shown).
   * Empty means the move alone; a line whose element 0 is not `san` is not used (the move alone is shown).
   */
  lineSan: string[];
  /** One computed sentence per ply of `lineSan` (element 0 is about `san`); first 12 plies, 200 chars each. */
  notes?: string[];
  /** Win% (0-100, whole number) for `side` after `san`; never rendered for a tablebase line or with `result`. */
  win?: number;
  /** Tablebase result for `side` after `san` (drills), instead of a Win%; stated even when there is no line. */
  result?: CoachTablebaseResult;
  source: CoachLineSource;
  /**
   * Brief 9.11.3 (R5-6), `engine` lines only: false when the page's search of this move stopped short (below depth 10,
   * no `win`). The prompt and the coach panel then label the line "engine line, from a search that did not finish".
   * Absent: a finished search (the page sends `false` only, so earlier inputs keep their hash).
   */
  finished?: boolean;
  /**
   * Brief 9.11.3 (the (p) note for questions), `engine` lines only: on a pack or punish card, a move other than the
   * card's move whose quick check (depth 12) came within 5 points of the card's move carries this plain note instead of
   * its figures ("A quick engine check in this page rated {move} close to the card's move, but the analysis that picked
   * this card found one clearly better move."); `win` is then absent. Claude's drills and short-scan positions keep
   * their figures. The prompt states the note (cut at 400 chars) in place of the Win% sentence.
   */
  checkNote?: string;
}

/**
 * A free question after the card is solved or revealed (modelTier "default"; L6). The question is the
 * learner's own text: it is never trusted as chess data, so a move in it counts as given only when the page
 * analysed it into `askedLines`. Cached at `explanations/<itemId>__ask-<inputsHash>`.
 */
export interface CoachAskInput {
  kind: 'ask';
  itemId: string;
  source: AttemptSource;
  fen: string;
  /** Side to move at `fen` (the side the learner plays on this card). Every Win% is for this side. */
  side: 'w' | 'b';
  /** 1-300 characters after trimming (longer text is cut). */
  question: string;
  framing?: string;
  boardText?: string;
  lesson?: string;
  /** Section 9.2, same meaning as on `CoachExplainInput`. */
  title?: string;
  objective?: string;
  answerSource?: CoachAnswerSource;
  /** The card's answer line from `fen` (whole), in SAN, answer first (up to 32 plies shown). */
  answerLineSan: string[];
  /** One computed sentence per ply of `answerLineSan`; first 12 plies. */
  answerNotes?: string[];
  /** Win% (0-100, whole number) for `side` after the answer's first move, when the page searched it (L4 `bestWin`). */
  answerWin?: number;
  /** Tablebase result for `side` after the answer (drills); when present `answerWin` is not rendered. */
  answerResult?: CoachTablebaseResult;
  /** Punish cards only; same meaning and the same check as on `CoachExplainInput`. */
  gameFen?: string;
  gameMoveSan?: string;
  betterMoveSan?: string;
  betterLineSan?: string[];
  /** Up to 3 moves named in the question that are legal at `fen`, each with its line (empty when none). */
  askedLines: CoachAskedLine[];
  /**
   * Brief 9.11.3 (R5-1): the card's themes. The prompt states them ("Themes: …"), and each `mateInN` theme lets an
   * answer cite "mate in N" (the question is about the card position). Absent: no themes sentence.
   */
  themes?: string[];
}

/** "What should I practise next?" on the session summary (modelTier "quick"; M2). */
export interface CoachSummaryInput {
  kind: 'summary';
  session: Array<{ theme: string; attempts: number; correct: number; rate: number | null }>;
  /** Top 5 of `derived/snapshot.weakest`. */
  weakest: Array<{ theme: string; rate: number | null; attempts: number }>;
  focus: Array<{ theme: string; weight: number; reason: string }>;
}

export type CoachInput = CoachExplainInput | CoachSummaryInput | CoachAskInput;

export interface CoachResult {
  text: string;
  /** False when a SAN token or a number in `text` is not in the inputs (show the check-on-the-board warning). */
  grounded: boolean;
  /** The ungrounded tokens, for the `grounded:false` review. */
  misses: string[];
  /** True when the answer came from `explanations/*` without a model call. */
  cached: boolean;
  truncated: boolean;
  /** Epoch ms of the answer. */
  at: number;
  inputsHash: string;
}

/**
 * What the page does with a failure, collapsed from the platform's SampleErrorCode:
 * - `hide`: not_granted, sampling_disabled, not_declared, capability_disabled, capability_removed:
 *   hide the button for this view, keep the static panel;
 * - `tell`: rate_limited, session_expired, refused, empty_completion, upstream_error, and the
 *   page's own limits (cooldown, daily cap, one call in flight): show `message`, keep the control;
 * - `cancelled`: the Stop button; restore the idle UI silently.
 */
export type CoachFailureAction = 'hide' | 'tell' | 'cancelled';
export type CoachErrorCode =
  | 'not_granted' | 'sampling_disabled' | 'not_declared' | 'capability_disabled' | 'capability_removed'
  | 'rate_limited' | 'session_expired' | 'refused' | 'empty_completion' | 'upstream_error'
  | 'cancelled' | 'busy' | 'cooldown' | 'daily_limit' | 'invalid_request' | 'prompt_too_large';
export interface CoachFailure {
  code: CoachErrorCode;
  action: CoachFailureAction;
  /** Viewer copy. */
  message: string;
  /** Partial answer that streamed before the failure, when the platform kept one. */
  partial?: string;
  /** For `cooldown`/`daily_limit`/`rate_limited`: epoch ms when asking makes sense again. */
  retryAt?: number;
}
/** Rejection type of `CoachClient.ask`. */
export class CoachError extends Error {
  constructor(readonly failure: CoachFailure) {
    super(failure.message);
    this.name = 'CoachError';
  }
}

export interface CoachAskOptions {
  signal?: AbortSignal;
  /** Streaming: called with the WHOLE answer so far. */
  onText?: (text: string) => void;
}

export interface CoachClient {
  /** `permissions.state("sample")`; never prompts. `prompt` -> label "Ask Claude (asks permission once)"; `denied`/`unavailable` -> hide. */
  availability(): Promise<PermissionState>;
  /**
   * Cache first (`explanations/*`: explain at `<itemId>__<playedUci>`, ask at `<itemId>__ask-<inputsHash>`),
   * then one rate-limited model call. Rejects `CoachError`. Call only from a click.
   */
  ask(input: CoachInput, options?: CoachAskOptions): Promise<CoachResult>;
  /** Calls left today on this device, and when the cooldown ends (epoch ms, 0 if none). */
  limits(): { remainingToday: number; cooldownUntil: number };
}

/** Minimal shape of the platform `sample` namespace that the coach needs (see sample.d.ts, contract 0.2.96). */
export interface SampleFn {
  (input: string | Array<{ role: 'user' | 'assistant'; content: string }>, options?: {
    modelTier?: 'quick' | 'default' | 'complex';
    signal?: AbortSignal;
    onText?: (chunk: { text: string; delta: string }) => void;
    cache?: boolean;
  }): Promise<{ text: string; truncated: boolean }>;
}
/** Minimal shape of the platform `permissions` namespace. */
export interface PermissionsApi {
  state(name: string): Promise<PermissionState>;
}

export interface CoachDeps {
  sample: SampleFn;
  /** Null when the permissions namespace is unavailable: treat availability as `prompt`. */
  permissions: PermissionsApi | null;
  store: Store;
  deviceId: string;
  /** Browser storage for the per-device rate-limit counter (localStorage in the page; a Map in tests). */
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  now?: () => number;
}
export type CreateCoach = (deps: CoachDeps) => CoachClient;
