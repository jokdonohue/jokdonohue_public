/**
 * "Safe or not?" card (lead decision D4). Two components so the answer can never reach the page early:
 * `SafeQuestionPanel` receives only the question view (position, his move, his side), never `kind` or `reveal`;
 * `SafeAnswerPanel` is rendered only after he answers. Copy follows the safety check "what does that allow?"
 * (evidence C1) and practises telling sound moves from blunders apart (evidence A3).
 */
import { useMemo } from 'react';
import { ArrowRight, GraduationCap, ShieldCheck } from 'lucide-react';
import Chessboard from './Chessboard';
import LineViewer from './LineViewer';
import { describeMove, type SafeChoice, type SafeQuestion, type SafeScore } from './safe';
import { safeReveal } from './safeReveal';
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

/**
 * After his answer (version 7.3). The panel says what the stored facts show (`safeReveal`): the result, a lead in plain
 * words, the engine's choice and the stored pair of figures; then Next; then the line viewers, as after any other card
 * (`SolvedViewers`). The reply line is stepped through in words from his move on; before 7.3 it was one sentence of
 * percentages and an arrow behind a "Show the reply" toggle.
 */
export function SafeAnswerPanel({ question, card, choice, saved = true, score, onNext, nextLabel, layout = 'wide', children }: {
  question: SafeQuestion; card: SafeCardDoc; choice: SafeChoice; /** False when the answer could not be recorded (fix pass P2-4). */ saved?: boolean;
  score: SafeScore | null; onNext: () => void; nextLabel: string;
  /** Where the line viewers go: under the board from 651 to 1000 px, where the panel is narrowest (as `PracticeColumns`). */
  layout?: 'phone' | 'mid' | 'wide'; children?: React.ReactNode;
}) {
  // Read only now, after his answer: the card's answer never reaches the question panel.
  const view = useMemo(() => safeReveal(question, card), [question, card]);
  const gameUrl = card.reveal?.gameUrl;
  const correct = choice === card.kind;
  const verdict = correct ? 'Right.' : choice === 'unsure' ? 'Here is the answer.' : 'Not this time.';
  // The reply line opens on his move (step 1), so its first request is to guess the reply; the engine's choice waits
  // one press away. Stepping records nothing.
  const viewers = (view.reply || (view.best && view.best.line.length > 1)) ? <div className="teach-viewers">
    {view.reply && <LineViewer key={`reply-${question.id}`} title={view.reply.title} startFen={question.fen} line={view.reply.line} orientation={question.side}
      initialStep={1} verdict={view.reply.verdict} noChangeSentence={false}/>}
    {view.best && view.best.line.length > 1 && <div className="teach-more"><LineViewer key={`best-${question.id}`} title={view.best.title} startFen={question.fen} line={view.best.line} orientation={question.side}
      verdict={view.best.verdict} noChangeSentence={false} defaultOpen={false} toggleLabel={view.best.toggle}/></div>}
  </div> : null;
  return <div className="practice-layout safe-card">
    <div className="board-column">
      <div className="board-top"><span className={`turn-dot ${question.side}`}/><strong>{`You played ${sideName(question.side)}`}</strong><span>From your game</span></div>
      <Chessboard fen={question.fen} orientation={question.side} disabled arrow={question.playedUci}/>
      <div className="board-caption"><span>The arrow shows your move.</span><span>{question.title ?? ''}</span></div>
      {layout === 'mid' && viewers && <div className="board-viewers">{viewers}</div>}
    </div>
    <aside className="coach-panel">
      <div className="coach-heading"><GraduationCap size={24}/><h2>Safe or not?</h2></div>
      <div className={`feedback ${correct ? 'success' : ''}`} aria-live="polite"><strong>{verdict}</strong> {view.fact}</div>
      {!saved && <p className="notice error" role="alert">This answer was not saved, so it does not count in your score or schedule. Your earlier answers are unchanged.</p>}
      {view.lead && <p className="safe-lead">{view.lead}</p>}
      {view.best && <p className="small"><strong>The engine’s choice: </strong>{view.best.san}</p>}
      {view.figures && <p className="small">{view.figures}</p>}
      {score && <SafeScoreLine score={score}/>}
      <button className="primary wide" onClick={onNext}>{nextLabel}<ArrowRight size={18}/></button>
      {layout !== 'mid' && viewers}
      {gameUrl && <a className="small" href={gameUrl} target="_blank" rel="noreferrer">Open the game on Chess.com</a>}
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
