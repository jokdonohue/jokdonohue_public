/**
 * Ungraded "punish it" items as worked examples (item a, B3's `study` entries with `set: "punish"`).
 * Never scheduled, graded or recorded, and no move input: the stored reply was not clearly the only good
 * move. Worked examples suit learners at this level (evidence A8); the "what does that allow?" framing
 * is Heisman's safety check (C1).
 */
import { useState } from 'react';
import Chessboard from './Chessboard';
import { fenAfter } from '@/lib/personal-pack';

export interface PunishStudyItem {
  id: string; fen: string; solverColor?: string; playedSan?: string; playedUci?: string; replyUci?: string; replySan?: string;
  lineSan?: string[]; why?: string; explanation?: string; gameUrl?: string; date?: string; timeClass?: string; moveNumber?: number; title?: string;
}

const str = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
/** Items with what the example needs: a position, his move and a legal stored reply. */
export function usablePunishStudy(items: ReadonlyArray<Record<string, unknown>>): PunishStudyItem[] {
  return items.filter(i => str(i.id) && str(i.fen) && str(i.playedSan) && str(i.replySan) && str(i.replyUci) && !!fenAfter(i.fen as string, i.replyUci as string)) as unknown as PunishStudyItem[];
}

export default function PunishStudy({ items }: { items: PunishStudyItem[] }) {
  const [index, setIndex] = useState(0), [shown, setShown] = useState(false);
  if (!items.length) return null;
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
  </section>;
}
