/** Structural inputs; no storage, games, profile version, or app state required. */
export interface Puzzle {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  themes: string[];
}

export interface Attempt {
  puzzleId: string;
  themes: string[];
  correct: boolean;
  unassisted: boolean;
  hints: number;
  revealed: boolean;
  durationMs: number;
  at: number;
}

export interface Card {
  attempts: number;
  successes: number;
  lapses: number;
  streak: number;
  intervalDays: number;
  lastAttempt: number;
  due: number;
}

export interface Skill {
  attempts: number;
  successes: number;
  lastAttempt: number;
}

export interface Progress {
  attempts: Attempt[];
  cards: Record<string, Card>;
  skills: Record<string, Skill>;
  settings: { rating: number; sessionLength: number };
}

export interface SelectOptions {
  theme?: string;
  now?: number;
  excludeIds?: string[];
}

export interface AttemptOptions {
  correct: boolean;
  hints?: number;
  revealed?: boolean;
  durationMs?: number;
  now?: number;
}

export interface SkillStats {
  theme: string;
  attempts: number;
  successes: number;
  accuracy: number | null;
  confidence: 'new' | 'early' | 'developing' | 'established';
  label: string;
  total: number;
}

/** Dedupe themes and remove source outcome, line-length, and player metadata. */
export function trainingThemes(themes: string[]): string[];

/** Preserve caller-specific puzzle fields in the selected result. */
export function selectPuzzle<P extends Puzzle>(puzzles: readonly P[], progress: Progress, options?: SelectOptions): P | null;
/** Preserve extra top-level/settings fields; replace the three updated records. */
export function recordAttempt<P extends Progress>(progress: P, puzzle: Puzzle, options: AttemptOptions): Omit<P, 'attempts' | 'cards' | 'skills'> & Pick<Progress, 'attempts' | 'cards' | 'skills'>;
export function getSkillStats(progress: Progress, puzzles: readonly Puzzle[]): SkillStats[];
export function dueCount(progress: Progress, now?: number): number;
