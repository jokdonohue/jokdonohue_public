/**
 * A small UCI driver for the bundled Stockfish worker with MultiPV, for the PGN analysis.
 *
 * Why not `lib/chess-engine.ts` `StockfishEngine.evaluate` (read-only for this stream): it keeps only the
 * last `info` line (at MultiPV 2 that is the second line's score), always adds a `movetime` cap, and its
 * default worker URL is an absolute engine path that the strict build rejects. This driver reuses
 * lib's `parseInfo` for every score and line, reads `multipv N` itself, searches to a fixed depth, and loads
 * the worker by the same relative URL as the self-test (`src/store/selftest.tsx`).
 */
import { Chess } from 'chess.js';
import { parseInfo, type EngineScore } from '@/lib/chess-engine';

/** One search line. `score` is from White's point of view (lib convention). */
export interface EngineLine { multipv: number; depth: number; score: EngineScore; pv: string[] }
export interface AnalyseOptions { depth: number; multiPv: 1 | 2; signal?: AbortSignal }
/** What the analysis needs from an engine; tests pass a stub. */
export interface AnalysisEngine {
  /** Lines sorted best first; empty only for a position with no legal move (then one terminal line). */
  analyse(fen: string, options: AnalyseOptions): Promise<EngineLine[]>;
  dispose(): void;
}

export const ENGINE_WORKER_URL = 'stockfish-19-lite-single.js';
export const ENGINE_LABEL = 'Stockfish 19 lite, in this page';
const INIT_TIMEOUT_MS = 20_000;

export const abortError = () => new DOMException('Analysis stopped.', 'AbortError');
export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** The lines for a finished game position (no search needed), or null when moves exist. */
export function terminalLines(fen: string): EngineLine[] | null {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) return [{ multipv: 1, depth: 0, score: { cp: null, mate: 0, mated: chess.turn() }, pv: [] }];
  if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.moves().length === 0) return [{ multipv: 1, depth: 0, score: { cp: 0, mate: null }, pv: [] }];
  return null;
}

/** Parse one `info` line with its MultiPV index (1 when absent). */
export function parseLine(line: string, turn: 'w' | 'b'): EngineLine | null {
  const info = parseInfo(line, turn);
  if (!info || info.pv.length === 0) return null;
  const k = /\bmultipv (\d+)/.exec(line);
  return { multipv: k ? Number(k[1]) : 1, depth: info.depth, score: info.score, pv: info.pv };
}

/**
 * Of the lines seen during one search, the latest report of each line, best first. Stockfish reports every
 * line at each depth in order, so after a full `go depth N` these all come from depth N; after a watchdog
 * stop the second line may be one iteration shallower (callers record the smaller depth).
 */
export function finalLines(seen: EngineLine[], multiPv: number): EngineLine[] {
  const latest = new Map<number, EngineLine>();
  for (const l of seen) if (l.multipv <= multiPv) latest.set(l.multipv, l);
  return [...latest.values()].sort((a, b) => a.multipv - b.multipv);
}

type WorkerLike = Pick<Worker, 'postMessage' | 'terminate' | 'addEventListener' | 'removeEventListener'>;

/**
 * The real engine: one Web Worker running the bundled Stockfish, created on first use.
 * `maxSearchMs` is a watchdog: past it the search is told to stop and returns the deepest lines it has.
 */
export function createWorkerEngine(options: { workerFactory?: () => WorkerLike; maxSearchMs?: number } = {}): AnalysisEngine {
  const factory = options.workerFactory ?? (() => new Worker(ENGINE_WORKER_URL));
  const maxSearchMs = options.maxSearchMs ?? 30_000;
  let worker: WorkerLike | null = null;
  let ready: Promise<WorkerLike> | null = null;
  let multiPvSet = 0;
  let busy = false;

  function kill() {
    try { worker?.terminate(); } catch { /* already gone */ }
    worker = null; ready = null; multiPvSet = 0;
  }
  function start(): Promise<WorkerLike> {
    if (ready) return ready;
    ready = new Promise<WorkerLike>((resolve, reject) => {
      let w: WorkerLike;
      try { w = factory(); } catch { reject(new Error('The chess engine could not start on this device.')); return; }
      worker = w;
      const done = () => { clearTimeout(timer); w.removeEventListener('message', onMessage); w.removeEventListener('error', onError); };
      const fail = (message: string) => { done(); kill(); reject(new Error(message)); };
      const onError = () => fail('The chess engine could not start on this device.');
      const onMessage = (event: Event) => {
        for (const raw of String((event as MessageEvent).data).split('\n')) {
          const line = raw.trim();
          if (line === 'uciok') { w.postMessage('setoption name Hash value 16'); w.postMessage('isready'); }
          if (line === 'readyok') { done(); resolve(w); }
        }
      };
      const timer = setTimeout(() => fail('The chess engine took too long to start.'), INIT_TIMEOUT_MS);
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      w.postMessage('uci');
    });
    return ready;
  }

  return {
    async analyse(fen, { depth, multiPv, signal }) {
      if (signal?.aborted) throw abortError();
      const terminal = terminalLines(fen);
      if (terminal) return terminal;
      if (busy) throw new Error('The engine is already busy.');
      busy = true;
      try {
        const w = await withAbort(start(), signal);
        if (multiPvSet !== multiPv) { w.postMessage(`setoption name MultiPV value ${multiPv}`); multiPvSet = multiPv; }
        const turn = fen.split(/\s+/)[1] === 'b' ? 'b' : 'w';
        return await new Promise<EngineLine[]>((resolve, reject) => {
          const seen: EngineLine[] = [];
          let stopTimer: ReturnType<typeof setTimeout> | undefined;
          const done = () => { clearTimeout(watchdog); clearTimeout(stopTimer); w.removeEventListener('message', onMessage); w.removeEventListener('error', onError); signal?.removeEventListener('abort', onAbort); };
          const fail = (e: Error | DOMException) => { done(); kill(); reject(e); };
          const onAbort = () => fail(abortError());
          const onError = () => fail(new Error('The chess engine stopped unexpectedly.'));
          const onMessage = (event: Event) => {
            for (const raw of String((event as MessageEvent).data).split('\n')) {
              const line = raw.trim();
              const parsed = parseLine(line, turn);
              if (parsed) seen.push(parsed);
              if (line.startsWith('bestmove ')) {
                done();
                const lines = finalLines(seen, multiPv);
                if (!lines.length) { reject(new Error('The chess engine returned no result for a position.')); return; }
                resolve(lines);
              }
            }
          };
          const watchdog = setTimeout(() => {
            w.postMessage('stop');
            stopTimer = setTimeout(() => fail(new Error('The chess engine stopped responding.')), 5_000);
          }, maxSearchMs);
          w.addEventListener('message', onMessage);
          w.addEventListener('error', onError);
          signal?.addEventListener('abort', onAbort, { once: true });
          w.postMessage(`position fen ${fen}`);
          w.postMessage(`go depth ${depth}`);
        });
      } finally { busy = false; }
    },
    dispose() { kill(); },
  };
}

function withAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(v => { signal.removeEventListener('abort', onAbort); resolve(v); }, e => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}
