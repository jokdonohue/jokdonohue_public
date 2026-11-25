/**
 * "Why does my move fail?" (port plan section 4) and, from M3 (L6), an optional question box. The static
 * panel (stored lines and numbers) is shown for a wrong move once the position has ended; the Claude controls
 * appear only when the coach exists and its permission is `granted` or `prompt`. Nothing here calls the model
 * except a click.
 *
 * The question box renders only when the parent passes `askInput` (and never while `revealsAnswer` is true:
 * the ask prompt contains the answer line). It shares the explain button's consent rule, the page's limits,
 * the Stop button and the grounding warning. `input` is optional, so after a clean solve (no wrong move) the
 * panel can hold the question box alone.
 *
 * M3 fix pass: the explain button reads "Why does my move fail?" only for a try the page found `worse` or `losing`
 * (or with no verdict, as in version 6), else "Ask Claude about my move" (`coachLabel`, brief 9.9.2 a). With nothing
 * to show the panel renders nothing (brief 9.10 j).
 *
 * Request identity (brief 8.5): each control holds a `RequestGate`. A new card or move resets it, and every
 * callback of a request (streamed text, result, failure, busy flag) changes the panel only while that request is
 * current, so an answer that arrives after the card changed never attaches to the new card.
 */
import { useEffect, useId, useState } from 'react';
import { COACH_LIMITS, CoachError, type CoachAskInput, type CoachClient, type CoachExplainInput, type CoachResult, type CoachTryVerdict } from '@/src/contract/coach';
import type { PermissionState } from '@/src/contract/store';
import { askedLineSans, resultWords, tablebaseCard, UNFINISHED_LINE_LABEL } from '@/src/coach/prompts';
import { staticExplanation } from './coachInput';

/** One running request of a panel control, as `RequestGate.start` returns it. */
export interface RequestTicket {
  signal: AbortSignal;
  /** True while this is the control's current request (not replaced, reset or finished). */
  live(): boolean;
}
/**
 * Request identity for one panel control (brief 8.5). `start` aborts the request before it; `stop` (the Stop
 * button) aborts the running one, which stays current so its failure can clear the busy state; `reset` (a new
 * card or move, or unmount) aborts it and makes every earlier ticket dead; `finish` retires a ticket that is
 * still current.
 */
export class RequestGate {
  private current: AbortController | null = null;
  start(): RequestTicket {
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    return { signal: controller.signal, live: () => this.current === controller };
  }
  stop(): void { this.current?.abort(); }
  reset(): void { this.current?.abort(); this.current = null; }
  finish(ticket: RequestTicket): void { if (ticket.live()) this.current = null; }
}

export type Availability = PermissionState | 'unknown';
/** The explain button's label once permission is granted, by the page's class for the try (brief 9.9.2 a). */
export const EXPLAIN_FAIL_LABEL = 'Why does my move fail?';
export const EXPLAIN_NEUTRAL_LABEL = 'Ask Claude about my move';
/**
 * Button label for a permission state and the try's verdict (`input.tryVerdict`), or null when the button is hidden.
 * Granted: "Why does my move fail?" only when the page found the try `worse` or `losing`, or sent no verdict
 * (version 6); `strong`, `close`, `also-good`, `unchecked` and any other value read "Ask Claude about my move", as the
 * prompt makes no failure claim for them. The `prompt` label claims nothing and stays the same for every verdict.
 */
export function coachLabel(coach: CoachClient | null, availability: Availability, tryVerdict?: CoachTryVerdict | null): string | null {
  if (!coach) return null;
  if (availability === 'granted') return tryVerdict == null || tryVerdict === 'worse' || tryVerdict === 'losing' ? EXPLAIN_FAIL_LABEL : EXPLAIN_NEUTRAL_LABEL;
  if (availability === 'prompt') return 'Ask Claude (asks permission once)';
  return null;
}
/** The question box's button label, or null when the box is hidden (same consent rule as the explain button). */
export function askLabel(coach: CoachClient | null, availability: Availability): string | null {
  if (!coach) return null;
  if (availability === 'granted') return 'Ask Claude';
  if (availability === 'prompt') return 'Ask Claude (asks permission once)';
  return null;
}

/** Why the page would refuse a request right now (daily cap or cooldown), or null. Checked before anything is revealed. */
export function limitMessage(limits: { remainingToday: number; cooldownUntil: number }, now: number): string | null {
  if (limits.remainingToday <= 0) return 'Today’s questions to Claude on this device are used up. The stored line still applies; ask again tomorrow.';
  if (limits.cooldownUntil > now) return `Ask again in ${Math.ceil((limits.cooldownUntil - now) / 1000)} s.`;
  return null;
}

export const UNGROUNDED = 'Check this on the board: part of this answer is not from the engine line.';
export const ASK_PARTIAL = 'Claude stopped before finishing. This part was not checked against the lines.';
export const ASK_DEFAULT_HINT = 'Claude answers from the lines on this page. Name a move, like Nf3, to ask about it.';
const ASK_NOT_SENT = 'This question could not be sent. The lines on this page still apply.';

/**
 * Builds the ask input for a question (the parent's job, L6): find the moves the question names that are legal
 * at the card position (SAN or UCI), check up to 3 of them (in-page engine, stored lines, or tablebase data on
 * endgame drills) and return the input; null when no input can be made. Stop when `signal` aborts.
 */
export type AskInputBuilder = (question: string, signal: AbortSignal) => CoachAskInput | null | Promise<CoachAskInput | null>;

export type AskOutcome =
  | { status: 'answered'; result: CoachResult; input: CoachAskInput }
  /** Refused before anything ran (empty or long question, daily cap, cooldown). */
  | { status: 'refused'; message: string }
  | { status: 'failed'; message: string; partial?: string; hide: boolean }
  | { status: 'stopped' };

/**
 * The question box's submit, as a plain function: the component only maps the outcome to state, so tests can
 * drive it without a DOM. Order: question check -> the page's limits (so a refused question runs nothing) ->
 * `onStart` -> build the input (may run the engine; Stop aborts it) -> one coach call.
 */
export async function runAsk(opts: {
  coach: CoachClient;
  question: string;
  build: AskInputBuilder;
  signal: AbortSignal;
  now?: number;
  /** Called once the question will be sent (the parent cancels auto-advance and notes that Claude was asked). */
  onStart?: (question: string) => void;
  onPhase?: (phase: 'checking' | 'asking') => void;
  onText?: (text: string) => void;
}): Promise<AskOutcome> {
  const question = opts.question.trim();
  if (!question) return { status: 'refused', message: 'Write a question first.' };
  if (question.length > COACH_LIMITS.question) return { status: 'refused', message: `Keep the question to ${COACH_LIMITS.question} characters.` };
  const refused = limitMessage(opts.coach.limits(), opts.now ?? Date.now());
  if (refused) return { status: 'refused', message: refused };
  if (opts.signal.aborted) return { status: 'stopped' };
  opts.onStart?.(question);
  opts.onPhase?.('checking');
  let input: CoachAskInput | null;
  try { input = await opts.build(question, opts.signal); } catch { return opts.signal.aborted ? { status: 'stopped' } : { status: 'failed', message: ASK_NOT_SENT, hide: false }; }
  if (opts.signal.aborted) return { status: 'stopped' };
  if (!input) return { status: 'failed', message: ASK_NOT_SENT, hide: false };
  opts.onPhase?.('asking');
  try {
    const result = await opts.coach.ask(input, { signal: opts.signal, ...(opts.onText ? { onText: opts.onText } : {}) });
    // Stop pressed while a saved answer was being read: it is not shown (brief 8.13, Codex coach note).
    if (opts.signal.aborted) return { status: 'stopped' };
    return { status: 'answered', result, input };
  } catch (e) {
    const failure = e instanceof CoachError ? e.failure : null;
    if (failure?.action === 'cancelled' || opts.signal.aborted) return { status: 'stopped' };
    return {
      status: 'failed', hide: failure?.action === 'hide',
      message: failure?.message ?? 'Claude could not answer just now. The lines on this page still apply.',
      ...(failure?.partial ? { partial: failure.partial } : {}),
    };
  }
}

/**
 * The moves the page checked for a question, one plain line each, exactly as the prompt gave them to Claude (same
 * line rules: the whole line, the move first; legal moves only; at most 32 plies), e.g. "Nd5 exd5 Nxd5 (engine
 * line; winning chances for White 45%)" or "Kd3 Kd5 (tablebase line; the game is a draw with best play)".
 * A tablebase result is never shown as a percentage, and on an endgame drill no Win% is shown at all.
 * Brief 9.11.3: an engine line whose search did not finish reads "(engine line, from a search that did not finish)"
 * (R5-6), and a line that carries the (p) note (`checkNote`) shows no Win%, as in the prompt.
 */
export function checkedLines(input: CoachAskInput): string[] {
  const side = input.side === 'w' ? 'White' : 'Black';
  const drill = tablebaseCard(input);
  const out: string[] = [];
  for (const a of input.askedLines.slice(0, COACH_LIMITS.asked)) {
    const line = a ? askedLineSans(input.fen, a) : null;
    if (!line) continue;
    const unfinished = a.source === 'engine' && a.finished === false;
    const source = a.source === 'engine' ? (unfinished ? UNFINISHED_LINE_LABEL : 'engine line') : a.source === 'tablebase' ? 'tablebase line' : 'stored line';
    const result = a.result === 'win' || a.result === 'draw' || a.result === 'loss' ? a.result : null;
    const noted = a.source === 'engine' && typeof a.checkNote === 'string' && !!a.checkNote.trim();
    const detail = result ? `; ${resultWords(result, input.side)} with best play`
      : a.source !== 'tablebase' && !drill && !unfinished && !noted && typeof a.win === 'number' && Number.isFinite(a.win)
        ? `; winning chances for ${side} ${Math.round(Math.min(100, Math.max(0, a.win)))}%` : '';
    out.push(`${line.sans.join(' ')} (${source}${detail})`);
  }
  return out;
}

/** The panel's parts, each with the condition under which the panel shows it. */
export interface PanelParts {
  /** The stored lines (a wrong move, once the position has ended). */
  staticShown: boolean;
  /** The explain button's label, or null when it is hidden. */
  label: string | null;
  /** The explain answer so far, and whether a request is running. */
  text: string; busy: boolean;
  /** A message about the explain request (limits, failure). */
  message: string;
  /** The question box's button label, or null when the box is hidden. */
  questionLabel: string | null;
  /** The question's answer so far, and the question's phase while it runs. */
  askText: string; phase: 'checking' | 'asking' | null;
  /** A message about the question (refused, failed). */
  askMessage: string;
}
/** True when at least one part is on screen. False: the panel renders nothing (brief 9.10 j). */
export function panelHasContent(p: PanelParts): boolean {
  return p.staticShown || !!p.label || !!p.text || p.busy || !!p.message || !!p.questionLabel || !!p.askText || !!p.phase || !!p.askMessage;
}

export default function CoachPanel({
  coach, input = null, revealsAnswer = false, onAsk, initialAvailability = 'unknown',
  askInput, onAskQuestion, askKey, askHint = ASK_DEFAULT_HINT, onInteract,
}: {
  coach: CoachClient | null;
  /** The wrong move to explain; absent after a clean solve (then only the question box can show). */
  input?: CoachExplainInput | null;
  /** True while the position is unfinished: asking shows the answer, so the attempt is finished first. */
  revealsAnswer?: boolean;
  /** Called on the click, before the request (the Trainer records the attempt as revealed and coached). */
  onAsk?: () => void;
  initialAvailability?: Availability;
  /** M3: pass it (only once the card is solved or revealed) to show the question box. */
  askInput?: AskInputBuilder;
  /** M3: called when a question is about to be sent (after the limits pass), before the input is built. */
  onAskQuestion?: (question: string) => void;
  /** M3: the question box clears when this changes (default: `input.itemId`); pass the card id. */
  askKey?: string;
  /** M3: one short line under the box. */
  askHint?: string;
  /** M3: any focus or typing in the question box (the parent pauses auto-advance, as with FeedbackBar). */
  onInteract?: () => void;
}) {
  const [availability, setAvailability] = useState<Availability>(initialAvailability);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [result, setResult] = useState<CoachResult | null>(null);
  const [message, setMessage] = useState('');
  const [explainGate] = useState(() => new RequestGate());
  const shown = input ? staticExplanation(input) : null;
  // Question box state (M3).
  const askId = useId();
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<'checking' | 'asking' | null>(null);
  const [asked, setAsked] = useState('');
  const [askText, setAskText] = useState('');
  const [askResult, setAskResult] = useState<{ result: CoachResult; input: CoachAskInput } | null>(null);
  const [askPartial, setAskPartial] = useState(false);
  const [askMessage, setAskMessage] = useState('');
  const [askGate] = useState(() => new RequestGate());
  const askReset = askKey ?? input?.itemId ?? '';

  useEffect(() => {
    let live = true;
    if (coach) coach.availability().then(s => { if (live) setAvailability(s); }, () => { if (live) setAvailability('unavailable'); });
    return () => { live = false; };
  }, [coach]);
  // A new position or move starts a fresh panel; a request still running for the old one can no longer paint.
  useEffect(() => { explainGate.reset(); setText(''); setResult(null); setMessage(''); setBusy(false); }, [explainGate, input?.itemId, input?.playedUci, input?.fen]);
  // A new card clears the question box; an answer still on its way for the old card is dropped.
  useEffect(() => {
    askGate.reset();
    setDraft(''); setPhase(null); setAsked(''); setAskText(''); setAskResult(null); setAskPartial(false); setAskMessage('');
  }, [askGate, askReset]);
  useEffect(() => () => { explainGate.reset(); askGate.reset(); }, [explainGate, askGate]);

  const label = hidden || !input ? null : coachLabel(coach, availability, input.tryVerdict);
  const questionLabel = hidden || !askInput || revealsAnswer ? null : askLabel(coach, availability);
  async function ask() {
    if (!coach || !input || busy || phase) return;
    // Check the page's own limits first, so a refused request neither reveals the answer nor books the attempt (review P2-7).
    const refused = limitMessage(coach.limits(), Date.now());
    if (refused) { setMessage(refused); return; }
    onAsk?.();
    const ticket = explainGate.start();
    setBusy(true); setMessage(''); setText(''); setResult(null);
    try {
      const answer = await coach.ask(input, { signal: ticket.signal, onText: t => { if (ticket.live()) setText(t); } });
      if (!ticket.live()) return; // the card or move changed while this was running
      if (ticket.signal.aborted) { setText(''); return; } // stopped while a saved answer was read
      setResult(answer); setText(answer.text);
      setAvailability('granted');
    } catch (e) {
      if (!ticket.live()) return;
      const failure = e instanceof CoachError ? e.failure : null;
      if (!failure || failure.action === 'tell') setMessage(failure?.message ?? 'Claude could not answer just now. The stored line above still applies.');
      if (failure?.action === 'hide') setHidden(true);
      if (failure?.partial && failure.action !== 'cancelled') setText(failure.partial);
      if (failure?.action === 'cancelled') setText('');
    } finally {
      if (ticket.live()) { explainGate.finish(ticket); setBusy(false); }
    }
  }

  async function submitQuestion() {
    if (!coach || !askInput || busy || phase) return;
    const ticket = askGate.start();
    setAskMessage(''); setAskText(''); setAskResult(null); setAskPartial(false);
    const outcome = await runAsk({
      coach, question: draft, build: askInput, signal: ticket.signal,
      onStart: q => { if (ticket.live()) { setAsked(q); onAskQuestion?.(q); } },
      onPhase: p => { if (ticket.live()) setPhase(p); },
      onText: t => { if (ticket.live()) setAskText(t); },
    });
    if (!ticket.live()) return; // the card changed while this was running
    askGate.finish(ticket);
    setPhase(null);
    if (outcome.status === 'answered') { setAskResult(outcome); setAskText(outcome.result.text); setAvailability('granted'); setDraft(''); }
    else if (outcome.status === 'refused') setAskMessage(outcome.message);
    else if (outcome.status === 'stopped') { setAskText(''); setAsked(''); }
    else {
      setAskMessage(outcome.message);
      if (outcome.partial) { setAskText(outcome.partial); setAskPartial(true); }
      if (outcome.hide) setHidden(true);
    }
  }

  // Brief 9.10 (j): with nothing to show the panel renders nothing (after every hook), so no empty `.coach-explain`
  // block takes space. Each part below is shown under the condition `panelHasContent` reads.
  const staticShown = !!shown && !revealsAnswer;
  if (!panelHasContent({ staticShown, label, text, busy, message, questionLabel, askText, phase, askMessage })) return null;

  return <div className="coach-explain" aria-live="polite">
    {/* The stored lines contain the answer, so they appear only once the position has ended. */}
    {staticShown && shown && <div className="static-explain">
      <p><strong>You played {shown.playedSan}.</strong> Best line: <span className="san">{shown.bestLineSan.join(' ')}</span></p>
      {shown.refutationSan.length > 0 && <p>After {shown.playedSan} the engine's reply line is <span className="san">{shown.refutationSan.join(' ')}</span></p>}
      {shown.numbers && <p className="small">{shown.numbers}</p>}
    </div>}
    {label && <div className="coach-actions">
      {!busy && <button type="button" className="secondary" disabled={!!phase} onClick={() => void ask()}>{label}</button>}
      {busy && <button type="button" className="secondary" onClick={() => explainGate.stop()}>Stop</button>}
      {revealsAnswer && !busy && !result && <span className="small">This shows the answer for this position.</span>}
    </div>}
    {(text || busy) && <div className="coach-answer"><p>{text || 'Claude is reading the stored line…'}</p>
      {result && !result.grounded && <p className="notice warning" role="note">{UNGROUNDED}</p>}
      {result && <p className="small">{result.cached ? 'Saved answer, reused.' : 'Answer from Claude, using only the lines above.'}</p>}
    </div>}
    {message && <p className="small" role="status">{message}</p>}
    {questionLabel && <form className="coach-ask feedback-note" onSubmit={e => { e.preventDefault(); void submitQuestion(); }}>
      <label htmlFor={askId} className="small">Ask Claude about this position</label>
      <textarea id={askId} rows={2} maxLength={COACH_LIMITS.question} value={draft} readOnly={!!phase}
        aria-describedby={askHint ? `${askId}-hint` : undefined}
        onFocus={() => onInteract?.()} onChange={e => { setDraft(e.target.value); onInteract?.(); }}/>
      {askHint && <p className="small" id={`${askId}-hint`}>{askHint}</p>}
      <div className="coach-actions">
        {!phase && <button type="submit" className="secondary" disabled={busy || !draft.trim()}>{questionLabel}</button>}
        {phase && <button type="button" className="secondary" onClick={() => askGate.stop()}>Stop</button>}
        {/* Visual only: inside the panel's live region a counter would be read out on every keystroke. */}
        <span className="small" aria-hidden="true">{draft.length}/{COACH_LIMITS.question}</span>
      </div>
    </form>}
    {(askText || phase) && <div className="coach-answer">
      {asked && <p className="small">You asked: {asked}</p>}
      <p>{askText || (phase === 'checking' ? 'Checking the moves in your question…' : 'Claude is reading the lines…')}</p>
      {askPartial && <p className="notice warning" role="note">{ASK_PARTIAL}</p>}
      {askResult && !askResult.result.grounded && <p className="notice warning" role="note">{UNGROUNDED}</p>}
      {askResult && askResult.input.askedLines.length > 0 && <p className="small">Checked on this page: {checkedLines(askResult.input).join('; ')}.</p>}
      {askResult && <p className="small">{askResult.result.cached ? 'Saved answer, reused.' : 'Answer from Claude, using only the lines this page computed.'}</p>}
    </div>}
    {askMessage && <p className="small" role="status">{askMessage}</p>}
  </div>;
}
