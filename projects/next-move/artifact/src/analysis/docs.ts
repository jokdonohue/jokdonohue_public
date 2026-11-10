/**
 * `games/<gameId>` and `personal/<gameId>` documents from an analysed game, valid under the version-4
 * schemas unchanged (`src/contract/docs.ts`), and the card id rule.
 *
 * Card ids (so a later Claude refresh supersedes the page's cards without losing history):
 * - a chess.com game (its `Link` or `Site` header names `chess.com/game/<live|daily>/<digits>`) gets the
 *   producer's id `pack-<digits>:<ply>`, where `<digits>` is the last segment of the game URL
 *   (`reviews/claude/tools/engine_pass/sample.mjs`) and `<ply>` the 1-based half-move of his move
 *   (`finalize.mjs`, `ply: i + 1`; `lib/pgn.ts` counts the same way). A refresh that issues the same id for
 *   the same position keeps his attempt history, which is keyed by card id;
 * - the producer's id is the OLDEST row reaching a position (`src/importers/packDocs.ts`), so the ids match
 *   only for a position first reached in this game. The page therefore skips a position that is already a card
 *   (same first four FEN fields), so the same position is never practised under two ids;
 * - any other game gets `page-<gameId>:<ply>` (`<gameId>` = `lib/pgn.ts` `game-<hash>`), a namespace the
 *   producer never issues.
 * Page-made cards say so: `origin: 'page'` on each card (the structural marker `components/pools.ts` reads),
 * the title ends "(checked in this page)", the explanation names the depth, and the
 * game document carries a `NextMoveAnalysis` header entry with engine and depth.
 */
import { Chess } from 'chess.js';
import type { ParsedGame } from '@/lib/pgn';
import { positionThemes } from '@/lib/game-phase';
import { paths, prepareWrite, type GameDoc, type PersonalDoc, type PuzzleDoc } from '@/src/contract/docs';
import type { MoveVerdict } from './analyse';
import { ENGINE_LABEL } from './engine';

export const PAGE_CARD_RATING = 1000;
export const ANALYSIS_HEADER = 'NextMoveAnalysis';
const LINE_MAX = 32;

const CHESSCOM_GAME = /chess\.com\/game\/(?:live|daily)\/(\d+)(?:[/?#]|$)/i;
/** The chess.com game number from the PGN headers, or null. */
export function chesscomGameId(headers: Record<string, string>): string | null {
  for (const h of [headers.Link, headers.Site]) {
    const m = h ? CHESSCOM_GAME.exec(h.trim()) : null;
    if (m) return m[1];
  }
  return null;
}
/** The document id of a game: the chess.com game number, else `lib/pgn.ts`'s `game-<hash>`. */
export const gameIdOf = (game: ParsedGame) => chesscomGameId(game.headers) ?? game.id;
export const cardIdOf = (gameId: string, ply: number) => (/^\d+$/.test(gameId) ? `pack-${gameId}:${ply}` : `page-${gameId}:${ply}`);
/** First four FEN fields: the position, side to move, castling and en passant. */
export const positionKey = (fen: string) => fen.trim().split(/\s+/).slice(0, 4).join(' ');

function gameUrlOf(headers: Record<string, string>): string | undefined {
  const link = headers.Link?.trim();
  return link && /^https:\/\/(www\.)?chess\.com\/\S*$/.test(link) && link.length <= 2000 ? link : undefined;
}
function dateOf(headers: Record<string, string>): string | null {
  const raw = headers.UTCDate ?? headers.Date ?? '';
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(raw.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function san(fen: string, uci: string): string {
  try {
    const m = new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) });
    return m.san;
  } catch { return uci; }
}
/** His point of view in centipawns, or null for a mate score. */
function cpFor(score: MoveVerdict['before'], color: 'w' | 'b'): number | null {
  return typeof score.cp === 'number' ? score.cp * (color === 'w' ? 1 : -1) : null;
}

export function cardFrom(game: ParsedGame, gameId: string, v: MoveVerdict): PuzzleDoc {
  const date = dateOf(game.headers);
  const url = gameUrlOf(game.headers);
  const drop = Math.max(0, Math.round(v.winBefore - v.winAfter));
  return {
    id: cardIdOf(gameId, v.ply),
    // Structural marker (review P2-2, R-UI-3): pools de-duplicate by position only for page-made cards.
    origin: 'page',
    fen: v.fen,
    moves: [v.bestUci],
    rating: PAGE_CARD_RATING,
    themes: ['personal', ...positionThemes(v.fen, v.ply)],
    ...(url ? { gameUrl: url } : {}),
    title: `Your game${date ? ` · ${date}` : ''} · move ${Math.ceil(v.ply / 2)} (checked in this page)`,
    // Wording mirrors the producer's card text (src/importers/packDocs.ts), plus where and how deep it was checked.
    explanation: `You played ${v.playedSan}. The engine preferred ${san(v.fen, v.bestUci)}, and it was clearly best at depth ${v.depth} (checked in this page). By the engine's estimate, your move lowered your winning chances by about ${drop} points out of 100.`,
  };
}

export interface GameDocs {
  gamePath: string; game: GameDoc; personalPath: string; personal: PersonalDoc | null; cardIds: string[];
  /** Card-worthy positions not made into cards because they are already practised (in `skip`). */
  skippedKnown: number;
}

/**
 * Both documents for one analysed game, already passed through `prepareWrite` (schema and the 180 KiB guard;
 * throws `DocTooLargeError` or a zod error). `skip` holds position keys already practised elsewhere; the
 * keys of the cards made here are added to it, so one import never makes the same position twice.
 */
export function buildGameDocs(game: ParsedGame, color: 'w' | 'b', verdicts: MoveVerdict[], options: { depth: number; importedAt: number; skip?: Set<string> }): GameDocs {
  const gameId = gameIdOf(game);
  const mistakes = verdicts.filter(v => v.judgement === 'mistake' || v.judgement === 'blunder').slice(0, 200).map(v => ({
    ply: v.ply, fen: v.fen, playedUci: v.playedUci, bestUci: v.bestUci, pvUci: v.pvUci.slice(0, LINE_MAX),
    ...(v.refutationPvUci.length ? { refutationPvUci: v.refutationPvUci.slice(0, LINE_MAX) } : {}),
    cpBefore: cpFor(v.before, color), cpAfter: cpFor(v.after, color),
  }));
  const minDepth = verdicts.length ? Math.min(...verdicts.map(v => v.depth)) : options.depth;
  const headers: Record<string, string> = {};
  for (const [k, val] of Object.entries(game.headers)) if (k.length <= 200) headers[k] = val.slice(0, 5000);
  headers[ANALYSIS_HEADER] = `${ENGINE_LABEL}; depth ${options.depth} (lowest reached ${minDepth}); two lines; his moves only`;
  const gamePath = paths.game(gameId);
  const gameBody = prepareWrite<GameDoc>(gamePath, {
    pgn: game.pgn, headers, userColor: color, importedAt: options.importedAt, result: game.result, mistakes,
  });
  const seen = options.skip ?? new Set<string>();
  const puzzles: PuzzleDoc[] = [];
  let skippedKnown = 0;
  for (const v of verdicts) {
    if (v.why !== 'card') continue;
    const key = positionKey(v.fen);
    if (seen.has(key)) { skippedKnown++; continue; }
    seen.add(key);
    puzzles.push(cardFrom(game, gameId, v));
  }
  const personalPath = paths.personal(gameId);
  const personal = puzzles.length ? prepareWrite<PersonalDoc>(personalPath, { gameId, puzzles }) : null;
  return { gamePath, game: gameBody, personalPath, personal, cardIds: puzzles.map(p => p.id), skippedKnown };
}
