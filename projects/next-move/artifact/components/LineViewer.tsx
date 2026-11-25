/**
 * M3 line viewer (lead decision L2; brief 8.15 and 9.4): step through a line of moves on a display-only board.
 * The board shows the move just played as `lastMove` and as an arrow over the same squares; the start position
 * has no arrow. Nothing previews the next move, so the learner can guess each move before pressing Next.
 * The caption is the narrated sentence of the move just played (L1), or the intro at the start; the line summary
 * closes the last step. Positions, move names, sentences and the summary are all computed (chess.js through the
 * stepper and the narrator). A narration passed in is used only when it was made from this position for this
 * whole line; otherwise the viewer narrates the line itself, so it never prints a sentence about a different line.
 * A caption never names a move still ahead in the line: a move that allows mate in one reads "..., but it allows
 * mate in one." without the mating move (brief 9.9.2 b; see `lineNarration`).
 * `defaultOpen={false}` shows only a button until it is pressed; nothing is narrated before that.
 * The step and the open state are local; both start again when the position or the line changes (an engine line
 * can arrive later).
 * FX1b (brief 9.11.2): `verdict` is an engine figure that closes the line when it contradicts the material count,
 * `omit` is a move no sentence may describe (the answer, while the card is unsolved; FXR2b1, brief 9.11.8: or a list
 * of them, every move still to find), and "No material changes hands." is left out in every viewer
 * (`noChangeSentence`, default false here; the narrator keeps it by default, so lessons, hints and coach inputs read as
 * before). All three reach the narrator, never the board.
 * FX1c (brief 9.11.3): the move list shows the moves up to the step on the board, then "…" while more remain, so it
 * never shows a move he is asked to guess (R4-4); the legend at step 0 says "Press Next to step through the line."
 * and asks for a guess only from step 1 (R4-4, R6-3); a step back that removes the focused move button moves the focus
 * to the move now current, or to Next. Each step's caption is the ply's `caption` when the narrator made one (a
 * sentence of three or more facts, or over 25 words, split; R4-6), else its sentence.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Chess } from 'chess.js';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from 'lucide-react';
import Chessboard from './Chessboard';
import { buildSteps, clampStep, type LineStep } from '@/src/teach/stepper';
import { narrateLine, omitRefs, playUci, NO_CHANGE_SENTENCE, type LineVerdict, type MoveRef, type NarratedLine } from '@/src/teach/narrate';

export interface LineViewerProps {
  title: string;
  startFen: string;
  /** UCI moves from `startFen`, alternating sides. The viewer stops before the first move that is not legal. */
  line: readonly string[];
  orientation: 'w' | 'b';
  /** `narrateLine(startFen, line)` when the caller already has it; otherwise the viewer narrates the line. Not used
   *  when a move of the line allows mate in one (its sentence would name the mate): the viewer narrates the line. */
  narrated?: NarratedLine;
  /** Caption at the start, before any move is played. */
  intro?: string;
  /** 0 = the start position, k = after the k-th move. Clamped to the line. */
  initialStep?: number;
  /** A smaller board, for a viewer shown under another board. */
  compact?: boolean;
  /** false: only a button labelled `toggleLabel` until he presses it. Default true (open at once). */
  defaultOpen?: boolean;
  /** The label of that button. Default "Show the line". */
  toggleLabel?: string;
  /** Called when that button is pressed; never for a viewer that starts open, never while rendering. */
  onOpen?: () => void;
  /** An engine figure for this line (brief 9.11.2 (r) 2 lists what the Trainer passes for each viewer). When it
   *  contradicts the material count, the closing sentence says so instead of naming a winner. */
  verdict?: LineVerdict | null;
  /** A move the sentences must not describe: the answer, while the card is unsolved (brief 9.11.2 (t) 2); or a list of
   *  them, every move still to find (brief 9.11.8). An empty list leaves nothing out. */
  omit?: MoveRef | readonly MoveRef[] | null;
  /** true keeps "No material changes hands." as the closing sentence. Default false (brief 9.11.2 (r) 4). */
  noChangeSentence?: boolean;
}

/** The narrator options a viewer reads its line with. */
export type ViewerNarrateOptions = { verdict?: LineVerdict | null; omit?: MoveRef | readonly MoveRef[] | null; noChangeSentence?: boolean };

/** A control press: one of the four buttons, or a step number from the move list. */
export type StepAction = 'start' | 'back' | 'next' | 'end' | number;

/** The step an action leads to, always inside the line. */
export function stepAfter(action: StepAction, current: number, steps: readonly LineStep[]): number {
  const target = action === 'start' ? 0 : action === 'end' ? steps.length - 1 : action === 'back' ? current - 1 : action === 'next' ? current + 1 : action;
  return clampStep(target, steps);
}

/** Left and Right step through the line, Home and End jump; other keys are left alone. */
export function keyAction(key: string): StepAction | null {
  switch (key) {
    case 'ArrowLeft': return 'back';
    case 'ArrowRight': return 'next';
    case 'Home': return 'start';
    case 'End': return 'end';
    default: return null;
  }
}

/** "12. Bxh7+" for White, "12... Kxh7" for Black: number and side come from the position before the move. */
export function moveLabel(fenBefore: string, san: string): string {
  const fields = fenBefore.trim().split(/\s+/);
  const n = Number.parseInt(fields[5] ?? '', 10);
  return `${Number.isFinite(n) && n > 0 ? n : 1}${fields[1] === 'b' ? '...' : '.'} ${san}`;
}

/** The narrator starts each sentence with the move ("Bxh7+ takes the pawn on h7 with check."); the caption shows
 *  the numbered move in bold, so that leading move is dropped. A sentence in another form is kept whole. */
export function sentenceAfterMove(text: string, san: string): string {
  return text.startsWith(`${san} `) ? text.slice(san.length + 1) : text;
}

/** The line under the board. There is no arrow for the next move, so after the first move it asks him to guess the
 *  next one. FX1c (brief 9.11.3, R4-4 and R6-3): at the start it only says how to step, because the title often names
 *  the first move (and a try viewer's first move is his own try). */
export function legendFor(step: number, last: number): string {
  if (step >= last) return 'End of the line.';
  return step <= 0 ? 'Press Next to step through the line.' : 'Guess the next move, then press Next.';
}

/** FX1c (brief 9.11.3, R4-6): the narration with each ply's `caption` (its short form) in place of its sentence, for
 *  the step captions. A narration without captions is returned as it is. */
export function withCaptions(n: NarratedLine): NarratedLine {
  return n.plies.some(p => p.caption) ? { ...n, plies: n.plies.map(p => (p.caption ? { ...p, text: p.caption } : p)) } : n;
}

/**
 * FX1c (brief 9.11.3, R4-4): the move list shows the moves up to the step on the board, so a step back removes the
 * move buttons after it. When the focus is on one of those, it must not fall to the page: it goes to the move now
 * current, or to Next when no move is shown. `focusedPly` is the ply of the focused move button (null when the focus
 * is elsewhere). Null: leave the focus alone.
 */
export function focusAfterStep(focusedPly: number | null, target: number): 'move' | 'next' | null {
  if (focusedPly === null || focusedPly <= target) return null;
  return target > 0 ? 'move' : 'next';
}

/** Board, side to move, castling and en passant: the FEN fields that define the position (not the move counters). */
const position = (fen: string) => fen.trim().split(/\s+/).slice(0, 4).join(' ');
const sideToMove = (fen: string): 'w' | 'b' => (fen.trim().split(/\s+/)[1] === 'b' ? 'b' : 'w');

/** The narration only when it was made from this position for this line (every narrated move matches); otherwise none. */
export function matchingNarration(startFen: string, line: readonly string[], narrated?: NarratedLine): NarratedLine | undefined {
  if (!narrated || position(narrated.startFen) !== position(startFen)) return undefined;
  return narrated.plies.every((ply, k) => ply.uci === line[k]) ? narrated : undefined;
}

/** A ply that allows a mate in one: the default narration names the mating move in its sentence. */
const allowsMate = (narrated: NarratedLine) => narrated.plies.some(p => !!p.facts?.allowsMate);

/** A matching narration that reaches the end of the line (every move, or up to the first illegal one) and has no
 *  move that allows a mate in one; else the viewer's own narration of the whole line. Its summary is then about the
 *  line shown, never about a part of it. The viewer's own narration never names the mating move in a step's caption
 *  (`nameMate: false`, brief 9.9.2 b): that move may be the next one in the line, still to be guessed. A narration
 *  passed in may name it, so a line with such a move is always narrated here, from this `startFen`, which also keeps
 *  the stepper from narrating any step again with the default wording. The summary keeps the SAN (the line has ended).
 *  FX1b: a narration passed in is used only when it can have been made with these options (brief 9.11.2). A narration
 *  carries no record of them, so one is ignored whenever a verdict or an `omit` is in play, and when it closes on the
 *  sentence `noChangeSentence: false` leaves out. */
export function lineNarration(startFen: string, line: readonly string[], narrated?: NarratedLine, opts?: ViewerNarrateOptions): NarratedLine {
  const verdict = opts?.verdict ?? null, omit = opts?.omit ?? null, noChangeSentence = opts?.noChangeSentence ?? false;
  const given = matchingNarration(startFen, line, narrated);
  const sameOptions = !verdict && omitRefs(omit).length === 0 && !(noChangeSentence === false && given?.summary === NO_CHANGE_SENTENCE);
  if (given && sameOptions && (given.plies.length === line.length || given.stoppedAt === given.plies.length) && !allowsMate(given)) return given;
  return narrateLine(startFen, line, { maxPlies: line.length, nameMate: false, verdict, omit, noChangeSentence });
}

/** The step to show: the one he moved to while the line is unchanged, else the requested first step; always inside the line. */
export function resolveStep(saved: { key: string; step: number }, key: string, initialStep: number | undefined, steps: readonly LineStep[]): number {
  return clampStep(saved.key === key ? saved.step : (initialStep ?? 0), steps);
}

/** Open or collapsed: what he chose while the line is unchanged, else `defaultOpen` (a new line starts as asked). */
export function resolveOpen(saved: { key: string; open: boolean }, key: string, defaultOpen: boolean): boolean {
  return saved.key === key ? saved.open : defaultOpen;
}

/** A readable position and a legal first move: the open viewer then has something to show. The same replay as
 *  the stepper's (the narrator's `playUci`), without narrating anything, so a collapsed viewer stays cheap. */
export function hasFirstMove(startFen: string, line: readonly string[]): boolean {
  if (!Array.isArray(line) || line.length === 0) return false;
  let board: Chess;
  try { board = new Chess(startFen); } catch { return false; }
  return playUci(board, line[0]) !== null;
}

/** The stepper's steps, cut before the first one that is not a played move; none when the position cannot be read. */
function readSteps(startFen: string, line: readonly string[], narrated: NarratedLine): LineStep[] {
  let steps: LineStep[];
  try { steps = buildSteps(startFen, line, narrated); } catch { return []; }
  const cut = steps.findIndex((s, i) => i > 0 && !(s.uci && s.san && s.fen));
  return cut === -1 ? steps : steps.slice(0, cut);
}

/** The "…" after the moves shown: centred on the row of move buttons, in the legend's muted colour. Inline, because
 *  `styles/app.css` has another writer this stage. It stays inline for v7: an inline style would override a
 *  `.line-viewer-more` rule in app.css, and tests/m3_fix2b_narrate.test.tsx pins this exact style string. */
const MORE_STYLE = { alignSelf: 'center', padding: '0 4px', color: 'var(--muted)' } as const;

const CONTROLS = [
  { action: 'start', name: 'Start', Icon: ChevronFirst },
  { action: 'back', name: 'Back', Icon: ChevronLeft },
  { action: 'next', name: 'Next', Icon: ChevronRight },
  { action: 'end', name: 'End', Icon: ChevronLast },
] as const;

/** Renders nothing when there is no legal move to show (an unreadable position, an empty line, or an illegal first
 *  move), open or collapsed. */
export default function LineViewer({ title, startFen, line, orientation, narrated, intro, initialStep, compact = false, defaultOpen = true, toggleLabel = 'Show the line', onOpen, verdict = null, omit = null, noChangeSentence = false }: LineViewerProps) {
  const headingId = useId();
  const sectionRef = useRef<HTMLElement | null>(null);
  // Set by the button press only, so a viewer that starts open never takes the focus.
  const focusWhenOpen = useRef(false);
  // `key` stands for startFen and line, so a parent that rebuilds the same line each render does not narrate it again.
  const key = `${startFen}|${line.join(' ')}`;
  const [saved, setSaved] = useState({ key, step: initialStep ?? 0, open: defaultOpen });
  // A new line starts at `initialStep` and as `defaultOpen` asks every time it is shown, also when an earlier line
  // comes back without a press in between.
  if (saved.key !== key) setSaved({ key, step: initialStep ?? 0, open: defaultOpen });
  const open = resolveOpen(saved, key, defaultOpen);
  const playable = useMemo(() => hasFirstMove(startFen, line), [key]);
  // The narrator options as plain strings, so a verdict or an `omit` built again each render does not narrate the
  // line again, and one that really changes (an engine check finishing after the viewer is on screen) does.
  // They stay out of `key`: a new figure for the same line must not send him back to step 0 or close the viewer.
  const verdictKey = verdict ? `${verdict.side}:${'winning' in verdict ? 'winning' : verdict.win}` : '';
  // FXR2b1 (brief 9.11.8): every move of a list, in order; one move gives the same key as before.
  const omitKey = omitRefs(omit).map(o => `${o.piece}${o.from}${o.to}${o.promotion ?? ''}`).join(' ');
  // Narration and steps only once the viewer is open.
  const story = useMemo(() => (open ? lineNarration(startFen, line, narrated, { verdict, omit, noChangeSentence }) : null),
    [key, narrated, open, verdictKey, omitKey, noChangeSentence]);
  // FX1c (brief 9.11.3, R4-6): the steps carry each ply's short form (`caption`), so no caption sentence runs long.
  const steps = useMemo(() => (story ? readSteps(startFen, line, withCaptions(story)) : []), [key, story]);
  // The pressed button is gone once the viewer opens: the focus moves to the viewer, not to the page. The viewer
  // opens where the button was, so focusing it never needs to scroll the page.
  useEffect(() => {
    if (open && focusWhenOpen.current) { focusWhenOpen.current = false; sectionRef.current?.focus({ preventScroll: true }); }
  }, [open]);
  // FX1c (R4-4): set by a step back that removes the focused move button (see `focusAfterStep`); used after render.
  const refocus = useRef<'move' | 'next' | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const where = refocus.current;
    if (!where) return;
    refocus.current = null;
    const target = where === 'move' ? sectionRef.current?.querySelector<HTMLElement>('.line-viewer-move[aria-current="step"]') : nextRef.current;
    target?.focus({ preventScroll: true });
  });

  if (!open) {
    if (!playable) return null;
    const show = () => {
      focusWhenOpen.current = true;
      setSaved({ key, step: saved.key === key ? saved.step : (initialStep ?? 0), open: true });
      onOpen?.();
    };
    return <button type="button" className="secondary line-viewer-toggle" aria-expanded="false" onClick={show}>{toggleLabel}</button>;
  }
  if (steps.length < 2 || !story) return null;

  const last = steps.length - 1;
  const step = resolveStep(saved, key, initialStep, steps);
  const go = (action: StepAction) => {
    const target = stepAfter(action, step, steps);
    if (target !== step || saved.key !== key) {
      // FX1c (R4-4): a focused move button after `target` is about to go; the focus follows to the new current move.
      const active = typeof document === 'undefined' ? null : document.activeElement;
      const button = active && sectionRef.current?.contains(active) ? active.closest('.line-viewer-move') : null;
      const ply = button ? Number.parseInt(button.getAttribute('data-ply') ?? '', 10) : Number.NaN;
      refocus.current = focusAfterStep(Number.isFinite(ply) ? ply : null, target);
      setSaved({ key, step: target, open: true });
    }
  };
  const now = steps[step];
  const label = step > 0 ? moveLabel(steps[step - 1].fen, now.san ?? '') : '';
  const text = step > 0 ? (now.text ? sentenceAfterMove(now.text, now.san ?? '') : '') : intro ?? `${sideToMove(now.fen) === 'w' ? 'White' : 'Black'} to move.`;
  const summary = step === last && story.plies.length === last ? story.summary : '';
  const atEdge = { start: step === 0, back: step === 0, next: step === last, end: step === last };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const action = keyAction(e.key);
    if (action === null) return;
    e.preventDefault();
    go(action);
  };

  // tabIndex only on a viewer opened by the button, so the focus has somewhere to go; the arrow is the move just
  // played (the same squares as lastMove), none at the start.
  return <section ref={sectionRef} className={compact ? 'line-viewer line-viewer-compact' : 'line-viewer'} aria-labelledby={headingId} tabIndex={defaultOpen ? undefined : -1} onKeyDown={onKey}>
    <h3 id={headingId} className="line-viewer-title">{title}</h3>
    <div className="line-viewer-board"><Chessboard fen={now.fen} orientation={orientation} disabled lastMove={now.uci} arrow={step > 0 ? now.uci : undefined}/></div>
    <p className="line-viewer-legend">{legendFor(step, last)}</p>
    {/* aria-disabled, not disabled: the focused button keeps focus at either end of the line. */}
    <div className="line-viewer-controls" role="group" aria-label="Step through the line">
      {CONTROLS.map(({ action, name, Icon }) => <button key={action} ref={action === 'next' ? nextRef : undefined} type="button" className="secondary" aria-disabled={atEdge[action] || undefined} onClick={() => go(action)}>
        <Icon size={16} aria-hidden="true"/><span>{name}</span></button>)}
    </div>
    <p className="line-viewer-caption" aria-live="polite">{label && <strong>{label}</strong>}{label && text ? ' ' : ''}{text}</p>
    {summary && <p className="line-viewer-summary">{summary}</p>}
    {/* FX1c (brief 9.11.3, R4-4): the moves up to the step on the board, then "…" while more remain, so the list never
        shows a move he is asked to guess. */}
    <ol className="line-viewer-moves" role="list" aria-label="Moves in the line">
      {steps.slice(1, step + 1).map((s, k) => {
        const ply = k + 1, before = steps[k].fen, full = moveLabel(before, s.san ?? '');
        return <li key={ply}><button type="button" className="line-viewer-move" data-ply={ply} aria-current={ply === step ? 'step' : undefined} aria-label={full} onClick={() => go(ply)}>
          {sideToMove(before) === 'w' || k === 0 ? full : s.san}</button></li>;
      })}
      {step < last && <li className="line-viewer-more" style={MORE_STYLE}><span aria-hidden="true">…</span><span className="sr-only">More moves follow.</span></li>}
    </ol>
  </section>;
}
