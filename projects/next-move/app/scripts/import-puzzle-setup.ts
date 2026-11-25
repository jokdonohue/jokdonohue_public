/**
 * Build data/puzzle-setup.json: for each puzzle in data/puzzles.json, the opponent's setup move (Lichess `Moves[0]`),
 * which scripts/import-puzzles.ts applies but does not store. The app highlights it when a puzzle loads (QA P2-14).
 *
 * Run from app/:
 *   node --import tsx scripts/import-puzzle-setup.ts [../opus/puzzle-bank/raw-setup.json]
 *
 * Source: opus/puzzle-bank/raw-setup.json (`id -> {fen, setup}`, the raw FEN before the setup move and that move;
 * see opus/puzzle-bank/README.md §raw-setup.json). Every entry is replayed with chess.js and must reproduce the
 * bundled puzzle FEN exactly; any missing or mismatching id stops the build and nothing is written.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.resolve(process.argv[2] ?? path.join(appDir, '../opus/puzzle-bank/raw-setup.json'));
const sourceBytes = readFileSync(sourcePath);
const raw = JSON.parse(sourceBytes.toString('utf8')) as Record<string, { fen: string; setup: string }>;
const puzzles = JSON.parse(readFileSync(path.join(appDir, 'data/puzzles.json'), 'utf8')) as { id: string; fen: string }[];

const setup: Record<string, string> = {}, problems: string[] = [];
for (const puzzle of puzzles) {
  const entry = raw[puzzle.id];
  if (!entry) { problems.push(`${puzzle.id}: missing`); continue; }
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(entry.setup)) { problems.push(`${puzzle.id}: setup is not UCI`); continue; }
  try {
    const board = new Chess(entry.fen);
    board.move(entry.setup);
    if (board.fen() !== puzzle.fen) problems.push(`${puzzle.id}: replay does not give the bundled FEN`);
    else setup[puzzle.id] = entry.setup;
  } catch { problems.push(`${puzzle.id}: setup move is illegal`); }
}
if (problems.length) { console.error(`${problems.length} problem(s). First: ${problems.slice(0, 10).join(' | ')}`); process.exit(1); }

const text = `${JSON.stringify(setup)}\n`;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
await writeFile(path.join(appDir, 'data/puzzle-setup.json'), text);
await writeFile(path.join(appDir, 'data/puzzle-setup.provenance.json'), `${JSON.stringify({
  source: 'opus/puzzle-bank/raw-setup.json', source_sha256: sha(sourceBytes), source_entries: Object.keys(raw).length,
  puzzles_sha256: sha(readFileSync(path.join(appDir, 'data/puzzles.json'))), entries: Object.keys(setup).length,
  output_sha256: sha(text), check: 'every setup move replayed with chess.js from the raw FEN reproduces the bundled puzzle FEN exactly',
  license: 'Lichess puzzle database, CC0 1.0', built: new Date().toISOString().slice(0, 10),
}, null, 2)}\n`);
console.log(JSON.stringify({ entries: Object.keys(setup).length, bytes: Buffer.byteLength(text) }));
