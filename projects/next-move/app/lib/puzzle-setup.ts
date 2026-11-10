import setup from '../data/puzzle-setup.json';

/**
 * The opponent's move that led to each Lichess puzzle position (Lichess `Moves[0]`), highlighted when a puzzle loads
 * (QA P2-14). Built by scripts/import-puzzle-setup.ts; provenance in data/puzzle-setup.provenance.json.
 * Endgame drills and personal cards have no recorded previous move, so they return undefined.
 */
const SETUP: Record<string, string> = setup;
export const setupMove = (id: string): string | undefined => Object.prototype.hasOwnProperty.call(SETUP, id) ? SETUP[id] : undefined;
