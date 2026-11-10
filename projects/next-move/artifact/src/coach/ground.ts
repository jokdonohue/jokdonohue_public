/**
 * Grounding check for coach answers (port plan section 4, build rule 4): every move and every evaluation
 * figure in the answer must come from the prompt's inputs. A miss makes the page show "Check this on the
 * board: part of this answer is not from the engine line" and stores `grounded:false`.
 *
 * Rules (judgement calls, kept strict because the warning is cheap and a confident invented line is not):
 * - Moves: every SAN token with a piece letter, a capture, a promotion or castling must equal (ignoring
 *   + # ! ? and "=") one of the given SAN moves. A move that is legal but not in the given lines is flagged
 *   (stricter than the plan text, which also allowed any legal move: build rule 4 asks for "not in the input").
 * - Bare squares ("the knight on f3", "then h4"): a pawn move and a square name look the same, so a bare
 *   square passes only when it is a given SAN move, a square named in a given move, or occupied at the FEN.
 *   An invented quiet pawn move ("then h4 wins") is flagged; "the pawn on f7" in the position is not.
 * - Numbers, explain answers: figures with a unit (%, percent, points, cp, centipawns, pawns), any decimal
 *   (3.1, +1.5) and "mate in N" must equal a number rendered in the prompt's data (mate distances never are).
 *   Small counts such as "two pieces" or "3 moves" are prose.
 * - Numbers, summary answers: every number must be one given (list markers "1." at a line start excepted).
 */
import type { BuiltPrompt } from './prompts';

const SAN_RE = /(?<![A-Za-z0-9])(O-O-O|O-O|0-0-0|0-0|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=?[QRBN])?|[a-h]x[a-h][1-8](?:=?[QRBN])?|[a-h][18]=?[QRBN])[+#]?[!?]*(?![A-Za-z0-9])/g;
const UNIT_RE = /([+\-−]?\d+(?:\.\d+)?)\s*(%|percent\b|per cent\b|percentage points?\b|points?\b|cp\b|centipawns?\b|pawns?\b)/gi;
const DEC_RE = /(?<![\w.])([+\-−]?\d+\.\d+)(?!\w|\.\d)/g;
const MATE_RE = /\bmate\s+in\s+(\d+)\b/gi;
const SQUARE_RE = /(?<![A-Za-z0-9])([a-h][1-8])(?![A-Za-z0-9])/g;
const ANY_NUM_RE = /(?<![\w.])(\d+(?:\.\d+)?)(?!\w|\.\d)/g;

export const normalizeSan = (san: string) => san.replace(/[+#!?=]/g, '').replace(/0/g, 'O').trim();

export interface GroundResult { grounded: boolean; misses: string[] }

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

export function groundCheck(text: string, built: Pick<BuiltPrompt, 'sans' | 'numbers'> & { fen?: string }, kind: 'explain' | 'summary'): GroundResult {
  const misses: string[] = [];
  const sans = new Set(built.sans.map(normalizeSan));
  for (const m of text.matchAll(SAN_RE)) {
    if (!sans.has(normalizeSan(m[1]))) misses.push(m[0]);
  }
  const allowedSquares = new Set<string>([...built.sans.flatMap(s => s.match(/[a-h][1-8]/g) ?? []), ...(built.fen ? occupiedSquares(built.fen) : [])]);
  for (const m of text.replace(SAN_RE, ' ').matchAll(SQUARE_RE)) if (!allowedSquares.has(m[1])) misses.push(m[1]);
  const allowed = built.numbers;
  const ok = (raw: string) => {
    const x = Math.abs(Number(raw.replace('−', '-')));
    return Number.isFinite(x) && allowed.some(a => Math.abs(Math.abs(a) - x) < 1e-9);
  };
  if (kind === 'explain') {
    for (const m of text.matchAll(UNIT_RE)) if (!ok(m[1])) misses.push(m[0].trim());
    for (const m of text.replace(UNIT_RE, ' ').matchAll(DEC_RE)) if (!ok(m[1])) misses.push(m[1]);
    for (const m of text.matchAll(MATE_RE)) if (!ok(m[1])) misses.push(m[0]);
  } else {
    const body = text.replace(/^\s*(?:[-*•]\s*)?\d+[.)]\s/gm, '');
    for (const m of body.matchAll(ANY_NUM_RE)) if (!ok(m[1])) misses.push(m[1]);
  }
  const unique = [...new Set(misses)].slice(0, 20).map(s => s.slice(0, 40));
  return { grounded: unique.length === 0, misses: unique };
}
