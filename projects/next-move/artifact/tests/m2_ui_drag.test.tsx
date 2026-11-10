import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import Chessboard, { squareCentre } from '../components/Chessboard';
import { canDragFrom, isDrag, resolveDrop, squareAt, DRAG_THRESHOLD_PX } from '../components/dragMove';
import { ARTIFACT_DIR } from './b3_paths';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PROMO = '8/P6k/8/8/8/8/8/K7 w - - 0 1';

test('D11: a press becomes a drag after 6 px', () => {
  assert.equal(DRAG_THRESHOLD_PX, 6);
  assert.equal(isDrag(3, 4), false);
  assert.equal(isDrag(6, 0), true);
  assert.equal(isDrag(-4.3, 4.3), true);
});

test('D11: the square under a point, both orientations; off the board is null', () => {
  assert.equal(squareAt(0, 0, 400, 'w'), 'a8');
  assert.equal(squareAt(399, 399, 400, 'w'), 'h1');
  assert.equal(squareAt(0, 0, 400, 'b'), 'h1');
  assert.equal(squareAt(399, 399, 400, 'b'), 'a8');
  assert.equal(squareAt(4 * 50 + 1, 6 * 50 + 1, 400, 'w'), 'e2');
  assert.equal(squareAt(-1, 10, 400, 'w'), null);
  assert.equal(squareAt(10, 400, 400, 'w'), null);
  assert.equal(squareAt(10, 10, 0, 'w'), null);
  for (const sq of ['a1', 'e4', 'h8', 'c6'] as const) for (const o of ['w', 'b'] as const) {
    const c = squareCentre(sq, o);
    assert.equal(squareAt(c.x * 50, c.y * 50, 400, o), sq, 'the arrow and the drop agree on geometry');
  }
});

test('D11: a drop on a legal square plays; promotion asks as today; anything else cancels', () => {
  assert.equal(canDragFrom(START, 'e2'), true);
  assert.equal(canDragFrom(START, 'e7'), false, 'only the side to move');
  assert.equal(canDragFrom(START, 'e4'), false);
  assert.deepEqual(resolveDrop(START, 'e2', 'e4'), { kind: 'move', uci: 'e2e4' });
  assert.deepEqual(resolveDrop(START, 'g1', 'f3'), { kind: 'move', uci: 'g1f3' });
  assert.deepEqual(resolveDrop(START, 'e2', 'e5'), { kind: 'cancel' });
  assert.deepEqual(resolveDrop(START, 'e2', 'e2'), { kind: 'cancel' });
  assert.deepEqual(resolveDrop(START, 'e2', null), { kind: 'cancel' });
  assert.deepEqual(resolveDrop(START, 'e7', 'e5'), { kind: 'cancel' });
  assert.deepEqual(resolveDrop(PROMO, 'a7', 'a8'), { kind: 'promote', from: 'a7', to: 'a8' });
  assert.deepEqual(resolveDrop('not a fen', 'e2', 'e4'), { kind: 'cancel' });
});

test('D11: tap-tap markup unchanged (64 square buttons); touch-action none only on a board that takes moves', () => {
  const html = renderToStaticMarkup(<Chessboard fen={START} onMove={() => undefined}/>);
  assert.equal((html.match(/<button[^>]*data-square=/g) ?? []).length, 64);
  assert.doesNotMatch(html, /drag-ghost/);
  const css = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8');
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*touch-action:\s*none[^{}]*\}/g)].map(m => m[1].trim());
  assert.deepEqual(rules, ['.chessboard.interactive']);
  assert.match(html, /class="chessboard interactive"/);
  assert.doesNotMatch(renderToStaticMarkup(<Chessboard fen={START} disabled arrow="e2e4"/>), /interactive/, 'a display-only board lets the page scroll');
  const src = readFileSync(join(ARTIFACT_DIR, 'components/Chessboard.tsx'), 'utf8');
  assert.match(src, /onPointerDown=\{pointerDown\}/);
  assert.doesNotMatch(src, /from ['"](?!react|chess\.js|\.\/dragMove)/, 'no new dependency');
});

test('P2-7a: only a pointer click within 500 ms of a drop is swallowed; keyboard Enter never is', async () => {
  const { swallowClick, CLICK_AFTER_DRAG_MS } = await import('../components/dragMove');
  assert.equal(CLICK_AFTER_DRAG_MS, 500);
  assert.equal(swallowClick(1000, 1100, 1), true, 'the browser echo of the drag');
  assert.equal(swallowClick(1000, 1100, 0), false, 'keyboard Enter right after a drag');
  assert.equal(swallowClick(1000, 1600, 1), false, 'a later tap after a drag with no echo');
  assert.equal(swallowClick(1000, 60_000, 0), false, 'keyboard Enter much later');
  assert.equal(swallowClick(null, 1100, 1), false, 'no drag');
  const src = readFileSync(join(ARTIFACT_DIR, 'components/Chessboard.tsx'), 'utf8');
  assert.doesNotMatch(src, /suppressClick/);
  assert.match(src, /onClick=\{e=>click\(square,e\.detail\)\}/);
});
