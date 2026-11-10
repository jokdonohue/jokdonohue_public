/** Argument parsing for scripts/import-personal-pack.ts. Pure, so it can be tested without touching files. */
export type ImportArgs =
  | { mode: 'clear'; out: string }
  | { mode: 'import'; input: string; out: string; skipInvalid: boolean };

export const IMPORT_USAGE = 'Usage: import-personal-pack.ts <input-dir> [--out dir] [--skip-invalid] | --clear [--out dir]';

/** `defaultOut` is used when `--out` is absent. Throws the usage text for anything it cannot read unambiguously. */
export function parseImportArgs(args: readonly string[], defaultOut: string): ImportArgs {
  let out: string | undefined, clear = false, skipInvalid = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--out') {
      const value = args[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`--out needs a directory. ${IMPORT_USAGE}`);
      if (out !== undefined) throw new Error(`--out was given twice. ${IMPORT_USAGE}`);
      out = value; index++;
    } else if (arg === '--clear') clear = true;
    else if (arg === '--skip-invalid') skipInvalid = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}. ${IMPORT_USAGE}`);
    else positional.push(arg);
  }
  if (clear) {
    if (positional.length || skipInvalid) throw new Error(`--clear takes no input directory. ${IMPORT_USAGE}`);
    return { mode: 'clear', out: out ?? defaultOut };
  }
  if (positional.length !== 1) throw new Error(positional.length ? `Give one input directory, not ${positional.length}. ${IMPORT_USAGE}` : IMPORT_USAGE);
  return { mode: 'import', input: positional[0], out: out ?? defaultOut, skipInvalid };
}
