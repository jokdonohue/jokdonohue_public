/**
 * The board look this browser last showed (version 7.2), kept beside the device id in localStorage so the board has
 * the right colours from the first paint. A cache only: the choice itself lives in the database (`prefs/ui`,
 * `components/boardTheme.ts`). Never throws: blocked or missing storage, or a name this version does not know, reads
 * as "nothing cached".
 */
import { isBoardTheme, type BoardTheme } from '@/components/boardTheme';
import { safeLocalStorage } from './device';

export const BOARD_CACHE_KEY = 'nextmove.board';
type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export function cachedBoardTheme(storage: StorageLike | null = safeLocalStorage()): BoardTheme | null {
  try { const v = storage?.getItem(BOARD_CACHE_KEY); return isBoardTheme(v) ? v : null; } catch { return null; }
}
export function cacheBoardTheme(board: BoardTheme, storage: StorageLike | null = safeLocalStorage()): void {
  try { storage?.setItem(BOARD_CACHE_KEY, board); } catch { /* storage blocked: the choice still holds for this page load */ }
}
