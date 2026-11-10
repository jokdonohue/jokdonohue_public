/**
 * "Why does my move fail?" (port plan section 4). The static panel (stored lines and numbers) is always
 * shown; the Claude button appears only when the coach exists and its permission is `granted` or
 * `prompt`. Nothing here calls the model except a click.
 */
import { useEffect, useRef, useState } from 'react';
import { CoachError, type CoachClient, type CoachExplainInput, type CoachResult } from '@/src/contract/coach';
import type { PermissionState } from '@/src/contract/store';
import { staticExplanation } from './coachInput';

export type Availability = PermissionState | 'unknown';
/** Button label for a permission state, or null when the button is hidden. */
export function coachLabel(coach: CoachClient | null, availability: Availability): string | null {
  if (!coach) return null;
  if (availability === 'granted') return 'Why does my move fail?';
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

export default function CoachPanel({ coach, input, revealsAnswer = false, onAsk, initialAvailability = 'unknown' }: {
  coach: CoachClient | null;
  input: CoachExplainInput;
  /** True while the position is unfinished: asking shows the answer, so the attempt is finished first. */
  revealsAnswer?: boolean;
  /** Called on the click, before the request (the Trainer records the attempt as revealed and coached). */
  onAsk?: () => void;
  initialAvailability?: Availability;
}) {
  const [availability, setAvailability] = useState<Availability>(initialAvailability);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [result, setResult] = useState<CoachResult | null>(null);
  const [message, setMessage] = useState('');
  const abort = useRef<AbortController | null>(null);
  const shown = staticExplanation(input);

  useEffect(() => {
    let live = true;
    if (coach) coach.availability().then(s => { if (live) setAvailability(s); }, () => { if (live) setAvailability('unavailable'); });
    return () => { live = false; };
  }, [coach]);
  // A new position or move starts a fresh panel.
  useEffect(() => { abort.current?.abort(); setText(''); setResult(null); setMessage(''); setBusy(false); }, [input.itemId, input.playedUci, input.fen]);
  useEffect(() => () => abort.current?.abort(), []);

  const label = hidden ? null : coachLabel(coach, availability);
  async function ask() {
    if (!coach || busy) return;
    // Check the page's own limits first, so a refused request neither reveals the answer nor books the attempt (review P2-7).
    const refused = limitMessage(coach.limits(), Date.now());
    if (refused) { setMessage(refused); return; }
    onAsk?.();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setMessage(''); setText(''); setResult(null);
    try {
      const answer = await coach.ask(input, { signal: controller.signal, onText: setText });
      setResult(answer); setText(answer.text);
      setAvailability('granted');
    } catch (e) {
      const failure = e instanceof CoachError ? e.failure : null;
      if (!failure || failure.action === 'tell') setMessage(failure?.message ?? 'Claude could not answer just now. The stored line above still applies.');
      if (failure?.action === 'hide') setHidden(true);
      if (failure?.partial && failure.action !== 'cancelled') setText(failure.partial);
      if (failure?.action === 'cancelled') setText('');
    } finally {
      if (abort.current === controller) abort.current = null;
      setBusy(false);
    }
  }

  return <div className="coach-explain" aria-live="polite">
    {/* The stored lines contain the answer, so they appear only once the position has ended. */}
    {!revealsAnswer && <div className="static-explain">
      <p><strong>You played {shown.playedSan}.</strong> Best line: <span className="san">{shown.bestLineSan.join(' ')}</span></p>
      {shown.refutationSan.length > 0 && <p>After {shown.playedSan} the engine's reply line is <span className="san">{shown.refutationSan.join(' ')}</span></p>}
      {shown.numbers && <p className="small">{shown.numbers}</p>}
    </div>}
    {label && <div className="coach-actions">
      {!busy && <button type="button" className="secondary" onClick={() => void ask()}>{label}</button>}
      {busy && <button type="button" className="secondary" onClick={() => abort.current?.abort()}>Stop</button>}
      {revealsAnswer && !busy && !result && <span className="small">This shows the answer for this position.</span>}
    </div>}
    {(text || busy) && <div className="coach-answer"><p>{text || 'Claude is reading the stored line…'}</p>
      {result && !result.grounded && <p className="notice warning" role="note">{UNGROUNDED}</p>}
      {result && <p className="small">{result.cached ? 'Saved answer, reused.' : 'Answer from Claude, using only the lines above.'}</p>}
    </div>}
    {message && <p className="small" role="status">{message}</p>}
  </div>;
}
