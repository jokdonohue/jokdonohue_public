/**
 * Leech rule (plan section 10 item c, M2; lead decision D7; evidence A8: study a worked example instead of
 * repeating a failure). Pure rules, no React.
 *
 * Counted in "attempt days": distinct local days with at least one attempt at the card, since its last put-back.
 * A lapse day is one on which an attempt was not clean (a miss, a hint or a reveal); several retries in one sitting
 * count once. Lead change to D7 (fix pass, judgement call): a card is a leech when 4 of its last 6 attempt days were
 * lapse days, so old misses followed by clean days stop counting; with fewer than 6 attempt days, all of them count.
 * A leech leaves the queue and sits in "Study these" with its position, stored line and explanation.
 *
 * "Put it back" must hold on both devices with no change to the session writer, so it is stored the way
 * everything else is: as an attempt, recorded through the ordinary writer, on the marker id
 * `putback:<cardId>`. Markers are never answers: the model keeps them out of `attempts` (so out of the schedule,
 * caps, rates and the snapshot) and lists them in `putBacks`. After a put-back the lapse count restarts at 0
 * and the card is due at the start of the next local day.
 */
import { isSafeCardId, type AttemptSource, type SessionAttempt } from '@/src/contract/docs';
import { localDay } from './daily';

export const LEECH_LAPSES = 4;
/** D7 (fix pass): the window of most recent attempt days the lapses are counted in. */
export const LEECH_WINDOW_DAYS = 6;
export const PUTBACK_PREFIX = 'putback:';
export const isPutBack = (a: { puzzleId: string }) => a.puzzleId.startsWith(PUTBACK_PREFIX);
export const putBackCardId = (a: { puzzleId: string }) => a.puzzleId.slice(PUTBACK_PREFIX.length);

/** The marker attempt for "Put it back" on `cardId` (recorded through the ordinary session writer). */
export function putBackAttempt(cardId: string, source: AttemptSource, at: number): SessionAttempt {
  return { puzzleId: `${PUTBACK_PREFIX}${cardId}`, themes: ['putback'], correct: false, unassisted: false, hints: 0, revealed: false, durationMs: 0, at, source };
}

/** Latest put-back time per card id. */
export function putBackTimes(markers: readonly SessionAttempt[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of markers) if (isPutBack(m)) out.set(putBackCardId(m), Math.max(out.get(putBackCardId(m)) ?? 0, m.at));
  return out;
}

export interface LeechInfo {
  /** Lapse days among the counted attempt days. */
  lapseDays: number;
  /** Attempt days counted: the last 6 (or fewer when there are fewer). */
  windowDays: number;
  leeched: boolean;
  putBackAt: number | null;
}

/** Per card since its latest put-back: lapse days among its last 6 attempt days. "Safe or not?" cards are exempt (D7). */
export function leechState(attempts: readonly SessionAttempt[], putBacks: ReadonlyMap<string, number>): Map<string, LeechInfo> {
  const days = new Map<string, Map<string, boolean>>(); // card -> local day -> had a lapse
  for (const a of attempts) {
    if (isSafeCardId(a.puzzleId) || isPutBack(a)) continue;
    const since = putBacks.get(a.puzzleId);
    if (since !== undefined && a.at <= since) continue;
    let byDay = days.get(a.puzzleId);
    if (!byDay) days.set(a.puzzleId, (byDay = new Map()));
    const day = localDay(a.at);
    byDay.set(day, (byDay.get(day) ?? false) || !a.unassisted);
  }
  const out = new Map<string, LeechInfo>();
  for (const [id, byDay] of days) {
    const recent = [...byDay].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).slice(-LEECH_WINDOW_DAYS);
    const lapseDays = recent.filter(([, lapse]) => lapse).length;
    out.set(id, { lapseDays, windowDays: recent.length, leeched: lapseDays >= LEECH_LAPSES, putBackAt: putBacks.get(id) ?? null });
  }
  for (const [id, at] of putBacks) if (!out.has(id)) out.set(id, { lapseDays: 0, windowDays: 0, leeched: false, putBackAt: at });
  return out;
}

export const leechIds = (state: ReadonlyMap<string, LeechInfo>) => new Set([...state].filter(([, s]) => s.leeched).map(([id]) => id));

/** Start of the local day after `ms`. */
export function startOfNextDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/**
 * Cards with the put-back applied: a card put back and not attempted since is due at the start of the next day,
 * and its lapse count reads 0. Other cards are returned unchanged.
 */
export function withPutBacks<C extends { due: number; lapses: number; lastAttempt: number }>(cards: Readonly<Record<string, C>>, putBacks: ReadonlyMap<string, number>): Record<string, C> {
  const out: Record<string, C> = { ...cards };
  for (const [id, at] of putBacks) {
    const card = out[id];
    if (!card || card.lastAttempt > at) continue;
    out[id] = { ...card, lapses: 0, due: startOfNextDay(at) };
  }
  return out;
}
