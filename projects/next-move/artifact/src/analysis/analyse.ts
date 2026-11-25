/**
 * Engine pass over one game, his moves only: the position before each of his moves at MultiPV 2, and the
 * position after it (MultiPV 1) unless he played the engine's first choice.
 */
import type { EngineScore } from '@/lib/chess-engine';
import type { ParsedGame } from '@/lib/pgn';
import { abortError, type AnalysisEngine } from './engine';
import { cardRule, judge, winFor, type CardWhy, type Judgement } from './judge';

export interface MoveVerdict {
  ply: number;
  fen: string;
  playedUci: string;
  playedSan: string;
  bestUci: string;
  /** The engine's best line from the position before his move. */
  pvUci: string[];
  /** The engine's line after his move (the opponent's best reply first); empty when he played the best move. */
  refutationPvUci: string[];
  /** White's point of view. */
  before: EngineScore;
  after: EngineScore;
  /** His winning chances before and after the move, 0-100. */
  winBefore: number;
  winAfter: number;
  judgement: Judgement | null;
  gap: number | null;
  /** `shallow`: the search stopped before the requested depth, so the move is not judged. */
  why: CardWhy | 'shallow';
  /** The shallower of the depths the verdict rests on. */
  depth: number;
}

export interface MoveProgress { ply: number }

export async function analyseGame(
  game: ParsedGame,
  color: 'w' | 'b',
  engine: AnalysisEngine,
  options: { depth: number; signal?: AbortSignal; onMove?: (p: MoveProgress) => void },
): Promise<MoveVerdict[]> {
  const { depth, signal } = options;
  const out: MoveVerdict[] = [];
  const opponent = color === 'w' ? 'b' : 'w';
  for (const move of game.moves) {
    if (move.color !== color) continue;
    if (signal?.aborted) throw abortError();
    const beforeLines = await engine.analyse(move.before, { depth, multiPv: 2, signal });
    const best = beforeLines[0];
    const bestUci = best?.pv[0];
    if (!best || !bestUci) { options.onMove?.({ ply: move.ply }); continue; }
    let after = best.score, refutation: string[] = [], afterDepth = best.depth;
    if (bestUci !== move.uci) {
      const afterLines = await engine.analyse(move.after, { depth, multiPv: 1, signal });
      after = afterLines[0].score; refutation = afterLines[0].pv; afterDepth = afterLines[0].depth;
    }
    const judgement = bestUci === move.uci ? null : judge(best.score, after, color);
    const second = beforeLines[1]?.pv[0] && beforeLines[1].pv[0] !== bestUci ? beforeLines[1] : null;
    const rule = cardRule(judgement, best.score, second?.score ?? null, color);
    const depths = [best.depth, ...(second ? [second.depth] : []), ...(bestUci !== move.uci && afterDepth > 0 ? [afterDepth] : [])];
    const reached = Math.min(...depths);
    // A search cut short (watchdog stop, e.g. after the phone slept) is too shallow to judge: no mistake, no card.
    const shallow = reached < depth;
    out.push({
      ply: move.ply, fen: move.before, playedUci: move.uci, playedSan: move.san, bestUci, pvUci: best.pv, refutationPvUci: refutation,
      before: best.score, after, winBefore: rule.winBefore, winAfter: winFor(after, color, opponent),
      judgement: shallow ? null : judgement, gap: rule.gap, why: shallow ? 'shallow' : rule.why, depth: reached,
    });
    options.onMove?.({ ply: move.ply });
  }
  return out;
}
