/** Synthetic producer rows for B3 tests: legal positions from seeded random playouts. No owner data. */
import { Chess } from 'chess.js';

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
const uciOf = (m: { from: string; to: string; promotion?: string }) => m.from + m.to + (m.promotion ?? '');

export interface RowOpts { gameId: number; ply: number; date: string; fen: string; drillable?: boolean; set?: 'stalemate' | 'conversion' }

/** A row at `fen`: played = first legal move, best = second, a 2-ply refutation after the played move. */
export function rowAt(o: RowOpts): Record<string, unknown> | null {
  const board = new Chess(o.fen);
  const moves = board.moves({ verbose: true });
  if (moves.length < 2) return null;
  const played = moves[0], best = moves[1];
  const after = new Chess(o.fen); after.move(played);
  if (after.isGameOver()) return null;
  const reply = after.moves({ verbose: true })[0];
  const after2 = new Chess(after.fen()); after2.move(reply);
  const reply2 = after2.isGameOver() ? null : after2.moves({ verbose: true })[0];
  const bestBoard = new Chess(o.fen); bestBoard.move(best);
  const bestReply = bestBoard.isGameOver() ? null : bestBoard.moves({ verbose: true })[0];
  return {
    id: `${o.gameId}:${o.ply}`, gameUrl: `https://www.chess.com/game/live/${o.gameId}`, date: o.date, timeClass: 'rapid',
    ownerColor: board.turn(), ply: o.ply, moveNumber: Math.ceil(o.ply / 2), fen: o.fen,
    playedSan: played.san, playedUci: uciOf(played), bestSan: best.san, bestUci: uciOf(best),
    pvUci: [uciOf(best), ...(bestReply ? [uciOf(bestReply)] : [])],
    winBefore: 55, winAfter: 20, drop: 35, cpBefore: 40, cpAfter: -300, mateBefore: null, mateAfter: null,
    judgement: 'blunder', phase: 'opening', motifs: ['missed-material'], secondBestGap: 20, drillable: o.drillable ?? true,
    clockBefore: 300, moveSeconds: 4, eco: 'C20', opening: 'Synthetic Opening',
    refutationPvUci: [uciOf(reply), ...(reply2 ? [uciOf(reply2)] : [])],
    ...(o.set ? { set: o.set, ...(o.set === 'conversion' ? { outcome: 'time' } : {}) } : {}),
  };
}

/** `n` rows from distinct positions (seeded random games), dated `date`, game ids from `firstGame`. */
export function syntheticRows(n: number, opts: { seed?: number; date?: string; firstGame?: number } = {}): Array<Record<string, unknown>> {
  const rand = rng(opts.seed ?? 1);
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let game = opts.firstGame ?? 100000;
  while (rows.length < n) {
    const board = new Chess();
    game++;
    for (let ply = 1; ply <= 40 && rows.length < n; ply++) {
      const moves = board.moves();
      if (!moves.length || board.isGameOver()) break;
      board.move(moves[Math.floor(rand() * moves.length)]);
      if (ply % 3 !== 0) continue;
      const key = board.fen().split(' ').slice(0, 4).join(' ');
      if (seen.has(key)) continue;
      const row = rowAt({ gameId: game, ply: ply + 1, date: opts.date ?? '2026-10-01', fen: board.fen() });
      if (row) { seen.add(key); rows.push(row); }
    }
  }
  return rows;
}

export const jsonl = (rows: Array<Record<string, unknown>>) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

export const PROFILE = {
  schemaVersion: 1, generatedAt: '2026-11-10T04:00:00.000Z',
  sample: { games: 10, from: '2026-09-01', to: '2026-11-08', timeClasses: ['rapid'], engine: 'test', depth: 14, multipv: 2, confirmDepth: 18 },
  phaseRates: {}, motifs: { 'missed-material': { count: 7, per100Moves: 1, ci95: [0, 2], weight: 1.5 }, 'allowed-fork': { count: 3, per100Moves: 1, ci95: [0, 2], weight: 1 } },
  themePriors: { fork: 2.5, hangingPiece: 2.5, pin: 1, skewer: 0.4, mateIn1: 3 },
  overall: { blundersPer100: 6.13 }, conversion: { notWonShare: 0.2354 },
};

/** A stalemate row: K+Q vs K where Qb6 stalemates. */
export const STALEMATE_ROW = {
  id: '731:75', gameUrl: 'https://www.chess.com/game/live/731', date: '2020-03-14', timeClass: 'rapid', ownerColor: 'w', ply: 75, moveNumber: 38,
  fen: 'k7/8/2K5/8/8/8/8/1Q6 w - - 0 38', playedSan: 'Qb6', playedUci: 'b1b6', bestSan: 'Qb7#', bestUci: 'b1b7', pvUci: ['b1b7'],
  winBefore: 100, winAfter: 50, drop: 50, cpBefore: 1000, cpAfter: 0, mateBefore: 1, mateAfter: null, judgement: 'blunder', phase: 'endgame',
  motifs: [], secondBestGap: 0, drillable: false, clockBefore: 10, moveSeconds: 1, eco: null, opening: null, refutationPvUci: [], set: 'stalemate', outcome: 'other',
};
