/**
 * Grounding check for coach answers (port plan section 4, build rule 4): every move and every evaluation
 * figure in the answer must come from the prompt's inputs. A miss makes the page show "Check this on the
 * board: part of this answer is not from the engine line" and stores `grounded:false`.
 *
 * Rules (judgement calls, kept strict because the warning is cheap and a confident invented line is not):
 * - Moves: every SAN token with a piece letter, a capture, a promotion or castling must equal (ignoring
 *   + # ! ? and "=") one of the given SAN moves. A move that is legal but not in the given lines is flagged
 *   (stricter than the plan text, which also allowed any legal move: build rule 4 asks for "not in the input").
 *   M3: "given" covers every line in the prompt (answer, try, better, asked) and the SAN-like tokens of the
 *   page's own computed texts (notes, title, framing, goal, lesson, the piece list "Ke1, Qd1"), never the
 *   learner's question.
 * - Tablebase results (section 9.2) are words ("White wins", "the game is a draw"): words are never flagged,
 *   and a tablebase prompt renders no percentage, so a "50%" for a draw is flagged.
 * - Bare squares ("the knight on f3", "then h4"): a pawn move and a square name look the same, so a bare
 *   square passes only when it is a given SAN move, a square named in a given move or in a computed text, or
 *   occupied at the FEN. An invented quiet pawn move ("then h4 wins") is flagged; "the pawn on f7" is not.
 * - Numbers, explain and ask answers: figures with a unit (%, percent, points, cp, centipawns, pawns), any
 *   decimal (3.1, +1.5) and "mate in N" must equal a number rendered in the prompt's data (mate distances
 *   never are). Small counts such as "two pieces" or "3 moves" are prose. A digit that is part of a square
 *   ("the d3 pawn", "the bishop on b2 points at g7") is not a figure (M3 fix: it used to be read as "3 pawn").
 * - Mate in words (brief 9.10 l): a digit "mate in 1" in an answer is also grounded when one of the page's computed
 *   texts says "mate in one" (likewise two to ten), as the narrator's notes do. Only that phrase: the word never
 *   becomes a citable number, so "1%" or "1 pawn" stays a miss. The reverse needs nothing: an answer's "mate in one"
 *   in words is never read as a figure, so a note's "mate in 1" (whose 1 is a given number) or no note at all
 *   leaves it grounded.
 * - Numbers, summary answers: every number must be one given (list markers "1." at a line start excepted).
 *
 * Fix round 2 (brief 9.11.3, R5-1 and R5-2):
 * - A figure with a hyphen before its unit ("a 40-point drop") is checked like "40 points", and so is any whole number
 *   with a sign ("+4 for Black"). "1-0", "0-0" and "2-3" never count as signed: a sign right after a letter or digit
 *   is not one.
 * - The prompt takes citable numbers only from its figure sentences (Win%, drop, difference). `givenInText(text,
 *   { numbers: false })` gives a computed text's moves, squares and mate markers without its numbers (the title's
 *   "move 30", the date, a rating), and a "mate in 2" written with a digit in a computed text gives the marker too.
 */
import type { BuiltPrompt } from './prompts';

const SAN_RE = /(?<![A-Za-z0-9])(O-O-O|O-O|0-0-0|0-0|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=?[QRBN])?|[a-h]x[a-h][1-8](?:=?[QRBN])?|[a-h][18]=?[QRBN])[+#]?[!?]*(?![A-Za-z0-9])/g;
const UNIT_RE = /(?<![\w.])([+\-−]?\d+(?:\.\d+)?)\s*[-‐‑–]?\s*(%|percent\b|per cent\b|percentage points?\b|points?\b|cp\b|centipawns?\b|pawns?\b)/gi;
const DEC_RE = /(?<![\w.])([+\-−]?\d+\.\d+)(?!\w|\.\d)/g;
/** A whole number written with a sign ("+4", "-3", "−2"); a sign right after a letter or a digit is not one. */
const SIGNED_RE = /(?<![\w.+\-−])([+\-−]\d+)(?!\w|\.\d)/g;
const MATE_RE = /\bmate\s+in\s+(\d+)\b/gi;
const SQUARE_RE = /(?<![A-Za-z0-9])([a-h][1-8])(?![A-Za-z0-9])/g;
const ANY_NUM_RE = /(?<![\w.])(\d+(?:\.\d+)?)(?!\w|\.\d)/g;
const MATE_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'] as const;
const MATE_WORD_RE = new RegExp(`\\bmate\\s+in\\s+(${MATE_WORDS.join('|')})\\b`, 'gi');

export const normalizeSan = (san: string) => san.replace(/[+#!?=]/g, '').replace(/0/g, 'O').trim();
/**
 * The marker a computed text's "mate in one" (one to ten, in words) adds to its citable `squares`: "mate in 1".
 * `squares` entries are only ever compared whole, and no bare square, SAN token or figure can equal this one, so it
 * grounds an answer's digit "mate in 1" and nothing else. It rides in `squares` because the prompt builder passes on
 * exactly the `sans`, `squares` and `numbers` that `givenInText` returns.
 */
export const mateMarker = (n: number) => `mate in ${n}`;

export interface GroundResult { grounded: boolean; misses: string[] }
export type GroundKind = 'explain' | 'summary' | 'ask';

/** Occupied squares from a FEN's placement field (no chess.js needed). */
export function occupiedSquares(fen: string): Set<string> {
  const out = new Set<string>();
  const ranks = (fen.trim().split(/\s+/)[0] ?? '').split('/');
  ranks.forEach((row, i) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) file += Number(ch);
      else { if (file < 8 && i < 8) out.add(`${'abcdefgh'[file]}${8 - i}`); file++; }
    }
  });
  return out;
}

/** Options for `givenInText`. */
export interface GivenTextOptions {
  /**
   * Brief 9.11.3 (R5-2): which standalone numbers of the text become citable. `all` (the default, as before), `percent`
   * (only figures written with "%", such as a lesson's "about 85% to win") or `none` (a title's "move 30", a date, a
   * rating: never a figure an answer may cite).
   */
  numbers?: 'all' | 'percent' | 'none';
  /**
   * Whether the text's "mate in N" (words or digit) becomes a citable mate marker. Default true. False for texts that
   * name the card rather than state a fact about the position (a title or framing such as "Mate in three" stays true
   * of the drill's start only).
   */
  mates?: boolean;
}
const PERCENT_RE = /(?<![\w.])(\d+(?:\.\d+)?)\s*%/g;

/**
 * What one of the page's own computed texts (a narrated note, the framing, the lesson, the piece list) lets an
 * answer cite: its SAN-like tokens, its bare squares and its standalone numbers (a square's digit is not a
 * number; `opts.numbers` narrows them), plus a `mateMarker` for each "mate in one" .. "mate in ten" it says in words
 * and each "mate in N" it writes with a digit (in `squares`, after the squares). Never call this on the learner's own
 * words.
 */
export function givenInText(text: string, opts: GivenTextOptions = {}): { sans: string[]; squares: string[]; numbers: number[] } {
  const sans = [...text.matchAll(SAN_RE)].map(m => m[1]);
  const rest = text.replace(SAN_RE, ' ');
  const mates = opts.mates === false ? [] : [
    ...[...text.matchAll(MATE_WORD_RE)].map(m => mateMarker(MATE_WORDS.indexOf(m[1].toLowerCase() as typeof MATE_WORDS[number]) + 1)),
    ...[...text.matchAll(MATE_RE)].map(m => Number(m[1])).filter(x => Number.isInteger(x) && x > 0).map(mateMarker),
  ];
  const which = opts.numbers ?? 'all';
  const numbers = which === 'none' ? [] : [...rest.matchAll(which === 'percent' ? PERCENT_RE : ANY_NUM_RE)].map(m => Number(m[1])).filter(Number.isFinite);
  return { sans, squares: [...[...rest.matchAll(SQUARE_RE)].map(m => m[1]), ...mates], numbers };
}

export function groundCheck(text: string, built: Pick<BuiltPrompt, 'sans' | 'numbers'> & { fen?: string; squares?: string[] }, kind: GroundKind): GroundResult {
  const misses: string[] = [];
  const sans = new Set(built.sans.map(normalizeSan));
  for (const m of text.matchAll(SAN_RE)) {
    if (!sans.has(normalizeSan(m[1]))) misses.push(m[0]);
  }
  const allowedSquares = new Set<string>([
    ...built.sans.flatMap(s => s.match(/[a-h][1-8]/g) ?? []),
    ...(built.squares ?? []),
    ...(built.fen ? occupiedSquares(built.fen) : []),
  ]);
  for (const m of text.replace(SAN_RE, ' ').matchAll(SQUARE_RE)) if (!allowedSquares.has(m[1])) misses.push(m[1]);
  const allowed = built.numbers;
  const ok = (raw: string) => {
    const x = Math.abs(Number(raw.replace('−', '-')));
    return Number.isFinite(x) && allowed.some(a => Math.abs(Math.abs(a) - x) < 1e-9);
  };
  if (kind !== 'summary') {
    for (const m of text.matchAll(UNIT_RE)) if (!ok(m[1])) misses.push(m[0].trim());
    for (const m of text.replace(UNIT_RE, ' ').matchAll(DEC_RE)) if (!ok(m[1])) misses.push(m[1]);
    // R5-2: a whole number with a sign ("+4 for Black") is an evaluation figure too.
    for (const m of text.replace(UNIT_RE, ' ').replace(DEC_RE, ' ').matchAll(SIGNED_RE)) if (!ok(m[1])) misses.push(m[1]);
    // A digit mate distance: a given number, or a computed text that said the same distance in words (9.10 l).
    const matesInWords = new Set(built.squares ?? []);
    for (const m of text.matchAll(MATE_RE)) if (!ok(m[1]) && !matesInWords.has(mateMarker(Number(m[1])))) misses.push(m[0]);
  } else {
    const body = text.replace(/^\s*(?:[-*•]\s*)?\d+[.)]\s/gm, '');
    for (const m of body.matchAll(ANY_NUM_RE)) if (!ok(m[1])) misses.push(m[1]);
  }
  const unique = [...new Set(misses)].slice(0, 20).map(s => s.slice(0, 40));
  return { grounded: unique.length === 0, misses: unique };
}
