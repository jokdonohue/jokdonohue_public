/**
 * M3 "teach the why": piece values and names, and the Win% scale (A1).
 *
 * Win% follows scalachess `winningChances` exactly as the rest of the app does (`src/analysis/judge.ts`, the
 * engine pass `reviews/claude/tools/engine_pass/common.mjs`): centipawns are ceiled at +/-1000 before the
 * logistic, so the cp scale tops out near 97.5. A forced mate is 100 for the side that mates and 0 for the side
 * that is mated (brief L4). Pure; no chess.js.
 */

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type Side = 'w' | 'b';

/** Material values in pawns. The king has no material value (0): code must special-case it, never compare with it. */
export const PIECE_VALUE: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const PIECE_NAME: Record<PieceType, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

/** scalachess CEILING and MULTIPLIER (same constants as `src/analysis/judge.ts`). */
export const WIN_CP_CEILING = 1000;
export const WIN_MULTIPLIER = 0.00368208;

/** Lichess Win% (0-100) for the side whose centipawn score this is. NaN in, NaN out. */
export function winPctFromCp(cp: number): number {
  if (Number.isNaN(cp)) return Number.NaN;
  const c = Math.max(-WIN_CP_CEILING, Math.min(WIN_CP_CEILING, cp));
  const w = 50 + 50 * (2 / (1 + Math.exp(-WIN_MULTIPLIER * c)) - 1);
  return Math.max(0, Math.min(100, w));
}

/**
 * Win% for `pov` from a score given from `scorePov`'s point of view.
 * Accepts `null` as well as absent fields, so an engine `EngineScore` (`{ cp: number | null; mate: number | null;
 * mated?: 'w' | 'b' }`, White's view) can be passed as it is.
 * - `mated` (a side already checkmated): 0 for that side, 100 for the other.
 * - `mate` n > 0: `scorePov` mates (100 for it); n < 0: `scorePov` is mated (0 for it). `mate: 0` has no sign: without
 *   `mated` it is read as UCI reads it, `scorePov` (the side to move) is mated.
 * - otherwise `cp`, flipped when `pov` differs from `scorePov`.
 * Returns NaN when the score carries neither cp nor mate (callers test `Number.isFinite`).
 */
export function winPctFromScore(
  score: { cp?: number | null; mate?: number | null; mated?: Side },
  pov: Side,
  scorePov: Side,
): number {
  if (score.mated === 'w' || score.mated === 'b') return pov === score.mated ? 0 : 100;
  const mate = score.mate;
  if (mate != null && Number.isFinite(mate)) {
    const scorePovMates = mate > 0;
    return (pov === scorePov) === scorePovMates ? 100 : 0;
  }
  const cp = score.cp;
  if (cp != null && !Number.isNaN(cp)) return winPctFromCp(pov === scorePov ? cp : -cp);
  return Number.NaN;
}
