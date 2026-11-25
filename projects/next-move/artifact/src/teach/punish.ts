/**
 * M3 punish curation and lesson text (B1, brief L5). Pure and synchronous; never throws.
 *
 * A punish card is the position right after the learner's own game move (`pack.playedUci` from `pack.sourceFen`),
 * played from his opponent's side. `pack.winAfter` is HIS Win% after that move, so the solver's Win% is
 * 100 - winAfter.
 *
 * classifyPunish:
 * - `missed-win`  solver Win% < 50: his move allowed nothing decisive; what cost him was the move he missed (his
 *                 sibling mistake card teaches it). Not served graded.
 * - `small-edge`  50 <= solver Win% < 65: listed with the reading-only punish study items.
 * - `punish`      solver Win% >= 65: served graded.
 * A card without a usable `winAfter` stays `punish` (served as before M3; the curation is page-side and reversible).
 *
 * punishLesson (deterministic, at most 300 characters), from the narrator over the answer line (`pack.pvUci`) and
 * the sibling card `pack-<pack.rowId>` (what he should have played):
 *   punish / small-edge: "In your game you played {SAN}. That allowed {answer}, which {first move's effect}.
 *     Then {key later move of the line}. {outcome}. Better was {sibling's move}."
 *     The outcome is the narrator's material summary (or the mate), else the engine's Win% for the solver after
 *     his move ("only a small edge" from 55 to 65, "about level" below 55). When his game move gave check, "That
 *     allowed" becomes "{Side}'s best reply is". When his game move was a capture, or the card is small-edge, the
 *     material summary (which counts from the card, so a recapture looks like a gain) gives way to the engine's Win%.
 *   missed-win: "In your game you played {SAN}. {Opponent}'s best reply is {answer}, which ... {His side} is still
 *     better (about N% to win). Better was {sibling's move}." (below 55%: "The engine rates the game about level".)
 * Colours name the sides; "you" is only the learner in his game. Optional parts are dropped to stay within 300
 * characters. The sibling's move is shown only when it is legal from `pack.sourceFen`, the sibling's position
 * matches it, and it differs from his game move.
 *
 * Fix round 2 (brief 9.11.3):
 * - R3-4: the second sentence follows the level-1 hint. When that hint says his move left a piece "still" loose (rule
 *   `left-still` in hints.ts: loose before his move and after it), his move did not allow its capture, so the lesson
 *   never says "That allowed {reply}" there. When the reply takes that piece: "Your move left the {piece} on {square}
 *   to be taken: {reply}, which takes it …". When the reply does something else first (the piece falls later in the
 *   line): "{Side}'s best reply is {reply}, which …", as after a check. His move giving check keeps that wording first.
 * - R3-5: when the reply itself mates, the closing "The line ends in checkmate by …" is left out (no mate said twice).
 * - R5-5: `opts.engineFigure: false` leaves out every engine sentence about his move (the Win% figure and the
 *   about-level / still-better words built on it), for a coach input that already carries a live figure.
 *
 * Fix round 3 (brief 9.12.2, FX1e):
 * - Item 3 (V1-6 part 2): "about level" is decided on the figure the sentence prints (rounded), in the small-edge
 *   outcome and in the missed-win standing: 54.95 prints 55 and reads "only a small edge" / "still better".
 * - Item 4 (V1-4): "That allowed {reply}" is decided from the position before his move. When the reply takes a piece of
 *   his that already stood there loose (undefended, or its cheapest legal taker worth less; pawns included; read with
 *   his opponent to move, also when he was in check), his move did not allow it: "{Side}'s best reply is {reply}, …".
 *   The piece he moved does not count. R3-4's left-still wording, tied to the level-1 hint, is unchanged.
 * - Item 5 (V2-3): `opts.betterMove: false` leaves out "Better was {Y}." (the sibling card's move), for PunishStudy's
 *   small edges, which show while that card may still be served. The default keeps it.
 *
 * Version 7.1 (brief m31, sections 4.3 and 4.6):
 * - F1: "That allowed {reply}" needs something to say about the reply. A reply the narrator only places ("moves the
 *   rook to c1"), or one with no tactical fact (`hasTactic`), reads "{Side}'s best reply is {reply}[, which …]."
 *   So the bare "That allowed {reply}." is never written for a quiet reply.
 * - F2: `playedLabel` names his game move for the page. When his SAN is also a legal SAN for the solver on the card
 *   (after his Rxb5 the reply can be Rxb5 too; check and mate marks aside), it adds the piece and the square it came
 *   from: "Rxb5 (the rook from b1)". The lesson's first sentence uses it.
 * - `keyPly`: a later capture that only takes back (it takes the piece that has just taken one of the solver's on that
 *   square, the solver has taken no more on that square than it lost there, and the move does nothing else) is not the
 *   line's point and is never the "Then …" or "Later …" sentence. See `onlyTakesBack`.
 * - `opts.threat` (4.3, row L): what a quiet reply threatens, as sentences the page built from the stored threat line.
 *   They follow the second sentence. The lesson then has no "Then …" / "Later …" sentence, and its outcome is the mate
 *   or the engine's figure, never the stored line's material summary (the threat's own closing sentence states the
 *   material of the threat line). After a game move that was a capture the threat is given without its closing
 *   sentence. Over 300 characters the short form is tried, and then the lesson is built as if no threat were given.
 */
import { Chess, type Square } from 'chess.js';
import { describeMove, narrateLine, playUci, uciOf, type NarratedLine, type NarratedPly } from './narrate';
import { PIECE_NAME, PIECE_VALUE, type PieceType, type Side } from './values';
import { buildHintsWithRules, hasTactic, looseNow, netWonCaptures, replayLine, type LineCapture, type LineReplay } from './hints';

export type PunishClass = 'punish' | 'small-edge' | 'missed-win';
/** Solver Win% thresholds (brief L5). */
export const PUNISH_MIN_WIN = 65;
export const SMALL_EDGE_MIN_WIN = 50;
export const LESSON_MAX_CHARS = 300;

/** Any card with a `pack` detail object (TrainerItem, PackCard, a pack chunk card) fits. */
export interface PunishLike { fen: string; moves: readonly string[]; pack?: object | null }
/** The sibling mistake card `pack-<pack.rowId>`. */
export interface SiblingLike { fen?: string; moves: readonly string[]; pack?: object | null }

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const uciList = (v: unknown) => (Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : null);
const other = (c: Side): Side => (c === 'w' ? 'b' : 'w');
const colorName = (c: Side) => (c === 'w' ? 'White' : 'Black');
const positionKey = (fen: string) => fen.trim().split(/\s+/).slice(0, 4).join(' ');
function load(fen: string): Chess | null {
  try { return new Chess(fen); } catch { return null; }
}

/** The solver's Win% after his move (100 - pack.winAfter), or null when it is missing. */
export function solverWinAfter(card: { pack?: object | null }): number | null {
  const w = num(rec(card?.pack)?.winAfter);
  return w === null ? null : 100 - w;
}

export function classifyPunish(card: { pack?: object | null }): PunishClass {
  const s = solverWinAfter(card);
  if (s === null) return 'punish';
  if (s < SMALL_EDGE_MIN_WIN) return 'missed-win';
  if (s < PUNISH_MIN_WIN) return 'small-edge';
  return 'punish';
}

/** Id of the sibling mistake card (`pack-<pack.rowId>`), or null. */
export function punishSiblingId(card: { pack?: object | null }): string | null {
  const row = str(rec(card?.pack)?.rowId);
  return row ? `pack-${row}` : null;
}

/** The answer line to explain (brief §2): `pack.pvUci` when it starts with the card's move, else `moves`. */
export function punishAnswerLine(card: PunishLike): string[] {
  const moves = uciList(card?.moves) ?? [];
  const pv = uciList(rec(card?.pack)?.pvUci);
  return pv && pv.length && moves.length && pv[0] === moves[0] ? [...pv] : [...moves];
}

/** SAN of his game move: `pack.playedSan`, else computed from `pack.sourceFen` + `pack.playedUci`. */
function playedSanOf(pack: Record<string, unknown>): string | null {
  const given = str(pack.playedSan);
  if (given) return given;
  const src = str(pack.sourceFen), uci = str(pack.playedUci);
  const b = src && uci ? load(src) : null;
  return b ? playUci(b, uci!)?.san ?? null : null;
}

/**
 * F2 (brief m31 4.6): his game move as the page names it. The SAN; and when that same SAN (check and mate marks
 * aside) is also a legal move for the solver in the card's position, the piece and the square it came from as well:
 * "Rxb5 (the rook from b1)", so the two moves cannot be mixed up. '' when the card has no game move. The piece and its
 * square are read from `pack.sourceFen` and `pack.playedUci`, and only when that move, replayed, has this SAN and
 * leads to the card's position; otherwise the bare SAN is returned. Pure; never throws.
 */
export function playedLabel(card: PunishLike): string {
  let san = '';
  try {
    const pack = rec(card?.pack);
    san = (pack && playedSanOf(pack)) || '';
    const board = san && typeof card.fen === 'string' ? load(card.fen) : null;
    // The same words for a reader: "Rxb5" and "Rxb5+" count as one SAN (the check and mate marks are left out).
    const core = (s: string) => s.replace(/[+#]+$/, '');
    if (!pack || !board || !board.moves().some(m => core(m) === core(san))) return san;
    const src = str(pack.sourceFen), uci = str(pack.playedUci);
    const before = src && uci ? load(src) : null;
    const mv = before ? playUci(before, uci!) : null;
    if (!before || !mv || mv.san !== san || positionKey(before.fen()) !== positionKey(board.fen())) return san;
    return `${san} (the ${PIECE_NAME[mv.piece as PieceType]} from ${mv.from})`;
  } catch {
    return san;
  }
}

/** The kind of piece his game move took (from `pack.sourceFen` + `pack.playedUci`), or null. */
function priorCapture(pack: Record<string, unknown>): PieceType | null {
  const src = str(pack.sourceFen), uci = str(pack.playedUci);
  const b = src && uci ? load(src) : null;
  const mv = b ? playUci(b, uci!) : null;
  return (mv?.captured as PieceType | undefined) ?? null;
}

/** The sibling's move as SAN from `pack.sourceFen`, with the guards in the header; null when any guard fails. */
export function betterMoveSan(card: PunishLike, sibling?: SiblingLike | null): string | null {
  const pack = rec(card?.pack);
  if (!pack || !sibling) return null;
  const src = str(pack.sourceFen);
  const fen = src ?? str(sibling.fen);
  const uci = uciList(sibling.moves)?.[0];
  if (!fen || !uci) return null;
  const board = load(fen);
  if (!board) return null;
  if (src && str(sibling.fen)) {
    const sib = load(sibling.fen as string);
    if (!sib || positionKey(sib.fen()) !== positionKey(board.fen())) return null;
  }
  const playedUci = str(pack.playedUci);
  let played: string | null = null;
  if (playedUci) { const b = load(board.fen()); const m = b ? playUci(b, playedUci) : null; played = m ? uciOf(m) : null; }
  const mv = playUci(board, uci);
  if (!mv) return null;
  if (played && uciOf(mv) === played) return null;
  return mv.san;
}

/** The narrated ply's sentence without its SAN and final period, or '' when it only says where the piece went. */
function clauseOf(p: NarratedPly): string {
  const san = p.san;
  if (!p.text.startsWith(`${san} `)) return '';
  const b = load(p.fenBefore);
  const piece = b?.get(p.uci.slice(0, 2) as Square)?.type as PieceType | undefined;
  const to = p.uci.slice(2, 4);
  if (piece && (p.text === `${san} moves the ${PIECE_NAME[piece]} to ${to}.` || p.text === `${san} pushes the pawn to ${to}.`)) return '';
  if (/^O-O/.test(san) && !hasTactic(p)) return '';
  return p.text.slice(san.length + 1).replace(/\.$/, '');
}

/**
 * Version 7.1 (brief m31 4.6, `keyPly`): does this move only take back? All three hold:
 * - it takes the piece that has just taken a piece of the mover's side on that square (the ply before it was a capture
 *   that landed there);
 * - counting every capture on that square so far in the line, this one included, the mover's side has taken no more
 *   there than it has lost there (pawn 1, knight and bishop 3, rook 5, queen 9). So a queen taken for the pawn it took
 *   is a gain, and so is the last capture of an exchange the mover began on that square (bishop takes bishop, knight
 *   takes back, queen takes the knight): neither only takes back;
 * - the move does nothing else: no check, mate, promotion, fork, threat, discovered attack, pin or stopped castling.
 */
function onlyTakesBack(n: NarratedLine, p: NarratedPly): boolean {
  const prev = n.plies[p.index - 1], square = p.uci.slice(2, 4);
  if (!prev || !p.facts.capture || !prev.facts.capture || prev.color === p.color || prev.uci.slice(2, 4) !== square) return false;
  let taken = 0, lost = 0;
  for (const q of n.plies.slice(0, p.index + 1)) {
    const c = q.facts.capture;
    if (!c || q.uci.slice(2, 4) !== square) continue;
    if (q.color === p.color) taken += PIECE_VALUE[c.piece as PieceType]; else lost += PIECE_VALUE[c.piece as PieceType];
  }
  if (taken > lost) return false;
  const f = p.facts;
  return !(f.check || f.mate || f.promotion || f.fork || f.threats.length || f.discovered.length || f.pins.length || f.castlingStopped.length);
}

/**
 * The later move of the solver's that carries the line's point: the mate, else the capture that wins material
 * (after trades cancel), else a promotion; when the first move has no tactical fact, else the first later move
 * that has one. Version 7.1: never a capture that only takes back (`onlyTakesBack`); the next candidate is looked at.
 */
function keyPly(n: NarratedLine, solver: Side, prior: PieceType | null): NarratedPly | null {
  const later = n.plies.filter(p => p.index > 0 && p.color === solver && !onlyTakesBack(n, p));
  const last = n.plies[n.plies.length - 1];
  if (n.result === 'mate' && last && last.color === solver && last.index > 0) return last;
  // His game move's own capture counts as a capture by his side (a recapture is not a gain).
  const net = n.material.net - (prior ? PIECE_VALUE[prior] : 0);
  if (net > 0) {
    const caps = replayLine(n).captures;
    const all = prior ? [{ ply: -1, by: other(solver), piece: prior, origin: '-', at: '-' }, ...caps] : caps;
    const won = new Set(netWonCaptures(all, solver).map(c => c.ply));
    // F1: the narrator now marks more line ends as unsettled (Codex P2: something can still be taken at the end).
    // That hides no winning capture made earlier in the line; only a capture on the last ply, which may still be
    // taken back, is skipped then. The sentence narrates the move; the outcome stays the engine's number.
    const hit = later.find(p => won.has(p.index) && (n.material.settled || p.index < n.plies.length - 1));
    if (hit) return hit;
  }
  const promo = later.find(p => p.facts.promotion);
  if (promo) return promo;
  if (n.plies[0] && !hasTactic(n.plies[0])) return later.find(hasTactic) ?? null;
  return null;
}

/** The whole number a figure prints as. FX1e (brief 9.12.2 item 3): "about level" is decided on this same number. */
const shown = (x: number) => Math.round(Math.max(0, Math.min(100, x)));
const pct = (x: number) => `${shown(x)}%`;
/** Below this printed figure (for the side named) the lesson says "about level" (brief L5). */
const ABOUT_LEVEL_BELOW = 55;

/** Squares his move's piece stands on after it (castling: the king's and the rook's), as hints.ts counts them. */
function movedSquares(p: NarratedPly): string[] {
  const to = p.uci.slice(2, 4), from = p.uci.slice(0, 2);
  if (from[0] === 'e' && (to[0] === 'g' || to[0] === 'c') && from[1] === to[1]) {
    const b = load(p.fenBefore);
    if (b?.get(from as Square)?.type === 'k') return [to, `${to[0] === 'g' ? 'f' : 'd'}${to[1]}`];
  }
  return [to];
}

/** Squares (at the card's start) of the pieces the line wins after trades cancel, counted as hints.ts counts them. */
function netWonOrigins(n: NarratedLine, replay: LineReplay, solver: Side, gameMove: NarratedPly): Set<string> {
  // His game move's own capture counts as a capture by his side; a promotion leaves the count unknown.
  if (gameMove.facts.promotion || !n.material.settled) return new Set();
  const prior = (gameMove.facts.capture?.piece as PieceType | undefined) ?? null;
  if (n.material.net - (prior ? PIECE_VALUE[prior] : 0) <= 0) return new Set();
  const caps: LineCapture[] = prior ? [{ ply: -1, by: other(solver), piece: prior, origin: '-', at: '-' }, ...replay.captures] : replay.captures;
  return new Set(netWonCaptures(caps, solver).map(c => c.origin));
}

/** A piece of his: its kind and its square at the card's start. */
export interface LeftPiece { piece: PieceType; square: string }

/**
 * R3-4's target: the piece the card's level-1 hint calls still loose. The piece is picked as hints.ts picks it; then
 * the rule is read from `buildHintsWithRules` with the input the page builds at step 0 (his game move from
 * `pack.sourceFen`), so the lesson and the hint never disagree. Null for any other rule, or when the pick cannot be
 * repeated (then the lesson keeps its other wording).
 */
function stillLoose(card: PunishLike, pack: Record<string, unknown>, line: readonly string[], n: NarratedLine): LeftPiece | null {
  const src = str(pack.sourceFen), uci = str(pack.playedUci), san = playedSanOf(pack);
  const p0 = n.plies[0];
  if (!src || !uci || !san || !p0) return null;
  // hints.ts `whatItLeft`: his pieces that his move left loose and that the line later takes (his moved piece only when
  // his move was not an ordinary trade), the one the line wins after trades cancel first. This cheap pick runs first;
  // the hint's own rule (below) is asked only when it finds a piece that was loose before his move too.
  const replay = replayLine(n);
  const taken = new Set(replay.captures.filter(c => c.by === p0.color).map(c => c.origin));
  if (!taken.size) return null; // the line takes nothing of his: no such piece
  const d = describeMove(src, uci);
  if (!d || positionKey(d.fenAfter) !== positionKey(p0.fenBefore)) return null;
  const moved = movedSquares(d);
  const movedNow = load(d.fenAfter)?.get(moved[0] as Square);
  const trade = !!d.facts.capture && !!movedNow && PIECE_VALUE[d.facts.capture.piece as PieceType] >= PIECE_VALUE[movedNow.type as PieceType];
  const candidates = d.facts.leftHanging.filter(h => taken.has(h.square) && !(trade && moved.includes(h.square)));
  const won = netWonOrigins(n, replay, p0.color, d);
  const hit = candidates.find(h => won.has(h.square)) ?? candidates[0];
  // The rule's own conditions: not the piece he moved, and loose before his move too.
  if (!hit || moved.includes(hit.square) || !looseNow(src).some(l => l.square === hit.square)) return null;
  // The level-1 hint decides (a mate the line ends in, or his move from check, gives another rule).
  const raw = (card as { themes?: unknown }).themes;
  const themes = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
  const { rules } = buildHintsWithRules({ fen: card.fen, line, themes, kind: 'punish', ply: 0, justPlayed: { uci, san, byLearner: true, fenBefore: src } });
  return rules.idea === 'punish/left-still' ? { piece: hit.piece as PieceType, square: hit.square } : null;
}

/**
 * R3-4 (brief 9.11.3): the piece of his that the card's level-1 hint calls still loose (rule `left-still`: loose
 * before his game move and still loose after it, and taken later in the answer line), or null when the hint gives
 * any other rule. Pure; never throws.
 */
export function leftStillPiece(card: PunishLike): LeftPiece | null {
  try {
    const pack = rec(card?.pack);
    if (!pack || typeof card.fen !== 'string') return null;
    const line = punishAnswerLine(card);
    return line.length ? stillLoose(card, pack, line, narrateLine(card.fen, line, { maxPlies: 32 })) : null;
  } catch {
    return null;
  }
}

/** Options for `punishLesson`. */
export interface PunishLessonOptions {
  /**
   * R5-5 (brief 9.11.3). Default true. False leaves out every engine sentence about his move: the Win% figure
   * ("After your move the engine gives Black about 85% to win.") and the about-level or still-better words built on it.
   * A coach input that already carries a live figure for this position asks for that; the page keeps the default.
   */
  engineFigure?: boolean;
  /**
   * FX1e (brief 9.12.2 item 5, V2-3). Default true. False leaves out "Better was {Y}." (the sibling card's move, which
   * is the answer of a card practice may still serve). PunishStudy's small edges ask for that; a practice card keeps
   * the sentence once it is finished, as before.
   */
  betterMove?: boolean;
  /**
   * Version 7.1 (brief m31 4.3, row L). What the card's quiet reply threatens, as finished sentences (the page builds
   * them from the stored threat line with `threatSay` in threat.ts; this module does not import it): `full` with the
   * threat line and its closing sentence, `fullNoClosing` without that closing sentence, `short` the first sentence
   * alone. Absent: the lesson is the one version 7 writes. With it:
   * - the threat follows the second sentence: `fullNoClosing` when his game move was a capture (the closing sentence
   *   counts material from the card, where his capture is already made), else `full`;
   * - the lesson has no "Then …" / "Later …" sentence;
   * - its outcome sentence is the mate, else the engine's figure when the lesson has one; the stored line's material
   *   summary is left out;
   * - over `LESSON_MAX_CHARS` the same lesson is tried with `short`, and then the lesson is built exactly as without
   *   this option.
   * A part that is not a non-empty string counts as absent.
   */
  threat?: { full: string; fullNoClosing: string; short: string };
}

/**
 * The threat sentences to try, in order (brief m31 4.3): the full one (without its closing sentence after a capture by
 * him), then the short one. Anything that is not a non-empty string is left out, so a bad option changes nothing.
 */
function threatTexts(threat: unknown, hisCapture: boolean): string[] {
  const t = rec(threat);
  if (!t) return [];
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return [text(hisCapture ? t.fullNoClosing : t.full), text(t.short)].filter(Boolean);
}

/**
 * FX1e (brief 9.12.2 item 4, V1-4): could `by` take the piece on `square` at once if it were its move in `fen`, and is
 * that piece loose there (undefended, or its cheapest legal taker is worth less; pawns included)? Read on a copy of
 * the position with `by` to move (en passant cleared), as hints.ts `looseNow` reads it, and also when the side to move
 * is in check in `fen` (`looseNow` gives nothing then; here the answer can only widen "best reply", never "allowed").
 */
function looseTo(fen: string, square: string, by: Side): boolean {
  const fields = fen.trim().split(/\s+/);
  if (fields.length < 4) return false;
  const b = load([fields[0], by, fields[2], '-', '0', fields[5] ?? '1'].join(' '));
  const target = b?.get(square as Square);
  if (!b || !target || target.color === by || target.type === 'k') return false;
  let cheapest = Infinity;
  try {
    for (const a of b.attackers(square as Square, by)) {
      for (const m of b.moves({ square: a, verbose: true })) if (m.captured && m.to === square && !m.isEnPassant()) cheapest = Math.min(cheapest, PIECE_VALUE[m.piece as PieceType]);
    }
  } catch { return false; }
  if (cheapest === Infinity) return false;
  return b.attackers(square as Square, target.color).length === 0 || cheapest < PIECE_VALUE[target.type as PieceType];
}

/**
 * FX1e (brief 9.12.2 item 4, V1-4): does the answer's first move take a piece of his that was already loose in the
 * position before his game move (and so can still be taken after it: the reply takes it)? Then his move did not allow
 * that capture. The piece he moved does not count (it was not there before; castling moves the rook too).
 * Loose after his move is not also required to be undefended or cheaper-taken: his move may have defended the piece
 * and the reply still takes it (two of V1-4's six cards), and the plain "best reply" is true either way.
 */
function replyTakesLooseBefore(pack: Record<string, unknown>, p0: NarratedPly): boolean {
  const cap = p0.facts.capture;
  const src = str(pack.sourceFen), uci = str(pack.playedUci);
  if (!cap || !src || !uci) return false;
  const d = describeMove(src, uci);
  if (!d || positionKey(d.fenAfter) !== positionKey(p0.fenBefore) || movedSquares(d).includes(cap.square)) return false;
  const was = load(src)?.get(cap.square as Square);
  if (!was || was.color !== cap.color || was.type !== cap.piece) return false;
  return looseTo(src, cap.square, p0.color);
}

/** Lesson text for a punish card (header); null when the card has no usable line or game move. */
export function punishLesson(card: PunishLike, sibling?: SiblingLike | null, opts: PunishLessonOptions = {}): string | null {
  try {
    const pack = rec(card?.pack);
    if (!pack || typeof card.fen !== 'string') return null;
    const line = punishAnswerLine(card);
    if (!line.length) return null;
    const n = narrateLine(card.fen, line, { maxPlies: 32 });
    const p0 = n.plies[0];
    if (!p0) return null;
    const played = playedSanOf(pack);
    if (!played) return null;
    const solver = p0.color, his = other(solver);
    const Solver = colorName(solver), His = colorName(his);
    const cls = classifyPunish(card);
    const solverWin = solverWinAfter(card);
    const figure = opts?.engineFigure !== false;
    const better = opts?.betterMove === false ? null : betterMoveSan(card, sibling);
    const clause = clauseOf(p0);
    // F2 (brief m31 4.6): his move with its piece and from-square when the solver could play the same SAN.
    const s1 = `In your game you played ${playedLabel(card) || played}.`;
    const tail = better ? `Better was ${better}.` : '';
    const reply = (withClause: boolean) => `${Solver}'s best reply is ${p0.san}${withClause && clause ? `, which ${clause}` : ''}.`;
    // His game move was a capture (the test the outcome sentence uses below).
    const hisCapture = played.includes('x');
    // Brief m31 4.3: the threat sentences to try before the lesson without one (none without the option).
    const threats = threatTexts(opts?.threat, hisCapture);

    if (cls === 'missed-win' && solverWin !== null) {
      // Near 50% "still better" overclaims: below 55 the game is called about level, as on small-edge cards.
      const hisWin = 100 - solverWin;
      const standing = !figure ? ''
        : shown(hisWin) < ABOUT_LEVEL_BELOW
          ? `The engine rates the game about level (${His} about ${pct(hisWin)} to win).`
          : `${His} is still better (about ${pct(hisWin)} to win).`;
      return fit([...threats.map(t => [s1, reply(true), t, standing, tail]), [s1, reply(true), standing, tail], [s1, reply(false), standing, tail]]);
    }

    // His move gave check: the answer gets out of check, which his move did not "allow".
    const inCheck = load(p0.fenBefore)?.inCheck() ?? false;
    // R3-4: a piece the level-1 hint calls still loose was loose before his move too, so his move did not "allow" its
    // capture. The reply that takes it says so; a reply that does something else first gets the plain "best reply".
    const still = inCheck ? null : stillLoose(card, pack, line, n);
    const cap = p0.facts.capture;
    const takesStill = !!still && !!cap && cap.square === still.square && cap.piece === still.piece;
    let s2full: string, s2short: string;
    // FX1e (brief 9.12.2 item 4, V1-4): decided from the position before his move. A reply that takes a piece which
    // was already loose there (and can still be taken now: the reply takes it) was not allowed by his move: the plain
    // "best reply" (the level-1 hint gives that card another rule, so "Your move left …" stays with left-still).
    // F1 (brief m31 4.6): a reply the narrator says nothing about, or one with no tactical fact, is the "best reply"
    // too: "That allowed {reply}." alone says nothing about what his move allowed.
    if (inCheck || (still && !takesStill) || (!still && replyTakesLooseBefore(pack, p0)) || !clause || !hasTactic(p0)) {
      s2full = reply(true); s2short = reply(false);
    } else if (still) {
      const name = PIECE_NAME[still.piece], plain = `takes the ${name} on ${still.square}`;
      const it = clause.startsWith(plain) ? `takes it${clause.slice(plain.length)}` : clause;
      const head = `Your move left the ${name} on ${still.square} to be taken: ${p0.san}`;
      s2full = `${head}${it ? `, which ${it}` : ''}.`; s2short = `${head}.`;
    } else {
      s2full = `That allowed ${p0.san}${clause ? `, which ${clause}` : ''}.`; s2short = `That allowed ${p0.san}.`;
    }
    const key = keyPly(n, solver, priorCapture(pack));
    let s3 = key ? `${key.index === 2 ? 'Then' : 'Later'} ${key.text}` : '';
    // Do not repeat a "but ... can take ..." clause the first sentence already gave.
    const but = /, but [^,.]+ can take [^,.]+/.exec(clause)?.[0];
    if (but && s3.includes(but)) s3 = s3.replace(but, '');
    // The outcome. The narrator's material summary counts from the card; when his game move was itself a capture,
    // the first gain may only win back what he took, so the engine's number is used instead. A small-edge card
    // always gets the engine's number: a line that wins material can still leave the game about level.
    // The engine's sentence about his move ('' without a figure, or when `engineFigure` is false).
    const engine = solverWin === null || !figure ? ''
      : cls !== 'small-edge'
        ? `After your move the engine gives ${Solver} about ${pct(solverWin)} to win.`
        : shown(solverWin) < ABOUT_LEVEL_BELOW
          ? `After your move the engine rates the game about level (${Solver} about ${pct(solverWin)} to win).`
          : `After your move the engine gives ${Solver} about ${pct(solverWin)} to win, only a small edge.`;
    let s4 = '', s4IsEngine = false;
    const mateBySolver = n.result === 'mate' && n.plies[n.plies.length - 1].color === solver;
    if (mateBySolver) {
      // R3-5: a reply that mates at once already says so in the second sentence.
      if (!p0.facts.mate && (!key || key.index !== n.plies.length - 1)) s4 = n.summary;
    } else if (n.material.settled && n.material.net > 0 && !hisCapture && cls !== 'small-edge') {
      s4 = n.summary;
    } else if (engine) {
      s4IsEngine = true;
      s4 = engine;
    }
    // Brief m31 4.3: beside a threat sentence there is no "Then …" / "Later …" sentence, so a mate the line ends in is
    // always said here (unless the reply itself mates); otherwise the outcome is the engine's sentence, never the
    // stored line's material summary.
    const s4threat = mateBySolver ? (p0.facts.mate ? '' : n.summary) : engine;
    // Over the limit: drop the less telling of the later move and the outcome first (the engine's number is the
    // point of a positional punish; the material summary repeats the later capture).
    const dropFirst = s4IsEngine ? [s1, s2full, s4, tail] : [s1, s2full, s3, tail];
    return fit([
      // The threat in full, then in short; when neither fits, the candidates below, which are the lesson without one.
      ...threats.map(t => [s1, s2full, t, s4threat, tail]),
      [s1, s2full, s3, s4, tail],
      dropFirst,
      [s1, s2full, tail],
      [s1, s2short, ...(s4IsEngine ? [s4] : [s3]), tail],
      [s1, s2short, tail],
    ]);
  } catch {
    return null;
  }
}

/** The first candidate (parts joined) within LESSON_MAX_CHARS; the last one cut at a word if none fits. */
function fit(candidates: string[][]): string {
  const texts = candidates.map(parts => parts.filter(Boolean).join(' '));
  const ok = texts.find(t => t.length <= LESSON_MAX_CHARS);
  if (ok) return ok;
  const last = texts[texts.length - 1];
  const cut = last.slice(0, LESSON_MAX_CHARS - 1);
  return `${cut.slice(0, Math.max(0, cut.lastIndexOf(' ')))}.`;
}
