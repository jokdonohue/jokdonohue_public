/**
 * M3 hint ladder (B1, brief L3): four levels for the position the learner is solving, each built from computed
 * facts (chess.js through the narrator, and Lichess tags for bank puzzles). Pure and synchronous; never throws.
 *
 *   1 Idea   what kind of idea, without naming the move or the target's square.
 *            bank: the Lichess theme tags (only while the line is the whole puzzle line, see `ply`); mates are
 *            always computed from the line. own-game and agent cards: computed from the narrated answer line.
 *            punish: "The move just played, {SAN}, was yours in the game." plus what that move left (computed from
 *            `justPlayed.fenBefore` when given: a piece of his the line takes, by kind and colour; or "It opened the
 *            diagonal through f7", the square his move left), else the computed idea. Only where that move led to the
 *            position shown (`fenBefore` check; without it, at the card's start only); at a later step the computed
 *            idea. endgame drills: the L9 idea.
 *   2 Target when level 1 named a fact of the first move (fork, pin, capture, threat, castling, a loose piece of
 *            the solver's, a later fork ...), that fact's target. Otherwise: the enemy king (mate), the piece the
 *            line wins after trades cancel, a promotion square, the first move's targets, endgame key squares, a
 *            later target, an attacked piece of the solver's, what a quiet move does (narrator), "The right move
 *            pushes a pawn." for a quiet pawn push (its SAN is its square), else the square the move goes to.
 *   3 Piece  "Use your bishop on c1." (square = from-square)
 *   4 Move   "Play Bxf7+." (arrow = the move, UCI)
 *
 * Every level is always present (four entries, non-empty). A level with nothing tactical computed falls back to a
 * plainer computed fact (for example "The right move is a quiet one: no capture and no check."), never to filler.
 *
 * Wording rules:
 * - Levels 1 to 3 never contain the answer's SAN (punish level 1 names his game move, which can share it). A count
 *   of moves to mate is stated only when it is certain: one move (the first move mates) or a bank line whose
 *   `mateInN` tag fits the remaining line; an engine or Claude line ending in mate is described as such ("the
 *   engine's line ends in mate").
 * - "The right line wins it" only when the line is settled and leaves the solver ahead after trades cancel; the
 *   capture made by the move just played counts too, on every kind (`justPlayed` with `fenBefore`, brief 9.3: a
 *   recapture is never called a win; a capture of unknown kind, or a promotion just played: no such claim).
 * - Pins: "cannot leave the line" when the pinned piece can still move along the pin line, else "cannot move away".
 * - "you" is the side to move (the solver). Punish cards are played from the opponent's side, so their hints name
 *   colours instead ("the white bishop on c1", "a black knight") and say "you" only for the learner's game move.
 * - Tags give pointers ("Look for a back-rank mate"), never claims about a square.
 */
import { Chess, type Move, type Square } from 'chess.js';
import { describeMove, narrateLine, playUci, type NarratedLine, type NarratedPly, type PieceAt } from './narrate';
import { PIECE_NAME, PIECE_VALUE, type PieceType, type Side } from './values';
import { mateCountFromThemes, mateIdea, matePattern, tacticalIdea, themesFitLine } from './themes';

/** `squares` (version 7.3): every square the hint names, when it names more than one (an endgame drill's key squares);
 *  `square` is then the first of them, as before. */
export interface Hint { level: 1 | 2 | 3 | 4; text: string; square?: string; arrow?: string; squares?: readonly string[] }
export interface HintInput {
  fen: string;
  /** Answer line from the CURRENT position, solver first (UCI). */
  line: readonly string[];
  themes: readonly string[];
  kind: 'bank' | 'pack' | 'punish' | 'endgame' | 'agent';
  /**
   * The move just played on the board, the one that led to `fen` (punish at the start: his game move,
   * `byLearner: true`; brief 9.3: at a later step, on every kind, the previous ply, `byLearner: false`).
   * B1 addition, optional: `fenBefore` = the position before that move (punish start: `pack.sourceFen`).
   * With `fenBefore`, checked by replaying the move to `fen`, its capture counts as material the opponent took, on
   * every kind, so a recapture is never called a win. When that check fails, or without `fenBefore`, a capture SAN
   * ("x") leaves the material unknown and no win is claimed (punish cards: only at the start; at a later step his
   * game move is not the move just played). Only punish cards name the move at level 1.
   * Version 7.1 (brief m31 4.6, F2), optional: `label` = how the level-1 head prints that move when its SAN alone could
   * be mixed up with a move of the solver's: the SAN, then the piece and the square it came from ("Rxb5 (the rook from
   * b1)"; punish.ts `playedLabel`). Only the head reads it. `san` stays the bare SAN, and every rule reads `san`.
   */
  justPlayed?: { uci: string; san: string; byLearner: boolean; fenBefore?: string; label?: string };
  /** Endgame drills: the L9 idea (`drillTeach(id).idea`). */
  idea?: string;
  /**
   * B1 addition, optional: index of the current step in the card's moves (0 = start). Bank theme ideas describe
   * the whole puzzle, so they are used only at ply 0. Absent: inferred from the Lichess length tags.
   */
  ply?: number;
  /** B1 addition, optional: endgame drills' key squares (`drillTeach(id).keySquares`), used at level 2. */
  keySquares?: readonly string[];
}

/** Which rule produced each level (diagnostics for tests and the quality sweep; not shown on the page). */
export interface HintRules { idea: string; target: string }

const MAX_PLIES = 32;
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const other = (c: Side): Side => (c === 'w' ? 'b' : 'w');
const colorName = (c: Side) => (c === 'w' ? 'White' : 'Black');
const colorAdj = (c: Side) => (c === 'w' ? 'white' : 'black');
const value = (p: PieceType) => PIECE_VALUE[p];
const positionKey = (fen: string) => fen.trim().split(/\s+/).slice(0, 4).join(' ');
const SLIDER = new Set<PieceType>(['b', 'r', 'q']);

function load(fen: string): Chess | null {
  if (typeof fen !== 'string') return null;
  try { return new Chess(fen); } catch { return null; }
}
const takenSquare = (m: Move) => (m.isEnPassant() ? `${m.to[0]}${m.from[1]}` : m.to);

/**
 * The same position with the other side to move (en passant cleared), for "what could they take right now".
 * Null when the side to move is in check (a null move would be illegal; chess.js does not refuse it itself).
 */
function nullMove(board: Chess): Chess | null {
  if (board.inCheck()) return null;
  const parts = board.fen().split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  return load(parts.join(' '));
}

export interface Loose { piece: PieceType; square: string; by: { piece: PieceType; square: string }; undefended: boolean }
/**
 * Pieces of the side to move that the opponent could legally take right now (pins respected), when undefended or
 * when the cheapest legal taker is worth less. Most valuable first. [] when the side to move is in check.
 */
export function looseNow(fen: string): Loose[] {
  const b = load(fen);
  const nb = b ? nullMove(b) : null;
  if (!b || !nb) return [];
  const side = b.turn() as Side;
  const cheapest = new Map<string, Move>();
  for (const m of nb.moves({ verbose: true })) {
    if (!m.captured || m.isEnPassant()) continue;
    const c = cheapest.get(m.to);
    if (!c || value(m.piece as PieceType) < value(c.piece as PieceType)) cheapest.set(m.to, m);
  }
  const out: Loose[] = [];
  for (const [sq, m] of cheapest) {
    const p = b.get(sq as Square);
    if (!p || p.color !== side || p.type === 'k') continue;
    const undefended = b.attackers(sq as Square, side).length === 0;
    if (undefended || value(m.piece as PieceType) < value(p.type)) out.push({ piece: p.type, square: sq, by: { piece: m.piece as PieceType, square: m.from }, undefended });
  }
  return out.sort((x, y) => value(y.piece) - value(x.piece) || (x.square < y.square ? -1 : 1));
}

// ---------------------------------------------------------------- the line, with piece identities

export interface LineCapture {
  /** Ply index in the line. */
  ply: number;
  by: Side;
  /** Type of the piece where it stood at the start of the line (a pawn that promoted later is a pawn). */
  piece: PieceType;
  /** Its square at the start of the line (the square it stands on now, on the board being solved). */
  origin: string;
  /** Where it was taken. */
  at: string;
}
export interface LineReplay {
  captures: LineCapture[];
  /** origins[i]: current square -> square at the start, before ply i (origins[plies] = after the last ply). */
  origins: Array<Map<string, string>>;
  /** Squares at the start of the pieces that promote in the line. */
  promoted: Set<string>;
}

/** Replays the narrated plies, following each piece back to its square at the start. */
export function replayLine(n: NarratedLine): LineReplay {
  const board = load(n.plies[0]?.fenBefore ?? n.startFen);
  const origin = new Map<string, string>();
  if (board) for (const row of board.board()) for (const c of row) if (c) origin.set(c.square, c.square);
  const startTypes = new Map<string, PieceType>();
  if (board) for (const row of board.board()) for (const c of row) if (c) startTypes.set(c.square, c.type);
  const origins: Array<Map<string, string>> = [];
  const captures: LineCapture[] = [];
  const promoted = new Set<string>();
  for (let i = 0; i < n.plies.length; i++) {
    origins.push(new Map(origin));
    const mv = board ? playUci(board, n.plies[i].uci) : null;
    if (!mv) break;
    if (mv.captured) {
      const at = takenSquare(mv);
      const o = origin.get(at) ?? at;
      origin.delete(at);
      captures.push({ ply: i, by: mv.color as Side, piece: startTypes.get(o) ?? (mv.captured as PieceType), origin: o, at });
    }
    const o = origin.get(mv.from) ?? mv.from;
    origin.delete(mv.from);
    origin.set(mv.to, o);
    if (mv.isKingsideCastle() || mv.isQueensideCastle()) {
      const r = mv.from[1], rf = `${mv.isKingsideCastle() ? 'h' : 'a'}${r}`, rt = `${mv.isKingsideCastle() ? 'f' : 'd'}${r}`;
      const ro = origin.get(rf) ?? rf;
      origin.delete(rf);
      origin.set(rt, ro);
    }
    if (mv.promotion) promoted.add(o);
  }
  origins.push(new Map(origin));
  return { captures, origins, promoted };
}

/**
 * The captures by `side` left after trades cancel (same kind first, then bishop for knight), as the narrator's
 * summary counts them. An earlier capture cancels first, so a gain made at the end of a sequence stays.
 */
export function netWonCaptures(captures: readonly LineCapture[], side: Side): LineCapture[] {
  const mine = captures.filter(c => c.by === side);
  const theirs = captures.filter(c => c.by !== side).map(c => c.piece);
  const minor = (t: PieceType) => t === 'b' || t === 'n';
  for (const pass of [(a: PieceType, b: PieceType) => a === b, (a: PieceType, b: PieceType) => minor(a) && minor(b)]) {
    for (let j = 0; j < theirs.length; j++) {
      const k = mine.findIndex(c => pass(c.piece, theirs[j]));
      if (k >= 0) { mine.splice(k, 1); theirs.splice(j, 1); j--; }
    }
  }
  return mine;
}

/** Is `mid` strictly between `a` and `b` on one rank, file or diagonal? Returns the line kind or null. */
function between(a: string, b: string, mid: string): 'file' | 'rank' | 'diagonal' | null {
  const f = (s: string) => s.charCodeAt(0) - 97, r = (s: string) => Number(s[1]) - 1;
  const df = f(b) - f(a), dr = r(b) - r(a);
  const kind = df === 0 ? 'file' : dr === 0 ? 'rank' : Math.abs(df) === Math.abs(dr) ? 'diagonal' : null;
  if (!kind || (df === 0 && dr === 0)) return null;
  const sf = Math.sign(df), sr = Math.sign(dr);
  for (let x = f(a) + sf, y = r(a) + sr; x !== f(b) || y !== r(b); x += sf, y += sr) {
    if (x === f(mid) && y === r(mid)) return kind;
  }
  return null;
}

// ---------------------------------------------------------------- voice

interface Voice {
  punish: boolean;
  /** "your bishop on c1" | "the white bishop on c1" */
  own(piece: PieceType, sq: string): string;
  /** "the knight on c6" | "the black knight on c6" (kings: "the king on g8" | "the black king on g8") */
  foe(piece: PieceType, sq: string): string;
  /** "you" | "White" */
  you: string;
  /** "You are" | "White is" */
  youAre: string;
  /** "your" | "White's" */
  your: string;
  /** "enemy" | "black" (adjective for the solver's opponent) */
  enemy: string;
}
function voiceFor(solver: Side, punish: boolean): Voice {
  const foe = other(solver);
  if (!punish) {
    return {
      punish, you: 'you', youAre: 'You are', your: 'your', enemy: 'enemy',
      own: (p, s) => `your ${PIECE_NAME[p]} on ${s}`,
      foe: (p, s) => `the ${PIECE_NAME[p]} on ${s}`,
    };
  }
  return {
    punish, you: colorName(solver), youAre: `${colorName(solver)} is`, your: `${colorName(solver)}'s`, enemy: colorAdj(foe),
    own: (p, s) => `the ${colorAdj(solver)} ${PIECE_NAME[p]} on ${s}`,
    foe: (p, s) => `the ${colorAdj(foe)} ${PIECE_NAME[p]} on ${s}`,
  };
}


// ---------------------------------------------------------------- context

interface Ctx {
  input: HintInput;
  n: NarratedLine;
  p0: NarratedPly;
  solver: Side;
  foe: Side;
  start: Chess;
  replay: LineReplay;
  /** Solver plies in the line when it ends in mate given by the solver, else null. */
  mateIn: number | null;
  /**
   * The line is settled and leaves the solver ahead in material. When the move just played (`justPlayed`, any kind)
   * was itself a capture, that capture counts too (a recapture is not a gain); when its kind is unknown, never.
   */
  ahead: boolean;
  /** Solver's captures left after trades cancel, when `ahead`; else []. */
  netWon: LineCapture[];
  voice: Voice;
  /** The moving piece of the first move. */
  piece: PieceType;
  /** Punish: the learner's game move narrated from `justPlayed.fenBefore`, when that matches the card. */
  gameMove: NarratedPly | null;
  /**
   * Punish: `justPlayed` is the move that led to this position, so level 1 may name it. Checked through `fenBefore`
   * when given; without it, assumed only at the card's start (`ply` 0 or absent). At a later step it is not.
   */
  jpHere: boolean;
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const listJoin = (items: string[]) => (items.length <= 1 ? items[0] ?? '' : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const orListJoin = (items: string[]) => (items.length <= 1 ? items[0] ?? '' : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`);
const ordinal = (n: number) => ORDINAL[n - 1] ?? `${n}th`;
function directCheck(after: Chess, mover: Side, movedTo: string[]): boolean {
  const k = after.findPiece({ type: 'k', color: other(mover) })[0];
  return !!k && after.attackers(k, mover).some(s => movedTo.includes(s));
}
/** Squares the moving pieces land on (castling: the king's and the rook's). */
function movedSquares(p: NarratedPly): string[] {
  const to = p.uci.slice(2, 4), from = p.uci.slice(0, 2);
  if (from[0] === 'e' && (to[0] === 'g' || to[0] === 'c') && from[1] === to[1]) {
    const b = load(p.fenBefore);
    if (b?.get(from as Square)?.type === 'k') return [to, `${to[0] === 'g' ? 'f' : 'd'}${to[1]}`];
  }
  return [to];
}
/** Does a narrated ply carry any tactical fact (capture, check, mate, promotion, fork, threat, discovery, pin, castling)? */
export const hasTactic = (p: NarratedPly) => {
  const f = p.facts;
  return !!f.capture || f.check || f.mate || !!f.promotion || f.fork || f.threats.length > 0 || f.discovered.length > 0
    || f.pins.length > 0 || f.castlingStopped.length > 0;
};

/**
 * The ply's new pins that are worth a hint (the narrator's own text filter): not a pawn pinned to a queen or rook,
 * and the pin holds, i.e. the pinned piece cannot take its pinner without losing material.
 */
export function pinsThatHold(p: NarratedPly): NarratedPly['facts']['pins'] {
  const after = load(p.fenAfter);
  if (!after) return [];
  return p.facts.pins.filter(pin => {
    if (pin.pinned.piece === 'p' && pin.behind.piece !== 'k') return false;
    if (p.facts.mate || p.facts.stalemate) return true;
    const canTake = after.moves({ square: pin.pinned.square as Square, verbose: true }).some(m => m.to === pin.by.square);
    const pinnerHeld = after.attackers(pin.by.square as Square, pin.by.color).length > 0 && value(pin.pinned.piece) > value(pin.by.piece);
    return !canTake || pinnerHeld;
  });
}

/**
 * Can the pinned piece still move along its pin line (towards the pinner, or take it)? From its legal moves in the
 * position after the pin, where its side is to move. Legal moves only, so a piece that cannot move right now (for
 * example because its king is also in check) counts as unable to move.
 */
function movesAlongPin(p: NarratedPly, pin: NarratedPly['facts']['pins'][number]): boolean {
  const after = load(p.fenAfter);
  if (!after) return false;
  const f = (s: string) => s.charCodeAt(0) - 97, r = (s: string) => Number(s[1]) - 1;
  const onLine = new Set<string>([pin.by.square]);
  const sf = Math.sign(f(pin.behind.square) - f(pin.by.square)), sr = Math.sign(r(pin.behind.square) - r(pin.by.square));
  if (!sf && !sr) return false;
  for (let x = f(pin.by.square) + sf, y = r(pin.by.square) + sr; x >= 0 && x < 8 && y >= 0 && y < 8; x += sf, y += sr) {
    const s = `${String.fromCharCode(97 + x)}${y + 1}`;
    if (s === pin.behind.square) break;
    onLine.add(s);
  }
  onLine.delete(pin.pinned.square);
  return after.moves({ square: pin.pinned.square as Square, verbose: true }).some(m => onLine.has(m.to));
}

function context(input: HintInput): Ctx | null {
  const line = Array.isArray(input.line) ? input.line : [];
  const n = narrateLine(input.fen, line, { maxPlies: MAX_PLIES });
  const p0 = n.plies[0];
  const start = p0 ? load(p0.fenBefore) : null;
  if (!p0 || !start) return null;
  const solver = p0.color, foe = other(solver);
  const piece = start.get(p0.uci.slice(0, 2) as Square)?.type as PieceType | undefined;
  if (!piece) return null;
  const last = n.plies[n.plies.length - 1];
  const mateIn = n.result === 'mate' && last.color === solver ? n.plies.filter(p => p.color === solver).length : null;
  const replay = replayLine(n);
  // The move just played (every kind; brief 9.3) and whether it was itself a capture: then the line's first gain may
  // only win back what it took, so material is counted from before it. Checked by replaying it from `fenBefore`.
  // A promotion just played leaves the count unknown (the new piece was a pawn a move ago).
  const punish = input.kind === 'punish';
  const jp = input.justPlayed && typeof input.justPlayed === 'object' && typeof input.justPlayed.uci === 'string' ? input.justPlayed : undefined;
  const atStart = !(typeof input.ply === 'number' && Number.isFinite(input.ply) && input.ply > 0);
  let prevMove: NarratedPly | null = null;
  let prior: PieceType | null | 'unknown' = null;
  if (jp) {
    if (typeof jp.fenBefore === 'string') {
      const d = describeMove(jp.fenBefore, jp.uci);
      if (d && positionKey(d.fenAfter) === positionKey(p0.fenBefore)) prevMove = d;
    }
    if (prevMove) prior = prevMove.facts.promotion ? 'unknown' : prevMove.facts.capture?.piece ?? null;
    // Not checked: a capture SAN leaves the material unknown (punish: only at the card's start, where it is his
    // game move; at a later step his game move is not the move just played).
    else if ((punish ? atStart : true) && typeof jp.san === 'string' && jp.san.includes('x')) prior = 'unknown';
  }
  // Punish: his game move (or, at a later step, the move that led there), named at level 1.
  const gameMove = punish ? prevMove : null;
  const jpHere = punish && !!jp && (typeof jp.fenBefore === 'string' ? prevMove !== null : atStart);
  let ahead = false, netWon: LineCapture[] = [];
  if (prior !== 'unknown' && n.material.settled) {
    const net = n.material.net - (prior ? value(prior) : 0);
    if (net > 0) {
      ahead = true;
      const caps = prior ? [{ ply: -1, by: foe, piece: prior, origin: '-', at: '-' }, ...replay.captures] : replay.captures;
      netWon = netWonCaptures(caps, solver);
    }
  }
  return { input, n, p0, solver, foe, start, replay, mateIn, ahead, netWon, voice: voiceFor(solver, input.kind === 'punish'), piece, gameMove, jpHere };
}

/** Is the line still the whole puzzle line (so the Lichess tags describe it)? */
function atPuzzleStart(ctx: Ctx): boolean {
  const ply = ctx.input.ply;
  if (typeof ply === 'number' && Number.isFinite(ply)) return ply === 0;
  return themesFitLine(ctx.input.themes ?? [], ctx.n.plies.length);
}

interface Rule { text: string; rule: string; square?: string; /** 7.3: every square named, when more than one. */ squares?: readonly string[] }

// ---------------------------------------------------------------- level 1

function mateSentence(ctx: Ctx): Rule | null {
  const N = ctx.mateIn;
  if (N === null) return null;
  if (ctx.input.kind === 'bank') {
    const themes = ctx.input.themes ?? [];
    // The Lichess count holds for the remaining line when the tag fits: a mate in T from the start leaves T - k.
    const T = mateCountFromThemes(themes);
    const L = ctx.n.plies.length, ply = ctx.input.ply;
    // With `ply` the remaining length is known exactly; without it, any even number of plies already played fits.
    const left = typeof ply === 'number' && Number.isFinite(ply) ? L === 2 * (T ?? 0) - 1 - ply : (2 * (T ?? 0) - 1 - L) % 2 === 0 && 2 * (T ?? 0) - 1 >= L;
    const fits = T !== null && N <= T && left && ctx.n.stoppedAt === undefined;
    if (fits || N === 1) return { text: mateIdea(N, themes), rule: 'mate-count' };
    // No certain count: the pattern pointer when tagged, else a plain statement about the line.
    return matePattern(themes) ? { text: mateIdea(null, themes), rule: 'mate' } : { text: 'Look for checkmate: the puzzle line ends in mate.', rule: 'mate' };
  }
  if (N === 1) return { text: 'There is a checkmate in one move.', rule: 'mate-count' };
  const who = ctx.input.kind === 'pack' || ctx.input.kind === 'punish' ? "the engine's line" : 'the line';
  return { text: `Look for checkmate: ${who} ends in mate.`, rule: 'mate' };
}

function firstPlyIdea(ctx: Ctx): Rule | null {
  const { p0, voice: v, solver } = ctx;
  const f = p0.facts;
  const after = load(p0.fenAfter);
  if (!after) return null;
  const direct = f.check && directCheck(after, solver, movedSquares(p0));
  const discCheck = f.discovered.some(d => d.target.piece === 'k');
  if (f.check && direct && discCheck) return { text: `Look for a double check: two of ${v.your} pieces giving check at once, so the king has to move.`, rule: 'double-check' };
  if (discCheck) return { text: 'Look for a discovered check: move one piece so that another one gives check.', rule: 'discovered-check' };
  if (f.fork) {
    return direct
      ? { text: 'Look for a fork: a check that also attacks another piece.', rule: 'fork-check' }
      : { text: 'Look for a fork: one move that attacks two pieces at once.', rule: 'fork' };
  }
  if (f.discovered.length) return { text: 'Look for a discovered attack: move one piece out of the way so that a piece behind it attacks.', rule: 'discovered' };
  const pins = pinsThatHold(p0);
  if (pins.length) {
    // The pin level 2 names (king pins sort first). A pinned piece that can still move along the pin line "cannot
    // leave the line" (brief 9.3); "cannot move away" only when it has no such move.
    const pin = pins[0];
    const where = movesAlongPin(p0, pin) ? 'cannot leave the line' : 'cannot move away';
    return pin.behind.piece === 'k'
      ? { text: `Look for a pin: a piece that ${where} because its king stands behind it.`, rule: 'pin' }
      : { text: `Look for a pin: a piece that ${where} without exposing a more valuable piece behind it.`, rule: 'pin' };
  }
  if (f.promotion) return { text: 'Look for a way to promote a pawn.', rule: 'promotion' };
  if (f.capture) {
    const undefended = ctx.start.attackers(f.capture.square as Square, f.capture.color).length === 0;
    if (undefended) return { text: `Look for an undefended ${v.enemy} piece that ${v.you} can take.`, rule: 'capture-free' };
    if (value(f.capture.piece) > value(ctx.piece)) return { text: 'Look for a capture: a cheaper piece can take a more valuable one.', rule: 'capture-up' };
    if (ctx.ahead) return { text: 'Start with a capture: the line wins material.', rule: 'capture-wins' };
    return { text: 'Start with a capture.', rule: 'capture' };
  }
  if (f.castlingStopped.length && !f.check) return { text: `The ${v.enemy} king has not castled yet: look for a move that stops it castling.`, rule: 'castling' };
  if (f.threats.length) {
    return f.threats[0].undefended
      ? { text: 'Look for a move that attacks an undefended piece.', rule: 'threat-free' }
      : { text: 'Look for a move that attacks a more valuable piece.', rule: 'threat-up' };
  }
  if (f.check) return { text: 'Start with a check.', rule: 'check' };
  // A quiet pawn step to the square next to promotion.
  const to = p0.uci.slice(2, 4);
  if (ctx.piece === 'p' && to[1] === (solver === 'w' ? '7' : '2')) return { text: `One of ${v.your} pawns can step up next to its promotion square.`, rule: 'pawn-step' };
  return null;
}

/** A piece of the solver's that is loose now and is no longer loose after the first move. */
function savedPiece(ctx: Ctx): Loose | null {
  const loose = looseNow(ctx.p0.fenBefore);
  if (!loose.length) return null;
  const afterOrigin = ctx.replay.origins[1] ?? new Map<string, string>();
  const stillLoose = new Set(ctx.p0.facts.leftHanging.map(h => afterOrigin.get(h.square) ?? h.square));
  return loose.find(l => !stillLoose.has(l.square)) ?? null;
}

type LaterKind = 'fork' | 'capture' | 'capture-wins' | 'discovered' | 'pin' | 'promotion' | 'threat' | 'check';
const LATER_NAMES: Record<LaterKind, string> = {
  fork: 'A fork', capture: 'A capture', 'capture-wins': 'A capture that wins material', discovered: 'A discovered attack',
  pin: 'A pin', promotion: 'A promotion', check: 'A check', threat: 'An attack on a piece',
};
/** Kinds strong enough to announce at level 1 ("A fork follows on your second move."). */
const STRONG_LATER = new Set<LaterKind>(['fork', 'capture-wins', 'discovered', 'pin', 'promotion']);

/** The first later move of the solver's with a tactical fact. */
function laterPly(ctx: Ctx): { ply: NarratedPly; kind: LaterKind; move: number } | null {
  const won = new Set(ctx.netWon.map(c => c.ply));
  for (const p of ctx.n.plies.slice(1)) {
    if (p.color !== ctx.solver) continue;
    const f = p.facts, move = Math.floor(p.index / 2) + 1;
    if (f.fork) return { ply: p, kind: 'fork', move };
    if (f.capture) return { ply: p, kind: won.has(p.index) ? 'capture-wins' : 'capture', move };
    if (f.discovered.length) return { ply: p, kind: 'discovered', move };
    if (pinsThatHold(p).length) return { ply: p, kind: 'pin', move };
    if (f.promotion) return { ply: p, kind: 'promotion', move };
    if (f.threats.length) return { ply: p, kind: 'threat', move };
    if (f.check) return { ply: p, kind: 'check', move };
  }
  return null;
}

function computedIdea(ctx: Ctx): Rule {
  const v = ctx.voice;
  const mate = mateSentence(ctx);
  if (mate) return mate;
  if (ctx.n.result === 'stalemate') return { text: 'Look for stalemate: a position with no legal move and no check is a draw.', rule: 'stalemate' };
  const first = firstPlyIdea(ctx);
  if (first) return first;
  if (savedPiece(ctx)) return { text: `One of ${v.your} pieces is under attack. The right move keeps it safe.`, rule: 'defend' };
  const inCheck = ctx.start.inCheck();
  const lead = inCheck ? `${v.youAre} in check.` : 'Start with a quiet move (no capture, no check).';
  const later = laterPly(ctx);
  if (later && STRONG_LATER.has(later.kind)) {
    return { text: `${lead} ${LATER_NAMES[later.kind]} follows on ${v.your} ${ordinal(later.move)} move.`, rule: `later-${later.kind}` };
  }
  if (ctx.ahead) return { text: `${lead} The line wins material later.`, rule: 'later-material' };
  if (inCheck) {
    const ways = waysOutOfCheck(ctx.start);
    return ways.length > 1
      ? { text: `${v.youAre} in check: compare every way out (${orListJoin(ways)}).`, rule: 'in-check' }
      : { text: `${v.youAre} in check: the only way out is ${ways[0] ?? 'moving the king'}.`, rule: 'in-check' };
  }
  return { text: 'The right move is a quiet one: no capture and no check.', rule: 'quiet' };
}

/** The kinds of legal replies to a check that exist here, in a fixed order. */
function waysOutOfCheck(board: Chess): string[] {
  const k = board.findPiece({ type: 'k', color: board.turn() })[0];
  const checkers = k ? board.attackers(k, other(board.turn() as Side)) : [];
  const moves = board.moves({ verbose: true });
  const takes = (m: Move) => checkers.includes((m.captured ? takenSquare(m) : m.to) as Square);
  const out: string[] = [];
  if (moves.some(m => m.piece === 'k' && !takes(m))) out.push('moving the king');
  if (moves.some(m => m.piece !== 'k' && !takes(m))) out.push('blocking');
  if (moves.some(takes)) out.push('taking the checking piece');
  return out;
}

/** Punish level 1: what the learner's game move left. */
function whatItLeft(ctx: Ctx): Rule | null {
  if (ctx.mateIn !== null) {
    return ctx.mateIn === 1
      ? { text: 'It allows a checkmate in one move.', rule: 'left-mate' }
      : { text: "It allows a checkmate: the engine's line ends in mate.", rule: 'left-mate' };
  }
  const d = ctx.gameMove, jp = ctx.input.justPlayed;
  if (!d || !jp?.fenBefore) return null;
  const his = d.color, His = colorAdj(his), Solver = colorAdj(ctx.solver);
  const after = load(d.fenAfter);
  if (!after) return null;
  // A piece of his that the answer line later takes. The moved piece counts unless his move was an ordinary
  // trade (it took something worth at least as much).
  const taken = new Set(ctx.replay.captures.filter(c => c.by === ctx.solver).map(c => c.origin));
  const moved = movedSquares(d);
  const movedNow = after.get(moved[0] as Square);
  const trade = !!d.facts.capture && !!movedNow && value(d.facts.capture.piece) >= value(movedNow.type);
  const candidates = d.facts.leftHanging.filter(h => taken.has(h.square) && !(trade && moved.includes(h.square)));
  // Prefer the piece the line wins after trades cancel, so levels 1 and 2 name the same piece.
  const netWon = new Set(ctx.netWon.map(c => c.origin));
  const hit = candidates.find(h => netWon.has(h.square)) ?? candidates[0];
  if (hit) {
    const undefended = after.attackers(hit.square as Square, his).length === 0;
    const name = PIECE_NAME[hit.piece];
    const taker = hit.by.piece === 'k' ? `the ${Solver} king` : `a ${Solver} ${PIECE_NAME[hit.by.piece]}`;
    if (moved.includes(hit.square)) return { text: `It put the ${His} ${name} where ${taker} can take it.`, rule: 'left-moved' };
    // In check before his move, what was loose then cannot be computed (no null move): state wording only.
    if (load(jp.fenBefore)?.inCheck()) {
      return undefended
        ? { text: `After it, a ${His} ${name} is undefended.`, rule: 'left-state' }
        : { text: `After it, ${taker} can take a ${His} ${name}.`, rule: 'left-state' };
    }
    if (looseNow(jp.fenBefore).some(l => l.square === hit.square)) {
      return undefended
        ? { text: `After it, a ${His} ${name} is still undefended.`, rule: 'left-still' }
        : { text: `After it, ${taker} can still take a ${His} ${name}.`, rule: 'left-still' };
    }
    return undefended
      ? { text: `It left a ${His} ${name} undefended.`, rule: 'left-new' }
      : { text: `It left a ${His} ${name} where ${taker} can take it.`, rule: 'left-new' };
  }
  // A line his move opened: the square it left lies on the path of the answer's first move, or between one of the
  // solver's long-range pieces and what it now checks, attacks or pins.
  const vacated = d.uci.slice(0, 2);
  const p0 = ctx.p0, afterFirst = load(p0.fenAfter);
  if (!afterFirst) return null;
  const hisKing = afterFirst.findPiece({ type: 'k', color: his })[0];
  const pairs: Array<{ from: string; to: string; king: boolean }> = [];
  if (SLIDER.has(ctx.piece)) pairs.push({ from: p0.uci.slice(0, 2), to: p0.uci.slice(2, 4), king: false });
  if (p0.facts.check && hisKing) for (const s of afterFirst.attackers(hisKing, ctx.solver)) pairs.push({ from: s, to: hisKing, king: true });
  const targets = [...p0.facts.threats.map(t => t.square), ...p0.facts.discovered.filter(x => x.target.piece !== 'k').map(x => x.target.square)];
  for (const t of targets) for (const s of afterFirst.attackers(t as Square, ctx.solver)) pairs.push({ from: s, to: t, king: false });
  for (const pin of pinsThatHold(p0)) pairs.push({ from: pin.by.square, to: pin.pinned.square, king: false });
  for (const pr of pairs) {
    // A piece of his that only stepped along the line opened nothing (it is the target itself).
    if (moved.includes(pr.to)) continue;
    const slider = pr.from === p0.uci.slice(0, 2) ? ctx.piece : (afterFirst.get(pr.from as Square)?.type as PieceType | undefined);
    if (!slider || !SLIDER.has(slider)) continue;
    const kind = between(pr.from, pr.to, vacated);
    if (kind) return { text: `It opened the ${kind} through ${vacated}${pr.king ? ` to the ${His} king` : ''}.`, rule: 'left-opened' };
  }
  return null;
}

/** "You are in check. " when the solver starts in check and the idea does not already say so. */
function checkLead(ctx: Ctx, text: string): string {
  const lead = `${ctx.voice.youAre} in check.`;
  return ctx.start.inCheck() && !text.startsWith(`${ctx.voice.youAre} in check`) ? `${lead} ${text}` : text;
}

function levelOne(ctx: Ctx): Rule {
  const { input } = ctx;
  if (input.kind === 'endgame' && typeof input.idea === 'string' && input.idea.trim()) return { text: input.idea.trim(), rule: 'endgame-idea' };
  if (input.kind === 'punish' && ctx.jpHere && input.justPlayed && typeof input.justPlayed.san === 'string' && input.justPlayed.san) {
    const jp = input.justPlayed;
    // F2 (brief m31 4.6): `label` is printed in place of the SAN only when it is that SAN plus a note, and the note
    // names neither square of the answer's first move (levels 1 to 3 never give an answer square away).
    const note = typeof jp.label === 'string' && jp.label.startsWith(jp.san) ? jp.label.slice(jp.san.length) : '';
    const name = note.trim() && !note.includes(ctx.p0.uci.slice(0, 2)) && !note.includes(ctx.p0.uci.slice(2, 4)) ? `${jp.san}${note}` : jp.san;
    const head = jp.byLearner ? `The move just played, ${name}, was yours in the game.` : `The move just played was ${name}.`;
    const left = whatItLeft(ctx);
    if (left) return { text: `${head} ${left.text}`, rule: `punish/${left.rule}` };
    const rest = computedIdea(ctx);
    return { text: `${head} ${checkLead(ctx, rest.text)}`, rule: rest.rule };
  }
  if (input.kind === 'bank') {
    const mate = mateSentence(ctx);
    if (mate) return { text: checkLead(ctx, mate.text), rule: `bank/${mate.rule}` };
    if (atPuzzleStart(ctx)) {
      const t = tacticalIdea(input.themes ?? []);
      if (t) return { text: checkLead(ctx, t.idea), rule: `theme:${t.tag}` };
    }
  }
  const idea = computedIdea(ctx);
  return { ...idea, text: checkLead(ctx, idea.text) };
}

// ---------------------------------------------------------------- level 2

/** " Right now it can only go to f8 or h8." for the enemy king (its legal moves if it were its turn). */
function kingRoom(ctx: Ctx, kingSq: string): string {
  const nb = nullMove(ctx.start);
  if (!nb) return '';
  const moves = nb.moves({ square: kingSq as Square, verbose: true });
  // With castling legal the list would include the castling square (g1 or c1), which the king cannot simply step to, so say nothing.
  if (moves.some(m => m.isKingsideCastle() || m.isQueensideCastle())) return '';
  const to = [...new Set(moves.map(m => m.to))].sort();
  // The answer landing on one of those squares would give its destination away (a pawn push's SAN is the square).
  if (to.includes(ctx.p0.uci.slice(2, 4) as Square)) return '';
  if (!to.length) return ' Right now it has no square to go to.';
  if (to.length <= 3) return ` Right now it can only go to ${orListJoin(to)}.`;
  return '';
}

/**
 * Level 2. `ideaRule` is level 1's rule: when level 1 named a fact of the first move (a fork, a pin, a capture,
 * a threat, castling, defending), level 2 names that fact's target, so the two levels tell one story.
 */
function levelTwo(ctx: Ctx, ideaRule: string): Rule {
  const { p0, n, voice: v, solver, input } = ctx;
  const f = p0.facts;
  const ksq = ctx.start.findPiece({ type: 'k', color: ctx.foe })[0] ?? null;
  const king = (sq: string) => v.foe('k', sq);
  const won = new Set(ctx.netWon.map(c => c.origin));
  const wins = (sq: string) => (won.has(sq) ? ' The right line wins it.' : '');
  const best = [...ctx.netWon].sort((a, b) => value(b.piece) - value(a.piece) || a.ply - b.ply)[0] ?? null;
  const rule = ideaRule.replace(/^(punish|bank)\//, '');

  const forkTargets = (): Rule => {
    const after = load(p0.fenAfter)!;
    const direct = f.check && directCheck(after, solver, movedSquares(p0));
    // A forking move that also captures: the piece it takes comes first.
    const named = [...(f.capture ? [v.foe(f.capture.piece, f.capture.square)] : []), ...(direct && ksq ? [king(ksq)] : []), ...f.threats.map(t => v.foe(t.piece, t.square))].slice(0, 3);
    const hit = best && (f.threats.some(t => t.square === best.origin) || f.capture?.square === best.origin) ? best : null;
    const square = hit?.origin ?? f.capture?.square ?? f.threats.find(t => t.piece !== 'k')?.square ?? ksq ?? undefined;
    return { text: `Targets: ${listJoin(named)}.${hit ? ` The right line wins the ${PIECE_NAME[hit.piece]}.` : ''}`, ...(square ? { square } : {}), rule: hit ? 'fork-wins' : 'fork' };
  };
  const discTarget = (): Rule | null => {
    const d = f.discovered.find(x => x.target.piece !== 'k');
    return d ? { text: `Target: ${v.foe(d.target.piece, d.target.square)}.${wins(d.target.square)}`, square: d.target.square, rule: 'discovered' } : null;
  };
  const pinTarget = (): Rule | null => {
    const pin = pinsThatHold(p0)[0];
    if (!pin) return null;
    const behind = pin.behind.piece === 'k' ? king(pin.behind.square) : v.foe(pin.behind.piece, pin.behind.square);
    return { text: `Target: ${v.foe(pin.pinned.piece, pin.pinned.square)}, in front of ${behind}.${wins(pin.pinned.square)}`, square: pin.pinned.square, rule: 'pin' };
  };
  const captureTarget = (): Rule | null => (f.capture ? { text: `Target: ${v.foe(f.capture.piece, f.capture.square)}.${wins(f.capture.square)}`, square: f.capture.square, rule: 'capture' } : null);
  const threatTarget = (): Rule | null => (f.threats.length ? { text: `Target: ${v.foe(f.threats[0].piece, f.threats[0].square)}.${wins(f.threats[0].square)}`, square: f.threats[0].square, rule: 'threat' } : null);
  const castlingTarget = (): Rule | null => {
    if (!f.castlingStopped.length || f.check || !ksq) return null;
    const how = f.castlingStopped.length === 2 ? 'on either side' : f.castlingStopped[0] === 'k' ? 'kingside' : 'queenside';
    return { text: `Target: ${king(ksq)}. The right move stops it castling ${how}.`, square: ksq, rule: 'castling' };
  };
  const checkTarget = (): Rule | null => (f.check && ksq ? { text: `Target: ${king(ksq)}.${kingRoom(ctx, ksq)}`, square: ksq, rule: 'check' } : null);
  const defendTarget = (): Rule | null => {
    const saved = savedPiece(ctx);
    return saved ? { text: `${sentence(v.own(saved.piece, saved.square))} is under attack from ${v.foe(saved.by.piece, saved.by.square)}.`, square: saved.square, rule: 'defend' } : null;
  };
  const laterTarget = (): Rule | null => {
    const later = laterPly(ctx);
    if (!later) return null;
    const g = later.ply.facts, origin = ctx.replay.origins[later.ply.index];
    const back = (sq: string) => origin.get(sq) ?? sq;
    const when = `${v.your} ${ordinal(later.move)} move`;
    if (later.kind === 'fork') {
      const after = load(later.ply.fenAfter);
      const direct = !!after && g.check && directCheck(after, solver, movedSquares(later.ply));
      const ref = (x: PieceAt) => { const sq = back(x.square); return { sq, piece: (ctx.start.get(sq as Square)?.type ?? x.piece) as PieceType }; };
      // A forking move that also captures: the piece it takes comes first.
      const pieces = [...(g.capture ? [ref(g.capture)] : []), ...g.threats.map(ref)];
      const named = [...(direct && ksq ? [king(ksq)] : []), ...pieces.map(p => v.foe(p.piece, p.sq))].slice(0, 3);
      const gain = pieces.find(p => won.has(p.sq));
      const sq = gain?.sq ?? pieces[0]?.sq ?? ksq;
      return { text: `Targets: ${listJoin(named)}. ${sentence(when)} forks them.${gain ? ` The right line wins the ${PIECE_NAME[gain.piece]}.` : ''}`, ...(sq ? { square: sq } : {}), rule: 'later-fork' };
    }
    let t: PieceAt | null = null, verb = 'attacks it';
    if (g.capture) { t = g.capture; verb = 'takes it'; }
    else if (g.discovered.length) { t = g.discovered.find(x => x.target.piece !== 'k')?.target ?? null; verb = 'uncovers an attack on it'; }
    else if (pinsThatHold(later.ply).length) { t = pinsThatHold(later.ply)[0].pinned; verb = 'pins it'; }
    else if (g.threats.length) t = g.threats.find(x => x.piece !== 'k') ?? null;
    if (t) {
      const sq = back(t.square), piece = ctx.start.get(sq as Square)?.type ?? t.piece;
      // A capture that is a net gain "wins" it; otherwise it only "takes" it.
      const how = verb === 'takes it' && won.has(sq) ? 'wins it' : verb;
      return { text: `Target: ${v.foe(piece, sq)}. ${sentence(when)} ${how}.`, square: sq, rule: `later-${later.kind}` };
    }
    if (g.promotion) {
      const sq = later.ply.uci.slice(2, 4);
      return { text: `Target: the promotion square ${sq}. ${sentence(when)} promotes there.`, square: sq, rule: 'later-promotion' };
    }
    if (g.check && ksq) return { text: `Target: ${king(ksq)}. ${sentence(when)} gives check.`, square: ksq, rule: 'later-check' };
    return null;
  };

  // Follow level 1 when it named a fact of the first move.
  const follow: Record<string, () => Rule | null> = {
    fork: forkTargets, 'fork-check': forkTargets, discovered: discTarget, pin: pinTarget,
    'capture-free': captureTarget, 'capture-up': captureTarget, capture: captureTarget,
    'threat-free': threatTarget, 'threat-up': threatTarget, castling: castlingTarget, defend: defendTarget,
    'pawn-step': () => ({ text: `Target: the promotion square ${p0.uci[2]}${solver === 'w' ? '8' : '1'}.`, square: `${p0.uci[2]}${solver === 'w' ? '8' : '1'}`, rule: 'pawn-step' }),
  };
  // "The line wins material later" goes to the general order, which names the piece the line wins.
  const lead = rule.startsWith('later-') && rule !== 'later-material' ? laterTarget : follow[rule];
  const aligned = lead?.();
  if (aligned) return aligned;

  // Otherwise the general order.
  if (ctx.mateIn !== null && ksq) return { text: `Target: ${king(ksq)}.${kingRoom(ctx, ksq)}`, square: ksq, rule: 'mate' };
  if (n.result === 'stalemate') {
    const stuck = other(n.plies[n.plies.length - 1].color);
    const end = ctx.replay.origins[ctx.replay.origins.length - 1];
    const kNow = load(n.plies[n.plies.length - 1].fenAfter)?.findPiece({ type: 'k', color: stuck })[0];
    const kStart = kNow ? end.get(kNow) ?? kNow : null;
    return { text: `Target: stalemate. The line ends with ${colorName(stuck)} having no legal move.`, ...(kStart ? { square: kStart } : {}), rule: 'stalemate' };
  }
  if (best) {
    if (f.fork && (f.threats.some(t => t.square === best.origin) || f.capture?.square === best.origin)) return forkTargets();
    return { text: `Target: ${v.foe(best.piece, best.origin)}. The right line wins it.`, square: best.origin, rule: 'wins' };
  }
  if (ctx.ahead) {
    const promo = n.plies.find(p => p.color === solver && p.facts.promotion);
    if (promo) return { text: `Target: the promotion square ${promo.uci.slice(2, 4)}. The right line makes a new ${PIECE_NAME[promo.facts.promotion!]}.`, square: promo.uci.slice(2, 4), rule: 'promote' };
  }
  if (f.fork) return forkTargets();
  const first = discTarget() ?? pinTarget()
    ?? (f.promotion ? { text: `Target: the promotion square ${p0.uci.slice(2, 4)}.`, square: p0.uci.slice(2, 4), rule: 'promote' } : null)
    ?? captureTarget() ?? threatTarget() ?? castlingTarget() ?? checkTarget();
  if (first) return first;
  if (input.kind === 'endgame' && Array.isArray(input.keySquares)) {
    // A single key square the moving piece is about to leave is stale at that step ("Key square: c7" next to "Use your
    // king on c7"). A list of several stays whole (7.3): they are named as a set, here and in the drill's idea, and a
    // king stepping off one of them (the give-up-the-pawn drill's b6) does not make the set shorter.
    const named = input.keySquares.filter(s => typeof s === 'string' && /^[a-h][1-8]$/.test(s));
    const keys = named.length > 1 ? named : named.filter(s => s !== p0.uci.slice(0, 2));
    if (keys.length) return { text: `Key square${keys.length === 1 ? '' : 's'}: ${listJoin(keys)}.`, square: keys[0], ...(keys.length > 1 ? { squares: keys } : {}), rule: 'key-squares' };
  }
  const later = laterTarget() ?? defendTarget();
  if (later) return later;
  // The narrator's sentence when it says what a quiet move does (defends, out of check, opposition, ...).
  const san = p0.san, to = p0.uci.slice(2, 4);
  const plain = new Set([`${san} moves the ${PIECE_NAME[ctx.piece]} to ${to}.`, `${san} pushes the pawn to ${to}.`]);
  const said = p0.text.startsWith(`${san} `) ? p0.text.slice(san.length + 1) : '';
  // A quiet pawn push's SAN is its square, so its sentence may not name that square ("lets the knight take the pawn on b5").
  const namesPush = ctx.piece === 'p' && new RegExp(`(^|[^a-z0-9])${to}([^a-z0-9]|$)`).test(said);
  // A sentence that ends on a mate the move allows (narrator `allowsMate`) names the opponent's move: not a hint.
  if (!/^O-O/.test(san) && !plain.has(p0.text) && said && !namesPush && !p0.facts.allowsMate) return { text: `The right move ${said}`, rule: 'quiet-text' };
  // A quiet pawn push's SAN is its square, so naming the square would name the move.
  if (ctx.piece === 'p') return { text: 'The right move pushes a pawn.', rule: 'pawn-push' };
  return { text: `The right move goes to ${to}.`, square: to, rule: 'destination' };
}

// ---------------------------------------------------------------- the ladder

function fallback(input: HintInput): { hints: Hint[]; rules: HintRules } {
  const idea = input?.kind === 'endgame' && typeof input.idea === 'string' && input.idea.trim() ? input.idea.trim() : 'Look at checks, captures and threats for both sides.';
  return {
    hints: [
      { level: 1, text: idea },
      { level: 2, text: 'Look for enemy pieces that are undefended or attacked more often than they are defended.' },
      { level: 3, text: 'The stored line for this position could not be read, so there is no piece hint.' },
      { level: 4, text: 'The stored line for this position could not be read, so the move cannot be shown.' },
    ],
    rules: { idea: 'fallback', target: 'fallback' },
  };
}

/** The ladder and the rules that produced levels 1 and 2 (diagnostics). Never throws. */
export function buildHintsWithRules(input: HintInput): { hints: Hint[]; rules: HintRules } {
  let ctx: Ctx | null = null;
  try { ctx = input && typeof input === 'object' ? context(input) : null; } catch { ctx = null; }
  if (!ctx) return fallback(input);
  let one: Rule, two: Rule;
  try { one = levelOne(ctx); } catch { one = { text: 'Look at checks, captures and threats for both sides.', rule: 'error' }; }
  try { two = levelTwo(ctx, one.rule); } catch { two = { text: `The right move goes to ${ctx.p0.uci.slice(2, 4)}.`, square: ctx.p0.uci.slice(2, 4), rule: 'error' }; }
  const from = ctx.p0.uci.slice(0, 2);
  return {
    hints: [
      { level: 1, text: one.text },
      { level: 2, text: two.text, ...(two.square ? { square: two.square } : {}), ...(two.squares?.length ? { squares: two.squares } : {}) },
      { level: 3, text: `Use ${ctx.voice.own(ctx.piece, from)}.`, square: from },
      { level: 4, text: `Play ${ctx.p0.san}.`, arrow: ctx.p0.uci },
    ],
    rules: { idea: one.rule, target: two.rule },
  };
}

/** Four hints, levels 1..4, each non-empty. Never throws. */
export function buildHints(input: HintInput): Hint[] {
  return buildHintsWithRules(input).hints;
}
