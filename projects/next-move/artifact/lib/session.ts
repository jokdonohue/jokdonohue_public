/**
 * "This session" in the practice header. A session is the attempts recorded since it started; a new one starts after
 * an idle gap, so a tab left open overnight does not keep counting yesterday (review R8, code review P2-6).
 * The two-hour gap is a judgement call, not an evidence-based value.
 */
export const SESSION_GAP_MS = 2 * 60 * 60 * 1000;

/** The session start to use at `now`: unchanged while active, or `now` after a gap since the last activity. */
export function sessionStartAt(start: number, lastAttemptAt: number | undefined, now: number, gapMs = SESSION_GAP_MS): number {
  const lastActivity = Math.max(start, lastAttemptAt ?? 0);
  return now - lastActivity > gapMs ? now : start;
}

/** Attempts recorded at or after the session start. */
export function sessionCount(attempts: readonly { at: number }[], start: number): number {
  return attempts.reduce((n, a) => n + Number(a.at >= start), 0);
}
