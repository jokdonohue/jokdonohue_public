/**
 * Import the owner's personal pack (an offline engine pass over his completed games) into the app.
 *
 * Run from app/:
 *   node --import tsx scripts/import-personal-pack.ts <input-dir> [--out dir] [--skip-invalid]
 *   node --import tsx scripts/import-personal-pack.ts --clear [--out dir]
 * The default output is app/public/personal-pack, resolved from this script's folder, not the current directory.
 *
 * <input-dir> holds weakness_profile.json, mistake_positions.jsonl and, optionally, special_sets.jsonl
 * (reviews/claude/data/weakness_profile/CONTRACT.md, v1). Every row is validated and replayed with chess.js;
 * any invalid row stops the import unless --skip-invalid is given. Only drillable positions become cards.
 * Output: <out>/pack.json. --clear restores the empty stub, which makes the app behave as if no pack existed.
 *
 * Privacy: the pack holds positions and chess.com URLs from the owner's public games. It stays in its own
 * folder so it can be left out of an upload; any upload that includes it needs the owner's separate approval.
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPack, STUB_PACK } from '../lib/personal-pack';
import { parseImportArgs } from './import-personal-pack-args';

const MAX_PACK_BYTES = 20 * 1024 * 1024; // Workers static assets allow 25 MiB per file.

/** Default output: app/public/personal-pack, whatever the current directory is. */
const DEFAULT_OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/personal-pack');

async function main() {
  // Everything is validated before anything is created or written.
  const args = parseImportArgs(process.argv.slice(2), DEFAULT_OUT);
  const out = path.resolve(args.out);
  const target = path.join(out, 'pack.json');
  if (args.mode === 'clear') {
    await mkdir(out, { recursive: true });
    await writeFile(target, `${JSON.stringify(STUB_PACK)}\n`);
    console.log(`Cleared ${target}: it now holds the empty stub.`);
    return;
  }
  const { input } = args;
  if (!existsSync(input) || !statSync(input).isDirectory()) throw new Error(`Input directory not found: ${input}`);
  const files: Record<string, { sha256: string; bytes: number }> = {};
  const read = async (name: string, required: boolean) => {
    const file = path.join(input, name);
    if (!existsSync(file)) { if (required) throw new Error(`Missing ${name} in ${input}.`); return undefined; }
    const buffer = await readFile(file);
    files[name] = { sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length };
    return buffer.toString('utf8');
  };
  const profile = JSON.parse((await read('weakness_profile.json', true))!);
  const positions = (await read('mistake_positions.jsonl', true))!;
  const special = await read('special_sets.jsonl', false);
  await read('run_manifest.json', false); // recorded by hash, so the pack names the run it came from
  // importedAt is the producer's generatedAt, so importing the same files twice gives identical bytes (review R10).
  const importedAt = typeof profile?.generatedAt === 'string' ? profile.generatedAt : undefined;
  const { pack, report } = buildPack({ profile, positions, special, files, skipInvalid: args.skipInvalid, importedAt });
  const text = JSON.stringify(pack);
  if (Buffer.byteLength(text) > MAX_PACK_BYTES) throw new Error('The pack exceeds 20 MiB. Split it before serving it as a static asset.');
  await mkdir(out, { recursive: true });
  await writeFile(target, `${text}\n`);
  console.log(JSON.stringify({ wrote: target, bytes: Buffer.byteLength(text), counts: pack.counts, priors: pack.priors, skippedInvalidRows: report.errors.length, firstSkipped: report.errors.slice(0, 5), warnings: report.warnings.length, firstWarnings: report.warnings.slice(0, 5) }, null, 1));
}

main().catch(cause => { console.error(cause instanceof Error ? cause.message : cause); process.exit(1); });
