/**
 * The pack loaded from the database, in the shape the Site app's PersonalPackSummary reads.
 * Full check first (`readPack`); if the db pack does not pass it (for example a meta without file
 * hashes, or B3's `pack-<gameId>:<ply>` ids), the summary still shows when the weakness profile itself is
 * valid, with the stalemate study items whose moves check out.
 */
const str = (x: unknown) => typeof x === 'string' && x.length > 0;
function studyOk(item: Record<string, unknown>): boolean {
  if (!['id', 'fen', 'playedUci', 'playedSan', 'bestUci', 'bestSan', 'date', 'timeClass', 'ownerColor'].every(k => str(item[k]))) return false;
  try {
    const after = fenAfter(item.fen as string, item.playedUci as string);
    return !!after && new Chess(after).isStalemate() && !!fenAfter(item.fen as string, item.bestUci as string);
  } catch { return false; }
}
import { Chess } from 'chess.js';
import { fenAfter, PACK_KIND, readPack, weaknessProfile, type PersonalPack } from '@/lib/personal-pack';
import type { LoadedPack } from './model';

export function packForSummary(loaded: LoadedPack | null): PersonalPack | null {
  if (!loaded) return null;
  const meta = loaded.meta as typeof loaded.meta & { source?: unknown };
  const candidate = {
    kind: PACK_KIND, schemaVersion: 1, installed: true,
    importedAt: typeof meta.importedAt === 'number' ? new Date(meta.importedAt).toISOString() : String(meta.importedAt),
    source: meta.source ?? { files: {} }, profile: meta.profile, priors: meta.priors,
    cards: loaded.cards, study: loaded.study, counts: meta.counts,
  };
  try { const full = readPack(candidate); if (full) return full; } catch { /* fall through to the relaxed view */ }
  const profile = weaknessProfile.safeParse(meta.profile);
  if (!profile.success) return null;
  return { ...candidate, profile: profile.data, study: loaded.study.filter(studyOk) } as unknown as PersonalPack;
}
