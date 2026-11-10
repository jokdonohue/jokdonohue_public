/**
 * Practice items and pools for the artifact Trainer. Every item carries the `source` it is recorded
 * under; pools are keyed by the plan's mix sources (`pack` also holds punish cards and Site-imported
 * personal positions).
 */
import type { AttemptSource, DrillCard, PackCardDoc, PuzzleDoc } from '@/src/contract/docs';
import type { MixKey } from './daily';
import type { DrillSetView, LoadedPack } from './model';
import { NEW_PROFILE_ATTEMPTS } from '@/lib/practice';

export interface TrainerItem {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  themes: string[];
  gameUrl: string;
  title?: string;
  explanation?: string;
  /** Pack detail block (lib/personal-pack PackDetail), when the item came from his games. */
  pack?: Record<string, unknown> & { playedUci?: string; refutationPvUci?: string[]; sets?: string[] };
  /** Pack card kind (`punish` for item a). */
  kind?: string;
  source: AttemptSource;
}

type Base = { id: string; fen: string; moves: string[]; rating: number; themes: string[]; gameUrl?: string; title?: string; explanation?: string };
const item = (p: Base & { pack?: unknown; kind?: string }, source: AttemptSource): TrainerItem => ({
  id: p.id, fen: p.fen, moves: [...p.moves], rating: p.rating, themes: [...p.themes], gameUrl: p.gameUrl ?? '',
  ...(p.title ? { title: p.title } : {}), ...(p.explanation ? { explanation: p.explanation } : {}),
  ...(p.pack && typeof p.pack === 'object' ? { pack: p.pack as TrainerItem['pack'] } : {}), ...(p.kind ? { kind: p.kind } : {}), source,
});

/** Board, side to move, castling and en passant: the first four FEN fields. */
export const positionKey = (fen: string) => fen.trim().split(/\s+/).slice(0, 4).join(' ');

/** Item a: a punish card is played from the opponent's side. */
export const isPunish = (p: { kind?: string } | null | undefined) => p?.kind === 'punish';

export interface Pools {
  bySource: Record<MixKey, TrainerItem[]>;
  /** Everything servable, first occurrence of each id. */
  all: TrainerItem[];
  /** Own-game positions: personal, pack and punish cards. */
  own: TrainerItem[];
  byId: Map<string, TrainerItem>;
}

export function buildPools(input: {
  bank: readonly Base[];
  endgames: readonly Base[];
  pack: LoadedPack | null;
  personal: readonly PuzzleDoc[];
  drills: readonly DrillSetView[];
}): Pools {
  const byId = new Map<string, TrainerItem>();
  const add = (list: TrainerItem[]) => list.filter(p => (byId.has(p.id) ? false : (byId.set(p.id, p), true)));
  // Pack and punish cards first (R-PGN-2): when a Claude refresh issues the id a page-made personal card already
  // uses, the pack card wins and the attempt history (keyed by id) carries over.
  const packCards = add((input.pack?.cards ?? []).map((c: PackCardDoc) => item(c as Base, 'pack')));
  const punish = add((input.pack?.punish ?? []).map((c: PackCardDoc) => item({ ...(c as Base), kind: 'punish' }, 'pack')));
  // R-PGN-4, narrowed in the fix pass (P2-2): a page-made personal card (`origin: "page"`) whose position a pack card
  // already covers is not practised twice. Site-backup positions keep their own ids and history, as in version 4.
  const packPositions = new Set([...packCards, ...punish].map(p => positionKey(p.fen)));
  const personal = add(input.personal.filter(p => !(p.origin === 'page' && packPositions.has(positionKey(p.fen)))).map(p => item(p, 'personal')));
  const agent = add(input.drills.flatMap(set => set.cards.map((c: DrillCard) => item({ ...c, title: set.title }, 'agent'))));
  const endgame = add(input.endgames.map(p => item(p, 'endgame')));
  const bank = add(input.bank.map(p => item(p, 'bank')));
  const own = [...personal, ...packCards, ...punish];
  return { bySource: { bank, pack: own, endgame, agent }, all: [...byId.values()], own, byId };
}


/**
 * The app's own rule when no plan is in force: bank, endgame drills, agent sets and personal positions,
 * with every fourth attempt reserved for own-game positions (a transparent heuristic carried over from
 * the Site app), and no endgame drill for a brand-new profile.
 */
export function fallbackPool(bySource: Record<MixKey, TrainerItem[]>, attemptCount: number): TrainerItem[] {
  const own = bySource.pack;
  if (own.length && attemptCount % 4 === 3) return own;
  const personal = own.filter(p => p.source === 'personal');
  let mixed = [...personal, ...bySource.agent, ...bySource.bank, ...bySource.endgame];
  if (attemptCount < NEW_PROFILE_ATTEMPTS && mixed.some(p => p.source !== 'endgame')) mixed = mixed.filter(p => p.source !== 'endgame');
  return mixed.length ? mixed : own;
}
