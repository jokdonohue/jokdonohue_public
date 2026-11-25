/**
 * Move judgement for the in-page PGN analysis (brief M2, stream PGN; port plan section 5).
 *
 * A port of the engine pass's rules so a page-made card means the same thing as a Claude-made one:
 * - severity: `opus/mistake-classifier.ts` `judge()` (Lichess "Advice" incl. the mate branches): a drop in
 *   winning chances of 0.1 / 0.2 / 0.3 on the [-1, 1] scale, i.e. 5 / 10 / 15 points on the 0-100 scale,
 *   with centipawns clamped at +/-1000;
 * - card rule: the producer's `drillableOf` uniqueness and band (`UNIQUE_GAP`, `DECIDED_LO`, `DECIDED_HI`,
 *   mirrored in `src/importers/packDocs.ts`; a test keeps the two equal), including its mate rule (lead decision
 *   2026-11-10): a position where he had a forced mate is eligible, with the same 10-point gap; a forced mate
 *   against him is decided.
 * Pure: no engine, no IO.
 */
import type { EngineScore } from '@/lib/chess-engine';

export const CEILING = 1000;
export const MULTIPLIER = 0.00368208;
/** Winning-chance drops on the 0-100 scale (brief: 5, 10 and 15 points). */
export const INACCURACY_DROP = 5, MISTAKE_DROP = 10, BLUNDER_DROP = 15;
/** Second-best move at least this many points worse (0-100 scale) at MultiPV 2. */
export const UNIQUE_GAP = 10;
/** A card only when his chances before the move are strictly inside this band (0-100 scale). */
export const DECIDED_LO = 5, DECIDED_HI = 95;

export type Judgement = 'inaccuracy' | 'mistake' | 'blunder';
type Color = 'w' | 'b';

/** scalachess `winningChances`: cp ceiled at +/-1000, result in [-1, 1]. */
export function winningChances(cp: number): number {
  const c = Math.max(-CEILING, Math.min(CEILING, cp));
  return Math.max(-1, Math.min(1, 2 / (1 + Math.exp(-MULTIPLIER * c)) - 1));
}

type Pov = { kind: 'cp'; cp: number } | { kind: 'mate'; n: number };
/**
 * Score from `mover`'s point of view (as the classifier reads it). Scores are White's point of view (lib
 * convention). mate n > 0: mover mates; n < 0: mover is mated; +/-0.5: a side is already checkmated.
 */
export function pov(s: EngineScore | null | undefined, mover: Color, sideToMove: Color): Pov | null {
  if (!s) return null;
  const sign = mover === 'w' ? 1 : -1;
  if (typeof s.cp === 'number' && Number.isFinite(s.cp)) return { kind: 'cp', cp: s.cp * sign };
  const matedSide = s.mated ?? (s.mate === 0 ? sideToMove : undefined);
  if (matedSide) return { kind: 'mate', n: matedSide === mover ? -0.5 : 0.5 };
  if (typeof s.mate === 'number' && Number.isFinite(s.mate)) return { kind: 'mate', n: s.mate * sign };
  return null;
}
const povChances = (p: Pov) => (p.kind === 'cp' ? winningChances(p.cp) : winningChances(p.n > 0 ? CEILING : -CEILING));
/** Winning chances for `mover`, 0-100 (a mate counts as +/-1000 cp, as in the producer). */
export function winFor(s: EngineScore, mover: Color, sideToMove: Color): number {
  const p = pov(s, mover, sideToMove);
  if (!p) throw new Error('Missing engine score.');
  return 50 + 50 * povChances(p);
}

/**
 * Lichess Advice judgement for the mover. `before` is read with the mover to move, `after` with the opponent
 * to move. Port of `opus/mistake-classifier.ts` `judge()`.
 */
export function judge(before: EngineScore, after: EngineScore, mover: Color): Judgement | null {
  const b = pov(before, mover, mover);
  const a = pov(after, mover, mover === 'w' ? 'b' : 'w');
  if (!b || !a) return null;
  if (b.kind === 'cp' && a.kind === 'cp') {
    const delta = winningChances(b.cp) - winningChances(a.cp);
    if (delta >= 0.3) return 'blunder';
    if (delta >= 0.2) return 'mistake';
    if (delta >= 0.1) return 'inaccuracy';
    return null;
  }
  const prevCp = b.kind === 'cp' ? b.cp : 0;
  const nextCp = a.kind === 'cp' ? a.cp : 0;
  const mateCreated = b.kind === 'cp' && a.kind === 'mate' && a.n < 0;
  const mateLost = b.kind === 'mate' && b.n > 0 && (a.kind === 'cp' || a.n < 0);
  if (mateCreated) return prevCp < -999 ? 'inaccuracy' : prevCp < -700 ? 'mistake' : 'blunder';
  if (mateLost) return nextCp > 999 ? 'inaccuracy' : nextCp > 700 ? 'mistake' : 'blunder';
  return null; // a mate delayed and other mate-to-mate changes: no judgement, as in Lichess
}

export type CardWhy = 'card' | 'not-a-mistake' | 'one-line' | 'not-unique' | 'decided';
/**
 * Whether a judged move becomes a practice position. `best` and `second` are the two MultiPV lines of the
 * position before his move (White's point of view, mover to move).
 */
export function cardRule(judgement: Judgement | null, best: EngineScore, second: EngineScore | null, mover: Color): { why: CardWhy; gap: number | null; winBefore: number } {
  const winBefore = winFor(best, mover, mover);
  if (judgement !== 'mistake' && judgement !== 'blunder') return { why: 'not-a-mistake', gap: null, winBefore };
  if (!second) return { why: 'one-line', gap: null, winBefore };
  // The second line is a normal search score, never a terminal "mated" marker (as in the producer).
  const gap = Math.round((winBefore - winFor({ ...second, mated: undefined }, mover, mover)) * 100) / 100;
  if (gap < UNIQUE_GAP) return { why: 'not-unique', gap, winBefore };
  // Producer `drillableOf`: a forced mate for him is not decided (finding it is the lesson); one against him is.
  // A mate score is a proof at any depth. Otherwise his chances must be strictly inside the band.
  const b = pov(best, mover, mover);
  if (b?.kind === 'mate') return { why: b.n > 0 ? 'card' : 'decided', gap, winBefore };
  if (!(winBefore > DECIDED_LO && winBefore < DECIDED_HI)) return { why: 'decided', gap, winBefore };
  return { why: 'card', gap, winBefore };
}
