/**
 * Item g, transfer card (M2): blunders per 100 moves and the +3 not-won rate in his real games, with 95% ranges,
 * one point per refresh in `transfer/history`. Pedagogy: B10 (puzzle-to-game transfer is unproven, so measure
 * games) and A4 (the feeling of progress is unreliable) in reviews/claude/evidence_base.md.
 *
 * Units: `blundersPer100` and `ci95` per 100 owner moves (the producer's game-bootstrap interval);
 * `convNotWonPct` and `convCi95` in percent of games that reached +3 (the producer's Wilson interval over games);
 * `onTimeShare` = share (0-1) of those not-won games that ended on the clock.
 * Each refresh's sample is the most recent N games, so consecutive windows overlap: a trend over points is
 * a moving window, not independent measurements.
 */
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const rec = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pair = (v: unknown): [number, number] | null => (Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1]] : null);

export function transferPoint(profile: Record<string, unknown>, opts: { packVersion: string; at: string }): Record<string, unknown> {
  const sample = rec(profile.sample), overall = rec(profile.overall), conv = rec(profile.conversion), by = rec(conv.byOutcome);
  const bp = num(overall.blundersPer100), ci = pair(overall.ci95);
  if (bp === null || !ci) throw new Error('weakness_profile.json: overall.blundersPer100 and overall.ci95 are required');
  const share = num(conv.notWonShare), shareCi = pair(conv.notWonShareCi95), notWon = num(conv.notWon), onTime = num(by.time);
  return {
    at: opts.at,
    games: num(sample.games) ?? 0,
    window: `${sample.from ?? '?'}..${sample.to ?? '?'} (most recent ${sample.games ?? '?'} rapid and blitz games)`,
    blundersPer100: bp,
    ci95: ci,
    convNotWonPct: share === null ? null : r2(share * 100),
    convCi95: shareCi ? [r2(shareCi[0] * 100), r2(shareCi[1] * 100)] : null,
    onTimeShare: notWon && onTime !== null ? r4(onTime / notWon) : null,
    packVersion: opts.packVersion,
    ownerMoves: num(sample.ownerMoves) ?? num(overall.ownerMoves),
    convGames: num(conv.gamesWinningBy3), convNotWon: notWon,
    methods: { blunders: 'per 100 owner moves; 95% percentile bootstrap over games', conversion: 'games at +3 (engine, depth 14) not won; 95% Wilson over games' },
  };
}

/** Append (or replace the point with the same packVersion), oldest first, at most 500 points. */
export function appendTransferPoint(existing: { points?: Array<Record<string, unknown>> } | null, point: Record<string, unknown>): Record<string, unknown> {
  const points = (existing?.points ?? []).filter(p => p.packVersion !== point.packVersion);
  points.push(point);
  points.sort((a, b) => Date.parse(String(a.at)) - Date.parse(String(b.at)) || (String(a.packVersion) < String(b.packVersion) ? -1 : String(a.packVersion) > String(b.packVersion) ? 1 : 0));
  return {
    ...(existing ?? {}),
    points: points.slice(-500),
    note: 'One point per refresh. Each point covers the most recent N games at that refresh, so windows overlap; read the trend as a moving window.',
  };
}
