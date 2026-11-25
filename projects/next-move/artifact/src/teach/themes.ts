/**
 * M3 hint ladder, level 1 for Lichess puzzles (B1, brief L3): Lichess puzzle theme tags -> one plain sentence that
 * points at the kind of idea without naming the move. Pure; no chess.js.
 *
 * The tags are Lichess's own classification of the whole puzzle line, so the sentences are pointers ("Look for a
 * fork"), not claims about a square. Mate counts: `ideaFromThemes` uses the `mateInN` tag, which holds only at the
 * start of the puzzle; `hints.ts` passes a count it computed from the remaining line instead (`mateIdea`).
 *
 * Priority: mates (count from `mateInN`, plus a pattern pointer for the named patterns below), then the tactical
 * tags in the order of `TACTICAL_THEMES`. Non-tactical tags (crushing, advantage, equality, phases, lengths, master,
 * endgame kinds, ...) are ignored, as is any tag not listed here.
 */

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** "one move", "two moves", "11 moves". */
export const movesWord = (n: number) => `${NUMBER_WORDS[n] ?? String(n)} move${n === 1 ? '' : 's'}`;

/**
 * Named mate patterns (Lichess tags) -> a pointer completing "There is a checkmate in two moves: ...". Only the
 * patterns in the brief are named; the other Lichess mate tags (opera, Pillsbury, epaulette, ...) still carry `mate`
 * and `mateInN`, so they get the plain count sentence.
 */
export const MATE_PATTERNS: ReadonlyArray<readonly [tag: string, pointer: string]> = [
  ['smotheredMate', 'look for a smothered mate, a knight mating a king boxed in by its own pieces'],
  ['backRankMate', 'look for a back-rank mate, against a king shut in on its back rank by its own pieces'],
  ['anastasiaMate', "look for Anastasia's mate, a knight and a rook or queen trapping the king on the edge"],
  ['arabianMate', 'look for the Arabian mate, a rook and a knight mating the king in the corner'],
  ['hookMate', 'look for a hook mate, with a rook, a knight and a pawn working together'],
  ['doubleBishopMate', 'look for a mate by two bishops on neighbouring diagonals'],
  ['bodenMate', "look for Boden's mate, two bishops mating on crossing diagonals"],
  ['dovetailMate', 'look for a dovetail mate, the queen mating right next to the king'],
];

/** Tactical tags in priority order (after mates), each with its one-sentence idea. */
export const TACTICAL_THEMES: ReadonlyArray<readonly [tag: string, idea: string]> = [
  ['doubleCheck', 'Look for a double check: two of your pieces giving check at once, so the king has to move.'],
  ['discoveredCheck', 'Look for a discovered check: move one piece so that another one gives check.'],
  ['discoveredAttack', 'Look for a discovered attack: move one piece out of the way so that a piece behind it attacks.'],
  ['fork', 'Look for a fork: one piece attacking two at once.'],
  // "cannot leave the line" (brief 9.3): true whether or not the pinned piece can still move along the pin line.
  ['pin', 'Look for a pin: a piece that cannot leave the line without exposing a more valuable piece behind it.'],
  ['skewer', 'Look for a skewer: attack a valuable piece so that, when it moves, you can take the piece behind it.'],
  ['xRayAttack', 'Look for an x-ray: one of your pieces attacks or defends a square through an enemy piece.'],
  ['deflection', 'Look for a deflection: pull an enemy piece away from a square or a piece it guards.'],
  ['attraction', 'Look for an attraction: force an enemy piece, often the king, onto a square where it can be hit.'],
  ['clearance', 'Look for a clearance: move a piece out of the way, often with a threat, to free a square or a line.'],
  ['interference', 'Look for an interference: put a piece between two enemy pieces to cut one off from the other.'],
  ['intermezzo', 'Before the obvious move, look for an in-between move with a threat your opponent must answer.'],
  ['capturingDefender', 'Look for a way to take a defender, so that the piece it guarded falls next.'],
  ['trappedPiece', 'An enemy piece has few safe squares: look for a way to trap and win it.'],
  ['hangingPiece', 'An enemy piece is undefended or not defended enough: find it.'],
  ['sacrifice', 'Be ready to give up material: the solution sacrifices to gain more.'],
  ['quietMove', 'The solution includes a quiet move: no check and no capture, but it sets up a threat that cannot be stopped.'],
  ['zugzwang', 'Look for a move that leaves your opponent only bad moves (zugzwang).'],
  ['promotion', 'Look for a way to promote a pawn.'],
  ['advancedPawn', 'One of your pawns is far up the board: put it to work.'],
  ['defensiveMove', 'This is a defensive puzzle: find the precise move that meets your opponent\'s threat.'],
  ['exposedKing', 'The enemy king has few defenders around it: go after it.'],
  ['kingsideAttack', 'Go after the enemy king on the kingside.'],
  ['queensideAttack', 'Go after the enemy king on the queenside.'],
];

const MATE_IN = /^mateIn([1-9])$/;

/** N from a `mateInN` tag (the smallest when several), or null. */
export function mateCountFromThemes(themes: readonly string[]): number | null {
  let best: number | null = null;
  for (const t of Array.isArray(themes) ? themes : []) {
    const m = MATE_IN.exec(t);
    if (m) best = best === null ? Number(m[1]) : Math.min(best, Number(m[1]));
  }
  return best;
}

/** The pattern pointer of the first named mate pattern in MATE_PATTERNS order, or null. */
export function matePattern(themes: readonly string[]): string | null {
  const set = new Set(Array.isArray(themes) ? themes : []);
  return MATE_PATTERNS.find(([tag]) => set.has(tag))?.[1] ?? null;
}

/** True when the tags mark a mating puzzle (`mate`, `mateInN` or a named pattern). */
export function hasMateTheme(themes: readonly string[]): boolean {
  const list = Array.isArray(themes) ? themes : [];
  return list.some(t => t === 'mate' || MATE_IN.test(t)) || matePattern(list) !== null;
}

/**
 * The mate sentence: "There is a checkmate in two moves: look for a back-rank mate, ..." `n` null or not a
 * positive whole number leaves the count out ("There is a checkmate: ...").
 */
export function mateIdea(n: number | null, themes: readonly string[]): string {
  const count = n !== null && Number.isInteger(n) && n > 0 ? ` in ${movesWord(n)}` : '';
  const pattern = matePattern(themes);
  return `There is a checkmate${count}${pattern ? `: ${pattern}` : ''}.`;
}

/** The first non-mate tactical tag in priority order with its sentence, or null. */
export function tacticalIdea(themes: readonly string[]): { tag: string; idea: string } | null {
  const set = new Set(Array.isArray(themes) ? themes : []);
  const hit = TACTICAL_THEMES.find(([tag]) => set.has(tag));
  return hit ? { tag: hit[0], idea: hit[1] } : null;
}

/**
 * First tactical Lichess theme by priority -> one sentence; null when none applies. Mates come first (count from
 * the `mateInN` tag, so this holds at the start of the puzzle), then TACTICAL_THEMES in order.
 */
export function ideaFromThemes(themes: readonly string[]): string | null {
  const list = Array.isArray(themes) ? themes.filter(t => typeof t === 'string') : [];
  if (hasMateTheme(list)) return mateIdea(mateCountFromThemes(list), list);
  return tacticalIdea(list)?.idea ?? null;
}

/**
 * Lichess length tags give the number of plies of the whole puzzle line (solver first): oneMove 1, short 3,
 * long 5, veryLong 7 or more; `mateInN` 2N-1. True when `plies` is consistent with every such tag present, so the
 * tags still describe the line from here; true when no such tag is present (nothing to check against).
 */
export function themesFitLine(themes: readonly string[], plies: number): boolean {
  const set = new Set(Array.isArray(themes) ? themes : []);
  if (set.has('oneMove') && plies !== 1) return false;
  if (set.has('short') && plies !== 3) return false;
  if (set.has('long') && plies !== 5) return false;
  if (set.has('veryLong') && plies < 7) return false;
  const n = mateCountFromThemes([...set]);
  if (n !== null && plies !== 2 * n - 1) return false;
  return true;
}
