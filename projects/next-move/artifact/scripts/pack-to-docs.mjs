#!/usr/bin/env node
/**
 * Personal pack -> artifact database seed files (port plan sections 2, 3, 10 items a and h).
 *
 * Run from artifact/ (tsx resolves the TypeScript modules):
 *   node --import tsx scripts/pack-to-docs.mjs [--src <weakness_profile dir>] [--out <seed dir>]
 *        [--at <ISO time>] [--prev <previous seed dir>] [--check] [--allow-mismatch]
 *
 * - --src  producer folder (default ../reviews/claude/data/weakness_profile)
 * - --out  seed folder (default seed/); holds the owner's positions and game links: never commit or publish it
 * - --at   timestamp for importedAt / plan / ingest (default: weakness_profile.json generatedAt) -> deterministic
 * - --prev a previous seed folder: card ids already issued for a position are kept (refresh contract, item h)
 * - --check  convert and report only; write nothing
 * - --validate <docPath> <file.json>  check one agent-written document (plan/current, drills/<id>, notes/<id>, ...)
 *          against the contract schema the page reads it with, the size limit and, for drills, chess.js line
 *          legality; prints every problem and exits 1. The page ignores a WHOLE document that fails (review 2 P2-9).
 * - --m2   write the M2 documents instead (items b, e, g): safe/<ver>-NN, openings/accidents, transfer/history
 *          and safe/meta listing the safe chunks (LAST), into --out (default seed_m2/). Nothing under pack/ (D1). Streams the engine cache in
 *          <src>/cache/. Extra options: --archive-summary <SUMMARY.md> (default ../reviews/claude/data/chesscom_games/
 *          SUMMARY.md), --archive-rows <json> (which SUMMARY rows to carry as context; default seed_inputs/
 *          archive_context.json, git-ignored; no context rows when absent), --transfer-prev <transfer/history.json from a snapshot> (append to it), --per-half <n> (300).
 *
 * Writes <out>/<collection>/<docId>.json (compact JSON, the exact document body), <out>/batches.json (ArtifactData
 * batch entries, at most 50 writes and 600 KiB each, pack/meta alone in the last batch) and <out>/summary.json.
 * Exits 1 when counts do not reconcile with run_manifest.json (unless --allow-mismatch) or any document fails
 * its contract schema or the 180 KiB limit. Prints one summary line per stage, never document content.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackDocs, previousIdsFromDocs, afterEvalFromCache, fenAfter, positionKey } from '../src/importers/packDocs.ts';
import { buildSeedDocs } from '../src/importers/seedDocs.ts';
import { docBytes, MAX_DOC_BYTES, schemaForPath } from '../src/contract/docs.ts';
import { sanLine } from '../src/importers/packDocs.ts';
import { buildM2Docs } from '../src/importers/m2Docs.ts';
import { readArchiveRows } from '../src/importers/openingsDocs.ts';

const here = dirname(fileURLToPath(import.meta.url));
const artifactDir = resolve(here, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const flag = name => args.includes(name);

if (flag('--validate')) {
  const i = args.indexOf('--validate');
  const [docPath, file] = [args[i + 1], args[i + 2]];
  if (!docPath || !file) { console.error('usage: --validate <docPath> <file.json>'); process.exit(2); }
  const raw = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const body = raw && typeof raw === 'object' && 'data' in raw && !('cards' in raw) && !('focus' in raw) && !('text' in raw) ? raw.data : raw;
  const problems = [];
  let schema = null;
  try { schema = schemaForPath(docPath); } catch (e) { problems.push(`path: ${e.message}`); }
  if (!schema && !problems.length) problems.push(`path: no contract schema for ${docPath}`);
  if (schema) {
    const parsed = schema.safeParse(body);
    if (!parsed.success) for (const issue of parsed.error.issues.slice(0, 30)) problems.push(`${issue.path.join('.') || '(document)'}: ${issue.message}`);
  }
  const bytes = docBytes(body);
  if (bytes > MAX_DOC_BYTES) problems.push(`size: ${bytes} bytes, over ${MAX_DOC_BYTES}`);
  if (docPath.startsWith('drills/')) for (const c of body?.cards ?? []) {
    if (Array.isArray(c?.moves) && typeof c?.fen === 'string' && sanLine(c.fen, c.moves).length !== c.moves.length) problems.push(`cards ${c.id}: line is not legal from its fen (the page lists it in rejected)`);
  }
  if (docPath === 'plan/current' && body?.mix && body.mix.agent === 0) console.warn('note: mix.agent is 0, so active drills/* sets will not be served while this plan is current');
  console.log(problems.length ? `INVALID ${docPath} (${bytes} bytes): the page would ignore the whole document\n- ${problems.join('\n- ')}` : `ok ${docPath} (${bytes} bytes)`);
  process.exit(problems.length ? 1 : 0);
}

const src = resolve(opt('--src', join(artifactDir, '../reviews/claude/data/weakness_profile')));
const m2 = flag('--m2');
const out = resolve(opt('--out', join(artifactDir, m2 ? 'seed_m2' : 'seed')));
const prevDir = opt('--prev', null);
// 600 KiB per batch leaves a wide margin under ArtifactData's 1 MiB batch body (review 2 U7).
const BATCH_MAX_WRITES = 50, BATCH_MAX_BYTES = 600 * 1024;

const read = name => readFileSync(join(src, name), 'utf8');
const profile = JSON.parse(read('weakness_profile.json'));
const manifest = existsSync(join(src, 'run_manifest.json')) ? JSON.parse(read('run_manifest.json')) : null;
const at = opt('--at', profile.generatedAt);

let previousIds;
if (prevDir) {
  const packDir = join(resolve(prevDir), 'pack');
  // Read exactly the chunks the folder's pack/meta lists (a snapshot's meta is the live one), so leftover
  // files from older versions never feed ids; fall back to every chunk file when there is no meta.
  const metaFile = join(packDir, 'meta.json');
  const rawMeta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : null;
  const metaBody = rawMeta && rawMeta.chunks ? rawMeta : rawMeta?.data ?? null;
  const listed = metaBody ? Object.values(metaBody.chunks).flat().map(id => `${id}.json`) : null;
  const files = existsSync(packDir) ? (listed ?? readdirSync(packDir).filter(f => f.endsWith('.json') && f !== 'meta.json').sort()) : [];
  const missing = files.filter(f => !existsSync(join(packDir, f)));
  if (missing.length) { console.error(`--prev: ${missing.length} chunk files listed in pack/meta are missing, e.g. ${missing[0]}`); process.exit(1); }
  const chunks = files.map(f => JSON.parse(readFileSync(join(packDir, f), 'utf8')));
  previousIds = previousIdsFromDocs(chunks);
  console.log(`prev: ${Object.keys(previousIds).length} issued ids from ${chunks.length} chunk files${listed ? ' listed in pack/meta' : ''}`);
  if (!Object.keys(previousIds).length) { console.error(`--prev ${prevDir} yielded no card ids (expected <dir>/pack/<chunk>.json files)`); process.exit(1); }
}

const positionsText = read('mistake_positions.jsonl'), specialText = read('special_sets.jsonl');
const afterEvals = await loadAfterEvals([positionsText, specialText]);
const pack = buildPackDocs({ profile, positions: positionsText, special: specialText, manifest, at, previousIds, afterEvals });
const seeds = buildSeedDocs(profile, pack.counts, pack.packVersion, at, pack.docs.filter(d => d.path !== 'pack/meta').flatMap(d => d.data.cards));
console.log(`pack ${pack.packVersion}: ${JSON.stringify(pack.counts)}`);
console.log(`reconcile: ${pack.reconcile.ok ? 'ok' : 'MISMATCH'} (${pack.reconcile.checked} checks)${pack.reconcile.diffs.length ? ' ' + pack.reconcile.diffs.join('; ') : ''}`);
if (!pack.reconcile.ok && !flag('--allow-mismatch')) { console.error('counts do not reconcile with run_manifest.json'); process.exit(1); }

let docs, counts, note;
if (m2) {
  ({ docs, counts } = await buildM2(pack));
  note = 'M2 seed (lead decision D1: new documents only, nothing under pack/). Apply in order with ArtifactData action "batch" (drop the bytes field), with NO if_version on any entry: a write to a document that already exists is then refused, so nothing existing is overwritten (see scripts/ingest.md, M2 seeding). safe/meta is the last batch.';
} else {
  // Write order: pack chunks, then plan / note / ingest, then pack/meta LAST.
  docs = [...pack.docs.slice(0, -1), ...seeds, pack.docs[pack.docs.length - 1]];
  counts = pack.counts;
  note = 'Apply in order with ArtifactData action "batch" (drop the bytes field). pack/meta is the last batch.';
}

const sizes = docs.map(d => docBytes(d.data));
const maxBytes = Math.max(...sizes), total = sizes.reduce((a, b) => a + b, 0);
if (m2) console.log(`m2: ${JSON.stringify(counts)}`);
console.log(`docs: ${docs.length}, total ${total} bytes, largest ${maxBytes} bytes (limit ${MAX_DOC_BYTES}), warnings ${pack.warnings.length}`);
if (maxBytes > MAX_DOC_BYTES) { console.error('a document is over the size limit'); process.exit(1); }
if (flag('--check')) process.exit(0);

// Files and batches.
const batches = [];
let current = { writes: [], bytes: 0 };
docs.forEach((d, i) => {
  const [collection, docId] = d.path.split('/');
  const file = join(out, collection, `${docId}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(d.data));
  const entry = { op: 'set', collection, doc_id: docId, file_path: file, bytes: sizes[i] };
  const isMeta = d.path === 'pack/meta' || d.path === 'safe/meta';
  if (current.writes.length && (isMeta || current.writes.length >= BATCH_MAX_WRITES || current.bytes + sizes[i] > BATCH_MAX_BYTES)) { batches.push(current); current = { writes: [], bytes: 0 }; }
  current.writes.push(entry); current.bytes += sizes[i];
});
batches.push(current);
writeFileSync(join(out, '.gitignore'), '*\n');
writeFileSync(join(out, 'batches.json'), JSON.stringify({ packVersion: pack.packVersion, note, batches }, null, 1));
writeFileSync(join(out, 'summary.json'), JSON.stringify({ packVersion: pack.packVersion, at, counts, reconcile: pack.reconcile, docs: docs.map((d, i) => ({ path: d.path, bytes: sizes[i] })), totalBytes: total, warnings: pack.warnings }, null, 1));
console.log(`wrote ${docs.length} docs into ${out} in ${batches.length} batches (${batches.map(b => b.writes.length).join('+')} writes)`);

// ---------------------------------------------------------------- punish grading inputs (streamed; nothing is printed)

/** AfterEval for every after-position of a drillable row with a refutation, from the engine cache. */
async function loadAfterEvals(texts) {
  const keys = new Set();
  for (const text of texts) for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (!r.drillable || !(r.refutationPvUci ?? []).length) continue;
    const a = fenAfter(r.fen, r.playedUci);
    if (a) keys.add(positionKey(a));
  }
  const f14 = join(src, 'cache', 'positions_d14_mpv2.jsonl'), f18 = join(src, 'cache', 'positions_d18_mpv2.jsonl');
  if (!existsSync(f14)) { console.warn('punish grading: no cache/positions_d14_mpv2.jsonl; every punish card becomes a study item'); return undefined; }
  const e14 = new Map(), e18 = new Map();
  await streamJsonl(f14, o => { if (keys.has(o.k)) e14.set(o.k, o); });
  if (existsSync(f18)) await streamJsonl(f18, o => { if (keys.has(o.k)) e18.set(o.k, o); });
  const out = {};
  for (const k of [...keys].sort()) { const ev = afterEvalFromCache(e14.get(k), e18.get(k)); if (ev) out[k] = ev; }
  console.log(`punish grading: ${keys.size} after-positions, ${e14.size} found at depth 14, ${e18.size} at depth 18 MultiPV 2`);
  return out;
}

// ---------------------------------------------------------------- M2 inputs (streamed; nothing is printed)

async function streamJsonl(file, onRow) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) onRow(JSON.parse(line));
}

async function buildM2(pack) {
  const cache = join(src, 'cache');
  // Owner moves: played/best from judged_moves, confirmed judgement and values from final_moves.
  const judged = new Map();
  await streamJsonl(join(cache, 'judged_moves.jsonl'), o => judged.set(`${o.g}:${o.p}`, { bm: o.bm, pu: o.pu, best: !!o.best, mate: o.mb != null || o.ma != null }));
  const moves = [];
  await streamJsonl(join(cache, 'final_moves.jsonl'), o => {
    const j = judged.get(`${o.g}:${o.p}`);
    if (!j) return;
    moves.push({ g: String(o.g), p: o.p, mn: o.mn, ph: o.ph, j: o.j ?? null, wb: o.wb, wa: o.wa, drop: o.drop, bm: j.bm, pu: j.pu, best: j.best, mate: j.mate || o.mb14 != null, sec: o.sec ?? null, depth: o.depth });
  });
  const sampleGames = new Set(moves.map(m => m.g));
  const games = new Map();
  await streamJsonl(join(cache, 'candidates.jsonl'), o => {
    if (sampleGames.has(String(o.id))) games.set(String(o.id), { url: o.url, date: o.date, timeClass: o.timeClass, ownerColor: o.ownerColor, fens: o.fens });
  });
  const gameFamily = new Map();
  await streamJsonl(join(cache, 'judged_games.jsonl'), o => gameFamily.set(String(o.g), { family: o.openingFamily, color: o.color }));
  const rowLines = new Map(), openingRows = [];
  await streamJsonl(join(src, 'mistake_positions.jsonl'), r => {
    if (r.judgement === 'blunder') rowLines.set(r.id, { pvUci: r.pvUci, refutationPvUci: r.refutationPvUci, mate: r.mateBefore != null || r.mateAfter != null });
    openingRows.push({ id: r.id, judgement: r.judgement, moveNumber: r.moveNumber });
  });
  const summaryPath = resolve(opt('--archive-summary', join(artifactDir, '../reviews/claude/data/chesscom_games/SUMMARY.md')));
  const summaryMd = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : null;
  const rowsPath = resolve(opt('--archive-rows', join(artifactDir, 'seed_inputs', 'archive_context.json')));
  const archiveRows = existsSync(rowsPath) ? readArchiveRows(JSON.parse(readFileSync(rowsPath, 'utf8'))) : null;
  const tp = opt('--transfer-prev', null);
  const existingTransfer = tp ? JSON.parse(readFileSync(resolve(tp), 'utf8')) : null;
  const unwrap = d => (d && Array.isArray(d.points) ? d : d?.data ?? d);
  console.log(`m2 inputs: ${moves.length} owner moves, ${games.size} games, ${rowLines.size} blunder rows, archive summary ${summaryMd ? 'found' : 'absent'}, archive context rows ${archiveRows ? archiveRows.length : 'none (no --archive-rows file)'}`);
  return buildM2Docs({
    pack, profile, moves, games, rowLines, openingRows, gameFamily, summaryMd, archiveRows,
    existingTransfer: existingTransfer ? unwrap(existingTransfer) : null,
    perHalf: Number(opt('--per-half', '300')), at,
  });
}
