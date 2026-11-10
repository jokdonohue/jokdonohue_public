'use client';
import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import Chessboard from './Chessboard';
import { fenAfter, type PersonalPack, type StudyItem } from '@/lib/personal-pack';

/** Openings with fewer games than this are left out: one game moves a 5-game score by about 10 points (review R6). */
export const MIN_OPENING_GAMES = 15;

const one = (n: number) => n.toFixed(1);
const interval = ([low, high]: readonly [number, number]) => `${one(low)} to ${one(high)}`;
const percentRange = ([low, high]: readonly [number, number]) => `${Math.round(low * 100)} to ${Math.round(high * 100)}%`;
const label = (s: string) => s.replace(/[-_:]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());

/**
 * Wilson 95% interval for a share `p` (0-1) over `n` games. For an opening score, draws count as half a point,
 * so the interval treats the score as a share of games won: an approximation, stated in the fine print.
 */
export function wilson(p: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const share = Math.min(1, Math.max(0, p)), z2 = z * z, centre = share + z2 / (2 * n);
  const spread = z * Math.sqrt(share * (1 - share) / n + z2 / (4 * n * n)), scale = 1 + z2 / n;
  return [Math.max(0, (centre - spread) / scale), Math.min(1, (centre + spread) / scale)];
}

/** Compact summary of the personal pack's profile: main findings with sample sizes and 95% intervals. */
export default function PersonalPackSummary({ pack, onPractise }: { pack: PersonalPack; onPractise: () => void }) {
  const { profile } = pack, { sample } = profile;
  const phases = (['opening', 'middlegame', 'endgame'] as const).flatMap(phase => profile.phaseRates[phase] ? [[phase, profile.phaseRates[phase]] as const] : []);
  // "unknown" means no classifier rule matched; it is not a motif (QA P2-7).
  const motifs = Object.entries(profile.motifs).filter(([motif]) => motif !== 'unknown').sort((a, b) => b[1].count - a[1].count).slice(0, 6);
  const openings = (profile.openings ?? []).filter(o => o.games >= MIN_OPENING_GAMES).sort((a, b) => a.scorePct - b.scorePct).slice(0, 5);
  const practice = pack.cards.length;
  const deeper = sample.confirmDepth > sample.depth;
  const conversion = profile.conversion;
  return <div className="surface pack-summary">
    <div className="pack-summary-heading">
      <div><h2>From your games</h2><p className="small">An engine pass over {sample.games.toLocaleString()} of your {sample.timeClasses.join(' and ')} games, {sample.from} to {sample.to}. {sample.engine}, depth {sample.depth}{deeper ? `, practice moves rechecked at depth ${sample.confirmDepth}` : ''}.</p></div>
      <button className="primary" disabled={!practice} onClick={onPractise}>Practise {practice.toLocaleString()} position{practice === 1 ? '' : 's'}<ArrowRight size={17}/></button>
    </div>
    <div className="pack-grid">
      {phases.length > 0 && <div><h3>Blunders by phase</h3><table><thead><tr><th>Phase</th><th>Your moves</th><th>Per 100 moves</th><th>95% interval</th></tr></thead><tbody>{phases.map(([phase, row]) => <tr key={phase}><td>{label(phase)}</td><td>{row.ownerMoves.toLocaleString()}</td><td>{one(row.blundersPer100)}</td><td>{interval(row.ci95)}</td></tr>)}</tbody></table></div>}
      {motifs.length > 0 && <div><h3>Most frequent motifs</h3><table><thead><tr><th>Motif</th><th>Count</th><th>Per 100 moves</th><th>95% interval</th></tr></thead><tbody>{motifs.map(([motif, row]) => <tr key={motif}><td>{label(motif)}</td><td>{row.count.toLocaleString()}</td><td>{one(row.per100Moves)}</td><td>{interval(row.ci95)}</td></tr>)}</tbody></table></div>}
      {profile.clock && profile.clock.length > 0 && <div><h3>Blunders by clock</h3><table><thead><tr><th>Clock</th><th>Your moves</th><th>Per 100 moves</th><th>95% interval</th></tr></thead><tbody>{profile.clock.map(row => <tr key={row.bucket}><td>{row.bucket}</td><td>{row.ownerMoves.toLocaleString()}</td><td>{one(row.blundersPer100)}</td><td>{interval(row.ci95)}</td></tr>)}</tbody></table></div>}
      {openings.length > 0 && <div><h3>Openings with your lowest scores</h3><table><thead><tr><th>Opening</th><th>Side</th><th>Games</th><th>Score (95% interval)</th><th>Games with a blunder by move 10</th></tr></thead><tbody>{openings.map(row => <tr key={`${row.eco}-${row.name}-${row.color}`}><td>{row.name}{row.eco ? ` (${row.eco})` : ''}</td><td>{row.color === 'w' ? 'White' : 'Black'}</td><td>{row.games}</td><td>{Math.round(row.scorePct)}% ({percentRange(wilson(row.scorePct / 100, row.games))})</td><td>{Math.round(row.earlyBlunderRate * 100)}%{row.earlyBlunderCi95 ? ` (${percentRange(row.earlyBlunderCi95)})` : ''}</td></tr>)}</tbody></table></div>}
    </div>
    {conversion && <p className="small">Games where the engine had you at +3 or better (300 centipawns, or a forced mate) at some point: {conversion.gamesWinningBy3.toLocaleString()}. Not won: {conversion.notWon.toLocaleString()}{conversion.notWonShareCi95 ? ` (95% interval ${percentRange(conversion.notWonShareCi95)} of such games)` : ''}; ended on time {conversion.byOutcome.time}, checkmated {conversion.byOutcome.mated}, other {conversion.byOutcome.other}.</p>}
    {profile.firstBlunderMove?.median != null && <p className="small">Median move number of your first blunder: {profile.firstBlunderMove.median}.</p>}
    {pack.study.length > 0 && <StalemateStudy items={pack.study}/>}
    <p className="fine-print">These counts describe the games listed above at the stated engine settings. Phase, motif and clock intervals come from the engine pass; an opening&apos;s score interval is computed here from its number of games and treats a draw as half a win, so it is approximate. Openings with fewer than {MIN_OPENING_GAMES} games are left out. They describe past games; they are not a rating estimate. Practice positions use only moves where the engine&apos;s choice was clearly best; a position you reached in several games is one practice position.</p>
  </div>;
}

/**
 * Stalemates the owner delivered while winning, as study positions. They are not scored or scheduled: in a won
 * position many moves keep the win, so grading one engine move as the answer would be wrong (lead brief, item 3).
 */
export function StalemateStudy({ items }: { items: StudyItem[] }) {
  const [index, setIndex] = useState(0), [shown, setShown] = useState<'none' | 'played' | 'best'>('none');
  const item = items[Math.min(index, items.length - 1)];
  const go = (step: number) => { setIndex((index + step + items.length) % items.length); setShown('none'); };
  const uci = shown === 'played' ? item.playedUci : shown === 'best' ? item.bestUci : undefined;
  const fen = (uci && fenAfter(item.fen, uci)) || item.fen;
  return <section className="stalemate-study" aria-label="Stalemates to study">
    <h3>Stalemates in won positions: {items.length} to study</h3>
    <p className="small">Study positions, not scored: in a won position many moves keep the win. {items.length === 1 ? 'This is the position' : 'These are the positions'} before you gave stalemate.</p>
    <div className="stalemate-study-grid">
      <div><Chessboard key={`${item.id}-${shown}`} fen={fen} orientation={item.ownerColor} lastMove={uci}/></div>
      <div>
        <p className="small"><strong>{index + 1} of {items.length}</strong> · {item.timeClass === 'rapid' ? 'Rapid' : 'Blitz'} · {item.date} · move {item.moveNumber} · {item.ownerColor === 'w' ? 'White' : 'Black'} to move</p>
        <p className="small">Find a move that keeps the win without leaving the opponent stuck, then compare.</p>
        <div className="button-row">
          <button className="secondary" onClick={() => setShown('played')}>Show your move</button>
          <button className="secondary" onClick={() => setShown('best')}>Show the engine&apos;s move</button>
        </div>
        {shown === 'played' && <p className="small">You played {item.playedSan}. The opponent then had no legal move and was not in check: stalemate, so the game was drawn.</p>}
        {shown === 'best' && <p className="small">The engine&apos;s choice was {item.bestSan}. Before your move the engine gave you {Math.round(item.winBefore)} out of 100 winning chances.</p>}
        <div className="button-row">
          <button className="text-button" disabled={items.length < 2} onClick={() => go(-1)}>Previous</button>
          <button className="text-button" disabled={items.length < 2} onClick={() => go(1)}>Next stalemate</button>
          <a className="text-button" href={item.gameUrl} target="_blank" rel="noreferrer">Open the game on Chess.com</a>
        </div>
      </div>
    </div>
  </section>;
}
