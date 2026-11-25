/**
 * M3 bank level (brief sections 8.18 and 9.5; audit `reviews/claude/m3_bank_difficulty_2026-11-12.md` section 3).
 *
 * One gated, weighted up-down staircase for the Lichess bank puzzles, recomputed from stored attempts on every
 * render. Nothing is stored: the level is a pure fold over fields every attempt already has (`puzzleId`, `at`,
 * `unassisted`) plus the bundled bank's ratings, so a version-6 page sees no new document, field or enum value.
 *
 * Only his FIRST attempt at each bank puzzle counts, in time order (a repeat measures recall, not difficulty).
 * For a first try at a puzzle rated r, with the running level L:
 *   |r - L| > 150   hold: the puzzle was not served near the level (a version-6 page, older history, a thin
 *                   themed pool), so it says nothing about L. L is left exactly as it is.
 *   unassisted      L = clamp(L + 25)    (no wrong move, hint, reveal or coach)
 *   otherwise       L = clamp(L - 100)
 * clamp = [600, 1750], applied only after a counted step. The seed itself is never clamped, so a seed of 1800 with
 * no counted try stays 1800 (the audit's reference fold, `seed_refold.py`). A distance of exactly 150 counts.
 *
 * The expected step is zero where 25 p = 100 (1 - p), that is at 80% first-try success (Kaernbach 1991, the
 * weighted up-down staircase). A clean solve never lowers L by its own step and a miss never raises it; the one
 * exception is the clamp, when the seed lies above 1750.
 *
 * Bank membership is `ratingOf(id) !== undefined`, so imported attempts without `source` still count. Ids in `skip`
 * (open "wrong" flags: `view.flaggedWrong`) are ignored altogether.
 */

/** A first try farther than this from the running level is held. */
export const BANK_LEVEL_GATE = 150;
export const BANK_LEVEL_UP = 25;
export const BANK_LEVEL_DOWN = 100;
export const BANK_LEVEL_MIN = 600;
export const BANK_LEVEL_MAX = 1750;
/** The settings default (`DEFAULT_SETTINGS.rating` in `src/contract/docs.ts`), used only when the seed is not a number. */
const FALLBACK_SEED = 1000;

/** The fields of a stored attempt the fold reads (`SessionAttempt` fits). */
export interface BankLevelAttempt { puzzleId: string; at: number; unassisted: boolean }

export interface BankLevel {
  /** The level bank puzzles are aimed at now. */
  level: number;
  /** First tries that moved the level (a step that the clamp cancels still counts). */
  counted: number;
  /** First tries more than 150 from the running level, which left it unchanged. */
  held: number;
}

export function bankLevel(
  attempts: readonly BankLevelAttempt[],
  ratingOf: (puzzleId: string) => number | undefined,
  seed: number,
  skip?: ReadonlySet<string>,
): BankLevel {
  let level = Number.isFinite(seed) ? seed : FALLBACK_SEED;
  let counted = 0, held = 0;
  const seen = new Set<string>();
  // Time order, ties by id (the order `collectAttempts` gives the view); a copy, so the caller's list is untouched.
  const ordered = [...attempts].sort((a, b) => a.at - b.at || a.puzzleId.localeCompare(b.puzzleId));
  for (const a of ordered) {
    // Seen before any check, so a later repeat never stands in for a first try that was held or skipped.
    if (seen.has(a.puzzleId)) continue;
    seen.add(a.puzzleId);
    if (skip?.has(a.puzzleId)) continue;
    const rating = ratingOf(a.puzzleId);
    if (typeof rating !== 'number' || !Number.isFinite(rating)) continue; // not a bank puzzle
    if (Math.abs(rating - level) > BANK_LEVEL_GATE) { held++; continue; }
    counted++;
    level = Math.min(BANK_LEVEL_MAX, Math.max(BANK_LEVEL_MIN, level + (a.unassisted ? BANK_LEVEL_UP : -BANK_LEVEL_DOWN)));
  }
  return { level, counted, held };
}
