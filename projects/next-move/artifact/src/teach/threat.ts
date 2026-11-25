/**
 * Version 7.1, item A (brief m31, sections 4.1 and 4.3): what a quiet answer threatens.
 *
 * Pure and synchronous; never throws. The builder (`src/importers/teachDocs.ts`), the sweeps and the page run this
 * same code, so a sentence in the builder's `sentences.private.tsv` is the sentence the page prints.
 *
 * Terms. F = the card position. a = the answer (`moves[0]`). P = the pass position: F after a, with the move handed
 * back to the solver (`passFen`). t = the stored threat line from P, solver first (`TeachThreat.t`).
 *
 * Who decides what:
 * - WHETHER a card has a threat the page may state is decided offline, by the frozen rule (gates T0 to T5, at two
 *   engine depths) in the builder. The page never searches and never re-judges that rule.
 * - The page reads the stored entry with its own eyes before it uses it (`threatFacts`): the entry must be for this
 *   answer, the answer must be quiet, the line must replay legally from P, and the page's own reading of the replay
 *   (`readThreat`: kind and "already legal on the card") must agree with the stored `k` and `pre`. Anything else gives
 *   null, and the card behaves as in version 7.
 * - The target (`sq`) and its reason (`r`, `pin`) are stored facts that the page checks on F before it prints them:
 *   `sq` must hold an enemy piece other than the king and must not be a square of the answer; `pin` must hold the
 *   enemy king; and the reason must be true on F (the piece really is pinned to that king, or really has no defender).
 *   A part that fails is dropped alone; the rest of the entry is used.
 *
 * Cost: `threatFacts` replays at most 8 plies with chess.js and narrates nothing, so the hint path costs what it cost
 * in version 7. `threatSay` narrates the line once (at most 8 plies) and is called only for a finished card or a
 * reading list. Both are cached per card object.
 *
 * Words (table 4.3). "prepares" when t[0] is already legal on the card (`pre`), "threatens" when it is not; a mate
 * always "threatens". Hints (H1, H2) never contain the answer's SAN, the SAN of t[0], the answer's piece or squares,
 * or the from-square of t[0]: they name enemy pieces and the enemy king only.
 *
 * Imports: `hints.ts` (a type), `narrate.ts`, `values.ts` and the contract types. Nothing from Node and nothing from
 * `src/importers/`, so it can ship in the page bundle. `hints.ts` and `punish.ts` do not import this file.
 */
import { Chess, type Move, type Square } from 'chess.js';
import type { TeachHeld, TeachThreat } from '../contract/teachDocs';
import type { Hint } from './hints';
import { narrateLine, playUci, uciOf, type NarratedLine } from './narrate';
import { PIECE_NAME, type PieceType, type Side } from './values';

/** Version 7's last-resort idea hint (`hints.ts`, rule `quiet`). Pinned by a test against `buildHints`. */
export const QUIET_BARE = 'The right move is a quiet one: no capture and no check.';
/** The longest threat line the page replays, in plies. */
export const THREAT_MAX_PLIES = 8;

export type ThreatKind = 'mate' | 'check' | 'capture' | 'promotion';
/** Any card with a position, its moves and (optionally) its joined entry fits: a `TrainerItem`, a pack chunk card. */
export interface ThreatCard { fen: string; moves: readonly string[]; kind?: string; pack?: object | null; teach?: TeachThreat | null }
export interface ThreatFacts {
  /** SAN of the answer on the card, and of t[0] in the pass position. */
  answerSan: string; firstSan: string;
  passFen: string;
  /** The shown line as replayed (UCI). */
  line: string[];
  k: ThreatKind; pre: boolean;
  /** The enemy king for 'mate', else the piece on `sq`. `piece` is the chess.js letter (p, n, b, r, q, k); all read on the card position. */
  target?: { square: string; piece: string; colour: 'w' | 'b' };
  /** True of the target on the card position. `to` is the square of the king it is pinned to. */
  reason?: { kind: 'pinned'; to: string } | { kind: 'undefended' };
  solver: 'White' | 'Black'; opponent: 'White' | 'Black';
}
export interface ThreatSay {
  /** P: the paragraph after a mistake card. */
  paragraph: string;
  /** L: the sentences a punish lesson adds after its second sentence (`PunishLessonOptions.threat`). */
  clause: { full: string; fullNoClosing: string; short: string };
  /** V: the threat viewer. No verdict and no figure; closed at first. */
  viewer: { fen: string; line: string[]; title: string; toggle: string; intro: string };
}

const SQUARE_RE = /^[a-h][1-8]$/;
const other = (c: Side): Side => (c === 'w' ? 'b' : 'w');
const sideName = (c: Side): 'White' | 'Black' => (c === 'w' ? 'White' : 'Black');
const fileOf = (s: string) => s.charCodeAt(0) - 97;
const rankOf = (s: string) => Number(s[1]) - 1;
const squareAt = (f: number, r: number) => `${String.fromCharCode(97 + f)}${r + 1}` as Square;

function load(fen: string): Chess | null {
  if (typeof fen !== 'string') return null;
  try { return new Chess(fen); } catch { return null; }
}

/** The answer played on the card position, and whether it is quiet: no capture (en passant included), no promotion, no check. */
function playAnswer(fen: string, answerUci: string): { after: Chess; move: Move; quiet: boolean } | null {
  const after = load(fen);
  const move = after ? playUci(after, answerUci) : null;
  if (!after || !move) return null;
  return { after, move, quiet: !move.captured && !move.promotion && !after.isCheck() };
}

/** Every square the answer touches: from and to, and for castling the rook's two squares as well. */
function answerSquares(move: Move): string[] {
  const out = [move.from as string, move.to as string];
  if (move.isKingsideCastle() || move.isQueensideCastle()) {
    const r = move.from[1], king = move.isKingsideCastle();
    out.push(`${king ? 'h' : 'a'}${r}`, `${king ? 'f' : 'd'}${r}`);
  }
  return out;
}

/**
 * The pass position P: the card position after the answer, with the move handed back to the solver. En passant is
 * cleared, the halfmove clock goes up by one, and the move number goes up by one when the solver is White (the side
 * that passes is then Black), so a viewer numbers the moves as a game would.
 * Null unless the answer is legal and quiet (no capture, no promotion, no check) and chess.js accepts the result.
 */
export function passFen(fen: string, answerUci: string): string | null {
  try {
    const a = playAnswer(fen, answerUci);
    if (!a || !a.quiet) return null;
    const f = a.after.fen().split(' ');
    const half = Number(f[4]), full = Number(f[5]);
    if (f.length !== 6 || !Number.isInteger(half) || !Number.isInteger(full)) return null;
    const solver = a.move.color as Side;
    const out = [f[0], solver, f[2], '-', String(half + 1), String(full + (solver === 'w' ? 1 : 0))].join(' ');
    return load(out) ? out : null;
  } catch {
    return null;
  }
}

/** A line narrated as a line viewer narrates it (`components/LineViewer.tsx` `lineNarration`, with no verdict and no omitted move). */
export function narrateAsViewer(fen: string, line: readonly string[]): NarratedLine {
  return narrateLine(fen, line, { maxPlies: line.length, nameMate: false, verdict: null, omit: null, noChangeSentence: false });
}

/** The page's own reading of a threat line. */
export interface ThreatReading {
  passFen: string;
  solver: Side;
  answerSan: string;
  /** Every square the answer touches (`answerSquares`). */
  answerSquares: string[];
  /** t as replayed from P: UCI and SAN. */
  line: string[]; san: string[];
  /** The from-square of t[0]. */
  firstFrom: string;
  /** 'mate' when the line ends in mate by the solver; else 'check' when t[0] gives check; else 'capture' when t[0] captures; else 'promotion'. */
  k: ThreatKind;
  /** t[0] is a legal move in the card position. */
  pre: boolean;
}

/**
 * Replays `t` (1 to 8 plies) from the pass position of `answerUci` on `fen` and reads its kind (3.4). Null when the
 * answer is not quiet, a ply is not legal, or t[0] is neither a capture, a check nor a promotion and the line is not
 * mate by the solver. No narration.
 */
export function readThreat(fen: string, answerUci: string, t: readonly string[]): ThreatReading | null {
  try {
    if (!Array.isArray(t) || t.length < 1 || t.length > THREAT_MAX_PLIES) return null;
    const a = playAnswer(fen, answerUci);
    const pass = a && a.quiet ? passFen(fen, answerUci) : null;
    const board = pass ? load(pass) : null;
    if (!a || !pass || !board) return null;
    const solver = a.move.color as Side;
    const line: string[] = [], san: string[] = [];
    let first: Move | null = null, firstChecks = false;
    for (const u of t) {
      const mv = playUci(board, u);
      if (!mv) return null;
      if (!first) { first = mv; firstChecks = board.isCheck(); }
      line.push(uciOf(mv)); san.push(mv.san);
    }
    if (!first) return null;
    const mate = board.isCheckmate() && board.turn() !== solver;
    const k: ThreatKind | null = mate ? 'mate' : firstChecks ? 'check' : first.captured ? 'capture' : first.promotion ? 'promotion' : null;
    if (!k) return null;
    const card = load(fen);
    const pre = !!card && !!playUci(card, line[0]);
    return { passFen: pass, solver, answerSan: a.move.san, answerSquares: answerSquares(a.move), line, san, firstFrom: first.from, k, pre };
  } catch {
    return null;
  }
}

/**
 * The square of its own king when the piece on `square` is pinned to it: king and piece on one rank, file or
 * diagonal with nothing between them, and the first piece beyond the piece is an enemy bishop, rook or queen that
 * moves along that line. The narrator's own definition of an absolute pin (`narrate.ts` `findPins`), read from the
 * pinned piece. Null otherwise.
 */
function pinnedTo(board: Chess, square: string): string | null {
  const p = board.get(square as Square);
  if (!p || p.type === 'k') return null;
  const king = board.findPiece({ type: 'k', color: p.color })[0];
  if (!king) return null;
  const df = fileOf(square) - fileOf(king), dr = rankOf(square) - rankOf(king);
  if (!(df === 0 || dr === 0 || Math.abs(df) === Math.abs(dr))) return null;
  const sf = Math.sign(df), sr = Math.sign(dr), straight = sf === 0 || sr === 0;
  let f = fileOf(king) + sf, r = rankOf(king) + sr;
  for (; f !== fileOf(square) || r !== rankOf(square); f += sf, r += sr) if (board.get(squareAt(f, r))) return null;
  for (f += sf, r += sr; f >= 0 && f < 8 && r >= 0 && r < 8; f += sf, r += sr) {
    const q = board.get(squareAt(f, r));
    if (q) return q.color !== p.color && (q.type === 'q' || q.type === (straight ? 'r' : 'b')) ? king : null;
  }
  return null;
}
/** No piece of its own side defends the piece on `square` (chess.js `attackers`, as the narrator reads "defended"). */
const undefended = (board: Chess, square: string, owner: Side) => board.attackers(square as Square, owner).length === 0;

/**
 * What the position `fen` says about the piece on `square` (3.4), for the builder: 'pinned' (to its own king, with
 * that king's square) first; else 'undefended' when no piece of its own side defends it; else null. Read on the card
 * position, never on the pass position, so a pin the answer itself creates is not a reason. Never an attacker count.
 */
export function targetReason(fen: string, square: string): { r: 'pinned'; pin: string } | { r: 'undefended' } | null {
  try {
    const board = load(fen);
    const p = board && SQUARE_RE.test(square) ? board.get(square as Square) : undefined;
    if (!board || !p || p.type === 'k') return null;
    const king = pinnedTo(board, square);
    if (king) return { r: 'pinned', pin: king };
    return undefended(board, square, p.color as Side) ? { r: 'undefended' } : null;
  } catch {
    return null;
  }
}

function factsOf(card: ThreatCard): ThreatFacts | null {
  const e = card.teach;
  const answer = Array.isArray(card.moves) ? card.moves[0] : undefined;
  if (!e || typeof e !== 'object' || typeof answer !== 'string' || e.a !== answer || typeof e.pre !== 'boolean') return null;
  const read = readThreat(card.fen, answer, e.t);
  if (!read || read.k !== e.k || read.pre !== e.pre) return null;
  const start = load(card.fen);
  if (!start) return null;
  const foe = other(read.solver);
  let target: ThreatFacts['target'], reason: ThreatFacts['reason'];
  if (read.k === 'mate') {
    const king = start.findPiece({ type: 'k', color: foe })[0];
    if (king) target = { square: king, piece: 'k', colour: foe };
  } else if (typeof e.sq === 'string' && SQUARE_RE.test(e.sq) && !read.answerSquares.includes(e.sq) && e.sq !== read.firstFrom) {
    const p = start.get(e.sq as Square);
    if (p && p.color === foe && p.type !== 'k') {
      target = { square: e.sq, piece: p.type, colour: foe };
      if (e.r === 'pinned' && typeof e.pin === 'string' && SQUARE_RE.test(e.pin)) {
        const k = start.get(e.pin as Square);
        if (k && k.type === 'k' && k.color === foe && pinnedTo(start, e.sq) === e.pin) reason = { kind: 'pinned', to: e.pin };
      } else if (e.r === 'undefended' && undefended(start, e.sq, foe)) {
        reason = { kind: 'undefended' };
      }
    }
  }
  return {
    answerSan: read.answerSan, firstSan: read.san[0], passFen: read.passFen, line: read.line, k: read.k, pre: read.pre,
    ...(target ? { target } : {}), ...(reason ? { reason } : {}), solver: sideName(read.solver), opponent: sideName(foe),
  };
}

const FACTS = new WeakMap<object, ThreatFacts | null>();
/**
 * The checked facts of a card's stored threat (header comment), or null: behave as version 7. Lazy: nothing runs
 * when the pools are built. Cached per card object, so a card whose `teach` changes needs a new object (the pools
 * make one).
 */
export function threatFacts(card: ThreatCard): ThreatFacts | null {
  if (!card || typeof card !== 'object') return null;
  const hit = FACTS.get(card);
  if (hit !== undefined) return hit;
  let facts: ThreatFacts | null = null;
  try { facts = factsOf(card); } catch { facts = null; }
  FACTS.set(card, facts);
  return facts;
}

/** H1: the sentence that takes the place of `QUIET_BARE`. It names no piece, square or move. */
function ideaText(f: ThreatFacts): string {
  if (f.k === 'mate') return 'The right move is a quiet one, but it threatens checkmate.';
  if (f.pre) {
    const what = f.k === 'check' ? 'a check that wins material' : f.k === 'capture' ? 'a capture that wins material' : 'the promotion of a pawn';
    return `The right move is a quiet one. It prepares ${what}.`;
  }
  const what = f.k === 'check' ? 'a check that wins material' : f.k === 'capture' ? 'a capture that wins material' : 'to promote a pawn';
  return `The right move is a quiet one, but it threatens ${what}.`;
}

/** H2: the target rung, or null when the card keeps version 7's rung 2 (no target, or a promotion). */
function targetText(f: ThreatFacts, punish: boolean): string | null {
  const t = f.target;
  if (!t) return null;
  const colour = t.colour === 'w' ? 'white' : 'black';
  if (f.k === 'mate') return `Target: the ${colour} king on ${t.square}. The right move threatens checkmate.`;
  if (f.k !== 'check' && f.k !== 'capture') return null;
  // Pieces are named as version 7 names them: with the colour on a punish card, without it on a mistake card.
  const piece = `the ${punish ? `${colour} ` : ''}${PIECE_NAME[t.piece as PieceType]} on ${t.square}`;
  const why = !f.reason ? '' : f.reason.kind === 'pinned' ? ` It is pinned to the king on ${f.reason.to}.` : ' It is undefended.';
  const verb = f.pre ? 'prepares' : 'threatens';
  return f.k === 'check'
    ? `Target: ${piece}.${why} The right move ${verb} a check that wins it.${f.pre ? ' Giving the check at once is not the move.' : ''}`
    : `Target: ${piece}.${why} The right move ${verb} to win it.${f.pre ? ' Playing the capture at once is not the move.' : ''}`;
}

/**
 * H1 and H2 on a hint ladder (table 4.3). Never adds or removes a rung, and never touches rungs 3 and 4.
 * With null facts, or when no rung-1 text ends with `QUIET_BARE`, the ladder comes back unchanged (a copy of the list
 * with the same rung objects). Else rung 1 keeps its head and gets the threat sentence in place of `QUIET_BARE`, and,
 * when the facts carry a target (and the kind is mate, check or capture), rung 2 becomes the target rung: its text,
 * `square` = the target's square, no arrow.
 * The caller applies it only at step 0 of the card, with `fen` the card's position (`hintLadderFor`).
 * Applying it twice changes nothing more: the new rung 1 no longer ends with `QUIET_BARE`.
 */
export function applyThreatHints(ladder: readonly Hint[], facts: ThreatFacts | null, punish: boolean): Hint[] {
  const out = Array.isArray(ladder) ? [...ladder] : [];
  if (!facts) return out;
  const one = out.findIndex(h => !!h && h.level === 1 && typeof h.text === 'string' && h.text.endsWith(QUIET_BARE));
  if (one < 0) return out;
  out[one] = { ...out[one], text: `${out[one].text.slice(0, -QUIET_BARE.length)}${ideaText(facts)}` };
  const text = targetText(facts, punish);
  const two = out.findIndex(h => !!h && h.level === 2);
  if (text && facts.target && two >= 0) out[two] = { level: 2, text, square: facts.target.square };
  return out;
}

function sayOf(card: ThreatCard): ThreatSay | null {
  const f = threatFacts(card);
  if (!f) return null;
  const n = narrateAsViewer(f.passFen, f.line);
  if (n.plies.length !== f.line.length) return null;
  const mate = f.k === 'mate';
  const verb = !mate && f.pre ? 'prepares' : 'threatens';
  const frame = `If ${f.opponent} made no move in reply: ${n.plies.map(p => p.san).join(' ')}.`;
  const why = !mate && f.target && f.reason
    ? ` The ${PIECE_NAME[f.target.piece as PieceType]} on ${f.target.square} is ${f.reason.kind === 'pinned' ? `pinned to the king on ${f.reason.to}` : 'undefended'}.`
    : '';
  const head = (subject: string) => (mate ? `${subject} threatens checkmate.` : `${subject} ${verb} ${f.firstSan}.`);
  const body = (subject: string, closing: boolean) => `${head(subject)}${why} ${frame}${!mate && closing && n.summary ? ` ${n.summary}` : ''}`;
  return {
    paragraph: body(f.answerSan, true),
    clause: { full: body('It', true), fullNoClosing: body('It', false), short: head('It') },
    viewer: {
      fen: f.passFen, line: [...f.line], title: `What ${f.answerSan} ${verb}`, toggle: `Show what it ${verb}`,
      intro: `${f.answerSan} has been played. If ${f.opponent} made no move in reply, this would follow.`,
    },
  };
}

const SAY = new WeakMap<object, ThreatSay | null>();
/**
 * P, L and V for a card with a stored threat (table 4.3), or null: show nothing new. Narrates the shown line once (at
 * most 8 plies), so call it only for a finished card or a reading list. Cached per card object.
 * `{closing}` is the narrator's closing sentence for the shown line from the pass position, as the threat viewer
 * prints it; a mate has none in the paragraph.
 */
export function threatSay(card: ThreatCard): ThreatSay | null {
  if (!card || typeof card !== 'object') return null;
  const hit = SAY.get(card);
  if (hit !== undefined) return hit;
  let say: ThreatSay | null = null;
  try { say = sayOf(card); } catch { say = null; }
  SAY.set(card, say);
  return say;
}

/**
 * "The engine rates {alt SAN} almost as highly." (brief 4.5), for a card held as 'not-unique': its held row must be
 * for this answer and name another legal move. Null otherwise.
 */
export function almostAsHighly(card: { fen: string; moves: readonly string[]; teachHeld?: TeachHeld | null }): string | null {
  try {
    const h = card?.teachHeld;
    const answer = Array.isArray(card?.moves) ? card.moves[0] : undefined;
    if (!h || typeof h !== 'object' || h.why !== 'not-unique' || typeof h.alt !== 'string' || h.a !== answer) return null;
    const board = load(card.fen);
    const own = board ? playUci(board, h.a) : null;
    if (!board || !own) return null;
    board.undo();
    const alt = playUci(board, h.alt);
    return alt && uciOf(alt) !== uciOf(own) ? `The engine rates ${alt.san} almost as highly.` : null;
  } catch {
    return null;
  }
}
