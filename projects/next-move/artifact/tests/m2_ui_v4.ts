// Unused since lead decision D14: version-4 checks validate against the frozen `tests/fixtures/v4_docs.ts`.
// Kept (no deletions in this milestone); nothing imports it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARTIFACT_DIR } from './b3_paths';

// The version-4 source (the page that is live today) for compatibility tests. Set NEXT_MOVE_V4_DIR to an
// unedited copy of the version-4 `artifact/` directory; tests that need it skip when it is unset or absent.
export const V4_DIR = process.env.NEXT_MOVE_V4_DIR ? resolve(process.env.NEXT_MOVE_V4_DIR) : '';
export const HAVE_V4 = !!V4_DIR && existsSync(join(V4_DIR, 'src/contract/docs.ts'));

/**
 * Import version-4 modules. The copy has no node_modules, so the named files are copied (same relative
 * layout) into a fresh temp directory whose `node_modules` links to this artifact's dependencies.
 * Only files under the temp directory are written.
 */
/** The temp directory of the most recent `loadV4` call. */
export let lastRoot = '';
export async function loadV4<T = Record<string, unknown>>(files: string[], entry: string): Promise<T> {
  if (!HAVE_V4) throw new Error('NEXT_MOVE_V4_DIR not set');
  const root = mkdtempSync(join(tmpdir(), 'nm-v4-'));
  lastRoot = root;
  symlinkSync(join(ARTIFACT_DIR, 'node_modules'), join(root, 'node_modules'), 'dir');
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    // The `@/` alias would resolve through THIS artifact's tsconfig (M2 code), so rewrite it to a relative path.
    let rel = relative(dirname(join(root, f)), root) || '.';
    if (!rel.startsWith('.')) rel = `./${rel}`;
    const text = readFileSync(join(V4_DIR, f), 'utf8').replace(/(from\s+|import\s*\(\s*)(['"])@\//g, (_m, a: string, q: string) => `${a}${q}${rel}/`);
    writeFileSync(join(root, f), text);
  }
  // Probe: the copied contract must be the version-4 one (no `safe` collection), or the test is not testing v4.
  if (files.includes('src/contract/docs.ts')) {
    const docs = (await import(pathToFileURL(join(root, 'src/contract/docs.ts')).href)) as { paths: Record<string, unknown> };
    if ('safeMeta' in docs.paths) throw new Error('loadV4: NEXT_MOVE_V4_DIR holds M2 code, not version 4');
  }
  const mod = (await import(pathToFileURL(join(root, entry)).href)) as T;
  return mod;
}

/** Every `@/` import left in a loaded version-4 file set (should be none after the rewrite). */
export function v4AliasLeft(text: string): boolean { return /from\s+['"]@\//.test(text); }
