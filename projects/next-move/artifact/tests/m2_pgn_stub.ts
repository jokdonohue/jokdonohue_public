/** Test helpers for the PGN stream: a scripted stub engine and invented games (no real players or games). */
import { Chess } from 'chess.js';
import type { EngineScore } from '../lib/chess-engine';
import { terminalLines, type AnalysisEngine, type EngineLine } from '../src/analysis/engine';
import { positionKey } from '../src/analysis/docs';

export type Scripted = Array<{ uci: string; score: EngineScore; depth?: number }>;
export interface StubEngine extends AnalysisEngine {
  calls: Array<{ fen: string; multiPv: number; depth: number }>;
  disposed: number;
}
/**
 * Every position is level (0) with the first legal moves as lines, unless `script` (keyed by the first four
 * FEN fields) says otherwise. Scores are White's point of view, like the real driver. `onCall` runs before
 * each answer (tests use it to press Stop mid-way).
 */
export function stubEngine(script: Record<string, Scripted> = {}, onCall?: (n: number) => void): StubEngine {
  const stub: StubEngine = {
    calls: [], disposed: 0,
    async analyse(fen, { depth, multiPv, signal }) {
      stub.calls.push({ fen, multiPv, depth });
      onCall?.(stub.calls.length);
      await new Promise(r => setTimeout(r, 0));
      if (signal?.aborted) throw new DOMException('Analysis stopped.', 'AbortError');
      const terminal = terminalLines(fen);
      if (terminal) return terminal;
      const s = script[positionKey(fen)];
      const lines: EngineLine[] = s
        ? s.map((l, i) => ({ multipv: i + 1, depth: l.depth ?? depth, score: l.score, pv: [l.uci] }))
        : new Chess(fen).moves({ verbose: true }).slice(0, 2).map((m, i) => ({ multipv: i + 1, depth, score: { cp: 0, mate: null }, pv: [`${m.from}${m.to}${m.promotion ?? ''}`] }));
      return lines.slice(0, multiPv);
    },
    dispose() { stub.disposed++; },
  };
  return stub;
}

/** FEN before the n-th half-move (1-based) of a SAN move list. */
export function fenBefore(sans: string[], ply: number): string {
  const c = new Chess();
  for (const s of sans.slice(0, ply - 1)) c.move(s);
  return c.fen();
}

// Game A: he is Black ("Alex Example") and blunders at half-move 6 (3...Nf6?? allowing Qxf7#).
export const A_MOVES = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'];
export const GAME_A = `[Event "Invented test game"]
[Site "Chess.com"]
[Date "2026.11.01"]
[White "Opponent A"]
[Black "Alex Example"]
[Result "1-0"]
[Link "https://www.chess.com/game/live/111222333"]

1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0
`;
/** Before 3...Nf6: g6 holds (level), Qe7 is clearly worse, Nf6 allows mate in one. */
export const A_SCRIPT: Record<string, Scripted> = {
  [positionKey(fenBefore(A_MOVES, 6))]: [{ uci: 'g7g6', score: { cp: 0, mate: null } }, { uci: 'd8e7', score: { cp: 200, mate: null } }],
  [positionKey(fenBefore(A_MOVES, 7))]: [{ uci: 'h5f7', score: { cp: null, mate: 1 } }],
};

// Game B: he is White ("alex example", other case) and blunders at half-move 7 (4.Nxe5? in a well-known trap).
export const B_MOVES = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4', 'Nxe5', 'Qg5', 'Nxf7', 'Qxg2', 'Rf1', 'Qxe4+', 'Be2', 'Nf3#'];
export const GAME_B = `[Event "Invented test game"]
[Date "2026.11.02"]
[White "alex example"]
[Black "Opponent B"]
[Result "0-1"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. Nxe5 Qg5 5. Nxf7 Qxg2 6. Rf1 Qxe4+ 7. Be2 Nf3# 0-1
`;
export const B_SCRIPT: Record<string, Scripted> = {
  [positionKey(fenBefore(B_MOVES, 7))]: [{ uci: 'f3d4', score: { cp: 30, mate: null } }, { uci: 'e1g1', score: { cp: -150, mate: null } }],
  [positionKey(fenBefore(B_MOVES, 8))]: [{ uci: 'd8g5', score: { cp: -300, mate: null } }],
};
