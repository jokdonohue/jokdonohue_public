#!/usr/bin/env node
/**
 * Engine pass rows -> seed files for the document `teach/meta` (version 7.1, brief m31 section 3.6).
 *
 * Run from artifact/ (tsx resolves the TypeScript modules and the `@/` paths):
 *   node --import tsx scripts/teach-to-docs.mjs --rows <depth-18 rows.jsonl> --rows22 <depth-22 rows.jsonl>
 *        --pack <pack folder of a snapshot> --out seed_teach [--at <epoch ms>] [--verify <dir>] [--force-stop-rules]
 *
 * - --rows, --rows22  the row files of reviews/claude/tools/m31/teach_pass.mjs at depth 18 and at depth 22. Read in
 *                     place; the last row per card id and kind counts.
 * - --pack            a folder holding pack/meta as `meta.json` and every chunk it lists as `<chunk id>.json` (the
 *                     layout scripts/snapshot-db.md writes). The pack is assembled as the page assembles it.
 * - --out             the seed folder (default seed_teach/). It holds the owner's card ids, moves and sentences:
 *                     never commit or publish it. Its README.txt starts with PRIVATE and marks every file in it.
 * - --at              the document's `at` (epoch ms). Default: the clock; with --verify, the staged document's `at`.
 *                     The version name takes its day from `at` in UTC, so the same `at` gives the same document.
 * - --verify <dir>    build again and compare with the files staged in <dir>; write nothing. 0 differences is the
 *                     check (exit 0); any difference exits 1.
 * - --force-stop-rules  the lead's only: write the document although a stop rule fired.
 *
 * Writes into --out:
 *   teach/meta.json            the document body, compact JSON (this exact text is what gets written to the database)
 *   batches.json               one ArtifactData batch with one write, `teach/meta` (the shape scripts/ingest.md gives).
 *                              Its `file_path` is `teach/meta.json`: relative to the folder that holds batches.json,
 *                              so the folder can move; whoever applies the batch joins it to that folder
 *   summary.json               counts only
 *   sentences.private.tsv      id, slot, text: every sentence the page can show from the document
 *   decisions.private.jsonl    one record per quiet card (each gate at both depths) and per graded punish card
 *   README.txt, .gitignore
 *
 * Exit 0: the document was written. Exit 1: a stop rule fired (src/importers/teachDocs.ts lists s1 to s6);
 * summary.json and decisions.private.jsonl are written and NO teach/meta.json (one from an earlier run is renamed
 * aside, with batches.json and the sentences, so nothing stale can be seeded). Exit 2: a usage or input problem.
 * Prints counts only: never a card id, a move or a sentence.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTeachDocs } from '../src/importers/teachDocs.ts';
import { assemblePack } from '../components/model.ts';
import { packChunkIds, readDoc } from '../src/contract/docs.ts';
import { TEACH_META_PATH } from '../src/contract/teachDocs.ts';

const here = dirname(fileURLToPath(import.meta.url));
const artifactDir = resolve(here, '..');
const args = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const flag = name => args.includes(name);
const USAGE = 'usage: node --import tsx scripts/teach-to-docs.mjs --rows <d18 jsonl> --rows22 <d22 jsonl> --pack <pack dir> --out <seed dir> [--at <ms>] [--verify <dir>] [--force-stop-rules]';
const stop = (message, code = 2) => { console.error(message); process.exit(code); };

const rowsFile = opt('--rows'), rows22File = opt('--rows22'), packDir = opt('--pack');
const verifyDir = opt('--verify');
if (flag('--verify') && !verifyDir) stop(`--verify needs a folder.\n${USAGE}`);
if (!rowsFile || !rows22File || !packDir) stop(USAGE);
const out = resolve(verifyDir ?? opt('--out', join(artifactDir, 'seed_teach')));
const force = flag('--force-stop-rules');

/** Rows of one file; lines that are not JSON objects are counted and skipped. */
function readRows(file) {
  if (!existsSync(file)) stop(`No rows file at ${file}.`);
  const rows = [];
  let bad = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r === 'object') rows.push(r); else bad++; } catch { bad++; }
  }
  return { rows, bad };
}

/** The pack as the page loads it: meta, the chunks it lists, `assemblePack`. Files may be bare bodies or `{ data }`. */
function loadPack(dir) {
  const body = file => { const raw = JSON.parse(readFileSync(file, 'utf8')); return raw && typeof raw === 'object' && raw.data && !raw.packVersion && !raw.cards ? raw.data : raw; };
  const metaFile = join(dir, 'meta.json');
  if (!existsSync(metaFile)) stop(`No pack meta at ${metaFile}.`);
  const meta = readDoc('pack/meta', body(metaFile));
  if (!meta) stop('The pack meta does not pass the page schema.');
  const chunks = packChunkIds(meta).map(id => { try { return { id, data: body(join(dir, `${id}.json`)) }; } catch { return null; } });
  const pack = assemblePack(meta, chunks);
  if (!pack) stop(`The page loader rejected the pack: ${chunks.filter(c => !c).length} of ${chunks.length} listed chunks are missing or unreadable.`);
  return pack;
}

const metaPath = join(out, 'teach', 'meta.json');
let at;
if (opt('--at') !== null) at = Number(opt('--at'));
else if (verifyDir) {
  if (!existsSync(metaPath)) stop(`--verify: no staged document at ${metaPath}; pass --at to compare the other files.`, 1);
  at = JSON.parse(readFileSync(metaPath, 'utf8')).at;
} else at = Date.now();
if (!Number.isFinite(at) || at < 0) stop('--at must be a time in epoch milliseconds.');

const r18 = readRows(resolve(rowsFile)), r22 = readRows(resolve(rows22File));
const pack = loadPack(resolve(packDir));
console.log(`rows: depth 18 ${r18.rows.length} read (${r18.bad} unparsable lines), depth 22 ${r22.rows.length} read (${r22.bad} unparsable lines)`);
console.log(`pack ${pack.version}: ${pack.cards.length} cards, ${pack.punish.length} punish cards`);

const build = buildTeachDocs({ rows18: r18.rows, rows22: r22.rows, pack, at });
const { doc, summary } = build;
const stops = summary.stops;
const writeDoc = stops.length === 0 || force;

// The exact texts of the five files.
const metaText = JSON.stringify(doc);
const bytes = Buffer.byteLength(metaText, 'utf8');
const [collection, docId] = TEACH_META_PATH.split('/');
const note = 'Version 7.1 seed (brief m31 section 8): ONE document, teach/meta. Apply with ArtifactData action "batch" (drop the bytes field). First seed: no if_version, so the write can only create. Read teach/meta first (expected absent) and read it back after. See scripts/ingest.md section D.';
// `file_path` is relative to the folder that holds batches.json (forward slashes), never absolute: the folder, or the
// whole project, can then move, and --verify of a moved folder finds no difference. It names the file at `metaPath`.
const batchesText = JSON.stringify({
  packVersion: doc.packVersion, teachVersion: doc.teachVersion, note,
  batches: [{ writes: [{ op: 'set', collection, doc_id: docId, file_path: `${collection}/${docId}.json`, bytes }], bytes }],
}, null, 1);
const summaryText = JSON.stringify({ ...summary, written: writeDoc, forced: force && stops.length > 0 }, null, 1);
const clean = text => String(text).replace(/[\t\r\n]+/g, ' ');
const sentencesText = `${['id', 'slot', 'text'].join('\t')}\n${build.sentences.map(row => row.map(clean).join('\t')).join('\n')}${build.sentences.length ? '\n' : ''}`;
const decisionsText = build.decisions.map(d => JSON.stringify(d)).join('\n') + (build.decisions.length ? '\n' : '');

const s = summary;
console.log(`cards: ${s.cards.served} served or listed, ${s.cards.quiet} with a quiet answer; rows depth 18 ${s.rows.d18.found.total} of ${s.rows.d18.expected.total} (capped ${s.rows.d18.capped}); depth-22 candidates ${s.rows.d22.candidates}, with both rows ${s.rows.d22.withBothRows} (capped ${s.rows.d22.capped})`);
console.log(`threats: pass at depth 18 ${s.threats.passDepth18}, stored ${s.threats.stored}, lost at depth 22 ${s.threats.lostAtDepth22.total}, unconfirmed ${s.threats.unconfirmed}; kinds ${JSON.stringify(s.k)}; pre ${JSON.stringify(s.pre)}`);
console.log(`held: ${s.held.total} of ${s.graded.total} graded punish cards (${JSON.stringify({ 'not-unique': s.held['not-unique'], 'not-held': s.held['not-held'] })}); kept ${s.graded.kept}`);
console.log(`document: ${bytes} bytes (limit ${s.limitBytes}), version ${doc.teachVersion}; dry run rejected ${s.dryRun.rejected}, lines that do not replay ${s.dryRun.shownNotReplaying}, closing mismatches ${s.dryRun.closingMismatches}`);
for (const line of stops) console.log(`STOP ${line}`);

// ---------------------------------------------------------------- --verify: compare, write nothing

if (verifyDir) {
  const flat = (value, path = '', into = new Map()) => {
    if (value && typeof value === 'object') { for (const [k, v] of Object.entries(value)) flat(v, path ? `${path}.${k}` : k, into); if (!Object.keys(value).length) into.set(path, Array.isArray(value) ? '[]' : '{}'); }
    else into.set(path, JSON.stringify(value));
    return into;
  };
  const diffMaps = (a, b) => { let n = 0; for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) n++; return n; };
  const diffLines = (a, b) => { const x = new Map(), add = (t, d) => { for (const l of t.split('\n')) if (l) x.set(l, (x.get(l) ?? 0) + d); }; add(a, 1); add(b, -1); return [...x.values()].filter(v => v !== 0).length; };
  const staged = name => (existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8') : null);
  const jsonDiff = (mine, theirs) => { if (theirs === null) return 1; try { return diffMaps(flat(JSON.parse(mine)), flat(JSON.parse(theirs))); } catch { return 1; } };
  const entries = text => { const d = JSON.parse(text); const m = new Map([['#head', JSON.stringify([d.v, d.teachVersion, d.packVersion, d.at, d.chunks ?? null])]]); for (const c of d.cards ?? []) m.set(`c ${c.id}`, JSON.stringify(c)); for (const h of d.held ?? []) m.set(`h ${h.id}`, JSON.stringify(h)); return m; };
  const result = {};
  const stagedMeta = staged(join('teach', 'meta.json'));
  if (writeDoc) {
    // Entry by entry; a text that differs with equal entries (key order, white space) still counts as one.
    try { result.meta = stagedMeta === null ? 1 : diffMaps(entries(metaText), entries(stagedMeta)) || (stagedMeta === metaText ? 0 : 1); } catch { result.meta = 1; }
    result.batches = jsonDiff(batchesText, staged('batches.json'));
    const tsv = staged('sentences.private.tsv');
    result.sentences = tsv === null ? 1 : diffLines(sentencesText, tsv);
  } else {
    // A stop rule fires on the rebuild: a staged document is then a difference by itself.
    result.meta = stagedMeta === null ? 0 : 1;
  }
  const dec = staged('decisions.private.jsonl');
  result.decisions = dec === null ? 1 : diffLines(decisionsText, dec);
  result.summary = jsonDiff(summaryText, staged('summary.json'));
  const total = Object.values(result).reduce((a, b) => a + b, 0);
  console.log(`verify ${out}: ${Object.entries(result).map(([k, v]) => `${k} ${v}`).join(', ')} -> ${total} difference${total === 1 ? '' : 's'}${stops.length ? ` (stop rules fire: ${stops.length})` : ''}`);
  process.exit(total === 0 && stops.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- write

mkdirSync(join(out, 'teach'), { recursive: true });
writeFileSync(join(out, 'README.txt'), [
  'PRIVATE',
  'Output of artifact/scripts/teach-to-docs.mjs (Next Move version 7.1): card ids, moves and sentences from the owner\'s own games.',
  'Every file in this folder is private. Never commit, publish or copy any of it into source, tests or public logs.',
  '',
  'teach/meta.json           the body of the database document teach/meta (compact JSON; write exactly this)',
  'batches.json              one ArtifactData batch with one write (scripts/ingest.md, section D)',
  'summary.json              counts only',
  'sentences.private.tsv     id, slot, text: every sentence the page can show from the document',
  'decisions.private.jsonl   one record per quiet card (each gate at both depths) and per graded punish card',
  '',
  'Rebuild after every pack refresh and after any change to the narrator; check with --verify (0 differences).',
  '',
].join('\n'));
writeFileSync(join(out, '.gitignore'), '*\n');
writeFileSync(join(out, 'summary.json'), summaryText);
writeFileSync(join(out, 'decisions.private.jsonl'), decisionsText);
if (!writeDoc) {
  // Nothing stale may stay in place: a document, its batch and its sentences from an earlier run are renamed aside.
  const mark = `superseded-${new Date().toISOString().replace(/[:.]/g, '')}`;
  let moved = 0;
  for (const name of [join('teach', 'meta.json'), 'batches.json', 'sentences.private.tsv']) {
    if (existsSync(join(out, name))) { renameSync(join(out, name), join(out, `${name}.${mark}`)); moved++; }
  }
  console.error(`NOT WRITTEN: ${stops.length} stop rule${stops.length === 1 ? '' : 's'} fired. summary.json and decisions.private.jsonl are in ${out}; no teach/meta.json${moved ? ` (${moved} file${moved === 1 ? '' : 's'} from an earlier run renamed aside)` : ''}.`);
  process.exit(1);
}
writeFileSync(metaPath, metaText);
writeFileSync(join(out, 'batches.json'), batchesText);
writeFileSync(join(out, 'sentences.private.tsv'), sentencesText);
console.log(`wrote ${TEACH_META_PATH} (${bytes} bytes), batches.json (1 batch, 1 write), summary.json, sentences.private.tsv (${build.sentences.length} rows), decisions.private.jsonl (${build.decisions.length} records) into ${out}${force && stops.length ? ' (FORCED past the stop rules)' : ''}`);
