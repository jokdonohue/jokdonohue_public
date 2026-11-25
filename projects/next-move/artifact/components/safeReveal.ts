/**
 * "Safe or not?" answer panel, version 7.3: what the page says after he answers, built from the card's stored facts.
 *
 * Until now the panel printed the producer's one sentence (the reply inside a pair of engine percentages) and drew
 * the reply as an arrow behind a toggle. Now the stored reply line is stepped through in the line viewer, in words,
 * and the panel leads with what that line shows.
 *
 * What the line shows is counted, never assumed. A stored line (the move and six plies) need not end with the
 * opponent ahead in material: the material can be level at its end, or the mover can even be ahead, although the
 * engine rates the move a clear mistake. So:
 * - the lead is the narrator's own closing sentence for the line (the count; the engine's figure when it contradicts
 *   the count; what is still hanging), and when the count shows no loss the lead says so in plain words. It never
 *   says he lost material unless the count says it;
 * - the viewer's title says his move "allowed" the line only under the gate the mistake cards use (`gameMoveViewer`,
 *   brief m31 4.4): his opponent at 65% or more after the move, and he is not ahead in material at the end;
 * - figures are the stored pair from the offline pass (one engine run at one depth). No live figure is ever set
 *   beside them.
 * Everything here is read only after he has answered: nothing in this module may reach the page before that
 * (`kind` and `reveal` are the answer, `src/contract/docs.ts`).
 */
import { Chess } from 'chess.js';
import type { SafeCardDoc } from '@/src/contract/docs';
import type { LineVerdict } from '@/src/teach/narrate';
import { PUNISH_MIN_WIN } from '@/src/teach/punish';
import { lineNarration } from './LineViewer';
import type { SafeQuestion } from './safe';

type Side = 'w' | 'b';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** What the stored line shows for him: he is mated, he ends behind in material, or neither. */
export type SafeShown = 'mate' | 'material' | 'nothing';

export interface SafeReplyView {
  /** His move, then the stored reply, as far as it is legal. At least two plies. */
  line: string[];
  /** His stored figure after his move: the viewer's closing sentence uses it when it contradicts the count. */
  verdict: LineVerdict | null;
  shown: SafeShown;
  /** The title may say what his move "allowed" (header comment). */
  allowed: boolean;
  title: string;
}
export interface SafeBestView {
  san: string;
  /** The engine's line from the card's position, UCI, as far as it is legal. At least one ply. */
  line: string[];
  /** The stored figure before his move, which is the figure after the engine's move. */
  verdict: LineVerdict | null;
  title: string;
  toggle: string;
}
export interface SafeReveal {
  /** His move in SAN ('' when it cannot be read). */
  playedSan: string;
  /** The sentence in the result box, after "Right." or "Not this time.". */
  fact: string;
  /** The panel's own sentence or two about what the move did; '' when there is nothing to add. */
  lead: string;
  reply: SafeReplyView | null;
  best: SafeBestView | null;
  /** The stored pair in the page's words, or null without both figures. */
  figures: string | null;
}

/** The longest legal start of `line` from `fen` (UCI). Never throws. */
export function legalStart(fen: string, line: readonly unknown[]): string[] {
  const out: string[] = [];
  let board: Chess;
  try { board = new Chess(fen); } catch { return out; }
  for (const raw of line) {
    if (typeof raw !== 'string' || !UCI.test(raw)) break;
    try { board.move({ from: raw.slice(0, 2), to: raw.slice(2, 4), promotion: raw[4] }); } catch { break; }
    out.push(raw);
  }
  return out;
}

/** A SAN line from `fen` as UCI, as far as chess.js accepts it. Never throws. */
export function sanLineToUci(fen: string, sans: readonly unknown[]): string[] {
  const out: string[] = [];
  let board: Chess;
  try { board = new Chess(fen); } catch { return out; }
  for (const san of sans) {
    if (typeof san !== 'string' || !san) break;
    try { const m = board.move(san); out.push(`${m.from}${m.to}${m.promotion ?? ''}`); } catch { break; }
  }
  return out;
}

const sanOf = (fen: string, uci: string): string => {
  try { return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; } catch { return ''; }
};

export const SAFE_FACT = { safe: 'This move was safe.', unsafe: 'This move lost something.' } as const;
/** The count shows no loss and nothing is left hanging: the mistake is in the position at the end of the line. */
export const NO_LOSS_LEAD = 'No piece or pawn is lost in this line: the loss is in the position that is left.';
export const EVEN_TRADES_LEAD = 'The trades are even in this line: the loss is in the position that is left.';
/** He ends ahead in the count and no stored figure is there to say otherwise. */
export const AHEAD_LEAD = 'You come out ahead in material in this line, but the engine still rates the move a mistake.';

/** "Engine's figures: 50% to win before your move, 30% after." Null without both stored figures. */
export function storedFigures(winBefore: unknown, winAfter: unknown): string | null {
  if (!finite(winBefore) || !finite(winAfter)) return null;
  return `Engine’s figures: ${Math.round(winBefore)}% to win before your move, ${Math.round(winAfter)}% after.`;
}

/**
 * The reply viewer of a card that lost something, and the panel's lead for it. Null when the card stores no legal
 * reply to his move (the panel then has only the result and the figures).
 */
export function safeReplyView(question: SafeQuestion, card: SafeCardDoc, playedSan: string): { view: SafeReplyView; lead: string } | null {
  const reveal = card.reveal ?? {};
  const line = legalStart(question.fen, [question.playedUci, ...(Array.isArray(reveal.replyLineUci) ? reveal.replyLineUci : [])]);
  if (line.length < 2) return null;
  const side: Side = question.side;
  const winAfter = reveal.winAfter;
  const verdict: LineVerdict | null = finite(winAfter) ? { side, win: winAfter } : null;
  // The same reading the viewer makes of this line (same options): the lead is the viewer's closing sentence, except
  // in the three cases below, where the count shows no loss and the panel says that in plain words.
  const story = lineNarration(question.fen, line, undefined, { verdict, noChangeSentence: false });
  const last = story.plies[story.plies.length - 1];
  // `material.pov` is the side that made the first ply: him.
  const net = story.material.pov === side ? story.material.net : -story.material.net;
  const mated = story.result === 'mate' && !!last && last.color !== side;
  const shown: SafeShown = mated ? 'mate' : net < -1e-9 ? 'material' : 'nothing';
  const allowed = finite(winAfter) && 100 - winAfter >= PUNISH_MIN_WIN && !(net > 1e-9);
  const name = playedSan || 'your move';
  const title = allowed ? `What your move ${name} allowed` : `The engine’s line after your move ${name}`;
  let lead = story.summary;
  if (shown === 'nothing') {
    if (!lead) lead = NO_LOSS_LEAD;
    else if (lead === 'The trades are even.') lead = EVEN_TRADES_LEAD;
    // A sentence that names him as the winner with nothing against it would contradict the result box. A sentence
    // that already carries its "but" keeps the narrator's words (the engine's figure, or what is still hanging:
    // "So far in this line White has won a pawn, but the queen on g5 attacks …"), and so does a line that ends in
    // mate (review of 7.3, P2-11).
    else if (net > 1e-9 && story.result !== 'mate' && !/, but /.test(lead)) lead = AHEAD_LEAD;
  }
  return { view: { line, verdict, shown, allowed, title }, lead };
}

/** The engine's choice on a card that lost something: its stored line from the card's position. Null without one. */
export function safeBestView(question: SafeQuestion, card: SafeCardDoc): SafeBestView | null {
  const reveal = card.reveal ?? {};
  const sans = Array.isArray(reveal.bestLineSan) && reveal.bestLineSan.length ? reveal.bestLineSan : typeof reveal.bestSan === 'string' && reveal.bestSan ? [reveal.bestSan] : [];
  let line = sanLineToUci(question.fen, sans);
  // A card that stores the move only as UCI.
  if (!line.length && typeof reveal.bestUci === 'string') line = legalStart(question.fen, [reveal.bestUci]);
  if (!line.length || line[0] === question.playedUci) return null;
  const san = sanOf(question.fen, line[0]);
  if (!san) return null;
  const before = reveal.winBefore;
  return {
    san, line, verdict: finite(before) ? { side: question.side, win: before } : null,
    title: `The engine’s choice: ${san}`, toggle: `Show the line after ${san}`,
  };
}

/** A sound-move card's figure falls by less than this (the producer's rule, `SOUND_MAX_DROP` in `src/importers/safeDocs.ts`). */
export const SOUND_MAX_DROP = 2;

/** Everything the answer panel says about a card, from its stored facts. Never throws. */
export function safeReveal(question: SafeQuestion, card: SafeCardDoc): SafeReveal {
  const reveal = card.reveal ?? {};
  const playedSan = sanOf(question.fen, question.playedUci) || (typeof reveal.playedSan === 'string' ? reveal.playedSan : '');
  const figures = storedFigures(reveal.winBefore, reveal.winAfter);
  if (card.kind === 'safe') {
    const first = (reveal as { engineBest?: unknown }).engineBest === true;
    const other = !first && typeof reveal.bestSan === 'string' && reveal.bestSan && reveal.bestSan !== playedSan ? reveal.bestSan : '';
    // The words speak of the change, never of the level: a sound-move card can stand anywhere from 30% to 70% to win,
    // so "kept the balance" would be false beside its own figures. And they are said only when the stored pair bears
    // them out (the producer's own rule for a sound move); otherwise the producer's sentence stands alone.
    const drop = finite(reveal.winBefore) && finite(reveal.winAfter) ? reveal.winBefore - reveal.winAfter : null;
    if (!figures || drop === null || drop >= SOUND_MAX_DROP) return { playedSan, fact: SAFE_FACT.safe, lead: typeof reveal.explanation === 'string' ? reveal.explanation : '', reply: null, best: null, figures: null };
    // "rates about the same" needs the two figures close either way: a stored figure can also have risen.
    const same = Math.abs(drop) < SOUND_MAX_DROP ? ', which it rates about the same' : '';
    const lead = `${playedSan || 'Your move'} gave nothing away.${first ? ' It was also the engine’s first choice.' : other ? ` The engine’s first choice was ${other}${same}.` : ''}`;
    return { playedSan, fact: SAFE_FACT.safe, lead, reply: null, best: null, figures };
  }
  let reply: { view: SafeReplyView; lead: string } | null = null;
  try { reply = safeReplyView(question, card, playedSan); } catch { reply = null; }
  let best: SafeBestView | null = null;
  try { best = safeBestView(question, card); } catch { best = null; }
  // Without a line to show, the producer's sentence is all there is.
  const lead = reply ? reply.lead : (typeof reveal.explanation === 'string' ? reveal.explanation : '');
  return { playedSan, fact: SAFE_FACT.unsafe, lead, reply: reply?.view ?? null, best, figures: reply ? figures : null };
}
