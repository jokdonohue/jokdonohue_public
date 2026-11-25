import { Chess } from 'chess.js';

export interface ParsedMove {
  san: string;
  uci: string;
  before: string;
  after: string;
  color: 'w' | 'b';
  ply: number;
}
export interface ParsedGame {
  id: string;
  headers: Record<string, string>;
  moves: ParsedMove[];
  pgn: string;
  result: '1-0' | '0-1' | '1/2-1/2';
}
export const PGN_LIMITS = { bytes: 2_000_000, games: 20, plies: 600 };

function stableId(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `game-${(hash >>> 0).toString(16)}`;
}

/** Parse a bounded PGN export locally. Comments and side variations are ignored. */
export function parsePgn(text: string): ParsedGame[] {
  if (!text.trim()) throw new Error('Paste or select a completed-game PGN first.');
  if (new TextEncoder().encode(text).length > PGN_LIMITS.bytes) throw new Error('PGN exceeds the 2 MB import limit.');
  const games: ParsedGame[] = [];
  let headers: Record<string, string> = {};
  let sans: string[] = [];
  let start = 0;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let variation = 0;
  const finish = (result: string, end: number) => {
    if (result === '*') throw new Error('Only completed games can be imported; this game ends with *.');
    if (headers.Result && headers.Result !== result) throw new Error('PGN Result header disagrees with the game result.');
    if (headers.Variant && !['standard', 'chess'].includes(headers.Variant.toLowerCase())) throw new Error('Only standard chess PGNs are supported.');
    if (headers.SetUp === '1' && !headers.FEN) throw new Error('PGN SetUp requires a FEN header.');
    if (sans.length === 0) throw new Error('The PGN contains no moves.');
    if (sans.length > PGN_LIMITS.plies) throw new Error('A game exceeds the 600 half-move import limit.');
    let chess: Chess;
    try { chess = headers.FEN ? new Chess(headers.FEN) : new Chess(); }
    catch { throw new Error('The PGN starting FEN is invalid.'); }
    const moves: ParsedMove[] = [];
    for (const san of sans) {
      const before = chess.fen();
      try {
        if (/^(--|Z0|0000)$/i.test(san)) throw new Error('Null move');
        const move = chess.move(san.replace(/[!?]+$/g, ''), { strict: true });
        moves.push({ san: move.san, uci: `${move.from}${move.to}${move.promotion ?? ''}`, before, after: chess.fen(), color: move.color, ply: moves.length + 1 });
      } catch { throw new Error(`Game ${games.length + 1}: illegal or invalid move “${san}” at half-move ${moves.length + 1}.`); }
    }
    if (chess.isCheckmate() && result !== (chess.turn() === 'w' ? '0-1' : '1-0')) throw new Error('The recorded result contradicts the checkmate position.');
    if ((chess.isStalemate() || chess.isInsufficientMaterial()) && result !== '1/2-1/2') throw new Error('The recorded result contradicts the drawn final position.');
    const pgn = text.slice(start, end).trim();
    games.push({ id: stableId(pgn), headers: { ...headers, Result: result }, moves, pgn, result: result as ParsedGame['result'] });
    if (games.length > PGN_LIMITS.games) throw new Error('Import at most 20 games at a time.');
    headers = {};
    sans = [];
    start = end;
  };
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text[i] === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (text[i] === '{') {
      const end = text.indexOf('}', i + 1);
      if (end < 0) throw new Error('Unclosed PGN comment.');
      i = end + 1; continue;
    }
    if (text[i] === '(') { variation++; i++; continue; }
    if (text[i] === ')') { if (!variation) throw new Error('Unmatched PGN variation.'); variation--; i++; continue; }
    if (variation) { i++; continue; }
    if (text[i] === '[') {
      if (sans.length) throw new Error('A game is missing its final result before the next headers.');
      const tag = text.slice(i).match(/^\[([A-Za-z][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\.)*)"\s*\]/);
      if (!tag) throw new Error('Invalid PGN header.');
      if (headers[tag[1]] !== undefined) throw new Error(`Duplicate PGN header: ${tag[1]}.`);
      headers[tag[1]] = tag[2].replace(/\\(["\\])/g, '$1');
      i += tag[0].length; continue;
    }
    const token = text.slice(i).match(/^[^\s{}();\[\]]+/)?.[0];
    if (!token) throw new Error('Unexpected PGN character.');
    i += token.length;
    // Chess.com commonly joins move numbers to SAN: 1.e4 or 1...e5.
    const move = token.replace(/^\d+\.(?:\.\.)?/, '').replace(/\$\d+$/, '');
    if (!move || /^\$\d+$/.test(move) || /^\.+$/.test(move) || /^[!?]+$/.test(move)) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(move)) finish(move, i);
    else sans.push(move);
  }
  if (variation) throw new Error('Unclosed PGN variation.');
  if (sans.length || Object.keys(headers).length) throw new Error('A final result (1-0, 0-1, or 1/2-1/2) is required for every game.');
  if (!games.length) throw new Error('No completed games found.');
  return games;
}
