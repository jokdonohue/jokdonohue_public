/** Home-screen pieces: today's progress line, Claude's plan, unread notes, and the connection banner. */
import type { PlanDoc } from '@/src/contract/docs';
import type { ConnectionState, SaveState } from '@/src/contract/store';
import type { NoteView } from './model';
import type { CapState, DailyCounts } from './daily';

/** One line above the board: today's counts against the caps and the plan's focus themes. */
export function TodayStrip({ counts, caps, cap, plan, unread, pretty, onNotes, status }: {
  counts: DailyCounts; caps: CapState; cap: { reviewCap: number; newCap: number }; plan: PlanDoc | null; unread: number;
  pretty: (theme: string) => string; onNotes: () => void;
  /** Save status, shown here on phones where the top bar is hidden. */
  status?: string;
}) {
  const done = counts.reviews + counts.new, total = cap.reviewCap + cap.newCap;
  return <div className="today-strip">
    <span className="today-count"><strong>{Math.min(done, total)}</strong> of {total} today{caps.done ? ' · done' : ''}</span>
    {plan && plan.focus.length > 0 && <span className="today-focus">Focus: {plan.focus.slice(0, 3).map(f => pretty(f.theme)).join(', ')}</span>}
    {unread > 0 && <button type="button" className="chip note-chip" onClick={onNotes}>{unread === 1 ? '1 note from Claude' : `${unread} notes from Claude`}</button>}
    {status && <span className="today-save">{status}</span>}
  </div>;
}

/** Shown when the daily set is finished. */
export function DailyDone({ counts, onMore }: { counts: DailyCounts; onMore: () => void }) {
  return <div className="empty-state daily-done">
    <h2>Today's set is done</h2>
    <p>{counts.reviews} review{counts.reviews === 1 ? '' : 's'} and {counts.new} new position{counts.new === 1 ? '' : 's'} today. Spacing practice over days helps it last, so tomorrow's set will be ready then.{/* evidence A2 (spacing) */}</p>
    <button type="button" className="secondary" onClick={onMore}>Keep practising anyway</button>
  </div>;
}

/** Claude's current plan and notes, newest first. */
export function PlanAndNotes({ plan, notes, pretty, onRead, id }: {
  plan: PlanDoc | null; notes: NoteView[]; pretty: (theme: string) => string; onRead: (id: string) => void; id?: string;
}) {
  if (!plan && !notes.length) return null;
  return <section className="surface plan-notes" id={id} aria-label="From Claude">
    {plan && <div className="plan">
      <h2>Your current focus</h2>
      {plan.noteToLearner && <p>{plan.noteToLearner}</p>}
      {plan.focus.length > 0 && <ul className="focus-list">{plan.focus.map(f => <li key={f.theme}><strong>{pretty(f.theme)}</strong>{f.reason ? <span> {f.reason}</span> : null}</li>)}</ul>}
    </div>}
    {notes.length > 0 && <div className="notes">
      <h2>Notes from Claude</h2>
      {notes.slice(0, 10).map(n => <article key={n.id} className={`note ${n.read ? 'read' : 'unread'}`}>
        <p>{n.text}</p>
        <div className="note-meta"><span className="small">{n.createdAt ? new Date(n.createdAt).toLocaleDateString() : ''}</span>
          {!n.read && <button type="button" className="chip" onClick={() => onRead(n.id)}>Mark as read</button>}</div>
      </article>)}
    </div>}
  </section>;
}

/**
 * Banner copy. `persistent` is the session writer's flag: false when this browser has no IndexedDB, so
 * answers that the account database has not confirmed are lost when the page closes (B1, review P0-1).
 */
export function connectionCopy(connection: ConnectionState, saveState: SaveState | string, persistent: boolean): string {
  // B1's writer (final union): device-full > set-aside > error > retrying > pending > saved. `persistent` is
  // false when the browser has no IndexedDB from the start, and also after a mid-load `device-full`.
  const deviceFull = saveState === 'device-full';
  const deviceKeeps = persistent && !deviceFull;
  const kept = deviceKeeps ? 'kept on this device' : 'kept until this page closes';
  const cannotKeep = deviceFull ? 'this device’s storage is full' : 'this browser blocks storage';
  const base = ((): string => {
    switch (connection) {
      case 'stale': return `Working offline. Your answers are ${kept} and saved when the connection returns.`;
      case 'local-only': return deviceKeeps
        ? 'Saved on this device only for now. Your answers upload to your account the next time Next Move opens while you are signed in to claude.ai.'
        : `Not saved: ${cannotKeep} and the database is unavailable. Answers made now are lost when the page closes.`;
      case 'read-only': return deviceKeeps
        ? 'This view cannot save to your account. Your answers stay on this device until a view that can save opens.'
        : `This view cannot save to your account, and ${cannotKeep}. Answers made now are lost when the page closes.`;
      case 'full': return `Storage for this page is full. Your answers are ${kept}; Claude can tidy older history.`;
      case 'revoked': return 'Access to your saved progress was withdrawn. Reload the page.';
      default:
        if (deviceFull) return 'This device’s storage is full. Answers are still being saved to your account; wait for "Saved" before closing the page.';
        if (saveState === 'retrying') return `Saving did not work just now. Your answers are ${kept} and sent again automatically.`;
        if (saveState === 'error') return '';
        // Live, but nothing survives a close here until the account confirms it.
        if (!persistent && saveState === 'pending') return 'Saving to your account. This browser blocks storage, so wait for "Saved" before closing the page.';
        if (saveState === 'set-aside' || saveState === 'saved' || saveState === 'pending') return '';
        // A state the page does not know is never treated as saved.
        return `Your latest answers are not confirmed yet. They are ${kept} and sent again.`;
    }
  })();
  const extra: string[] = [];
  // `error`: the account refused a save permanently; nothing is retried on a timer in this load.
  if (saveState === 'error') extra.push(deviceKeeps
    ? 'Your account refused a save. Your answers stay on this device and are sent again the next time Next Move opens.'
    : 'Your account refused a save, and this device cannot keep the answers: answers not yet saved are lost when the page closes.');
  // `set-aside`: an answer that failed validation is never uploaded or retried.
  if (saveState === 'set-aside') extra.push('One answer could not be saved because its record was not valid, so it was set aside. Your other answers are not affected.');
  return [base, ...extra].filter(Boolean).join(' ');
}
/** Status banner for anything other than a live connection. */
export function ConnectionBanner({ connection, saveState, persistent = true }: { connection: ConnectionState; saveState: SaveState | string; persistent?: boolean }) {
  const text = connectionCopy(connection, saveState, persistent);
  if (!text) return null;
  const serious = connection === 'revoked' || connection === 'full' || saveState === 'set-aside' || saveState === 'error' || saveState === 'device-full' || (!persistent && connection !== 'live');
  return <div className={`notice ${serious ? 'error' : ''}`} role="status">{text}</div>;
}

/** Short save status for the top bar. */
/**
 * Short save status for the top bar (review re-check F1). "Saved" only when the connection is live, the
 * writer reports `saved` AND no answer on this device is still unconfirmed by the database. A timeout or
 * any state name this page does not know never reads as saved.
 */
export function saveLabel(connection: ConnectionState, saveState: SaveState | string, persistent = true, unconfirmed = 0): string {
  const deviceKeeps = persistent && saveState !== 'device-full';
  if (connection === 'connecting') return 'Connecting…';
  if (connection === 'local-only' || connection === 'read-only') return deviceKeeps ? 'Saved on this device' : 'Not saved';
  if (connection === 'revoked') return 'Not saving';
  if (connection === 'full') return 'Storage full';
  if (saveState === 'set-aside') return 'One answer not saved';
  if (saveState === 'error') return deviceKeeps ? 'Saved on this device' : 'Not saved';
  if (connection === 'stale') return 'Will save when online';
  if (saveState === 'retrying') return 'Retrying…';
  if (saveState === 'pending' || saveState === 'device-full') return 'Saving…';
  if (saveState === 'saved') return unconfirmed > 0 ? 'Saving…' : 'Saved';
  return 'Not yet confirmed';
}
