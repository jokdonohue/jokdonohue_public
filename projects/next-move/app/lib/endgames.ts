import drills from '../data/technical_endgames.json';
import type { PersonalPuzzle } from './training-state';

/**
 * Technical-endgame drills: 26 positions (13 to win, 13 to hold the draw), tablebase-verified,
 * in the bank's puzzle shape. Provenance: data/technical_endgames.provenance.json.
 * The solver moves first; opponent replies are scripted, so there is no resisting engine.
 */
export const endgameDrills: PersonalPuzzle[] = drills;
export const ENDGAME_TECH = 'endgame-tech';
export const isEndgameDrill = (puzzle: { themes: string[] } | null | undefined) => !!puzzle?.themes.includes(ENDGAME_TECH);
