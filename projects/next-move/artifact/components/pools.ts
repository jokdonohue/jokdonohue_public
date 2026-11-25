/**
 * Practice items and pools for the artifact Trainer. Every item carries the `source` it is recorded
 * under; pools are keyed by the plan's mix sources (`pack` also holds punish cards and Site-imported
 * personal positions).
 *
 * M3 punish curation (brief L5, section 7, 9.6 stage a; page-side and reversible, the pack is not rewritten):
 * `classifyPunish` sorts each punish card by the solver's Win% after his game move. Only class `punish` is served
 * graded. `small-edge` cards go to the "punish it" reading list (`smallEdge`, shown by PunishStudy with their
 * lesson); `missed-win` cards are not shown (`missedWin`; their sibling mistake card teaches the missed move).
 * Held cards are in none of `all`, `own`, `bySource` or `byId`, so nothing schedules, counts or serves them.
 *
 * Version 7.1 (brief m31, 4.2), with the optional input `teach` (the document `teach/meta` as the model loads it):
 * - a pack or punish card whose entry was computed for the card's own move (`entry.a === moves[0]`) carries it as
 *   `teach`; an entry for another move is stale and is not joined;
 * - a punish card of class `punish` whose `held` row is for the card's own move leaves the graded set: it goes to
 *   `notUnique` (`why` 'not-unique', listed for reading) or `notHeld` (`why` 'not-held', listed nowhere), carries the
 *   row as `teachHeld`, and is in none of `all`, `own`, `bySource` or `byId`. A row for another move, or with a `why`
 *   this page does not know, is ignored and the card stays graded.
 * `punishClasses` keeps its three keys and counts every card by its Win% class, as in version 7. Without `teach`
 * every pool is exactly version 7's.
 */
import type { AttemptSource, DrillCard, PackCardDoc, PuzzleDoc } from '@/src/contract/docs';
import type { MixKey } from './daily';
import type { DrillSetView, LoadedPack, LoadedTeach } from './model';
import type { TeachHeld, TeachThreat } from '@/src/contract/teachDocs';
import { NEW_PROFILE_ATTEMPTS } from '@/lib/practice';
import { classifyPunish, type PunishClass } from '@/src/teach/punish';

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
  /** Version 7.1: the card's entry in `teach/meta`, joined only when it was computed for this card's move. */
  teach?: TeachThreat;
  /** Version 7.1: the row that holds this punish card out of the graded set (`Pools.notUnique`, `Pools.notHeld`). */
  teachHeld?: TeachHeld;
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
  /** Own-game positions: personal, pack and graded punish cards. */
  own: TrainerItem[];
  byId: Map<string, TrainerItem>;
  /** M3: punish cards of class `small-edge`, for the reading list (never served graded). */
  smallEdge: TrainerItem[];
  /** M3: punish cards of class `missed-win`, not shown. */
  missedWin: TrainerItem[];
  /** M3: how the pack's punish cards were classed (`punish` = served graded). */
  punishClasses: Record<PunishClass, number>;
  /** Version 7.1: class `punish` cards held as 'not-unique' (more than one good reply), for the reading list. */
  notUnique: TrainerItem[];
  /** Version 7.1: class `punish` cards held as 'not-held' (the engine's best reply is another move). Not shown. */
  notHeld: TrainerItem[];
}

export function buildPools(input: {
  bank: readonly Base[];
  endgames: readonly Base[];
  pack: LoadedPack | null;
  personal: readonly PuzzleDoc[];
  drills: readonly DrillSetView[];
  /** Version 7.1: `teach/meta` as loaded, or null / absent (then every pool is version 7's). */
  teach?: LoadedTeach | null;
}): Pools {
  const byId = new Map<string, TrainerItem>();
  const add = (list: TrainerItem[]) => list.filter(p => (byId.has(p.id) ? false : (byId.set(p.id, p), true)));
  const teach = input.teach ?? null;
  // Version 7.1: an entry is joined only when it was computed for the card's own move (a stale one is ignored).
  const joined = (p: TrainerItem): TrainerItem => {
    const entry = teach?.byId.get(p.id);
    return entry && entry.a === p.moves[0] ? { ...p, teach: entry } : p;
  };
  // Pack and punish cards first (R-PGN-2): when a Claude refresh issues the id a page-made personal card already
  // uses, the pack card wins and the attempt history (keyed by id) carries over.
  const packCards = add((input.pack?.cards ?? []).map((c: PackCardDoc) => joined(item(c as Base, 'pack'))));
  const punishAll = (input.pack?.punish ?? []).map((c: PackCardDoc) => joined(item({ ...(c as Base), kind: 'punish' }, 'pack')));
  // M3 curation: only class `punish` is graded; the other two are held out of every pool.
  const classed: Record<PunishClass, TrainerItem[]> = { punish: [], 'small-edge': [], 'missed-win': [] };
  for (const p of punishAll) classed[classifyPunish(p)].push(p);
  // Version 7.1 (item D): a class `punish` card with a held row for its own move leaves the graded set.
  const notUnique: TrainerItem[] = [], notHeld: TrainerItem[] = [], graded: TrainerItem[] = [];
  for (const p of classed.punish) {
    const row = teach?.held.get(p.id);
    // An id a pack card already took is dropped by `add` below, as in version 7; it is never listed as held.
    const list = !row || row.a !== p.moves[0] || byId.has(p.id) ? null : row.why === 'not-unique' ? notUnique : row.why === 'not-held' ? notHeld : null;
    if (list && row) list.push({ ...p, teachHeld: row }); else graded.push(p);
  }
  const punish = add(graded);
  // R-PGN-4, narrowed in the fix pass (P2-2): a page-made personal card (`origin: "page"`) whose position a pack card
  // already covers is not practised twice. Site-backup positions keep their own ids and history, as in version 4.
  // Every punish card counts here, held or not, so this rule is the same as before the curation.
  const packPositions = new Set([...packCards, ...punishAll].map(p => positionKey(p.fen)));
  const personal = add(input.personal.filter(p => !(p.origin === 'page' && packPositions.has(positionKey(p.fen)))).map(p => item(p, 'personal')));
  const agent = add(input.drills.flatMap(set => set.cards.map((c: DrillCard) => item({ ...c, title: set.title }, 'agent'))));
  const endgame = add(input.endgames.map(p => item(p, 'endgame')));
  const bank = add(input.bank.map(p => item(p, 'bank')));
  const own = [...personal, ...packCards, ...punish];
  return {
    bySource: { bank, pack: own, endgame, agent }, all: [...byId.values()], own, byId,
    smallEdge: classed['small-edge'], missedWin: classed['missed-win'],
    punishClasses: { punish: classed.punish.length, 'small-edge': classed['small-edge'].length, 'missed-win': classed['missed-win'].length },
    notUnique, notHeld,
  };
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
