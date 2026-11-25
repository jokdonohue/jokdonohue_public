/**
 * `derived/snapshot`: the read model a coaching session reads first (port plan section 3). A full,
 * idempotent recompute from the attempts this page can see; written a few seconds after practice
 * pauses, so either device may write it and the later write simply wins.
 */
import { docBytes, isSafeCardId, prepareWrite, type SessionAttempt, type SnapshotDoc } from '@/src/contract/docs';
import type { SafeScore } from './safe';
import { isPutBack } from './leech';
import type { DocError } from './model';
import { dailyCounts } from './daily';
import type { Progress } from './progress';

const DAY = 86_400_000;
const rate = (ok: number, n: number) => (n ? Math.round((ok / n) * 1000) / 1000 : null);
const SOURCES = ['bank', 'pack', 'endgame', 'personal', 'agent'] as const;

export interface SnapshotInput {
  attempts: readonly SessionAttempt[];
  progress: Progress;
  themesOf: (themes: string[]) => string[];
  priors: Readonly<Record<string, number>> | null | undefined;
  /** Every servable item id, for due counts (a removed card must not count as due). */
  servableIds: readonly string[];
  /** Pack card ids (cards, special, punish), for coverage. */
  packIds: readonly string[];
  /** The current session on this device. */
  session: { id: string; attempts: readonly SessionAttempt[]; endedAt?: number } | null;
  deviceId: string;
  now: number;
  /** M2 (D6): the "Safe or not?" score, when the cards are loaded. */
  safe?: SafeScore | null;
  /** M2 (D7): leeched card ids (out of the queue, in "Study these"). */
  leeches?: readonly string[];
  /** M2 (D10): unreadable agent documents (at most 20 are written). */
  docErrors?: readonly DocError[];
}

export function computeSnapshot(input: SnapshotInput): SnapshotDoc {
  const { attempts, progress, now } = input;
  // "Safe or not?" answers are reported in `safe`, not in the first-try rates (a "Not sure" is not a miss of recall).
  const practice = attempts.filter(a => !isSafeCardId(a.puzzleId));
  const window = (days: number) => {
    const list = practice.filter(a => a.at > now - days * DAY);
    return { attempts: list.length, firstTryRate: rate(list.filter(a => a.unassisted).length, list.length) };
  };
  const themes: SnapshotDoc['themes'] = {};
  for (const [theme, s] of Object.entries(progress.skills)) {
    themes[theme] = { attempts: s.attempts, successes: s.successes, rate: rate(s.successes, s.attempts), lastAttempt: s.lastAttempt, prior: input.priors?.[theme] ?? null };
  }
  // Weakest: at least 5 attempts (smaller samples are not judged, as on the Progress page).
  const weakest = Object.entries(themes)
    .filter(([, t]) => t.attempts >= 5)
    .sort(([a, x], [b, y]) => (x.rate ?? 1) - (y.rate ?? 1) || y.attempts - x.attempts || a.localeCompare(b))
    .slice(0, 8)
    .map(([theme, t]) => ({ theme, rate: t.rate, attempts: t.attempts, prior: t.prior, why: `${t.successes} of ${t.attempts} solved without help` }));
  const dueCards = input.servableIds
    .map(id => [id, progress.cards[id]?.due] as const)
    .filter((x): x is readonly [string, number] => typeof x[1] === 'number' && x[1] <= now)
    .sort((a, b) => a[1] - b[1]);
  const sources = Object.fromEntries(SOURCES.map(s => [s, 0])) as SnapshotDoc['sources'];
  for (const a of attempts) sources[a.source ?? 'bank']++;
  const pack = new Set(input.packIds);
  const seen = [...pack].filter(id => progress.cards[id]).length;
  const s = input.session;
  const today = dailyCounts(attempts, now);
  const body: SnapshotDoc = {
    computedAt: now,
    attemptsTotal: attempts.length,
    approxBytes: docBytes(attempts),
    last7d: window(7), last30d: window(30),
    themes, weakest,
    due: { count: dueCards.length, overdue: dueCards.filter(([, due]) => due < now - DAY).length, nextIds: dueCards.slice(0, 50).map(([id]) => id) },
    sources,
    packCoverage: { seen, total: pack.size },
    lastSession: s ? (() => { const answers = s.attempts.filter(a => !isPutBack(a)), own = answers.filter(a => !isSafeCardId(a.puzzleId)); return { id: s.id, attempts: answers.length, firstTryRate: rate(own.filter(a => a.unassisted).length, own.length), endedAt: s.endedAt ?? null }; })() : null,
    today: { date: today.date, reviews: today.reviews, new: today.new },
    ...(input.leeches ? { leeches: { count: input.leeches.length, ids: [...input.leeches].sort().slice(0, 50) } } : {}),
    ...(input.safe ? { safe: { answers: input.safe.caught.n + input.safe.trusted.n, caught: { ...input.safe.caught }, trusted: { ...input.safe.trusted } } } : {}),
    ...(input.docErrors?.length ? { docErrors: input.docErrors.slice(0, 20).map(e => ({ path: e.path.slice(0, 200), issue: e.issue.slice(0, 300), at: e.at })) } : {}),
    device: input.deviceId,
  };
  return prepareWrite<SnapshotDoc>('derived/snapshot', body);
}
