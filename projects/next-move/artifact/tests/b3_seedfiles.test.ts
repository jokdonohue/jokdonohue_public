import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SEED_DIR, SEED_M2_DIR } from './b3_paths';

// Seeding writes only what batches.json lists. Any other JSON file under <seed>/pack is a leftover from an earlier
// generation: it is found at run time (never named here) and must not appear in batches.json.
for (const dir of [SEED_DIR, SEED_M2_DIR]) {
  const name = basename(dir);
  const file = join(dir, 'batches.json');
  test(`${name}/batches.json names only existing, current files`, { skip: !existsSync(file) }, () => {
    const { batches, packVersion } = JSON.parse(readFileSync(file, 'utf8')) as { packVersion: string; batches: Array<{ writes: Array<{ collection: string; doc_id: string; file_path: string }> }> };
    const writes = batches.flatMap(b => b.writes);
    for (const w of writes) {
      assert.ok(existsSync(w.file_path), `missing ${basename(w.file_path)}`);
      assert.equal(basename(w.file_path), `${w.doc_id}.json`);
    }
    // The chunks written are exactly the ones the written meta lists: pack/meta for seed/, safe/meta for seed_m2/
    // (lead decision D1: M2 writes nothing under pack/).
    const coll = name === 'seed' ? 'pack' : 'safe';
    if (coll === 'safe') assert.ok(!writes.some(w => w.collection === 'pack'), 'seed_m2 writes nothing under pack/');
    const metaWrite = writes.find(w => w.collection === coll && w.doc_id === 'meta')!;
    assert.ok(metaWrite, `${coll}/meta is written`);
    const meta = JSON.parse(readFileSync(metaWrite.file_path, 'utf8')) as { packVersion: string; chunks: Record<string, string[]> | string[] };
    assert.equal(meta.packVersion, packVersion);
    const listed = new Set(Array.isArray(meta.chunks) ? meta.chunks : Object.values(meta.chunks).flat());
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
