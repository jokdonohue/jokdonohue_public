import { Chess } from 'chess.js';
import type { ParsedGame, ParsedMove } from './pgn';

export interface EngineScore { cp: number | null; mate: number | null; mated?: 'w' | 'b' }
export interface Evaluation {
  /** Scores are always from White's perspective. Mate is signed moves to mate. */
  score: EngineScore;
  depth: number;
  pv: string[];
  bestMove: string | null;
}
export interface EvaluateOptions { moveTimeMs?: number; depth?: number; signal?: AbortSignal }
export interface AnalysisMistake {
  id: string; ply: number; fen: string; color: 'w' | 'b';
  playedUci: string; playedSan: string; bestUci: string;
  lossCp: number; depth: number; pv: string[];
  before: EngineScore; after: EngineScore;
}
export interface GameAnalysis {
  gameId: string; color: 'w' | 'b'; mistakes: AnalysisMistake[];
  analyzedMoves: number; totalMoves: number; partial: boolean;
  engine: string; moveTimeMs: number;
}
export interface AnalysisProgress { completed: number; total: number; ply: number }

export function parseInfo(line: string, turn: 'w' | 'b'): Evaluation | null {
  if (!line.startsWith('info ') || /\b(?:lowerbound|upperbound)\b/.test(line)) return null;
  const depth = line.match(/\bdepth (\d+)/);
  const score = line.match(/\bscore (cp|mate) (-?\d+)/);
  const pv = line.match(/\bpv (.+)$/);
  if (!depth || !score) return null;
  const value = Number(score[2]) * (turn === 'w' ? 1 : -1);
  const moves = pv ? pv[1].trim().split(/\s+/) : [];
  return { score: { cp: score[1] === 'cp' ? value : null, mate: score[1] === 'mate' ? value : null, ...(score[1] === 'mate' && value === 0 ? { mated: turn } : {}) }, depth: Number(depth[1]), pv: moves, bestMove: moves[0] ?? null };
}
/** Internal ranking only: mate is not a centipawn evaluation. */
export function scoreToCp(score: EngineScore): number {
  if (score.cp !== null) return score.cp;
  if (score.mate === null) throw new Error('Missing engine score.');
  if (score.mated) return score.mated === 'w' ? -10000 : 10000;
  return Math.sign(score.mate || 1) * (10000 - Math.min(1000, Math.abs(score.mate)));
}
export function moverLoss(before: EngineScore, after: EngineScore, color: 'w' | 'b'): number {
  return Math.max(0, Math.round((scoreToCp(before) - scoreToCp(after)) * (color === 'w' ? 1 : -1)));
}

type WorkerLike = Pick<Worker, 'postMessage' | 'terminate' | 'addEventListener' | 'removeEventListener'>;
/** One local single-thread worker. No account, server analysis, or network API. */
export class StockfishEngine {
  private worker: WorkerLike | null = null;
  private ready: Promise<void> | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private busy = false;
  constructor(private workerFactory: () => WorkerLike = () => new Worker('/engine/stockfish-19-lite-single.js')) {}

  init(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException('Analysis cancelled.', 'AbortError'));
    if (this.ready) return this.waitForReady(this.ready, signal);
    this.ready = new Promise<void>((resolve, reject) => {
      const worker = this.workerFactory();
      this.worker = worker;
      const cleanup = () => { clearTimeout(timer); worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); this.pendingReject = null; };
      const fail = (error: Error) => { cleanup(); this.terminate(); reject(error); };
      const onError = () => fail(new Error('Stockfish could not load. Check browser WebAssembly support and engine assets.'));
      const onMessage = (event: Event) => {
        for (const line of String((event as MessageEvent).data).split('\n')) {
          if (line.trim() === 'uciok') { worker.postMessage('setoption name Hash value 16'); worker.postMessage('isready'); }
          if (line.trim() === 'readyok') { cleanup(); resolve(); }
        }
      };
      const timer = setTimeout(() => fail(new Error('Stockfish initialization timed out.')), 20000);
      this.pendingReject = fail;
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage('uci');
    });
    return this.waitForReady(this.ready, signal);
  }

  private waitForReady(ready: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return ready;
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => { this.terminate(); reject(new DOMException('Analysis cancelled.', 'AbortError')); };
      signal.addEventListener('abort', onAbort, { once: true });
      ready.then(() => { signal.removeEventListener('abort', onAbort); resolve(); }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
    });
  }

  async evaluate(fen: string, options: EvaluateOptions = {}): Promise<Evaluation> {
    if (options.signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
    if (this.busy) throw new Error('An engine evaluation is already running.');
    this.busy = true;
    try {
      const chess = new Chess(fen);
      if (chess.isCheckmate()) return { score: { cp: null, mate: 0, mated: chess.turn() }, depth: 0, pv: [], bestMove: null };
      if (chess.isStalemate() || chess.isInsufficientMaterial()) return { score: { cp: 0, mate: null }, depth: 0, pv: [], bestMove: null };
      await this.init(options.signal);
      if (options.signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
      const worker = this.worker!;
      const moveTimeMs = Math.max(50, Math.min(3000, options.moveTimeMs ?? 250));
      const depth = Math.max(1, Math.min(24, options.depth ?? 16));
      return await new Promise<Evaluation>((resolve, reject) => {
        let latest: Evaluation | null = null;
        const cleanup = () => { clearTimeout(timer); worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); options.signal?.removeEventListener('abort', onAbort); this.pendingReject = null; };
        const fail = (error: Error) => { cleanup(); this.terminate(); reject(error); };
        const onAbort = () => fail(new DOMException('Analysis cancelled.', 'AbortError'));
        const onError = () => fail(new Error('Stockfish stopped unexpectedly. Please retry.'));
        const onMessage = (event: Event) => {
          for (const raw of String((event as MessageEvent).data).split('\n')) {
            const line = raw.trim();
            const info = parseInfo(line, chess.turn());
            if (info) latest = info;
            if (line.startsWith('bestmove ')) {
              cleanup();
              if (!latest) { reject(new Error('Stockfish returned no scored variation.')); return; }
              const best = line.split(/\s+/)[1];
              resolve({ ...latest, bestMove: best === '(none)' || best === '0000' ? null : best });
            }
          }
        };
        const timer = setTimeout(() => fail(new Error('Stockfish evaluation timed out.')), moveTimeMs + 10000);
        this.pendingReject = fail;
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        worker.postMessage(`position fen ${fen}`);
        worker.postMessage(`go depth ${depth} movetime ${moveTimeMs}`);
      });
    } finally { this.busy = false; }
  }

  terminate(): void {
    const reject = this.pendingReject;
    this.pendingReject = null;
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    if (reject) reject(new Error('Engine terminated.'));
  }
}

export async function analyzeGame(
  game: ParsedGame,
  color: 'w' | 'b',
  onProgress?: (progress: AnalysisProgress) => void,
  signal?: AbortSignal,
  options: { moveTimeMs?: number; budgetMs?: number; maxMoves?: number; engine?: StockfishEngine } = {},
): Promise<GameAnalysis> {
  const engine = options.engine ?? new StockfishEngine();
  const moveTimeMs = options.moveTimeMs ?? 250;
  const moves: ParsedMove[] = game.moves.filter(move => move.color === color);
  const maxMoves = options.maxMoves ?? 100;
  const budgetMs = options.budgetMs ?? 60000;
  const mistakes: AnalysisMistake[] = [];
  let completed = 0;
  try {
    await engine.init(signal);
    const started = Date.now();
    for (const move of moves) {
      if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
      if (completed >= maxMoves || Date.now() - started > budgetMs) break;
      const before = await engine.evaluate(move.before, { moveTimeMs, signal });
      const after = before.bestMove === move.uci ? before : await engine.evaluate(move.after, { moveTimeMs, signal });
      const lossCp = moverLoss(before.score, after.score, color);
      if (lossCp >= 80 && before.bestMove && before.bestMove !== move.uci) {
        mistakes.push({ id: `${game.id}-${move.ply}`, ply: move.ply, fen: move.before, color, playedUci: move.uci, playedSan: move.san, bestUci: before.bestMove, lossCp, depth: Math.min(before.depth, after.depth || before.depth), pv: before.pv, before: before.score, after: after.score });
      }
      completed++;
      onProgress?.({ completed, total: moves.length, ply: move.ply });
    }
  } finally { engine.terminate(); }
  return { gameId: game.id, color, mistakes: mistakes.sort((a, b) => b.lossCp - a.lossCp), analyzedMoves: completed, totalMoves: moves.length, partial: completed < moves.length, engine: 'Stockfish 19 lite · local browser', moveTimeMs };
}
