import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chess } from 'chess.js';
import PunishStudy, { EDGES_PER_PAGE, edgeMeta, solverSide, usableEdges, usablePunishStudy, type PunishEdge } from '../components/PunishStudy';
import type { TrainerItem } from '../components/pools';
import { classifyPunish, punishLesson } from '../src/teach/punish';

// M3 (brief 9.5): small-edge punish cards in the "punish it" reading list. Invented positions only, each checked with
// chess.js. The lesson's wording belongs to punish.ts, so tests compare against `punishLesson` itself, never a literal.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

function play(fen: string, uci: string) {
  const b = new Chess(fen);
  const m = b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return { fen: b.fen(), san: m.san };
}
/** A small-edge punish card (position after his game move, solver = his opponent) and its sibling mistake card. */
function edge(id: string, before: string, playedUci: string, pvUci: string[], winAfter: number, solverColor: 'w' | 'b', betterUci: string): PunishEdge {
  const g = play(before, playedUci);
  play(before, betterUci); // the better move is legal where he played his
  const card: TrainerItem = {
    id, fen: g.fen, moves: [pvUci[0]], rating: 1000, themes: ['personal'], gameUrl: 'https://www.chess.com/game/live/1', source: 'pack', kind: 'punish',
    title: `Punish it · Rapid · 2026-01-0${id.length % 9 + 1} · move 9`,
    pack: { playedSan: g.san, playedUci, sourceFen: before, pvUci, rowId: `row-${id}`, winAfter, solverColor },
  };
  return { card, sibling: { id: `pack-row-${id}`, fen: before, moves: [betterUci], rating: 1000, themes: ['personal'], gameUrl: '', source: 'pack' } };
}
// White owner: a3 lets the bishop reach c4, where it stops White castling kingside (Black to play: solver Black).
const W = () => edge('punish-w1', '6k1/5ppp/4b3/8/8/8/PP4PP/4K2R w K - 0 1', 'a2a3', ['e6c4', 'e1d2', 'g8f8'], 42, 'b', 'e1g1');
// Black owner: ...a6 lets the bishop reach c5, where it stops Black castling kingside (solver White).
const B = () => edge('punish-b1', '4k2r/pp4pp/8/8/8/4B3/5PPP/6K1 b k - 0 1', 'a7a6', ['e3c5', 'e8d7', 'g1f1'], 44, 'w', 'e8g8');

// The existing reading list's invented item (tests/b2_punishstudy.test.tsx).
const FEN = 'rnbqkbnr/ppppp2p/5p2/6p1/4P3/8/PPPP1PPP/RNBQKBNR w KQkq g6 0 3';
const studyItem = { id: 'punish-g1:4', set: 'punish', graded: false, fen: FEN, solverColor: 'w', ownerColor: 'b', playedUci: 'g7g5', playedSan: 'g5', replyUci: 'd1h5', replySan: 'Qh5#', lineSan: ['Qh5#'], why: 'not-unique', date: '2026-10-01', timeClass: 'rapid', moveNumber: 2 };

test('fixtures: both edges are small-edge cards with a lesson', () => {
  for (const e of [W(), B()]) {
    assert.equal(classifyPunish(e.card), 'small-edge');
    assert.ok(punishLesson(e.card, e.sibling), e.card.id);
  }
});

test('without edges the reading list renders exactly as before', () => {
  const items = usablePunishStudy([studyItem]);
  const html = renderToStaticMarkup(<PunishStudy items={items}/>);
  assert.equal(renderToStaticMarkup(<PunishStudy items={items} edges={[]}/>), html);
  assert.equal(renderToStaticMarkup(<PunishStudy items={items} edges={undefined}/>), html);
  assert.doesNotMatch(html, /Smaller edges/);
  assert.ok(html.startsWith('<section class="surface punish-study" aria-label="Punish it: worked examples"><h2>Punish it: 1 worked example</h2>'));
  assert.ok(html.endsWith('</div></div></section>'), 'nothing after the worked example');
  assert.equal(renderToStaticMarkup(<PunishStudy items={[]}/>), '');
  assert.equal(renderToStaticMarkup(<PunishStudy items={[]} edges={[]}/>), '');
});

test('smaller edges follow the worked examples: the lesson, then a collapsed viewer of the line', () => {
  const w = W(), b = B();
  const html = renderToStaticMarkup(<PunishStudy items={usablePunishStudy([studyItem])} edges={[w, b]}/>);
  const examples = html.indexOf('<h2>Punish it: 1 worked example</h2>'), edges = html.indexOf('<h3>Smaller edges from your games</h3>');
  assert.ok(examples >= 0 && edges > examples, 'a sub-list (h3) after the worked example');
  assert.match(html, /In these 2 positions your move gave your opponent a small edge at most\. Read what the move allowed\. Then step through the engine&#x27;s line\./);
  for (const e of [w, b]) {
    // FX1e (brief 9.12.2 item 5, V2-3): the edge lesson leaves out "Better was …" (the sibling's move, the answer of a
    // card practice may serve). This compared with punishLesson(e.card, e.sibling) before.
    assert.ok(html.includes(esc(punishLesson(e.card, e.sibling, { betterMove: false })!)), `${e.card.id}: lesson shown as text`);
    assert.match(punishLesson(e.card, e.sibling)!, /Better was O-O\.$/, `${e.card.id}: fixture: the sibling's move is there to leave out`);
    assert.ok(html.includes(esc(edgeMeta(e.card))), `${e.card.id}: game line`);
  }
  assert.doesNotMatch(html, /Better was|O-O/, "no edge names its sibling card's move");
  assert.equal(count(html, /<li class="study-item">/g), 2);
  assert.equal(count(html, /<button type="button" class="secondary line-viewer-toggle" aria-expanded="false">Show the line<\/button>/g), 2, 'one collapsed viewer per edge');
  assert.doesNotMatch(html, /class="line-viewer|line-viewer-board/, 'collapsed: no viewer section or board yet');
  assert.equal(count(html, /class="chessboard/g), 1, 'only the worked example has a board');
  assert.equal(count(html, /Open the game on Chess.com/g), 2, 'the worked example has no game link here; each edge has one');
});

test('edges alone get their own section and heading', () => {
  const html = renderToStaticMarkup(<PunishStudy items={[]} edges={[W()]}/>);
  assert.match(html, /^<section class="surface punish-study" aria-label="Punish it: smaller edges"><div class="study-list punish-edges"><h2>Smaller edges from your games<\/h2>/);
  assert.match(html, /In this position your move gave your opponent a small edge at most\./);
  assert.doesNotMatch(html, /worked example/);
});

test('edges are listed five at a time', () => {
  assert.equal(EDGES_PER_PAGE, 5);
  const many = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? B() : W())).map((e, i) => ({ ...e, card: { ...e.card, id: `${e.card.id}-${i}` } }));
  const seven = renderToStaticMarkup(<PunishStudy items={[]} edges={many(7)}/>);
  assert.equal(count(seven, /<li class="study-item">/g), 5);
  assert.match(seven, /In these 7 positions/);
  assert.match(seven, /<button type="button" class="secondary">Show 2 more<\/button>/);
  assert.match(renderToStaticMarkup(<PunishStudy items={[]} edges={many(12)}/>), />Show 5 more</);
  assert.doesNotMatch(renderToStaticMarkup(<PunishStudy items={[]} edges={many(5)}/>), /more<\/button>/);
});

test('an edge without a playable line is left out; one without a lesson names his move alone', () => {
  const w = W();
  const noLine = { ...w, card: { ...w.card, id: 'punish-x1', moves: [], pack: { ...w.card.pack, pvUci: [] } } };
  const illegal = { ...w, card: { ...w.card, id: 'punish-x2', moves: ['a1a8'], pack: { ...w.card.pack, pvUci: ['a1a8'] } } };
  assert.deepEqual(usableEdges([noLine, illegal, w]).map(e => e.card.id), ['punish-w1']);
  assert.equal(renderToStaticMarkup(<PunishStudy items={[]} edges={[noLine, illegal]}/>), '');
  // No lesson (no game move to read): the line is still offered.
  const bare = { card: { ...w.card, id: 'punish-x3', title: undefined, pack: { pvUci: w.card.pack!.pvUci, solverColor: 'b' } } };
  assert.equal(punishLesson(bare.card), null);
  const html = renderToStaticMarkup(<PunishStudy items={[]} edges={[bare]}/>);
  assert.equal(count(html, /<li class="study-item">/g), 1);
  assert.match(html, />Show the line</);
});

test('text from the pack is shown as text, never as markup', () => {
  const w = W();
  const odd = { ...w, card: { ...w.card, id: 'punish-x4', title: 'Punish it <i>x</i>', pack: { ...w.card.pack, playedSan: '<img src=x>' } } };
  const html = renderToStaticMarkup(<PunishStudy items={[]} edges={[odd]}/>);
  assert.doesNotMatch(html, /<img|<i>/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /Punish it &lt;i&gt;x&lt;\/i&gt;/);
});

test('each edge names its game as the worked examples do (time class, date, move), else by its title', () => {
  const w = W();
  assert.equal(edgeMeta(w.card), w.card.title, 'no game detail: the title');
  assert.equal(edgeMeta({ ...w.card, pack: { ...w.card.pack, timeClass: 'blitz', date: '2026-02-03', moveNumber: 14 } }), 'Blitz · 2026-02-03 · move 14');
  assert.equal(edgeMeta({ title: undefined, pack: {} }), '');
  const html = renderToStaticMarkup(<PunishStudy items={[]} edges={[{ ...w, card: { ...w.card, pack: { ...w.card.pack, timeClass: 'rapid', date: '2026-02-03', moveNumber: 14 } } }]}/>);
  assert.match(html, /<p class="small"><strong>Rapid · 2026-02-03 · move 14<\/strong><\/p>/);
  assert.doesNotMatch(html, /Punish it ·/, 'the card title is not repeated when the game detail is there');
});

test('the viewer is oriented to the solver: pack.solverColor, else the side to move', () => {
  assert.equal(solverSide(W().card), 'b');
  assert.equal(solverSide(B().card), 'w');
  const fenW = '6k1/8/8/8/8/8/8/6K1 w - - 0 1', fenB = '6k1/8/8/8/8/8/8/6K1 b - - 0 1';
  assert.equal(solverSide({ fen: fenB, pack: {} }), 'b');
  assert.equal(solverSide({ fen: fenW }), 'w');
  assert.equal(solverSide({ fen: fenB, pack: { solverColor: 'white' } }), 'b', 'an unusable colour falls back to the side to move');
});
