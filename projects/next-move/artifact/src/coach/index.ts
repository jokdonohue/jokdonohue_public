/**
 * The coach client (port plan section 4; contract `src/contract/coach.ts`). `main.tsx` calls
 * `createCoach(deps)` once `claude.use("sample")` resolves non-null; with no `sample` the Trainer gets
 * `coach: null` and shows `staticPanel` (exported here) on its own.
 *
 * `ask` order: validate -> cache (`explanations/*`, same inputsHash) -> limits -> one model call -> grounding
 * check -> cache write (best effort and not awaited; a failed or slow write never affects the answer).
 */
import type {
  CoachAskOptions, CoachClient, CoachDeps, CoachErrorCode, CoachFailure, CoachInput, CoachResult,
} from '../contract/coach';
import { CoachError } from '../contract/coach';
import { paths, prepareWrite, readDoc, type ExplanationDoc } from '../contract/docs';
import type { PermissionState } from '../contract/store';
import { buildPrompt, inputsHash } from './prompts';
import { groundCheck } from './ground';
import { createLimiter, nextLocalMidnight } from './rateLimit';

export { buildExplainPrompt, buildSummaryPrompt, buildPrompt, inputsHash } from './prompts';
export { groundCheck } from './ground';
export { explainInputFromPackCard, explainInputFromPuzzle, staticPanel, staticPanelText, sanMoves } from './inputs';
export { COOLDOWN_MS, DAILY_LIMIT } from './rateLimit';

/** Viewer copy for the "check this on the board" warning (plan section 4). */
export const UNGROUNDED_WARNING = 'Check this on the board: part of this answer is not from the engine line.';
/** Button label while consent is pending (plan section 4). */
export const ASK_LABEL_PROMPT = 'Ask Claude (asks permission once)';

const HIDE: CoachErrorCode[] = ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'];
const MESSAGES: Partial<Record<CoachErrorCode, string>> = {
  not_granted: 'Claude is not available for this page.',
  sampling_disabled: 'Claude is not available for this account.',
  not_declared: 'Claude is not available for this page.',
  capability_disabled: 'Claude is not available in this view.',
  capability_removed: 'Claude is not available in this view.',
  rate_limited: "Claude's usage limit is reached for today. The engine lines above still apply.",
  session_expired: 'Sign in to claude.ai again to ask Claude.',
  refused: 'Claude declined this question. The engine lines above still apply.',
  empty_completion: 'Claude returned no answer. The engine lines above still apply.',
  upstream_error: 'Claude could not be reached. Try again in a moment.',
  invalid_request: 'This question could not be sent.',
  prompt_too_large: 'This question is too long to send.',
  cancelled: 'Stopped.',
};

/** Collapse a platform SampleError (or anything thrown) into a CoachFailure. */
export function toFailure(e: unknown): CoachFailure {
  const raw = (e && typeof e === 'object' ? (e as { code?: unknown; text?: unknown }) : {});
  let code = typeof raw.code === 'string' ? raw.code : (e instanceof DOMException && e.name === 'AbortError' ? 'cancelled' : 'upstream_error');
  if (code === 'transform_error' || code === 'queue_overflow') code = 'invalid_request';
  if (!(code in MESSAGES)) code = 'upstream_error';
  const c = code as CoachErrorCode;
  const action = c === 'cancelled' ? 'cancelled' : HIDE.includes(c) ? 'hide' : 'tell';
  const partial = c !== 'refused' && typeof raw.text === 'string' && raw.text ? raw.text : undefined;
  return { code: c, action, message: MESSAGES[c]!, ...(partial ? { partial } : {}) };
}

function validate(input: CoachInput): void {
  const bad = (why: string) => { throw new CoachError({ code: 'invalid_request', action: 'tell', message: `This question could not be sent (${why}).` }); };
  if (!input || (input.kind !== 'explain' && input.kind !== 'summary')) bad('unknown kind');
  if (input.kind === 'explain') {
    if (!input.itemId || !input.fen || !input.playedSan || !input.bestSan) bad('missing fields');
    if (!Array.isArray(input.bestLineSan) || !Array.isArray(input.refutationSan) || !Array.isArray(input.themes)) bad('lines');
  } else if (!Array.isArray(input.session) || !Array.isArray(input.weakest) || !Array.isArray(input.focus)) bad('summary fields');
}

export function createCoach(deps: CoachDeps): CoachClient {
  const now = deps.now ?? Date.now;
  const limiter = createLimiter({ deviceId: deps.deviceId, storage: deps.storage, now });

  async function cached(input: CoachInput, hash: string): Promise<CoachResult | null> {
    if (input.kind !== 'explain') return null;
    try {
      const path = paths.explanation(input.itemId, input.playedUci);
      const doc = await deps.store.get(path);
      const body = doc ? readDoc<ExplanationDoc>(path, doc.data) : null;
      if (!body || body.inputsHash !== hash) return null;
      return { text: body.text, grounded: body.grounded, misses: body.misses ?? [], cached: true, truncated: false, at: body.at, inputsHash: hash };
    } catch { return null; }
  }

  async function remember(input: CoachInput, result: CoachResult): Promise<void> {
    if (input.kind !== 'explain' || result.truncated) return;
    try {
      const path = paths.explanation(input.itemId, input.playedUci);
      const body = prepareWrite(path, {
        text: result.text.slice(0, 3000), at: result.at, grounded: result.grounded, inputsHash: result.inputsHash,
        itemId: input.itemId, playedUci: input.playedUci, misses: result.misses.slice(0, 20),
      });
      await deps.store.set(path, body);
    } catch { /* best effort: the answer is already shown */ }
  }

  return {
    async availability(): Promise<PermissionState> {
      if (!deps.permissions) return 'prompt';
      try { return await deps.permissions.state('sample'); } catch { return 'prompt'; }
    },

    async ask(input: CoachInput, options: CoachAskOptions = {}): Promise<CoachResult> {
      validate(input);
      const hash = inputsHash(input);
      const hit = await cached(input, hash);
      if (hit) return hit;
      if (options.signal?.aborted) throw new CoachError(toFailure({ code: 'cancelled' }));
      const blocked = limiter.check();
      if (blocked) throw new CoachError(blocked);
      const built = buildPrompt(input);
      limiter.start();
      let answer: { text: string; truncated: boolean };
      try {
        answer = await deps.sample(built.prompt, {
          modelTier: built.modelTier,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onText ? { onText: (chunk: { text: string }) => options.onText!(chunk.text) } : {}),
        });
      } catch (e) {
        const failure = toFailure(e);
        if (failure.code === 'rate_limited') { limiter.block(); failure.retryAt = nextLocalMidnight(now()); }
        throw new CoachError(failure);
      } finally {
        limiter.end();
      }
      const text = (answer?.text ?? '').trim();
      if (!text) throw new CoachError(toFailure({ code: 'empty_completion' }));
      const ground = groundCheck(text, built, input.kind);
      const result: CoachResult = { text, grounded: ground.grounded, misses: ground.misses, cached: false, truncated: !!answer.truncated, at: now(), inputsHash: hash };
      void remember(input, result); // not awaited: a slow store never holds back an answer already shown
      return result;
    },

    limits() { return limiter.limits(); },
  };
}
