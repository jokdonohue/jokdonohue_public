/**
 * "Study these" (lead decision D7, evidence A8): positions that went wrong on 4 of their last 6 practice days leave the
 * queue and wait here as worked examples, with the position, the stored line and the explanation. "Put it back"
 * returns one to practice (lapses start again at 0; due tomorrow).
 */
import { useState } from 'react';
import { Chess } from 'chess.js';
import { BookOpen, RotateCcw } from 'lucide-react';
import Chessboard from './Chessboard';
import { sanLine } from './coachInput';
import { isPunish, type TrainerItem } from './pools';

export interface StudyEntry { item: TrainerItem; lapseDays: number; windowDays: number }

function StudyItem({ entry, onPutBack }: { entry: StudyEntry; onPutBack: (item: TrainerItem) => void }) {
  const [open, setOpen] = useState(false);
  const { item } = entry;
  let turn: 'w' | 'b' = 'w';
  try { turn = new Chess(item.fen).turn(); } catch { /* shown without a board below */ }
  const line = sanLine(item.fen, item.moves);
  return <li className="study-item">
    <div className="study-item-head">
      <button type="button" className="study-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <strong>{item.title ?? (isPunish(item) ? 'Punish it' : item.source === 'bank' ? 'Puzzle' : 'From your game')}</strong>
        <span className="small">{`Went wrong on ${entry.lapseDays} of the last ${entry.windowDays} days you practised it`}</span>
      </button>
      <button type="button" className="secondary" onClick={() => onPutBack(item)}><RotateCcw size={15}/>Put it back</button>
    </div>
    {open && <div className="study-body">
      <div className="study-board"><Chessboard fen={item.fen} orientation={turn} disabled arrow={item.moves[0]}/></div>
      <div className="study-text">
        <p><strong>{`${turn === 'w' ? 'White' : 'Black'} to move. `}</strong>The arrow shows the first move of the stored line.</p>
        {line.length > 0 && <p><strong>Stored line: </strong>{line.join('  ')}</p>}
        {item.explanation && <p className="small">{item.explanation}</p>}
        <p className="small">Play it through on a board of your own, say why each move works, then put it back.</p>
      </div>
    </div>}
  </li>;
}

export default function StudyList({ entries, onPutBack }: { entries: readonly StudyEntry[]; onPutBack: (item: TrainerItem) => void }) {
  if (!entries.length) return null;
  return <section className="surface study-list" aria-labelledby="study-these">
    <div className="coach-heading"><BookOpen size={22}/><h2 id="study-these">Study these</h2></div>
    <p className="small">{`${entries.length} position${entries.length === 1 ? '' : 's'} went wrong on at least 4 of the last 6 days you practised ${entries.length === 1 ? 'it' : 'them'}, so ${entries.length === 1 ? 'it is' : 'they are'} out of your practice for now. Studying the worked line helps more than another miss.`}</p>
    <ul>{entries.map(e => <StudyItem key={e.item.id} entry={e} onPutBack={onPutBack}/>)}</ul>
  </section>;
}
