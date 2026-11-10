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
    // The pack chunks written are exactly the ones the written pack/meta lists.
    const metaWrite = writes.find(w => w.collection === 'pack' && w.doc_id === 'meta')!;
    const meta = JSON.parse(readFileSync(metaWrite.file_path, 'utf8')) as { packVersion: string; chunks: Record<string, string[]> };
    assert.equal(meta.packVersion, packVersion);
    const listed = new Set(Object.values(meta.chunks).flat());
    const chunkWrites = writes.filter(w => w.collection === 'pack' && w.doc_id !== 'meta').map(w => w.doc_id);
    for (const id of chunkWrites) assert.ok(listed.has(id), `${id} written but not in pack/meta`);
    if (name === 'seed') assert.deepEqual(new Set(chunkWrites), listed, 'every listed chunk is written');
    assert.equal(writes[writes.length - 1].doc_id, 'meta', 'pack/meta last');
    // Leftovers: pack files on disk that neither batches.json nor pack/meta names stay unwritten.
    const packDir = join(dir, 'pack');
    const written = new Set(writes.filter(w => w.collection === 'pack').map(w => `${w.doc_id}.json`));
    const leftovers = existsSync(packDir) ? readdirSync(packDir).filter(f => f.endsWith('.json') && !written.has(f)) : [];
    for (const f of leftovers) assert.ok(!listed.has(f.slice(0, -5)), `${f} is listed in pack/meta but not written`);
    if (name === 'seed') console.log(`${name}: ${written.size} pack files written, ${leftovers.length} leftover file(s) left unwritten`);
  });
}
