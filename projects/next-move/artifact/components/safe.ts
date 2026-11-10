/**
 * "Safe or not?" (plan section 10 item b; lead decisions D3 to D6). Pure rules, no React.
 *
 * The cards live in `safe/meta` + `safe/<ver>-NN` (D1). Each shows the position before one of his real moves,
 * from his side, with that move drawn; he judges it "Safe", "It loses something" or "Not sure".
 * Answers are ordinary session attempts (`source: "pack"`, `verdict` set for the first two choices, absent for
 * "Not sure"), and they are kept out of the ordinary schedule, skills and leech counts by id
 * (`isSafeCardId`): this practice trains a habit, not recall (D5).
 */
import { Chess } from 'chess.js';
import { isSafeCardId, safeShare, type SafeCardDoc, type SessionAttempt } from '@/src/contract/docs';
import type { CapState } from './daily';

export type SafeChoice = 'safe' | 'unsafe' | 'unsure';
const DAY = 86_400_000;
/** D5: a correct answer retires the card for this long (judgement call). */
export const SAFE_RETIRE_DAYS = 90;
/** D5: a wrong answer brings the card back once after this long (judgement call). */
export const SAFE_RETURN_DAYS = 7;
/** D6: the score covers his last this many answers. */
export const SAFE_SCORE_WINDOW = 50;

export const isSafeAttempt = (a: { puzzleId: string }) => isSafeCardId(a.puzzleId);

/** Everything the page may show BEFORE he answers. Built only from these fields, never from `kind` or `reveal`. */
export interface SafeQuestion {
  id: string;
  fen: string;
  playedUci: string;
  /** His colour: the board faces this side. */
  side: 'w' | 'b';
  title?: string;
  themes: string[];
}

/** The question view of a card, or null when its move is not legal in its position (the card is skipped). */
export function safeQuestion(card: SafeCardDoc): SafeQuestion | null {
  const playedUci = card.moves[0];
  let side: 'w' | 'b';
  try {
    const board = new Chess(card.fen);
    side = board.turn();
    board.move({ from: playedUci.slice(0, 2), to: playedUci.slice(2, 4), promotion: playedUci[4] });
  } catch { return null; }
  return { id: card.id, fen: card.fen, playedUci, side, themes: [...card.themes], ...(card.title ? { title: card.title } : {}) };
}

const NAMES: Record<string, string> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
/** His move in words, from the position alone: "Bc4: your bishop from f1 to c4" (plus capture, check, castling, promotion). */
export function describeMove(fen: string, uci: string): string {
  const board = new Chess(fen);
  const m = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  let words: string;
  if (m.isKingsideCastle()) words = 'you castle on the king’s side';
  else if (m.isQueensideCastle()) words = 'you castle on the queen’s side';
  else {
    words = `your ${NAMES[m.piece]} from ${m.from} to ${m.to}`;
    if (m.captured) words += `, taking the ${NAMES[m.captured]}`;
    if (m.promotion) words += `, becoming a ${NAMES[m.promotion]}`;
  }
  if (board.isCheckmate()) words += ', with checkmate';
  else if (board.inCheck()) words += ', with check';
  return `${m.san}: ${words}`;
}

/** Whether a choice is correct for a card. "Not sure" is never correct (D4). */
export const isCorrectChoice = (kind: 'safe' | 'unsafe', choice: SafeChoice) => choice === kind;

/** The attempt to record for an answer (D4): `verdict` only for "Safe" or "It loses something". */
export function safeAttempt(q: SafeQuestion, kind: 'safe' | 'unsafe', choice: SafeChoice, startedAt: number, at: number): SessionAttempt {
  const correct = isCorrectChoice(kind, choice);
  return {
    puzzleId: q.id, themes: q.themes.slice(0, 30), correct, unassisted: correct, hints: 0, revealed: false,
    durationMs: Math.max(0, at - startedAt), at, source: 'pack', ...(choice === 'unsure' ? {} : { verdict: choice }),
  };
}

export interface SafeCardState { answers: number; lastAt: number; lastCorrect: boolean; /** Next showing; Infinity when it never returns. */ due: number }

/**
 * D5 fold over his answers on these cards: a correct answer retires the card for 90 days; a wrong answer
 * (including "Not sure") brings it back once after 7 days; a second wrong answer in a row retires it for 90 days too.
 */
export function safeSchedule(attempts: readonly SessionAttempt[]): Record<string, SafeCardState> {
  const out: Record<string, SafeCardState> = {};
  for (const a of [...attempts].filter(isSafeAttempt).sort((x, y) => x.at - y.at)) {
    const prev = out[a.puzzleId];
    const returnUsed = !!prev && !prev.lastCorrect;
    const days = a.correct || returnUsed ? SAFE_RETIRE_DAYS : SAFE_RETURN_DAYS;
    out[a.puzzleId] = { answers: (prev?.answers ?? 0) + 1, lastAt: a.at, lastCorrect: a.correct, due: a.at + days * DAY };
  }
  return out;
}

/**
 * Cards that may be shown now: unseen ones while new places remain, due returns while review places remain
 * (D5: a first showing counts against the new cap, a return against the review cap). `caps` null = no caps
 * (free practice): every unseen or due card.
 */
export function safePool(questions: readonly SafeQuestion[], schedule: Readonly<Record<string, SafeCardState>>, caps: CapState | null, now: number, flagged: ReadonlySet<string>): SafeQuestion[] {
  return questions.filter(q => {
    if (flagged.has(q.id)) return false;
    const s = schedule[q.id];
    if (!s) return !caps || caps.newLeft > 0;
    return s.due <= now && (!caps || caps.reviewsLeft > 0);
  });
}

/** Returns first (oldest due), then new cards in stored order (the producer interleaves the halves); skips recent ids. */
export function chooseSafe(pool: readonly SafeQuestion[], schedule: Readonly<Record<string, SafeCardState>>, recent: readonly string[]): SafeQuestion | null {
  const fresh = pool.filter(q => !recent.includes(q.id));
  const list = fresh.length ? fresh : pool;
  const due = list.filter(q => schedule[q.id]).sort((a, b) => schedule[a.id].due - schedule[b.id].due);
  return due[0] ?? list[0] ?? null;
}

/** D3: whether this pick goes to the safe pool. The other sources keep their proportions within the rest. */
export function takeSafe(mixSafe: number | undefined | null, poolSize: number, r: number): boolean {
  if (poolSize <= 0) return false;
  return r < safeShare(mixSafe);
}

export interface SafeScore {
  /** Blunders caught: "It loses something" on cards that lose something. */
  caught: { k: number; n: number };
  /** Sound moves trusted: "Safe" on cards that were safe. */
  trusted: { k: number; n: number };
  /** Answers in the window whose card is no longer loaded (left out of both halves). */
  unknown: number;
}
/**
 * D6: two numbers over his last 50 answers, never one combined percentage. Which half an answer belongs to comes
 * from the loaded card (a "Not sure" answer has no verdict); answers on cards no longer loaded are left out.
 */
export function safeScore(attempts: readonly SessionAttempt[], kindOf: (id: string) => 'safe' | 'unsafe' | undefined): SafeScore {
  const last = [...attempts].filter(isSafeAttempt).sort((a, b) => a.at - b.at).slice(-SAFE_SCORE_WINDOW);
  const score: SafeScore = { caught: { k: 0, n: 0 }, trusted: { k: 0, n: 0 }, unknown: 0 };
  for (const a of last) {
    const kind = kindOf(a.puzzleId);
    if (!kind) { score.unknown++; continue; }
    const half = kind === 'unsafe' ? score.caught : score.trusted;
    half.n++;
    if (a.verdict === kind) half.k++;
  }
  return score;
}

/**
 * D3 in the daily set: with probability `safeShare(mixSafe)` a waiting "Safe or not?" card is served; otherwise the
 * ordinary pick runs unchanged. When the ordinary pick has nothing, a waiting safe card may still serve, unless
 * the plan switched the share off (`mix.safe: 0`).
 */
export function pickWithSafe<R extends { item: unknown }>(input: {
  safePool: readonly SafeQuestion[]; schedule: Readonly<Record<string, SafeCardState>>; recent: readonly string[];
  mixSafe: number | undefined | null; r: number; pickRest: () => R;
}): { safe: SafeQuestion } | { rest: R } {
  if (takeSafe(input.mixSafe, input.safePool.length, input.r)) {
    const q = chooseSafe(input.safePool, input.schedule, input.recent);
    if (q) return { safe: q };
  }
  const rest = input.pickRest();
  if (rest.item || input.mixSafe === 0) return { rest };
  const q = chooseSafe(input.safePool, input.schedule, input.recent);
  return q ? { safe: q } : { rest };
}
