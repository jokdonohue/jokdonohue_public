/**
 * Ungraded "punish it" items as worked examples (item a, B3's `study` entries with `set: "punish"`).
 * Never scheduled, graded or recorded, and no move input: the stored reply was not clearly the only good
 * move. Worked examples suit learners at this level (evidence A8); the "what does that allow?" framing
 * is Heisman's safety check (C1).
 *
 * M3 (brief 9.5): `edges` are punish cards where his move gave the opponent only a small edge (`classifyPunish` =
 * small-edge: 50 to 65% for the solver), so they are not served graded. They are listed under the worked examples
 * as "Smaller edges from your games": the card's lesson (`punishLesson`) and a collapsed line viewer over the answer
 * line (`pack.pvUci`, the same line the lesson narrates), oriented to the solver. Reading only. A lesson costs a few
 * milliseconds (more on a phone), so lessons are made only for the items shown, five more per press, and kept per
 * card object.
 *
 * Version 7.1 (brief m31 4.5, 4.3 row L, 4.6 F2): `notUnique` are punish cards the document `teach/meta` holds as
 * 'not-unique': at 65% or more for the solver, but the deeper engine pass rates a second reply almost as highly, so they
 * are no longer served graded. They are listed above the smaller edges under "More than one good reply": the same item
 * (date line, lesson without "Better was", line viewer) plus one line, "The engine rates {other move} almost as highly."
 * (`almostAsHighly`). Cards held as 'not-held' are listed nowhere. A lesson in either list carries what the quiet reply
 * threatens when the card has a stored threat (`lessonThreat`, the definition the practice page and the coach use), and
 * names his game move with its piece and from-square where the solver could play the same SAN (`playedLabel`).
 */
import { useMemo, useState } from 'react';
import Chessboard from './Chessboard';
import LineViewer from './LineViewer';
import type { TrainerItem } from './pools';
import { fenAfter } from '@/lib/personal-pack';
import { punishAnswerLine, punishLesson, solverWinAfter } from '@/src/teach/punish';
import { playedLabel } from '@/src/teach/punish';
import { almostAsHighly } from '@/src/teach/threat';
import { lessonThreat } from './coachInput';

export interface PunishStudyItem {
  id: string; fen: string; solverColor?: string; playedSan?: string; playedUci?: string; replyUci?: string; replySan?: string;
  lineSan?: string[]; why?: string; explanation?: string; gameUrl?: string; date?: string; timeClass?: string; moveNumber?: number; title?: string;
}

/** A small-edge punish card and its sibling mistake card (`pack-<pack.rowId>`, what he should have played). */
export interface PunishEdge { card: TrainerItem; sibling?: TrainerItem }

const str = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
/** Items with what the example needs: a position, his move and a legal stored reply. */
export function usablePunishStudy(items: ReadonlyArray<Record<string, unknown>>): PunishStudyItem[] {
  return items.filter(i => str(i.id) && str(i.fen) && str(i.playedSan) && str(i.replySan) && str(i.replyUci) && !!fenAfter(i.fen as string, i.replyUci as string)) as unknown as PunishStudyItem[];
}

/** The side that plays the card's line: `pack.solverColor`, else the side to move in the card's position. */
export function solverSide(card: Pick<TrainerItem, 'fen' | 'pack'>): 'w' | 'b' {
  const c = card.pack?.solverColor;
  if (c === 'w' || c === 'b') return c;
  return card.fen.trim().split(/\s+/)[1] === 'b' ? 'b' : 'w';
}

/** Edges with a position and a line whose first move is legal there (the lesson may still be missing; his move is then named alone). */
export function usableEdges(edges: ReadonlyArray<PunishEdge>): PunishEdge[] {
  return edges.filter(e => {
    if (!str(e?.card?.id) || !str(e.card.fen)) return false;
    const first = punishAnswerLine(e.card)[0];
    return !!first && !!fenAfter(e.card.fen, first);
  });
}

/**
 * Lessons by card object, made once per card and sibling (`punishLesson` is pure). FX1e (brief 9.12.2 item 5, V2-3):
 * without "Better was …": the sibling is his own mistake card, which practice serves, and this list shows at any time.
 * Version 7.1 (brief m31 4.3, row L): with what the card's quiet reply threatens, when it has a stored threat.
 */
const lessons = new WeakMap<object, { sibling: object | undefined; text: string | null }>();
function lessonOf(edge: PunishEdge): string | null {
  const hit = lessons.get(edge.card);
  if (hit && hit.sibling === edge.sibling) return hit.text;
  const text = punishLesson(edge.card, edge.sibling ?? null, { betterMove: false, threat: lessonThreat(edge.card) });
  lessons.set(edge.card, { sibling: edge.sibling, text });
  return text;
}

/** How many smaller edges are listed at first, and added per press. */
export const EDGES_PER_PAGE = 5;

/** "Rapid · YYYY-MM-DD · move N" from the pack detail, as the worked examples show it; else the card's title. */
export function edgeMeta(card: Pick<TrainerItem, 'title' | 'pack'>): string {
  const p = card.pack ?? {};
  const parts = [p.timeClass === 'rapid' ? 'Rapid' : p.timeClass === 'blitz' ? 'Blitz' : '', str(p.date) ? p.date : '', typeof p.moveNumber === 'number' ? `move ${p.moveNumber}` : ''];
  return parts.some(Boolean) ? parts.filter(Boolean).join(' · ') : card.title ?? '';
}

/** One listed card. `also` (the "More than one good reply" list): the line about the engine's other move, between the
 *  lesson and the viewer. */
function EdgeItem({ edge, also = false }: { edge: PunishEdge; also?: boolean }) {
  const { card } = edge;
  const playedSan = card.pack?.playedSan;
  const played = str(playedSan) ? playedSan : '';
  // F2 (brief m31 4.6): the fallback sentence names his move as the lesson does (`playedLabel`).
  const lesson = lessonOf(edge) ?? (played ? `In your game you played ${playedLabel(card) || played}.` : '');
  const almost = also ? almostAsHighly(card) : null;
  const meta = edgeMeta(card);
  // Brief 9.11.2 (r) 3 and 9.11.7: the line's figure, the punisher's stored Win% after his game move.
  const win = solverWinAfter(card);
  return <li className="study-item">
    {meta && <p className="small"><strong>{meta}</strong></p>}
    {lesson && <p>{lesson}</p>}
    {almost && <p className="almost-line">{almost}</p>}
    <LineViewer title={played ? `The engine's line after ${played}` : "The engine's line"} startFen={card.fen} line={punishAnswerLine(card)}
      orientation={solverSide(card)} compact defaultOpen={false} toggleLabel="Show the line" verdict={win === null ? null : { side: solverSide(card), win }}/>
    {card.gameUrl && <a className="text-button" href={card.gameUrl} target="_blank" rel="noreferrer">Open the game on Chess.com</a>}
  </li>;
}

/** The heading of the list of punish cards held as 'not-unique' (brief m31 4.5; also the marker of a 7.1 build). */
export const MORE_THAN_ONE_HEADING = 'More than one good reply';
/** The intro of that list: the count is the number of cards listed. */
export const moreThanOneIntro = (n: number) =>
  `In ${n === 1 ? 'this position' : `these ${n} positions`} the engine's reply was not clearly the only good one. Read what your move allowed. Then step through the engine's line. These are for reading, not scored.`;

function SmallEdges({ edges, nested, also = false }: { edges: readonly PunishEdge[]; nested: boolean; also?: boolean }) {
  const [count, setCount] = useState(EDGES_PER_PAGE);
  const shown = edges.slice(0, count), left = edges.length - shown.length;
  const heading = also ? MORE_THAN_ONE_HEADING : 'Smaller edges from your games';
  return <div className={also ? 'study-list punish-edges punish-also' : 'study-list punish-edges'}>
    {nested ? <h3>{heading}</h3> : <h2>{heading}</h2>}
    <p className="small">{also ? moreThanOneIntro(edges.length) : `In ${edges.length === 1 ? 'this position' : `these ${edges.length} positions`} your move gave your opponent a small edge at most. Read what the move allowed. Then step through the engine's line. These are for reading, not scored.`}</p>
    <ul>{shown.map(e => <EdgeItem key={e.card.id} edge={e} also={also}/>)}</ul>
    {left > 0 && <div className="button-row">
      <button type="button" className="secondary" onClick={() => setCount(c => c + EDGES_PER_PAGE)}>{`Show ${Math.min(EDGES_PER_PAGE, left)} more`}</button>
    </div>}
  </div>;
}

export default function PunishStudy({ items, edges, notUnique }: { items: PunishStudyItem[]; edges?: ReadonlyArray<PunishEdge>; notUnique?: ReadonlyArray<PunishEdge> }) {
  const [index, setIndex] = useState(0), [shown, setShown] = useState(false);
  const smallEdges = useMemo(() => usableEdges(edges ?? []), [edges]);
  // Version 7.1 (brief m31 4.5): the cards held as 'not-unique', listed above the smaller edges.
  const moreThanOne = useMemo(() => usableEdges(notUnique ?? []), [notUnique]);
  if (!items.length && !smallEdges.length && !moreThanOne.length) return null;
  const edgeList = <>
    {moreThanOne.length > 0 && <SmallEdges edges={moreThanOne} nested={items.length > 0} also/>}
    {smallEdges.length > 0 && <SmallEdges edges={smallEdges} nested={items.length > 0}/>}
  </>;
  if (!items.length) return <section className="surface punish-study" aria-label={moreThanOne.length > 0 ? 'Punish it: positions to read' : 'Punish it: smaller edges'}>{edgeList}</section>;
  const item = items[Math.min(index, items.length - 1)];
  const go = (step: number) => { setIndex((index + step + items.length) % items.length); setShown(false); };
  const orientation = item.solverColor === 'b' ? 'b' : item.solverColor === 'w' ? 'w' : (item.fen.split(' ')[1] === 'b' ? 'b' : 'w');
  const fen = (shown && item.replyUci && fenAfter(item.fen, item.replyUci)) || item.fen;
  return <section className="surface punish-study" aria-label="Punish it: worked examples">
    <h2>Punish it: {items.length} worked example{items.length === 1 ? '' : 's'}</h2>
    <p className="small">Positions after one of your moves, seen from your opponent&apos;s side. These are for reading, not scored: the engine&apos;s reply was not clearly the only good one.</p>
    <div className="stalemate-study-grid">
      <div><Chessboard key={`${item.id}-${shown}`} fen={fen} orientation={orientation} lastMove={shown ? item.replyUci : item.playedUci}/></div>
      <div className="punish-study-text">
        <p className="small"><strong>{index + 1} of {items.length}</strong>{item.timeClass ? ` · ${item.timeClass === 'rapid' ? 'Rapid' : 'Blitz'}` : ''}{item.date ? ` · ${item.date}` : ''}{item.moveNumber ? ` · move ${item.moveNumber}` : ''}</p>
        <p>In your game you played <strong>{item.playedSan}</strong>. Your opponent&apos;s best reply: <strong>{item.replySan}</strong>{item.why === 'not-unique' ? ' (the engine’s reply, one of several good options)' : ''}.</p>
        {item.lineSan && item.lineSan.length > 0 && <p className="small">Engine line: <span className="san">{item.lineSan.join(' ')}</span></p>}
        {item.explanation && <p className="small">{item.explanation}</p>}
        <div className="button-row">
          <button className="secondary" onClick={() => setShown(s => !s)}>{shown ? 'Back to the position' : 'Show the move'}</button>
        </div>
        <div className="button-row">
          <button className="text-button" disabled={items.length < 2} onClick={() => go(-1)}>Previous</button>
          <button className="text-button" disabled={items.length < 2} onClick={() => go(1)}>Next example</button>
          {item.gameUrl && <a className="text-button" href={item.gameUrl} target="_blank" rel="noreferrer">Open the game on Chess.com</a>}
        </div>
      </div>
    </div>
    {edgeList}
  </section>;
}
