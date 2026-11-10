/**
 * "Import games from a PGN" (brief M2 D13, stream PGN): paste or choose a .pgn file, the engine in this page
 * checks his moves, and his clear mistakes become practice positions. No outside fetch: the text comes from
 * the paste box or a local file, and the engine is the bundled worker.
 * All logic lives in `src/analysis/importer.ts`; this component only holds the screen state.
 */
import { useEffect, useRef, useState } from 'react';
import type { Store } from '@/src/contract/store';
import { createWorkerEngine, isAbort, type AnalysisEngine } from '@/src/analysis/engine';
import {
  cleanNames, prepareGames, readGames, runImport, ImportWriteError, MAX_GAMES,
  type ImportProgress, type ImportSummary, type PreparedGame, type Side,
} from '@/src/analysis/importer';

export interface PgnImportProps {
  store: Store;
  /** `settings.myNames`: the names he plays under, used to tell which side he played. */
  myNames: string[];
  /** `settings.chesscomUser`, also matched as one of his names. */
  chesscomUser?: string;
  /** Saves `settings.myNames` through the model (the one settings writer). */
  saveMyNames(names: string[]): Promise<boolean>;
  /** Positions already in his practice (pack, punish and personal), so the same position is not added twice. */
  knownCards: ReadonlyArray<{ id: string; fen: string }>;
  onSaved?(r: { games: number; positions: number }): void;
  /** Tests only: an engine instead of the bundled worker. */
  createEngine?: () => AnalysisEngine;
}

type Stage = 'input' | 'review' | 'running' | 'done';
export const LOCAL_ONLY_LINE = 'Importing games is off for now: it needs the saved storage, which is not available right now. Your practice still works.';
const FILE_LIMIT = 2_000_000;
const SIDE_WORD: Record<Side, string> = { w: 'White', b: 'Black' };

export default function PgnImport(props: PgnImportProps) {
  const { store, myNames, chesscomUser, saveMyNames, knownCards, onSaved, createEngine } = props;
  const [stage, setStage] = useState<Stage>('input');
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [prepared, setPrepared] = useState<PreparedGame[]>([]);
  const [sides, setSides] = useState<Record<string, Side>>({});
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [namesText, setNamesText] = useState(myNames.join(', '));
  const [namesNote, setNamesNote] = useState('');
  const [busy, setBusy] = useState(false);
  const stopper = useRef<AbortController | null>(null);

  // Keyed on the text, not the array: a parent re-render with a fresh `[]` must not wipe what he is typing.
  const savedNames = myNames.join(', ');
  useEffect(() => setNamesText(savedNames), [savedNames]);
  useEffect(() => () => stopper.current?.abort(), []);

  const names = cleanNames([...myNames, ...(chesscomUser ? [chesscomUser] : [])]);
  // Review P2-1: on the local-only memory store nothing would survive a reload, so importing is switched off.
  const saveable = store.kind === 'db';

  async function saveNames() {
    if (!saveable) return;
    const list = cleanNames(namesText.split(','));
    setNamesNote((await saveMyNames(list)) ? (list.length ? 'Saved.' : 'Cleared.') : 'That did not save. Try again in a moment.');
  }

  async function check(source: string) {
    if (!saveable) { setMessage(LOCAL_ONLY_LINE); return; }
    setMessage(''); setBusy(true);
    try {
      const read = readGames(source);
      if (!read.ok) { setMessage(read.message); return; }
      const list = await prepareGames(read.games, names, store);
      setPrepared(list); setSides({}); setStage('review');
    } catch { setMessage('The games could not be checked against your saved games. Try again in a moment.'); }
    finally { setBusy(false); }
  }

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    if (file.size > FILE_LIMIT) { setMessage('That file is over 2 MB. Choose a smaller file, with at most 10 games.'); return; }
    let content = '';
    try { content = await file.text(); } catch { setMessage('That file could not be read.'); return; }
    setText(content);
    await check(content);
  }

  const todo = prepared.filter(p => !p.already && !p.problem);
  const needSide = todo.filter(p => !p.side && !sides[p.gameId]);

  async function analyse() {
    const ctrl = new AbortController();
    stopper.current = ctrl;
    setStage('running'); setMessage(''); setProgress(null);
    try {
      const result = await runImport({
        prepared, sides, engine: (createEngine ?? createWorkerEngine)(), store, knownCards, signal: ctrl.signal, onProgress: setProgress,
      });
      setSummary(result); setStage('done');
      onSaved?.({ games: result.games, positions: result.positions });
    } catch (e) {
      setStage('review');
      if (isAbort(e)) setMessage('Stopped. Nothing was saved.');
      else if (e instanceof ImportWriteError) setMessage(e.message);
      else setMessage(e instanceof Error && e.message ? e.message : 'The check did not finish. Nothing was saved.');
    } finally { stopper.current = null; }
  }

  function reset() { setStage('input'); setText(''); setPrepared([]); setSides({}); setSummary(null); setProgress(null); setMessage(''); }

  return <div className="surface pgn-import">
    <h2>Import games from a PGN</h2>
    {stage === 'input' && <>
      <p className="small">Paste up to {MAX_GAMES} finished games, or choose a .pgn file. The engine in this page checks your moves, and the clear mistakes become positions to practise. This can take a few minutes on a phone.</p>
      <p className="small">On chess.com, open a finished game and use Share to copy or download its PGN.</p>
      {!saveable && <p className="notice" role="status">{LOCAL_ONLY_LINE}</p>}
      <div className="pgn-names">
        <label htmlFor="pgn-my-names">Your names in your games (separate with commas)</label>
        <div className="input-row">
          <input id="pgn-my-names" autoComplete="off" disabled={!saveable} value={namesText} onChange={e => setNamesText(e.target.value)}/>
          <button type="button" className="secondary" disabled={!saveable} onClick={() => void saveNames()}>Save</button>
        </div>
        {namesNote && <p className="small" role="status">{namesNote}</p>}
      </div>
      <label htmlFor="pgn-text">Games (PGN)</label>
      <textarea id="pgn-text" className="pgn-text" rows={8} spellCheck={false} disabled={!saveable} value={text} onChange={e => setText(e.target.value)} placeholder={'[White "..."]\n[Black "..."]\n\n1. e4 e5 ...'}/>
      <div className="backup-actions">
        <button type="button" className="primary" disabled={!saveable || busy || !text.trim()} onClick={() => void check(text)}>Check these games</button>
        <label className="secondary file-button">Choose a .pgn file
          <input id="pgn-file" type="file" accept=".pgn,application/x-chess-pgn,text/plain" disabled={!saveable || busy} onChange={e => { void chooseFile(e.target.files?.[0]); e.target.value = ''; }}/>
        </label>
      </div>
    </>}
    {stage === 'review' && <>
      <ul className="pgn-games">
        {prepared.map(p => <li key={p.gameId}>
          <span>{p.label}</span>{' '}
          {p.already ? <em>already imported, skipped</em>
            : p.problem ? <em>{p.problem}, skipped</em>
            : p.side ? <em>you played {SIDE_WORD[p.side]}</em>
            : <span className="pgn-side" role="group" aria-label={`Which side did you play in ${p.label}?`}>
                Which side did you play?{' '}
                {(['w', 'b'] as const).map(s => <button key={s} type="button" className={sides[p.gameId] === s ? 'primary' : 'secondary'} aria-pressed={sides[p.gameId] === s} onClick={() => setSides({ ...sides, [p.gameId]: s })}>{SIDE_WORD[s]}</button>)}
              </span>}
        </li>)}
      </ul>
      <p className="small">This can take a few minutes on a phone. You can stop at any time before saving; nothing is saved until every game is checked.</p>
      <div className="backup-actions">
        <button type="button" className="primary" disabled={!todo.length || needSide.length > 0} onClick={() => void analyse()}>
          {todo.length ? `Check ${todo.length} game${todo.length === 1 ? '' : 's'}` : 'Nothing new to check'}
        </button>
        <button type="button" className="secondary" onClick={reset}>Back</button>
      </div>
    </>}
    {stage === 'running' && <>
      <p role="status">{!progress ? 'Starting the engine…'
        : progress.phase === 'saving' ? 'Saving…'
        : `Checking game ${progress.game} of ${progress.games}: ${progress.done} of ${progress.total} of your moves`}</p>
      <progress className="pgn-progress" value={progress?.phase === 'analysing' ? progress.done : progress?.phase === 'saving' ? 1 : 0} max={progress?.phase === 'analysing' ? Math.max(1, progress.total) : 1}/>
      <div className="backup-actions">
        <button type="button" className="secondary" disabled={progress?.phase === 'saving'} onClick={() => stopper.current?.abort()}>Stop</button>
      </div>
    </>}
    {stage === 'done' && summary && <>
      <p role="status">{summaryLine(summary)}</p>
      <div className="backup-actions"><button type="button" className="secondary" onClick={reset}>Import more games</button></div>
    </>}
    {message && <p className="notice" role="status">{message}</p>}
  </div>;
}

export function summaryLine(s: ImportSummary): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [`Checked ${plural(s.games, 'game', 'games')}: ${plural(s.positions, 'new position', 'new positions')} to practise from your mistakes.`];
  if (s.skippedKnown) parts.push(`${plural(s.skippedKnown, 'mistake was', 'mistakes were')} already in your practice.`);
  if (s.skippedAlready) parts.push(`${plural(s.skippedAlready, 'game was', 'games were')} imported before.`);
  if (s.skippedProblem) parts.push(`${plural(s.skippedProblem, 'game was', 'games were')} too large to save and skipped.`);
  if (s.games && !s.positions) parts.push('Only mistakes with one clearly best answer become positions.');
  return parts.join(' ');
}
