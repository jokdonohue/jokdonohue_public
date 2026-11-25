import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, posix, win32 } from 'node:path';
import { ARTIFACT_DIR, SEED_DIR, SEED_M2_DIR, SEED_TEACH_DIR } from './b3_paths';
import { PROFILE, STALEMATE_ROW, jsonl, syntheticRows } from './b3_fixtures';
import { readTeachMeta, TEACH_MAX_BYTES } from '../src/contract/teachDocs';

/**
 * The file a write names. `file_path` is stored relative to the folder that holds batches.json, as
 * `<collection>/<doc_id>.json`, and is joined to that folder here. It is never absolute: an absolute path names the
 * place the folder was built in, and stops being true when the folder or the project moves.
 */
function fileOf(dir: string, w: { collection: string; doc_id: string; file_path: string }): string {
  assert.ok(!posix.isAbsolute(w.file_path) && !win32.isAbsolute(w.file_path), `the file_path of ${w.collection}/${w.doc_id} is relative to the folder of batches.json, not absolute`);
  assert.equal(w.file_path, `${w.collection}/${w.doc_id}.json`, 'file_path is <collection>/<doc_id>.json');
  return join(dir, w.file_path);
}

// Seeding writes only what batches.json lists. Any other JSON file under <seed>/pack is a leftover from an earlier
// generation: it is found at run time (never named here) and must not appear in batches.json.
// The collection each seed folder writes its meta document to. seed_teach/ (version 7.1) is one document with no
// chunks, so its meta lists none and is the only write.
const COLLECTION: Record<string, string> = { seed: 'pack', seed_m2: 'safe', seed_teach: 'teach' };
for (const dir of [SEED_DIR, SEED_M2_DIR, SEED_TEACH_DIR]) {
  const name = basename(dir);
  const file = join(dir, 'batches.json');
  test(`${name}/batches.json names only existing, current files`, { skip: !existsSync(file) }, () => {
    const { batches, packVersion } = JSON.parse(readFileSync(file, 'utf8')) as { packVersion: string; batches: Array<{ writes: Array<{ collection: string; doc_id: string; file_path: string }> }> };
    const writes = batches.flatMap(b => b.writes);
    for (const w of writes) {
      assert.ok(existsSync(fileOf(dir, w)), `missing ${basename(w.file_path)}`);
      assert.equal(basename(w.file_path), `${w.doc_id}.json`);
    }
    // The chunks written are exactly the ones the written meta lists: pack/meta for seed/, safe/meta for seed_m2/
    // (lead decision D1: M2 writes nothing under pack/).
    const coll = COLLECTION[name];
    if (coll !== 'pack') assert.ok(!writes.some(w => w.collection === 'pack'), `${name} writes nothing under pack/`);
    if (coll === 'teach') assert.ok(!writes.some(w => w.collection === 'safe'), 'seed_teach writes nothing under safe/');
    const metaWrite = writes.find(w => w.collection === coll && w.doc_id === 'meta')!;
    assert.ok(metaWrite, `${coll}/meta is written`);
    const meta = JSON.parse(readFileSync(fileOf(dir, metaWrite), 'utf8')) as { packVersion: string; chunks?: Record<string, string[]> | string[] };
    assert.equal(meta.packVersion, packVersion);
    const listed = new Set(!meta.chunks ? [] : Array.isArray(meta.chunks) ? meta.chunks : Object.values(meta.chunks).flat());
    const chunkWrites = writes.filter(w => w.collection === coll && w.doc_id !== 'meta').map(w => w.doc_id);
    assert.deepEqual(new Set(chunkWrites), listed, `every chunk ${coll}/meta lists is written, and only those`);
    assert.deepEqual([writes[writes.length - 1].collection, writes[writes.length - 1].doc_id], [coll, 'meta'], `${coll}/meta last`);
    // Leftovers: chunk files on disk that neither batches.json nor the meta names stay unwritten (seed_m2/pack/ holds
    // only leftovers from the pre-D1 layout).
    const packDir = join(dir, coll);
    const written = new Set(writes.filter(w => w.collection === coll).map(w => `${w.doc_id}.json`));
    const leftovers = existsSync(packDir) ? readdirSync(packDir).filter(f => f.endsWith('.json') && !written.has(f)) : [];
    for (const f of leftovers) assert.ok(!listed.has(f.slice(0, -5)), `${f} is listed in pack/meta but not written`);
    console.log(`${name}: ${written.size} ${coll} files written, ${leftovers.length} leftover file(s) left unwritten`);
  });
}

// Version 7.1 (brief m31, 3.6 and section 8): seed_teach/ holds ONE document. Going live is one write of teach/meta,
// so the batch file must name exactly that, the body must be what the page reads whole, and the folder must be
// marked private (it holds his card ids and moves). Counts only are printed.
test('seed_teach: one batch with one write, teach/meta, readable by the page and marked private', { skip: !existsSync(join(SEED_TEACH_DIR, 'batches.json')) }, () => {
  const { batches, packVersion, teachVersion } = JSON.parse(readFileSync(join(SEED_TEACH_DIR, 'batches.json'), 'utf8')) as {
    packVersion: string; teachVersion: string;
    batches: Array<{ bytes: number; writes: Array<{ op: string; collection: string; doc_id: string; file_path: string; bytes: number; if_version?: unknown }> }>;
  };
  assert.equal(batches.length, 1, 'one batch');
  assert.equal(batches[0].writes.length, 1, 'one write');
  const w = batches[0].writes[0];
  assert.deepEqual([w.op, w.collection, w.doc_id], ['set', 'teach', 'meta']);
  assert.ok(!('if_version' in w), 'a first seed carries no pin, so it can only create');
  assert.equal(w.file_path, 'teach/meta.json', 'relative to seed_teach/, the folder that holds batches.json');
  const text = readFileSync(fileOf(SEED_TEACH_DIR, w), 'utf8');
  assert.deepEqual([Buffer.byteLength(text, 'utf8'), batches[0].bytes], [w.bytes, w.bytes]);
  assert.ok(w.bytes <= TEACH_MAX_BYTES, 'at most 150 KiB');
  const body = JSON.parse(text) as { packVersion: string; chunks?: unknown };
  const read = readTeachMeta(body);
  assert.deepEqual([read.ok, read.skipped, read.issue, read.teachVersion], [true, 0, '', teachVersion]);
  assert.equal(body.packVersion, packVersion);
  assert.equal(body.chunks, undefined, 'no chunks: the field is reserved');
  assert.equal(readFileSync(join(SEED_TEACH_DIR, 'README.txt'), 'utf8').split('\n')[0], 'PRIVATE');
  // The builder's own record: the document was written, and past a stop rule only when the lead forced it.
  const summary = JSON.parse(readFileSync(join(SEED_TEACH_DIR, 'summary.json'), 'utf8')) as { written: boolean; forced: boolean; stops: string[]; teachVersion: string; bytes: number };
  assert.deepEqual([summary.written, summary.forced, summary.teachVersion, summary.bytes], [true, summary.stops.length > 0, teachVersion, w.bytes]);
  console.log(`seed_teach: 1 document, ${w.bytes} bytes, ${read.cards.length} threat entries, ${read.held.length} held cards`);
});

// The writer itself, on invented rows (tests/b3_fixtures.ts; no owner data): what scripts/pack-to-docs.mjs puts in
// batches.json. The seed is built as <seed>/next and then moved, as scripts/ingest.md section B does on a refresh.
test('pack-to-docs: batches.json names each file relative to its own folder, so a moved seed folder still resolves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-seedfiles-'));
  const src = join(dir, 'profile'), next = join(dir, 'seed', 'next');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'weakness_profile.json'), JSON.stringify(PROFILE));
  writeFileSync(join(src, 'mistake_positions.jsonl'), jsonl(syntheticRows(60, { seed: 7 })));
  writeFileSync(join(src, 'special_sets.jsonl'), jsonl([STALEMATE_ROW]));
  const made = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/pack-to-docs.mjs', '--src', src, '--out', next], { cwd: ARTIFACT_DIR, encoding: 'utf8', timeout: 120_000 });
  assert.equal(made.status, 0, `${made.stdout}\n${made.stderr}`);
  const text = readFileSync(join(next, 'batches.json'), 'utf8');
  assert.ok(!text.includes(dir), 'batches.json holds nothing of the folder it was built in');
  const writes = (JSON.parse(text) as { batches: Array<{ writes: Array<{ op: string; collection: string; doc_id: string; file_path: string; bytes: number }> }> }).batches.flatMap(b => b.writes);
  assert.ok(writes.length > 1 && new Set(writes.map(w => w.collection)).size > 1, 'several documents, in several collections');
  assert.deepEqual([writes[writes.length - 1].collection, writes[writes.length - 1].doc_id], ['pack', 'meta']);
  // Joined to the folder of batches.json, every path is the document the entry describes.
  for (const w of writes) assert.equal(statSync(fileOf(next, w)).size, w.bytes, `${w.collection}/${w.doc_id}`);
  // Moved: the same batches.json, not edited, names the same documents from the new folder.
  const moved = join(dir, 'seed_moved');
  renameSync(next, moved);
  assert.equal(existsSync(next), false);
  assert.equal(readFileSync(join(moved, 'batches.json'), 'utf8'), text);
  for (const w of writes) assert.equal(statSync(fileOf(moved, w)).size, w.bytes, `${w.collection}/${w.doc_id}, after the move`);
});
