import { Chess, type PieceSymbol } from 'chess.js';

const ENDING_THEMES: Partial<Record<PieceSymbol, string>> = { p: 'pawnEndgame', r: 'rookEndgame', q: 'queenEndgame', b: 'bishopEndgame', n: 'knightEndgame' };

/**
 * Phase and ending-type themes for a position, using the Lichess theme vocabulary.
 * Endgame follows the Lichess divider's rule: six or fewer queens, rooks, bishops and
 * knights in total, kings and pawns not counted (spec §6.3). Before that, `ply <= 20`
 * is the app's labelled opening fallback. An ending-type theme is added when only one
 * kind of piece remains besides kings and pawns (or only pawns), as Lichess tags them.
 */
export function positionThemes(fen: string, ply: number): string[] {
  const pieces = new Chess(fen).board().flat().filter(square => square !== null && square.type !== 'k');
  const officers = pieces.filter(square => square!.type !== 'p');
  if (officers.length > 6) return [ply <= 20 ? 'opening' : 'middlegame'];
  const kinds = new Set(officers.map(square => square!.type));
  const only = kinds.size === 1 ? [...kinds][0] : kinds.size === 0 && pieces.length ? 'p' : undefined;
  const ending = only ? ENDING_THEMES[only] : undefined;
  return ending ? ['endgame', ending] : ['endgame'];
}
