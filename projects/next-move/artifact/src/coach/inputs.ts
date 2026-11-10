/**
 * Build CoachExplainInput from what the page already holds, and the static panel shown with no model
 * (capability absent, consent not given, limits reached). Pure; chess.js only.
 *
 * Grounding rule enforced here, which token checks cannot catch: the stored refutation line and the
 * "after" evaluation belong to the move he played IN THE GAME. When the drill's wrong move is a different
 * move, both are left out, so the prompt never presents them as the answer to his drill move.
 */
import { Chess } from 'chess.js';
import type { AttemptSource } from '../contract/docs';
import type { CoachExplainInput } from '../contract/coach';

const playUci = (board: Chess, uci: string) => board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
/** SAN for a UCI line from `fen`, stopping before the first illegal move. */
export function sanMoves(fen: string, line: readonly string[]): string[] {
  const out: string[] = [];
  let board: Chess;
  try { board = new Chess(fen); } catch { return out; }
  for (const step of line) { try { out.push(playUci(board, step).san); } catch { break; } }
  return out;
}
function fenAfter(fen: string, uci: string): string | null {
  try { const b = new Chess(fen); playUci(b, uci); return b.fen(); } catch { return null; }
}
const turnOf = (fen: string): 'w' | 'b' | null => { try { return new Chess(fen).turn(); } catch { return null; } };
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The card fields this module reads (a db pack card: `packCardDoc` plus its passthrough `pack` detail). */
export interface PackCardLike {
  id: string; fen: string; moves: string[]; themes: string[]; kind?: string;
  pack?: {
    playedUci?: string; pvUci?: string[]; refutationPvUci?: string[];
    winBefore?: number; winAfter?: number; cpBefore?: number | null; cpAfter?: number | null;
  } & Record<string, unknown>;
}

/**
 * "Why does my move fail?" for a pack card (mistake, conversion, stalemate or punish kinds).
 * Returns null when the move is illegal at the card's position or equals the answer.
 * - Mistake cards: best line = the stored engine line; when `playedUci` is the game move, the stored
 *   refutation and both evaluations are passed; otherwise only the "before" evaluation.
 * - Punish cards: the solver is his opponent and the stored evaluations are from his own point of view,
 *   so no evaluation is passed; best line = the stored refutation.
 */
export function explainInputFromPackCard(card: PackCardLike, playedUci: string, source: AttemptSource = 'pack'): CoachExplainInput | null {
  const side = turnOf(card.fen);
  const bestUci = card.moves[0];
  if (!side || !bestUci || playedUci === bestUci) return null;
  const playedSan = sanMoves(card.fen, [playedUci])[0];
  if (!playedSan) return null;
  const detail = card.pack ?? {};
  let line = Array.isArray(detail.pvUci) && detail.pvUci[0] === bestUci ? detail.pvUci : [bestUci];
  const bestLineSan = sanMoves(card.fen, line);
  if (!bestLineSan.length) return null;
  line = line.slice(0, bestLineSan.length);
  const base: CoachExplainInput = {
    kind: 'explain', itemId: card.id, source, fen: card.fen, side, playedUci, playedSan,
    bestUci, bestSan: bestLineSan[0], bestLineSan, refutationSan: [], themes: card.themes.filter(t => t !== 'personal').slice(0, 10),
  };
  if (!base.themes.length) base.themes = card.themes.slice(0, 1);
  if (card.kind === 'punish') return base;
  const sameAsGame = detail.playedUci === playedUci;
  const winBefore = finite(detail.winBefore);
  if (winBefore !== undefined) base.winBefore = winBefore;
  if (finite(detail.cpBefore) !== undefined) base.cpBefore = detail.cpBefore as number;
  if (sameAsGame) {
    const after = fenAfter(card.fen, playedUci);
    if (after && Array.isArray(detail.refutationPvUci)) base.refutationSan = sanMoves(after, detail.refutationPvUci);
    const winAfter = finite(detail.winAfter);
    if (winAfter !== undefined) base.winAfter = winAfter;
    if (finite(detail.cpAfter) !== undefined) base.cpAfter = detail.cpAfter as number;
  }
  return base;
}

/**
 * For a bank puzzle, an endgame drill or an agent drill card at solution step `index`: `fenAtIndex` is the
 * board where he moved and the best line is the rest of the stored solution from there. No evaluation.
 */
export function explainInputFromPuzzle(
  puzzle: { id: string; moves: string[]; themes: string[] },
  index: number, fenAtIndex: string, playedUci: string, source: AttemptSource = 'bank',
): CoachExplainInput | null {
  const side = turnOf(fenAtIndex);
  const rest = puzzle.moves.slice(index);
  if (!side || !rest.length || rest[0] === playedUci) return null;
  const playedSan = sanMoves(fenAtIndex, [playedUci])[0];
  const bestLineSan = sanMoves(fenAtIndex, rest);
  if (!playedSan || !bestLineSan.length) return null;
  return {
    kind: 'explain', itemId: puzzle.id, source, fen: fenAtIndex, side, playedUci, playedSan,
    bestUci: rest[0], bestSan: bestLineSan[0], bestLineSan, refutationSan: [], themes: puzzle.themes.slice(0, 10),
  };
}

export interface StaticPanel {
  /** Label / text rows, in display order. Always available, with no model involved. */
  rows: Array<{ label: string; text: string }>;
}
/**
 * The static panel (plan section 4 "always shown"): the stored lines in SAN and the stored numbers,
 * labelled as the engine's. "Engine-scaled" follows the producer README (Win% is not a real-game chance).
 */
export function staticPanel(input: CoachExplainInput): StaticPanel {
  const rows: StaticPanel['rows'] = [
    { label: 'Your move', text: input.playedSan },
    { label: 'Engine best line', text: input.bestLineSan.join(' ') },
  ];
  if (input.refutationSan.length) rows.push({ label: `Engine reply to ${input.playedSan}`, text: input.refutationSan.join(' ') });
  const wb = finite(input.winBefore), wa = finite(input.winAfter);
  if (wb !== undefined && wa !== undefined) rows.push({ label: 'Engine-scaled winning chances', text: `${Math.round(wb)}% before your move, ${Math.round(wa)}% after` });
  else if (wb !== undefined) rows.push({ label: 'Engine-scaled winning chances', text: `${Math.round(wb)}% before the move` });
  return { rows };
}
export const staticPanelText = (input: CoachExplainInput) => staticPanel(input).rows.map(r => `${r.label}: ${r.text}`).join('\n');
