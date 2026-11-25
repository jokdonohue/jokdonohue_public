import { join, resolve } from 'node:path';

// Private inputs the B3 tests read when present. None of them ships in the public copy, and every test that
// reads one skips when it is absent.
//   NEXT_MOVE_SEED_ROOT    directory holding seed/, seed_m2/, seed_teach/ and seed_inputs/ (default: artifact/)
//   NEXT_MOVE_PROFILE_DIR  the engine pass output, weakness_profile/ (default: ../reviews/claude/data/weakness_profile)
// Point both at a missing path to run the suite as the public copy runs it.
export const ARTIFACT_DIR = resolve(import.meta.dirname ?? '.', '..');
export const SEED_ROOT = resolve(process.env.NEXT_MOVE_SEED_ROOT || ARTIFACT_DIR);
export const SEED_DIR = join(SEED_ROOT, 'seed');
export const SEED_M2_DIR = join(SEED_ROOT, 'seed_m2');
/** Version 7.1: the one document `teach/meta`, written by scripts/teach-to-docs.mjs (private, as the other seeds). */
export const SEED_TEACH_DIR = join(SEED_ROOT, 'seed_teach');
export const SEED_INPUTS_DIR = join(SEED_ROOT, 'seed_inputs');
export const PROFILE_DIR = resolve(process.env.NEXT_MOVE_PROFILE_DIR || join(ARTIFACT_DIR, '../reviews/claude/data/weakness_profile'));
