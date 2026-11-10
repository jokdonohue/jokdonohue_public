/**
 * Personal pack -> artifact database documents (port plan sections 2, 3 and 10 items a and h).
 *
 * Pure and deterministic: the same producer files give byte-identical documents (no wall clock; the version
 * and every timestamp derive from the inputs or an explicit `at`). `scripts/pack-to-docs.mjs` does the file IO.
 *
 * Card ids (stable across refreshes so attempt history keeps applying):
 * - one card per position (first four FEN fields), as the Site loader does;
 * - id = `pack-<gameId>:<ply>` of the position's CANONICAL row: the oldest row (date, then game id, then ply).
 *   New games are always newer, so a weekly refresh never changes the canonical row of an existing position;
 * - `previousIds` (positionKey -> id, read from the previous seed) wins over the rule, so even a sample that
 *   grows backwards in time keeps every id it already issued;
 * - "punish it" cards (item a) use their own namespace `punish-<gameId>:<ply>` so their attempts never merge
 *   into the original card's schedule; stalemate study items use `study-<gameId>:<ply>`;
 * - each card carries `siteId`, the id the Site loader (app/lib/personal-pack.ts) gives the same position
 *   (`pack-<stableId(positionKey|bestUci)>`), and `aliases`, the other producer rows merged into it.
 */
import { Chess } from 'chess.js';
import {
  assertDocSize, CARDS_PER_CHUNK, docBytes, MAX_DOC_BYTES, paths, schemaForPath, type PackPart,
} from '../contract/docs';
import { stableId } from '../coach/hash';

/** Byte budget per chunk: under the 180 KiB document cap with room for growth (plan section 2: 120-150 KiB). */
export const CHUNK_BYTE_BUDGET = 150 * 1024;
export const PACK_RATING = 1000;
const MAX_OCCURRENCES = 50;
const PRIOR_MIN = 0.5, PRIOR_MAX = 2.5;

type Color = 'w' | 'b';
export interface Row {
  id: string; gameUrl: string; date: string; timeClass: 'rapid' | 'blitz'; ownerColor: Color; ply: number; moveNumber: number;
  fen: string; playedSan: string; playedUci: string; bestSan: string; bestUci: string; pvUci: string[];
  winBefore: number; winAfter: number; drop: number; cpBefore?: number | null; cpAfter?: number | null;
  mateBefore?: number | null; mateAfter?: number | null; judgement: 'inaccuracy' | 'mistake' | 'blunder';
  phase: 'opening' | 'middlegame' | 'endgame'; motifs: string[]; secondBestGap?: number | null; drillable: boolean;
  clockBefore?: number | null; moveSeconds?: number | null; eco?: string | null; opening?: string | null;
  refutationPvUci?: string[]; set?: 'stalemate' | 'conversion'; outcome?: 'time' | 'mated' | 'other';
}
type SetName = 'mistake' | 'stalemate' | 'conversion';

export interface PackInput {
  /** Parsed `weakness_profile.json`. */
  profile: Record<string, unknown>;
  /** Raw text of `mistake_positions.jsonl` and `special_sets.jsonl`. */
  positions: string;
  special: string;
  /** Parsed `run_manifest.json`, for reconciliation (optional). */
  manifest?: Record<string, unknown> | null;
  /** Override for `importedAt` (ISO string); default `profile.generatedAt`. */
  at?: string;
  /** positionKey -> card id from a previous pack (see `previousIdsFromDocs`); keyed `<part>|<positionKey>`. */
  previousIds?: Record<string, string>;
  /**
   * Engine evaluations of the positions after his moves (positionKey -> AfterEval), from the bulk pass
   * (`cache/positions_d14_mpv2.jsonl`, deeper `positions_d18_mpv2.jsonl` when present). A punish card is graded
   * only when its after-position passes `punishGrade`; without an evaluation it is kept as a study item.
   */
  afterEvals?: Record<string, AfterEval>;
}
export interface PackOutput {
  packVersion: string;
  /** Document path -> body, chunks first and `pack/meta` LAST (write order). */
  docs: Array<{ path: string; data: Record<string, unknown> }>;
  counts: Record<string, number>;
  reconcile: { ok: boolean; checked: number; diffs: string[] };
  warnings: string[];
}

// ---------------------------------------------------------------- chess helpers

const playUci = (board: Chess, uci: string) => board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
/** SAN for a UCI line from `fen`, stopping before the first illegal move. */
export function sanLine(fen: string, line: readonly string[]): string[] {
  const out: string[] = [];
  let board: Chess;
  try { board = new Chess(fen); } catch { return out; }
  for (const step of line) { try { out.push(playUci(board, step).san); } catch { break; } }
  return out;
}
export function fenAfter(fen: string, uci: string): string | null {
  try { const b = new Chess(fen); playUci(b, uci); return b.fen(); } catch { return null; }
}
export const positionKey = (fen: string) => fen.trim().split(/\s+/).slice(0, 4).join(' ');
const legalPrefix = (fen: string, line: readonly string[]) => line.slice(0, sanLine(fen, line).length);
/** The Site loader's id for the same card (app/lib/personal-pack.ts `cardFromRow`). */
export const siteCardId = (fen: string, bestUci: string) => `pack-${stableId(`${positionKey(fen)}|${bestUci}`)}`;
export const siteStudyId = (fen: string, playedUci: string) => `study-${stableId(`${positionKey(fen)}|${playedUci}`)}`;

const ENDING_PIECE: Record<string, string> = { p: 'pawnEndgame', r: 'rookEndgame', q: 'queenEndgame', b: 'bishopEndgame', n: 'knightEndgame' };
function endingTheme(fen: string): string | undefined {
  const squares = new Chess(fen).board().flat();
  const kinds = new Set(squares.filter(sq => sq && sq.type !== 'k' && sq.type !== 'p').map(sq => sq!.type));
  if (kinds.size === 1) return ENDING_PIECE[[...kinds][0]];
  if (kinds.size === 0 && squares.some(sq => sq?.type === 'p')) return ENDING_PIECE.p;
  return undefined;
}
/** Code-unit string order: independent of the ICU build, unlike localeCompare. */
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- row parsing

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ROW_ID = /^\d+:\d+$/;
function checkRow(r: Row, label: string): string | null {
  if (typeof r !== 'object' || r === null) return `${label}: not an object`;
  if (typeof r.id !== 'string' || !ROW_ID.test(r.id)) return `${label}: id is not <gameId>:<ply>`;
  if (typeof r.fen !== 'string' || r.fen.length < 15) return `${label}: fen`;
  if (!UCI.test(r.playedUci) || !UCI.test(r.bestUci)) return `${label}: playedUci/bestUci`;
  if (!Array.isArray(r.pvUci) || !r.pvUci.every(m => UCI.test(m))) return `${label}: pvUci`;
  if (r.refutationPvUci !== undefined && (!Array.isArray(r.refutationPvUci) || !r.refutationPvUci.every(m => UCI.test(m)))) return `${label}: refutationPvUci`;
  if (!DAY.test(r.date) || !['rapid', 'blitz'].includes(r.timeClass) || !['w', 'b'].includes(r.ownerColor)) return `${label}: date/timeClass/ownerColor`;
  if (!['inaccuracy', 'mistake', 'blunder'].includes(r.judgement) || !['opening', 'middlegame', 'endgame'].includes(r.phase)) return `${label}: judgement/phase`;
  if (typeof r.drillable !== 'boolean' || !Number.isFinite(r.winBefore) || !Number.isFinite(r.winAfter) || !Number.isFinite(r.drop)) return `${label}: numbers`;
  if (typeof r.gameUrl !== 'string' || !/^https:\/\/(www\.)?chess\.com\/\S*$/.test(r.gameUrl)) return `${label}: gameUrl`;
  return null;
}
export function parseRows(text: string, label: string, errors: string[]): Row[] {
  const rows: Row[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    let row: Row;
    try { row = JSON.parse(raw) as Row; } catch { errors.push(`${label}:${i + 1}: not JSON`); return; }
    const problem = checkRow(row, `${label}:${i + 1}`);
    if (problem) errors.push(problem); else rows.push(row);
  });
  return rows;
}

/** Canonical order: oldest first (date, then numeric game id, then ply). */
const gameNum = (id: string) => Number(id.split(':')[0]);
const plyNum = (id: string) => Number(id.split(':')[1]);
export function olderFirst(a: Row, b: Row): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : gameNum(a.id) - gameNum(b.id) || plyNum(a.id) - plyNum(b.id);
}

// ---------------------------------------------------------------- cards

interface Group { key: string; rows: Array<{ row: Row; set: SetName }> }
function groupBy(entries: Array<{ row: Row; set: SetName }>, keyOf: (row: Row) => string | null): Group[] {
  const map = new Map<string, Group>();
  for (const e of entries) {
    const key = keyOf(e.row);
    if (key === null) continue;
    const g = map.get(key) ?? { key, rows: [] };
    g.rows.push(e);
    map.set(key, g);
  }
  for (const g of map.values()) g.rows.sort((x, y) => olderFirst(x.row, y.row) || cmp(x.set, y.set));
  return [...map.values()];
}

function occurrences(group: Group) {
  const seen = new Set<string>();
  const out: Array<{ date: string; timeClass: string; gameUrl: string; moveNumber: number; playedSan: string }> = [];
  for (const { row } of group.rows) {
    const k = `${row.gameUrl}|${row.moveNumber}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ date: row.date, timeClass: row.timeClass, gameUrl: row.gameUrl, moveNumber: row.moveNumber, playedSan: sanLine(row.fen, [row.playedUci])[0] ?? row.playedSan });
  }
  return out.sort((a, b) => cmp(b.date, a.date) || cmp(a.gameUrl, b.gameUrl)).slice(0, MAX_OCCURRENCES);
}
const uniqueSets = (group: Group): SetName[] => {
  const order: SetName[] = ['mistake', 'conversion', 'stalemate'];
  const have = new Set(group.rows.map(r => r.set));
  return order.filter(s => have.has(s));
};
const evals = (row: Row) => ({
  winBefore: row.winBefore, winAfter: row.winAfter, cpBefore: row.cpBefore ?? null, cpAfter: row.cpAfter ?? null,
  mateBefore: row.mateBefore ?? null, mateAfter: row.mateAfter ?? null,
});

/** The drill card for a position: the app's PackCard shape (`pack` detail included) plus kind, siteId, aliases. */
function mistakeCard(group: Group, id: string, check: { depth: number; confirmDepth: number }, warnings: string[]): Record<string, unknown> | null {
  const { row } = group.rows[0];
  const board = new Chess(row.fen);
  if (board.turn() !== row.ownerColor) { warnings.push(`${row.id}: side to move differs from ownerColor; skipped`); return null; }
  if (row.bestUci === row.playedUci) { warnings.push(`${row.id}: best move equals the played move; skipped`); return null; }
  const bestSan = sanLine(row.fen, [row.bestUci])[0], playedSan = sanLine(row.fen, [row.playedUci])[0];
  if (!bestSan || !playedSan) { warnings.push(`${row.id}: illegal best or played move; skipped`); return null; }
  for (const other of group.rows.slice(1)) if (other.row.bestUci !== row.bestUci) warnings.push(`${other.row.id}: same position as ${row.id} with a different best move; ${row.id}'s move is kept`);
  let pvUci = legalPrefix(row.fen, row.pvUci);
  if (pvUci.length && pvUci[0] !== row.bestUci) { warnings.push(`${row.id}: pvUci does not start with bestUci; line dropped`); pvUci = []; }
  const after = fenAfter(row.fen, row.playedUci)!;
  const refutation = row.refutationPvUci ? legalPrefix(after, row.refutationPvUci) : [];
  const ending = row.phase === 'endgame' ? endingTheme(row.fen) : undefined;
  const sets = uniqueSets(group);
  const outcome = group.rows.find(r => r.row.outcome)?.row.outcome;
  const checkPhrase = check.confirmDepth > check.depth ? `it stayed clearly best on a deeper check (depth ${check.confirmDepth})` : `it was clearly best at depth ${check.depth}`;
  return {
    id, kind: sets.includes('mistake') ? 'mistake' : sets[0], fen: row.fen, moves: [row.bestUci], rating: PACK_RATING,
    themes: ['personal', row.phase, ...(ending ? [ending] : [])], gameUrl: row.gameUrl,
    title: `${titleCase(row.timeClass)} · ${row.date} · move ${row.moveNumber}`,
    // Wording mirrors the Site loader's card text; "engine's estimate" follows the producer README's Limits note.
    explanation: `You played ${playedSan}. The engine preferred ${bestSan}, and ${checkPhrase}. By the engine's estimate, your move lowered your winning chances by about ${Math.round(row.drop)} points out of 100.`,
    siteId: siteCardId(row.fen, row.bestUci),
    aliases: group.rows.slice(1).map(r => `${r.set}:${r.row.id}`),
    pack: {
      sets, ...(outcome ? { outcome } : {}), occurrences: occurrences(group), rowId: row.id,
      date: row.date, timeClass: row.timeClass, ownerColor: row.ownerColor, ply: row.ply, moveNumber: row.moveNumber,
      playedSan, playedUci: row.playedUci, bestSan, pvUci, ...(refutation.length ? { refutationPvUci: refutation } : {}),
      drop: row.drop, judgement: row.judgement, phase: row.phase, motifs: row.motifs,
      clockBefore: row.clockBefore ?? null, moveSeconds: row.moveSeconds ?? null, opening: row.opening ?? null, ...evals(row),
    },
  };
}

// ---------------------------------------------------------------- punish-it uniqueness

/** The producer's `drillable` constants (reviews/claude/tools/engine_pass/finalize.mjs). */
export const UNIQUE_GAP = 10, DECIDED_LO = 5, DECIDED_HI = 95;
const CEIL = 1000, MULT = 0.00368208;
const winPct = (cp: number) => { const c = Math.max(-CEIL, Math.min(CEIL, cp)); return 50 + 50 * (2 / (1 + Math.exp(-MULT * c)) - 1); };
/** Win% for the side to move of one engine line score `{cp, mate}` (mate counts as +/-1000 cp, as in the producer). */
export const lineWin = (sc: { cp?: number | null; mate?: number | null }) =>
  sc.mate !== null && sc.mate !== undefined ? winPct(sc.mate > 0 ? CEIL : -CEIL) : winPct(sc.cp ?? 0);

/** What the punish grading needs about an after-position (side to move = the solver). */
export interface AfterEval {
  /** Engine best move at the bulk depth (14), for the "held up" check. */
  best14: string | null;
  /** Win% gap between best and second-best line for the solver; null when only one line exists. */
  gap: number | null;
  /** Depth the gap comes from (18 when a deeper MultiPV 2 search exists, else 14). */
  gapDepth: number;
}
type CacheEntry = { bm?: string | null; d?: number; l?: Array<{ s: { cp?: number | null; mate?: number | null } }> } | undefined;
/** AfterEval from a bulk-pass cache entry and an optional deeper MultiPV 2 entry for the same position. */
export function afterEvalFromCache(e14: CacheEntry, e18mpv2?: CacheEntry): AfterEval | null {
  if (!e14 || !e14.l?.length) return null;
  const deep = e18mpv2 && (e18mpv2.l?.length ?? 0) >= 2 ? e18mpv2 : null;
  const src = deep ?? e14;
  const lines = src.l ?? [];
  const gap = lines.length >= 2 ? Math.round((lineWin(lines[0].s) - lineWin(lines[1].s)) * 100) / 100 : null;
  return { best14: e14.bm ?? null, gap, gapDepth: deep ? (deep.d ?? 18) : (e14.d ?? 14) };
}

export type PunishWhy = 'unique' | 'no-eval' | 'not-held' | 'not-unique' | 'decided';
/**
 * The producer's `drillableOf` rule applied to the position after his move, with his opponent as the solver:
 * 1. held up: the stored reply (depth-18 MultiPV 1 search) equals the depth-14 best move there;
 * 2. clearly unique: the second-best reply is at least 10 Win% points worse (`gap >= 10`; depth 18 when a
 *    MultiPV 2 search exists at that depth, else depth 14: the after-positions were never searched at depth 18
 *    with two lines, so the uniqueness check is one depth shallower than the producer's);
 * 3. not decided: a forced mate for the solver counts as not decided (finding it is the lesson), a forced mate
 *    against the solver as decided; otherwise 5 < solver Win% < 95, from the stored depth-18 values.
 * Only "unique" cards are graded recall; the rest are ungraded study items.
 */
export function punishGrade(row: Row, reply: string, ev: AfterEval | null | undefined): PunishWhy {
  if (!ev) return 'no-eval';
  if (ev.best14 !== reply) return 'not-held';
  if (ev.gap === null || ev.gap < UNIQUE_GAP) return 'not-unique';
  const solverMate = row.mateAfter === null || row.mateAfter === undefined ? null : -row.mateAfter;
  if (solverMate !== null) return solverMate > 0 ? 'unique' : 'decided';
  const solverWin = 100 - row.winAfter;
  return solverWin > DECIDED_LO && solverWin < DECIDED_HI ? 'unique' : 'decided';
}

/**
 * Item a, "punish it": the position after his move, opponent to move; the answer is the first move of the
 * stored refutation. Pedagogy: C1 (Heisman's "what does that allow?" safety check), B6 (errors come from
 * missing one cue) and A6 (pattern store) in reviews/claude/evidence_base.md.
 * Judgement call: the after-position was searched with MultiPV 1 only, so the reply is the engine's best but
 * is not checked for uniqueness; another winning reply would be marked as differing from the stored line.
 */
function punishCard(group: Group, id: string, warnings: string[]): Record<string, unknown> | null {
  const { row } = group.rows[0];
  const after = fenAfter(row.fen, row.playedUci);
  if (!after) return null;
  const line = legalPrefix(after, row.refutationPvUci ?? []);
  if (!line.length) return null;
  const board = new Chess(after);
  if (board.isGameOver()) return null;
  if (line.length !== (row.refutationPvUci ?? []).length) warnings.push(`${row.id}: refutationPvUci truncated at an illegal move`);
  const lineSan = sanLine(after, line);
  const playedSan = sanLine(row.fen, [row.playedUci])[0] ?? row.playedSan;
  const opponent: Color = row.ownerColor === 'w' ? 'b' : 'w';
  return {
    id, kind: 'punish', fen: after, moves: [line[0]], rating: PACK_RATING,
    themes: ['personal', 'punish', row.phase], gameUrl: row.gameUrl,
    title: `Punish it · ${titleCase(row.timeClass)} · ${row.date} · move ${row.moveNumber}`,
    explanation: `In your game you played ${playedSan} here. Your opponent's best reply was ${lineSan[0]}${lineSan.length > 1 ? ` (engine line: ${lineSan.join(' ')})` : ''}. Before each move, ask what it allows.`,
    siteId: `punish-${stableId(`${positionKey(after)}|${line[0]}`)}`,
    aliases: group.rows.slice(1).map(r => `${r.set}:${r.row.id}`),
    pack: {
      sets: uniqueSets(group), occurrences: occurrences(group), rowId: row.id, sourceFen: row.fen,
      date: row.date, timeClass: row.timeClass, ownerColor: row.ownerColor, solverColor: opponent, ply: row.ply, moveNumber: row.moveNumber,
      playedSan, playedUci: row.playedUci, bestSan: lineSan[0], pvUci: line,
      drop: row.drop, judgement: row.judgement, phase: row.phase, motifs: row.motifs,
      clockBefore: row.clockBefore ?? null, moveSeconds: row.moveSeconds ?? null, opening: row.opening ?? null, ...evals(row),
    },
  };
}

/**
 * An ungraded "punish it" study item: shown as a worked example (position, his move, the engine's reply and
 * line), never graded and never scheduled. Same id as the card it would be, so history stays keyed if a later
 * refresh promotes it. Rationale: a reply that is not clearly unique cannot be graded fairly (lead, 2026-11-10);
 * studying a worked example is A8 in reviews/claude/evidence_base.md.
 */
function punishStudyItem(card: Record<string, unknown>, why: PunishWhy, ev: AfterEval | null | undefined): Record<string, unknown> {
  const d = card.pack as Record<string, unknown>;
  const line = d.pvUci as string[];
  return {
    id: card.id, set: 'punish', graded: false, why, gap: ev?.gap ?? null, gapDepth: ev?.gapDepth ?? null,
    fen: card.fen, sourceFen: d.sourceFen, ownerColor: d.ownerColor, solverColor: d.solverColor,
    playedUci: d.playedUci, playedSan: d.playedSan, replyUci: line[0], replySan: d.bestSan, lineUci: line, lineSan: sanLine(String(card.fen), line),
    title: card.title, explanation: card.explanation, themes: card.themes, siteId: card.siteId, aliases: card.aliases,
    date: d.date, timeClass: d.timeClass, moveNumber: d.moveNumber, gameUrl: card.gameUrl,
  };
}

/** Stalemate study item (ungraded; producer README "Special sets"). Throws on a row that does not stalemate. */
function studyItem(row: Row, id: string): Record<string, unknown> {
  const board = new Chess(row.fen);
  if (board.turn() !== row.ownerColor) throw new Error(`${row.id}: side to move differs from ownerColor`);
  const playedSan = sanLine(row.fen, [row.playedUci])[0], bestSan = sanLine(row.fen, [row.bestUci])[0];
  if (!playedSan || !bestSan) throw new Error(`${row.id}: illegal played or best move`);
  if (!new Chess(fenAfter(row.fen, row.playedUci)!).isStalemate()) throw new Error(`${row.id}: the played move does not give stalemate`);
  return {
    id, set: 'stalemate', fen: row.fen, ownerColor: row.ownerColor, playedUci: row.playedUci, playedSan, bestUci: row.bestUci, bestSan,
    winBefore: row.winBefore, date: row.date, timeClass: row.timeClass, moveNumber: row.moveNumber, gameUrl: row.gameUrl,
    siteId: siteStudyId(row.fen, row.playedUci),
  };
}

// ---------------------------------------------------------------- priors, chunks, version

/** The producer's theme priors as the Site loader cleans them: weights of exactly 1 dropped, the rest clamped to 0.5-2.5. */
export function cleanPriors(themePriors: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [theme, w] of Object.entries((themePriors ?? {}) as Record<string, unknown>).sort(([a], [b]) => cmp(a, b))) {
    if (typeof w === 'number' && Number.isFinite(w) && w > 0 && w !== 1) out[theme] = Math.min(PRIOR_MAX, Math.max(PRIOR_MIN, w));
  }
  return out;
}

/**
 * Fill chunks greedily: graded cards first, then ungraded study items, at most CARDS_PER_CHUNK cards,
 * STUDY_PER_CHUNK study items and CHUNK_BYTE_BUDGET bytes per chunk.
 */
export const STUDY_PER_CHUNK = 500;
export function chunkCards(packVersion: string, part: PackPart, cards: Array<Record<string, unknown>>, study: Array<Record<string, unknown>> = []) {
  const chunks: Array<{ path: string; id: string; data: Record<string, unknown> }> = [];
  let cur: { cards: Array<Record<string, unknown>>; study: Array<Record<string, unknown>> } = { cards: [], study: [] };
  const make = (c: typeof cur) => ({ packVersion, part, cards: c.cards, ...(c.study.length ? { study: c.study } : {}) });
  const flush = () => {
    const n = chunks.length;
    chunks.push({ path: paths.packChunk(packVersion, part, n), id: `${packVersion}-${part}-${String(n).padStart(2, '0')}`, data: make(cur) });
    cur = { cards: [], study: [] };
  };
  const add = (item: Record<string, unknown>, into: 'cards' | 'study') => {
    const next = { ...cur, [into]: [...cur[into], item] };
    const full = into === 'cards' ? next.cards.length > CARDS_PER_CHUNK : next.study.length > STUDY_PER_CHUNK;
    if ((cur.cards.length || cur.study.length) && (full || docBytes(make(next)) > CHUNK_BYTE_BUDGET)) flush();
    cur[into].push(item);
  };
  for (const card of cards) add(card, 'cards');
  for (const item of study) add(item, 'study');
  if (cur.cards.length || cur.study.length) flush();
  return chunks;
}

/** Version string from the content: `p<yyyymmdd of generatedAt>-<8 hex of the inputs>`. */
export function packVersionOf(input: PackInput): string {
  const day = String(input.profile.generatedAt ?? '').slice(0, 10).replace(/-/g, '');
  const h = stableId(`${stableId(JSON.stringify(input.profile))}|${stableId(input.positions)}|${stableId(input.special)}`).slice(0, 8);
  return `p${/^\d{8}$/.test(day) ? day : '00000000'}-${h}`;
}

/** Map `<part>|<positionKey>` -> id from previously written pack chunk bodies, for `PackInput.previousIds`. */
export function previousIdsFromDocs(chunks: Array<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of chunks) {
    // Accept a bare body or a snapshot file that wraps it as `{data: body}`.
    const chunk = (Array.isArray(raw.cards) || Array.isArray(raw.study) ? raw : (raw.data as Record<string, unknown> | undefined) ?? raw);
    for (const card of (chunk.cards as Array<{ id: string; fen: string; kind?: string }> | undefined) ?? []) {
      if (card.kind === 'safe' || card.kind === 'unsafe') continue; // "Safe or not?" ids are per move, not per position
      const ns = card.kind === 'punish' ? 'punish' : 'card';
      out[`${ns}|${positionKey(card.fen)}`] = card.id;
    }
    for (const item of (chunk.study as Array<{ id: string; fen: string; set?: string }> | undefined) ?? []) out[`${item.set === 'punish' ? 'punish' : 'study'}|${positionKey(item.fen)}`] = item.id;
  }
  return out;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
function dig(obj: unknown, path: string[]): unknown {
  return path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

// ---------------------------------------------------------------- main

export function buildPackDocs(input: PackInput): PackOutput {
  const errors: string[] = [], warnings: string[] = [];
  const rows = parseRows(input.positions, 'mistake_positions.jsonl', errors);
  const special = parseRows(input.special, 'special_sets.jsonl', errors);
  for (const r of special) if (r.set !== 'stalemate' && r.set !== 'conversion') errors.push(`special_sets.jsonl ${r.id}: set must be stalemate or conversion`);
  const ids = new Set<string>();
  for (const r of rows) { if (ids.has(r.id)) errors.push(`mistake_positions.jsonl: duplicate id ${r.id}`); ids.add(r.id); }
  const specialIds = new Set<string>();
  for (const r of special) { const k = `${r.set}:${r.id}`; if (specialIds.has(k)) errors.push(`special_sets.jsonl: duplicate id ${k}`); specialIds.add(k); }
  if (errors.length) throw new Error(`${errors.length} invalid row(s). First: ${errors.slice(0, 5).join(' | ')}`);

  const sample = (input.profile.sample ?? {}) as Record<string, unknown>;
  const check = { depth: num(sample.depth) ?? 0, confirmDepth: num(sample.confirmDepth) ?? 0 };
  const packVersion = packVersionOf(input);
  const prev = input.previousIds ?? {};
  const entries = [
    ...rows.map(row => ({ row, set: 'mistake' as SetName })),
    ...special.map(row => ({ row, set: row.set as SetName })),
  ];
  const drillable = entries.filter(e => e.row.drillable);

  // Drill cards: one per position.
  const used = new Set<string>();
  const claim = (id: string, label: string) => { if (used.has(id)) throw new Error(`duplicate card id ${id} (${label})`); used.add(id); return id; };
  const cardsMain: Array<Record<string, unknown>> = [], cardsSpecial: Array<Record<string, unknown>> = [];
  for (const group of groupBy(drillable, r => positionKey(r.fen))) {
    const id = prev[`card|${group.key}`] ?? `pack-${group.rows[0].row.id}`;
    const card = mistakeCard(group, id, check, warnings);
    if (!card) continue;
    claim(id, 'card');
    (card.kind === 'mistake' ? cardsMain : cardsSpecial).push(card);
  }
  // Punish cards: one per after-position; graded only when the reply is clearly unique (punishGrade),
  // otherwise an ungraded study item in the chunk's `study` array (same id, so a later refresh can promote it).
  const punish: Array<Record<string, unknown>> = [], punishStudy: Array<Record<string, unknown>> = [];
  const why: Record<string, number> = {};
  for (const group of groupBy(drillable.filter(e => (e.row.refutationPvUci ?? []).length > 0), r => { const a = fenAfter(r.fen, r.playedUci); return a ? positionKey(a) : null; })) {
    const id = prev[`punish|${group.key}`] ?? `punish-${group.rows[0].row.id}`;
    const card = punishCard(group, id, warnings);
    if (!card) continue;
    claim(id, 'punish');
    const verdict = punishGrade(group.rows[0].row, (card.moves as string[])[0], input.afterEvals?.[group.key]);
    why[verdict] = (why[verdict] ?? 0) + 1;
    if (verdict === 'unique') punish.push(card);
    else punishStudy.push(punishStudyItem(card, verdict, input.afterEvals?.[group.key]));
  }
  // Stalemate study items: every stalemate row, once per position.
  const study: Array<Record<string, unknown>> = [];
  for (const group of groupBy(entries.filter(e => e.set === 'stalemate'), r => positionKey(r.fen))) {
    const id = prev[`study|${group.key}`] ?? `study-${group.rows[0].row.id}`;
    study.push(studyItem(group.rows[0].row, claim(id, 'study')));
  }
  const byId = (a: Record<string, unknown>, b: Record<string, unknown>) => cmp(String(a.id), String(b.id));
  cardsMain.sort(byId); cardsSpecial.sort(byId); punish.sort(byId); study.sort(byId);

  const chunkSets = {
    cards: chunkCards(packVersion, 'cards', cardsMain),
    special: chunkCards(packVersion, 'special', cardsSpecial, study),
    punish: chunkCards(packVersion, 'punish', punish, punishStudy),
  };
  const allCards = [...cardsMain, ...cardsSpecial];
  const setsOf = (c: Record<string, unknown>) => ((c.pack as { sets: string[] }).sets);
  const counts: Record<string, number> = {
    rows: rows.length, drillable: rows.filter(r => r.drillable).length, notDrillable: rows.filter(r => !r.drillable).length,
    specialRows: special.length, specialDrillable: special.filter(r => r.drillable).length,
    stalemateRows: special.filter(r => r.set === 'stalemate').length, conversionRows: special.filter(r => r.set === 'conversion').length,
    cards: allCards.length, cardsMain: cardsMain.length, cardsSpecial: cardsSpecial.length,
    mergedRows: drillable.length - allCards.length,
    stalemateCards: allCards.filter(c => setsOf(c).includes('stalemate')).length,
    conversionCards: allCards.filter(c => setsOf(c).includes('conversion')).length,
    punish: punish.length, punishStudy: punishStudy.length,
    ...Object.fromEntries(['not-held', 'not-unique', 'decided', 'no-eval'].map(w => [`punishStudy_${w.replace('-', '_')}`, why[w] ?? 0])),
    study: study.length, warnings: warnings.length,
    chunksCards: chunkSets.cards.length, chunksSpecial: chunkSets.special.length, chunksPunish: chunkSets.punish.length,
  };

  // Reconcile with the producer's manifest.
  const diffs: string[] = [];
  let checked = 0;
  if (input.manifest) {
    const c = (input.manifest as { counts?: unknown }).counts;
    const expect: Array<[string, unknown, number]> = [
      ['mistakePositions', dig(c, ['mistakePositions']), counts.rows],
      ['drillable', dig(c, ['drillable']), counts.drillable],
      ['specialSets.stalemate.records', dig(c, ['specialSets', 'stalemate', 'records']), counts.stalemateRows],
      ['specialSets.conversion.withDecisiveError', dig(c, ['specialSets', 'conversion', 'withDecisiveError']), counts.conversionRows],
      ['specialSets.lines', dig(c, ['specialSets', 'lines']), counts.specialRows],
    ];
    for (const [name, want, got] of expect) {
      if (typeof want !== 'number') continue;
      checked++;
      if (want !== got) diffs.push(`${name}: manifest ${want}, converted ${got}`);
    }
  }

  const meta: Record<string, unknown> = {
    packVersion,
    importedAt: input.at ?? String(input.profile.generatedAt ?? '1970-01-01T00:00:00.000Z'),
    idScheme: 'pack-<gameId>:<ply> (oldest row per position); punish-<gameId>:<ply>; study-<gameId>:<ply>; siteId = Site loader id',
    counts,
    profile: input.profile,
    priors: cleanPriors(input.profile.themePriors),
    chunks: { cards: chunkSets.cards.map(c => c.id), special: chunkSets.special.map(c => c.id), punish: chunkSets.punish.map(c => c.id) },
  };
  const docs = [...chunkSets.cards, ...chunkSets.special, ...chunkSets.punish].map(({ path, data }) => ({ path, data }));
  docs.push({ path: paths.packMeta(), data: meta });
  for (const d of docs) validateDoc(d.path, d.data);
  return { packVersion, docs, counts, reconcile: { ok: diffs.length === 0, checked, diffs }, warnings };
}

/** Parse a document with its contract schema and check its size; throws with the path on failure. */
export function validateDoc(path: string, data: Record<string, unknown>): number {
  const schema = schemaForPath(path);
  if (!schema) throw new Error(`No contract schema for ${path}`);
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  const bytes = assertDocSize(data, path);
  if (bytes > MAX_DOC_BYTES) throw new Error(`${path} too large`);
  return bytes;
}
