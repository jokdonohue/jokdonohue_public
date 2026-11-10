/**
 * Coach contract (port plan section 4). B3 implements it in `src/coach/` and exports
 * `createCoach(deps: CoachDeps): CoachClient` from `src/coach/index.ts`; `main.tsx` calls it once
 * `claude.use("sample")` resolves non-null, and passes the client to the Trainer (B2).
 *
 * Frozen after milestone M-a; change only by agreement between B1, B2 and B3.
 */
import type { AttemptSource } from './docs';
import type { PermissionState, Store } from './store';

/** "Why does my move fail?" (modelTier "default"). Every prompt field comes from here and nowhere else. */
export interface CoachExplainInput {
  kind: 'explain';
  /** Card or puzzle id; with `playedUci` it keys `explanations/<itemId>__<playedUci>`. */
  itemId: string;
  source: AttemptSource;
  fen: string;
  /** Side to move at `fen` (the learner). */
  side: 'w' | 'b';
  playedUci: string;
  playedSan: string;
  bestUci: string;
  bestSan: string;
  /** Engine best line from `fen`, in SAN, starting with `bestSan`. */
  bestLineSan: string[];
  /** Engine reply line after the played move, in SAN; empty when not stored. */
  refutationSan: string[];
  /** Win chance (0-100) for the learner before and after the move. Absent for bank puzzles: the evaluation sentence is dropped. */
  winBefore?: number;
  winAfter?: number;
  /** Stored centipawns from the learner's view, when the source has them (games, pack). */
  cpBefore?: number | null;
  cpAfter?: number | null;
  themes: string[];
}

/** "What should I practise next?" on the session summary (modelTier "quick"; M2). */
export interface CoachSummaryInput {
  kind: 'summary';
  session: Array<{ theme: string; attempts: number; correct: number; rate: number | null }>;
  /** Top 5 of `derived/snapshot.weakest`. */
  weakest: Array<{ theme: string; rate: number | null; attempts: number }>;
  focus: Array<{ theme: string; weight: number; reason: string }>;
}

export type CoachInput = CoachExplainInput | CoachSummaryInput;

export interface CoachResult {
  text: string;
  /** False when a SAN token or a number in `text` is not in the inputs (show the check-on-the-board warning). */
  grounded: boolean;
  /** The ungrounded tokens, for the `grounded:false` review. */
  misses: string[];
  /** True when the answer came from `explanations/*` without a model call. */
  cached: boolean;
  truncated: boolean;
  /** Epoch ms of the answer. */
  at: number;
  inputsHash: string;
}

/**
 * What the page does with a failure, collapsed from the platform's SampleErrorCode:
 * - `hide`: not_granted, sampling_disabled, not_declared, capability_disabled, capability_removed:
 *   hide the button for this view, keep the static panel;
 * - `tell`: rate_limited, session_expired, refused, empty_completion, upstream_error, and the
 *   page's own limits (cooldown, daily cap, one call in flight): show `message`, keep the control;
 * - `cancelled`: the Stop button; restore the idle UI silently.
 */
export type CoachFailureAction = 'hide' | 'tell' | 'cancelled';
export type CoachErrorCode =
  | 'not_granted' | 'sampling_disabled' | 'not_declared' | 'capability_disabled' | 'capability_removed'
  | 'rate_limited' | 'session_expired' | 'refused' | 'empty_completion' | 'upstream_error'
  | 'cancelled' | 'busy' | 'cooldown' | 'daily_limit' | 'invalid_request' | 'prompt_too_large';
export interface CoachFailure {
  code: CoachErrorCode;
  action: CoachFailureAction;
  /** Viewer copy. */
  message: string;
  /** Partial answer that streamed before the failure, when the platform kept one. */
  partial?: string;
  /** For `cooldown`/`daily_limit`/`rate_limited`: epoch ms when asking makes sense again. */
  retryAt?: number;
}
/** Rejection type of `CoachClient.ask`. */
export class CoachError extends Error {
  constructor(readonly failure: CoachFailure) {
    super(failure.message);
    this.name = 'CoachError';
  }
}

export interface CoachAskOptions {
  signal?: AbortSignal;
  /** Streaming: called with the WHOLE answer so far. */
  onText?: (text: string) => void;
}

export interface CoachClient {
  /** `permissions.state("sample")`; never prompts. `prompt` -> label "Ask Claude (asks permission once)"; `denied`/`unavailable` -> hide. */
  availability(): Promise<PermissionState>;
  /** Cache first (`explanations/*`), then one rate-limited model call. Rejects `CoachError`. Call only from a click. */
  ask(input: CoachInput, options?: CoachAskOptions): Promise<CoachResult>;
  /** Calls left today on this device, and when the cooldown ends (epoch ms, 0 if none). */
  limits(): { remainingToday: number; cooldownUntil: number };
}

/** Minimal shape of the platform `sample` namespace that the coach needs (see sample.d.ts, contract 0.2.96). */
export interface SampleFn {
  (input: string | Array<{ role: 'user' | 'assistant'; content: string }>, options?: {
    modelTier?: 'quick' | 'default' | 'complex';
    signal?: AbortSignal;
    onText?: (chunk: { text: string; delta: string }) => void;
    cache?: boolean;
  }): Promise<{ text: string; truncated: boolean }>;
}
/** Minimal shape of the platform `permissions` namespace. */
export interface PermissionsApi {
  state(name: string): Promise<PermissionState>;
}

export interface CoachDeps {
  sample: SampleFn;
  /** Null when the permissions namespace is unavailable: treat availability as `prompt`. */
  permissions: PermissionsApi | null;
  store: Store;
  deviceId: string;
  /** Browser storage for the per-device rate-limit counter (localStorage in the page; a Map in tests). */
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  now?: () => number;
}
export type CreateCoach = (deps: CoachDeps) => CoachClient;
