import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_DIR, SEED_M2_DIR } from './b3_paths';

// D1 / D14: seeding M2 only adds documents, in collections the version-4 page never reads (safe, openings,
// transfer; the search of the version-4 source is in the build log, "M2 data"). No version-4 code is imported.

type Doc = { path: string; data: Record<string, unknown> };
/** The documents a seed directory writes, in batches.json order (bodies read from the directory itself). */
function seedDocs(dir: string): Doc[] {
  const { batches } = JSON.parse(readFileSync(join(dir, 'batches.json'), 'utf8')) as { batches: Array<{ writes: Array<{ collection: string; doc_id: string }> }> };
  return batches.flatMap(b => b.writes).map(w => ({ path: `${w.collection}/${w.doc_id}`, data: JSON.parse(readFileSync(join(dir, w.collection, `${w.doc_id}.json`), 'utf8')) }));
}
const HAVE = existsSync(join(SEED_DIR, 'batches.json')) && existsSync(join(SEED_M2_DIR, 'batches.json'));
const M2_COLLECTIONS = ['safe', 'openings', 'transfer'];

test('seed_m2 only adds documents, all under safe/, openings/ or transfer/; safe/meta last lists its chunks', { skip: !HAVE }, () => {
  const m1 = new Set(seedDocs(SEED_DIR).map(d => d.path));
  const m2 = seedDocs(SEED_M2_DIR);
  assert.ok(m2.length > 0);
  for (const d of m2) {
    assert.ok(!m1.has(d.path), `${d.path} would rewrite an M1 document`);
    assert.ok(M2_COLLECTIONS.includes(d.path.split('/')[0]), `${d.path} is outside the M2 collections`);
  }
  assert.equal(m2[m2.length - 1].path, 'safe/meta', 'safe/meta is written last, after its chunks');
  const meta = m2[m2.length - 1].data as { chunks: string[] };
  assert.deepEqual(m2.filter(d => /^safe\/(?!meta$)/.test(d.path)).map(d => d.path.slice('safe/'.length)), meta.chunks, 'safe/meta lists exactly the chunks written');
});
