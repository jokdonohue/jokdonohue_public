/** Small, pure practice-flow rules used by the trainer. */

/** Mixed practice keeps endgame drills out until a profile has this many attempts (QA P1-3; judgement call). */
export const NEW_PROFILE_ATTEMPTS = 5;
/** How many recently served positions "Another position" avoids (QA P1-3, audit A1 F3). */
export const RECENT_POSITIONS = 5;

/** The stated task of a technical-endgame drill: hold items carry `planb` (technical_endgames README). */
export const drillGoal = (puzzle: { themes: string[] }) => puzzle.themes.includes('planb') ? 'Goal: hold the draw' : 'Goal: win';

/**
 * Ids to exclude when picking the next position: the recently served ones that the pool (after the theme filter)
 * can spare, so at least one candidate remains. Falls back to excluding only the current position.
 */
export function recentExclusion(pool: readonly { id: string; themes: string[] }[], theme: string, recent: readonly string[], activeId?: string): string[] {
  const candidates = pool.filter(p => theme === 'all' || p.themes.includes(theme));
  const ids = new Set(candidates.map(p => p.id));
  const avoid = [...new Set([...recent.slice(-RECENT_POSITIONS), ...(activeId ? [activeId] : [])])].filter(id => ids.has(id));
  if (candidates.length > avoid.length) return avoid;
  return activeId && candidates.length > 1 ? [activeId] : [];
}
