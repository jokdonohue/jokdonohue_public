/**
 * Coach prompts (port plan section 4; M3 lead decision L6; brief section 9.2). Pure functions: every fact in a
 * prompt comes from a CoachInput field and nowhere else. Each builder also returns what the answer may cite (SAN
 * moves, squares and numbers), which `ground.ts` checks the answer against.
 *
 * Explain prompt order (M3): role; the card (title, `framing`, goal); the position (FEN, side to move, the
 * pieces, the card lesson, and on punish cards the game move that led here and the better move); the try and
 * where it came in the card; the answer line with its notes; the try's line with its notes; the numbers (Win%,
 * or tablebase results in words); the themes; then the instructions (at most 120 words). The instruction follows
 * the page's class for the try (`tryVerdict`, section 9.1): `also-good`, `close` and `strong` compare the two
 * lines and never say the try fails; `worse` and `losing` say what goes wrong, from the given lines only;
 * `unchecked` asks how the try and the answer differ. Sentences whose fields are absent are dropped, so an
 * M2-shaped input still gets the M2 content.
 * Brief 9.11.2 (p): with `tryCheckNote` and a `tryVerdict` of `also-good`, `close` or `strong` (never on an endgame
 * drill), the note takes the place of the live numbers: it is stated as "Note on the learner's try: …", `tryWin` and
 * `bestWin` are left out, and the instruction starts from the note. It says neither that the try fails nor that it is
 * as good as the answer, and it never calls the try a good move. With any other class the note is ignored.
 *
 * Lines (section 9.2): `tryLineSan` and asked-line `lineSan` are whole lines, their move first; the M2
 * `refutationSan` is the reply alone and always gets the try in front. Every line is checked with chess.js from
 * its start position and kept up to its first move that is not legal (a FEN chess.js cannot read leaves the
 * lines as given); at most 32 plies are shown, and a longer line gets "Note: line shortened to N of M plies".
 * Tablebase results are stated in words, never as percentages; on an endgame drill no Win% is ever shown.
 *
 * Fix round 2 (brief 9.11.3):
 * - R5-1: each `mateInN` theme gives a citable mate marker ("mate in N", see ground.ts `mateMarker`), counted from the
 *   try's position (N minus the solver's moves already played; explain at a later step also says the distance in a
 *   sentence). The ask prompt states the card's themes too (`CoachAskInput.themes`). The card lesson's own "mate in N"
 *   counts only at the card's start (a drill's explanation describes it from there).
 * - R5-2: an answer may cite only the numbers of the figure sentences (Win% before and after, drop, difference, the
 *   answer's and the checked moves' Win%) and the Win% figures of the card lesson. Title, framing, goal, pieces and
 *   notes give moves, squares and mate markers only.
 * - R5-3: the ask instruction asks for "this page did not check that move" without the move written out.
 * - R5-4: with the numbers as basis and the try's Win% at least the answer's, the instruction says "at least as good"
 *   and never "about as good" or "nearly as good".
 * - R5-5: "still a good move" is never said beside a stored drop.
 * - R5-6: a checked move whose search did not finish (`finished: false`) is labelled "engine line, from a search that
 *   did not finish" and gets no Win%.
 * - The (p) note for questions: a checked move with `checkNote` gets "Note on {move}: …" in place of its figures.
 */
import { Chess } from 'chess.js';
import {
  COACH_LIMITS, COACH_TRY_VERDICTS,
  type CoachAnswerSource, type CoachAskedLine, type CoachAskInput, type CoachExplainInput, type CoachInput,
  type CoachLineSource, type CoachSummaryInput, type CoachTablebaseResult, type CoachTryVerdict,
} from '../contract/coach';
import type { AttemptSource } from '../contract/docs';
import { givenInText, mateMarker, normalizeSan, type GivenTextOptions } from './ground';
import { canonicalJson, stableId } from './hash';

export interface BuiltPrompt {
  prompt: string;
  modelTier: 'quick' | 'default';
  /** SAN moves the answer may name (as written in the prompt's data). */
  sans: string[];
  /** Numbers the answer may cite (as rendered in the prompt's data, not its instructions). */
  numbers: number[];
  /** The position, so bare squares occupied there may be named. */
  fen?: string;
  /** Squares named in the prompt's computed texts (notes, framing, lesson, pieces); an answer may name them too. */
  squares?: string[];
}

/**
 * Part of every inputsHash (brief section 8.14). Change it when the prompt wording changes after answers have
 * been cached under it, so an answer cached under older wording is never served for the new prompt. The
 * version-6 page hashed inputs without it, so none of its cached answers (the three M2 non-answers among them)
 * can match an M3 hash. No page has been published with 'm3-1', so the section 9.2 wording keeps it.
 */
export const COACH_PROMPT_VERSION = 'm3-1';
/** A3's name for the same constant (kept so existing imports work). */
export const PROMPT_VERSION = COACH_PROMPT_VERSION;
/** Answer length asked for in explain and ask prompts. */
export const ANSWER_WORDS = 120;

const MAX_LINE = COACH_LIMITS.line;
const MAX_NOTES = COACH_LIMITS.notes;
/** At most this many entries of a line array are read: a sanity cap far above any real line. */
const MAX_GIVEN = 256;
const MAX_THEMES = 10;
const clean = (s: unknown, max = 80) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const round = (x: number) => Math.round(x);
const pct = (r: number | null) => (r === null ? null : Math.round(r * 100));
const numbersIn = (text: string) => (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
const colorName = (c: 'w' | 'b') => (c === 'w' ? 'White' : 'Black');
const otherColor = (c: 'w' | 'b'): 'w' | 'b' => (c === 'w' ? 'b' : 'w');
/** A Win% field clamped to 0-100, or null when absent or not a finite number. */
const clampWin = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? Math.min(100, Math.max(0, x)) : null);
/** The same, as the whole number the prompt renders (section 9.1 classes use this rounded value). */
const winOf = (x: unknown): number | null => { const v = clampWin(x); return v === null ? null : round(v); };
const textOf = (x: unknown, max: number = COACH_LIMITS.text) => (typeof x === 'string' ? clean(x, max) : '');
/** `text` as a sentence: a full stop unless it already ends with one. */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** `map[key]` for the map's own keys only, so "constructor" or "toString" never match. */
const own = <V>(map: Record<string, V>, key: unknown): V | undefined =>
  (typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);
/** A ply index, or null when absent or not a small whole number. */
const stepOf = (x: unknown): number | null => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 1000 ? x : null);

/** The leading non-empty SAN strings of a line array (at most 256). */
function givenSans(line: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(line)) return out;
  for (const m of line.slice(0, MAX_GIVEN)) {
    const s = typeof m === 'string' ? clean(m, 12) : '';
    if (!s) break;
    out.push(s);
  }
  return out;
}
const notesOf = (notes: unknown): string[] => (Array.isArray(notes) ? notes.slice(0, MAX_NOTES).map(n => textOf(n, COACH_LIMITS.note)) : []);

/** A line as a prompt shows it: `sans` = the plies shown (at most 32); `total` = the plies that were legal (M in "N of M"). */
export interface ShownLine { sans: string[]; total: number }
/**
 * The plies of `line` that are legal one after another from `fen` (strict SAN, written as chess.js writes them),
 * at most 32 of them. When chess.js cannot read `fen`, the line is taken as given.
 */
export function shownLine(fen: unknown, line: unknown): ShownLine {
  const given = givenSans(line);
  let board: Chess | null = null;
  if (typeof fen === 'string' && fen.trim()) { try { board = new Chess(fen); } catch { board = null; } }
  let legal = given;
  if (board) {
    legal = [];
    // Strict: the permissive parser would read "Nd4" as the capture "Nxd4".
    for (const san of given) { try { legal.push(board.move(san, { strict: true }).san); } catch { break; } }
  }
  return { sans: legal.slice(0, MAX_LINE), total: legal.length };
}

/**
 * One move the learner asked about, as the ask prompt and the question box show it (section 9.2): `lineSan` is
 * the whole line, `san` first; an empty line, or one that starts with another move, shows the move alone. Null
 * when `san` is empty or not legal at `fen`.
 */
export function askedLineSans(fen: unknown, asked: Pick<CoachAskedLine, 'san' | 'lineSan'>): ShownLine | null {
  const san = clean(asked?.san ?? '', 12);
  if (!san) return null;
  const given = givenSans(asked?.lineSan);
  const shown = shownLine(fen, given.length && normalizeSan(given[0]) === normalizeSan(san) ? given : [san]);
  return shown.sans.length ? shown : null;
}

/**
 * The section 9.1 class from whole-number Win% for the side to move (gap = bestWin - tryWin). Used only for an
 * input without `tryVerdict`; the page's `gradeTry` (src/teach/grade.ts) is the authority.
 */
export function verdictFromWin(tryWin: number, bestWin: number): Exclude<CoachTryVerdict, 'unchecked'> {
  if (tryWin >= Math.max(65, bestWin - 5)) return 'also-good';
  if (bestWin - tryWin <= 5) return 'close';
  if (tryWin >= 65) return 'strong';
  return tryWin >= 35 ? 'worse' : 'losing';
}
const RESULTS: readonly unknown[] = ['win', 'draw', 'loss'];
const resultOf = (r: unknown): CoachTablebaseResult | null => (RESULTS.includes(r) ? (r as CoachTablebaseResult) : null);
const RANK: Record<CoachTablebaseResult, number> = { loss: 0, draw: 1, win: 2 };
/** From tablebase results: the same (or a better) result is also good; a worse one is worse, or losing when it loses. */
const verdictFromResults = (t: CoachTablebaseResult, b: CoachTablebaseResult): CoachTryVerdict =>
  (RANK[t] >= RANK[b] ? 'also-good' : t === 'loss' ? 'losing' : 'worse');
/**
 * True for a card whose answer comes from the tablebase (an endgame drill). Drills never use the engine (section
 * 9.1), so no Win% is ever shown for them, whatever fields came along: results are words (Codex F3).
 */
export function tablebaseCard(input: { source?: unknown; answerSource?: unknown }): boolean {
  return input.source === 'endgame' || input.answerSource === 'tablebase';
}
/** A tablebase result in words for the side `side` names ("White wins", "the game is a draw", "Black loses"). */
export function resultWords(result: CoachTablebaseResult, side: 'w' | 'b'): string {
  return result === 'win' ? `${colorName(side)} wins` : result === 'draw' ? 'the game is a draw' : `${colorName(side)} loses`;
}

/** Labels for where the card's answer line comes from (an "engine" label on a puzzle solution would be false). */
const ANSWER_LABEL: Record<AttemptSource, string> = {
  bank: "the puzzle's solution",
  pack: "the engine's best line",
  endgame: "the drill's line, checked with the tablebase",
  agent: "the drill's line",
  personal: "a short engine scan's candidate line",
};
/** Section 8.4 provenance, when the page names it (`answerSource`); it wins over the label from `source`. */
const ANSWER_SOURCE_LABEL: Record<CoachAnswerSource, string> = {
  puzzle: "the Lichess puzzle's solution",
  'game-engine': "the engine's best line, in a position from the learner's own game",
  tablebase: "the drill's line, checked with the endgame tablebase",
  drill: 'a practice line set by Claude',
};
const LINE_LABEL: Record<CoachLineSource, string> = {
  engine: 'engine line, searched in this page',
  stored: 'line stored with the card',
  tablebase: 'tablebase line',
};
/** R5-6: the label of a checked move's engine line whose search stopped short (ask prompt and the coach panel). */
export const UNFINISHED_LINE_LABEL = 'engine line, from a search that did not finish';

/**
 * R5-1: the mate distances the `mateInN` themes give from ply `step` of the card's line (N minus the solver's moves
 * already played; none at 0 or below), each once.
 */
export function themeMateDistances(themes: readonly unknown[], step = 0): number[] {
  const out: number[] = [];
  const played = Math.floor(Math.max(0, step) / 2);
  for (const t of themes) {
    const m = typeof t === 'string' ? /^mateIn([1-9]\d*)$/.exec(t.trim()) : null;
    const left = m ? Number(m[1]) - played : 0;
    if (left > 0 && !out.includes(left)) out.push(left);
  }
  return out;
}
const answerLabel = (source: unknown, answerSource: unknown) => own(ANSWER_SOURCE_LABEL, answerSource) ?? own(ANSWER_LABEL, source) ?? 'the stored line';

export function inputsHash(input: CoachInput): string {
  return `h${stableId(`${COACH_PROMPT_VERSION}\n${canonicalJson(input)}`)}`;
}

interface Ply { san: string; color: 'w' | 'b'; note: string }
/** Plies of a line from a position where `first` moves; `notes[i]` belongs to ply i. */
const plies = (sans: string[], notes: string[], first: 'w' | 'b'): Ply[] =>
  sans.map((san, i) => ({ san, color: i % 2 === 0 ? first : otherColor(first), note: notes[i] ?? '' }));
const lineText = (ps: Ply[]) => ps.map(p => p.san).join(' ');
const noteRows = (ps: Ply[]) => ps.filter(p => p.note).map(p => `- ${p.san} (${colorName(p.color)}): ${p.note}`);

/** Placement and side to move: the part of a FEN that a move decides. */
const boardKey = (fen: string) => fen.trim().split(/\s+/).slice(0, 2).join(' ');
/** The game move in chess.js SAN when, played from `gameFen` by `color`, it reaches `fen`; otherwise null. */
function gameMoveTo(gameFen: string, san: string, fen: string, color: 'w' | 'b'): string | null {
  try {
    const board = new Chess(gameFen);
    if (board.turn() !== color) return null;
    const played = board.move(san, { strict: true }).san;
    return boardKey(board.fen()) === boardKey(fen) ? played : null;
  } catch { return null; }
}

/** Collects the prompt's data sentences and everything an answer may cite from them. */
class Given {
  readonly lines: string[] = [];
  readonly sans: string[] = [];
  readonly numbers: number[] = [];
  readonly squares: string[] = [];
  /**
   * A sentence of the page's own computed text: its moves, squares and mate markers become citable, and its numbers
   * only as `numbers` says (R5-2: by default none; figures come from the figure sentences, pushed by the builders).
   */
  text(sentence: string, computed: string, opts: GivenTextOptions = {}): void {
    this.lines.push(sentence);
    const g = givenInText(computed, { numbers: 'none', ...opts });
    this.sans.push(...g.sans); this.squares.push(...g.squares); this.numbers.push(...g.numbers);
  }
  /**
   * A line with its notes: the moves become citable, and so do the notes' tokens. When the line had more legal
   * plies than are shown (`total`), a sentence says so (section 8.12: never cut silently); N and M are not figures.
   */
  line(label: string, ps: Ply[], notesLabel: string, total = ps.length): void {
    if (!ps.length) return;
    this.lines.push(`${label}: ${lineText(ps)}.`);
    if (total > ps.length) this.lines.push(`Note: line shortened to ${ps.length} of ${total} plies; the moves after that are not shown.`);
    this.sans.push(...ps.map(p => p.san));
    const rows = noteRows(ps);
    if (rows.length) {
      this.lines.push(`${notesLabel}:`, ...rows);
      for (const p of ps) if (p.note) { const g = givenInText(p.note, { numbers: 'none' }); this.sans.push(...g.sans); this.squares.push(...g.squares); }
    }
  }
}

interface CardContext { fen: string; side: 'w' | 'b'; title?: string; framing?: string; objective?: string; boardText?: string; lesson?: string }
/**
 * The opening sentences shared by the explain and ask prompts: the card (title, what it teaches, its goal), the
 * position, its pieces and lesson. `hide` (while he is still solving) holds the answer's moves: a title, framing
 * or goal that names one of them is left out, and so is the lesson.
 */
function context(g: Given, input: CardContext, hide: Set<string> | null = null, step = 0): void {
  const namesAnswer = (text: string) => {
    if (!hide) return false;
    const t = givenInText(text);
    return [...t.sans, ...t.squares].some(s => hide.has(normalizeSan(s)));
  };
  const title = textOf(input.title, COACH_LIMITS.label), framing = textOf(input.framing), objective = textOf(input.objective, COACH_LIMITS.label);
  const board = textOf(input.boardText), lesson = hide ? '' : textOf(input.lesson);
  // R5-2: title and framing give moves and squares only (a title's "move 30", a date, a rating, or a drill's "mate in
  // three" are no facts an answer may cite); the goal also gives its mate distance as a marker (R5-1: counted from the
  // board shown, so "find the mate in 2" at step 2 of a mate in three).
  if (title && !namesAnswer(title)) g.text(`Card title: ${sentence(title)}`, title, { mates: false });
  if (framing && !namesAnswer(framing)) g.text(`What this card teaches: ${framing}`, framing, { mates: false });
  if (objective && !namesAnswer(objective)) g.text(`Goal of this card: ${sentence(objective)}`, objective);
  g.lines.push(`Position (FEN): ${clean(input.fen, 120)}. ${colorName(input.side)} to move.`);
  if (board) g.text(`Pieces: ${board}`, board);
  // R5-2: the lesson is the one computed text whose numbers may be figures (a punish lesson's "about 85% to win").
  // R5-1: it describes the card from its start, so its "mate in N" counts only there (a drill's "misses the mate in
  // two" is stale once he has played a move).
  if (lesson) g.text(`Card lesson: ${lesson}`, lesson, { numbers: 'percent', mates: Math.floor(Math.max(0, step) / 2) === 0 });
}

/** R5-1: the card's themes as a data sentence, with a citable mate marker for each `mateInN` theme from ply `step`. */
function themesLine(g: Given, themes: string[], step: number): void {
  if (!themes.length) return;
  g.lines.push(`Themes: ${themes.join(', ')}.`);
  for (const left of themeMateDistances(themes, step)) {
    g.squares.push(mateMarker(left));
    // At a later step the theme still counts from the card's start: the distance left is said in its own sentence.
    if (Math.floor(step / 2) > 0) g.lines.push(`From this position the card's line is a mate in ${left}.`);
  }
}

/**
 * Punish cards: the learner's game move that led to `fen` and the better move. Computed, not trusted: the
 * context is stated only when `gameMoveSan` played from `gameFen` reaches `fen`, and the better line keeps only
 * its moves that are legal from `gameFen`; otherwise the fields are left out.
 */
function gameContext(g: Given, input: { fen: string; side: 'w' | 'b'; gameFen?: string; gameMoveSan?: string; betterMoveSan?: string; betterLineSan?: string[] }): void {
  const them = otherColor(input.side);
  const before = typeof input.gameFen === 'string' ? input.gameFen : '';
  const game = before && input.gameMoveSan ? gameMoveTo(before, clean(input.gameMoveSan, 12), input.fen, them) : null;
  if (!game) return;
  g.lines.push(`This position comes from the learner's own game, where he played ${colorName(them)}. His move ${game} led to this position; on this card he plays ${colorName(input.side)}.`);
  g.sans.push(game);
  const better = clean(input.betterMoveSan ?? '', 12);
  let line = shownLine(before, input.betterLineSan);
  if (better && (!line.sans.length || normalizeSan(line.sans[0]) !== normalizeSan(better))) line = shownLine(before, [better]);
  if (!line.sans.length) return;
  g.line(`In the position before ${game}, the better move for ${colorName(them)} was ${line.sans[0]}. Its engine line from there`, plies(line.sans, [], them), 'Notes', line.total);
}

/** The classes with which the prompt uses `tryCheckNote` (brief 9.11.2 (p)); with any other class it is ignored. */
const NOTE_VERDICTS: readonly CoachTryVerdict[] = ['also-good', 'close', 'strong'];

/** The style rules of every answer the learner reads (brief L11). */
const STYLE = 'Use plain words and short sentences, one idea per sentence. Name pieces with their squares. No praise words. No exclamation marks.';

/**
 * The explain instruction for the page's class of the try (section 9.2). `best` is the answer's SAN, or "the
 * card's answer" while he is still solving; `basis` says what the class rests on.
 */
function explainTask(verdict: CoachTryVerdict, o: {
  played: string; best: string; reply: string | null; spoilers: boolean; basis: 'numbers' | 'tablebase' | 'check';
  tryResult: CoachTablebaseResult | null; bestResult: CoachTablebaseResult | null;
  /** Brief 9.11.2 (p): the prompt states the page's `tryCheckNote` (only with also-good, close or strong). */
  noted?: boolean;
  /** R5-4: the numbers are the basis and the try's Win% is at least the answer's ("at least as good", never "nearly"). */
  atLeast?: boolean;
  /** R5-5: the prompt states a stored drop for the try ("still a good move" is then never said). */
  drop?: boolean;
}): string {
  const { played: P, best: B, reply, spoilers } = o;
  const noFault = o.drop ? `Do not say that ${P} fails or loses.` : `${P} is still a good move: do not say that it fails or loses.`;
  const then = spoilers ? `explain the idea of ${B} and its line` : `say what the line after ${P} shows, if one is given`;
  const by = o.basis === 'numbers' ? 'By these numbers' : o.basis === 'tablebase' ? 'By the tablebase results' : "By the page's check";
  if (o.noted && NOTE_VERDICTS.includes(verdict)) {
    // 9.11.2 (p): a quick check rated the try close, yet the card asks for another move. The deeper analysis may rate
    // the try well below the answer, so no claim that it is good, as good, or a fault: the note and the lines only.
    const next = spoilers ? `Then compare the two lines: say what ${B} does that ${P} does not.` : `Then say what the line after ${P} shows, if one is given.`;
    return `Say in plain words what the note on ${P} says. ${next} Do not say that ${P} fails or loses, and do not say that it is as good as ${B}.`;
  }
  switch (verdict) {
    case 'also-good': {
      if (o.basis === 'tablebase') {
        const same = o.tryResult !== o.bestResult ? `does at least as well as ${B}`
          : `${o.tryResult === 'win' ? 'also wins' : o.tryResult === 'draw' ? 'also holds the draw' : 'gets the same result'}, like ${B}`;
        return `By the tablebase, ${P} ${same}. Say so, then ${then}. Do not invent a fault in ${P}.`;
      }
      // R5-4 (as 9.9.2 d on the page): a try rated at least as high as the answer is "at least as good".
      return `${by} ${P} is ${o.atLeast ? 'at least' : 'about'} as good as ${B}. Say so, then ${then}. Do not invent a fault in ${P}.`;
    }
    case 'close':
      if (o.atLeast) {
        // R5-4: never "nearly as good" for a try the numbers rate at least as high as the answer.
        return `${by} ${P} is at least as good as ${B}. ${spoilers ? `Compare the two lines: say how ${P} and ${B} differ.` : `Say what the line after ${P} shows, if one is given.`} Do not say that ${P} fails or loses.`;
      }
      return `${by} ${P} is nearly as good as ${B}. ${spoilers ? `Compare the two lines: say what ${B} does that ${P} does not.` : `Say what the line after ${P} shows, if one is given.`} Do not say that ${P} fails or loses.`;
    case 'strong': {
      // Section 8.10: a strong try is a good idea with a stronger move beside it, never a fault (Codex F2: 70/95).
      const compare = spoilers ? `Compare the two lines: say what ${B} gains over ${P}.` : `Say what the line after ${P} shows, if one is given.`;
      // A drill try with the answer's own tablebase result (`gradeTry`: a slower mate) keeps the goal but is not the drill's move.
      if (o.tryResult && o.tryResult === o.bestResult) {
        const same = o.tryResult === 'win' ? 'also wins' : o.tryResult === 'draw' ? 'also holds the draw' : 'gets the same result';
        return `By the tablebase, ${P} ${same}, like ${B}, but this card asks for ${B}. ${compare} ${noFault}`;
      }
      // R5-5: beside a stored drop the try is not called "still a good move".
      return `${by} ${P} keeps a good game, but ${B} is stronger. ${compare} ${noFault}`;
    }
    case 'worse':
    case 'losing': {
      const wrong = reply ? `say what goes wrong after ${P}, naming the reply ${reply}` : `say what goes wrong after ${P}, if these lines show it`;
      return spoilers ? `First ${wrong}. Then explain the idea of ${B} and its line.` : `${capital(wrong)}.`;
    }
    default:
      // `unchecked`: no finished analysis, so no failure claim (section 8.4).
      return spoilers
        ? `Say how ${P} and ${B} differ, using only these lines. Do not claim that ${P} fails or loses.`
        : `Say what the line after ${P} shows, if one is given. Do not claim that ${P} fails or loses.`;
  }
}

/**
 * "Why does my move fail?" (modelTier default). Every fact comes from the input; see the file header for the
 * order. The try's line is `tryLineSan` (M3, the whole line) or, for an M2 input, the try followed by the stored
 * reply `refutationSan`; never both.
 */
export function buildExplainPrompt(input: CoachExplainInput): BuiltPrompt {
  const side = colorName(input.side);
  const played = clean(input.playedSan, 12), best = clean(input.bestSan, 12);
  const spoilers = input.spoilersAllowed !== false;
  const themes = (Array.isArray(input.themes) ? input.themes : []).slice(0, MAX_THEMES).map(t => clean(t, 40));
  const answer = shownLine(input.fen, input.bestLineSan);
  // While he is still solving (section 8.2) nothing in the data names the answer: its moves are kept out.
  const hide = spoilers ? null : new Set([best, ...answer.sans].filter(Boolean).map(normalizeSan));
  const label = answerLabel(input.source, input.answerSource);
  const answerRef = spoilers ? best : "the card's answer";
  const g = new Given();
  context(g, input, hide, stepOf(input.step) ?? 0);
  gameContext(g, input);
  if (spoilers) {
    g.lines.push(`The learner tried ${played}. The card's answer is ${best}.`);
    g.sans.push(played, best);
  } else {
    g.lines.push(`The learner tried ${played}. He is still solving: the card's answer (${label}) is not given here.`);
    g.sans.push(played);
  }
  const step = stepOf(input.step);
  if (step !== null) g.lines.push(step === 0 ? 'This was his first move on the card.' : `This was his move ${Math.floor(step / 2) + 1} on the card, after the first ${step} plies of its line.`);
  if (spoilers) g.line(`Answer line (${label})`, plies(answer.sans, notesOf(input.bestLineNotes), input.side), 'Notes on the answer line', answer.total);

  // Section 9.2 line semantics: `tryLineSan` is the whole line, the try first (a line that starts with another
  // move is left out, never re-read as a reply); the M2 `refutationSan` is the reply alone, so the try goes in front.
  const full = givenSans(input.tryLineSan);
  const reply0 = givenSans(input.refutationSan);
  const stored = !full.length && reply0.length > 0;
  const tryRaw = full.length ? (normalizeSan(full[0]) === normalizeSan(played) ? full : []) : stored ? [played, ...reply0] : [];
  const tryShown = shownLine(input.fen, tryRaw);
  const tryPlies = plies(tryShown.sans, stored ? [] : notesOf(input.tryLineNotes), input.side);
  const reply = tryPlies[1]?.san ?? null;

  // The class decides the instruction. An unknown value is treated as `unchecked` (never the fault wording).
  const tr = resultOf(input.tryResult), br = resultOf(input.bestResult);
  // A tablebase result is never a percentage (Codex F3): on a drill, with a result, or on a tablebase line, every
  // Win% (live or stored) is left out.
  const tablebase = tr !== null || br !== null || input.trySource === 'tablebase' || tablebaseCard(input);
  const wb = tablebase ? null : winOf(input.winBefore), wa = tablebase ? null : winOf(input.winAfter);
  let tw = tablebase ? null : winOf(input.tryWin), bw = tablebase ? null : winOf(input.bestWin);
  let verdict: CoachTryVerdict;
  /** The page itself said `unchecked` (or sent a class this prompt does not know). */
  let pageUnchecked = false;
  if (input.tryVerdict !== undefined) {
    verdict = (COACH_TRY_VERDICTS as readonly unknown[]).includes(input.tryVerdict) ? input.tryVerdict : 'unchecked';
    // Section 9.1: an unfinished check has no numbers; the page's `unchecked` drops any that came along.
    if (verdict === 'unchecked') { pageUnchecked = true; tw = null; bw = null; }
  } else if (tr && br) verdict = verdictFromResults(tr, br);
  else if (tw !== null && bw !== null) verdict = verdictFromWin(tw, bw);
  else if (tr === 'loss') verdict = 'losing';
  // M2: the stored engine reply to his own game move, or the stored drop after it, is an analysis of this move.
  else if ((stored && reply) || (wb !== null && wa !== null && wa < wb)) verdict = 'worse';
  else verdict = 'unchecked';
  // Brief 9.11.2 (p): the page's note replaces the live numbers, only with the page's own also-good, close or strong
  // and never on a drill (no engine there); otherwise the note is ignored.
  const note = textOf(input.tryCheckNote);
  const noted = !!note && !tablebase && input.tryVerdict !== undefined && NOTE_VERDICTS.includes(verdict);
  if (noted) { tw = null; bw = null; }

  // The page's `unchecked` with an engine line means the search stopped short (section 9.1, depth < 10).
  const trySourceLabel = pageUnchecked && input.trySource === 'engine'
    ? 'engine line from a search in this page that did not finish' : own(LINE_LABEL, input.trySource);
  const tryLabel = stored
    ? `Line after the learner's move (stored engine reply line)`
    : `Line after the learner's try${trySourceLabel ? ` (${trySourceLabel})` : ''}`;
  g.line(tryLabel, tryPlies, `Notes on the line after ${played}`, tryShown.total);

  // Stored figures (M2 fields: his game move from this position), the live check (M3: tryWin, bestWin), and the
  // tablebase results (words only).
  if (wb !== null && wa !== null) {
    const d = wb - wa;
    g.lines.push(`Stored winning chances for ${side} as the engine scales them: ${wb}% before ${played} and ${wa}% after it, a ${d >= 0 ? 'drop' : 'rise'} of ${Math.abs(d)} points.`);
    g.numbers.push(wb, wa, Math.abs(d));
  } else if (wb !== null) {
    g.lines.push(`Stored winning chances for ${side} as the engine scales them, in this position: ${wb}%.`);
    g.numbers.push(wb);
  }
  if (noted) g.text(`Note on the learner's try: ${sentence(note)}`, note);
  const scale = `Winning chances for ${side} as the engine scales them${input.trySource === 'engine' ? ', from the search in this page' : ''}`;
  if (tw !== null && bw !== null) {
    g.lines.push(`${scale}: ${bw}% after ${answerRef}, ${tw}% after ${played}, a difference of ${Math.abs(bw - tw)} points.`);
    g.numbers.push(bw, tw, Math.abs(bw - tw));
  } else if (tw !== null) { g.lines.push(`${scale}: ${tw}% after ${played}.`); g.numbers.push(tw); }
  else if (bw !== null) { g.lines.push(`${scale}: ${bw}% after ${answerRef}.`); g.numbers.push(bw); }
  if (tr || br) {
    const parts: string[] = [];
    if (br) parts.push(`after ${answerRef}, ${resultWords(br, input.side)}`);
    if (tr) parts.push(`after ${played}, ${resultWords(tr, input.side)}`);
    g.lines.push(`Tablebase result with best play from both sides: ${parts.join('; ')}.`);
  }
  themesLine(g, themes, step ?? 0);

  // The instruction cites the numbers or the results only when they give the same class as the page's.
  const basis = tr && br && verdictFromResults(tr, br) === verdict ? 'tablebase'
    : tw !== null && bw !== null && verdictFromWin(tw, bw) === verdict ? 'numbers' : 'check';
  const atLeast = basis === 'numbers' && tw !== null && bw !== null && tw >= bw;
  const drop = wb !== null && wa !== null && wa < wb;
  const task = explainTask(verdict, { played, best: answerRef, reply, spoilers, basis, tryResult: tr, bestResult: br, noted, atLeast, drop });
  const prompt = [
    'You are a chess coach for an adult rated about 1000.',
    ...g.lines,
    `Using ONLY these lines, notes and numbers, write at most ${ANSWER_WORDS} words to the learner, addressed as "you". ${task}`,
    'Do not give any evaluation, move or line that is not listed above. If the lines do not show the reason, say so.',
    ...(spoilers ? [] : ['He is still solving this card: do not name or hint at its answer, and do not suggest any move to play.']),
    STYLE,
  ].join('\n');
  return { prompt, modelTier: 'default', sans: g.sans, numbers: g.numbers, fen: input.fen, squares: g.squares };
}

/**
 * A free question after the card is solved or revealed (modelTier default; L6). The answer line, the game
 * context and every move the page checked are given with their notes and numbers (or tablebase results in
 * words); the question is quoted last and is never a source of citable moves.
 */
export function buildAskPrompt(input: CoachAskInput): BuiltPrompt {
  const side = colorName(input.side);
  const g = new Given();
  context(g, input);
  gameContext(g, input);
  const shown = shownLine(input.fen, input.answerLineSan);
  const answerPlies = plies(shown.sans, notesOf(input.answerNotes), input.side);
  g.line(`Answer line (${answerLabel(input.source, input.answerSource)})`, answerPlies, 'Notes on the answer line', shown.total);
  const answer = answerPlies[0]?.san ?? null;
  const ar = resultOf(input.answerResult);
  const drill = tablebaseCard(input);
  const aw = ar || drill ? null : winOf(input.answerWin);
  if (answer && ar) g.lines.push(`Tablebase result with best play from both sides, after ${answer}: ${resultWords(ar, input.side)}.`);
  else if (answer && aw !== null) { g.lines.push(`Winning chances for ${side} as the engine scales them, after ${answer}: ${aw}%.`); g.numbers.push(aw); }
  const asked = (Array.isArray(input.askedLines) ? input.askedLines : []).slice(0, COACH_LIMITS.asked)
    .flatMap(a => { const line = a ? askedLineSans(input.fen, a) : null; return line ? [{ a, line }] : []; });
  if (!asked.length) g.lines.push('The page found no move in the question that it could check.');
  else g.lines.push('Moves from the question that the page checked:');
  for (const { a, line } of asked) {
    const san = line.sans[0];
    // R5-6: a line from a search that stopped short says so, and gets no Win%.
    const unfinished = a.source === 'engine' && a.finished === false;
    const label = unfinished ? UNFINISHED_LINE_LABEL : own(LINE_LABEL, a.source) ?? 'line';
    g.line(`Checked move ${san}. Its line (${label})`, plies(line.sans, notesOf(a.notes), input.side), `Notes on the line after ${san}`, line.total);
    const other = answer !== null && normalizeSan(answer) !== normalizeSan(san);
    const r = resultOf(a.result);
    if (r) {
      g.lines.push(`Tablebase result with best play from both sides: after ${san}, ${resultWords(r, input.side)}${other && ar ? `; after ${answer}, ${resultWords(ar, input.side)}` : ''}.`);
      continue;
    }
    if (a.source === 'tablebase' || drill) continue; // a tablebase line, or any line on a drill, never gets a percentage
    // Brief 9.11.3 (the (p) note for questions): the page's plain note in place of this move's quick-check figures.
    const note = a.source === 'engine' ? textOf(a.checkNote) : '';
    if (note) { g.text(`Note on ${san}: ${sentence(note)}`, note); continue; }
    if (unfinished) continue;
    const w = winOf(a.win);
    if (w === null) continue;
    const scale = `Winning chances for ${side} as the engine scales them`;
    if (other && aw !== null) {
      g.lines.push(`${scale}: ${w}% after ${san}, ${aw}% after ${answer}, a difference of ${Math.abs(aw - w)} points.`);
      g.numbers.push(w, Math.abs(aw - w));
    } else { g.lines.push(`${scale}: ${w}% after ${san}.`); g.numbers.push(w); }
  }
  // R5-1: the card's themes, with a citable mate marker for each `mateInN` (the question is about the card position).
  themesLine(g, (Array.isArray(input.themes) ? input.themes : []).slice(0, MAX_THEMES).map(t => clean(t, 40)).filter(Boolean), 0);
  const question = clean(input.question, COACH_LIMITS.question);
  const prompt = [
    'You are a chess coach for an adult rated about 1000.',
    ...g.lines,
    `The learner's question: “${question}”`,
    `Using ONLY these lines, notes and numbers, answer the question in at most ${ANSWER_WORDS} words, addressed to the learner as "you".`,
    // R5-3: the move itself is not written, so the sentence the page asks for never draws the grounding warning.
    'If the question is about a move that is not in these lines, say that this page did not check that move, without writing the move, and do not judge it.',
    'Do not give any evaluation, move or line that is not listed above. If the lines do not answer the question, say so.',
    STYLE,
  ].join('\n');
  return { prompt, modelTier: 'default', sans: g.sans, numbers: g.numbers, fen: input.fen, squares: g.squares };
}

/** "What should I practise next?" (modelTier quick; M2). Three bullets, each citing one number given. */
export function buildSummaryPrompt(input: CoachSummaryInput): BuiltPrompt {
  const data: string[] = [];
  const session = input.session.slice(0, 15).map(s => `${clean(s.theme, 40)} ${s.correct}/${s.attempts} correct${pct(s.rate) !== null ? ` (${pct(s.rate)}%)` : ''}`);
  const weakest = input.weakest.slice(0, 5).map(w => `${clean(w.theme, 40)} ${pct(w.rate) !== null ? `${pct(w.rate)}%` : 'no rate yet'} over ${w.attempts} attempts`);
  const focus = input.focus.slice(0, 8).map(f => `${clean(f.theme, 40)} (weight ${f.weight}): ${clean(f.reason, 200)}`);
  const lines = [
    `This session, by theme: ${session.length ? session.join('; ') : 'no attempts'}.`,
    `Weakest themes over all practice: ${weakest.length ? weakest.join('; ') : 'none yet'}.`,
    `Current plan focus: ${focus.length ? focus.join('; ') : 'none'}.`,
  ];
  data.push(...lines);
  const prompt = [
    'You are a chess coach for an adult rated about 1000.',
    ...lines,
    'Write exactly three bullets of at most 20 words each on what to practise next. Each bullet must cite one number given above.',
    'Do not use any number, move or evaluation that is not given above.',
  ].join(' ');
  return { prompt, modelTier: 'quick', sans: [], numbers: data.flatMap(numbersIn) };
}

export function buildPrompt(input: CoachInput): BuiltPrompt {
  return input.kind === 'explain' ? buildExplainPrompt(input) : input.kind === 'ask' ? buildAskPrompt(input) : buildSummaryPrompt(input);
}
