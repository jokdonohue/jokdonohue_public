/**
 * Item b, "Safe or not?" (M2): one of his real moves, judged safe or losing before the reveal; half blunders,
 * half sound moves. Pedagogy: C1 (Heisman's safety check before every move), A3 (interleaving two categories
 * so he learns to tell them apart) and B6 (errors come from missing one cue) in reviews/claude/evidence_base.md.
 *
 * Source: the engine-pass cache (`cache/judged_moves.jsonl` for the played/best moves, `cache/final_moves.jsonl`
 * for the confirmed judgement and values, `cache/candidates.jsonl` for the FENs). Pure: the script streams the
 * files and passes compact records in. Deterministic: selection and order use stable hashes, no randomness.
 *
 * Selection (judgement calls, each closing a cue that would give the answer away):
 * - both halves come from roughly level positions, 30-70 engine-scaled Win% before the move, so the
 *   evaluation of the position does not hint at the verdict;
 * - unsafe = confirmed blunders; safe = moves with no judgement and a drop under 2 points;
 * - positions that occur in more than one game of the sample are left out (book positions would be
 *   recognised as safe), as are positions with fewer than 3 legal moves and any move with a mate score;
 * - matched by phase and count: in every phase the two halves have exactly the same size;
 * - card ids (`judge-<gameId>:<ply>`), titles, themes and the fields shown before judging have the same
 *   form for both halves; blunders he also drills as pack or punish cards are used only when a phase runs
 *   out of others (a familiar position would hint "unsafe": sound moves never become pack cards); the verdict, the engine values and the game link live only in `reveal` (and in
 *   `kind`, the answer key the page compares against and must not render before judging).
 */
import { Chess } from 'chess.js';
import { stableId } from '../coach/hash';
import { chunkCards, cmp, positionKey, sanLine, fenAfter } from './packDocs';

export const SAFE_PRESHOW_FIELDS = ['id', 'fen', 'moves', 'rating', 'themes', 'title', 'question'] as const;
/** Fields that carry the answer: never render before the learner has judged. */
export const SAFE_ANSWER_FIELDS = ['kind', 'reveal'] as const;
export const WIN_BAND: readonly [number, number] = [30, 70];
export const SOUND_MAX_DROP = 2;
export const MIN_LEGAL_MOVES = 3;
/** Default cap per half (db size: total cap unknown, plan risk 3); judgement call. */
export const DEFAULT_PER_HALF = 300;

export interface JudgedMove {
  g: string; p: number; mn: number; ph: 'opening' | 'middlegame' | 'endgame';
  /** Final (confirmed) judgement, or null for no error. */
  j: 'inaccuracy' | 'mistake' | 'blunder' | null;
  wb: number; wa: number; drop: number;
  /** Engine best move at the position (UCI) and the move played. */
  bm: string; pu: string; best: boolean;
  /** True when either side had a forced mate in the stored scores. */
  mate: boolean;
  sec?: number | null;
  /** Search depth of the stored values (14 for unconfirmed moves, the confirm depth for errors). */
  depth?: number;
}
export interface GameInfo { url: string; date: string; timeClass: string; ownerColor: 'w' | 'b'; fens: string[] }
/** Line data for blunders, from `mistake_positions.jsonl` (id `<g>:<p>`). */
export interface RowLines { pvUci: string[]; refutationPvUci?: string[]; /** Mate score at the confirm depth (row mateBefore/mateAfter). */ mate?: boolean }

const PHASES = ['opening', 'middlegame', 'endgame'] as const;
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const r0 = (x: number) => Math.round(x);

interface Candidate { m: JudgedMove; fen: string; game: GameInfo; verdict: 'safe' | 'unsafe'; order: string }

/** Split a total cap into per-phase quotas proportional to `sizes` (largest remainder, phase order breaks ties). */
export function quotas(sizes: Record<string, number>, cap: number): Record<string, number> {
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  if (total <= cap) return { ...sizes };
  const out: Record<string, number> = {}, rem: Array<[string, number]> = [];
  let used = 0;
  for (const ph of PHASES) { const exact = ((sizes[ph] ?? 0) * cap) / total; out[ph] = Math.floor(exact); used += out[ph]; rem.push([ph, exact - out[ph]]); }
  rem.sort((a, b) => b[1] - a[1]);
  for (let i = 0; used < cap && i < rem.length; i++, used++) out[rem[i][0]]++;
  return out;
}

export function buildSafeCards(input: { moves: JudgedMove[]; games: Map<string, GameInfo>; rows: Map<string, RowLines>; perHalf?: number; familiar?: ReadonlySet<string> }) {
  const familiar = input.familiar ?? new Set<string>();
  const perHalf = input.perHalf ?? DEFAULT_PER_HALF;
  // Positions (owner to move) that occur in more than one game of the sample.
  const gamesAt = new Map<string, Set<string>>();
  for (const m of input.moves) {
    const fen = input.games.get(m.g)?.fens[m.p - 1];
    if (!fen) continue;
    const k = positionKey(fen);
    (gamesAt.get(k) ?? gamesAt.set(k, new Set()).get(k)!).add(m.g);
  }
  const pool: Record<'safe' | 'unsafe', Record<string, Candidate[]>> = { safe: {}, unsafe: {} };
  const skipped = { mate: 0, band: 0, repeated: 0, fewMoves: 0, illegal: 0, noLines: 0 };
  for (const m of input.moves) {
    const verdict = m.j === 'blunder' ? 'unsafe' : m.j === null && m.drop < SOUND_MAX_DROP ? 'safe' : null;
    if (!verdict) continue;
    const game = input.games.get(m.g);
    const fen = game?.fens[m.p - 1];
    if (!game || !fen) { skipped.illegal++; continue; }
    if (m.mate || input.rows.get(`${m.g}:${m.p}`)?.mate) { skipped.mate++; continue; }
    if (m.wb < WIN_BAND[0] || m.wb > WIN_BAND[1]) { skipped.band++; continue; }
    if ((gamesAt.get(positionKey(fen))?.size ?? 0) > 1) { skipped.repeated++; continue; }
    let legal: number;
    try { legal = new Chess(fen).moves().length; } catch { skipped.illegal++; continue; }
    if (legal < MIN_LEGAL_MOVES) { skipped.fewMoves++; continue; }
    if (!sanLine(fen, [m.pu]).length || new Chess(fen).turn() !== game.ownerColor) { skipped.illegal++; continue; }
    if (verdict === 'unsafe' && !input.rows.has(`${m.g}:${m.p}`)) { skipped.noLines++; continue; }
    (pool[verdict][m.ph] ??= []).push({ m, fen, game, verdict, order: stableId(`safe-or-not|${m.g}:${m.p}`) });
  }
  // Match by phase and count, then cap proportionally.
  const matched: Record<string, number> = {};
  for (const ph of PHASES) matched[ph] = Math.min(pool.safe[ph]?.length ?? 0, pool.unsafe[ph]?.length ?? 0);
  const quota = quotas(matched, perHalf);
  const chosen: Candidate[] = [];
  for (const ph of PHASES) {
    for (const v of ['unsafe', 'safe'] as const) {
      const fam = (c: Candidate) => (familiar.has(`${c.m.g}:${c.m.p}`) ? 1 : 0);
      const list = [...(pool[v][ph] ?? [])].sort((a, b) => fam(a) - fam(b) || cmp(a.order, b.order));
      chosen.push(...list.slice(0, quota[ph] ?? 0));
    }
  }
  // Interleave the halves: order every card by a hash of its id, so no chunk or position in a chunk hints at the verdict.
  chosen.sort((a, b) => cmp(stableId(`order|${a.m.g}:${a.m.p}`), stableId(`order|${b.m.g}:${b.m.p}`)));
  const cards = chosen.map(c => safeCard(c, input.rows.get(`${c.m.g}:${c.m.p}`)));
  const counts: Record<string, number> = {
    safeCards: cards.filter(c => c.kind === 'safe').length,
    unsafeCards: cards.filter(c => c.kind === 'unsafe').length,
    ...Object.fromEntries(PHASES.map(ph => [`safe_${ph}`, quota[ph] ?? 0])),
    unsafeAlsoInPack: chosen.filter(c => c.verdict === 'unsafe' && familiar.has(`${c.m.g}:${c.m.p}`)).length,
    eligibleSafe: PHASES.reduce((s, ph) => s + (pool.safe[ph]?.length ?? 0), 0),
    eligibleUnsafe: PHASES.reduce((s, ph) => s + (pool.unsafe[ph]?.length ?? 0), 0),
    ...Object.fromEntries(Object.entries(skipped).map(([k, v]) => [`skipped_${k}`, v])),
  };
  return { cards, counts };
}

function safeCard(c: Candidate, lines: RowLines | undefined): Record<string, unknown> & { kind: 'safe' | 'unsafe' } {
  const { m, fen, game } = c;
  const playedSan = sanLine(fen, [m.pu])[0];
  const bestSan = m.bm && m.bm !== m.pu ? sanLine(fen, [m.bm])[0] : undefined;
  const reveal: Record<string, unknown> = {
    verdict: c.verdict, playedSan, winBefore: m.wb, winAfter: m.wa, drop: m.drop, judgement: m.j,
    gameUrl: game.url, moveSeconds: m.sec ?? null, engineBest: m.best,
    ...(bestSan ? { bestUci: m.bm, bestSan } : {}),
  };
  if (c.verdict === 'unsafe') {
    const after = fenAfter(fen, m.pu)!;
    const reply = sanLine(after, lines?.refutationPvUci ?? []);
    const bestLine = lines?.pvUci?.[0] === m.bm ? sanLine(fen, lines.pvUci) : bestSan ? [bestSan] : [];
    if (reply.length) Object.assign(reveal, { replyLineUci: (lines!.refutationPvUci ?? []).slice(0, reply.length), replyLineSan: reply });
    if (bestLine.length) reveal.bestLineSan = bestLine;
    reveal.explanation = `Not safe. ${reply.length ? `After ${playedSan}, the engine's reply ${reply[0]}${reply.length > 1 ? ` (line: ${reply.join(' ')})` : ''}` : `${playedSan}`} took your engine-scaled winning chances from ${r0(m.wb)}% to ${r0(m.wa)}%.${bestSan ? ` The engine preferred ${bestSan}.` : ''}`;
  } else {
    reveal.explanation = `Safe. ${playedSan} kept the balance at the engine's depth-${m.depth ?? 14} check: engine-scaled winning chances ${r0(m.wb)}% before, ${r0(m.wa)}% after.${m.best ? ' It was also the engine\'s first choice.' : bestSan ? ` The engine slightly preferred ${bestSan}.` : ''}`;
  }
  return {
    id: `judge-${m.g}:${m.p}`,
    kind: c.verdict,
    fen,
    moves: [m.pu],
    rating: 1000,
    themes: ['personal', 'safety', m.ph],
    title: `Safe or not? · ${titleCase(game.timeClass)} · ${game.date} · move ${m.mn}`,
    question: { playedUci: m.pu, playedSan, side: game.ownerColor },
    reveal,
  };
}

/** The `pack/<ver>-safe-NN` chunks for these cards. */
export function safeChunks(packVersion: string, cards: Array<Record<string, unknown>>) {
  return chunkCards(packVersion, 'safe', cards);
}
