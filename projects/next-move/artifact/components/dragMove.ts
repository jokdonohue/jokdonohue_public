/**
 * Drag to move (lead decision D11): pure helpers for `Chessboard`. A press becomes a drag after 6 px of travel;
 * a drop on a legal square plays the move (or asks for the promotion piece, as a tap does); anywhere else cancels.
 */
import { Chess, type Square } from 'chess.js';

export const DRAG_THRESHOLD_PX = 6;
/** A click this soon after a drop is the browser's own echo of the drag (fix pass P2-7a). */
export const CLICK_AFTER_DRAG_MS = 500;
/**
 * Whether a click is the echo of a drag that just ended and must be ignored. Only pointer clicks (`detail` > 0)
 * within 500 ms of the drop qualify; a keyboard Enter or Space (`detail` 0) is never swallowed, and a guard left
 * over from a drag with no click after it expires by itself.
 */
export function swallowClick(dragEndedAt: number | null, now: number, detail: number): boolean {
  return dragEndedAt !== null && detail > 0 && now >= dragEndedAt && now - dragEndedAt < CLICK_AFTER_DRAG_MS;
}
export const isDrag = (dx: number, dy: number) => Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;

/** The square under a point given relative to the board's top-left corner; null outside the board. */
export function squareAt(x: number, y: number, size: number, orientation: 'w' | 'b'): Square | null {
  if (!(size > 0) || x < 0 || y < 0 || x >= size || y >= size) return null;
  const col = Math.floor((x / size) * 8), row = Math.floor((y / size) * 8);
  const file = orientation === 'w' ? col : 7 - col;
  const rank = orientation === 'w' ? 8 - row : row + 1;
  return `${'abcdefgh'[file]}${rank}` as Square;
}

/** Whether a press on `square` may start a drag: one of the side to move's pieces. */
export function canDragFrom(fen: string, square: Square): boolean {
  try { const b = new Chess(fen); const p = b.get(square); return !!p && p.color === b.turn(); } catch { return false; }
}

export type DropResult = { kind: 'move'; uci: string } | { kind: 'promote'; from: Square; to: Square } | { kind: 'cancel' };
/** What a drop does: a legal target plays (or asks for promotion); the start square, an illegal square or off the board cancels. */
export function resolveDrop(fen: string, from: Square, to: Square | null): DropResult {
  if (!to || to === from || !canDragFrom(fen, from)) return { kind: 'cancel' };
  let moves;
  try { moves = new Chess(fen).moves({ square: from, verbose: true }).filter(m => m.to === to); } catch { return { kind: 'cancel' }; }
  if (!moves.length) return { kind: 'cancel' };
  if (moves.some(m => m.promotion)) return { kind: 'promote', from, to };
  return { kind: 'move', uci: `${from}${to}` };
}
