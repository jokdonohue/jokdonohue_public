/**
 * Cards and skills rebuilt from attempts (cards are never stored; port plan section 2). The fold is
 * the Site app's `mergeStates` fold without its whole-profile size check, which does not apply to a
 * history spread over many documents. `b2_selection` checks it against `mergeStates` itself.
 */
import type { SessionAttempt } from '@/src/contract/docs';

export interface Card { attempts: number; successes: number; lapses: number; streak: number; intervalDays: number; lastAttempt: number; due: number }
export interface Skill { attempts: number; successes: number; lastAttempt: number }
export interface Progress {
  attempts: SessionAttempt[];
  cards: Record<string, Card>;
  skills: Record<string, Skill>;
  settings: { rating: number; sessionLength: number };
}

const INTERVALS = [0, 1, 3, 7, 14, 30, 60];
const DAY = 86_400_000;
const safe = (k: string) => !['__proto__', 'constructor', 'prototype'].includes(k);

export function buildProgress(attempts: readonly SessionAttempt[], settings: { rating: number; sessionLength: number }, themesOf: (themes: string[]) => string[]): Progress {
  const sorted = [...attempts].sort((a, b) => a.at - b.at);
  const cards: Record<string, Card> = {};
  const skills: Record<string, Skill> = {};
  for (const a of sorted) {
    if (!safe(a.puzzleId)) continue;
    const previous = cards[a.puzzleId] ?? { attempts: 0, successes: 0, lapses: 0, streak: 0, intervalDays: 0, lastAttempt: 0, due: 0 };
    const streak = a.unassisted ? previous.streak + 1 : 0;
    const intervalDays = a.unassisted ? INTERVALS[Math.min(streak, 6)] : 10 / 1440;
    cards[a.puzzleId] = { attempts: previous.attempts + 1, successes: previous.successes + Number(a.unassisted), lapses: previous.lapses + Number(!a.unassisted), streak, intervalDays, lastAttempt: a.at, due: a.at + intervalDays * DAY };
    for (const t of themesOf(a.themes)) {
      if (!safe(t)) continue;
      const old = skills[t] ?? { attempts: 0, successes: 0, lastAttempt: 0 };
      skills[t] = { attempts: old.attempts + 1, successes: old.successes + Number(a.unassisted), lastAttempt: a.at };
    }
  }
  return { attempts: sorted, cards, skills, settings: { rating: settings.rating, sessionLength: settings.sessionLength } };
}
