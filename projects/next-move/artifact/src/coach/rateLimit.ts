/**
 * Per-device coach limits (port plan section 4): one call in flight, a 10 s cooldown after each call,
 * at most 20 calls per local day, and a stop until the next local day after the platform says
 * `rate_limited`. The numbers are the plan's judgement calls.
 * The counter lives in browser storage (localStorage in the page); every access is guarded, so a blocked
 * or empty storage only makes the limit per page load.
 */
import type { CoachFailure } from '../contract/coach';

export const COOLDOWN_MS = 10_000;
export const DAILY_LIMIT = 20;

export interface KvLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
interface Saved { day: string; count: number; blockedDay?: string }

export const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const nextLocalMidnight = (ms: number) => { const d = new Date(ms); d.setHours(24, 0, 0, 0); return d.getTime(); };

export function memoryKv(): KvLike {
  const m = new Map<string, string>();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
}

export interface Limiter {
  /** A failure when a call may not start now, else null. */
  check(): CoachFailure | null;
  start(): void;
  end(): void;
  /** The platform said `rate_limited`: stop until the next local day. */
  block(): void;
  limits(): { remainingToday: number; cooldownUntil: number };
}

export function createLimiter(opts: { deviceId: string; storage?: KvLike; now?: () => number }): Limiter {
  const storage = opts.storage ?? memoryKv();
  const now = opts.now ?? Date.now;
  const key = `nextmove.coach.v1.${opts.deviceId}`;
  let inFlight = false;
  let cooldownUntil = 0;
  let mem: Saved = { day: '', count: 0 };
  const load = (): Saved => {
    const today = localDay(now());
    let saved: Saved = mem;
    try {
      const raw = storage.getItem(key);
      if (raw) { const p = JSON.parse(raw) as Saved; if (p && typeof p.day === 'string' && typeof p.count === 'number') saved = p; }
    } catch { /* storage blocked: keep the in-memory copy */ }
    if (saved.day !== today) saved = { day: today, count: 0, ...(saved.blockedDay === today ? { blockedDay: today } : {}) };
    return saved;
  };
  const save = (s: Saved) => { mem = s; try { storage.setItem(key, JSON.stringify(s)); } catch { /* per-load only */ } };

  return {
    check() {
      const t = now(), s = load();
      if (inFlight) return { code: 'busy', action: 'tell', message: 'Claude is already answering.' };
      if (s.blockedDay === s.day) return { code: 'rate_limited', action: 'tell', message: "Claude's usage limit is reached for today. The engine lines above still apply.", retryAt: nextLocalMidnight(t) };
      if (s.count >= DAILY_LIMIT) return { code: 'daily_limit', action: 'tell', message: `That is today's ${DAILY_LIMIT} questions on this device. The engine lines above still apply.`, retryAt: nextLocalMidnight(t) };
      if (t < cooldownUntil) return { code: 'cooldown', action: 'tell', message: 'Wait a few seconds before asking again.', retryAt: cooldownUntil };
      return null;
    },
    start() { inFlight = true; const s = load(); save({ ...s, count: s.count + 1 }); },
    end() { inFlight = false; cooldownUntil = now() + COOLDOWN_MS; },
    block() { const s = load(); save({ ...s, blockedDay: s.day }); },
    limits() {
      const s = load();
      return { remainingToday: s.blockedDay === s.day ? 0 : Math.max(0, DAILY_LIMIT - s.count), cooldownUntil: now() < cooldownUntil ? cooldownUntil : 0 };
    },
  };
}
