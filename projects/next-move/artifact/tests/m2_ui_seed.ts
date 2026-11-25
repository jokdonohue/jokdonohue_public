import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_DIR, SEED_M2_DIR } from './b3_paths';

export { SEED_DIR, SEED_M2_DIR };
export const HAVE_SEED = existsSync(join(SEED_DIR, 'batches.json'));
export const HAVE_SEED_M2 = existsSync(join(SEED_M2_DIR, 'batches.json'));

/**
 * The documents a seed directory writes, in `batches.json` order, as `{path, data}`. The file a write names is
 * read from the seed directory itself (`<collection>/<doc_id>.json`), so a moved seed root still works.
 */
export function loadSeedDocs(dir: string): Array<{ path: string; data: Record<string, unknown> }> {
  const { batches } = JSON.parse(readFileSync(join(dir, 'batches.json'), 'utf8')) as {
    batches: Array<{ writes: Array<{ collection: string; doc_id: string }> }>;
  };
  return batches.flatMap(b => b.writes).map(w => ({
    path: `${w.collection}/${w.doc_id}`,
    data: JSON.parse(readFileSync(join(dir, w.collection, `${w.doc_id}.json`), 'utf8')) as Record<string, unknown>,
  }));
}
