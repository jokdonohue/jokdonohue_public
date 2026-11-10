/**
 * Per-card feedback (item d): four buttons and an optional note, written to `feedback/*` for Claude.
 * The button set is a judgement call (plan section 10, row d).
 */
import { useEffect, useState } from 'react';
import type { FeedbackDoc } from '@/src/contract/docs';

export const FEEDBACK_BUTTONS: ReadonlyArray<readonly [FeedbackDoc['kind'], string]> = [
  ['wrong', 'Something is wrong'],
  ['too-easy', 'Too easy'],
  ['too-hard', 'Too hard'],
  ['more', 'More like this'],
];
const THANKS: Record<FeedbackDoc['kind'], string> = {
  wrong: 'Noted for Claude. This position is set aside until it is checked.',
  'too-easy': 'Noted for Claude.',
  'too-hard': 'Noted for Claude.',
  more: 'Noted for Claude.',
  less: 'Noted for Claude.',
  comment: 'Your note is saved for Claude.',
};

export default function FeedbackBar({ itemId, onSend, onInteract }: {
  itemId: string;
  onSend: (kind: FeedbackDoc['kind'], text?: string) => Promise<boolean>;
  /** Any tap here (pauses auto-advance). */
  onInteract?: () => void;
}) {
  const [sent, setSent] = useState<string>('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => { setSent(''); setNoteOpen(false); setNote(''); }, [itemId]);
  async function send(kind: FeedbackDoc['kind'], text?: string) {
    onInteract?.();
    const ok = await onSend(kind, text);
    setSent(ok ? THANKS[kind] : 'That did not save. Try again in a moment.');
    if (ok && kind === 'comment') { setNote(''); setNoteOpen(false); }
  }
  return <div className="feedback-bar" onPointerDown={onInteract}>
    <span className="feedback-label">About this position</span>
    <div className="feedback-buttons" role="group" aria-label="Feedback about this position">
      {FEEDBACK_BUTTONS.map(([kind, label]) => <button key={kind} type="button" className="chip" onClick={() => void send(kind)}>{label}</button>)}
      <button type="button" className="chip" aria-expanded={noteOpen} onClick={() => { onInteract?.(); setNoteOpen(o => !o); }}>Note for Claude</button>
    </div>
    {noteOpen && <form className="feedback-note" onSubmit={e => { e.preventDefault(); if (note.trim()) void send('comment', note); }}>
      <label htmlFor={`feedback-note-${itemId}`} className="small">What should Claude know about this position?</label>
      <textarea id={`feedback-note-${itemId}`} maxLength={500} rows={2} value={note} onChange={e => setNote(e.target.value)}/>
      <button type="submit" className="secondary" disabled={!note.trim()}>Save note</button>
    </form>}
    {sent && <p className="small" role="status">{sent}</p>}
  </div>;
}
