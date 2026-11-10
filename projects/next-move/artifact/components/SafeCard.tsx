/**
 * "Safe or not?" card (lead decision D4). Two components so the answer can never reach the page early:
 * `SafeQuestionPanel` receives only the question view (position, his move, his side), never `kind` or `reveal`;
 * `SafeAnswerPanel` is rendered only after he answers. Copy follows the safety check "what does that allow?"
 * (evidence C1) and practises telling sound moves from blunders apart (evidence A3).
 */
import { useState } from 'react';
import { Chess } from 'chess.js';
import { ArrowRight, GraduationCap, ShieldCheck } from 'lucide-react';
import Chessboard from './Chessboard';
import { describeMove, type SafeChoice, type SafeQuestion, type SafeScore } from './safe';
import type { SafeCardDoc } from '@/src/contract/docs';

const sideName = (c: 'w' | 'b') => (c === 'w' ? 'White' : 'Black');

export function SafeQuestionPanel({ question, onAnswer, children }: { question: SafeQuestion; onAnswer: (choice: SafeChoice) => void; children?: React.ReactNode }) {
  const words = describeMove(question.fen, question.playedUci);
  return <div className="practice-layout safe-card">
    <div className="board-column">
      <div className="board-top"><span className={`turn-dot ${question.side}`}/><strong>{`You played ${sideName(question.side)}`}</strong><span>From your game</span></div>
      <Chessboard fen={question.fen} orientation={question.side} disabled arrow={question.playedUci}/>
      <div className="board-caption"><span>The arrow shows your move.</span><span>{question.title ?? ''}</span></div>
    </div>
    <aside className="coach-panel">
      <div className="coach-heading"><ShieldCheck size={24}/><h2>Safe or not?</h2></div>
      <p className="lead">A position from one of your games, just before your move. Was the move safe, or did it lose something?</p>
      <p className="safe-move"><strong>Your move: </strong>{words}</p>
      <div className="thinking-steps"><p><span>1</span>What does this move allow?</p><p><span>2</span>Look at their checks, captures and threats after it.</p><p><span>3</span>Is anything left unprotected?</p></div>
      <div className="safe-choices" role="group" aria-label="Your verdict">
        <button type="button" className="primary" onClick={() => onAnswer('safe')}>Safe</button>
        <button type="button" className="primary" onClick={() => onAnswer('unsafe')}>It loses something</button>
        <button type="button" className="secondary" onClick={() => onAnswer('unsure')}>Not sure</button>
      </div>
      {children}
    </aside>
  </div>;
}

/** The position after his move, or null. */
function fenAfterMove(fen: string, uci: string): string | null {
  try { const b = new Chess(fen); b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); return b.fen(); } catch { return null; }
}

export function SafeAnswerPanel({ question, card, choice, saved = true, score, onNext, nextLabel, children }: {
  question: SafeQuestion; card: SafeCardDoc; choice: SafeChoice; /** False when the answer could not be recorded (fix pass P2-4). */ saved?: boolean;
  score: SafeScore | null; onNext: () => void; nextLabel: string; children?: React.ReactNode;
}) {
  const [showReply, setShowReply] = useState(false);
  const reveal = card.reveal ?? {};
  const correct = choice === card.kind;
  const replySan = reveal.replyLineSan ?? [];
  const replyUci = reveal.replyLineUci ?? [];
  const after = showReply ? fenAfterMove(question.fen, question.playedUci) : null;
  const verdict = correct ? 'Right.' : choice === 'unsure' ? 'Here is the answer.' : 'Not this time.';
  const fact = card.kind === 'safe' ? 'This move was safe.' : 'This move lost something.';
  return <div className="practice-layout safe-card">
    <div className="board-column">
      <div className="board-top"><span className={`turn-dot ${question.side}`}/><strong>{`You played ${sideName(question.side)}`}</strong><span>{showReply && after ? 'After your move' : 'From your game'}</span></div>
      <Chessboard fen={after ?? question.fen} orientation={question.side} disabled arrow={after ? replyUci[0] : question.playedUci} lastMove={after ? question.playedUci : undefined}/>
      <div className="board-caption"><span>{showReply && after ? 'The arrow shows their reply.' : 'The arrow shows your move.'}</span><span>{question.title ?? ''}</span></div>
    </div>
    <aside className="coach-panel">
      <div className="coach-heading"><GraduationCap size={24}/><h2>Safe or not?</h2></div>
      <div className={`feedback ${correct ? 'success' : ''}`} aria-live="polite"><strong>{verdict}</strong> {fact}</div>
      {!saved && <p className="notice error" role="alert">This answer was not saved, so it does not count in your score or schedule. Your earlier answers are unchanged.</p>}
      {reveal.explanation && <p className="small">{reveal.explanation}</p>}
      {reveal.bestSan && <p className="small"><strong>The engine’s choice: </strong>{reveal.bestLineSan?.length ? reveal.bestLineSan.join('  ') : reveal.bestSan}</p>}
      {replySan.length > 0 && <button type="button" className="text-button" aria-expanded={showReply} onClick={() => setShowReply(v => !v)}>{showReply ? 'Hide the reply' : 'Show the reply'}</button>}
      {showReply && replySan.length > 0 && <p className="small"><strong>Their reply: </strong>{replySan.join('  ')}</p>}
      {reveal.gameUrl && <a className="small" href={reveal.gameUrl} target="_blank" rel="noreferrer">Open the game on Chess.com</a>}
      {score && <SafeScoreLine score={score}/>}
      <button className="primary wide" onClick={onNext}>{nextLabel}<ArrowRight size={18}/></button>
      {children}
      <div className="coach-footnote">From an offline engine pass over your games at a fixed depth. It is a strong hint, not proof.</div>
    </aside>
  </div>;
}

/** D6: always two numbers, never one combined percentage. */
export function SafeScoreLine({ score }: { score: SafeScore }) {
  const total = score.caught.n + score.trusted.n;
  if (!total) return null;
  return <p className="safe-score small">{`Your last ${total} answer${total === 1 ? '' : 's'}: blunders caught ${score.caught.k} of ${score.caught.n} · sound moves trusted ${score.trusted.k} of ${score.trusted.n}`}</p>;
}
