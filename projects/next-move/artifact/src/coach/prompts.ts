/**
 * Coach prompts (port plan section 4). Pure functions: every fact in a prompt comes from a CoachInput field
 * and nowhere else. Each builder also returns what the answer may cite (SAN moves and numbers), which
 * `ground.ts` checks the answer against.
 */
import type { CoachExplainInput, CoachInput, CoachSummaryInput } from '../contract/coach';
import { canonicalJson, stableId } from './hash';

export interface BuiltPrompt {
  prompt: string;
  modelTier: 'quick' | 'default';
  /** SAN moves the answer may name (as written in the prompt). */
  sans: string[];
  /** Numbers the answer may cite (as rendered in the prompt's data, not its instructions). */
  numbers: number[];
  /** The position, so bare squares occupied there may be named. */
  fen?: string;
}

/** Longest line passed to the model, in plies (engine lines are stored up to 8; this only bounds odd input). */
const MAX_LINE = 12;
const MAX_THEMES = 10;
const clean = (s: string, max = 80) => String(s).replace(/[\r\n\t]+/g, ' ').slice(0, max);
const round = (x: number) => Math.round(x);
const pct = (r: number | null) => (r === null ? null : Math.round(r * 100));
const numbersIn = (text: string) => (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);

export function inputsHash(input: CoachInput): string {
  return `h${stableId(canonicalJson(input))}`;
}

/**
 * "Why does my move fail?" (modelTier default). Wording follows plan section 4 with two changes:
 * the learner is "the learner" (neutral), and the Win% drop is stated so the model may cite it.
 * Sentences whose fields are absent are dropped (bank puzzles carry no evaluation; a refutation is
 * passed only when it belongs to the move actually played).
 */
export function buildExplainPrompt(input: CoachExplainInput): BuiltPrompt {
  const side = input.side === 'w' ? 'White' : 'Black';
  const best = input.bestLineSan.slice(0, MAX_LINE).map(m => clean(m, 12));
  const refutation = input.refutationSan.slice(0, MAX_LINE).map(m => clean(m, 12));
  const played = clean(input.playedSan, 12), bestSan = clean(input.bestSan, 12);
  const themes = input.themes.slice(0, MAX_THEMES).map(t => clean(t, 40));
  const numbers: number[] = [];
  const parts = [
    'You are a chess coach for an adult rated about 1000.',
    `Position (FEN): ${clean(input.fen, 120)}. ${side} to move.`,
  ];
  const say = (sentence: string) => { parts.push(sentence); };
  say(`The learner played ${played}.`);
  say(`The engine's best move was ${bestSan}${best.length ? `, best line: ${best.join(' ')}` : ''}.`);
  if (refutation.length) say(`After the learner's move the engine's reply line is: ${refutation.join(' ')}.`);
  const wb = typeof input.winBefore === 'number' && Number.isFinite(input.winBefore) ? round(input.winBefore) : null;
  const wa = typeof input.winAfter === 'number' && Number.isFinite(input.winAfter) ? round(input.winAfter) : null;
  // The only figures an explain answer may cite: the rendered win chances and their difference.
  if (wb !== null && wa !== null) { say(`Stored evaluation from the learner's point of view: before ${wb}% win chance, after ${wa}% (a drop of ${wb - wa} points).`); numbers.push(wb, wa, wb - wa); }
  else if (wb !== null) { say(`Stored evaluation from the learner's point of view before the move: ${wb}% win chance.`); numbers.push(wb); }
  if (themes.length) say(`Themes: ${themes.join(', ')}.`);
  parts.push(
    `Using ONLY these lines and numbers, explain in at most 90 plain words why ${played} fails and what idea ${bestSan} uses.`,
    'Do not give any evaluation, move or line that is not listed above. If the lines do not show the reason, say so.',
  );
  return {
    prompt: parts.join(' '),
    modelTier: 'default',
    sans: [played, bestSan, ...best, ...refutation],
    numbers,
    fen: input.fen,
  };
}

/** "What should I practise next?" (modelTier quick; M2). Three bullets, each citing one number given. */
export function buildSummaryPrompt(input: CoachSummaryInput): BuiltPrompt {
  const data: string[] = [];
  const session = input.session.slice(0, 15).map(s => `${clean(s.theme, 40)} ${s.correct}/${s.attempts} correct${pct(s.rate) !== null ? ` (${pct(s.rate)}%)` : ''}`);
  const weakest = input.weakest.slice(0, 5).map(w => `${clean(w.theme, 40)} ${pct(w.rate) !== null ? `${pct(w.rate)}%` : 'no rate yet'} over ${w.attempts} attempts`);
  const focus = input.focus.slice(0, 8).map(f => `${clean(f.theme, 40)} (weight ${f.weight}): ${clean(f.reason, 200)}`);
  const lines = [
    `This session, by theme: ${session.length ? session.join('; ') : 'no attempts'}.`,
    `Weakest themes over all practice: ${weakest.length ? weakest.join('; ') : 'none yet'}.`,
    `Current plan focus: ${focus.length ? focus.join('; ') : 'none'}.`,
  ];
  data.push(...lines);
  const prompt = [
    'You are a chess coach for an adult rated about 1000.',
    ...lines,
    'Write exactly three bullets of at most 20 words each on what to practise next. Each bullet must cite one number given above.',
    'Do not use any number, move or evaluation that is not given above.',
  ].join(' ');
  return { prompt, modelTier: 'quick', sans: [], numbers: data.flatMap(numbersIn) };
}

export function buildPrompt(input: CoachInput): BuiltPrompt {
  return input.kind === 'explain' ? buildExplainPrompt(input) : buildSummaryPrompt(input);
}
