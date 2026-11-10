/** Local importer for a bounded prefix of the official CC0 puzzle export.
 * Run: npx tsx scripts/import-puzzles.ts [uncompressed-source.csv]
 * Requires curl and zstd only for online import. No account or writes upstream.
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Chess } from 'chess.js';
import type { Puzzle } from '../lib/puzzles';

const SOURCE = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';
const LIMIT = 60000;
const TARGET = 2000;
const curl = process.argv[2] ? null : spawn('curl', ['--fail', '--silent', '--show-error', '--location', SOURCE], { stdio: ['ignore', 'pipe', 'pipe'] });
const zstd = curl ? spawn('zstd', ['--decompress', '--stdout'], { stdio: ['pipe', 'pipe', 'pipe'] }) : null;
let transportError = '';
curl?.stderr.on('data', chunk => { transportError += String(chunk); });
zstd?.stderr.on('data', chunk => { transportError += String(chunk); });
curl?.stdout.pipe(zstd!.stdin);
// We intentionally stop reading a prefix; EPIPE after closing it is expected.
zstd?.stdin.on('error', () => {});
const input = process.argv[2] ? createReadStream(process.argv[2]) : zstd!.stdout;
const lines = createInterface({ input, crlfDelay: Infinity });
const candidates: { id: string; sourceFen: string; sourceMoves: string[]; rating: number; themes: string[]; gameUrl: string }[] = [];
let scanned = 0;
for await (const line of lines) {
  if (line.startsWith('PuzzleId,')) continue;
  if (++scanned > LIMIT) break;
  const cells = line.split(',');
  if (cells.length < 9) continue;
  const rating = Number(cells[3]);
  if (rating < 600 || rating > 1800 || Number(cells[5]) < 70 || Number(cells[6]) < 100 || Number(cells[4]) > 100) continue;
  candidates.push({ id: cells[0], sourceFen: cells[1], sourceMoves: cells[2].split(' '), rating, themes: cells[7].split(' '), gameUrl: cells[8] });
}
lines.close();
curl?.kill();
zstd?.kill();
if (scanned < 1000) throw new Error(`Insufficient source rows (${scanned}). ${transportError}`);
// Prefix order is puzzle ID, not rating. Deliberately balance difficulty bands
// and include defense/endgame motifs instead of simply taking the first 2000.
const selected = new Map<string, Puzzle>();
const seenFen = new Set<string>();
const add = (row: typeof candidates[number]): boolean => {
  if (selected.has(row.id) || selected.size >= TARGET) return false;
  try {
    const chess = new Chess(row.sourceFen);
    chess.move(row.sourceMoves[0]);
    const fen = chess.fen();
    const fenKey = fen.split(' ').slice(0, 4).join(' ');
    if (seenFen.has(fenKey)) return false;
    const moves = row.sourceMoves.slice(1);
    if (!moves.length) return false;
    for (const move of moves) chess.move(move);
    selected.set(row.id, { id: row.id, fen, moves, rating: row.rating, themes: row.themes, gameUrl: row.gameUrl });
    seenFen.add(fenKey);
    return true;
  } catch { return false; }
};
for (const [theme, quota] of [['defensiveMove', 140], ['equality', 80], ['pawnEndgame', 80], ['rookEndgame', 100], ['promotion', 80], ['endgame', 300]] as const) {
  let count = [...selected.values()].filter(puzzle => puzzle.themes.includes(theme)).length;
  for (const row of candidates) if (count < quota && row.themes.includes(theme) && add(row)) count++;
}
for (let low = 600; low < 1800; low += 200) {
  let count = [...selected.values()].filter(puzzle => puzzle.rating >= low && puzzle.rating < low + 200).length;
  for (const row of candidates) if (count < 333 && row.rating >= low && row.rating < low + 200 && add(row)) count++;
}
for (const row of candidates) add(row);
if (selected.size < 1000) throw new Error(`Only ${selected.size} validated puzzles; expected at least 1000.`);
await mkdir('data', { recursive: true });
const output=JSON.stringify([...selected.values()], null, 2) + '\n';
await writeFile('data/puzzles.json', output);
const themes = Object.fromEntries([...new Set([...selected.values()].flatMap(p => p.themes))].sort().map(theme => [theme, [...selected.values()].filter(p => p.themes.includes(theme)).length]));
console.log(JSON.stringify({ source: SOURCE, license: 'CC0-1.0', scanned: scanned - 1, candidates: candidates.length, imported: selected.size, themes }, null, 2));
await writeFile('data/puzzles.provenance.json', JSON.stringify({source:SOURCE,documentation:'https://database.lichess.org/#puzzles',license:'CC0-1.0',retrieved:new Date().toISOString().slice(0,10),source_rows_examined:Math.min(scanned,LIMIT),sampling:'Deterministic bounded prefix with thematic quotas and rating-band balancing; not statistically representative.',filters:{rating_min:600,rating_max:1800,popularity_min:70,plays_min:100,rating_deviation_max:100},normalization:'Apply the first source move to the source FEN; stored moves begin with the solver. All continuations replayed legally.',count:selected.size,themes,sha256:createHash('sha256').update(output).digest('hex'),importer:'scripts/import-puzzles.ts'},null,2)+'\n');
