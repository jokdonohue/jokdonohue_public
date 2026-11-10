import bank from '../data/puzzles.json';

export interface Puzzle {
  id: string;
  /** Position after the opponent's setup move; solver moves first here. */
  fen: string;
  moves: string[];
  rating: number;
  themes: string[];
  gameUrl: string;
}
export const puzzles: Puzzle[] = bank;
export const loadPuzzles = (): Puzzle[] => puzzles;
export const PUZZLE_SOURCE = { name: 'Lichess open puzzle database', url: 'https://database.lichess.org/#puzzles', license: 'CC0 1.0', imported: '2026-11-08' };
