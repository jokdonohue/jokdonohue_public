/**
 * M3 line viewer state (A1, brief L2): the positions of a UCI line as plain steps, for a step-through board
 * (Start / Back / Next / End and tapping a move). Pure; chess.js only; never throws.
 *
 * steps[0] is the start position (no `uci`); steps[i] is the position after ply i, with that ply's UCI, SAN and
 * narrated sentence. `nextUci` is the move played from that step (the viewer's arrow preview); it is absent on
 * the last step. The replay stops before the first malformed or illegal ply, so every step is a real position
 * and every arrow a legal move. FENs are chess.js's normalized form.
 */
import { Chess } from 'chess.js';
import { narrateLine, playUci, uciOf, type NarratedLine } from './narrate';

export interface LineStep { ply: number; fen: string; uci?: string; san?: string; text?: string; nextUci?: string }

/**
 * Steps for `line` from `startFen`. `narrated` (from `narrateLine` on the same line) supplies the captions;
 * a ply's caption is taken from it only when that ply's UCI and position match, otherwise the line is narrated
 * here. A bad `startFen` gives [].
 */
export function buildSteps(startFen: string, line: readonly string[], narrated?: NarratedLine): LineStep[] {
  let board: Chess;
  try { board = new Chess(startFen); } catch { return []; }
  const moves = Array.isArray(line) ? line : [];
  let own: NarratedLine | null = null;
  const caption = (i: number, uci: string, fenBefore: string): string | undefined => {
    const given = narrated?.plies?.[i];
    if (given && given.uci === uci && given.fenBefore === fenBefore) return given.text;
    own ??= narrateLine(startFen, moves, { maxPlies: moves.length });
    const mine = own.plies[i];
    return mine && mine.uci === uci && mine.fenBefore === fenBefore ? mine.text : undefined;
  };
  const steps: LineStep[] = [{ ply: 0, fen: board.fen() }];
  for (let i = 0; i < moves.length; i++) {
    const fenBefore = board.fen();
    const mv = playUci(board, moves[i]);
    if (!mv) break;
    const uci = uciOf(mv);
    steps[i].nextUci = uci;
    const text = caption(i, uci, fenBefore);
    steps.push({ ply: i + 1, fen: board.fen(), uci, san: mv.san, ...(text ? { text } : {}) });
  }
  return steps;
}

/** A step index made safe for `steps`: whole number in [0, steps.length - 1]; NaN and an empty list give 0. */
export function clampStep(i: number, steps: readonly LineStep[]): number {
  const last = steps.length - 1;
  if (last <= 0 || Number.isNaN(i)) return 0;
  return Math.max(0, Math.min(last, Math.trunc(i)));
}
