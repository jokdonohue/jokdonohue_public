/** Conservative practice heuristic, not a validated Elo or mastery model. */
const DAY = 86_400_000;
const METADATA_THEMES = new Set(['advantage', 'crushing', 'equality', 'oneMove', 'short', 'long', 'veryLong', 'master', 'masterVsMaster', 'superGM', 'personal']);

/** Source outcome/length/player tags remain provenance, not trainable skills. */
export function trainingThemes(themes) {
  return [...new Set(themes)].filter(theme => !METADATA_THEMES.has(theme));
}

/** Select a due review or an unseen card; alternate review with exploration. */
export function selectPuzzle(puzzles, progress, { theme = 'all', now = Date.now(), excludeIds = [] } = {}) {
  const excluded = new Set(excludeIds);
  let pool = puzzles.filter(p => !excluded.has(p.id) && (theme === 'all' || p.themes.includes(theme)));
  if (!pool.length) return null;
  const latest = progress.attempts?.at(-1)?.puzzleId;
  if (pool.length > 1) pool = pool.filter(p => p.id !== latest);
  const cards = progress.cards || {};
  const rating = progress.settings?.rating ?? 1000;
  const weakness = p => {
    const themes = trainingThemes(p.themes);
    if (!themes.length) return 0.5;
    return themes.reduce((sum, t) => {
      const s = progress.skills?.[t];
      return sum + (s ? (s.attempts - s.successes + 2) / (s.attempts + 4) : 0.5);
    }, 0) / themes.length;
  };
  const byFit = (a, b) => (weakness(b) - weakness(a)) * 600 + Math.abs(a.rating - rating) - Math.abs(b.rating - rating) || a.id.localeCompare(b.id);
  const unseen = pool.filter(p => !cards[p.id]).sort(byFit);
  const due = pool.filter(p => cards[p.id]?.due <= now).sort((a, b) => cards[a.id].due - cards[b.id].due || byFit(a, b));
  // One in three completed attempts introduces new material when available.
  if (unseen.length && (!due.length || (progress.attempts?.length || 0) % 3 === 2)) return unseen[0];
  if (due.length) return due[0];
  if (unseen.length) return unseen[0];
  // If everything is scheduled later, prefer the least recently practised card.
  return pool.sort((a, b) => cards[a.id].lastAttempt - cards[b.id].lastAttempt || byFit(a, b))[0];
}

/** Record once when a puzzle finishes. Hints/reveal/errors reset successful recall. */
export function recordAttempt(progress, puzzle, { correct, hints = 0, revealed = false, durationMs = 0, now = Date.now() }) {
  if (typeof correct !== 'boolean' || !Number.isInteger(hints) || hints < 0 || typeof revealed !== 'boolean' || !Number.isFinite(durationMs) || durationMs < 0 || !Number.isFinite(now) || now < 0) throw new Error('Invalid puzzle attempt.');
  const previous = progress.cards[puzzle.id] || { attempts: 0, successes: 0, lapses: 0, streak: 0, intervalDays: 0 };
  const unassisted = correct && hints === 0 && !revealed;
  const streak = unassisted ? previous.streak + 1 : 0;
  const intervals = [0, 1, 3, 7, 14, 30, 60];
  const intervalDays = unassisted ? intervals[Math.min(streak, intervals.length - 1)] : 10 / 1440;
  const card = { attempts: previous.attempts + 1, successes: previous.successes + Number(unassisted), lapses: previous.lapses + Number(!unassisted), streak, intervalDays, lastAttempt: now, due: now + intervalDays * DAY };
  const themes = [...new Set(puzzle.themes)];
  const skills = { ...progress.skills };
  for (const theme of trainingThemes(themes)) {
    const old = skills[theme] || { attempts: 0, successes: 0 };
    Object.defineProperty(skills, theme, { value: { attempts: old.attempts + 1, successes: old.successes + Number(unassisted), lastAttempt: now }, enumerable: true, configurable: true, writable: true });
  }
  return { ...progress, attempts: [...progress.attempts, { puzzleId: puzzle.id, themes, correct, unassisted, hints, revealed, durationMs, at: now }], cards: { ...progress.cards, [puzzle.id]: card }, skills };
}

/** Return descriptive theme statistics; small samples never imply proficiency. */
export function getSkillStats(progress, puzzles) {
  const themes = trainingThemes([...puzzles.flatMap(p => p.themes), ...Object.keys(progress.skills)]).sort();
  return themes.map(theme => {
    const { attempts = 0, successes = 0 } = progress.skills[theme] || {};
    const confidence = attempts === 0 ? 'new' : attempts < 5 ? 'early' : attempts < 20 ? 'developing' : 'established';
    const label = attempts === 0 ? 'Not yet practised' : attempts < 5 ? 'Too few attempts to judge' : attempts < 20 ? 'Early practice results' : 'Practice history';
    return { theme, attempts, successes, accuracy: attempts ? successes / attempts : null, confidence, label, total: puzzles.filter(p => p.themes.includes(theme)).length };
  });
}

/** Count scheduled cards whose review time has arrived (not unseen cards). */
export function dueCount(progress, now = Date.now()) {
  return Object.values(progress.cards).filter(card => card.due <= now).length;
}
