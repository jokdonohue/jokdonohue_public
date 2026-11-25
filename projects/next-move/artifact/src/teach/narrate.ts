/**
 * M3 narrator (A1, brief L1): per-ply chess facts computed with chess.js, one short sentence per ply, and a
 * summary of the whole line. Pure and synchronous; never throws (a bad FEN or move ends the line).
 *
 * Definitions (what each fact means; every sentence is built from these facts and nothing else):
 * - "attacked" uses chess.js `attackers()` (geometry). "defended" = attacked by the piece owner's own side
 *   (pseudo-legal: a pinned defender still counts, which can only make a piece look safer, never looser).
 * - threats: enemy pieces (not the king) that the moved piece attacks from its new square and did not attack from
 *   its old one, and could really take (a piece pinned to its own king only takes along the pin; a king only takes
 *   an undefended piece), when the target is undefended or worth more than the mover. Castling: the rook is the
 *   moved piece. Promotion: the new piece is.
 * - check is direct (the moved piece gives it), discovered (another piece gives it) or double (both). A fork
 *   counts check only when the moved piece itself gives it.
 * - discovered: attacks on enemy pieces worth 3 or more (or the king) that another own slider gains because the
 *   move opened its line (attacked after, not before), and could really take.
 * - pins: enemy pieces pinned by an own bishop, rook or queen to their king, or to a queen or rook worth more
 *   than the pinned piece (relative pins also need the pinner to be worth less than that queen or rook, or the
 *   queen or rook to be undefended, otherwise taking it loses material). Only NEW pins: keyed on (pinned square,
 *   behind square), so a pinner sliding along the same line does not report an old pin again.
 * - castlingStopped: castling was possible apart from this move and is not after it: the side to move still has
 *   the right in the FEN (with its king and that rook at home), nothing stands between king and rook, none of the
 *   king square and transit squares (e/f/g or e/d/c) was attacked before the move, and a transit square is attacked
 *   after it. A plain check is not "stopping castling" (the king square alone does not count).
 * - leftHanging: the mover's own pieces (not the king) that the opponent can legally take right now (from the
 *   opponent's legal moves, so pins and check are respected), when undefended or when the cheapest legal taker is
 *   worth less. Most valuable first; `by` is the cheapest legal taker.
 *
 * Sentence rules (brief L11: plain, short, pieces named with their squares, no exclamation marks):
 * - "{SAN} " starts every sentence; then at most two clauses, in this order: the move itself (castles / takes /
 *   promotes, with check), how it answers a check, fork, discovered attack, the moved piece's pin, its single
 *   threat, a pin by another piece, castling stopped.
 *   Only when none of the tactical clauses applies: defends, moves out of attack, takes the opposition. A move with
 *   nothing to say "moves the {piece} to {square}" (or "pushes the pawn to {square}").
 * - FX1c (brief 9.11.3): a move that answers a check and gives one says the answer first ("blocks the check and gives
 *   check", "moves the king out of check and uncovers check from …"). "forks" only when the forking piece cannot
 *   legally be taken (en passant included); otherwise the check is said as usual and the attacked pieces are named
 *   in the fork's place: "gives check and attacks the rook on h8", "takes the pawn on f7 with check and attacks …",
 *   "attacks the rook on c7 and the rook on f6" (the pieces "forks" would have named, without the king, less the
 *   pawns the single-threat rule leaves out; `facts.fork` is unchanged).
 *   Three facts in the clauses are listed "A, B and C".
 * - FX1c (R4-6): `caption`, for the line viewer's steps, is the same facts split into short sentences when they are
 *   three or more (the "but" clause counts) or the sentence runs over 25 words: "{SAN} A and B. It also C. But D.".
 *   `text` stays one sentence for lessons, hints and coach inputs.
 * - Text-only filters (the facts keep everything): a fork names the king and pieces before pawns; a moved piece
 *   that can itself be taken gets no "attacks the pawn" clause; a pin of a pawn
 *   to a queen or rook is not named; a pin that does not hold (the pinned piece can legally take the pinner without
 *   losing material: the pinner is undefended or worth at least as much) is named only together with that warning.
 * - Hanging clause ("..., but the queen can take the rook on e1 with check", or alone "lets the queen on e5 take
 *   the rook on e1"): never after a check, mate or stalemate (the next ply narrates the capture; this keeps
 *   "Bxh7+ takes the pawn on h7 with check and uncovers ..." free of "the king can take the bishop"); not for the
 *   moved piece after it took something worth at least as much (an ordinary trade); pawns only when the pawn just
 *   moved.
 * - Mate clause (F1, brief 9.3; fact `allowsMate`): "..., but it allows mate in one: Rd1#.", or alone "Rd7 allows
 *   mate in one: Re1#.". It replaces the hanging clause and is said after a check too. With the option
 *   `nameMate: false` (the line viewer's captions, brief 9.9.2 b) the sentence stops before the mating move:
 *   "..., but it allows mate in one." / "Rd7 allows mate in one.". The fact keeps the SAN, and the summary is the
 *   same either way.
 *
 * Summary rules: mate and stalemate first. Then, when `settled`, the material change: "White wins a bishop.",
 * "No material changes hands." (nothing taken) or "The trades are even." (captures that cancel). When not settled
 * (see `material.settled`), what changed so far and what either side can still do, never a settled win: "So far in
 * this line White has won a pawn, but the rook on c8 can take the queen on c7." (also "... can take back on f6",
 * "... the new queen can be taken", "... Black can mate in one: Qg2#", and the three clauses FX1b added for the last
 * mover's threats: "... White is giving check", "... White's pawn on a7 can promote", "... the knight on e2 attacks
 * the king and the queen on c1"). When the clause favours the side that is ahead in the count, it joins with "and":
 * "So far in this line White has won a knight for a pawn, and White can take back on e2.".
 *
 * FX1c (brief 9.11.3, side condition): the last mover's three clauses (check, promoting pawn, protected fork) open the
 * line only when the last mover is level or behind in the count; when it is ahead they only add to its lead, as the
 * mate-in-one and loose-piece checks already did for the side to move.
 *
 * FX1e (brief 9.12.2, fix round 3):
 * - Item 1 (V1-1): the material a closing sentence states (settled, "so far" or verdict) equals `material.net`.
 *   New pieces cancel as trades do: the other side's new pieces against the side's own (same kind, then a new bishop
 *   for a new knight), so a new queen on each side is not named. A side that gained nothing else names what it gave
 *   with its promotion: "White promotes a pawn to a queen for a knight.", "White is a new queen for a knight up …".
 *   Two or more new pieces are each named: "promotes two pawns to a queen and a rook", "is two new queens up". A new
 *   piece of the other side's that nothing cancels is named with its kind: "White wins the queen, though Black promotes
 *   a pawn to a queen." ("also promotes" when the side itself promotes too); in the verdict sentence everything the side
 *   got comes before "for" and the other side's gains after it, its new pieces by owner: "White is a queen for Black's
 *   new queen up …". A sentence that already added up keeps its words.
 * - Item 2 (V1-6 part 3): the clause "{Side}'s pawn on {sq} can promote" is left out when the side to move can legally
 *   take that pawn at once (a promoting pawn it cannot take is named instead); the line stays open, so the summary keeps
 *   "So far in this line …" without a clause. `material.settled` does not change.
 *
 * FX1b options (brief 9.11.2, fix round 2; every default keeps the text this module wrote before):
 * - `verdict`: an engine figure for one side after the line's first move. When the closing sentence would name a side
 *   as the material winner (settled, or "so far") and the verdict puts that side below 50, the whole sentence becomes
 *   "{Side} is {material} up at the end of this line, but the engine gives {other side} {N}% to win." ("..., but
 *   {other side} is winning." for a `winning` verdict with no number). FX1c (brief 9.11.3): at 50 to 54 for that side
 *   (rounded) it becomes "{Side} is {material} up at the end of this line, but the engine rates the position about
 *   level.". It is applied before the pending clause, so the verdict sentence replaces it. `material.settled` never
 *   changes with the verdict.
 * - `omit`: a move (a `MoveRef`) the text must not describe, for a try line shown while the card is unsolved. Every
 *   caption clause and every summary clause that describes that move is left out; a summary whose pending clause is
 *   left out keeps "So far in this line …" without a clause. The facts and `material.settled` keep everything.
 *   FXR2b1 (brief 9.11.8): `omit` may also be a list (every move still to find); every rule applies to each move in
 *   it, and one move behaves exactly as a list of one. A caption also leaves out, for each move, the discovered-attack
 *   clause "uncovers {by} against {target}" when `by` is that move's piece on its from-square and `target` sits on its
 *   to-square, and "lets {by} pin {pinned} to {behind}" when `by` is that piece on that square and `pinned` or `behind`
 *   sits on its to-square. As with the hanging clause, the next discovered attack or pin that no listed move describes
 *   is named in its place, and with a clause gone the next clause in the order above can fill the second place.
 * - `noChangeSentence: false`: "No material changes hands." is left out (the summary is ''), for the line viewer.
 */
import { Chess, type Move, type Square } from 'chess.js';
import { PIECE_NAME, PIECE_VALUE, type PieceType, type Side } from './values';

export interface PieceAt { piece: 'p' | 'n' | 'b' | 'r' | 'q' | 'k'; color: 'w' | 'b'; square: string }
/**
 * An engine figure for the end of a line (brief 9.11.2 (r) 2): `win` is the page's Win% (0-100) for `side` after the
 * line's first move, so the other side's figure is 100 - win. `winning: true` is the same statement without a number.
 */
export type LineVerdict = { side: 'w' | 'b'; win: number } | { side: 'w' | 'b'; winning: true };
/** A move by identity, not by SAN text (brief 9.11.2 (t) 1): the piece that moves, its squares, the new piece. */
export interface MoveRef { from: string; to: string; piece: 'p' | 'n' | 'b' | 'r' | 'q' | 'k'; promotion?: 'n' | 'b' | 'r' | 'q' }
export interface NarrateOptions {
  /** Plies to narrate (default 24, at most 64). */
  maxPlies?: number;
  /** false leaves the mating reply out of a ply's mate clause (viewer captions, brief 9.9.2 b). */
  nameMate?: boolean;
  /** An engine figure for the end of the line (brief 9.11.2 (r) 2). */
  verdict?: LineVerdict | null;
  /** A move no sentence may describe (brief 9.11.2 (t) 2), or a list of them (brief 9.11.8: every move still to find). */
  omit?: MoveRef | readonly MoveRef[] | null;
  /** false leaves out "No material changes hands." (brief 9.11.2 (r) 4). */
  noChangeSentence?: boolean;
}
export interface PlyFacts {
  /** What was taken (en passant: the pawn's own square, not the destination). */
  capture?: PieceAt;
  check: boolean; mate: boolean; stalemate: boolean;
  promotion?: 'q' | 'r' | 'b' | 'n';
  /** Enemy pieces the MOVED piece now attacks that are undefended or worth more than it; the king only via `check`. */
  threats: Array<PieceAt & { undefended: boolean }>;
  /** threats (counting check by the moved piece) >= 2 */
  fork: boolean;
  /** Attacks by OTHER own pieces opened by this move, on targets worth >= 3 or the king. */
  discovered: Array<{ by: PieceAt; target: PieceAt }>;
  /** Enemy pieces newly pinned to their king, or to a queen/rook worth more than the pinned piece. */
  pins: Array<{ pinned: PieceAt; behind: PieceAt; by: PieceAt }>;
  /** The side now to move keeps that castling right in the FEN, nothing stands between king and rook, and a transit square is now attacked and was not before. */
  castlingStopped: Array<'k' | 'q'>;
  /** Mover's OWN pieces the opponent can legally take now, undefended or taken by a cheaper piece (most valuable first). */
  leftHanging: Array<PieceAt & { by: PieceAt }>;
  /**
   * F1 addition (brief 9.3), optional: SAN of a reply that mates at once, when this move allows one (the first in
   * chess.js move order). Absent when there is none, and after mate or stalemate.
   */
  allowsMate?: string;
}
export interface NarratedPly {
  index: number; uci: string; san: string; color: 'w' | 'b'; fenBefore: string; fenAfter: string; facts: PlyFacts;
  /** One sentence, starting with the SAN. Lessons, hints and coach inputs read this. */
  text: string;
  /**
   * FX1c (brief 9.11.3, R4-6), optional: the same facts as the line viewer shows them, set only when it differs from
   * `text`: a sentence that joins three or more facts, or runs over 25 words, split into short sentences (public bank
   * 001Fg: "fxg3 takes the knight on g3 and uncovers the rook on f1 against the queen on f4. But the queen can take the
   * rook on f1 with check."). Same words and names as `text`; only the joins differ ("It also …", "But …").
   */
  caption?: string;
}
export interface NarratedLine {
  startFen: string; plies: NarratedPly[];
  /** First illegal (or malformed) ply index, when the line breaks. */
  stoppedAt?: number;
  /**
   * pov = side making the first ply; net = material change for pov in pawns (captures, plus promotion gains);
   * won/lost = pieces pov took / lost, where they stood.
   * settled (A1 refinement of the brief's "last ply is not a capture", widened by F1 for Codex P2): the end
   * position is checked whatever the last ply was. False when the side to move can at once: mate in one; legally
   * take back on the last ply's square after a capture or a promotion; or legally take one of the last mover's
   * pieces (not the king; a pawn only when it just moved) that is undefended or worth more than its cheapest legal
   * taker. The mate in one and the loose piece count only when the side to move is level or behind in `net`: when
   * the side already ahead is to move, they only add to its lead (A1 also checked a loose piece after a capture, for
   * either side). The take-back (A1's rule, an exchange still going) counts for either side. A line ending in mate or
   * stalemate is settled.
   * FX1b (brief 9.11.2 (r) 1) added three cases, all about what the LAST MOVER threatens: the side to move is in
   * check; the last mover has a pawn that can promote on its next move; or a piece of the last mover attacks two or
   * more pieces of the side to move that are loose (undefended, or worth more than the attacker) and cannot legally
   * be taken. FX1c (brief 9.11.3): they count only when the last mover is level or behind in `net`; when it is ahead
   * they only add to its lead. `verdict` and `omit` never change this flag.
   */
  material: { pov: 'w' | 'b'; net: number; won: PieceAt[]; lost: PieceAt[]; settled: boolean };
  result?: 'mate' | 'stalemate';
  /**
   * e.g. "White wins the queen for a bishop." / "The line ends in checkmate by White." / "No material changes hands."
   * / "So far in this line White has won a pawn, but the rook on c8 can take the queen on c7." ('' for an empty line).
   */
  summary: string;
}

const DEFAULT_MAX_PLIES = 24;
const HARD_MAX_PLIES = 64;
/** The settled zero-change summary, which `noChangeSentence: false` leaves out (brief 9.11.2 (r) 4). */
export const NO_CHANGE_SENTENCE = 'No material changes hands.';
/** Pawns count as fork targets, as they do in a ply's fork caption (brief 9.11.2 (r) 1; see logs/m3_FX1b.md). */
const FORK_COUNTS_PAWNS = true;
/** FX1c (brief 9.11.3): a verdict that gives the named material winner 50 to this figure (rounded) is "about level". */
const ABOUT_LEVEL_MAX = 54;
const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;
const DIAGONALS: Array<[number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTHOGONALS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const SLIDERS: Partial<Record<PieceType, Array<[number, number]>>> = { b: DIAGONALS, r: ORTHOGONALS, q: [...DIAGONALS, ...ORTHOGONALS] };

const other = (c: Side): Side => (c === 'w' ? 'b' : 'w');
const colorName = (c: Side) => (c === 'w' ? 'White' : 'Black');
const fileOf = (s: string) => s.charCodeAt(0) - 97;
const rankOf = (s: string) => Number(s[1]) - 1;
const onBoard = (f: number, r: number) => f >= 0 && f < 8 && r >= 0 && r < 8;
const sqAt = (f: number, r: number) => `${String.fromCharCode(97 + f)}${r + 1}` as Square;
const value = (p: PieceType) => PIECE_VALUE[p];
const byValueDesc = <T extends { piece: PieceType; square: string }>(a: T, b: T) => value(b.piece) - value(a.piece) || (a.square < b.square ? -1 : 1);

function load(fen: string): Chess | null {
  if (typeof fen !== 'string') return null;
  try { return new Chess(fen); } catch { return null; }
}
function pieceAt(board: Chess, square: string): PieceAt | null {
  const p = board.get(square as Square);
  return p ? { piece: p.type, color: p.color, square } : null;
}
function piecesOf(board: Chess, color?: Side): PieceAt[] {
  const out: PieceAt[] = [];
  for (const row of board.board()) for (const cell of row) if (cell && (!color || cell.color === color)) out.push({ piece: cell.type, color: cell.color, square: cell.square });
  return out;
}
const kingSquare = (board: Chess, color: Side): Square | null => board.findPiece({ type: 'k', color })[0] ?? null;
/** SAN of a move that mates at once for the side to move (the first in chess.js order), or null. */
const mateInOne = (board: Chess): string | null => board.moves().find(s => s.endsWith('#')) ?? null;
const defended = (board: Chess, square: string, owner: Side) => board.attackers(square as Square, owner).length > 0;
/** UCI of a chess.js move (castling as the king's two-square move). */
export const uciOf = (m: Pick<Move, 'from' | 'to' | 'promotion'>) => `${m.from}${m.to}${m.promotion ?? ''}`;
/** Square of the piece a capture removes (en passant: the pawn beside, not the destination). */
const takenSquare = (m: Move) => (m.isEnPassant() ? `${m.to[0]}${m.from[1]}` : m.to);

/**
 * Play one UCI move on `board`; null (board unchanged) when it is malformed or illegal. Lower-cases the input,
 * accepts king-takes-own-rook castling ("e1h1" for O-O), and refuses a promotion letter on a non-promotion and a
 * promotion without its letter.
 */
export function playUci(board: Chess, raw: string): Move | null {
  if (typeof raw !== 'string') return null;
  const m = UCI_RE.exec(raw.trim().toLowerCase());
  if (!m) return null;
  const from = m[1] as Square, promotion = m[3];
  let to = m[2] as Square;
  const p = board.get(from), t = board.get(to);
  if (p?.type === 'k' && t?.type === 'r' && t.color === p.color && from[1] === to[1]) to = `${to[0] > from[0] ? 'g' : 'c'}${from[1]}` as Square;
  let mv: Move;
  try { mv = board.move({ from, to, promotion }); } catch { return null; }
  if (promotion && !mv.isPromotion()) { board.undo(); return null; }
  return mv;
}

/**
 * The identity of `uci` in `fen` (brief 9.11.2 (t) 1), or null when the move is not legal there. Castling is the
 * king's two-square move, as `playUci` reads it.
 */
export function moveRefOf(fen: string, uci: string): MoveRef | null {
  const board = load(fen);
  if (!board) return null;
  const mv = playUci(board, uci);
  if (!mv) return null;
  const promotion = mv.promotion as MoveRef['promotion'] | undefined;
  return { from: mv.from, to: mv.to, piece: mv.piece as MoveRef['piece'], ...(promotion ? { promotion } : {}) };
}

/**
 * Is `uci`, played in `fenBefore`, the move `ref` describes? The same piece type from the same square to the same
 * square, and when both promote, to the same piece (brief 9.11.2 (t) 1). SAN text is never compared, so Nxf3+ and
 * Nf3+ are one move, and a different piece reaching the same square is not.
 */
export function sameMove(fenBefore: string, uci: string, ref: MoveRef): boolean {
  if (!ref || typeof ref !== 'object') return false;
  const m = moveRefOf(fenBefore, uci);
  if (!m || m.from !== ref.from || m.to !== ref.to || m.piece !== ref.piece) return false;
  return !(m.promotion && ref.promotion) || m.promotion === ref.promotion;
}

/** What `omit` may hold (brief 9.11.8): one move, a list of moves, or none. */
type OmitOption = MoveRef | readonly MoveRef[] | null | undefined;
/**
 * FXR2b1 (brief 9.11.8): `omit` as a list. One move is a list of one, so it is read exactly as before; null, undefined
 * and an empty list leave nothing out. An entry that is not an object is skipped.
 */
export function omitRefs(omit: MoveRef | readonly MoveRef[] | null | undefined): readonly MoveRef[] {
  if (!omit) return [];
  const list = (Array.isArray(omit) ? omit : [omit]) as readonly MoveRef[];
  return list.filter(o => !!o && typeof o === 'object');
}

/** A move by squares and piece, to test a clause against `omit`. */
type MoveId = { from: string; to: string; piece: PieceType };
const idOf = (m: Pick<Move, 'from' | 'to' | 'piece'>): MoveId => ({ from: m.from, to: m.to, piece: m.piece as PieceType });
/**
 * Does a move in `omit` name one of these moves? The promotion letter is left out of the comparison on purpose: a
 * clause about a capture names the piece and the two squares, which is what the learner would read as the hidden
 * answer, and an en-passant or promoting capture matches on them too.
 */
const hits = (omit: OmitOption, ...moves: Array<MoveId | undefined>) =>
  omitRefs(omit).some(o => moves.some(m => !!m && m.from === o.from && m.to === o.to && m.piece === o.piece));
/**
 * FXR2b1 (brief 9.11.8): does a move in `refs` read as `by` acting on one of `on`: the move's piece standing on its
 * from-square (`by`), and one of `on` sitting on its to-square? For "uncovers {by} against {target}" (`on` = the
 * target) and "lets {by} pin {pinned} to {behind}" (`on` = the pinned piece and the piece behind it).
 */
const describedBy = (refs: readonly MoveRef[], by: PieceAt, ...on: PieceAt[]) =>
  refs.some(o => o.piece === by.piece && o.from === by.square && on.some(t => t.square === o.to));

/**
 * One position with memoized lookups: the squares each side's pieces pinned to their OWN king may still reach,
 * and the legal moves from a square (only the side to move has any). Verbose move lists are the expensive part of
 * chess.js, so they are asked per square, never for the whole board.
 */
class Pos {
  private readonly pinLines: Partial<Record<Side, Map<string, Set<string>>>> = {};
  private readonly fromSquare = new Map<string, Move[]>();
  constructor(readonly b: Chess) {}

  /** Own pieces of `color` pinned to their king -> squares on the pin line (up to and including the pinner). */
  pinned(color: Side): Map<string, Set<string>> {
    const cached = this.pinLines[color];
    if (cached) return cached;
    const out = new Map<string, Set<string>>();
    const k = kingSquare(this.b, color);
    if (k) {
      for (const [df, dr] of [...DIAGONALS, ...ORTHOGONALS]) {
        const diagonal = df !== 0 && dr !== 0;
        let f = fileOf(k) + df, r = rankOf(k) + dr;
        let mine: string | null = null;
        const path: string[] = [];
        while (onBoard(f, r)) {
          const s = sqAt(f, r);
          path.push(s);
          const x = this.b.get(s);
          if (x) {
            if (!mine) { if (x.color !== color) break; mine = s; }
            else { if (x.color !== color && (x.type === 'q' || x.type === (diagonal ? 'b' : 'r'))) out.set(mine, new Set(path)); break; }
          }
          f += df; r += dr;
        }
      }
    }
    this.pinLines[color] = out;
    return out;
  }

  legalFrom(square: string): Move[] {
    let moves = this.fromSquare.get(square);
    if (!moves) { moves = this.b.moves({ square: square as Square, verbose: true }); this.fromSquare.set(square, moves); }
    return moves;
  }

  /** Could the piece on `from` really take the enemy piece on `to` (if it were its move)? Not for kings as targets. */
  canTake(from: string, to: string): boolean {
    const p = this.b.get(from as Square), t = this.b.get(to as Square);
    if (!p || !t || p.color === t.color || t.type === 'k') return false;
    if (!this.b.attackers(to as Square, p.color).includes(from as Square)) return false;
    if (p.type === 'k') return !defended(this.b, to, t.color);
    const line = this.pinned(p.color).get(from);
    return !line || line.has(to);
  }

  /** Legal captures (by the side to move) of the piece on `square`, en passant included via `epFrom`. */
  takersOf(square: string, epFrom: string[] = []): Move[] {
    const owner = this.b.get(square as Square)?.color;
    if (!owner || owner === this.b.turn()) return [];
    const out: Move[] = [];
    for (const a of this.b.attackers(square as Square, this.b.turn())) for (const m of this.legalFrom(a)) if (m.captured && m.to === square) out.push(m);
    for (const a of epFrom) for (const m of this.legalFrom(a)) if (m.isEnPassant() && takenSquare(m) === square) out.push(m);
    return out;
  }
}

type Pin = { pinned: PieceAt; behind: PieceAt; by: PieceAt };
function findPins(board: Chess, color: Side): Pin[] {
  const out: Pin[] = [];
  for (const s of piecesOf(board, color)) {
    const dirs = SLIDERS[s.piece];
    if (!dirs) continue;
    for (const [df, dr] of dirs) {
      let f = fileOf(s.square) + df, r = rankOf(s.square) + dr;
      let first: PieceAt | null = null;
      while (onBoard(f, r)) {
        const x = pieceAt(board, sqAt(f, r));
        if (x) {
          if (!first) {
            if (x.color === color || x.piece === 'k') break;
            first = x;
          } else {
            if (x.color !== color) {
              const absolute = x.piece === 'k';
              const relative = (x.piece === 'q' || x.piece === 'r') && value(x.piece) > value(first.piece)
                && (value(s.piece) < value(x.piece) || !defended(board, x.square, x.color));
              if (absolute || relative) out.push({ pinned: first, behind: x, by: s });
            }
            break;
          }
        }
        f += df; r += dr;
      }
    }
  }
  return out;
}
const pinKey = (p: Pin) => `${p.pinned.square}>${p.behind.square}`;

/** Text-only extras, computed like the facts but not part of the PlyFacts contract. */
interface Extras {
  inCheckBefore: boolean;
  directCheck: boolean;
  discoveredCheckers: PieceAt[];
  smothered: boolean;
  defends?: PieceAt;
  outOfAttack: boolean;
  opposition: boolean;
  /** Legal capture move behind each leftHanging entry (same order), to say "with check". */
  hangingMoves: Move[];
  /** After-squares of the moved pieces that can attack (the rook when castling). */
  movedSquares: string[];
  /**
   * Per facts.pins entry: the pin does not hold, because the pinned piece can legally take its pinner without losing
   * material (the pinner is undefended, or worth at least as much as the pinned piece).
   */
  pinBreaks: boolean[];
  /**
   * FX1c (brief 9.11.3): `facts.fork` holds and the side now to move can legally take the forking piece (the moved
   * piece, the rook when castling; en passant included). The sentence then says "attacks", never "forks".
   */
  forkerTakeable: boolean;
}

function analysePly(before: Chess, after: Chess, mv: Move): { facts: PlyFacts; extras: Extras } {
  const mover = mv.color as Side, enemy = other(mover);
  const pre = new Pos(before), post = new Pos(after);
  const castle = mv.isKingsideCastle() || mv.isQueensideCastle();
  // The pieces that moved and can attack: the rook when castling, else the (possibly promoted) piece on `to`.
  const attackersMoved: Array<{ from: string; to: string }> = castle
    ? [{ from: `${mv.isKingsideCastle() ? 'h' : 'a'}${mv.from[1]}`, to: `${mv.isKingsideCastle() ? 'f' : 'd'}${mv.from[1]}` }]
    : [{ from: mv.from, to: mv.to }];
  const movedAll = castle ? [mv.to, attackersMoved[0].to] : [mv.to];
  const enemyPieces = piecesOf(after, enemy);
  const ownPieces = piecesOf(after, mover);

  const facts: PlyFacts = {
    check: after.inCheck(), mate: after.isCheckmate(), stalemate: after.isStalemate(),
    threats: [], fork: false, discovered: [], pins: [], castlingStopped: [], leftHanging: [],
  };
  if (mv.captured) facts.capture = { piece: mv.captured, color: enemy, square: takenSquare(mv) };
  if (mv.promotion === 'q' || mv.promotion === 'r' || mv.promotion === 'b' || mv.promotion === 'n') facts.promotion = mv.promotion;
  // A mate-in-one reply: chess.js marks a mating SAN with '#'. One full SAN list per ply (about 0.08 ms on desktop).
  if (!facts.mate && !facts.stalemate) {
    const mate = mateInOne(after);
    if (mate) facts.allowsMate = mate;
  }

  // Threats by the moved piece (new attacks only).
  for (const m of attackersMoved) {
    const pm = after.get(m.to as Square);
    if (!pm) continue;
    for (const t of enemyPieces) {
      if (t.piece === 'k' || !post.canTake(m.to, t.square)) continue;
      const wasThere = before.get(m.from as Square);
      if (wasThere && wasThere.color === mover && before.attackers(t.square as Square, mover).includes(m.from as Square)) continue;
      const undefended = !defended(after, t.square, enemy);
      if (undefended || (pm.type !== 'k' && value(t.piece) > value(pm.type))) facts.threats.push({ ...t, undefended });
    }
  }
  facts.threats.sort(byValueDesc);

  // Check: direct, discovered, double.
  const ek = kingSquare(after, enemy);
  const checkers = facts.check && ek ? after.attackers(ek, mover) : [];
  const directCheck = checkers.some(s => attackersMoved.some(m => m.to === s));
  const discoveredCheckers = checkers.filter(s => !attackersMoved.some(m => m.to === s)).map(s => pieceAt(after, s)).filter((p): p is PieceAt => !!p);
  facts.fork = facts.threats.length + (directCheck ? 1 : 0) >= 2;

  // Discovered attacks: lines opened for other own sliders.
  const valuable = enemyPieces.filter(t => t.piece === 'k' || value(t.piece) >= 3);
  for (const p of ownPieces) {
    if (movedAll.includes(p.square) || !SLIDERS[p.piece]) continue;
    for (const t of valuable) {
      if (!after.attackers(t.square as Square, mover).includes(p.square as Square)) continue;
      if (before.attackers(t.square as Square, mover).includes(p.square as Square)) continue;
      if (t.piece !== 'k' && !post.canTake(p.square, t.square)) continue;
      facts.discovered.push({ by: p, target: t });
    }
  }
  facts.discovered.sort((a, b) => (a.target.piece === 'k' ? -1 : 0) - (b.target.piece === 'k' ? -1 : 0) || byValueDesc(a.target, b.target));

  // New pins.
  const old = new Set(findPins(before, mover).map(pinKey));
  facts.pins = findPins(after, mover).filter(p => !old.has(pinKey(p)))
    .sort((a, b) => (a.behind.piece === 'k' ? -1 : 0) - (b.behind.piece === 'k' ? -1 : 0) || byValueDesc(a.pinned, b.pinned));

  // Castling stopped for the side now to move.
  const home = enemy === 'w' ? 'e1' : 'e8', rank = home[1];
  const k = after.get(home as Square);
  if (k?.type === 'k' && k.color === enemy) {
    const rights = after.getCastlingRights(enemy);
    for (const side of ['k', 'q'] as const) {
      if (!rights[side]) continue;
      const rook = after.get(`${side === 'k' ? 'h' : 'a'}${rank}` as Square);
      if (!(rook?.type === 'r' && rook.color === enemy)) continue;
      const transit = (side === 'k' ? ['f', 'g'] : ['d', 'c']).map(f => `${f}${rank}` as Square);
      // Castling must have been possible apart from this move: nothing between king and rook.
      const between = (side === 'k' ? ['f', 'g'] : ['b', 'c', 'd']).map(f => `${f}${rank}` as Square);
      if (between.some(s => after.get(s))) continue;
      if ([home as Square, ...transit].some(s => before.isAttacked(s, mover))) continue;
      if (transit.some(s => after.isAttacked(s, mover))) facts.castlingStopped.push(side);
    }
  }

  // Left hanging: the opponent's legal captures of the mover's pieces.
  const over = facts.mate || facts.stalemate;
  const epFrom = mv.isBigPawn() ? [-1, 1].map(d => fileOf(mv.to) + d).filter(f => f >= 0 && f < 8).map(f => sqAt(f, rankOf(mv.to)))
    .filter(s => after.get(s)?.type === 'p' && after.get(s)?.color === enemy) : [];
  const takers = (square: string) => (over ? [] : post.takersOf(square, square === mv.to ? epFrom : []));
  const hanging: Array<{ entry: PieceAt & { by: PieceAt }; move: Move }> = [];
  for (const o of ownPieces) {
    if (o.piece === 'k') continue;
    const caps = takers(o.square);
    if (!caps.length) continue;
    const cheapest = caps.reduce((a, b) => (value(b.piece) < value(a.piece) ? b : a));
    if (!defended(after, o.square, mover) || value(cheapest.piece) < value(o.piece)) {
      hanging.push({ entry: { ...o, by: { piece: cheapest.piece, color: enemy, square: cheapest.from } }, move: cheapest });
    }
  }
  hanging.sort((a, b) => byValueDesc(a.entry, b.entry));
  facts.leftHanging = hanging.map(h => h.entry);

  // Text-only extras.
  let smothered = false;
  if (facts.mate && ek) {
    const kf = fileOf(ek), kr = rankOf(ek);
    const around: Square[] = [];
    for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) if ((df || dr) && onBoard(kf + df, kr + dr)) around.push(sqAt(kf + df, kr + dr));
    smothered = checkers.length > 0 && checkers.every(s => after.get(s)?.type === 'n') && around.every(s => after.get(s)?.color === enemy);
  }
  let defends: PieceAt | undefined;
  let outOfAttack = false;
  if (!castle && mv.piece !== 'k') {
    const hangingSquares = new Set(facts.leftHanging.map(h => h.square));
    defends = ownPieces
      .filter(o => o.piece !== 'k' && o.square !== mv.to && !hangingSquares.has(o.square) && !defended(before, o.square, mover)
        && after.attackers(o.square as Square, mover).includes(mv.to) && takers(o.square).length > 0)
      .sort(byValueDesc)[0];
    if (!mv.captured && !mv.promotion) {
      const realAttackers = before.attackers(mv.from, enemy).filter(s => pre.canTake(s, mv.from));
      const cheapest = Math.min(...realAttackers.map(s => value(before.get(s)!.type)));
      const wasLoose = realAttackers.length > 0 && (!defended(before, mv.from, mover) || cheapest < value(mv.piece));
      outOfAttack = wasLoose && after.attackers(mv.to, enemy).length === 0;
    }
  }
  let opposition = false;
  if (mv.piece === 'k' && !castle && ek && piecesOf(after).every(p => p.piece === 'k' || p.piece === 'p')) {
    const df = Math.abs(fileOf(mv.to) - fileOf(ek)), dr = Math.abs(rankOf(mv.to) - rankOf(ek));
    opposition = (df === 0 && dr === 2) || (dr === 0 && df === 2);
  }
  return {
    facts,
    extras: {
      inCheckBefore: before.inCheck(), directCheck, discoveredCheckers, smothered, defends, outOfAttack, opposition,
      hangingMoves: hanging.map(h => h.move), movedSquares: attackersMoved.map(m => m.to),
      pinBreaks: facts.pins.map(p => !over && post.legalFrom(p.pinned.square).some(r => r.to === p.by.square)
        && (!defended(after, p.by.square, mover) || value(p.pinned.piece) <= value(p.by.piece))),
      forkerTakeable: facts.fork && takers(attackersMoved[0].to).length > 0,
    },
  };
}

const ref = (p: PieceAt) => (p.piece === 'k' ? 'the king' : `the ${PIECE_NAME[p.piece]} on ${p.square}`);
function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
function checkSuffix(after: Chess, m: Move): string {
  const sim = load(after.fen());
  if (!sim) return '';
  try { sim.move({ from: m.from, to: m.to, promotion: m.promotion }); } catch { return ''; }
  return sim.isCheckmate() ? ' with checkmate' : sim.inCheck() ? ' with check' : '';
}

/** FX1c (brief 9.11.3, R4-6): no caption sentence runs over this many words (the SAN counted). */
const CAPTION_WORDS = 25;
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * A ply's sentence from its facts, in order (each one "takes …", "gives check", "attacks …"), and the "but" clause
 * that may close it ("the queen can take the rook on f1 with check", "it allows mate in one").
 * `text` is the one sentence every caller reads: "{SAN} A and B, but C." ("{SAN} A, B and C" for three facts).
 * `caption` (FX1c, brief 9.11.3 R4-6) is the same facts for a line viewer's step, set only when it differs: a sentence
 * with three or more facts, or one over 25 words, is split, so no sentence runs over 25 words:
 * "{SAN} A and B. It also C. But D." The words are the same; only the joins change.
 */
function sentences(san: string, facts: readonly string[], but: string): { text: string; caption?: string } {
  const text = `${san} ${listJoin([...facts])}${but ? `, but ${but}` : ''}.`;
  if (facts.length + (but ? 1 : 0) < 3 && wordCount(text) <= CAPTION_WORDS) return { text };
  const lead = facts.length > 1 && wordCount(`${san} ${facts[0]} and ${facts[1]}.`) <= CAPTION_WORDS ? 2 : 1;
  const out = [`${san} ${facts.slice(0, lead).join(' and ')}.`];
  const rest = facts.slice(lead);
  if (rest.length) out.push(`It also ${listJoin([...rest])}.`);
  if (but) out.push(`But ${but}.`);
  const caption = out.join(' ');
  return caption === text ? { text } : { text, caption };
}

function plyText(mv: Move, after: Chess, f: PlyFacts, x: Extras, nameMate = true, omit?: OmitOption): { text: string; caption?: string } {
  const san = mv.san, enemy = other(mv.color as Side), Enemy = colorName(enemy);
  const refs = omitRefs(omit);
  const castle = mv.isKingsideCastle() || mv.isQueensideCastle();
  // The move itself, one fact per part ("takes …", "promotes …"); a check is added to its last part.
  const prim: string[] = [];
  if (mv.isKingsideCastle()) prim.push('castles kingside');
  else if (mv.isQueensideCastle()) prim.push('castles queenside');
  else {
    if (f.capture) prim.push(`takes ${ref(f.capture)}${mv.isEnPassant() ? ' en passant' : ''}`);
    if (f.promotion) prim.push(f.promotion === 'q' ? 'promotes' : `promotes to a ${PIECE_NAME[f.promotion]}`);
  }
  const primary = prim.join(' and ');
  if (f.mate) {
    if (primary) return { text: `${san} ${primary} with checkmate.` };
    if (x.smothered) return { text: `${san} is a smothered mate: the king is boxed in by its own pieces.` };
    return { text: `${san} is checkmate.` };
  }
  if (f.stalemate) {
    if (primary) return { text: `${san} ${primary}, and it is stalemate: ${Enemy} has no legal move, so the game is a draw.` };
    return { text: `${san} is stalemate: ${Enemy} has no legal move, so the game is a draw.` };
  }

  // Each slot is one clause of the sentence as a list of facts; at most two slots are said.
  let tactical = false;
  const double = f.check && x.directCheck && x.discoveredCheckers.length > 0;
  const fork = f.fork && !double;
  // FX1c (brief 9.11.3): "forks" only when the forking piece cannot legally be taken. Otherwise the check is said as
  // usual and the pieces it hits are named: "gives check and attacks …" or "attacks … and …" (see below).
  const safeFork = fork && !x.forkerTakeable;
  const forkWithKing = safeFork && x.directCheck;
  let checkSlot: string[] = [];
  if (f.check) {
    tactical = true;
    if (double) { if (prim.length) prim[prim.length - 1] += ' with double check'; else checkSlot = ['gives double check']; }
    else if (x.directCheck) { if (!forkWithKing) { if (prim.length) prim[prim.length - 1] += ' with check'; else checkSlot = ['gives check']; } }
    else if (x.discoveredCheckers.length) checkSlot = [`uncovers check from ${ref(x.discoveredCheckers[0])}`];
  }
  if (prim.length) tactical = true;
  const answer = x.inCheckBefore && !mv.captured && !castle ? (mv.piece === 'k' ? 'moves the king out of check' : 'blocks the check') : '';

  const movedHere = (s: string) => x.movedSquares.includes(s);
  // The hanging piece to mention, if any (see the header). FX1b (brief 9.11.2 (t) 2): a capture that `omit` names is
  // not described, and the next piece that qualifies is named instead.
  let hangIdx = -1;
  if (!f.check) {
    const moverNow = after.get(x.movedSquares[0] as Square);
    const tookEnough = !!f.capture && !!moverNow && value(f.capture.piece) >= value(moverNow.type);
    hangIdx = f.leftHanging.findIndex((h, i) => !(tookEnough && movedHere(h.square)) && (movedHere(h.square) || value(h.piece) >= 3)
      && !hits(omit, x.hangingMoves[i] ? idOf(x.hangingMoves[i]) : undefined));
  }
  const hanging = hangIdx >= 0 ? f.leftHanging[hangIdx] : null;
  // Pins worth naming: not a pawn pinned to a queen or rook; and a pin that does not hold (the pinned piece takes the
  // pinner without losing material) only together with that warning. The moved piece's own pin and its own threat
  // come before a pin by another piece. A threat on a piece the named pin already covers is not repeated.
  const namedPins = f.pins.filter((p, k) => (p.behind.piece === 'k' || p.pinned.piece !== 'p') && (!x.pinBreaks[k] || hanging?.square === p.by.square));
  const ownPin = namedPins.find(p => movedHere(p.by.square));
  // FXR2b1 (brief 9.11.8): a pin by another piece that a move in `omit` describes (that piece from its square, onto the
  // pinned piece or the piece behind it) is not named; the next such pin is.
  const otherPin = namedPins.find(p => !movedHere(p.by.square) && !describedBy(refs, p.by, p.pinned, p.behind));
  const pinnedByMoved = new Set(ownPin ? [ownPin.pinned.square] : []);
  // A moved piece that can itself be taken (an even trade or worse) does not get its attack on a pawn named.
  const movedCanBeTaken = f.leftHanging.some(h => movedHere(h.square));
  const namable = f.threats.filter(th => !pinnedByMoved.has(th.square) && !(movedCanBeTaken && th.piece === 'p'));
  const attacker = after.get(x.movedSquares[0] as Square);
  const moverValue = attacker ? value(attacker.type) : 0;
  const attacks = (ts: typeof f.threats) => (ts.length === 1
    ? `attacks ${ts[0].undefended && value(ts[0].piece) <= moverValue ? `the undefended ${PIECE_NAME[ts[0].piece]} on ${ts[0].square}` : ref(ts[0])}`
    : `attacks ${listJoin(ts.map(ref))}`);

  let forkSlot: string[] | null = null;
  if (safeFork) {
    const pieces = f.threats.filter(t => t.piece !== 'p'), pawns = f.threats.filter(t => t.piece === 'p');
    const named = [...(forkWithKing ? ['the king'] : []), ...pieces.map(ref)];
    for (const p of pawns) if (named.length < 2) named.push(ref(p));
    forkSlot = [`forks ${listJoin(named.slice(0, 3))}`];
    tactical = true;
  } else if (fork) {
    // FX1c: a fork whose piece can be taken. The pieces named are the ones "forks" would have named, without the
    // king (pieces first, pawns only to make two names with the king counted, at most three names), less the ones the
    // single-threat rule leaves out (`namable`). With a check by the moved piece and no capture or promotion to carry
    // it, "gives check" and the attack share one clause, as "forks the king and …" did, so no other clause is pushed out.
    const king = x.directCheck ? 1 : 0;
    const ts = namable.filter(t => t.piece !== 'p');
    for (const p of namable) if (p.piece === 'p' && king + ts.length < 2) ts.push(p);
    ts.splice(3 - king);
    if (ts.length) {
      const said = attacks(ts);
      if (x.directCheck && checkSlot.length) checkSlot.push(said);
      else forkSlot = [said];
      tactical = true;
    }
  }

  const slots: string[][] = [];
  // FX1c (brief 9.11.3, R4-6): a move that answers a check and gives one says the answer first ("blocks the check and
  // gives check", never "gives check and blocks the check").
  if (answer && f.check) slots.push([answer], ...(prim.length ? [prim] : []), ...(checkSlot.length ? [checkSlot] : []));
  else slots.push(...(prim.length ? [prim] : []), ...(checkSlot.length ? [checkSlot] : []), ...(answer ? [[answer]] : []));
  if (forkSlot) slots.push(forkSlot);
  // FXR2b1 (brief 9.11.8): a discovered attack that a move in `omit` describes (the uncovered piece from its square onto
  // the target's square) is not named; the next one is.
  const disc = f.discovered.find(d => d.target.piece !== 'k' && !describedBy(refs, d.by, d.target));
  if (disc) { slots.push([`uncovers ${ref(disc.by)} against ${ref(disc.target)}`]); tactical = true; }
  if (ownPin) { slots.push([`pins ${ref(ownPin.pinned)} to ${ref(ownPin.behind)}`]); tactical = true; }
  if (!fork && namable[0]) { slots.push([attacks([namable[0]])]); tactical = true; }
  if (otherPin) { slots.push([`lets ${ref(otherPin.by)} pin ${ref(otherPin.pinned)} to ${ref(otherPin.behind)}`]); tactical = true; }
  if (!f.check && f.castlingStopped.length) {
    const how = f.castlingStopped.length === 2 ? 'on either side' : f.castlingStopped[0] === 'k' ? 'kingside' : 'queenside';
    slots.push([`stops ${Enemy} castling ${how}`]);
    tactical = true;
  }
  if (!tactical) {
    if (x.defends) slots.push([`defends ${ref(x.defends)}`]);
    if (x.outOfAttack) slots.push([`moves the ${PIECE_NAME[mv.piece as PieceType]} out of attack`]);
    if (x.opposition) slots.push(['takes the opposition']);
  }
  const shown = slots.slice(0, 2).flat();

  // A mate-in-one reply outweighs a loose piece: it replaces the hanging clause (one "but" per sentence), and it is
  // said after a check too (the reply that mates is the point of a try line). `nameMate: false` leaves the mating
  // move unnamed (a viewer's caption must not name a move still ahead in the line).
  if (f.allowsMate) {
    const mate = nameMate ? `mate in one: ${f.allowsMate}` : 'mate in one';
    return shown.length ? sentences(san, shown, `it allows ${mate}`) : { text: `${san} allows ${mate}.` };
  }

  let but = '';
  if (hanging) {
    const so = shown.join(' ');
    const taker = hanging.by.piece === 'k' ? 'the king' : so.includes(ref(hanging.by)) ? `the ${PIECE_NAME[hanging.by.piece]}` : ref(hanging.by);
    const tail = checkSuffix(after, x.hangingMoves[hangIdx]);
    if (shown.length) but = `${taker} can take ${ref(hanging)}${tail}`;
    else shown.push(`lets ${taker} take ${ref(hanging)}${tail}`);
  }
  if (!shown.length) shown.push(mv.piece === 'p' ? `pushes the pawn to ${mv.to}` : `moves the ${PIECE_NAME[mv.piece as PieceType]} to ${mv.to}`);
  return sentences(san, shown, but);
}

function narratePly(index: number, fenBefore: string, mv: Move, after: Chess, nameMate = true, omit?: OmitOption): NarratedPly {
  const base = { index, uci: uciOf(mv), san: mv.san, color: mv.color as Side, fenBefore, fenAfter: after.fen() };
  try {
    const before = load(fenBefore)!;
    const { facts, extras } = analysePly(before, after, mv);
    const { text, caption } = plyText(mv, after, facts, extras, nameMate, omit);
    return { ...base, facts, text, ...(caption ? { caption } : {}) };
  } catch {
    // Defensive only: a chess.js surprise must not break the page. Plain, true sentence; no facts claimed.
    const facts: PlyFacts = {
      check: after.inCheck(), mate: after.isCheckmate(), stalemate: after.isStalemate(),
      threats: [], fork: false, discovered: [], pins: [], castlingStopped: [], leftHanging: [],
    };
    const verb = facts.mate ? 'is checkmate' : `${mv.piece === 'p' ? 'pushes the pawn' : `moves the ${PIECE_NAME[mv.piece as PieceType]}`} to ${mv.to}`;
    return { ...base, facts, text: `${mv.san} ${verb}.` };
  }
}

// ---------------------------------------------------------------- line summary

const COUNT_WORD = ['no', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const ORDER: PieceType[] = ['q', 'r', 'b', 'n', 'p'];
function describeParts(types: PieceType[], singleQueen: boolean): string[] {
  const parts: string[] = [];
  for (const t of ORDER) {
    const n = types.filter(x => x === t).length;
    if (!n) continue;
    if (t === 'q' && n === 1 && singleQueen) { parts.push('the queen'); continue; }
    parts.push(n === 1 ? `a ${PIECE_NAME[t]}` : `${COUNT_WORD[n] ?? String(n)} ${PIECE_NAME[t]}s`);
  }
  return parts;
}
function describe(types: PieceType[], singleQueen: boolean): string {
  return listJoin(describeParts(types, singleQueen));
}
/**
 * FX1e (brief 9.12.2 item 1): new pieces from promotions, counted as pieces: "a new queen", "two new rooks"; with
 * `owner`, the other side's: "Black's new queen". One part per kind.
 */
function newPieceParts(types: PieceType[], owner?: Side): string[] {
  return ORDER.flatMap(t => {
    const n = types.filter(x => x === t).length;
    if (!n) return [];
    const words = n === 1 ? `new ${PIECE_NAME[t]}` : `${COUNT_WORD[n] ?? String(n)} new ${PIECE_NAME[t]}s`;
    return [owner ? `${colorName(owner)}'s ${words}` : n === 1 ? `a ${words}` : words];
  });
}
/** FX1e: "a pawn to a queen", "two pawns to two queens", "two pawns to a queen and a rook" (each new piece named). */
const pawnsTo = (types: PieceType[]) => `${types.length === 1 ? 'a pawn' : `${COUNT_WORD[types.length] ?? String(types.length)} pawns`} to ${describe(types, false)}`;
/**
 * Cancel trades so the sentence names only the difference: same kinds first (knight for knight), then bishop for
 * knight. Order-independent: won [bishop, knight] against lost [knight] leaves "a bishop".
 */
function cancelTrades(a: PieceType[], b: PieceType[]): [PieceType[], PieceType[]] {
  const x = [...a], y = [...b];
  const minor = (t: PieceType) => t === 'b' || t === 'n';
  for (const pass of [(t: PieceType, u: PieceType) => t === u, (t: PieceType, u: PieceType) => minor(t) && minor(u)]) {
    for (let i = 0; i < x.length; i++) {
      const j = y.findIndex(u => pass(x[i], u));
      if (j >= 0) { x.splice(i, 1); y.splice(j, 1); i--; }
    }
  }
  return [x, y];
}

interface Capture { by: Side; type: PieceType }
/**
 * What the side to move can do at once at the end of the line that would change the material picture (null: the
 * line is settled). See `endpoint`.
 */
type Pending =
  | null
  | { kind: 'mate'; by: Side; san: string; move?: MoveId }
  | { kind: 'take-back'; by: Side; square: string; takers: MoveId[] }
  | { kind: 'promoted'; by: Side; piece: PieceType; takers: MoveId[] }
  /** FX1b (brief 9.11.2 (r) 1): the side to move is in check, so the last mover is giving it. */
  | { kind: 'check'; by: Side }
  /**
   * FX1b: the last mover has a pawn that can promote on its next move. FX1e (brief 9.12.2 item 2): `takeable` when
   * the side to move can legally take that pawn at once (no promoting pawn is safe); its clause is then left out.
   */
  | { kind: 'promoting'; by: Side; square: string; takeable: boolean }
  /** FX1b: a piece of the last mover attacks two or more loose pieces and cannot legally be taken. */
  | { kind: 'fork'; by: PieceAt; targets: PieceAt[] }
  /** Most valuable target first; each entry carries every legal capture of it, for `omit`. */
  | { kind: 'loose'; entries: Array<{ target: PieceAt; by: PieceAt; takers: MoveId[] }> };

/** The side a pending clause favours: the side that can still act, or the last mover for its own threats. */
function favours(p: Exclude<Pending, null>): Side {
  switch (p.kind) {
    case 'mate': case 'take-back': case 'promoted': case 'check': case 'promoting': return p.by;
    case 'fork': return p.by.color;
    case 'loose': return p.entries[0].by.color;
  }
}

/**
 * FX1b (brief 9.11.2 (r) 1): the pawns of `side` that could promote if it were its move (board order). Legality comes
 * from chess.js on a copy of the position with `side` to move (so a pinned pawn does not count); the geometric test is
 * the fallback when that copy cannot be read. Only called with the side to move not in check, so the copy is a legal
 * position. FX1e (brief 9.12.2 item 2): every such pawn, not only the first, so `endpoint` can prefer one that the side
 * to move cannot take.
 */
function promotingPawns(board: Chess, side: Side): string[] {
  const rank = side === 'w' ? '7' : '2';
  const pawns = piecesOf(board, side).filter(p => p.piece === 'p' && p.square[1] === rank);
  if (!pawns.length) return [];
  const fields = board.fen().split(' ');
  const probe = load([fields[0], side, fields[2] ?? '-', '-', '0', fields[5] ?? '1'].join(' '));
  const out: string[] = [];
  for (const p of pawns) {
    if (probe) {
      try {
        if (probe.moves({ square: p.square as Square, verbose: true }).some(m => m.isPromotion())) out.push(p.square);
        continue;
      } catch { /* fall through to the geometric test */ }
    }
    const f = fileOf(p.square), r = rankOf(p.square), dr = side === 'w' ? 1 : -1;
    if (onBoard(f, r + dr) && !board.get(sqAt(f, r + dr))) { out.push(p.square); continue; }
    for (const df of [-1, 1]) {
      if (!onBoard(f + df, r + dr)) continue;
      const t = board.get(sqAt(f + df, r + dr));
      if (t && t.color !== side) { out.push(p.square); break; }
    }
  }
  return out;
}

/**
 * FX1b (brief 9.11.2 (r) 1): a piece of `by` that attacks two or more pieces of the side to move which are loose
 * (undefended, or worth more than the attacker), and that the side to move cannot legally take. The king, worth
 * nothing, counts only undefended targets (`Pos.canTake` already holds it to those). Pawns count as targets, as they
 * do in a ply's fork caption. The cheapest attacker is looked at first (a knight forking two rooks is the clause
 * worth printing), and the two most valuable targets are named.
 */
function forkAt(board: Chess, pos: Pos, by: Side): Extract<Pending, { kind: 'fork' }> | null {
  const toMove = other(by);
  const targets = piecesOf(board, toMove).filter(t => t.piece !== 'k' && (FORK_COUNTS_PAWNS || t.piece !== 'p'));
  if (targets.length < 2) return null;
  const attackers = piecesOf(board, by).sort((a, b) => value(a.piece) - value(b.piece));
  for (const a of attackers) {
    const hit = targets
      .filter(t => pos.canTake(a.square, t.square) && (!defended(board, t.square, toMove) || (a.piece !== 'k' && value(t.piece) > value(a.piece))))
      .sort(byValueDesc);
    if (hit.length >= 2 && pos.takersOf(a.square).length === 0) return { kind: 'fork', by: a, targets: hit.slice(0, 2) };
  }
  return null;
}

/**
 * The end of the line (Codex P2), checked whatever the last ply was. Not settled when the side to move can at once:
 * mate; take back on the last ply's square after a capture or a promotion; or legally take one of the last mover's
 * pieces that is undefended or worth more than its cheapest legal taker (any piece but the king; a pawn only when it
 * just moved, as in the ply's hanging clause). A defended piece attacked by an equal or dearer piece after a quiet
 * move is an offer to trade, not a loss, so it stays settled.
 * `leader`: the side ahead in the count (null when level). When the side to move is ahead, a mate in one or a loose
 * piece only adds to its lead, so only the take-back after a capture or a promotion (A1's rule, an exchange still
 * going) is checked. FX1c (brief 9.11.3, side condition on (r) 1): likewise the last mover's check, promoting pawn
 * and protected fork open the line only when the last mover is level or behind; when it is ahead they only add to
 * its lead.
 */
function endpoint(board: Chess, last: Move, leader: Side | null): Pending {
  const lastBy = last.color as Side, toMove = other(lastBy);
  const leaderToMove = leader === toMove;
  const mate = leaderToMove ? null : mateInOne(board);
  if (mate) {
    const mv = board.moves({ verbose: true }).find(m => m.san === mate);
    return { kind: 'mate', by: toMove, san: mate, ...(mv ? { move: idOf(mv) } : {}) };
  }
  const pos = new Pos(board);
  if (last.captured || last.promotion) {
    const back = pos.takersOf(last.to);
    if (back.length) {
      return last.promotion && !last.captured
        ? { kind: 'promoted', by: toMove, piece: last.promotion as PieceType, takers: back.map(idOf) }
        : { kind: 'take-back', by: toMove, square: last.to, takers: back.map(idOf) };
    }
  }
  // FX1b (brief 9.11.2 (r) 1): what the LAST MOVER threatens. These are the ends R3-2 found settled while the next
  // moves undid the count: a check, a pawn one step from queening, a fork that cannot be taken. FX1c (brief 9.11.3):
  // only when the last mover is level or behind in the count; a threat by the side already ahead adds to its lead.
  if (leader !== lastBy) {
    if (board.inCheck()) return { kind: 'check', by: lastBy };
    const promoting = promotingPawns(board, lastBy);
    if (promoting.length) {
      // FX1e (brief 9.12.2 item 2, V1-6): a pawn the side to move can take at once is a threat, not why the line is
      // open. A promoting pawn it cannot take is named instead; when it can take every one, the clause is left out and
      // the line stays open ("So far in this line …").
      const safe = promoting.find(s => pos.takersOf(s).length === 0);
      return { kind: 'promoting', by: lastBy, square: safe ?? promoting[0], takeable: safe === undefined };
    }
    const fork = forkAt(board, pos, lastBy);
    if (fork) return fork;
  }
  if (leaderToMove) return null;
  // A pawn that has just made a two-square move can also be taken en passant.
  const epFrom = last.isBigPawn() ? [-1, 1].map(d => fileOf(last.to) + d).filter(f => f >= 0 && f < 8).map(f => sqAt(f, rankOf(last.to)))
    .filter(s => board.get(s)?.type === 'p' && board.get(s)?.color === toMove) : [];
  const loose: Array<{ target: PieceAt; by: PieceAt; takers: MoveId[] }> = [];
  for (const o of piecesOf(board, lastBy)) {
    if (o.piece === 'k' || (o.piece === 'p' && !(last.piece === 'p' && o.square === last.to))) continue;
    const caps = pos.takersOf(o.square, o.square === last.to ? epFrom : []);
    if (!caps.length) continue;
    const cheapest = caps.reduce((a, b) => (value(b.piece) < value(a.piece) ? b : a));
    if (!defended(board, o.square, lastBy) || value(cheapest.piece) < value(o.piece)) {
      loose.push({ target: o, by: { piece: cheapest.piece, color: toMove, square: cheapest.from }, takers: caps.map(idOf) });
    }
  }
  loose.sort((a, b) => byValueDesc(a.target, b.target));
  return loose.length ? { kind: 'loose', entries: loose } : null;
}

/**
 * The clause after "So far in this line …". '' when `omit` names the move it would describe (brief 9.11.2 (t) 2):
 * the summary then keeps its first half alone. A loose piece whose every legal taker is that move gives way to the
 * next loose piece. FXR2b1 (brief 9.11.8): with a list, each rule is read for each move in it. FX1e (brief 9.12.2
 * item 2): also '' for a promoting pawn the side to move can take at once.
 */
function pendingText(p: Exclude<Pending, null>, omit?: OmitOption): string {
  switch (p.kind) {
    case 'mate': return hits(omit, p.move) ? '' : `${colorName(p.by)} can mate in one: ${p.san}`;
    case 'take-back': return hits(omit, ...p.takers) ? '' : `${colorName(p.by)} can take back on ${p.square}`;
    case 'promoted': return hits(omit, ...p.takers) ? '' : `the new ${PIECE_NAME[p.piece]} can be taken`;
    case 'check': return `${colorName(p.by)} is giving check`;
    case 'promoting':
      // FX1e (brief 9.12.2 item 2): left out when the side to move can take that pawn at once.
      return p.takeable || omitRefs(omit).some(o => o.piece === 'p' && o.from === p.square && !!o.promotion)
        ? '' : `${colorName(p.by)}'s pawn on ${p.square} can promote`;
    case 'fork':
      return describedBy(omitRefs(omit), p.by, ...p.targets)
        ? '' : `${ref(p.by)} attacks ${listJoin(p.targets.map(ref))}`;
    case 'loose': {
      const e = p.entries.find(x => !hits(omit, ...x.takers));
      return e ? `${ref(e.by)} can take ${ref(e.target)}` : '';
    }
  }
}

/**
 * FX1b (brief 9.11.2 (r) 2): the tail of the verdict sentence when `v` puts `ahead`, the side the closing sentence
 * names as the material winner, below 50. Null when there is no verdict, when it does not name a side, when its
 * number is not a number, or when it agrees with the count. The comparison uses the rounded whole number, as 9.1's
 * classes do, so the figure printed and the figure tested are the same one.
 */
function verdictAgainst(v: LineVerdict | null | undefined, ahead: Side): string | null {
  if (!v || typeof v !== 'object' || (v.side !== 'w' && v.side !== 'b')) return null;
  const loser = colorName(other(ahead));
  if ('winning' in v) return v.winning === true && v.side !== ahead ? `${loser} is winning` : null;
  const win = (v as { win: number }).win;
  if (typeof win !== 'number' || !Number.isFinite(win)) return null;
  // `win` is rounded once, for the side it was given for, so the figure printed here is the one the rest of the page
  // prints for that side (54.5 reads 55 for its own side and 45 for the other, never 54).
  const given = Math.round(win);
  const aheadWin = v.side === ahead ? given : 100 - given;
  if (aheadWin < 50) return `the engine gives ${loser} ${100 - aheadWin}% to win`;
  // FX1c (brief 9.11.3, "about level"): a named winner at 50 to 54 is not winning by the engine's figure either.
  return aheadWin <= ABOUT_LEVEL_MAX ? 'the engine rates the position about level' : null;
}

/**
 * Settled: "White wins a bishop." / "No material changes hands." (nothing taken) / "The trades are even." (captures
 * that cancel; Codex: not "level", which would describe the balance on the board). Not settled: what changed so far
 * and what can still happen, never a settled win: "So far in this line White has won a pawn, but the rook on c8 can
 * take the queen on c7." ("and" instead of "but" when the clause favours the side that is ahead.)
 * FX1b: a verdict that contradicts the count replaces the whole sentence; `omit` can leave the clause out; and
 * `noChangeSentence: false` leaves out "No material changes hands." (the summary is then '').
 */
function summarize(
  pov: Side, start: Chess, end: Chess, plies: NarratedPly[], captures: Capture[], promos: Array<{ by: Side; type: PieceType }>,
  net: number, pending: Pending, opts: { verdict?: LineVerdict | null; omit?: OmitOption; noChangeSentence?: boolean },
): { result?: 'mate' | 'stalemate'; summary: string } {
  if (!plies.length) return { summary: '' };
  if (end.isCheckmate()) return { result: 'mate', summary: `The line ends in checkmate by ${colorName(plies[plies.length - 1].color)}.` };
  if (end.isStalemate()) return { result: 'stalemate', summary: 'The line ends in stalemate, a draw.' };
  const done = pending === null;
  let change: string;
  // The side the sentence names as the material winner, and what it is up ("a bishop", "a knight for a pawn",
  // "a new queen"), for the verdict sentence. Null when no side is named.
  let ahead: Side | null = null, up = '';
  if (Math.abs(net) < 1e-9) {
    change = captures.length ? 'the trades are even' : 'no material changes hands';
  } else {
    ahead = net > 0 ? pov : other(pov);
    const behind = other(ahead);
    const [gained, gave] = cancelTrades(captures.filter(c => c.by === ahead).map(c => c.type), captures.filter(c => c.by === behind).map(c => c.type));
    // FX1e (brief 9.12.2 item 1, V1-1): the other side's new pieces cancel against the side's own first (same kinds,
    // then a new bishop for a new knight, as trades cancel), so a new queen on each side is not named at all.
    const [own, theirs] = cancelTrades(promos.filter(p => p.by === ahead).map(p => p.type), promos.filter(p => p.by === behind).map(p => p.type));
    const queens = (c: Side) => start.findPiece({ type: 'q', color: c }).length;
    const gaveText = describe(gave, queens(ahead) === 1), gaveUp = describe(gave, false);
    const parts: string[] = [], upParts: string[] = [];
    if (gained.length) {
      parts.push(`${done ? 'wins' : 'won'} ${describe(gained, queens(behind) === 1)}${gave.length ? ` for ${gaveText}` : ''}`);
      // "is a queen up", never "is the queen up": in this frame the piece is counted, not pointed at.
      upParts.push(`${describe(gained, false)}${gave.length ? ` for ${gaveUp}` : ''}`);
    }
    if (own.length) {
      // FX1e: a side that gained nothing else names what it gave with its promotion ("promotes a pawn to a queen for
      // a knight", "is a new queen for a knight up"); two or more new pieces are each named ("two pawns to two queens").
      const forGave = !gained.length && gave.length > 0;
      parts.push(`${done ? 'promotes' : 'promoted'} ${pawnsTo(own)}${forGave ? ` for ${gaveText}` : ''}`);
      upParts.push(`${listJoin(newPieceParts(own))}${forGave ? ` for ${gaveUp}` : ''}`);
    }
    // net > 0 for `ahead` always leaves a gain or a promotion of its own to name: trades and the cancelled new pieces
    // go in pairs of equal value, and what is left of the other side's only counts against it.
    change = `${colorName(ahead)} ${done ? '' : 'has '}${listJoin(parts)}`;
    up = listJoin(upParts);
    if (theirs.length) {
      // FX1e: a new piece of the other side's that no new piece of this side's cancels is named with its kind, so the
      // sentence adds up to the count: "White wins the queen and a rook, though Black promotes a pawn to a queen."
      // In the "{Side} is … up" frame everything this side got comes first and the other side's gains follow "for",
      // its new pieces by owner: "a queen and a rook for Black's new queen".
      change += `, though ${colorName(behind)} ${done ? '' : 'has '}${own.length ? 'also ' : ''}${done ? 'promotes' : 'promoted'} ${pawnsTo(theirs)}`;
      const plus = [...describeParts(gained, false), ...newPieceParts(own)];
      const minus = [...describeParts(gave, false), ...newPieceParts(theirs, behind)];
      up = `${listJoin(plus)} for ${listJoin(minus)}`;
    }
  }
  // FX1b (brief 9.11.2 (r) 2), before the pending clause: an engine figure against the count replaces the sentence.
  if (ahead && up) {
    const against = verdictAgainst(opts.verdict, ahead);
    if (against) return { summary: `${colorName(ahead)} is ${up} up at the end of this line, but ${against}.` };
  }
  if (done) {
    const settled = `${change.charAt(0).toUpperCase()}${change.slice(1)}.`;
    return { summary: opts.noChangeSentence === false && settled === NO_CHANGE_SENTENCE ? '' : settled };
  }
  const clause = pendingText(pending, opts.omit);
  if (!clause) return { summary: `So far in this line ${change}.` };
  // A clause the side already ahead can act on adds to its lead: "and".
  return { summary: `So far in this line ${change}, ${favours(pending) === ahead ? 'and' : 'but'} ${clause}.` };
}

/**
 * Narrate a UCI line from `fen`. Stops at the first malformed or illegal ply (`stoppedAt`) or after `maxPlies`
 * (default 24, at most 64). Never throws: a bad FEN gives an empty line with `stoppedAt: 0`.
 * `nameMate` (default true): false leaves the mating reply out of a ply's mate clause ("..., but it allows mate in
 * one."), for the line viewer's step captions (brief 9.9.2 b). Facts and the summary do not change. Lessons, hints
 * and coach inputs use the default and keep the SAN.
 * `verdict`, `omit` and `noChangeSentence` are FX1b's (see the header). All three are off by default, so a caller
 * that passes none reads the same text as before fix round 2.
 */
export function narrateLine(fen: string, line: readonly string[], opts?: NarrateOptions): NarratedLine {
  const board = load(fen);
  const cap = Math.max(0, Math.min(HARD_MAX_PLIES, Math.trunc(opts?.maxPlies ?? DEFAULT_MAX_PLIES) || 0));
  const moves = Array.isArray(line) ? line : [];
  if (!board) {
    const side: Side = typeof fen === 'string' && fen.trim().split(/\s+/)[1] === 'b' ? 'b' : 'w';
    return { startFen: fen, plies: [], stoppedAt: 0, material: { pov: side, net: 0, won: [], lost: [], settled: true }, summary: '' };
  }
  const start = load(board.fen())!;
  const pov = board.turn() as Side;
  const plies: NarratedPly[] = [];
  const won: PieceAt[] = [], lost: PieceAt[] = [];
  const captures: Capture[] = [];
  // Square -> index in promoLog, for promoted pieces still on the board (followed as they move).
  const promoted = new Map<string, number>();
  const promoLog: Array<{ by: Side; type: PieceType }> = [];
  let net = 0, stoppedAt: number | undefined, last: Move | null = null;
  for (let i = 0; i < Math.min(cap, moves.length); i++) {
    const fenBefore = board.fen();
    const mv = playUci(board, moves[i]);
    if (!mv) { stoppedAt = i; break; }
    last = mv;
    const by = mv.color as Side;
    if (mv.captured) {
      const s = takenSquare(mv);
      const wasPromoted = promoted.delete(s);
      const taken: PieceAt = { piece: mv.captured, color: other(by), square: s };
      (by === pov ? won : lost).push(taken);
      net += (by === pov ? 1 : -1) * value(mv.captured);
      captures.push({ by, type: wasPromoted ? 'p' : mv.captured });
    }
    const moving = promoted.get(mv.from);
    if (moving !== undefined) { promoted.delete(mv.from); promoted.set(mv.to, moving); }
    if (mv.promotion) {
      promoted.set(mv.to, promoLog.length);
      promoLog.push({ by, type: mv.promotion });
      net += (by === pov ? 1 : -1) * (value(mv.promotion) - 1);
    }
    plies.push(narratePly(i, fenBefore, mv, load(board.fen())!, opts?.nameMate !== false, opts?.omit ?? null));
  }
  // Promotions whose piece is still on the board (one captured later is counted as the pawn it was).
  const promos = [...promoted.values()].sort((a, b) => a - b).map(i => promoLog[i]);
  // The end position, whatever the last ply was (Codex P2: a quiet last move can leave a piece to be taken).
  // The mate-in-one and loose-piece checks count only for a side to move that is level or behind: when the side
  // already ahead is to move, they only add to its lead. The take-back check (A1's) counts for either side.
  const leader: Side | null = net > 0 ? pov : net < 0 ? other(pov) : null;
  const pending: Pending = last && !board.isCheckmate() && !board.isStalemate() ? endpoint(board, last, leader) : null;
  const settled = pending === null;
  const { result, summary } = summarize(pov, start, board, plies, captures, promos, net, pending, {
    verdict: opts?.verdict ?? null, omit: opts?.omit ?? null, noChangeSentence: opts?.noChangeSentence,
  });
  return {
    startFen: fen, plies, ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    material: { pov, net, won, lost, settled }, ...(result ? { result } : {}), summary,
  };
}

/** One move narrated on its own; null when the FEN or the move is bad. */
export function describeMove(fen: string, uci: string): NarratedPly | null {
  return narrateLine(fen, [uci], { maxPlies: 1 }).plies[0] ?? null;
}

/**
 * Plain piece list for prompts and screen readers:
 * "White: Ke1, Qd1, Ra1, Rh1, Bc1, Bf1, Nb1, Ng1; pawns a2, b2, ... h2. Black: ... White to move." (start position)
 * Pieces in the order K, Q, R, B, N, each by square (file, then rank). '' for a bad FEN.
 */
export function boardText(fen: string): string {
  const b = load(fen);
  if (!b) return '';
  const bySquare = (a: PieceAt, z: PieceAt) => (a.square < z.square ? -1 : a.square > z.square ? 1 : 0);
  const side = (c: Side) => {
    const ps = piecesOf(b, c);
    const pieces = (['k', 'q', 'r', 'b', 'n'] as PieceType[]).flatMap(t => ps.filter(p => p.piece === t).sort(bySquare).map(p => `${p.piece.toUpperCase()}${p.square}`));
    const pawns = ps.filter(p => p.piece === 'p').sort(bySquare).map(p => p.square);
    return `${colorName(c)}: ${pieces.join(', ')}${pawns.length ? `; ${pawns.length === 1 ? 'pawn' : 'pawns'} ${pawns.join(', ')}` : ''}.`;
  };
  return `${side('w')} ${side('b')} ${colorName(b.turn() as Side)} to move.`;
}
