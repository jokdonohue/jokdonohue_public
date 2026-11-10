/**
 * M2 data documents (plan section 10 items b, e, g), built on top of the M1 pack output:
 * `pack/<ver>-safe-NN`, `openings/accidents`, `transfer/history`, and `pack/meta` rewritten to list the safe
 * chunks (same packVersion, so the M1 chunks stay valid). Pure; `scripts/pack-to-docs.mjs --m2` does the IO.
 */
import { paths } from '../contract/docs';
import { validateDoc, type PackOutput } from './packDocs';
import { buildSafeCards, safeChunks, type GameInfo, type JudgedMove, type RowLines } from './safeDocs';
import { buildOpeningAccidents, parseArchiveContext, type ArchiveRow, type OpeningRow } from './openingsDocs';
import { appendTransferPoint, transferPoint } from './transferDocs';

/** producer row id -> card id, for drill cards and punish cards (canonical row and every alias). */
export function rowToCardMaps(pack: PackOutput) {
  const cardFor = new Map<string, string>(), punishFor = new Map<string, string>();
  for (const d of pack.docs) {
    if (d.path === 'pack/meta') continue;
    for (const c of (d.data.cards as Array<{ id: string; kind?: string; aliases?: string[]; pack?: { rowId?: string } }>) ?? []) {
      const target = c.kind === 'punish' ? punishFor : c.kind === 'safe' || c.kind === 'unsafe' ? null : cardFor;
      if (!target) continue;
      const rowIds = [c.pack?.rowId, ...(c.aliases ?? []).map(a => a.slice(a.indexOf(':') + 1))].filter((x): x is string => !!x);
      for (const r of rowIds) if (!target.has(r)) target.set(r, c.id);
    }
  }
  return { cardFor, punishFor };
}

export function buildM2Docs(input: {
  pack: PackOutput;
  profile: Record<string, unknown>;
  moves: JudgedMove[];
  games: Map<string, GameInfo>;
  rowLines: Map<string, RowLines>;
  openingRows: OpeningRow[];
  gameFamily: Map<string, { family: string; color: 'w' | 'b' }>;
  summaryMd?: string | null;
  /** Which whole-archive rows to carry as context (generation input; none when absent). */
  archiveRows?: readonly ArchiveRow[] | null;
  existingTransfer?: { points?: Array<Record<string, unknown>> } | null;
  perHalf?: number;
  at: string;
}) {
  const { pack } = input;
  const { cardFor, punishFor } = rowToCardMaps(pack);
  const familiar = new Set([...cardFor.keys(), ...punishFor.keys()]);
  const safe = buildSafeCards({ moves: input.moves, games: input.games, rows: input.rowLines, perHalf: input.perHalf, familiar });
  const chunks = safeChunks(pack.packVersion, safe.cards);
  const openings = buildOpeningAccidents({
    profile: input.profile, rows: input.openingRows, gameFamily: input.gameFamily, cardFor, punishFor,
    archiveContext: input.summaryMd && input.archiveRows?.length ? parseArchiveContext(input.summaryMd, input.archiveRows) : [], at: input.at,
  });
  const transfer = appendTransferPoint(input.existingTransfer ?? null, transferPoint(input.profile, { packVersion: pack.packVersion, at: input.at }));
  const m1Meta = pack.docs[pack.docs.length - 1].data as Record<string, unknown> & { chunks: Record<string, unknown>; counts: Record<string, number> };
  const meta = {
    ...m1Meta,
    counts: { ...m1Meta.counts, ...safe.counts, chunksSafe: chunks.length },
    chunks: { ...m1Meta.chunks, safe: chunks.map(c => c.id) },
  };
  const docs = [
    ...chunks.map(c => ({ path: c.path, data: c.data })),
    { path: paths.openingAccidents(), data: openings },
    { path: paths.transferHistory(), data: transfer },
    { path: paths.packMeta(), data: meta },
  ];
  for (const d of docs) validateDoc(d.path, d.data);
  return { docs, counts: { ...safe.counts, chunksSafe: chunks.length, openingGroups: (openings.groups as unknown[]).length, archiveContext: (openings.archiveContext as unknown[]).length, transferPoints: (transfer.points as unknown[]).length } };
}
