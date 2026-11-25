/**
 * `teach/meta`: the one additive document of version 7.1 (brief m31, section 3.2).
 *
 * It lives in a collection of its own, `teach`, outside `COLLECTIONS` (as `selftest/*` is), so `docs.ts` stays
 * byte-identical and an open version 6 or version 7 page never reads it. A Claude session writes it; the page only
 * reads it and never writes under `teach/`.
 *
 * What it holds, per card id:
 * - `cards`: for a quiet answer, the threat line the page may state (section 3.3) and the facts about it (3.4);
 * - `held`: graded "punish it" cards that leave the graded set because the reply is not clearly the only good one
 *   (3.5).
 * No score, depth, margin or gap is stored: the page prints none of them.
 *
 * Reading (`readTeachMeta`) is tolerant and never throws:
 * - absent (null or undefined): not ok, no issue;
 * - `v` above 1: not ok, no issue, `newer: true` (a later format: this page ignores it without an error line);
 * - a document whose top level does not fit: not ok, with an issue text;
 * - entries are parsed one by one: a bad entry is skipped and counted, the rest are used, and the issue text says how
 *   many were skipped and why the first one was.
 * Every schema is `.passthrough()`, so fields a later session adds are kept. There is no `z.enum` on purpose: an enum
 * issue echoes the value it received, and an issue text must never carry a move or a card id (it goes into
 * `derived/snapshot.docErrors`). Issue paths are array indexes, never ids.
 *
 * Self-contained like `docs.ts`: it imports zod and two shapes from `./docs`, nothing from Node, so it can ship in
 * the page bundle.
 */
import { z } from 'zod';
import { isSegment, uci } from './docs';

export const TEACH_META_PATH = 'teach/meta';
/** The size the builder keeps the document under (UTF-8 JSON bytes). The store's own limit is `MAX_DOC_BYTES`. */
export const TEACH_MAX_BYTES = 150 * 1024;
/** The format this page reads (`v`). */
export const TEACH_FORMAT = 1;
/** The longest threat line an entry may carry, in plies. */
export const TEACH_MAX_PLIES = 8;

export interface TeachThreat {
  /** Card id. */
  id: string;
  /** The answer (`moves[0]`, UCI) this entry was computed for. The page uses the entry only for that answer. */
  a: string;
  /** The SHOWN threat line: 1 to 8 UCI plies from the pass position, solver first (rule 3.3). */
  t: string[];
  /** 'mate' | 'check' | 'capture' | 'promotion' */
  k: string;
  /** `k` other than 'mate': the square, in the CARD position, of the enemy piece the shown line wins net. */
  sq?: string;
  /** 'pinned' | 'undefended': true of the piece on `sq` in the CARD position. */
  r?: string;
  /** With `r` 'pinned': the square of the enemy king it is pinned to, in the card position. */
  pin?: string;
  /** `t[0]` is a legal move in the card position. */
  pre: boolean;
}
export interface TeachHeld {
  id: string;
  /** The answer (`moves[0]`, UCI) the verdict was computed for. */
  a: string;
  /** 'not-unique' | 'not-held' */
  why: string;
  /** UCI: the engine's other near-equal move (with 'not-unique'). */
  alt?: string;
}
export interface TeachMetaDoc {
  v: 1;
  teachVersion: string;
  packVersion: string;
  at: number;
  cards: TeachThreat[];
  held: TeachHeld[];
  /** Reserved, unused. */
  chunks?: string[];
}

const segment = z.string().refine(isSegment, 'not a valid db path segment');
const square = z.string().regex(/^[a-h][1-8]$/);
const word = z.string().min(1).max(40);

/** One entry of `cards`. `k` and `r` are plain strings: a value this page does not know makes it skip that part. */
export const teachThreatSchema = z.object({
  id: segment,
  a: uci,
  t: z.array(uci).min(1).max(TEACH_MAX_PLIES),
  k: word,
  sq: square.optional(),
  r: word.optional(),
  pin: square.optional(),
  pre: z.boolean(),
}).passthrough();
/** One entry of `held`. */
export const teachHeldSchema = z.object({ id: segment, a: uci, why: word, alt: uci.optional() }).passthrough();
/** The document without its entries, which are read one by one. */
export const teachMetaShape = z.object({
  v: z.literal(TEACH_FORMAT),
  teachVersion: segment,
  packVersion: segment,
  at: z.number().finite().nonnegative(),
  cards: z.array(z.unknown()).max(5000),
  held: z.array(z.unknown()).max(2000),
  chunks: z.array(segment).max(50).optional(),
}).passthrough();

export interface TeachRead {
  /** The document was read (format 1, top level valid). False for an absent, newer or unreadable document. */
  ok: boolean;
  teachVersion: string;
  cards: TeachThreat[];
  held: TeachHeld[];
  /** Entries left out: malformed ones, and a second entry for an id already read. */
  skipped: number;
  /** '' when nothing is wrong; else at most 300 characters, with no move and no card id in it. */
  issue: string;
  /** `v` is above 1: a later format. Not an error. */
  newer: boolean;
}

const none = (issue: string, newer = false): TeachRead => ({ ok: false, teachVersion: '', cards: [], held: [], skipped: 0, issue, newer });
const issueText = (prefix: string, issues: readonly z.ZodIssue[]) =>
  issues.slice(0, 3).map(i => `${[prefix, ...i.path].filter(p => p !== '').join('.') || 'document'}: ${i.message}`).join('; ');

/** Tolerant read of `teach/meta` (header comment). Never throws. */
export function readTeachMeta(data: unknown): TeachRead {
  if (data === undefined || data === null) return none('');
  if (typeof data !== 'object' || Array.isArray(data)) return none('document: expected an object');
  const v = (data as { v?: unknown }).v;
  if (typeof v === 'number' && Number.isFinite(v) && v > TEACH_FORMAT) return none('', true);
  const top = teachMetaShape.safeParse(data);
  if (!top.success) return none(issueText('', top.error.issues).slice(0, 300));
  const cards: TeachThreat[] = [], held: TeachHeld[] = [];
  let skipped = 0, first = '';
  const skip = (why: string) => { skipped++; if (!first) first = why; };
  const seen = new Set<string>(), seenHeld = new Set<string>();
  top.data.cards.forEach((raw, i) => {
    const e = teachThreatSchema.safeParse(raw);
    if (!e.success) return skip(issueText(`cards.${i}`, e.error.issues.slice(0, 1)));
    if (seen.has(e.data.id)) return skip(`cards.${i}: a second entry for one card`);
    seen.add(e.data.id);
    cards.push(e.data as TeachThreat);
  });
  top.data.held.forEach((raw, i) => {
    const e = teachHeldSchema.safeParse(raw);
    if (!e.success) return skip(issueText(`held.${i}`, e.error.issues.slice(0, 1)));
    if (seenHeld.has(e.data.id)) return skip(`held.${i}: a second entry for one card`);
    seenHeld.add(e.data.id);
    held.push(e.data as TeachHeld);
  });
  const issue = skipped ? `${skipped} ${skipped === 1 ? 'entry' : 'entries'} skipped: ${first}`.slice(0, 300) : '';
  return { ok: true, teachVersion: top.data.teachVersion, cards, held, skipped, issue, newer: false };
}
