import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import Chessboard, { arrowHeadId } from '../components/Chessboard';
import LineViewer from '../components/LineViewer';

// M3 F3 (brief 9.4, A5's request): every board's arrowhead marker has its own id (React useId). Two boards with
// arrows on one page, such as the level-4 hint arrow and a line viewer, never share one, so hiding one board can
// never take the other's arrowhead with it. Textbook positions only.
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

/** Each drawn arrow: the id of the marker its svg defines, and the id its line points at. */
function arrows(html: string) {
  return [...html.matchAll(/<svg class="board-arrow"[^>]*>([\s\S]*?)<\/svg>/g)].map(m => ({
    defined: /<marker id="([^"]+)"/.exec(m[1])?.[1] ?? null,
    used: /marker-end="url\(#([^)]+)\)"/.exec(m[1])?.[1] ?? null,
  }));
}
const idCount = (html: string, id: string) => html.split(` id="${id}"`).length - 1;
const PLAIN = /^board-arrow-head[A-Za-z0-9_-]+$/;

/** Every arrow points at the marker in its own svg, every marker id is on the page once, and no two arrows share one. */
function assertOwnMarkers(html: string, expected: number) {
  const found = arrows(html);
  assert.equal(found.length, expected, `${expected} arrows drawn`);
  for (const a of found) {
    assert.ok(a.defined && a.used, 'each arrow has a marker and a reference to one');
    assert.equal(a.used, a.defined, 'the line points at the marker defined in its own svg');
    assert.equal(idCount(html, a.defined!), 1, `${a.defined} is defined once on the page`);
  }
  assert.equal(new Set(found.map(a => a.defined)).size, found.length, 'no two arrows share a marker');
  for (const a of found) assert.match(a.defined!, PLAIN, 'a plain id: safe inside url(#...)');
}

test('two boards with arrows in one tree: each arrow points at its own marker, and no marker id is used twice', () => {
  const html = renderToStaticMarkup(<>
    <Chessboard fen={START} arrow="e2e4"/>
    <Chessboard fen={AFTER_E4} orientation="b" arrow="e7e5" disabled/>
  </>);
  assertOwnMarkers(html, 2);
});

test('the page case: a hint arrow on the main board beside line viewers at later steps', () => {
  const html = renderToStaticMarkup(<>
    <Chessboard fen={START} arrow="g1f3" onMove={() => {}}/>
    <LineViewer title="Why e4 works" startFen={START} line={['e2e4', 'e7e5', 'g1f3']} orientation="w" initialStep={1}/>
    <LineViewer title="What could follow d4" startFen={START} line={['d2d4', 'd7d5']} orientation="b" initialStep={2}/>
  </>);
  assertOwnMarkers(html, 3);
});

test('a board without an arrow draws no marker and points at none; a viewer at its start draws none either', () => {
  const html = renderToStaticMarkup(<>
    <Chessboard fen={START}/>
    <LineViewer title="t" startFen={START} line={['e2e4']} orientation="w"/>
  </>);
  assert.doesNotMatch(html, /<marker\b/);
  assert.doesNotMatch(html, /url\(#/);
  assert.equal(arrows(html).length, 0);
});

test('the marker id is a plain fragment whatever form React gives its ids, and keeps them apart', () => {
  assert.equal(arrowHeadId('_R_5_'), 'board-arrow-head_R_5_', 'the form React 19.2.6 gives (checked), kept whole');
  assert.equal(arrowHeadId(':R1:'), 'board-arrow-headR1', 'a colon form');
  assert.equal(arrowHeadId('«r3»'), 'board-arrow-headr3', 'a guillemet form');
  for (const id of ['_R_5_', ':R1:', '«r3»', '_r_1a_']) assert.match(arrowHeadId(id), PLAIN);
  assert.notEqual(arrowHeadId('_R_1_'), arrowHeadId('_R_2_'));
});
