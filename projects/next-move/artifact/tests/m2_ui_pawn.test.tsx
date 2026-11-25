import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import Chessboard, { pieceArt, PIECE_VIEWBOX } from '../components/Chessboard';
import { PIECE_ART, PIECE_ART_CREDIT, PIECE_ART_LICENCE, PIECE_ART_SOURCES, PIECE_BOX, type PieceColour, type PieceType } from '../components/pieceSet';
import { ARTIFACT_DIR } from './b3_paths';

// Version 6: phones draw the pawn character (U+265F) as a colour emoji that ignores the fill, so a white pawn and a
// black pawn looked the same there, and the pawn became a drawn shape. Version 7.2: every piece is a drawn shape from
// one set, so no piece depends on a device's fonts. These tests keep it that way.
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** Any chess piece character, U+2654 to U+265F. */
const CHESS_CHARACTER = /[♔-♟]/;
const COLOURS: PieceColour[] = ['w', 'b'];
const TYPES: PieceType[] = ['k', 'q', 'r', 'b', 'n', 'p'];

const pieces = (html: string) => [...html.matchAll(/<svg[^>]*class="piece (w|b)[^"]*"[^>]*>(.*?)<\/svg>/g)].map(m => ({ color: m[1] as PieceColour, inner: m[2], tag: m[0] }));
const artOf = (color: PieceColour, type: PieceType) => renderToStaticMarkup(<svg>{pieceArt(color, type)}</svg>).replace(/^<svg>|<\/svg>$/g, '');

test('all 32 pieces are drawn shapes from the piece set, under their own colour class, in the set\'s drawing box', () => {
  const expected = new Map<string, number>();
  for (const c of COLOURS) for (const [t, n] of [['k', 1], ['q', 1], ['r', 2], ['b', 2], ['n', 2], ['p', 8]] as Array<[PieceType, number]>) expected.set(`${c}|${artOf(c, t)}`, n);
  for (const orientation of ['w', 'b'] as const) {
    const html = renderToStaticMarkup(<Chessboard fen={START} orientation={orientation} />);
    const all = pieces(html);
    assert.equal(all.length, 32);
    const seen = new Map<string, number>();
    for (const p of all) {
      assert.match(p.tag, new RegExp(`viewBox="${PIECE_VIEWBOX}"`));
      assert.doesNotMatch(p.inner, /<text|style=/, 'no font character and no inline style text');
      assert.match(p.inner, /^(<(path|circle)\b[^>]*><\/(path|circle)>)+$/, 'only paths and circles');
      const key = `${p.color}|${p.inner}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    assert.deepEqual([...seen].sort(), [...expected].sort(), 'each piece is the set\'s drawing for its colour and kind');
    assert.doesNotMatch(html, CHESS_CHARACTER);
  }
});

test('a lone pawn of each colour keeps its colour class and its own paint', () => {
  const html = renderToStaticMarkup(<Chessboard fen="4k3/3p4/8/8/8/8/4P3/4K3 w - - 0 1" />);
  const pawns = pieces(html).filter(p => p.inner === artOf(p.color, 'p'));
  assert.deepEqual(pawns.map(p => p.color).sort(), ['b', 'w']);
  assert.match(artOf('w', 'p'), /fill="#fff"/);
  assert.match(artOf('b', 'p'), /fill="#000"/);
});

test('the piece set: twelve drawings, each shape a path or a circle with plain paints; the two colours of a kind differ', () => {
  assert.equal(PIECE_BOX, 45);
  for (const c of COLOURS) {
    assert.deepEqual(Object.keys(PIECE_ART[c]).sort(), [...TYPES].sort());
    for (const t of TYPES) {
      const shapes = PIECE_ART[c][t];
      assert.ok(shapes.length >= 1, `${c}${t} has shapes`);
      for (const s of shapes) {
        assert.ok((typeof s.d === 'string' && s.d.length > 0) !== (Array.isArray(s.c) && s.c.length === 3), 'a path or a circle, not both');
        assert.match(s.f, /^(#000|#fff|none)$/);
        if (s.s !== undefined) { assert.match(s.s, /^(#000|#fff)$/); assert.ok(typeof s.w === 'number' && s.w > 0); }
        assert.ok(s.f !== 'none' || s.s !== undefined, 'every shape paints something');
      }
      // A filled body in the side's own colour: a white piece has a white fill, a black piece a black one.
      assert.ok(shapes.some(s => s.f === (c === 'w' ? '#fff' : '#000')), `${c}${t} has a body in its own colour`);
    }
  }
  for (const t of TYPES) assert.notEqual(artOf('w', t), artOf('b', t), `white and black ${t} differ`);
});

test('the piece set records its sources and carries the licence notice the page shows', () => {
  assert.equal(PIECE_ART_SOURCES.length, 12);
  assert.deepEqual(PIECE_ART_SOURCES.map(([name]) => name).sort(), COLOURS.flatMap(c => TYPES.map(t => `Chess_${t}${c === 'w' ? 'l' : 'd'}t45.svg`)).sort());
  for (const [, sha1] of PIECE_ART_SOURCES) assert.match(sha1, /^[0-9a-f]{40}$/);
  assert.match(PIECE_ART_CREDIT, /Cburnett/);
  assert.match(PIECE_ART_LICENCE, /^Copyright \(c\) 2006 Cburnett/);
  assert.match(PIECE_ART_LICENCE, /Redistributions in binary form must reproduce the above copyright notice/);
  const learn = readFileSync(join(ARTIFACT_DIR, 'components/Learn.tsx'), 'utf8');
  assert.match(learn, /PIECE_ART_CREDIT/, 'the Sources panel names the artist');
  assert.match(learn, /PIECE_ART_LICENCE/, 'the Sources panel shows the notice');
});

test('the stylesheet does not paint the pieces: their black and white come from the drawings', () => {
  const css = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // 7.3 (review of 7.2, P2-9 c): not only rules that name `.piece`. Every rule that sets a fill or a stroke must be one
  // of the known ones, the board arrow and the progress chart, none of which can reach a piece, the logo or the profile
  // dot (a rule such as `.square svg path{fill:…}` would have passed the old check).
  const painters: string[] = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/(^|;)\s*(fill|stroke)\s*:/.test(body)) painters.push(sel.trim());
  }
  assert.ok(painters.length >= 2, 'the arrow and the chart are found');
  for (const sel of painters) assert.match(sel, /^\.(board-arrow (line|marker path)|trend-(line|range|point))$/, `${sel} sets a fill or a stroke`);
});

test('no page source holds a chess piece character', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css|html)$/.test(name) ? [p] : [];
  });
  const files = ['components', 'lib', 'src', 'styles', 'page'].flatMap(d => walk(join(ARTIFACT_DIR, d)));
  assert.ok(files.length > 40);
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), CHESS_CHARACTER, f);
});
