/**
 * Board look (version 7.2): which colours the squares use. Green is the default; Blue is the look every earlier
 * version had; Brown is a wood tone. The pieces are the same on every board (`pieceSet.ts`).
 *
 * The choice is a page attribute, `data-board` on the app's own wrapper (`data-theme` on the root already means the
 * light or dark page). The stylesheet holds one block of board tokens per theme (`styles/app.css`, part 4b).
 *
 * Where the choice is kept:
 * - `prefs/ui` in the database, so it follows him to every device. `prefs` is a collection of its own, outside the
 *   contract's list (as `teach` and `selftest` are): a page of an earlier version never reads or writes it, and
 *   `src/contract/docs.ts` stays the frozen version-6 contract. The page writes it only when he changes the board.
 *   Version 7.3 merges the three fields into the document when it exists, so another field kept there survives. A
 *   version 7.2 page replaces the whole document, so while 7.2 pages may still be open, a later preference belongs in
 *   a document of its own (`prefs/<name>`), not in `prefs/ui`.
 * - this browser's own storage (`src/store/boardCache.ts`), so the board has the right colours from the first paint
 *   where the browser keeps storage.
 * Reading is tolerant and never throws: an absent or unreadable document, or a board name this version does not
 * know (a later version may add one), gives the default and no message.
 */
export const BOARD_THEMES = [
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
  { id: 'brown', label: 'Brown' },
] as const;
export type BoardTheme = (typeof BOARD_THEMES)[number]['id'];
export const DEFAULT_BOARD_THEME: BoardTheme = 'green';

export const isBoardTheme = (v: unknown): v is BoardTheme => typeof v === 'string' && BOARD_THEMES.some(t => t.id === v);
/** The board to show for a stored value: the value when this version knows it, otherwise the default. */
export const boardThemeFrom = (v: unknown): BoardTheme => (isBoardTheme(v) ? v : DEFAULT_BOARD_THEME);

/** `prefs/ui`: `{ board, updatedAt, device }`. */
export const UI_PREFS_PATH = 'prefs/ui';
/** The board named by a stored `prefs/ui` body, or null when there is none this version knows. */
export function boardFromPrefs(data: unknown): BoardTheme | null {
  if (!data || typeof data !== 'object') return null;
  const board = (data as { board?: unknown }).board;
  return isBoardTheme(board) ? board : null;
}
/** The body the page writes to `prefs/ui`. */
export function prefsBody(board: BoardTheme, now: number, device: string): { board: BoardTheme; updatedAt: number; device: string } {
  return { board, updatedAt: now, device };
}
/** What identifies one write of `prefs/ui`: its three fields, whatever order the store returns them in. */
export function prefsStamp(data: unknown): string {
  const d = (data && typeof data === 'object' ? data : {}) as { board?: unknown; updatedAt?: unknown; device?: unknown };
  return JSON.stringify([d.board ?? null, d.updatedAt ?? null, d.device ?? null]);
}
