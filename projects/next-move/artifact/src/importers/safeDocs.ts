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
import { paths } from '../contract/docs';

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

export interface Candidate { m: JudgedMove; fen: string; game: GameInfo; verdict: 'safe' | 'unsafe'; order: string }

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
  // Pair every chosen blunder with a sound move that looks the same before judging (see pairSafe).
  const chosen: Candidate[] = [];
  const pairing = { exact: 0, relaxed: 0, noPartner: 0 };
  const fam = (c: Candidate) => (familiar.has(`${c.m.g}:${c.m.p}`) ? 1 : 0);
  for (const ph of PHASES) {
    const unsafe = [...(pool.unsafe[ph] ?? [])].sort((a, b) => fam(a) - fam(b) || cmp(a.order, b.order));
    const safe = [...(pool.safe[ph] ?? [])].sort((a, b) => cmp(a.order, b.order));
    const pairs = pairSafe(unsafe, safe, quota[ph] ?? 0, pairing);
    for (const [u, s] of pairs) chosen.push(u, s);
    quota[ph] = pairs.length;
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
    pairedExact: pairing.exact, pairedRelaxed: pairing.relaxed, unsafeWithoutPartner: pairing.noPartner,
    ...Object.fromEntries(Object.entries(skipped).map(([k, v]) => [`skipped_${k}`, v])),
  };
  return { cards, counts };
}

/** The visible features of a candidate, as `surfaceCues` reads them from the finished card. */
function candidateCues(c: Candidate): SurfaceCues {
  return surfaceCues({
    question: { playedSan: sanLine(c.fen, [c.m.pu])[0], side: c.game.ownerColor },
    title: `x · ${titleCase(c.game.timeClass)}`, fen: c.fen, reveal: { winBefore: c.m.wb },
  });
}
/** Cell keys from strictest to loosest; a pair always shares at least capture, check and the piece moved. */
const CELLS: Array<(c: SurfaceCues) => string> = [
  c => `${c.capture}|${c.check}|${c.piece}|${c.side}|${c.timeClass}`,
  c => `${c.capture}|${c.check}|${c.piece}|${c.timeClass}`,
  c => `${c.capture}|${c.check}|${c.piece}`,
];
/** Distance on the two continuous cues: 1 per move number, 1 per Win% point. */
const cueDistance = (a: SurfaceCues, b: SurfaceCues) => Math.abs(a.moveNo - b.moveNo) + Math.abs(a.winBefore - b.winBefore);
/**
 * Matched pairs (judgement call; closes the answer cues the first M2 build had, see the build log). Blunders are
 * taken in their fixed order; each gets the unused sound move that shares its capture, check, piece moved, side
 * and time class (relaxing side, then time class, only when no such move is left) and is nearest in move number
 * and Win% before (ties: stable order). A blunder with no partner at all is passed over. Deterministic.
 */
export function pairSafe(unsafe: Candidate[], safe: Candidate[], want: number, tally = { exact: 0, relaxed: 0, noPartner: 0 }): Array<[Candidate, Candidate]> {
  const cues = new Map<Candidate, SurfaceCues>();
  for (const c of [...unsafe, ...safe]) cues.set(c, candidateCues(c));
  const used = new Set<Candidate>();
  const byCell = CELLS.map(key => {
    const m = new Map<string, Candidate[]>();
    for (const s of safe) (m.get(key(cues.get(s)!)) ?? m.set(key(cues.get(s)!), []).get(key(cues.get(s)!))!).push(s);
    return m;
  });
  const pairs: Array<[Candidate, Candidate]> = [];
  for (const u of unsafe) {
    if (pairs.length >= want) break;
    const cu = cues.get(u)!;
    let partner: Candidate | null = null, level = -1;
    for (let i = 0; i < CELLS.length && !partner; i++) {
      let best = Infinity;
      for (const s of byCell[i].get(CELLS[i](cu)) ?? []) {
        if (used.has(s)) continue;
        const d = cueDistance(cu, cues.get(s)!);
        if (d < best) { best = d; partner = s; level = i; }
      }
    }
    if (!partner) { tally.noPartner++; continue; }
    used.add(partner);
    if (level === 0) tally.exact++; else tally.relaxed++;
    pairs.push([u, partner]);
  }
  return pairs;
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

/** What the learner can see before judging, reduced to the features that could hint at the verdict. */
export interface SurfaceCues { capture: boolean; check: boolean; piece: 'P' | 'N' | 'B' | 'R' | 'Q' | 'K' | 'castle'; side: 'w' | 'b'; timeClass: string; moveNo: number; winBefore: number; /** Game date in days since 1970 (from the title), or NaN. */ day: number }
export function surfaceCues(card: Record<string, unknown>): SurfaceCues {
  const q = card.question as { playedSan: string; side: 'w' | 'b' };
  const san = q.playedSan;
  const head = san.charAt(0);
  const piece = san.startsWith('O-O') ? 'castle' : ('NBRQK'.includes(head) ? head : 'P') as SurfaceCues['piece'];
  const title = String(card.title ?? '');
  return {
    capture: san.includes('x'), check: /[+#]$/.test(san), piece, side: q.side,
    timeClass: (title.split(' · ')[1] ?? '').toLowerCase(),
    moveNo: Number(String(card.fen).split(' ')[5]) || 0,
    winBefore: Number((card.reveal as { winBefore?: number } | undefined)?.winBefore ?? 0),
    day: Date.parse(title.split(' · ')[2] ?? '') / 86_400_000,
  };
}
const pct = (k: number, n: number) => (n ? Math.round((1000 * k) / n) / 10 : 0);
const mean = (xs: number[]) => (xs.length ? Math.round((10 * xs.reduce((a, b) => a + b, 0)) / xs.length) / 10 : 0);
/**
 * Cue table for the two halves: share of each visible feature (percent) and the mean move number and Win% before.
 * `gap` is safe minus unsafe; a large gap means the feature alone predicts the answer.
 */
export function cueTable(cards: Array<Record<string, unknown>>) {
  const halves = { safe: cards.filter(c => c.kind === 'safe').map(surfaceCues), unsafe: cards.filter(c => c.kind === 'unsafe').map(surfaceCues) };
  const rows: Array<{ cue: string; unit: '%' | 'mean'; safe: number; unsafe: number; gap: number }> = [];
  const share = (cue: string, f: (c: SurfaceCues) => boolean) => {
    const s = pct(halves.safe.filter(f).length, halves.safe.length), u = pct(halves.unsafe.filter(f).length, halves.unsafe.length);
    rows.push({ cue, unit: '%', safe: s, unsafe: u, gap: Math.round(10 * (s - u)) / 10 });
  };
  share('capture', c => c.capture);
  share('check', c => c.check);
  for (const p of ['P', 'N', 'B', 'R', 'Q', 'K', 'castle'] as const) share(p === 'P' ? 'pawn move' : p === 'castle' ? 'castling' : `piece ${p}`, c => c.piece === p);
  share('plays white', c => c.side === 'w');
  for (const t of [...new Set([...halves.safe, ...halves.unsafe].map(c => c.timeClass))].sort()) share(`time class ${t || '?'}`, c => c.timeClass === t);
  for (const [cue, f] of [['move number', (c: SurfaceCues) => c.moveNo], ['Win% before', (c: SurfaceCues) => c.winBefore], ['game date (days)', (c: SurfaceCues) => c.day]] as const) {
    const s = mean(halves.safe.map(f).filter(Number.isFinite)), u = mean(halves.unsafe.map(f).filter(Number.isFinite));
    rows.push({ cue, unit: 'mean', safe: s, unsafe: u, gap: Math.round(10 * (s - u)) / 10 });
  }
  return { n: { safe: halves.safe.length, unsafe: halves.unsafe.length }, rows };
}

/**
 * The `safe/<ver>-NN` chunks for these cards (lead decision D1: outside `pack/`, so a version-4 page never reads
 * them). Same limits as pack chunks (150 cards, 150 KiB); body `{packVersion, cards}`; ids `<ver>-NN`.
 */
export function safeChunks(packVersion: string, cards: Array<Record<string, unknown>>) {
  return chunkCards(packVersion, 'safe', cards).map((c, n) => ({
    path: paths.safeChunk(packVersion, n),
    id: `${packVersion}-${String(n).padStart(2, '0')}`,
    data: { packVersion, cards: c.data.cards as Array<Record<string, unknown>> },
  }));
}
