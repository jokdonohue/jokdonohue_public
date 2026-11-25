/**
 * Site backup -> artifact database (port plan section 8). The Site's "Export" file is `exportState(TrainingState v1)`.
 *
 *   const plan = await planSiteImport(text, { parse: parseState, idMap });   // pure, no store access
 *   const result = await applySiteImport(store, plan, { deviceId });          // writes
 *
 * - Attempts -> `sessions/s-import-<sha8>-NN`, 600 per document, deduped by `puzzleId:at`, sorted by time.
 *   sha8 hashes the backup's attempt keys, game ids and puzzle ids, so the same backup always gives the same
 *   document ids and bodies: re-import overwrites with identical data (idempotent). Attempts that also sit in
 *   other session documents are deduped where they are read, by the same key (`mergeStates`).
 * - Games -> `games/<gameId>` (`mistakes: []`: the Site does not store analysis); personal puzzles ->
 *   `personal/import-NN`, 150 per document.
 * - Settings are applied only when the backup's `settingsUpdatedAt` is newer than `settings/main.updatedAt`.
 * - Cards and skills are dropped: the page rebuilds them from attempts.
 * - `idMap` (Site card id -> artifact card id, e.g. from pack cards' `siteId`) rewrites `puzzleId`, so Site
 *   attempts on pack cards keep applying to the db pack (`pack-<16hex>` -> `pack-<gameId>:<ply>`).
 * - `parse` defaults to a structural validator equal to the Site's schema (no PGN replay). Once `lib/` is copied
 *   into the artifact, pass `parseState` from `@/lib/training-state` for the full chess verification.
 * - The artifact's own export (`nextMove.kind === "next-move-artifact-backup"`, components/backup.ts) is read
 *   too: `nextMove.attemptExtras` restores `source`, `playedUci`, `coached` and `verdict` (review 2 P2-5), and
 *   its limits are wider than the Site's (200,000 attempts, 16 MB), so a long history stays importable.
 * - `skipKeys` (attempt keys already stored in this database) leaves those attempts out, so re-importing your
 *   own export does not write a second copy (review 2 P2-5). Document ids still come from the backup's full key set.
 */
import { z } from 'zod';
import {
  ATTEMPTS_PER_SESSION_DOC, CARDS_PER_CHUNK, attemptKey, paths, prepareWrite, toSegment, type AttemptSource, type SessionAttempt,
} from '../contract/docs';
import type { DocData, Store } from '../contract/store';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const NOT_A_BACKUP = 'This file is not a Next Move backup, or it is damaged. Your saved progress is unchanged.';
const MAX_TEXT_BYTES = 16_000_000, MAX_BYTES = 4_000_000;
export const ARTIFACT_BACKUP_KIND = 'next-move-artifact-backup';
const ARTIFACT_MAX_ATTEMPTS = 200_000, ARTIFACT_MAX_BYTES = 16_000_000;
export const IMPORT_DEVICE = 'site-import';

// Structural copy of the Site schema (app/lib/training-state.ts, 2026-11-10).
const key = z.string().min(1).max(200).refine(s => !['__proto__', 'constructor', 'prototype'].includes(s));
const number = z.number().finite().nonnegative();
const themes = z.array(key).min(1).max(30);
const uci = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
const attempt = z.object({ puzzleId: key, themes, correct: z.boolean(), unassisted: z.boolean(), hints: number.int(), revealed: z.boolean(), durationMs: number, at: number })
  .refine(a => a.unassisted === (a.correct && a.hints === 0 && !a.revealed));
const game = z.object({
  id: key, headers: z.record(z.string().max(5000)),
  moves: z.array(z.object({ san: z.string().max(20), uci, before: z.string().max(200), after: z.string().max(200), color: z.enum(['w', 'b']), ply: number.int() })).max(600),
  pgn: z.string().max(2_000_000), result: z.enum(['1-0', '0-1', '1/2-1/2']), userColor: z.enum(['w', 'b']).optional(), importedAt: number,
});
const puzzle = z.object({
  id: key, fen: z.string().max(200), moves: z.array(uci).min(1).max(100), rating: number.max(4000), themes,
  gameUrl: z.string().max(2000).refine(s => s === '' || /^https?:\/\//.test(s)), title: z.string().max(200).optional(), explanation: z.string().max(2000).optional(),
});
const extra = z.object({
  key: z.string().max(260), source: z.enum(['bank', 'pack', 'endgame', 'agent', 'personal']).optional(),
  playedUci: uci.optional(), coached: z.boolean().optional(), verdict: z.enum(['safe', 'unsafe']).optional(),
});
const nextMoveBlock = z.object({ kind: z.literal(ARTIFACT_BACKUP_KIND), attemptExtras: z.array(extra).max(ARTIFACT_MAX_ATTEMPTS).optional() }).passthrough();
const stateSchemaFor = (maxAttempts: number) => z.object({
  version: z.literal(1),
  progress: z.object({
    attempts: z.array(attempt).max(maxAttempts), cards: z.record(z.unknown()), skills: z.record(z.unknown()),
    settings: z.object({ rating: z.number().int().min(600).max(1800), sessionLength: z.number().int().min(3).max(30) }),
    settingsUpdatedAt: number.default(0),
  }),
  games: z.array(game).max(100), personalPuzzles: z.array(puzzle).max(1000),
  nextMove: nextMoveBlock.optional(),
});
const stateSchema = stateSchemaFor(20_000);
export type SiteState = z.infer<typeof stateSchema>;
/** What `parse` must return (the Site's TrainingState satisfies it). */
export interface SiteStateLike {
  progress: { attempts: SiteState['progress']['attempts']; settings: { rating: number; sessionLength: number }; settingsUpdatedAt: number };
  games: Array<{ id: string; headers: Record<string, string>; pgn: string; result: '1-0' | '0-1' | '1/2-1/2'; userColor?: 'w' | 'b'; importedAt: number }>;
  personalPuzzles: Array<{ id: string; fen: string; moves: string[]; rating: number; themes: string[]; gameUrl: string; title?: string; explanation?: string }>;
  nextMove?: { kind: string; attemptExtras?: Array<{ key: string; source?: AttemptSource; playedUci?: string; coached?: boolean; verdict?: 'safe' | 'unsafe' }> };
}

/** Default parser: the Site's limits and schema, plain-sentence errors. */
export function parseSiteBackup(text: string): SiteStateLike {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  if (bytes(text) > MAX_TEXT_BYTES) throw new Error('Backup exceeds 16 MB.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (k, v) => { if (['__proto__', 'constructor', 'prototype'].includes(k)) throw new Error('Invalid backup key.'); return v; });
  } catch (cause) { throw new Error(cause instanceof Error && cause.message === 'Invalid backup key.' ? cause.message : NOT_A_BACKUP); }
  const isArtifact = (parsed as { nextMove?: { kind?: unknown } } | null)?.nextMove?.kind === ARTIFACT_BACKUP_KIND;
  const maxBytes = isArtifact ? ARTIFACT_MAX_BYTES : MAX_BYTES;
  if (bytes(JSON.stringify(parsed)) > maxBytes) throw new Error(`Backup exceeds ${maxBytes / 1_000_000} MB.`);
  const result = (isArtifact ? stateSchemaFor(ARTIFACT_MAX_ATTEMPTS) : stateSchema).safeParse(parsed);
  if (!result.success) throw new Error(NOT_A_BACKUP);
  const s = result.data;
  if (new Set(s.games.map(g => g.id)).size !== s.games.length || new Set(s.personalPuzzles.map(p => p.id)).size !== s.personalPuzzles.length) throw new Error('Backup contains duplicate record IDs.');
  return s;
}

/** Hex SHA-256 (Web Crypto: the page and Node 20+). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Attempt source from the id the Site gave the item. */
export function sourceOf(puzzleId: string, personalIds: ReadonlySet<string>): AttemptSource {
  if (puzzleId.startsWith('pack-') || puzzleId.startsWith('punish-')) return 'pack';
  if (puzzleId.startsWith('endgame-') || puzzleId.startsWith('tech-')) return 'endgame';
  if (puzzleId.startsWith('agent-')) return 'agent';
  if (personalIds.has(puzzleId) || puzzleId.startsWith('personal-')) return 'personal';
  return 'bank';
}

export interface ImportPlan {
  sha8: string;
  /** Documents written with `set`, in order (games, personal, sessions). */
  writes: Array<{ path: string; data: DocData }>;
  settings: { rating: number; sessionLength: number; updatedAt: number } | null;
  counts: { attempts: number; alreadyStored: number; extrasRestored: number; duplicateAttempts: number; remapped: number; sessions: number; games: number; personalPuzzles: number; personalDocs: number; skippedGames: number };
  skipped: string[];
}

export async function planSiteImport(text: string, options: { parse?: (text: string) => SiteStateLike; idMap?: Record<string, string>; skipKeys?: ReadonlySet<string> } = {}): Promise<ImportPlan> {
  const state = (options.parse ?? parseSiteBackup)(text);
  const extras = new Map((state.nextMove?.attemptExtras ?? []).map(e => [e.key, e]));
  const idMap = options.idMap ?? {};
  const personalIds = new Set(state.personalPuzzles.map(p => p.id));
  const skipped: string[] = [];

  // Attempts: remap, dedupe, sort.
  const byKey = new Map<string, SessionAttempt>();
  let remapped = 0;
  for (const a of state.progress.attempts) {
    const mapped = idMap[a.puzzleId];
    if (mapped) remapped++;
    const puzzleId = mapped ?? a.puzzleId;
    const x = extras.get(attemptKey(a));
    const item: SessionAttempt = {
      puzzleId, themes: a.themes, correct: a.correct, unassisted: a.unassisted, hints: a.hints, revealed: a.revealed, durationMs: a.durationMs, at: a.at,
      source: x?.source ?? sourceOf(puzzleId, personalIds),
      ...(x?.playedUci ? { playedUci: x.playedUci } : {}), ...(x?.coached ? { coached: true } : {}), ...(x?.verdict ? { verdict: x.verdict } : {}),
    };
    byKey.set(attemptKey(item), item);
  }
  const allAttempts = [...byKey.values()].sort((x, y) => x.at - y.at || cmp(x.puzzleId, y.puzzleId));
  const attempts = options.skipKeys ? allAttempts.filter(a => !options.skipKeys!.has(attemptKey(a))) : allAttempts;
  // Hash the backup's ORIGINAL keys, so the same backup lands in the same documents with or without an idMap.
  const originalKeys = [...new Set(state.progress.attempts.map(attemptKey))].sort(cmp);
  const sha8 = (await sha256Hex(JSON.stringify({
    a: originalKeys, g: state.games.map(g => g.id).sort(cmp), p: state.personalPuzzles.map(p => p.id).sort(cmp),
  }))).slice(0, 8);

  const writes: ImportPlan['writes'] = [];
  // Games.
  let games = 0;
  for (const g of state.games) {
    const path = paths.game(toSegment(g.id));
    try {
      writes.push({ path, data: prepareWrite(path, { pgn: g.pgn, headers: g.headers, ...(g.userColor ? { userColor: g.userColor } : {}), importedAt: g.importedAt, result: g.result, mistakes: [] }) });
      games++;
    } catch { skipped.push(`game ${g.id}: too large or invalid for one document`); }
  }
  // Personal puzzles.
  const puzzles = [...state.personalPuzzles].sort((x, y) => cmp(x.id, y.id)).map(p => ({
    id: p.id, fen: p.fen, moves: p.moves, rating: p.rating, themes: p.themes,
    ...(p.gameUrl ? { gameUrl: p.gameUrl } : {}), ...(p.title ? { title: p.title } : {}), ...(p.explanation ? { explanation: p.explanation } : {}),
  }));
  let personalDocs = 0;
  for (let i = 0; i < puzzles.length; i += CARDS_PER_CHUNK) {
    const path = paths.personalImport(personalDocs++);
    writes.push({ path, data: prepareWrite(path, { puzzles: puzzles.slice(i, i + CARDS_PER_CHUNK) }) });
  }
  // Sessions.
  let sessions = 0;
  for (let i = 0; i < attempts.length; i += ATTEMPTS_PER_SESSION_DOC) {
    const part = attempts.slice(i, i + ATTEMPTS_PER_SESSION_DOC);
    const path = paths.importSession(sha8, sessions++);
    writes.push({ path, data: prepareWrite(path, { device: IMPORT_DEVICE, startedAt: part[0].at, endedAt: part[part.length - 1].at, attempts: part, importedFrom: `site-backup-${sha8}` }) });
  }
  const s = state.progress;
  return {
    sha8, writes,
    settings: s.settingsUpdatedAt > 0 ? { rating: s.settings.rating, sessionLength: s.settings.sessionLength, updatedAt: s.settingsUpdatedAt } : null,
    counts: { attempts: attempts.length, alreadyStored: allAttempts.length - attempts.length, extrasRestored: extras.size, duplicateAttempts: s.attempts.length - allAttempts.length, remapped, sessions, games, personalPuzzles: puzzles.length, personalDocs, skippedGames: state.games.length - games },
    skipped,
  };
}

export interface ImportResult { written: string[]; settingsApplied: boolean }

/** Write the plan's documents in order, then the settings when newer. Rejects with the store's error. */
export async function applySiteImport(store: Store, plan: ImportPlan, options: { deviceId: string }): Promise<ImportResult> {
  const written: string[] = [];
  for (const w of plan.writes) { await store.set(w.path, w.data); written.push(w.path); }
  let settingsApplied = false;
  if (plan.settings) {
    const path = paths.settings();
    const current = await store.get<{ updatedAt?: number }>(path);
    const currentAt = typeof current?.data.updatedAt === 'number' ? current.data.updatedAt : -1;
    if (plan.settings.updatedAt > currentAt) {
      const body = current
        ? { ...(current.data as DocData), rating: plan.settings.rating, sessionLength: plan.settings.sessionLength, updatedAt: plan.settings.updatedAt, device: options.deviceId }
        : { rating: plan.settings.rating, sessionLength: plan.settings.sessionLength, updatedAt: plan.settings.updatedAt, device: options.deviceId };
      await store.set(path, prepareWrite(path, body));
      settingsApplied = true;
    }
  }
  return { written, settingsApplied };
}

/** `siteId -> id` for every card in pack chunk bodies (for `planSiteImport`'s idMap). */
export function idMapFromPackChunks(chunks: Array<{ cards?: Array<{ id: string; siteId?: unknown }>; study?: Array<{ id: string; siteId?: unknown }> }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of chunks) for (const card of [...(c.cards ?? []), ...(c.study ?? [])]) if (typeof card.siteId === 'string') out[card.siteId] = card.id;
  return out;
}
