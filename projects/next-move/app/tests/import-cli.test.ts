import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseImportArgs } from '../scripts/import-personal-pack-args';
import { readPack } from '../lib/personal-pack';

const fixtureDir = path.join(process.cwd(), 'tests/fixtures/personal-pack');
const script = path.join(process.cwd(), 'scripts/import-personal-pack.ts');
// Never spawn the default-output form here: it would overwrite app/public/personal-pack/pack.json.
const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { cwd: process.cwd(), encoding: 'utf8' });

test('import arguments: the input may come first, with or without --out (review R1)', () => {
  assert.deepEqual(parseImportArgs(['in'], '/default'), { mode: 'import', input: 'in', out: '/default', skipInvalid: false });
  assert.deepEqual(parseImportArgs(['in', '--skip-invalid'], '/default'), { mode: 'import', input: 'in', out: '/default', skipInvalid: true });
  assert.deepEqual(parseImportArgs(['--skip-invalid', 'in'], '/default'), { mode: 'import', input: 'in', out: '/default', skipInvalid: true });
  assert.deepEqual(parseImportArgs(['in', '--out', 'x'], '/default'), { mode: 'import', input: 'in', out: 'x', skipInvalid: false });
  assert.deepEqual(parseImportArgs(['--out', 'x', 'in'], '/default'), { mode: 'import', input: 'in', out: 'x', skipInvalid: false });
  assert.deepEqual(parseImportArgs(['--clear'], '/default'), { mode: 'clear', out: '/default' });
  assert.deepEqual(parseImportArgs(['--clear', '--out', 'x'], '/default'), { mode: 'clear', out: 'x' });
});

test('import arguments: a missing --out value, an unknown flag, no input or two inputs are refused', () => {
  assert.throws(() => parseImportArgs(['in', '--out'], '/d'), /--out needs a directory/);
  assert.throws(() => parseImportArgs(['in', '--out', ''], '/d'), /--out needs a directory/);
  assert.throws(() => parseImportArgs(['--out', '--skip-invalid', 'in'], '/d'), /--out needs a directory/);
  assert.throws(() => parseImportArgs(['in', '--out', 'a', '--out', 'b'], '/d'), /twice/);
  assert.throws(() => parseImportArgs(['in', '--force'], '/d'), /Unknown option --force/);
  assert.throws(() => parseImportArgs([], '/d'), /^Error: Usage/);
  assert.throws(() => parseImportArgs(['a', 'b'], '/d'), /one input directory/);
  assert.throws(() => parseImportArgs(['--clear', 'in'], '/d'), /--clear takes no input/);
});

test('the import CLI writes a valid pack with the input first, gives identical bytes twice, and creates nothing when it fails', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pack-cli-'));
  try {
    const out = path.join(tmp, 'out');
    const first = run(fixtureDir, '--out', out);
    assert.equal(first.status, 0, first.stderr);
    const bytes = readFileSync(path.join(out, 'pack.json'), 'utf8');
    assert.ok(readPack(JSON.parse(bytes)), 'the written pack loads');
    assert.equal(run(fixtureDir, '--out', out).status, 0);
    assert.equal(readFileSync(path.join(out, 'pack.json'), 'utf8'), bytes, 're-importing the same input gives the same bytes (review R10)');

    const noInput = run('--out', path.join(tmp, 'fail-a'));
    assert.equal(noInput.status, 1);
    assert.match(noInput.stderr, /Usage/);
    assert.ok(!existsSync(path.join(tmp, 'fail-a')), 'a usage error creates no output directory');
    const missing = run(path.join(tmp, 'no-such-dir'), '--out', path.join(tmp, 'fail-b'));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Input directory not found/);
    assert.ok(!existsSync(path.join(tmp, 'fail-b')), 'a missing input creates no output directory');
    const noValue = run(fixtureDir, '--out');
    assert.equal(noValue.status, 1);
    assert.match(noValue.stderr, /--out needs a directory/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
