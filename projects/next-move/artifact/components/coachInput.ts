/**
 * Inputs for the "Why does my move fail?" coach and the static panel shown without any model call
 * (port plan section 4). Only stored lines and numbers are used; nothing here evaluates a position.
 */
import { Chess } from 'chess.js';
import type { AttemptSource } from '@/src/contract/docs';
import type { CoachExplainInput } from '@/src/contract/coach';

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

/** The card fields the coach can use. `pack` is the pack detail block, when the card came from his games. */
export interface CoachCard {
  id: string;
  fen: string;
  moves: string[];
  themes: string[];
  pack?: { playedUci?: string; pvUci?: string[]; refutationPvUci?: string[]; winBefore?: unknown; winAfter?: unknown; cpBefore?: unknown; cpAfter?: unknown };
  refutationPvUci?: string[];
}
/** A wrong move the learner played: the position it was played from and the move. */
export interface WrongMove { fen: string; uci: string; index: number }

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);

/**
 * Build the explain input. The stored refutation and evaluation describe the move he played in the game,
 * so they are passed only when today's wrong move is that same move from the card's own position;
 * otherwise the input has the solution line and themes only.
 */
export function explainInput(card: CoachCard, wrong: WrongMove, source: AttemptSource): CoachExplainInput | null {
  let board: Chess;
  try { board = new Chess(wrong.fen); } catch { return null; }
  const side = board.turn();
  let playedSan: string;
  try { playedSan = move(new Chess(wrong.fen), wrong.uci).san; } catch { return null; }
  const rest = card.moves.slice(wrong.index);
  const bestUci = rest[0];
  if (!bestUci) return null;
  const bestLineSan = sanLine(wrong.fen, rest);
  if (!bestLineSan.length) return null;
  const sameAsGame = wrong.index === 0 && wrong.fen === card.fen && card.pack?.playedUci === wrong.uci;
  const refutation = sameAsGame ? card.pack?.refutationPvUci ?? [] : [];
  const input: CoachExplainInput = {
    kind: 'explain', itemId: card.id, source, fen: wrong.fen, side, playedUci: wrong.uci, playedSan, bestUci, bestSan: bestLineSan[0],
    bestLineSan, refutationSan: refutation.length ? sanLine(new Chess(wrong.fen).fen(), [wrong.uci, ...refutation]).slice(1) : [], themes: card.themes,
  };
  if (sameAsGame) {
    const winBefore = num(card.pack?.winBefore), winAfter = num(card.pack?.winAfter);
    if (winBefore !== undefined && winAfter !== undefined) { input.winBefore = winBefore; input.winAfter = winAfter; }
    const cpBefore = num(card.pack?.cpBefore), cpAfter = num(card.pack?.cpAfter);
    if (cpBefore !== undefined) input.cpBefore = cpBefore;
    if (cpAfter !== undefined) input.cpAfter = cpAfter;
  }
  return input;
}

/** What the static panel shows: always available, no model involved. */
export interface StaticExplanation { playedSan: string; bestLineSan: string[]; refutationSan: string[]; numbers: string | null }
export function staticExplanation(input: CoachExplainInput): StaticExplanation {
  const parts: string[] = [];
  if (input.winBefore !== undefined && input.winAfter !== undefined) parts.push(`Stored win chance for you: ${Math.round(input.winBefore)}% before, ${Math.round(input.winAfter)}% after.`);
  return { playedSan: input.playedSan, bestLineSan: input.bestLineSan, refutationSan: input.refutationSan, numbers: parts.length ? parts.join(' ') : null };
}
