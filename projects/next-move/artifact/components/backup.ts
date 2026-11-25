/**
 * Item i: "Export my progress". The file is a Site-compatible `TrainingState` v1 (the Site's importer
 * reads `version`, `progress`, `games`, `personalPuzzles` and ignores other keys) plus a `nextMove` block
 * with what only the artifact database holds. Games are left to the db snapshot runbook in M1.
 */
import type { FeedbackDoc, PlanDoc, PuzzleDoc, SessionAttempt } from '@/src/contract/docs';
import type { ModelSettings, NoteView } from './model';

export interface BackupProgress {
  cards: Record<string, { attempts: number; successes: number; lapses: number; streak: number; intervalDays: number; lastAttempt: number; due: number }>;
  skills: Record<string, { attempts: number; successes: number; lastAttempt: number }>;
}
export interface BackupInput {
  attempts: readonly SessionAttempt[];
  progress: BackupProgress;
  settings: ModelSettings;
  personal: readonly PuzzleDoc[];
  plan: PlanDoc | null;
  notes: readonly NoteView[];
  openFeedback: ReadonlyArray<{ id: string; doc: FeedbackDoc }>;
  packVersion: string | null;
  exportedAt: number;
}

export const BACKUP_KIND = 'next-move-artifact-backup';
/** The Site importer refuses more than this many attempts (lib/training-state.ts). */
export const SITE_MAX_ATTEMPTS = 20_000;

export function buildBackup(input: BackupInput) {
  // Keep the file importable on the Site: the newest 20,000 attempts at most (review P2-5); `nextMove.omittedAttempts` says how many were left out.
  const kept = input.attempts.length > SITE_MAX_ATTEMPTS ? [...input.attempts].sort((a, b) => a.at - b.at).slice(-SITE_MAX_ATTEMPTS) : input.attempts;
  const attempts = kept.map(({ puzzleId, themes, correct, unassisted, hints, revealed, durationMs, at }) => ({ puzzleId, themes, correct, unassisted, hints, revealed, durationMs, at }));
  const extras = kept
    .filter(a => a.source || a.playedUci || a.coached || a.verdict)
    .map(a => ({ key: `${a.puzzleId}:${a.at}`, ...(a.source ? { source: a.source } : {}), ...(a.playedUci ? { playedUci: a.playedUci } : {}), ...(a.coached ? { coached: true } : {}), ...(a.verdict ? { verdict: a.verdict } : {}) }));
  return {
    version: 1 as const,
    progress: {
      attempts, cards: input.progress.cards, skills: input.progress.skills,
      settings: { rating: input.settings.rating, sessionLength: input.settings.sessionLength },
      settingsUpdatedAt: input.settings.updatedAt,
    },
    games: [] as never[],
    personalPuzzles: input.personal.map(p => ({ ...p, gameUrl: p.gameUrl && /^https?:\/\//.test(p.gameUrl) ? p.gameUrl : '' })),
    nextMove: {
      kind: BACKUP_KIND, exportedAt: input.exportedAt, attemptExtras: extras, omittedAttempts: input.attempts.length - kept.length,
      settings: input.settings, plan: input.plan, notes: input.notes, openFeedback: input.openFeedback, packVersion: input.packVersion,
    },
  };
}

export function backupFilename(ms: number): string {
  const d = new Date(ms);
  return `next-move-progress-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
}
