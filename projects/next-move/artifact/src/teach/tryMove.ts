/**
 * Live check of a wrong try (brief M3 L4) and the engine timing check in `#selftest` (L12).
 *
 * After a wrong move the bundled engine searches the position after the try and, for comparison, the
 * position after the card's answer (depth 12, MultiPV 1, 1500 ms per search). Both scores become the
 * solver's winning chances, 0-100 (the solver is the side to move before the try; engine scores are White's
 * point of view, `src/analysis/engine.ts`), and the verdict follows L4:
 *   also-good  tryWin >= max(65, bestWin - 5); with no answer to compare, tryWin >= 65
 *   losing     tryWin < 35
 *   worse      otherwise
 * A finished position (checkmate, stalemate, insufficient material) is scored without the engine: a mate
 * 100 or 0, a draw 50. The reply line is the engine's line after the try, replayed with chess.js: at most
 * 6 plies, cut at the first illegal move.
 *
 * Time. The shared engine (`getSharedEngine`) caps each search inside the worker: past 1500 ms it stops and
 * keeps the deepest line it reached, so `depth` can come back below 12. Starting the worker is outside that
 * cap. A backstop here abandons a search that has not settled `maxMs` + 25 s after it began (room for the
 * worker's start-up and for a stopped search to answer) and rejects with a TimeoutError.
 * Searches on one engine run one at a time, because the worker engine refuses a second search while one
 * runs; send every search through `searchOnce` or `checkTry`. The caller's abort rejects at once with the
 * engine's AbortError (`isAbort`), also while a search is waiting its turn. Any other failure rejects with
 * an ordinary Error, so the caller can fall back to the stored lines.
 */
import { Chess, type Move } from 'chess.js';
import type { EngineScore } from '@/lib/chess-engine';
import { abortError, createWorkerEngine, terminalLines, type AnalysisEngine, type EngineLine } from '@/src/analysis/engine';
import { winPctFromCp } from './values';

type Color = 'w' | 'b';

export const TRY_DEPTH = 12;
/** Search time cap per search (L4). The shared engine enforces it inside the worker. */
export const TRY_MAX_MS = 1500;
/** Plies of the engine's reply line kept after the try. */
export const REPLY_PLIES = 6;
export const ALSO_GOOD_FLOOR = 65;
export const ALSO_GOOD_MARGIN = 5;
export const LOSING_BELOW = 35;
/** Backstop allowance on top of `maxMs`: the worker's start-up (engine.ts allows 20 s) and 5 s for a stopped search. */
export const START_ALLOWANCE_MS = 25_000;

export interface TryCheck {
  tryUci: string;
  trySan: string;
  /** The engine's line after the try, UCI, at most 6 plies; empty when the try ended the game. */
  replyLine: string[];
  /** Solver's winning chances after the try, 0-100, one decimal. */
  tryWin: number;
  /** Solver's winning chances after the answer; null when no answer was given. */
  bestWin: number | null;
  verdict: 'also-good' | 'worse' | 'losing';
  /** The shallowest search the result rests on; 0 when no search was needed (finished positions only). */
  depth: number;
  /** Whole check, queue wait and worker start-up included. */
  ms: number;
}

export interface TryOptions {
  depth?: number;
  /** Per-search cap, default 1500 ms. The shared engine applies its own 1500 ms cap; here it sets the backstop. */
  maxMs?: number;
  signal?: AbortSignal;
  /** Abandon a search still unsettled this long after it began (default `maxMs` + 25 s). For tests and own engines. */
  backstopMs?: number;
}

export interface SearchResult {
  /** The engine's line from the searched position, UCI as reported (not replayed); empty for a finished position. */
  line: string[];
  /** White's point of view (lib convention). */
  score: EngineScore;
  /** Depth reached; 0 for a finished position (no search). */
  depth: number;
  terminal: boolean;
  ms: number;
}

const tenths = (x: number) => Math.round(x * 10);

/**
 * The solver's winning chances, 0-100 with one decimal, from an engine score in White's point of view.
 * `sideToMove` is the side to move in the searched position: a `mate 0` score without `mated` means that
 * side is checkmated. A mate counts 100 or 0 (L4); centipawns go through `winPctFromCp` (values.ts: the Lichess
 * formula with the 1000 cp ceiling the rest of the app uses). Mate is read here, not in `winPctFromScore`, because
 * engine scores are White's view and a bare `mate 0` belongs to the side to move of the searched position.
 */
export function solverWin(score: EngineScore, solver: Color, sideToMove: Color): number {
  const mated = score.mated ?? (score.mate === 0 ? sideToMove : undefined);
  if (mated) return mated === solver ? 0 : 100;
  if (typeof score.mate === 'number' && Number.isFinite(score.mate)) return (score.mate > 0) === (solver === 'w') ? 100 : 0;
  if (typeof score.cp === 'number' && Number.isFinite(score.cp)) return tenths(winPctFromCp(solver === 'w' ? score.cp : -score.cp)) / 10;
  throw new Error('The chess engine gave no score.');
}

/** The L4 verdict, compared in tenths so it agrees with the one-decimal numbers it is given. */
export function tryVerdict(tryWin: number, bestWin: number | null): TryCheck['verdict'] {
  const bar = Math.max(tenths(ALSO_GOOD_FLOOR), bestWin === null ? -Infinity : tenths(bestWin) - tenths(ALSO_GOOD_MARGIN));
  if (tenths(tryWin) >= bar) return 'also-good';
  return tenths(tryWin) < tenths(LOSING_BELOW) ? 'losing' : 'worse';
}

const UCI = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;
/** The legal move `uci` names in this position, or null. */
function legalMove(chess: Chess, uci: string): Move | null {
  const m = UCI.exec(uci);
  if (!m) return null;
  return chess.moves({ verbose: true }).find(x => x.from === m[1] && x.to === m[2] && (x.promotion ?? '') === (m[3] ?? '')) ?? null;
}
const uciOf = (m: Move) => `${m.from}${m.to}${m.promotion ?? ''}`;

/** The longest legal start of `line` from `fen`, at most `max` plies: an engine line is replayed, not trusted. */
function legalPrefix(fen: string, line: readonly string[], max: number): string[] {
  const chess = new Chess(fen);
  const out: string[] = [];
  for (const uci of line.slice(0, max)) {
    const m = legalMove(chess, uci);
    if (!m) break;
    chess.move({ from: m.from, to: m.to, promotion: m.promotion });
    out.push(uciOf(m));
  }
  return out;
}

function timeoutError(ms: number): Error {
  const e = new Error(`The chess engine gave no answer within ${ms} ms.`);
  e.name = 'TimeoutError';
  return e;
}
/** True for the backstop's rejection (a slow or stuck engine), as opposed to an abort or another failure. */
export const isTimeout = (e: unknown) => e instanceof Error && e.name === 'TimeoutError';

const noop = () => {};
const tails = new WeakMap<AnalysisEngine, Promise<void>>();

/** Runs `task` after every search already queued on `engine`. An abort rejects at once, also while waiting. */
function enqueue<T>(engine: AnalysisEngine, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
  const run = (tails.get(engine) ?? Promise.resolve()).then(() => {
    if (signal?.aborted) throw abortError();
    return task();
  });
  tails.set(engine, run.then(noop, noop));
  if (!signal) return run;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    run.then(v => { signal.removeEventListener('abort', onAbort); resolve(v); }, e => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/**
 * One MultiPV-1 search. The engine gets its own stop signal, aborted on the caller's abort and by the backstop;
 * it is aborted before this promise settles, so a worker engine has released itself before the next search starts.
 */
function runSearch(engine: AnalysisEngine, fen: string, depth: number, backstopMs: number, signal?: AbortSignal): Promise<EngineLine[]> {
  return new Promise<EngineLine[]>((resolve, reject) => {
    const stop = new AbortController();
    let open = true;
    const settle = (finish: () => void) => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      finish();
    };
    const onAbort = () => { stop.abort(); settle(() => reject(abortError())); };
    const timer = setTimeout(() => { stop.abort(); settle(() => reject(timeoutError(backstopMs))); }, backstopMs);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<EngineLine[]>;
    try { pending = Promise.resolve(engine.analyse(fen, { depth, multiPv: 1, signal: stop.signal })); } catch (e) { settle(() => reject(e)); return; }
    pending.then(lines => settle(() => resolve(lines)), e => settle(() => reject(e)));
  });
}

/**
 * One search through the queue: depth 12 and MultiPV 1 by default. A finished position is scored without the
 * engine. Used by `checkTry` and by the self-test, so the self-test times exactly this path.
 */
export async function searchOnce(engine: AnalysisEngine, fen: string, opts: TryOptions = {}): Promise<SearchResult> {
  const t0 = performance.now();
  if (opts.signal?.aborted) throw abortError();
  const depth = opts.depth ?? TRY_DEPTH;
  const backstopMs = opts.backstopMs ?? (opts.maxMs ?? TRY_MAX_MS) + START_ALLOWANCE_MS;
  const terminal = terminalLines(fen);
  const lines = terminal ?? await enqueue(engine, opts.signal, () => runSearch(engine, fen, depth, backstopMs, opts.signal));
  const best = lines[0];
  if (!best) throw new Error('The chess engine returned no line.');
  return { line: [...best.pv], score: best.score, depth: terminal ? 0 : best.depth, terminal: !!terminal, ms: Math.round(performance.now() - t0) };
}

/**
 * Checks a wrong try against the card's answer (L4). `fenBefore` is the position before the try, the solver
 * to move. Rejects when the try (or a given answer) is not a legal move there, when the engine fails or
 * gives no legal reply, on the backstop (TimeoutError) and on abort (AbortError).
 */
export async function checkTry(engine: AnalysisEngine, fenBefore: string, tryUci: string, answerUci: string | null, opts: TryOptions = {}): Promise<TryCheck> {
  const t0 = performance.now();
  if (opts.signal?.aborted) throw abortError();
  const board = new Chess(fenBefore);
  const solver: Color = board.turn();
  const opponent: Color = solver === 'w' ? 'b' : 'w';
  const tried = legalMove(board, tryUci);
  if (!tried) throw new Error(`The try ${tryUci} is not a legal move in this position.`);
  const answer = answerUci === null ? null : legalMove(board, answerUci);
  if (answerUci !== null && !answer) throw new Error(`The answer ${answerUci} is not a legal move in this position.`);

  const afterTry = await searchOnce(engine, tried.after, opts);
  const replyLine = afterTry.terminal ? [] : legalPrefix(tried.after, afterTry.line, REPLY_PLIES);
  if (!afterTry.terminal && !replyLine.length) throw new Error('The chess engine gave no legal reply to the try.');
  const tryWin = solverWin(afterTry.score, solver, opponent);
  const depths = afterTry.terminal ? [] : [afterTry.depth];

  let bestWin: number | null = null;
  if (answer && uciOf(answer) === uciOf(tried)) bestWin = tryWin;
  else if (answer) {
    const afterAnswer = await searchOnce(engine, answer.after, opts);
    bestWin = solverWin(afterAnswer.score, solver, opponent);
    if (!afterAnswer.terminal) depths.push(afterAnswer.depth);
  }
  return {
    tryUci: uciOf(tried), trySan: tried.san, replyLine, tryWin, bestWin, verdict: tryVerdict(tryWin, bestWin),
    depth: depths.length ? Math.min(...depths) : 0, ms: Math.round(performance.now() - t0),
  };
}

let shared: AnalysisEngine | null = null;
/**
 * The page's one engine for these checks: created on the first call, the worker starts on the first search.
 * Null where there is no Web Worker (tests, server rendering).
 */
export function getSharedEngine(): AnalysisEngine | null {
  if (typeof Worker === 'undefined') return null;
  shared ??= createWorkerEngine({ maxSearchMs: TRY_MAX_MS });
  return shared;
}
