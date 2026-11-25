/**
 * Read-outs from his real games (M2): "Opening accidents" (D8, evidence B7) and the transfer card (D9, evidence
 * B10 and A4). Pure; the numbers come from Claude's engine pass, the page only orders and words them.
 */
import type { OpeningsDoc, TransferDoc } from '@/src/contract/docs';

/** D8: openings with at least this many games are ranked; the rest are listed as "few games". */
export const MIN_RANKED_GAMES = 30;

export interface OpeningRow { key: string; opening: string; color: 'w' | 'b'; games: number; rate: number; ci: [number, number] | null; cardIds: string[] }
export interface ContextRow { label: string; color: 'w' | 'b' | null; games: number; scorePct: number }

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function openingRows(doc: OpeningsDoc | null): { ranked: OpeningRow[]; few: OpeningRow[]; context: ContextRow[] } {
  if (!doc) return { ranked: [], few: [], context: [] };
  const rows = doc.groups.map((g, i): OpeningRow & { fewFlag: boolean } => ({
    key: `${g.opening}|${g.color}|${i}`, opening: g.opening, color: g.color, games: g.games, rate: g.earlyBlunderRate,
    ci: g.ci95 && finite(g.ci95[0]) && finite(g.ci95[1]) ? [Math.min(g.ci95[0], g.ci95[1]), Math.max(g.ci95[0], g.ci95[1])] : null,
    cardIds: [...new Set(g.cardIds)], fewFlag: !!g.fewGames,
  }));
  const strip = ({ fewFlag: _f, ...r }: OpeningRow & { fewFlag: boolean }) => r;
  const isRanked = (r: { games: number; fewFlag: boolean }) => !r.fewFlag && r.games >= MIN_RANKED_GAMES;
  const ranked = rows.filter(isRanked).sort((a, b) => b.rate - a.rate || b.games - a.games || (a.opening < b.opening ? -1 : a.opening > b.opening ? 1 : 0)).map(strip);
  const few = rows.filter(r => !isRanked(r)).sort((a, b) => b.games - a.games || (a.opening < b.opening ? -1 : 1)).map(strip);
  const raw = (doc as Record<string, unknown>).archiveContext;
  const context: ContextRow[] = Array.isArray(raw) ? raw.flatMap(r => {
    const x = r as Record<string, unknown>;
    if (typeof x.label !== 'string' || !finite(x.games) || !finite(x.scorePct)) return [];
    const color: ContextRow['color'] = x.color === 'w' || x.color === 'b' ? x.color : null;
    return [{ label: x.label.slice(0, 120), color, games: x.games, scorePct: x.scorePct }];
  }).slice(0, 10) : [];
  return { ranked, few, context };
}

/** A 0-1 share as a whole percentage. */
export const pct = (x: number) => `${Math.round(x * 100)}%`;
/** A 0-1 range as "54–74%". */
export const pctRange = (r: [number, number]) => `${Math.round(r[0] * 100)}–${Math.round(r[1] * 100)}%`;
export const colorName = (c: 'w' | 'b' | null) => (c === 'w' ? 'White' : c === 'b' ? 'Black' : '');

export interface TransferPointView { at: number; games: number; window: string; blunders: number; blundersCi: [number, number]; notWon: number | null; notWonCi: [number, number] | null; onTime: number | null }
/** Two ranges overlap (inclusive). */
export const rangesOverlap = (a: readonly [number, number], b: readonly [number, number]) => a[0] <= b[1] && b[0] <= a[1];

export function transferView(doc: TransferDoc | null): { points: TransferPointView[]; blundersClear: boolean | null; notWonClear: boolean | null } {
  const points = (doc?.points ?? []).map(p => ({
    at: typeof p.at === 'number' ? p.at : Date.parse(p.at), games: p.games, window: p.window.replace('..', ' to '),
    blunders: p.blundersPer100, blundersCi: [Math.min(...p.ci95), Math.max(...p.ci95)] as [number, number],
    notWon: p.convNotWonPct, notWonCi: p.convCi95 ? [Math.min(...p.convCi95), Math.max(...p.convCi95)] as [number, number] : null, onTime: p.onTimeShare,
  })).filter(p => Number.isFinite(p.at)).sort((a, b) => a.at - b.at);
  if (points.length < 2) return { points, blundersClear: null, notWonClear: null };
  const [a, b] = points.slice(-2);
  return {
    points,
    // "Clear" only when the two latest ranges do not overlap (D9); anything else reads "no clear change yet".
    blundersClear: !rangesOverlap(a.blundersCi, b.blundersCi),
    notWonClear: a.notWonCi && b.notWonCi ? !rangesOverlap(a.notWonCi, b.notWonCi) : null,
  };
}
