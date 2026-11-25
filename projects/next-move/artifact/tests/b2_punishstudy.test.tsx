import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { assemblePack } from '../components/model';
import { buildPools } from '../components/pools';
import PunishStudy, { usablePunishStudy } from '../components/PunishStudy';

// After 1...g5?? the position below (Black to move would be wrong): White to move plays Qh5#? Use a simple legal reply instead.
const FEN = 'rnbqkbnr/ppppp2p/5p2/6p1/4P3/8/PPPP1PPP/RNBQKBNR w KQkq g6 0 3';
const item = { id: 'punish-g1:4', set: 'punish', graded: false, fen: FEN, solverColor: 'w', ownerColor: 'b', playedUci: 'g7g5', playedSan: 'g5', replyUci: 'd1h5', replySan: 'Qh5#', lineSan: ['Qh5#'], why: 'not-unique', explanation: 'The diagonal to e8 is open.', date: '2026-10-01', timeClass: 'rapid', moveNumber: 2 };
const card = { id: 'punish-g2:10', kind: 'punish', fen: FEN, moves: ['d1h5'], rating: 1000, themes: ['mateIn1'] };
const stalemate = { id: 'study-g3:80', set: 'stalemate', fen: '7k/8/6K1/5Q2/8/8/8/8 w - - 0 1' };

test('punish study items stay out of every practice pool and render as a worked example with no move input', () => {
  const meta = { packVersion: 'v', importedAt: 1, counts: {}, priors: {}, chunks: { cards: [], special: ['v-special-00'], punish: ['v-punish-00'] } };
  const pack = assemblePack(meta, [{ id: 'v-special-00', data: { cards: [], study: [stalemate] } }, { id: 'v-punish-00', data: { part: 'punish', cards: [card], study: [item] } }]);
  assert.ok(pack);
  assert.deepEqual(pack.punishStudy.map(i => i.id), ['punish-g1:4']);
  assert.deepEqual(pack.study.map(i => i.id), ['study-g3:80'], 'stalemate study is kept apart by `set`');
  const pools = buildPools({ bank: [], endgames: [], pack, personal: [], drills: [] });
  assert.deepEqual(pools.all.map(p => p.id), ['punish-g2:10'], 'only the graded punish card is practised');
  const usable = usablePunishStudy(pack.punishStudy);
  assert.equal(usable.length, 1);
  assert.equal(usablePunishStudy([{ ...item, replyUci: 'a1a8' }]).length, 0, 'an illegal stored reply is not shown');
  const html = renderToStaticMarkup(<PunishStudy items={usable}/>);
  assert.match(html, /In your game you played <strong>g5<\/strong>\. Your opponent&#x27;s best reply: <strong>Qh5#<\/strong> \(the engine’s reply, one of several good options\)/);
  assert.match(html, /Engine line: <span class="san">Qh5#<\/span>/);
  assert.match(html, /Show the move/);
  assert.doesNotMatch(html, /Reveal solution|Show a hint/);
  assert.equal(renderToStaticMarkup(<PunishStudy items={[]}/>), '');
});
