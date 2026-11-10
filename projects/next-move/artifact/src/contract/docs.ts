/**
 * Document contract for the Next Move artifact database (port plan sections 2, 3 and 10).
 *
 * Frozen after milestone M-a; change only by agreement between B1, B2 and B3.
 * Self-contained on purpose: it imports only zod, so it does not depend on `lib/` being copied yet.
 *
 * Validation policy:
 * - Page-written documents (settings, sessions, derived, games, personal, feedback, explanations, meta)
 *   are strict: unknown keys are stripped, and the page validates before every write (`prepareWrite`).
 * - Agent-written documents (pack, plan, drills, notes, summaries, transfer, ingest, openings) use
 *   `.passthrough()` so fields a later Claude session adds survive, and the page reads them
 *   tolerantly with `readDoc` (null on failure, never a throw).
 * - Timestamps written by the page are epoch milliseconds. Agent-written timestamps may be epoch
 *   milliseconds or ISO 8601 strings; use `toMs` to compare them.
 */
import { z } from 'zod';

// ---------------------------------------------------------------- limits and paths

/** Every document stays at or under this many bytes (UTF-8 JSON). The platform refuses 256 KiB. */
export const MAX_DOC_BYTES = 180 * 1024;
/** Attempts per session document before the writer starts a new one. */
export const ATTEMPTS_PER_SESSION_DOC = 600;
/** Cards per pack chunk and personal puzzles per `personal/import-NN` document. */
export const CARDS_PER_CHUNK = 150;
export const SCHEMA_VERSION = 1;

/** Thrown by `assertDocSize`; `code` matches the store error codes. */
export class DocTooLargeError extends Error {
  readonly code = 'doc_too_large' as const;
  constructor(readonly bytes: number, readonly path?: string) {
    super(`Document${path ? ` ${path}` : ''} is ${bytes} bytes, over the ${MAX_DOC_BYTES}-byte limit.`);
    this.name = 'DocTooLargeError';
  }
}

const encoder = new TextEncoder();
/** Serialized size in bytes, as the store measures a body. */
export function docBytes(data: unknown): number {
  return encoder.encode(JSON.stringify(data)).length;
}
/** Throws `DocTooLargeError` for a body over `MAX_DOC_BYTES`. Returns the size. */
export function assertDocSize(data: unknown, path?: string): number {
  const bytes = docBytes(data);
  if (bytes > MAX_DOC_BYTES) throw new DocTooLargeError(bytes, path);
  return bytes;
}

/** One path segment, as the db path grammar allows. */
export const SEGMENT_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
export function isSegment(s: string): boolean {
  return SEGMENT_RE.test(s) && s !== '.' && s !== '..' && encoder.encode(s).length <= 200;
}
function segments(path: string): string[] {
  const parts = path.split('/');
  if (parts.length > 16 || encoder.encode(path).length > 1000 || !parts.every(isSegment)) throw new TypeError(`Invalid db path: ${path}`);
  return parts;
}
/** Throws `TypeError` unless `path` is a document path (even segment count, valid segments). */
export function assertDocPath(path: string): string {
  if (segments(path).length % 2 !== 0) throw new TypeError(`Not a document path (odd segment count): ${path}`);
  return path;
}
/** Throws `TypeError` unless `path` is a collection path (odd segment count). */
export function assertCollectionPath(path: string): string {
  if (segments(path).length % 2 !== 1) throw new TypeError(`Not a collection path (even segment count): ${path}`);
  return path;
}
/** Make a free string safe as one segment (used for card ids and UCI in explanation ids). */
export function toSegment(s: string): string {
  const out = s.replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 200);
  return out === '' || out === '.' || out === '..' ? '_' : out;
}
const nn = (n: number) => String(n).padStart(2, '0');

export const COLLECTIONS = {
  meta: 'meta', settings: 'settings', sessions: 'sessions', summaries: 'summaries', derived: 'derived',
  games: 'games', personal: 'personal', pack: 'pack', plan: 'plan', drills: 'drills', notes: 'notes',
  feedback: 'feedback', explanations: 'explanations', transfer: 'transfer', ingest: 'ingest', openings: 'openings',
  /** M2, decision D1: "Safe or not?" cards live here, where a version-4 page never looks. */
  safe: 'safe',
} as const;
export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export type PackPart = 'cards' | 'special' | 'punish' | 'safe';
export const PACK_PARTS: readonly PackPart[] = ['cards', 'special', 'punish', 'safe'];

/** Path builders. Each returns a validated document path. */
export const paths = {
  schema: () => 'meta/schema',
  settings: () => 'settings/main',
  /** `sessions/s-<startMs>-<deviceId>` */
  session: (startMs: number, deviceId: string) => assertDocPath(`sessions/s-${Math.trunc(startMs)}-${deviceId}`),
  /** `sessions/s-import-<sha8>-NN`, for the Site-backup importer. */
  importSession: (sha8: string, n: number) => assertDocPath(`sessions/s-import-${sha8}-${nn(n)}`),
  summary: (month: string, part?: 'a' | 'b') => assertDocPath(`summaries/${month}${part ? `-${part}` : ''}`),
  snapshot: () => 'derived/snapshot',
  game: (gameId: string) => assertDocPath(`games/${gameId}`),
  personal: (gameId: string) => assertDocPath(`personal/${gameId}`),
  /** `personal/import-NN`, for the Site-backup importer. */
  personalImport: (n: number) => assertDocPath(`personal/import-${nn(n)}`),
  packMeta: () => 'pack/meta',
  /** `pack/<ver>-<part>-NN` */
  packChunk: (packVersion: string, part: PackPart, n: number) => assertDocPath(`pack/${packVersion}-${part}-${nn(n)}`),
  /** The full path of a chunk id listed in `pack/meta.chunks`. */
  packChunkById: (chunkId: string) => assertDocPath(`pack/${chunkId}`),
  plan: () => 'plan/current',
  drills: (setId: string) => assertDocPath(`drills/${setId}`),
  note: (noteId: string) => assertDocPath(`notes/${noteId}`),
  /** `feedback/f-<ms>-<deviceId>` */
  feedback: (ms: number, deviceId: string) => assertDocPath(`feedback/f-${Math.trunc(ms)}-${deviceId}`),
  /** `explanations/<cardId>__<playedUci>` (both made segment-safe). */
  explanation: (cardId: string, playedUci: string) => assertDocPath(`explanations/${toSegment(cardId)}__${toSegment(playedUci || 'none')}`),
  transferHistory: () => 'transfer/history',
  ingestState: () => 'ingest/state',
  openingAccidents: () => 'openings/accidents',
  /** M2 (D1): `safe/meta`, written LAST, lists the "Safe or not?" chunks. Never listed in `pack/meta`. */
  safeMeta: () => 'safe/meta',
  /** M2 (D1): `safe/<ver>-NN` */
  safeChunk: (packVersion: string, n: number) => assertDocPath(`safe/${packVersion}-${nn(n)}`),
  /** The full path of a chunk id listed in `safe/meta.chunks`. */
  safeChunkById: (chunkId: string) => assertDocPath(`safe/${chunkId}`),
} as const;

/** Parse a "Safe or not?" chunk id (`<ver>-NN`). */
export function parseSafeChunkId(chunkId: string): { packVersion: string; index: number } | null {
  const m = /^(.+)-(\d{2,})$/.exec(chunkId);
  return m && chunkId !== 'meta' ? { packVersion: m[1], index: Number(m[2]) } : null;
}

/** Parse a pack chunk id (`<ver>-<part>-NN`). */
export function parsePackChunkId(chunkId: string): { packVersion: string; part: PackPart; index: number } | null {
  const m = /^(.+)-(cards|special|punish|safe)-(\d{2,})$/.exec(chunkId);
  return m ? { packVersion: m[1], part: m[2] as PackPart, index: Number(m[3]) } : null;
}

// ---------------------------------------------------------------- shared shapes

const finite = z.number().finite();
const nonneg = finite.nonnegative();
const ms = nonneg;
/** Agent-written time: epoch ms or an ISO 8601 string. */
export const stamp = z.union([nonneg, z.string().max(40).refine(s => !Number.isNaN(Date.parse(s)), 'not a date')]);
export type Stamp = z.infer<typeof stamp>;
/** Epoch ms of a `Stamp`, or NaN. */
export function toMs(t: Stamp | undefined | null): number {
  if (t === undefined || t === null) return NaN;
  return typeof t === 'number' ? t : Date.parse(t);
}
const key = z.string().min(1).max(200).refine(s => !['__proto__', 'constructor', 'prototype'].includes(s), 'reserved key');
const segmentId = z.string().refine(isSegment, 'not a valid db path segment');
export const uci = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
const fen = z.string().min(15).max(120);
const themes = z.array(key).min(1).max(30);
const color = z.enum(['w', 'b']);

export const ATTEMPT_SOURCES = ['bank', 'pack', 'endgame', 'agent', 'personal'] as const;
export const attemptSource = z.enum(ATTEMPT_SOURCES);
export type AttemptSource = z.infer<typeof attemptSource>;

/** The app's Attempt (lib/training-state.ts), structurally identical. */
export const attemptSchema = z.object({
  puzzleId: key, themes, correct: z.boolean(), unassisted: z.boolean(), hints: nonneg.int(), revealed: z.boolean(), durationMs: nonneg, at: ms,
});
export type Attempt = z.infer<typeof attemptSchema>;
/** Attempt as stored in `sessions/*`: the app's Attempt plus the optional port fields. */
export const sessionAttemptSchema = attemptSchema.extend({
  source: attemptSource.optional(),
  playedUci: uci.optional(),
  coached: z.boolean().optional(),
  /** Item b ("safe or not?", M2): the learner's verdict. */
  verdict: z.enum(['safe', 'unsafe']).optional(),
}).refine(a => a.unassisted === (a.correct && a.hints === 0 && !a.revealed), 'unassisted must equal correct && hints==0 && !revealed');
export type SessionAttempt = z.infer<typeof sessionAttemptSchema>;
/** Dedupe key used everywhere attempts are merged (the app's `mergeStates` key). */
export const attemptKey = (a: { puzzleId: string; at: number }) => `${a.puzzleId}:${a.at}`;

/** A drillable position: the app's Puzzle/PersonalPuzzle, structurally. */
export const puzzleSchema = z.object({
  id: key, fen, moves: z.array(uci).min(1).max(100), rating: nonneg.max(4000), themes,
  gameUrl: z.string().max(2000).optional(), title: z.string().max(200).optional(), explanation: z.string().max(2000).optional(),
  /**
   * M2 (fix pass P2-2, R-UI-3): "page" on personal cards made by the page's PGN import. Only those give way to a pack
   * card on the same position; Site-backup positions (no `origin`) are kept as in version 4. Version 4 strips it.
   */
  origin: z.enum(['page']).optional(),
});
export type PuzzleDoc = z.infer<typeof puzzleSchema>;

// ---------------------------------------------------------------- page-written documents

/** `meta/schema` */
export const schemaDoc = z.object({ schemaVersion: z.literal(SCHEMA_VERSION), createdAt: ms });
export type SchemaDoc = z.infer<typeof schemaDoc>;

/** `settings/main`. The one doc both devices write; a lost concurrent change is acceptable. */
export const settingsDoc = z.object({
  rating: z.number().int().min(600).max(1800),
  sessionLength: z.number().int().min(3).max(30),
  chesscomUser: z.string().max(60).optional(),
  lastIngest: stamp.optional(),
  /** Item c caps; defaults 20 reviews and 10 new per day when absent. */
  dailyReviewCap: z.number().int().min(0).max(500).optional(),
  dailyNewCap: z.number().int().min(0).max(200).optional(),
  /**
   * M2 (PGN import, R-PGN-1): the names he plays under, matched against PGN player names to find his side.
   * Stored only here, never in source. A version-4 page drops it on its next settings save (strict schema).
   */
  myNames: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  updatedAt: ms,
  device: segmentId,
});
export type SettingsDoc = z.infer<typeof settingsDoc>;
export const DEFAULT_SETTINGS = { rating: 1000, sessionLength: 10, dailyReviewCap: 20, dailyNewCap: 10 } as const;

/** `sessions/<s-startMs-deviceId>`. Single writer: its own device. */
export const sessionDoc = z.object({
  device: segmentId,
  startedAt: ms,
  endedAt: ms.optional(),
  attempts: z.array(sessionAttemptSchema).max(ATTEMPTS_PER_SESSION_DOC),
  /** Set by the Site-backup importer. */
  importedFrom: z.string().max(80).optional(),
});
export type SessionDoc = z.infer<typeof sessionDoc>;

export const MAX_DOC_ERRORS = 20;
const rate = z.number().min(0).max(1).nullable();
const windowStats = z.object({ attempts: nonneg.int(), firstTryRate: rate });
/** `derived/snapshot`: the agent read model, a full recompute at session end. */
export const snapshotDoc = z.object({
  computedAt: ms,
  attemptsTotal: nonneg.int(),
  approxBytes: nonneg.int(),
  last7d: windowStats,
  last30d: windowStats,
  themes: z.record(key, z.object({ attempts: nonneg.int(), successes: nonneg.int(), rate, lastAttempt: ms, prior: finite.nullable() })),
  weakest: z.array(z.object({ theme: key, rate, attempts: nonneg.int(), prior: finite.nullable(), why: z.string().max(200) })).max(8),
  due: z.object({ count: nonneg.int(), overdue: nonneg.int(), nextIds: z.array(key).max(50) }),
  sources: z.object({ bank: nonneg.int(), pack: nonneg.int(), endgame: nonneg.int(), personal: nonneg.int(), agent: nonneg.int() }),
  packCoverage: z.object({ seen: nonneg.int(), total: nonneg.int() }),
  lastSession: z.object({ id: segmentId, attempts: nonneg.int(), firstTryRate: rate, endedAt: ms.nullable() }).nullable(),
  /** Item c: today's counts against the caps (local day of the writing device). */
  today: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reviews: nonneg.int(), new: nonneg.int() }).optional(),
  /** Item c (M2): cards with 4 or more lapses, moved out of the queue to study notes. */
  leeches: z.object({ count: nonneg.int(), ids: z.array(key).max(50) }).optional(),
  /** M2 (D6): "Safe or not?" over his last 50 answers, two numbers (never one combined rate). Left out of the windows and themes above. */
  safe: z.object({ answers: nonneg.int(), caught: z.object({ k: nonneg.int(), n: nonneg.int() }), trusted: z.object({ k: nonneg.int(), n: nonneg.int() }) }).optional(),
  /** M2 (D10): agent documents the page could not read (newest first, at most 20), so the next coach session sees them. */
  docErrors: z.array(z.object({ path: z.string().max(200), issue: z.string().max(300), at: ms })).max(MAX_DOC_ERRORS).optional(),
  device: segmentId.optional(),
});
export type SnapshotDoc = z.infer<typeof snapshotDoc>;

export const gameMistake = z.object({
  ply: nonneg.int(), fen, playedUci: uci, bestUci: uci, pvUci: z.array(uci).max(32), refutationPvUci: z.array(uci).max(32).optional(),
  cpBefore: finite.nullable(), cpAfter: finite.nullable(),
});
/** `games/<gameId>` */
export const gameDoc = z.object({
  pgn: z.string().max(170_000),
  headers: z.record(z.string().max(200), z.string().max(5000)),
  userColor: color.optional(),
  importedAt: ms,
  result: z.enum(['1-0', '0-1', '1/2-1/2']).optional(),
  mistakes: z.array(gameMistake).max(200),
});
export type GameDoc = z.infer<typeof gameDoc>;

/** `personal/<gameId>` or `personal/import-NN` */
export const personalDoc = z.object({
  gameId: z.string().max(120).optional(),
  puzzles: z.array(puzzleSchema).max(CARDS_PER_CHUNK),
});
export type PersonalDoc = z.infer<typeof personalDoc>;

export const FEEDBACK_KINDS = ['wrong', 'more', 'less', 'too-hard', 'too-easy', 'comment'] as const;
/** `feedback/f-<ms>-<deviceId>`. The page creates it; Claude sets only `status` and `reply`. */
export const feedbackDoc = z.object({
  at: ms,
  kind: z.enum(FEEDBACK_KINDS),
  itemId: key,
  source: attemptSource,
  themes: z.array(key).max(30),
  fen,
  playedUci: uci.optional(),
  text: z.string().max(500).optional(),
  sessionId: z.string().max(200),
  status: z.enum(['open', 'done']),
  reply: z.string().max(1000).optional(),
  device: segmentId.optional(),
});
export type FeedbackDoc = z.infer<typeof feedbackDoc>;

/** `explanations/<cardId>__<playedUci>` */
export const explanationDoc = z.object({
  text: z.string().max(3000),
  at: ms,
  grounded: z.boolean(),
  inputsHash: z.string().max(80),
  itemId: key.optional(),
  playedUci: uci.optional(),
  misses: z.array(z.string().max(40)).max(20).optional(),
});
export type ExplanationDoc = z.infer<typeof explanationDoc>;

// ---------------------------------------------------------------- agent-written documents (passthrough)

/** `summaries/<YYYY-MM>[-a|-b]` (M3). Compacted attempts of sessions older than 90 days. */
export const summaryDoc = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  attempts: z.array(sessionAttemptSchema),
  sessionIds: z.array(z.string().max(200)).optional(),
}).passthrough();
export type SummaryDoc = z.infer<typeof summaryDoc>;

export const PACK_CARD_KINDS = ['mistake', 'stalemate', 'conversion', 'punish', 'safe', 'unsafe'] as const;
/**
 * A card in a pack chunk: the app's PackCard (lib/personal-pack.ts) checked structurally, plus `kind`
 * for the section 10 parts. Ids are checked against the path grammar only (the app emits
 * `pack-<16 hex>`; the plan text says `pack-<gameId>:<ply>`): both are valid segments.
 * The `pack` detail object and any other field pass through untouched.
 */
export const packCardDoc = z.object({
  id: segmentId,
  fen,
  moves: z.array(uci).min(1).max(32),
  rating: finite,
  themes: z.array(key).min(1).max(30),
  kind: z.enum(PACK_CARD_KINDS).optional(),
  title: z.string().max(200).optional(),
  explanation: z.string().max(2000).optional(),
  gameUrl: z.string().max(300).optional(),
}).passthrough();
export type PackCardDoc = z.infer<typeof packCardDoc>;

/** `pack/<ver>-<part>-NN`. `study` (stalemate study items) may ride in `special` chunks. */
export const packChunkDoc = z.object({
  packVersion: segmentId.optional(),
  part: z.enum(['cards', 'special', 'punish', 'safe']).optional(),
  cards: z.array(packCardDoc).max(CARDS_PER_CHUNK),
  study: z.array(z.object({ id: segmentId, fen }).passthrough()).max(500).optional(),
}).passthrough();
export type PackChunkDoc = z.infer<typeof packChunkDoc>;

/** `pack/meta`, written LAST by Claude, so a reader that follows its chunk ids never mixes versions. */
export const packMetaDoc = z.object({
  packVersion: segmentId,
  importedAt: stamp,
  counts: z.record(key, nonneg),
  profile: z.record(z.string(), z.unknown()).nullable().optional(),
  priors: z.record(key, finite),
  chunks: z.object({
    cards: z.array(segmentId).max(200),
    special: z.array(segmentId).max(50).default([]),
    punish: z.array(segmentId).max(100).optional(),
    safe: z.array(segmentId).max(100).optional(),
  }).passthrough(),
}).passthrough();
export type PackMetaDoc = z.infer<typeof packMetaDoc>;
/** Every chunk id listed in a meta document, in part order. */
export function packChunkIds(meta: PackMetaDoc): string[] {
  return PACK_PARTS.flatMap(part => (meta.chunks[part] as string[] | undefined) ?? []);
}

export const MIX_KEYS = ['bank', 'pack', 'endgame', 'agent'] as const;
/** `plan/current`. Until `expires`, priors are multiplied by `focus.weight` and sources sampled by `mix`. */
export const planDoc = z.object({
  updatedAt: stamp,
  author: z.string().max(80),
  expires: stamp,
  focus: z.array(z.object({ theme: key, weight: z.number().min(0.5).max(3), reason: z.string().max(300) }).passthrough()).max(20),
  mix: z.object({
    bank: z.number().min(0).max(1), pack: z.number().min(0).max(1), endgame: z.number().min(0).max(1), agent: z.number().min(0).max(1),
    /**
     * M2 (D3), optional and outside the sum rule: the "Safe or not?" share of a session. Absent = 0.15, 0 = off,
     * otherwise this number capped at 0.5 (`safeShare`). The four shares above scale down in proportion.
     */
    safe: z.number().min(0).max(1).optional(),
  })
    .passthrough()
    .refine(m => Math.abs(MIX_KEYS.reduce((s, k) => s + m[k], 0) - 1) <= 0.02, 'mix fractions must sum to 1'),
  sessionMinutes: z.number().min(1).max(240).optional(),
  noteToLearner: z.string().max(600).optional(),
}).passthrough();
export type PlanDoc = z.infer<typeof planDoc>;

/** Lenient on `fen` and `moves` so one bad line does not hide the set: the page checks each card with chess.js and lists failures in `rejected`. */
export const drillCard = z.object({
  id: segmentId, fen: z.string().min(1).max(120), moves: z.array(z.string().max(10)).min(1).max(32), themes: z.array(key).min(1).max(30), rating: finite,
  explanation: z.string().max(400).optional(), refutationPvUci: z.array(uci).max(32).optional(),
}).passthrough();
/** `drills/<setId>`. The page may set only `rejected` (lines that fail chess.js). */
export const drillsDoc = z.object({
  title: z.string().max(200),
  reason: z.string().max(600),
  createdAt: stamp,
  active: z.boolean(),
  cards: z.array(drillCard).max(500),
  rejected: z.array(z.object({ id: z.string().max(200), reason: z.string().max(300) })).max(500).optional(),
}).passthrough();
export type DrillsDoc = z.infer<typeof drillsDoc>;
export type DrillCard = z.infer<typeof drillCard>;

/** `notes/<noteId>`. The page may set only `readAt`. */
export const noteDoc = z.object({ text: z.string().max(600), createdAt: stamp, readAt: ms.optional() }).passthrough();
export type NoteDoc = z.infer<typeof noteDoc>;

/** `transfer/history` (item g, M2) */
export const transferDoc = z.object({
  points: z.array(z.object({
    at: stamp, games: nonneg.int(), window: z.string().max(80), blundersPer100: finite, ci95: z.tuple([finite, finite]),
    convNotWonPct: finite.nullable(), convCi95: z.tuple([finite, finite]).nullable(), onTimeShare: finite.nullable(),
  }).passthrough()).max(500),
}).passthrough();
export type TransferDoc = z.infer<typeof transferDoc>;

/** `ingest/state` (item h) */
export const ingestDoc = z.object({
  lastArchive: z.string().max(40), lastGameEnd: stamp, gamesProcessed: nonneg.int(), packVersion: segmentId, at: stamp,
}).passthrough();
export type IngestDoc = z.infer<typeof ingestDoc>;

/** `openings/accidents` (item e, M2) */
export const openingsDoc = z.object({
  groups: z.array(z.object({
    opening: z.string().max(200), color, games: nonneg.int(), earlyBlunderRate: z.number().min(0).max(1), cardIds: z.array(segmentId).max(200),
    /** 95% Wilson interval over games (0-1); `fewGames` marks openings under 30 games, listed after the ranked ones. */
    ci95: z.tuple([finite, finite]).optional(), fewGames: z.boolean().optional(),
  }).passthrough()).max(200),
}).passthrough();
export type OpeningsDoc = z.infer<typeof openingsDoc>;

/** D3: the "Safe or not?" share of a session from `plan.mix.safe` (absent 0.15, 0 off, capped at 0.5). */
export const SAFE_SHARE_DEFAULT = 0.15;
export const SAFE_SHARE_MAX = 0.5;
export function safeShare(mixSafe: number | undefined | null): number {
  if (mixSafe === undefined || mixSafe === null || !Number.isFinite(mixSafe)) return SAFE_SHARE_DEFAULT;
  return Math.min(Math.max(mixSafe, 0), SAFE_SHARE_MAX);
}

/**
 * A "Safe or not?" card (M2, D1/D4) in a `safe/<ver>-NN` chunk. `fen` is the position BEFORE his move, his side
 * to move; `moves[0]` is the move he played (the move to judge, never a solution). `kind` and `reveal` are the
 * answer: the page must not put them in the DOM, an attribute or an aria label before he answers.
 */
export const safeCardDoc = z.object({
  id: segmentId,
  fen,
  moves: z.array(uci).min(1).max(32),
  kind: z.enum(['safe', 'unsafe']),
  rating: finite.optional(),
  themes: z.array(key).min(1).max(30),
  title: z.string().max(200).optional(),
  /** Pre-answer facts. `playedUci` equals `moves[0]` when present. */
  question: z.object({ playedUci: uci.optional(), playedSan: z.string().max(12).optional(), side: color.optional() }).passthrough().optional(),
  /** Post-answer facts. Lines are in SAN (`replyLineSan` after his move; `bestLineSan` from the position). */
  reveal: z.object({
    explanation: z.string().max(2000).optional(),
    playedSan: z.string().max(12).optional(),
    bestUci: uci.optional(), bestSan: z.string().max(12).optional(),
    bestLineSan: z.array(z.string().max(12)).max(32).optional(),
    replyLineUci: z.array(uci).max(32).optional(), replyLineSan: z.array(z.string().max(12)).max(32).optional(),
    winBefore: finite.nullable().optional(), winAfter: finite.nullable().optional(),
    gameUrl: z.string().max(300).optional(),
  }).passthrough().optional(),
}).passthrough();
export type SafeCardDoc = z.infer<typeof safeCardDoc>;

/**
 * "Safe or not?" card ids start with `judge-` (the producer's `judge-<gameId>:<ply>`). The page uses this to
 * keep these answers out of the ordinary schedule, skills and leech counts even when the safe documents are
 * not loaded. A producer must keep the prefix.
 */
export const SAFE_ID_PREFIX = 'judge-';
export const isSafeCardId = (id: string) => id.startsWith(SAFE_ID_PREFIX);

/** `safe/<ver>-NN` (M2, D1). */
export const safeChunkDoc = z.object({
  packVersion: segmentId.optional(),
  cards: z.array(safeCardDoc).max(CARDS_PER_CHUNK),
}).passthrough();
export type SafeChunkDoc = z.infer<typeof safeChunkDoc>;

/** `safe/meta` (M2, D1), written LAST, after its chunks. Chunk ids are `<packVersion>-NN`. */
export const safeMetaDoc = z.object({
  packVersion: segmentId,
  chunks: z.array(segmentId).max(100),
  counts: z.record(key, nonneg),
  importedAt: stamp.optional(),
}).passthrough();
export type SafeMetaDoc = z.infer<typeof safeMetaDoc>;

// ---------------------------------------------------------------- path -> schema registry

type AnySchema = z.ZodTypeAny;
/** Which writer owns each collection: the page writes only `page` docs (plus the pinned fields noted above). */
export const DOC_KINDS: Record<CollectionName, { writer: 'page' | 'agent'; schema: AnySchema }> = {
  meta: { writer: 'page', schema: schemaDoc },
  settings: { writer: 'page', schema: settingsDoc },
  sessions: { writer: 'page', schema: sessionDoc },
  summaries: { writer: 'agent', schema: summaryDoc },
  derived: { writer: 'page', schema: snapshotDoc },
  games: { writer: 'page', schema: gameDoc },
  personal: { writer: 'page', schema: personalDoc },
  pack: { writer: 'agent', schema: packChunkDoc },
  plan: { writer: 'agent', schema: planDoc },
  drills: { writer: 'agent', schema: drillsDoc },
  notes: { writer: 'agent', schema: noteDoc },
  feedback: { writer: 'page', schema: feedbackDoc },
  explanations: { writer: 'page', schema: explanationDoc },
  transfer: { writer: 'agent', schema: transferDoc },
  ingest: { writer: 'agent', schema: ingestDoc },
  openings: { writer: 'agent', schema: openingsDoc },
  safe: { writer: 'agent', schema: safeChunkDoc },
};

/** The schema for a document path (`pack/meta` is special-cased), or null for an unknown collection. */
export function schemaForPath(path: string): AnySchema | null {
  assertDocPath(path);
  if (path === 'pack/meta') return packMetaDoc;
  if (path === 'safe/meta') return safeMetaDoc;
  const collection = path.split('/')[0] as CollectionName;
  return (DOC_KINDS as Record<string, { schema: AnySchema }>)[collection]?.schema ?? null;
}

/** Tolerant read: the parsed document, or null when it is absent, unknown or malformed. Never throws. */
export function readDoc<T = unknown>(path: string, data: unknown): T | null {
  if (data === undefined || data === null) return null;
  let schema: AnySchema | null;
  try { schema = schemaForPath(path); } catch { return null; }
  if (!schema) return null;
  const parsed = schema.safeParse(data);
  return parsed.success ? (parsed.data as T) : null;
}

/** Strict pre-write check: validates against the path's schema and the size limit. Returns the cleaned body. */
export function prepareWrite<T extends Record<string, unknown>>(path: string, data: unknown): T {
  const schema = schemaForPath(path);
  if (!schema) throw new TypeError(`No schema for ${path}`);
  const body = schema.parse(data) as T;
  assertDocSize(body, path);
  return body;
}
