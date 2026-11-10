/**
 * Pure practice-selection rules for the artifact Trainer (port plan sections 3 and 10 c).
 *
 * No `@/lib` imports: the scheduler functions are passed in, so these rules are testable on their own
 * and the Trainer wires the real `selectPuzzle` and `withThemePriors`.
 */
import { MIX_KEYS, toMs, type FeedbackDoc, type PlanDoc } from '@/src/contract/docs';

export type MixKey = (typeof MIX_KEYS)[number];
export type Mix = Record<MixKey, number>;

/** Item c caps. 20 reviews and 10 new positions a day is a judgement call (plan section 10, row c). */
export const DEFAULT_REVIEW_CAP = 20;
export const DEFAULT_NEW_CAP = 10;

/** Local calendar day `YYYY-MM-DD` of an epoch-ms time (the device's own time zone). */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface DailyCounts { date: string; reviews: number; new: number }
/**
 * Today's counts. An attempt is "new" when it is the first ever attempt at that position; every other
 * attempt made today (including a same-day retry after a miss) counts as a review.
 */
export function dailyCounts(attempts: readonly { puzzleId: string; at: number }[], now: number): DailyCounts {
  const date = localDay(now);
  const seen = new Set<string>();
  let reviews = 0, fresh = 0;
  for (const a of [...attempts].sort((x, y) => x.at - y.at)) {
    const first = !seen.has(a.puzzleId);
    seen.add(a.puzzleId);
    if (localDay(a.at) !== date) continue;
    if (first) fresh++; else reviews++;
  }
  return { date, reviews, new: fresh };
}

export interface Caps { reviewCap: number; newCap: number }
export interface CapState { reviewsLeft: number; newLeft: number; done: boolean }
export function capState(counts: DailyCounts, caps: Caps): CapState {
  const reviewsLeft = Math.max(0, caps.reviewCap - counts.reviews);
  const newLeft = Math.max(0, caps.newCap - counts.new);
  return { reviewsLeft, newLeft, done: reviewsLeft === 0 && newLeft === 0 };
}

/**
 * Today's pool under the caps: unseen positions only while new places remain, due reviews only while
 * review places remain. Nothing else is served in the daily set, so it ends cleanly.
 */
export function todayPool<P extends { id: string }>(pool: readonly P[], cards: Readonly<Record<string, { due: number }>>, caps: CapState, now: number): P[] {
  return pool.filter(p => {
    const card = cards[p.id];
    if (!card) return caps.newLeft > 0;
    return caps.reviewsLeft > 0 && card.due <= now;
  });
}

/** The plan while it is in force; null once `expires` has passed or when it cannot be dated. */
export function activePlan(plan: PlanDoc | null | undefined, now: number): PlanDoc | null {
  if (!plan) return null;
  const expires = toMs(plan.expires);
  return Number.isFinite(expires) && expires > now ? plan : null;
}

/**
 * Pack priors with the plan's focus applied: each focus theme's prior (1 when the pack has none) is
 * multiplied by `focus.weight` (plan section 3). The scheduler adapter clamps the result.
 */
export function focusPriors(priors: Readonly<Record<string, number>> | null | undefined, plan: PlanDoc | null): Record<string, number> {
  const out: Record<string, number> = { ...(priors ?? {}) };
  for (const f of plan?.focus ?? []) {
    if (['__proto__', 'constructor', 'prototype'].includes(f.theme)) continue;
    out[f.theme] = (Number.isFinite(out[f.theme]) && out[f.theme] > 0 ? out[f.theme] : 1) * f.weight;
  }
  return out;
}

/** Mix weights over the sources that have something to serve, renormalised to sum to 1; null when none can. */
export function sourceWeights(mix: Readonly<Partial<Mix>>, available: Readonly<Record<MixKey, number>>): Mix | null {
  const raw = MIX_KEYS.map(k => (available[k] > 0 && Number.isFinite(mix[k]) && (mix[k] as number) > 0 ? (mix[k] as number) : 0));
  const total = raw.reduce((s, x) => s + x, 0);
  if (total <= 0) return null;
  return Object.fromEntries(MIX_KEYS.map((k, i) => [k, raw[i] / total])) as Mix;
}

/**
 * Drill-set share (review P1-1; lead decision 2026-11-10, a judgement call). While at least one active drill
 * set from Claude has servable cards, those cards get `plan.mix.agent` of the picks as written when it is
 * above 0, otherwise this default (the value B3 seeds); the other sources share the rest in their mix
 * proportions. With no plan in force the default applies too. When no set is active, the agent share goes to
 * the other sources (renormalised). To stop a set, Claude sets `drills/<setId>.active` to false.
 */
export const DEFAULT_AGENT_SHARE = 0.1;
/** Normalised weights with the drill-set share applied when agent cards are available. */
export function withAgentShare(weights: Mix | null, agentAvailable: boolean, mixAgent: number | undefined): Mix | null {
  if (!weights || !agentAvailable) return weights;
  const share = Math.min(1, Number.isFinite(mixAgent) && (mixAgent as number) > 0 ? (mixAgent as number) : DEFAULT_AGENT_SHARE);
  const rest = 1 - weights.agent;
  if (rest <= 0) return weights;
  const scale = (1 - share) / rest;
  return { bank: weights.bank * scale, pack: weights.pack * scale, endgame: weights.endgame * scale, agent: share };
}

/** Pick a source from normalised weights with `r` in [0, 1). */
export function pickSource(weights: Mix, r: number): MixKey {
  let acc = 0;
  for (const k of MIX_KEYS) {
    acc += weights[k];
    if (r < acc) return k;
  }
  return [...MIX_KEYS].reverse().find(k => weights[k] > 0) ?? 'bank';
}

/** Items flagged "wrong" and still open: selection skips them until Claude marks the feedback done. */
export function flaggedWrongIds(feedback: Iterable<Pick<FeedbackDoc, 'kind' | 'status' | 'itemId'>>): Set<string> {
  const out = new Set<string>();
  for (const f of feedback) if (f.kind === 'wrong' && f.status === 'open') out.add(f.itemId);
  return out;
}

export type Selector<P> = (pool: readonly P[], progress: SelectProgress, options: { theme?: string; now?: number; excludeIds?: string[] }) => P | null;
export interface SelectProgress {
  attempts: { puzzleId: string; at: number }[];
  cards: Record<string, { due: number; lastAttempt: number }>;
  skills: Record<string, { attempts: number; successes: number; lastAttempt: number }>;
  settings: { rating: number; sessionLength: number };
}

export interface PickInput<P extends { id: string; themes: string[] }> {
  /** Pools by mix source. `pack` holds pack, punish and personal positions. */
  pools: Record<MixKey, readonly P[]>;
  progress: SelectProgress;
  plan: PlanDoc | null;
  priors: Record<string, number> | null | undefined;
  flagged: ReadonlySet<string>;
  /** Daily caps; null outside the daily set (free practice). */
  caps: CapState | null;
  excludeIds: string[];
  now: number;
  /** Uniform [0, 1); injected for tests. */
  rand: () => number;
  select: Selector<P>;
  withPriors: <T extends SelectProgress>(progress: T, priors: Record<string, number> | null | undefined) => T;
  /** Fallback when no plan is in force: the app's own mixed-practice rule. */
  fallback: (pools: Record<MixKey, P[]>, progress: SelectProgress) => P[];
}

export interface PickResult<P> { item: P | null; source: MixKey | null; reason: 'picked' | 'daily-done' | 'empty' }

/**
 * Next position: drop flagged items, apply the caps, then either sample a source by the plan's mix
 * (renormalised over non-empty sources) or use the app's own rule, and let the scheduler pick within it.
 */
export function pickNext<P extends { id: string; themes: string[] }>(input: PickInput<P>): PickResult<P> {
  const { progress, now } = input;
  const plan = activePlan(input.plan, now);
  if (input.caps?.done) return { item: null, source: null, reason: 'daily-done' };
  const filtered = Object.fromEntries(MIX_KEYS.map(k => {
    let pool = input.pools[k].filter(p => !input.flagged.has(p.id));
    if (input.caps) pool = todayPool(pool, progress.cards, input.caps, now);
    return [k, pool];
  })) as Record<MixKey, P[]>;
  const priors = input.withPriors(progress, focusPriors(input.priors, plan));
  const choose = (pool: readonly P[]) => {
    if (!pool.length) return null;
    const ids = new Set(pool.map(p => p.id));
    const exclude = input.excludeIds.filter(id => ids.has(id));
    return input.select(pool, priors, { now, excludeIds: exclude.length < pool.length ? exclude : [] });
  };
  if (plan) {
    const available = Object.fromEntries(MIX_KEYS.map(k => [k, filtered[k].length])) as Record<MixKey, number>;
    let weights = withAgentShare(sourceWeights(plan.mix, available), available.agent > 0, plan.mix.agent);
    while (weights) {
      const source = pickSource(weights, input.rand());
      const item = choose(filtered[source]);
      if (item) return { item, source, reason: 'picked' };
      available[source] = 0;
      weights = withAgentShare(sourceWeights(plan.mix, available), available.agent > 0, plan.mix.agent);
    }
  }
  if (filtered.agent.length && input.rand() < DEFAULT_AGENT_SHARE) {
    // No plan in force (or none of its weighted sources can serve): drill sets get the default share.
    const item = choose(filtered.agent);
    if (item) return { item, source: 'agent', reason: 'picked' };
  }
  const pool = input.fallback(filtered, progress);
  // If the rule's pool has nothing left under the caps, any remaining source may serve.
  const item = choose(pool) ?? choose(MIX_KEYS.flatMap(k => filtered[k]));
  if (item) return { item, source: MIX_KEYS.find(k => filtered[k].some(p => p.id === item.id)) ?? null, reason: 'picked' };
  const any = MIX_KEYS.some(k => filtered[k].length);
  return { item: null, source: null, reason: input.caps && !any ? 'daily-done' : 'empty' };
}
