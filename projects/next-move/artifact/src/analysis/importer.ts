/**
 * The PGN import controller (brief M2, stream PGN; port plan section 5). Pure of React: the component in
 * `components/pgn/PgnImport.tsx` only calls these.
 *
 * Flow: `readGames` (parse and refuse with a plain message) -> `prepareGames` (which side is his, already
 * imported, size pre-check) -> `runImport` (engine pass for every game in memory, then the writes).
 * Write protocol: nothing is written until every game is analysed; a stop before that leaves the database
 * unchanged. Writes go in order `personal/<id>` then `games/<id>` per game, so `games/<id>` marks a finished
 * game: a re-import skips it, and a game interrupted by a failed write is simply redone next time.
 */
import { parsePgn, type ParsedGame } from '@/lib/pgn';
import { identifyPlayerColor } from '@/lib/player';
import { DocTooLargeError, MAX_DOC_BYTES, paths, prepareWrite } from '@/src/contract/docs';
import type { Store } from '@/src/contract/store';
import { analyseGame } from './analyse';
import { buildGameDocs, gameIdOf, positionKey, type GameDocs } from './docs';
import { abortError, isAbort, type AnalysisEngine } from './engine';

/** At most this many games per import (brief). */
export const MAX_GAMES = 10;
/**
 * Search depth for every position. Cautious default: the producer used 14 for its bulk pass and 18 to
 * confirm; 12 keeps a phone run to minutes. Phone timing is NOT measured (no browser was available to this
 * build): the page says "This can take a few minutes on a phone".
 */
export const ANALYSIS_DEPTH = 12;
export const MAX_NAMES = 10, NAME_MAX = 60;

export type Side = 'w' | 'b';
export type ReadResult = { ok: true; games: ParsedGame[] } | { ok: false; message: string };

const KEEP = [/^Game \d+: illegal or invalid move/, /^Only completed games/, /^Only standard chess/, /^PGN exceeds the 2 MB/, /^The PGN contains no moves/, /^A game exceeds the 600/];
/** Parse pasted or uploaded PGN text; any problem becomes one plain sentence. */
export function readGames(text: string): ReadResult {
  if (!text.trim()) return { ok: false, message: 'Paste a game first, or choose a .pgn file.' };
  let games: ParsedGame[];
  try { games = parsePgn(text); } catch (e) {
    const raw = e instanceof Error ? e.message : '';
    if (/^Import at most 20 games/.test(raw)) return { ok: false, message: `That is more than ${MAX_GAMES} games. Paste or choose at most ${MAX_GAMES} at a time.` };
    if (KEEP.some(re => re.test(raw))) return { ok: false, message: `This could not be read: ${raw} Nothing was saved.` };
    return { ok: false, message: 'This does not look like a complete game record (PGN). Copy the whole game, including the result at the end, and try again. Nothing was saved.' };
  }
  if (games.length > MAX_GAMES) return { ok: false, message: `That is ${games.length} games. Paste or choose at most ${MAX_GAMES} at a time.` };
  return { ok: true, games };
}

/** Clean a "my names" list: trimmed, non-empty, at most 60 characters, no duplicates (case-insensitive), at most 10. */
export function cleanNames(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const n = raw.trim().slice(0, NAME_MAX);
    if (n && !out.some(o => o.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out.slice(0, MAX_NAMES);
}
/** Which side he played: exactly one of his names matches exactly one player; otherwise null (ask him). */
export function detectSide(headers: Record<string, string>, names: readonly string[]): Side | null {
  const sides = new Set<Side>();
  for (const n of cleanNames(names)) { const s = identifyPlayerColor(headers, n); if (s) sides.add(s); }
  return sides.size === 1 ? [...sides][0] : null;
}

export interface PreparedGame {
  game: ParsedGame;
  gameId: string;
  /** "White name v Black name, date" for the page. */
  label: string;
  side: Side | null;
  /** `games/<gameId>` already exists: skipped. */
  already: boolean;
  /** Set when the game cannot be saved (too large); skipped. */
  problem?: string;
  /** His moves in the game (the analysis work). */
  hisMoves: (side: Side) => number;
}

function labelOf(g: ParsedGame): string {
  const h = g.headers;
  const date = (h.UTCDate ?? h.Date ?? '').replace(/\./g, '-').replace(/-\?\?/g, '');
  return `${h.White || 'White'} v ${h.Black || 'Black'}${date && !/\?/.test(date) ? `, ${date}` : ''} (${g.result})`;
}

/** Side detection, the already-imported check and a size pre-check (the game record alone, before analysis). */
export async function prepareGames(games: ParsedGame[], names: readonly string[], store: Pick<Store, 'get'>): Promise<PreparedGame[]> {
  const out: PreparedGame[] = [];
  const ids = new Set<string>();
  for (const game of games) {
    const gameId = gameIdOf(game);
    const duplicate = ids.has(gameId);
    ids.add(gameId);
    const already = duplicate || (await store.get(paths.game(gameId))) !== null;
    let problem: string | undefined;
    try { prepareWrite(paths.game(gameId), { pgn: game.pgn, headers: game.headers, importedAt: 0, mistakes: [] }); }
    catch (e) { problem = e instanceof DocTooLargeError ? `too large to save (over ${Math.round(MAX_DOC_BYTES / 1024)} KB)` : 'too large or unusual to save'; }
    out.push({
      game, gameId, label: labelOf(game), side: detectSide(game.headers, names), already, ...(problem ? { problem } : {}),
      hisMoves: side => game.moves.filter(m => m.color === side).length,
    });
  }
  return out;
}

export type ImportPhase = 'analysing' | 'saving';
export interface ImportProgress { phase: ImportPhase; done: number; total: number; game: number; games: number }
export interface ImportSummary {
  games: number;
  positions: number;
  mistakes: number;
  skippedAlready: number;
  skippedProblem: number;
  /** Cards not made because the position is already in his practice. */
  skippedKnown: number;
  cardIds: string[];
}
export class ImportWriteError extends Error {
  constructor(readonly savedGames: number, readonly totalGames: number, readonly cause: unknown) {
    super(`Saved ${savedGames} of ${totalGames} games before the connection failed. Try again: finished games are skipped.`);
    this.name = 'ImportWriteError';
  }
}

/**
 * Analyse the chosen games, then write their documents. `sides` gives his side for games whose side was not
 * detected. Throws an AbortError if `signal` fires before the writes start (nothing written); once writing
 * starts it runs to the end (the page disables Stop while saving).
 */
export async function runImport(input: {
  prepared: PreparedGame[];
  sides?: Record<string, Side>;
  engine: AnalysisEngine;
  store: Pick<Store, 'set' | 'get'>;
  knownCards?: ReadonlyArray<{ id: string; fen: string }>;
  depth?: number;
  signal?: AbortSignal;
  onProgress?: (p: ImportProgress) => void;
  now?: () => number;
  /** Tests only: waits between read-backs of a not-yet-confirmed view. */
  readBackDelaysMs?: readonly number[];
}): Promise<ImportSummary> {
  const readBackDelays = input.readBackDelaysMs ?? READ_BACK_DELAYS_MS;
  const depth = input.depth ?? ANALYSIS_DEPTH;
  const { signal } = input;
  const work = input.prepared.flatMap(p => {
    const side = p.side ?? input.sides?.[p.gameId] ?? null;
    return p.already || p.problem || !side ? [] : [{ p, side }];
  });
  const missingSide = input.prepared.filter(p => !p.already && !p.problem && !(p.side ?? input.sides?.[p.gameId]));
  if (missingSide.length) throw new Error('Choose which side you played in every game first.');
  const total = work.reduce((n, w) => n + w.p.hisMoves(w.side), 0);
  const skip = new Set((input.knownCards ?? []).map(c => positionKey(c.fen)));
  const built: GameDocs[] = [];
  const lateProblems: string[] = [];
  let done = 0;
  try {
    for (const [i, { p, side }] of work.entries()) {
      if (signal?.aborted) throw abortError();
      input.onProgress?.({ phase: 'analysing', done, total, game: i + 1, games: work.length });
      const verdicts = await analyseGame(p.game, side, input.engine, {
        depth, signal, onMove: () => { done++; input.onProgress?.({ phase: 'analysing', done, total, game: i + 1, games: work.length }); },
      });
      const importedAt = (input.now ?? Date.now)();
      // The size pre-check had no engine lines; a game can still be too large with them. Skip that game only.
      try { built.push(buildGameDocs(p.game, side, verdicts, { depth, importedAt, skip })); }
      catch { lateProblems.push(p.label); }
    }
  } finally { input.engine.dispose(); }
  if (signal?.aborted) throw abortError();

  let saved = 0;
  input.onProgress?.({ phase: 'saving', done: 0, total: built.length, game: 0, games: built.length });
  for (const docs of built) {
    try {
      // A game counts as saved only when a fresh read returns what was written (review: nobody has shown
      // that the platform's `set` resolves only after the server has the document). `personal/<id>` is
      // confirmed BEFORE `games/<id>` (the finished marker) is written (review re-check R-1), so a lost
      // personal write never leaves the game marked finished; a retry then rewrites both under the same ids.
      if (docs.personal) {
        await input.store.set(docs.personalPath, docs.personal);
        await confirmStored(input.store, docs.personalPath, docs.personal, readBackDelays);
      }
      await input.store.set(docs.gamePath, docs.game);
      await confirmStored(input.store, docs.gamePath, docs.game, readBackDelays);
    } catch (e) { throw new ImportWriteError(saved, built.length, e); }
    saved++;
    input.onProgress?.({ phase: 'saving', done: saved, total: built.length, game: saved, games: built.length });
  }
  const cardIds = built.flatMap(d => d.cardIds);
  return {
    games: built.length,
    positions: cardIds.length,
    mistakes: built.reduce((n, d) => n + d.game.mistakes.length, 0),
    skippedAlready: input.prepared.filter(p => p.already).length,
    skippedProblem: input.prepared.filter(p => p.problem).length + lateProblems.length,
    skippedKnown: built.reduce((n, d) => n + d.skippedKnown, 0),
    cardIds,
  };
}

/** Same JSON value, key order ignored. */
export function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => Array.isArray(v) ? v.map(norm)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, norm((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
/** Waits between read-backs while the store only offers a cached or pending view (as the session writer does). */
export const READ_BACK_DELAYS_MS = [300, 1000, 3000];
/**
 * True when every top-level field written is present in the read document and deep-equal to it (key order
 * ignored). Extra top-level fields in the read document are ignored: the database may add fields of its own.
 */
export function holdsWritten(read: unknown, written: Record<string, unknown>): boolean {
  if (!read || typeof read !== 'object' || Array.isArray(read)) return false;
  const r = read as Record<string, unknown>;
  return Object.keys(written).every(k => Object.prototype.hasOwnProperty.call(r, k) && sameJson(r[k], written[k]));
}
/**
 * Throws unless a fresh read (not a cached or pending view) of `path` holds every field of `body` (`holdsWritten`).
 * A view that is not yet fresh is read again after each delay; a fresh view missing or changing a written field,
 * or no document, fails at once.
 */
async function confirmStored(store: Pick<Store, 'get'>, path: string, body: Record<string, unknown>, delays: readonly number[]): Promise<void> {
  for (let i = 0; ; i++) {
    const doc = await store.get(path);
    if (!doc) throw new Error(`Read-back of ${path} found nothing.`);
    const fresh = !doc.meta || (!doc.meta.fromCache && !doc.meta.hasPendingWrites);
    if (fresh) {
      if (holdsWritten(doc.data, body)) return;
      throw new Error(`Read-back of ${path} did not match what was written.`);
    }
    if (i >= delays.length) throw new Error(`Read-back of ${path} was never confirmed by the database.`);
    await new Promise(r => setTimeout(r, delays[i]));
  }
}

export { isAbort };
