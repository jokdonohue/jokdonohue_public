#!/usr/bin/env node
/**
 * Build the Next Move artifact into artifact/dist/ (port plan section 1).
 *
 *   node scripts/build.mjs [--module-file] [--no-minify] [--strict] [--forbid <text>]... [--placeholders]
 *
 * (default)       the bundle is built as an IIFE and embedded in index.html as a CLASSIC inline script:
 *                 the probe proved only a classic inline script (lead decision 2026-11-10, review 2 U1).
 *                 Page cap 16 MB.
 * --module-file   emit an ES module dist/app.js loaded by <script type="module" src="app.js"> instead (unproven)
 * --inline        accepted for compatibility; same as the default
 * --no-minify     readable bundle for debugging
 * --strict        exit non-zero on any publish-checklist violation (use before every publish)
 * --forbid TEXT   extra string that must not occur in dist/ (pass the chess.com username here; never commit it)
 * --placeholders  build with the placeholder Trainer and coach even when B2/B3 files exist
 *
 * Run from anywhere; paths resolve against artifact/. No network, no installs: esbuild comes from the
 * node_modules symlink. Missing B2/B3 modules (`@/components/Trainer`, `@/src/coach`) are replaced
 * by generated placeholders under .build/, so the shell builds in any delivery order.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const BUILD = join(ROOT, '.build');
const ENGINE_SRC = [join(ROOT, 'vendor', 'engine'), join(ROOT, '..', 'app', 'public', 'engine')].find(d => existsSync(join(d, 'stockfish-19-lite-single.wasm')));
const ENGINE_FILES = ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm', 'COPYING-GPL-3.0.txt'];
const SERVED = new Set(['.html', '.js', '.wasm', '.txt', '.json']);
const MAX_APP_JS = 15 * 1024 * 1024;
const MAX_PAGE = 16 * 1024 * 1024;

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const forbid = args.flatMap((a, i) => (a === '--forbid' && args[i + 1] ? [args[i + 1]] : []));
const inline = !flag('--module-file');
const strict = flag('--strict');
const forcePlaceholders = flag('--placeholders');

const PLACEHOLDER_TRAINER = `import type { TrainerProps } from '../src/contract/store';
export default function Trainer({ store, deviceId }: TrainerProps) {
  return (<div className="boot-message"><h1>Next Move</h1>
    <p>The trainer is not part of this build yet. The page shell, the database connection and the attempt queue are running.</p>
    <p>Store: {store.kind} ({store.connection()}). Device: {deviceId}.</p></div>);
}
`;
const PLACEHOLDER_COACH = `import type { CoachDeps, CoachClient } from '../src/contract/coach';
export function createCoach(_deps: CoachDeps): CoachClient | null { return null; }
`;

/** Redirect a module specifier to a generated placeholder when its source file is missing. */
function optionalModules() {
  const targets = [
    { filter: /^@\/components\/Trainer$/, files: ['components/Trainer.tsx'], name: 'placeholder-trainer.tsx', body: PLACEHOLDER_TRAINER },
    { filter: /^@\/src\/coach$/, files: ['src/coach/index.ts', 'src/coach/index.tsx'], name: 'placeholder-coach.ts', body: PLACEHOLDER_COACH },
  ];
  const used = [];
  return {
    used,
    plugin: {
      name: 'optional-modules',
      setup(build) {
        for (const t of targets) {
          build.onResolve({ filter: t.filter }, () => {
            const present = t.files.find(f => existsSync(join(ROOT, f)));
            if (present && !forcePlaceholders) return { path: join(ROOT, present) };
            mkdirSync(BUILD, { recursive: true });
            const file = join(BUILD, t.name);
            writeFileSync(file, t.body);
            used.push(t.name);
            return { path: file };
          });
        }
      },
    },
  };
}

function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function walk(dir) { return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; }); }

async function main() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  const optional = optionalModules();
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['src/main.tsx'],
    bundle: true,
    format: inline ? 'iife' : 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    loader: { '.json': 'json' },
    tsconfig: 'tsconfig.json',
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: !flag('--no-minify'),
    outfile: join(DIST, 'app.js'),
    metafile: true,
    logLevel: 'warning',
    plugins: [optional.plugin],
  });
  if (result.errors.length) throw new Error('esbuild failed');

  // CSS: B2's stylesheet plus any CSS esbuild split out of component imports, inlined into the page.
  let css = '';
  const appCss = join(ROOT, 'styles', 'app.css');
  if (existsSync(appCss)) css += readFileSync(appCss, 'utf8');
  const splitCss = join(DIST, 'app.css');
  if (existsSync(splitCss)) { css += '\n' + readFileSync(splitCss, 'utf8'); rmSync(splitCss); }
  if (css.includes('</style')) throw new Error('CSS contains a closing style tag');

  const appJs = readFileSync(join(DIST, 'app.js'), 'utf8');
  let script = '<script type="module" src="app.js"></script>';
  if (inline) {
    if (/<\/script/i.test(appJs)) throw new Error('Bundle contains "</script"; cannot inline safely');
    if (appJs.includes('<!--')) throw new Error('Bundle contains "<!--", which changes how the HTML parser ends an inline script');
    script = `<script>${appJs}</script>`;
    rmSync(join(DIST, 'app.js'));
  }
  const shell = readFileSync(join(ROOT, 'page', 'index.html'), 'utf8');
  if (!shell.includes('/*__APP_CSS__*/') || !shell.includes('<!--__APP_SCRIPT__-->')) throw new Error('page/index.html lost its build markers');
  // Function replacers: `$` sequences in CSS or the bundle must not be read as patterns.
  writeFileSync(join(DIST, 'index.html'), shell.replace('/*__APP_CSS__*/', () => css).replace('<!--__APP_SCRIPT__-->', () => script));

  const engine = [];
  if (ENGINE_SRC) for (const f of ENGINE_FILES) { copyFileSync(join(ENGINE_SRC, f), join(DIST, f)); engine.push(f); }

  // Publish checklist (plan section 7) over dist/.
  const violations = [];
  const warnings = [];
  const files = walk(DIST);
  for (const f of files) if (!SERVED.has(extname(f))) violations.push(`not a served type: ${relative(DIST, f)}`);
  const sizes = Object.fromEntries(files.map(f => [relative(DIST, f), statSync(f).size]));
  if ((sizes['app.js'] ?? 0) > MAX_APP_JS) violations.push(`app.js is ${sizes['app.js']} bytes, over 15 MB`);
  if (sizes['index.html'] > MAX_PAGE) violations.push(`index.html is ${sizes['index.html']} bytes, over 16 MB`);
  if (!ENGINE_SRC) warnings.push('engine files not found (vendor/engine or ../app/public/engine); dist has no Stockfish');
  const texts = files.filter(f => ['.html', '.js', '.json'].includes(extname(f)) && !ENGINE_FILES.includes(relative(DIST, f)));
  const banned = [
    { what: 'api.chess.com', re: /api\.chess\.com/ },
    { what: 'absolute home path', re: /\/Users\/[A-Za-z]|\/home\/[a-z]/ },
    { what: 'absolute /engine/ path', re: /["'`(]\/engine\// },
    ...forbid.map(s => ({ what: 'a forbidden string (--forbid)', re: new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })),
  ];
  for (const f of texts) {
    const text = readFileSync(f, 'utf8');
    for (const b of banned) if (b.re.test(text)) violations.push(`${relative(DIST, f)} contains ${b.what}`);
  }
  const page = readFileSync(join(DIST, 'index.html'), 'utf8');
  if (!/<title>Next Move<\/title>/.test(page)) violations.push('title is not "Next Move"');
  const allText = texts.map(f => readFileSync(f, 'utf8')).join('\n');
  if (!/GPL|COPYING-GPL-3\.0\.txt/.test(allText)) warnings.push('no GPL licence link found in the page or bundle');
  if (!/github\.com\/(official-stockfish|nmrugg)|stockfishchess\.org/.test(allText)) warnings.push('no Stockfish source link found in the page or bundle');
  if (optional.used.length) warnings.push(`placeholders used: ${optional.used.join(', ')}`);

  const report = {
    dist: relative(process.cwd(), DIST) || '.',
    mode: inline ? 'inline-classic-iife' : 'module-file',
    sizes,
    totalBytes: Object.values(sizes).reduce((a, b) => a + b, 0),
    engineSource: ENGINE_SRC ? relative(ROOT, ENGINE_SRC) : null,
    engineSha256: Object.fromEntries(engine.map(f => [f, sha256(join(DIST, f))])),
    inputs: Object.keys(result.metafile.inputs).filter(p => !p.includes('node_modules')).length,
    warnings,
    violations,
  };
  console.log(JSON.stringify(report, null, 2));
  if (violations.length && strict) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
