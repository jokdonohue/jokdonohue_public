import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import Chessboard, { PAWN_PATH } from '../components/Chessboard';
import { ARTIFACT_DIR } from './b3_paths';

// Phones draw the pawn character (U+265F) as a colour emoji that ignores the fill, so a white pawn and a
// black pawn looked the same there. The pawn is therefore a drawn shape; these tests keep it that way.
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PAWN_CHARACTER = /♟/;

const pieces = (html: string) => [...html.matchAll(/<svg[^>]*class="piece (w|b)[^"]*"[^>]*>(.*?)<\/svg>/g)].map(m => ({ color: m[1], inner: m[2] }));

test('pawns of both colours are drawn as the pawn shape under their own colour class', () => {
  for (const orientation of ['w', 'b'] as const) {
    const html = renderToStaticMarkup(<Chessboard fen={START} orientation={orientation} />);
    const all = pieces(html);
    assert.equal(all.length, 32);
    const shapes = all.filter(p => p.inner.startsWith('<path'));
    assert.equal(shapes.filter(p => p.color === 'w').length, 8, 'eight white pawns');
    assert.equal(shapes.filter(p => p.color === 'b').length, 8, 'eight black pawns');
    for (const p of shapes) assert.equal(p.inner, `<path d="${PAWN_PATH}"></path>`);
    assert.equal(all.filter(p => p.inner.startsWith('<text')).length, 16, 'the other pieces are unchanged');
    assert.doesNotMatch(html, PAWN_CHARACTER);
  }
});

test('a lone pawn of each colour keeps its colour class', () => {
  const html = renderToStaticMarkup(<Chessboard fen="4k3/3p4/8/8/8/8/4P3/4K3 w - - 0 1" />);
  const shapes = pieces(html).filter(p => p.inner.startsWith('<path'));
  assert.deepEqual(shapes.map(p => p.color).sort(), ['b', 'w']);
});

test('the pawn outline is one closed shape', () => {
  assert.equal((PAWN_PATH.match(/[Mm]/g) ?? []).length, 1, 'one sub-path');
  assert.match(PAWN_PATH, /^M[^Zz]+Z$/);
});

test('the stylesheet colours the pawn shape exactly like the other pieces', () => {
  const css = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8');
  const rule = (selector: string) => (css.match(new RegExp(`(?:^|\\})\\s*${selector.replace(/\./g, '\\.')}\\{([^}]*)\\}`, 'm')) ?? [])[1];
  assert.match(rule('.piece.w path') ?? '', /^fill:#fffefa;stroke:#24374e;/);
  assert.match(rule('.piece.b path') ?? '', /^fill:#20334c;stroke:#f4f8ff;/);
  assert.equal(rule('.piece.w path'), rule('.piece.w text'));
  assert.equal(rule('.piece.b path'), rule('.piece.b text'));
});

test('no page source holds the pawn character', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css|html)$/.test(name) ? [p] : [];
  });
  const files = ['components', 'lib', 'src', 'styles', 'page'].flatMap(d => walk(join(ARTIFACT_DIR, d)));
  assert.ok(files.length > 40);
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), PAWN_CHARACTER, f);
});
