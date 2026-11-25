import raw from '../data/technical_endgames_teach.json';

/**
 * Teaching data for the 26 technique drills (M3, L9): the idea behind each drill, the tablebase result of
 * every legal move at every solver step, and for up to four plausible tries per step the tablebase best
 * line after the try with a one-sentence note. Results are from the solver's point of view.
 * Built by reviews/claude/tools/m3/endgame_teach/ from the Lichess Syzygy tablebase; checked by
 * tests/m3_endgame_teach.test.ts. No live engine is used on these drills.
 *
 * `step` is the index into the drill's `moves` of the solver move at that step (0, 2, 4, ...), so
 * `moves[step]` is the drill's answer at `fen`.
 */
export type TeachResult = 'win' | 'draw' | 'loss';
export interface TeachTry { uci: string; san: string; result: TeachResult; lineUci: string[]; note: string }
export interface TeachStep { step: number; fen: string; results: Record<string /* uci */, TeachResult>; tries: TeachTry[] }
export interface DrillTeach { id: string; idea: string; keySquares?: string[]; steps: TeachStep[] }

/** File layout (results grouped by outcome to keep the file small). */
interface RawTry { uci: string; san: string; result: string; lineUci: string[]; note: string }
interface RawStep { step: number; fen: string; win: string[]; draw: string[]; loss: string[]; tries: RawTry[] }
interface RawDrill { id: string; idea: string; keySquares?: string[]; steps: RawStep[] }
interface RawFile { version: number; drills: RawDrill[] }

const isResult = (v: string): v is TeachResult => v === 'win' || v === 'draw' || v === 'loss';

/** Placement, side to move, castling and en passant: move clocks do not change a tablebase result. */
export const positionKey = (fen: string) => fen.trim().split(/\s+/).slice(0, 4).join(' ');

function toStep(s: RawStep): TeachStep {
  const results: Record<string, TeachResult> = {};
  for (const r of ['win', 'draw', 'loss'] as const) for (const uci of s[r]) results[uci] = r;
  const tries = s.tries.filter(t => isResult(t.result)).map(t => Object.freeze({
    uci: t.uci, san: t.san, result: t.result as TeachResult, lineUci: Object.freeze([...t.lineUci]) as string[], note: t.note,
  }));
  return Object.freeze({ step: s.step, fen: s.fen, results: Object.freeze(results) as Record<string, TeachResult>, tries: Object.freeze(tries) as TeachTry[] });
}

let table: Map<string, DrillTeach> | null = null;
function all(): Map<string, DrillTeach> {
  if (table) return table;
  table = new Map();
  for (const d of (raw as RawFile).drills) {
    table.set(d.id, Object.freeze({
      id: d.id, idea: d.idea,
      ...(d.keySquares?.length ? { keySquares: Object.freeze([...d.keySquares]) as string[] } : {}),
      steps: Object.freeze(d.steps.map(toStep)) as TeachStep[],
    }));
  }
  return table;
}

/** Every drill id that has teaching data. */
export function teachDrillIds(): string[] { return [...all().keys()]; }

/** The teaching data for one drill, or null for an unknown id. The returned objects are frozen. */
export function drillTeach(id: string): DrillTeach | null { return all().get(id) ?? null; }

/** The step whose position is `fen` (clocks ignored), or null. */
export function teachStep(id: string, fen: string): TeachStep | null {
  const key = positionKey(fen);
  return drillTeach(id)?.steps.find(s => positionKey(s.fen) === key) ?? null;
}

/**
 * The tablebase result (solver's view) of playing `uci` at `fen` in drill `id`, and the stored line with its
 * note when the move is one of the listed tries. `result` is null when the drill or position is unknown or
 * the move is not legal there.
 */
export function teachTry(id: string, fen: string, uci: string): { result: TeachResult | null; tryLine?: TeachTry } {
  const step = teachStep(id, fen);
  if (!step) return { result: null };
  const move = uci.trim().toLowerCase();
  const result = step.results[move] ?? null;
  const tryLine = step.tries.find(t => t.uci === move);
  return tryLine ? { result, tryLine } : { result };
}
