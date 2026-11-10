/**
 * Personal pack: positions and statistics from an offline engine pass over the owner's
 * completed games (contract: reviews/claude/data/weakness_profile/CONTRACT.md, v1).
 *
 * The pack is static content, like the puzzle bank. It is never written into stored
 * progress. It lives in `public/personal-pack/pack.json`, which is a small stub
 * (`installed: false`) until `scripts/import-personal-pack.ts` replaces it, so the app
 * behaves exactly as before when no pack is installed.
 */
import { z } from 'zod';
import { Chess } from 'chess.js';
import type { PersonalPuzzle } from './training-state';
import { trainingThemes } from './scheduler.js';

export const PACK_URL = '/personal-pack/pack.json';
export const PACK_KIND = 'next-move-personal-pack';
/** Pack cards are served from their own pool, so this only orders them among themselves. */
export const PACK_RATING = 1000;
/** Prior pseudo-attempts per theme: the spec §3 v2 shrinkage constant m = 8. */
export const PRIOR_PSEUDO_ATTEMPTS = 8;
/** Theme-prior range. The spec defines none; the producer's README §Weights clamps to 0.5-2.5, so that range is used. */
export const PRIOR_MIN = 0.5, PRIOR_MAX = 2.5;
/** At most this many game occurrences are kept per card. */
const MAX_OCCURRENCES = 50;

const finite = z.number().finite();
const count = z.number().int().nonnegative();
const interval = z.tuple([finite, finite]).refine(([low, high]) => low <= high, 'interval low must not exceed high');
const uci = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9:_-]{0,60}$/).refine(s => !['constructor', 'prototype'].includes(s));
const chessComUrl = z.string().max(300).regex(/^https:\/\/(www\.)?chess\.com\/[^\s]*$/);

/** One row of `mistake_positions.jsonl` (also the base of `special_sets.jsonl`). Unknown fields are ignored. */
export const positionRow = z.object({
  id: z.string().min(1).max(120), gameUrl: chessComUrl, date: day, timeClass: z.enum(['rapid', 'blitz']),
  ownerColor: z.enum(['w', 'b']), ply: z.number().int().min(1).max(2000), moveNumber: z.number().int().min(1).max(1000),
  fen: z.string().min(15).max(120), playedSan: z.string().min(1).max(12), playedUci: uci, bestSan: z.string().min(1).max(12), bestUci: uci,
  pvUci: z.array(uci).max(32), winBefore: finite.min(0).max(100), winAfter: finite.min(0).max(100), drop: finite.min(-100).max(100),
  cpBefore: finite.nullable().optional(), cpAfter: finite.nullable().optional(), mateBefore: z.number().int().nullable().optional(), mateAfter: z.number().int().nullable().optional(),
  judgement: z.enum(['inaccuracy', 'mistake', 'blunder']), phase: z.enum(['opening', 'middlegame', 'endgame']),
  motifs: z.array(z.string().min(1).max(80)).max(20), secondBestGap: finite.nullable().optional(), drillable: z.boolean(),
  clockBefore: finite.nonnegative().nullable().optional(), eco: z.string().max(12).nullable().optional(), opening: z.string().max(200).nullable().optional(),
  refutationPvUci: z.array(uci).max(32).optional(), moveSeconds: finite.nonnegative().nullable().optional(),
});
export const specialRow = positionRow.extend({ set: z.enum(['stalemate', 'conversion']), outcome: z.enum(['time', 'mated', 'other']).optional() });
export type PositionRow = z.infer<typeof positionRow>;
type SpecialRow = z.infer<typeof specialRow>;

/** `weakness_profile.json`. Core sections are required; the others are shown when present. */
export const weaknessProfile = z.object({
  schemaVersion: z.literal(1), generatedAt: z.string().max(40),
  sample: z.object({ games: count, from: day, to: day, timeClasses: z.array(z.string().max(20)).max(6), engine: z.string().max(160), depth: count, multipv: count, confirmDepth: count }),
  phaseRates: z.record(key, z.object({ ownerMoves: count, inaccuracies: count, mistakes: count, blunders: count, blundersPer100: finite, ci95: interval })),
  motifs: z.record(key, z.object({ count, per100Moves: finite, ci95: interval, weight: finite })),
  themePriors: z.record(key, finite),
  clock: z.array(z.object({ bucket: z.string().max(80), ownerMoves: count, blundersPer100: finite, ci95: interval })).max(60).optional(),
  // earlyBlunderRate is a share of games (0-1), as the producer writes it; earlyBlunderCi95 is its Wilson interval, when given.
  openings: z.array(z.object({ eco: z.string().max(12).nullable().optional(), name: z.string().max(200), color: z.enum(['w', 'b']), games: count, scorePct: finite.min(0).max(100), earlyBlunderRate: finite.min(0).max(1), earlyBlunderCi95: interval.optional() })).max(2000).optional(),
  conversion: z.object({ gamesWinningBy3: count, notWon: count, byOutcome: z.object({ time: count, mated: count, other: count }), notWonShareCi95: interval.optional() }).optional(),
  firstBlunderMove: z.object({ median: finite.nullable(), histogram: z.record(z.string().max(20), count) }).optional(),
});
export type WeaknessProfile = z.infer<typeof weaknessProfile>;

const packSet = z.enum(['mistake', 'stalemate', 'conversion']);
export type PackSet = z.infer<typeof packSet>;
/** One game in which the owner reached the card's position. */
const occurrence = z.object({ date: day, timeClass: z.enum(['rapid', 'blitz']), gameUrl: chessComUrl, moveNumber: z.number().int().min(1), playedSan: z.string().max(12) });
/** Card detail. The single-game fields describe the card's first source row; `occurrences` lists every game with this position. */
const packDetail = z.object({
  sets: z.array(packSet).min(1).max(3), outcome: z.enum(['time', 'mated', 'other']).optional(), occurrences: z.array(occurrence).min(1).max(MAX_OCCURRENCES),
  date: day, timeClass: z.enum(['rapid', 'blitz']), ownerColor: z.enum(['w', 'b']), ply: z.number().int().min(1), moveNumber: z.number().int().min(1),
  playedSan: z.string().max(12), playedUci: uci, bestSan: z.string().max(12), pvUci: z.array(uci).max(32), refutationPvUci: z.array(uci).max(32).optional(),
  drop: finite, judgement: z.enum(['inaccuracy', 'mistake', 'blunder']), phase: z.enum(['opening', 'middlegame', 'endgame']),
  motifs: z.array(z.string().max(80)).max(20), clockBefore: finite.nullable(), moveSeconds: finite.nullable(), opening: z.string().max(200).nullable(),
});
export type PackDetail = z.infer<typeof packDetail>;
const packCard = z.object({ id: z.string().regex(/^pack-[0-9a-f]{16}$/), fen: z.string().max(120), moves: z.array(uci).length(1), rating: finite, themes: z.array(key).min(1).max(10), gameUrl: chessComUrl, title: z.string().max(120), explanation: z.string().max(400), pack: packDetail });
export type PackCard = z.infer<typeof packCard>;
/**
 * A stalemate the owner delivered, shown as a study position: not graded and never scheduled, because won
 * positions rarely have one uniquely best move (producer README §Special sets).
 */
const studyItem = z.object({
  id: z.string().regex(/^study-[0-9a-f]{16}$/), set: z.literal('stalemate'), fen: z.string().max(120), ownerColor: z.enum(['w', 'b']),
  playedUci: uci, playedSan: z.string().max(12), bestUci: uci, bestSan: z.string().max(12), winBefore: finite.min(0).max(100),
  date: day, timeClass: z.enum(['rapid', 'blitz']), moveNumber: z.number().int().min(1), gameUrl: chessComUrl,
});
export type StudyItem = z.infer<typeof studyItem>;
const installedPack = z.object({
  kind: z.literal(PACK_KIND), schemaVersion: z.literal(1), installed: z.literal(true), importedAt: z.string().max(40),
  source: z.object({ files: z.record(z.string().max(80), z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: count })) }),
  profile: weaknessProfile, priors: z.record(key, finite), cards: z.array(packCard).max(5000), study: z.array(studyItem).max(500),
  counts: z.object({ rows: count, drillable: count, notDrillable: count, specialRows: count, specialDrillable: count, cards: count, mergedRows: count, stalemateCards: count, conversionCards: count, study: count, warnings: count }),
});
export type PersonalPack = z.infer<typeof installedPack>;
const stubPack = z.object({ kind: z.literal(PACK_KIND), schemaVersion: z.literal(1), installed: z.literal(false) });
export const STUB_PACK = { kind: PACK_KIND, schemaVersion: 1, installed: false } as const;

const move = (board: Chess, uciMove: string) => board.move({ from: uciMove.slice(0, 2), to: uciMove.slice(2, 4), promotion: uciMove[4] });

/** SAN for a UCI line from `fen`, stopping before the first illegal move. */
export function sanMoves(fen: string, line: readonly string[]): string[] {
  const board = new Chess(fen), out: string[] = [];
  for (const step of line) { try { out.push(move(board, step).san); } catch { break; } }
  return out;
}
/** Fen after one move, or null when the move is illegal. */
export function fenAfter(fen: string, uciMove: string): string | null {
  try { const board = new Chess(fen); move(board, uciMove); return board.fen(); } catch { return null; }
}
/** The position part of a FEN (placement, side, castling, en passant), so move counters do not split a position. */
export const positionKey = (fen: string) => fen.trim().split(/\s+/).slice(0, 4).join(' ');
/** Stable 16-hex-digit id (two FNV-1a 32-bit hashes). Pure JavaScript, so it runs in the browser bundle too. */
export function stableId(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 ^ 0x2f) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Longest legal prefix of a UCI line. */
function legalPrefix(fen: string, line: readonly string[]): string[] {
  return line.slice(0, sanMoves(fen, line).length);
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ENDING_PIECE: Record<string, string> = { p: 'pawnEndgame', r: 'rookEndgame', q: 'queenEndgame', b: 'bishopEndgame', n: 'knightEndgame' };
function endingTheme(fen: string): string | undefined {
  const officers = new Chess(fen).board().flat().filter(sq => sq !== null && sq.type !== 'k' && sq.type !== 'p');
  const kinds = new Set(officers.map(sq => sq!.type));
  if (kinds.size === 1) return ENDING_PIECE[[...kinds][0]];
  if (kinds.size === 0 && new Chess(fen).board().flat().some(sq => sq?.type === 'p')) return ENDING_PIECE.p;
  return undefined;
}

/** Engine settings that the card wording depends on (code review P2-2: claim a deeper check only when there was one). */
export type CheckDepth = { depth: number; confirmDepth: number };
const checkPhrase = ({ depth, confirmDepth }: CheckDepth) => confirmDepth > depth ? `it stayed clearly best on a deeper check (depth ${confirmDepth})` : `it was clearly best at depth ${depth}`;

/** Convert one validated, drillable row into a single-move practice card. Throws on illegal chess. */
export function cardFromRow(row: PositionRow | SpecialRow, warnings: string[] = [], check: CheckDepth = { depth: 0, confirmDepth: 0 }): PackCard {
  const board = new Chess(row.fen);
  if (board.turn() !== row.ownerColor) throw new Error('side to move differs from ownerColor');
  if (row.bestUci === row.playedUci) throw new Error('best move equals the played move');
  const bestSan = sanMoves(row.fen, [row.bestUci])[0], playedSan = sanMoves(row.fen, [row.playedUci])[0];
  if (!bestSan) throw new Error(`bestUci ${row.bestUci} is illegal`);
  if (!playedSan) throw new Error(`playedUci ${row.playedUci} is illegal`);
  let pvUci = legalPrefix(row.fen, row.pvUci);
  if (pvUci.length !== row.pvUci.length) warnings.push(`${row.id}: pvUci truncated at an illegal move`);
  if (pvUci.length && pvUci[0] !== row.bestUci) { warnings.push(`${row.id}: pvUci does not start with bestUci; line dropped`); pvUci = []; }
  const afterPlayed = fenAfter(row.fen, row.playedUci)!;
  const refutation = row.refutationPvUci ? legalPrefix(afterPlayed, row.refutationPvUci) : undefined;
  if (row.refutationPvUci && refutation!.length !== row.refutationPvUci.length) warnings.push(`${row.id}: refutationPvUci truncated at an illegal move`);
  if (row.moveNumber !== Math.ceil(row.ply / 2)) warnings.push(`${row.id}: moveNumber does not match ply`);
  const ending = row.phase === 'endgame' ? endingTheme(row.fen) : undefined;
  const source: PackSet = 'set' in row ? row.set : 'mistake';
  return {
    id: `pack-${stableId(`${positionKey(row.fen)}|${row.bestUci}`)}`, fen: row.fen, moves: [row.bestUci], rating: PACK_RATING,
    themes: ['personal', row.phase, ...(ending ? [ending] : [])], gameUrl: row.gameUrl,
    title: `${titleCase(row.timeClass)} · ${row.date} · move ${row.moveNumber}`,
    explanation: `You played ${playedSan}. The engine preferred ${bestSan}, and ${checkPhrase(check)}. By the engine's estimate, your move lowered your winning chances by about ${Math.round(row.drop)} points out of 100.`,
    pack: {
      sets: [source], ...('outcome' in row && row.outcome ? { outcome: row.outcome } : {}),
      occurrences: [{ date: row.date, timeClass: row.timeClass, gameUrl: row.gameUrl, moveNumber: row.moveNumber, playedSan }], date: row.date, timeClass: row.timeClass, ownerColor: row.ownerColor,
      ply: row.ply, moveNumber: row.moveNumber, playedSan, playedUci: row.playedUci, bestSan, pvUci,
      ...(refutation && refutation.length ? { refutationPvUci: refutation } : {}),
      drop: row.drop, judgement: row.judgement, phase: row.phase, motifs: row.motifs,
      clockBefore: row.clockBefore ?? null, moveSeconds: row.moveSeconds ?? null, opening: row.opening ?? null,
    },
  };
}

const clampPrior = (weight: number) => Math.min(PRIOR_MAX, Math.max(PRIOR_MIN, weight));
/** A theme the scheduler trains on. Metadata themes such as `equality` are never read by `weakness()`, so a prior on them would do nothing (code review P2-9). */
const trainable = (theme: string) => key.safeParse(theme).success && trainingThemes([theme]).length === 1;

/** Keep only usable theme weights, clamped to 0.5-2.5; 1 means no adjustment and is dropped, as are metadata themes. */
export function cleanPriors(themePriors: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [theme, weight] of Object.entries(themePriors)) if (trainable(theme) && Number.isFinite(weight) && weight > 0 && weight !== 1) out[theme] = clampPrior(weight);
  return out;
}

/** Validate one stalemate row as a study item. Throws when the stored move is illegal or does not stalemate. */
function studyFromRow(row: SpecialRow): StudyItem {
  const board = new Chess(row.fen);
  if (board.turn() !== row.ownerColor) throw new Error('side to move differs from ownerColor');
  const bestSan = sanMoves(row.fen, [row.bestUci])[0], playedSan = sanMoves(row.fen, [row.playedUci])[0];
  if (!playedSan) throw new Error(`playedUci ${row.playedUci} is illegal`);
  if (!bestSan) throw new Error(`bestUci ${row.bestUci} is illegal`);
  if (!new Chess(fenAfter(row.fen, row.playedUci)!).isStalemate()) throw new Error('the played move does not give stalemate');
  if (new Chess(fenAfter(row.fen, row.bestUci)!).isStalemate()) throw new Error('the engine move also gives stalemate');
  return {
    id: `study-${stableId(`${positionKey(row.fen)}|${row.playedUci}`)}`, set: 'stalemate', fen: row.fen, ownerColor: row.ownerColor,
    playedUci: row.playedUci, playedSan, bestUci: row.bestUci, bestSan, winBefore: row.winBefore,
    date: row.date, timeClass: row.timeClass, moveNumber: row.moveNumber, gameUrl: row.gameUrl,
  };
}

export type BuildInput = { profile: unknown; positions: string; special?: string; files?: Record<string, { sha256: string; bytes: number }>; skipInvalid?: boolean; importedAt?: string };
export type BuildReport = { errors: string[]; warnings: string[] };

function parseLines<T>(text: string, schema: z.ZodType<T>, label: string, errors: string[]): { line: number; row: T }[] {
  const rows: { line: number; row: T }[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (!raw.trim()) return;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { errors.push(`${label}:${index + 1}: not valid JSON`); return; }
    const parsed = schema.safeParse(value);
    if (parsed.success) rows.push({ line: index + 1, row: parsed.data });
    else errors.push(`${label}:${index + 1}: ${parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.') || 'row'} ${i.message}`).join('; ')}`);
  });
  return rows;
}

/**
 * Validate the producer's files and build the app's compact pack. Pure; the import script does the file IO.
 * One card per position (first four FEN fields): rows that reach the same position merge into one card that lists
 * every source set and game, so a position is scheduled and counted once (review R2, code review P1-2, P1-4, P2-11).
 * Every stalemate row, drillable or not, also becomes an ungraded study item.
 */
export function buildPack(input: BuildInput): { pack: PersonalPack; report: BuildReport } {
  const errors: string[] = [], warnings: string[] = [];
  const profile = weaknessProfile.safeParse(input.profile);
  if (!profile.success) throw new Error(`weakness_profile.json: ${profile.error.issues.slice(0, 5).map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  const check = { depth: profile.data.sample.depth, confirmDepth: profile.data.sample.confirmDepth };
  const rows = parseLines(input.positions, positionRow, 'mistake_positions.jsonl', errors);
  const specialRows = input.special ? parseLines(input.special, specialRow, 'special_sets.jsonl', errors) : [];
  const seen = new Set<string>(), byPosition = new Map<string, PackCard>(), study: StudyItem[] = [], studyIds = new Set<string>();
  let mergedRows = 0;
  const convert = (entries: { line: number; row: PositionRow | SpecialRow }[], label: string) => {
    for (const { line, row } of entries) {
      const id = `${'set' in row ? row.set : 'mistake'}:${row.id}`;
      if (seen.has(id)) { errors.push(`${label}:${line}: duplicate id ${row.id}`); continue; }
      seen.add(id);
      if ('set' in row && row.set === 'stalemate') {
        try {
          const item = studyFromRow(row);
          if (studyIds.has(item.id)) warnings.push(`${row.id}: same stalemate position and move as an earlier row; study item kept once`);
          else { studyIds.add(item.id); study.push(item); }
        } catch (cause) { errors.push(`${label}:${line}: ${cause instanceof Error ? cause.message : 'invalid position'}`); continue; }
      }
      if (!row.drillable) continue;
      let card: PackCard;
      try { card = cardFromRow(row, warnings, check); } catch (cause) { errors.push(`${label}:${line}: ${cause instanceof Error ? cause.message : 'invalid position'}`); continue; }
      const position = positionKey(row.fen), existing = byPosition.get(position);
      if (!existing) { byPosition.set(position, card); continue; }
      // Same position: one card. Rule for a different best move (none in the 2026-11-10 data): the first row's move is kept.
      if (existing.moves[0] !== card.moves[0]) { warnings.push(`${row.id}: same position as an earlier card with a different best move; the earlier move is kept`); continue; }
      mergedRows++;
      const detail = existing.pack, set = card.pack.sets[0];
      if (!detail.sets.includes(set)) detail.sets.push(set);
      if (!detail.outcome && card.pack.outcome) detail.outcome = card.pack.outcome;
      const occurrence = card.pack.occurrences[0];
      if (detail.occurrences.length < MAX_OCCURRENCES && !detail.occurrences.some(o => o.gameUrl === occurrence.gameUrl && o.moveNumber === occurrence.moveNumber)) detail.occurrences.push(occurrence);
      existing.themes = [...new Set([...existing.themes, ...card.themes])].slice(0, 10);
    }
  };
  convert(rows, 'mistake_positions.jsonl');
  convert(specialRows, 'special_sets.jsonl');
  if (errors.length && !input.skipInvalid) throw new Error(`${errors.length} invalid row(s). First: ${errors.slice(0, 10).join(' | ')}`);
  const cards = [...byPosition.values()];
  for (const card of cards) card.pack.occurrences.sort((a, b) => b.date.localeCompare(a.date) || a.gameUrl.localeCompare(b.gameUrl));
  const pack: PersonalPack = {
    kind: PACK_KIND, schemaVersion: 1, installed: true, importedAt: input.importedAt ?? new Date().toISOString(),
    source: { files: input.files ?? {} }, profile: profile.data, priors: cleanPriors(profile.data.themePriors), cards, study,
    counts: {
      rows: rows.length, drillable: rows.filter(r => r.row.drillable).length, notDrillable: rows.filter(r => !r.row.drillable).length,
      specialRows: specialRows.length, specialDrillable: specialRows.filter(r => r.row.drillable).length, cards: cards.length, mergedRows,
      stalemateCards: cards.filter(c => c.pack.sets.includes('stalemate')).length, conversionCards: cards.filter(c => c.pack.sets.includes('conversion')).length,
      study: study.length, warnings: warnings.length,
    },
  };
  readPack(pack);
  return { pack, report: { errors, warnings } };
}

/** Validate an installed pack (structure and legal first moves). Returns null for the stub. Throws when invalid. */
export function readPack(input: unknown): PersonalPack | null {
  if (stubPack.safeParse(input).success) return null;
  const pack = installedPack.parse(input);
  const ids = new Set<string>(), positions = new Set<string>();
  for (const card of pack.cards) {
    if (ids.has(card.id)) throw new Error(`Duplicate pack card ${card.id}.`);
    if (positions.has(positionKey(card.fen))) throw new Error(`Pack card ${card.id} repeats a position.`);
    ids.add(card.id); positions.add(positionKey(card.fen));
    if (!sanMoves(card.fen, card.moves).length) throw new Error(`Pack card ${card.id} has an illegal move.`);
    if (new Chess(card.fen).turn() !== card.pack.ownerColor) throw new Error(`Pack card ${card.id} has the wrong side to move.`);
  }
  for (const item of pack.study) {
    if (ids.has(item.id)) throw new Error(`Duplicate study item ${item.id}.`);
    ids.add(item.id);
    if (new Chess(item.fen).turn() !== item.ownerColor) throw new Error(`Study item ${item.id} has the wrong side to move.`);
    const after = fenAfter(item.fen, item.playedUci);
    if (!after || !new Chess(after).isStalemate() || !fenAfter(item.fen, item.bestUci)) throw new Error(`Study item ${item.id} does not match its moves.`);
  }
  return pack;
}

/** Fetch the installed pack. Missing, stub or invalid packs all mean "no pack" and leave the app unchanged. */
export async function loadPersonalPack(fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<PersonalPack | null> {
  try {
    const response = await fetcher(PACK_URL, { cache: 'no-cache' });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return null;
    return readPack(await response.json());
  } catch (cause) {
    console.warn('The personal pack was not loaded.', cause instanceof Error ? cause.message : cause);
    return null;
  }
}

/** The pack's detail block, when a practice card came from the pack. */
export function packDetailOf(card: PersonalPuzzle | null | undefined): PackDetail | undefined {
  return (card as Partial<PackCard> | null | undefined)?.pack;
}

/**
 * Selection-only view of progress with theme priors as pseudo-attempts (m = 8, the spec §3 v2 constant):
 * a theme with weight w (clamped to 0.5-2.5) gets 8 attempts at a failure rate of w/(1+w), so w = 1 is
 * neutral (0.5, the scheduler's value for an unseen theme), 2.5 gives 0.71 and 0.5 gives 0.33, and the
 * order of the producer's weights is kept. Real attempts outweigh it as they accumulate. This is a
 * selection nudge, not the spec §3 v2 skill estimate (judgement call; see the fix-pass log).
 * Never store or validate the result; with no priors it returns `progress` itself.
 */
export function withThemePriors<P extends { skills: Record<string, { attempts: number; successes: number; lastAttempt: number }> }>(progress: P, priors: Record<string, number> | null | undefined): P {
  const entries = Object.entries(priors ?? {}).filter(([theme, weight]) => trainable(theme) && Number.isFinite(weight) && weight > 0 && weight !== 1);
  if (!entries.length) return progress;
  const skills = { ...progress.skills };
  for (const [theme, weight] of entries) {
    const w = clampPrior(weight), failure = w / (1 + w);
    const old = skills[theme] ?? { attempts: 0, successes: 0, lastAttempt: 0 };
    Object.defineProperty(skills, theme, { value: { ...old, attempts: old.attempts + PRIOR_PSEUDO_ATTEMPTS, successes: old.successes + PRIOR_PSEUDO_ATTEMPTS * (1 - failure) }, enumerable: true, configurable: true, writable: true });
  }
  return { ...progress, skills };
}

/**
 * Practice pools. Pack cards join "From my games", the one-in-four own-game slot of mixed
 * practice and the review queue; they do not enter mixed practice's general new-material pool.
 * With no pack: `all` and `mixed` hold the same puzzles and `own` is the stored personal list.
 */
export function practicePools<T extends { id: string }>(stored: T[], pack: T[], bank: T[]): { all: T[]; mixed: T[]; own: T[] } {
  const mixed = [...stored, ...bank];
  return pack.length ? { all: [...stored, ...pack, ...bank], mixed, own: [...stored, ...pack] } : { all: mixed, mixed, own: stored };
}
