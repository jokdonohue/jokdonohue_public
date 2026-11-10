/**
 * Item e, "Opening accidents" (M2): his mistakes in moves 1-12, grouped by opening family and colour, ordered
 * by the engine pass's early-blunder rate (share of the group's games with a confirmed blunder by move 10,
 * `weakness_profile.json` `openings[].earlyBlunderRate`). Pedagogy: B7 (players misjudge their own openings;
 * knowing one's own lines) in reviews/claude/evidence_base.md.
 *
 * - Ranked: groups with at least 30 games (as WEAKNESS_PROFILE.md section 8), each with a 95% interval over
 *   games: the producer's Wilson interval `earlyBlunderCi95`, or a Wilson interval computed here when absent.
 * - Groups under 30 games follow, marked `fewGames`, ordered by games.
 * - Whole-archive scores from `chesscom_games/SUMMARY.md` ride along in `archiveContext` with their source;
 *   they are descriptive (no engine) and never used for ranking. WHICH rows are carried is a generation input
 *   (`seed_inputs/archive_context.json`, git-ignored; see scripts/ingest.md), so this module holds no
 *   owner-specific constant.
 */
import { cmp } from './packDocs';

export const MIN_RANKED_GAMES = 30;
export const EARLY_MOVES = 12;
const MAX_IDS = 200;

export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = successes / n, z2 = z * z, den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den, half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  return [r4(Math.max(0, centre - half)), r4(Math.min(1, centre + half))];
}

export interface ArchiveContext { label: string; color: 'w' | 'b'; games: number; scorePct: number; table: string; source: string }
/** One row to carry: its first-cell label, his colour, and the start of the bold table title it sits under. */
export interface ArchiveRow { label: string; color: 'w' | 'b'; table: string }
/** Validate the generation input that lists the rows to carry (an array of ArchiveRow). Throws on anything else. */
export function readArchiveRows(input: unknown): ArchiveRow[] {
  if (!Array.isArray(input)) throw new Error('archive rows: expected an array');
  return input.map((r, i) => {
    const o = r as Partial<ArchiveRow>;
    if (typeof o?.label !== 'string' || !o.label || (o.color !== 'w' && o.color !== 'b') || typeof o.table !== 'string' || !o.table) throw new Error(`archive rows[${i}]: need label, color w|b, table`);
    return { label: o.label, color: o.color, table: o.table };
  });
}
/** Read the given rows from SUMMARY.md (markdown tables: | label | games | W | D | L | score |). Missing rows are skipped. */
export function parseArchiveContext(md: string, rows: readonly ArchiveRow[], sourcePath = 'reviews/claude/data/chesscom_games/SUMMARY.md'): ArchiveContext[] {
  const lines = md.split(/\r?\n/);
  const range = /(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/.exec(md);
  const out: ArchiveContext[] = [];
  for (const want of rows) {
    const start = lines.findIndex(l => l.replace(/\*/g, '').trim().startsWith(want.table));
    if (start < 0) continue;
    for (let i = start + 1; i < lines.length && !/^\*\*|^#/.test(lines[i]); i++) {
      const cells = lines[i].split('|').map(c => c.trim());
      if (cells[1] !== want.label) continue;
      const games = Number(cells[2]), score = Number(String(cells[6]).replace('%', ''));
      if (Number.isFinite(games) && Number.isFinite(score)) {
        out.push({ label: want.label, color: want.color, games, scorePct: score, table: want.table,
          source: `${sourcePath}, section 8 (whole archive${range ? ` ${range[1]} to ${range[2]}` : ''}; chess.com results, no engine)` });
      }
      break;
    }
  }
  return out;
}

export interface OpeningRow { id: string; judgement: string; moveNumber: number }
export function buildOpeningAccidents(input: {
  profile: Record<string, unknown>;
  rows: OpeningRow[];
  /** game id -> opening family and owner colour (`cache/judged_games.jsonl`). */
  gameFamily: Map<string, { family: string; color: 'w' | 'b' }>;
  /** producer row id -> drill card id and punish card id (from the pack docs, aliases included). */
  cardFor: Map<string, string>;
  punishFor?: Map<string, string>;
  archiveContext?: ArchiveContext[];
  at: string;
}): Record<string, unknown> {
  const openings = (input.profile.openings ?? []) as Array<{ name: string; color: 'w' | 'b'; eco?: string | null; ecoCodes?: string[]; games: number; scorePct?: number; earlyBlunderRate: number; earlyBlunderCi95?: [number, number] }>;
  const byGroup = new Map<string, OpeningRow[]>();
  for (const r of input.rows) {
    if (r.moveNumber > EARLY_MOVES || (r.judgement !== 'mistake' && r.judgement !== 'blunder')) continue;
    const fam = input.gameFamily.get(r.id.split(':')[0]);
    if (!fam) continue;
    const k = `${fam.family}|${fam.color}`;
    (byGroup.get(k) ?? byGroup.set(k, []).get(k)!).push(r);
  }
  const groups = openings.map(o => {
    const rows = (byGroup.get(`${o.name}|${o.color}`) ?? []).sort((a, b) => cmp(a.id, b.id));
    const uniq = (ids: Array<string | undefined>) => [...new Set(ids.filter((x): x is string => !!x))].slice(0, MAX_IDS);
    const ci = o.earlyBlunderCi95 ?? wilson(Math.round(o.earlyBlunderRate * o.games), o.games);
    return {
      opening: o.name, color: o.color, games: o.games, earlyBlunderRate: o.earlyBlunderRate,
      ci95: ci, ciSource: o.earlyBlunderCi95 ? 'producer (Wilson, games)' : 'pack-to-docs (Wilson, games)',
      fewGames: o.games < MIN_RANKED_GAMES,
      cardIds: uniq(rows.map(r => input.cardFor.get(r.id))),
      punishIds: uniq(rows.map(r => input.punishFor?.get(r.id))),
      mistakesFirst12: rows.length, blundersFirst12: rows.filter(r => r.judgement === 'blunder').length,
      ...(o.eco ? { eco: o.eco } : {}), ...(o.ecoCodes ? { ecoCodes: o.ecoCodes.slice(0, 20) } : {}),
      ...(typeof o.scorePct === 'number' ? { sampleScorePct: o.scorePct } : {}),
    };
  });
  const ranked = groups.filter(g => !g.fewGames).sort((a, b) => b.earlyBlunderRate - a.earlyBlunderRate || b.games - a.games || cmp(a.opening, b.opening) || cmp(a.color, b.color));
  const few = groups.filter(g => g.fewGames).sort((a, b) => b.games - a.games || cmp(a.opening, b.opening) || cmp(a.color, b.color));
  const sample = (input.profile.sample ?? {}) as Record<string, unknown>;
  return {
    generatedAt: input.at,
    groups: [...ranked, ...few].map((g, i) => ({ rank: g.fewGames ? null : i + 1, ...g })),
    method: `Groups: chess.com opening family and his colour, from the engine pass over his most recent ${sample.games ?? '?'} rapid and blitz games (${sample.from ?? '?'} to ${sample.to ?? '?'}). Ranked by earlyBlunderRate (share of games with a confirmed blunder by move 10) for groups with at least ${MIN_RANKED_GAMES} games; ci95 is a Wilson interval over games (0-1). Groups under ${MIN_RANKED_GAMES} games follow, marked fewGames. cardIds: drill cards from his confirmed mistakes and blunders in moves 1-${EARLY_MOVES} of that group.`,
    archiveContext: input.archiveContext ?? [],
    archiveContextNote: 'Whole-archive scores, shown as context only and not used for ranking: descriptive, without an engine, and mostly within sampling noise (about 50/sqrt(n) points).',
  };
}
