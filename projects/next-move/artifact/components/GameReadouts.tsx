/**
 * "Opening accidents" (D8, evidence B7: know your own lines) and "In your real games" (D9, evidence B10: puzzle
 * practice is not proven to carry over to games, so measure the games; A4: the feeling of progress is unreliable).
 */
import { colorName, openingRows, pct, pctRange, transferView, type OpeningRow, type TransferPointView } from './insights';
import type { OpeningsDoc, TransferDoc } from '@/src/contract/docs';

function OpeningLine({ row, available, onPractise }: { row: OpeningRow; available: number; onPractise: (row: OpeningRow) => void }) {
  return <li className="opening-row">
    <div className="opening-name"><strong>{row.opening}</strong><span className="small">{`as ${colorName(row.color)} · ${row.games} games`}</span></div>
    <div className="opening-rate"><strong>{pct(row.rate)}</strong>{row.ci && <span className="small">{`range ${pctRange(row.ci)}`}</span>}</div>
    {available > 0 && <button type="button" className="secondary" onClick={() => onPractise(row)}>{`Practise these ${available} position${available === 1 ? '' : 's'}`}</button>}
  </li>;
}

export function OpeningAccidents({ doc, isAvailable, onPractise }: { doc: OpeningsDoc | null; isAvailable: (id: string) => boolean; onPractise: (row: OpeningRow, ids: string[]) => void }) {
  const { ranked, few, context } = openingRows(doc);
  if (!ranked.length && !few.length) return null;
  const ids = (r: OpeningRow) => r.cardIds.filter(isAvailable);
  const line = (r: OpeningRow) => <OpeningLine key={r.key} row={r} available={ids(r).length} onPractise={row => onPractise(row, ids(row))}/>;
  return <section className="surface openings" aria-labelledby="opening-accidents">
    <h2 id="opening-accidents">Opening accidents</h2>
    <p className="small">How often a game in each opening had a blunder by move 10, from the engine check of your games. The range is where the true rate probably lies (95%). Openings with at least 30 games are ranked.</p>
    {ranked.length > 0 && <ol className="opening-list">{ranked.map(line)}</ol>}
    {few.length > 0 && <details className="opening-few"><summary>{`Few games (${few.length} opening${few.length === 1 ? '' : 's'} under 30 games)`}</summary><ul className="opening-list">{few.map(line)}</ul></details>}
    {context.length > 0 && <div className="opening-context"><p className="small"><strong>Your results in all your games (no engine, for context only):</strong></p>
      <ul>{context.map(c => <li key={`${c.label}|${c.color}`} className="small">{`${c.label}${c.color ? ` as ${colorName(c.color)}` : ''}: you scored ${Math.round(c.scorePct)}% over ${c.games} games`}</li>)}</ul>
      <p className="fine-print">These scores are not engine-based and most differences are within chance. They do not change the order above.</p></div>}
    <p className="fine-print">Practising these positions counts like any other answer. It is extra practice, outside today’s limits.</p>
  </section>;
}

/** One measure over time: a 2 px line through the points, each with its 95% range as a bar. Numbers are also given in text. */
function Trend({ points, value, range, label, unit }: { points: TransferPointView[]; value: (p: TransferPointView) => number | null; range: (p: TransferPointView) => [number, number] | null; label: string; unit: string }) {
  const rows = points.map(p => ({ p, v: value(p), r: range(p) })).filter((x): x is { p: TransferPointView; v: number; r: [number, number] | null } => x.v !== null);
  if (rows.length < 2) return null;
  const W = 240, H = 72, PAD = 10;
  const lo = Math.min(...rows.map(x => x.r?.[0] ?? x.v)), hi = Math.max(...rows.map(x => x.r?.[1] ?? x.v));
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / (rows.length - 1);
  const y = (v: number) => H - PAD - ((v - lo) / span) * (H - 2 * PAD);
  return <svg className="trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: ${rows.map(r => `${r.v.toFixed(1)}${unit}`).join(', ')}`}>
    {rows.map((r, i) => r.r && <line key={`r${i}`} className="trend-range" x1={x(i)} x2={x(i)} y1={y(r.r[0])} y2={y(r.r[1])}/>)}
    <polyline className="trend-line" points={rows.map((r, i) => `${x(i)},${y(r.v)}`).join(' ')}/>
    {rows.map((r, i) => <circle key={`p${i}`} className="trend-point" cx={x(i)} cy={y(r.v)} r={4}><title>{`${r.p.window}: ${r.v.toFixed(1)}${unit}${r.r ? ` (range ${r.r[0].toFixed(1)}–${r.r[1].toFixed(1)})` : ''}`}</title></circle>)}
  </svg>;
}

export function TransferCard({ doc }: { doc: TransferDoc | null }) {
  const { points, blundersClear, notWonClear } = transferView(doc);
  if (!points.length) return null;
  const last = points[points.length - 1];
  const change = (clear: boolean | null) => (clear === null ? '' : clear ? ' The last two ranges do not overlap: this looks like a real change.' : ' No clear change yet: the last two ranges overlap.');
  return <section className="surface transfer" aria-labelledby="real-games">
    <h2 id="real-games">In your real games</h2>
    <p className="small">{`Games from ${last.window} (${last.games} games), checked by the engine.`}</p>
    <div className="transfer-grid">
      <div><strong className="transfer-number">{last.blunders.toFixed(1)}</strong><span>blunders per 100 of your moves</span>
        <span className="small">{`range ${last.blundersCi[0].toFixed(1)}–${last.blundersCi[1].toFixed(1)}.${change(blundersClear)}`}</span>
        <Trend points={points} value={p => p.blunders} range={p => p.blundersCi} label="Blunders per 100 moves" unit=""/></div>
      {last.notWon !== null && <div><strong className="transfer-number">{`${Math.round(last.notWon)}%`}</strong><span>of games where you were clearly winning (about a piece up) and did not win</span>
        <span className="small">{`${last.notWonCi ? `range ${Math.round(last.notWonCi[0])}–${Math.round(last.notWonCi[1])}%.` : ''}${last.onTime !== null ? ` About ${Math.round(last.onTime * 100)}% of those ended on time.` : ''}${change(notWonClear)}`}</span>
        <Trend points={points} value={p => p.notWon} range={p => p.notWonCi} label="Winning positions not won" unit="%"/></div>}
    </div>
    <p className="fine-print">{points.length === 1
      ? 'One measurement so far, so there is no trend yet. The next refresh of your games adds a second point.'
      : 'Each point covers a window of recent games, and the windows overlap, so neighbouring points share games.'} Puzzle practice is not proven to carry over to games, which is why these numbers come from your games.</p>
  </section>;
}
