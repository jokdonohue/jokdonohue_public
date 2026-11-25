/**
 * M3 fix round 3 (brief 9.12.2), writer FX1e: the narrator's closing sentence.
 * - Item 1 (V1-1): on a line with a promotion the material the closing sentence states equals `material.net`, in the
 *   settled, the "so far" and the verdict sentence. The other side's new pieces cancel against the side's own; a side
 *   that gained nothing else names what it gave with its promotion ("promotes a pawn to a queen for a knight", "is a
 *   new queen for a knight up"); a new piece of the other side's that nothing cancels is named with its kind; two new
 *   pieces are each named.
 * - Item 2 (V1-6 part 3): "{Side}'s pawn on {sq} can promote" is left out when the side to move can legally take that
 *   pawn at once (another promoting pawn it cannot take is named instead); `material.settled` does not change.
 * Positions are invented or public Lichess bank puzzles read from the bundled bank by id, each replayed with chess.js
 * before a sentence is pinned. `statedForWhite` reads a closing sentence with the grammar in logs/m3_FX1e.md; it and the
 * board count below share no code with the narrator.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { narrateLine, type LineVerdict } from '../src/teach/narrate';
import { ARTIFACT_DIR } from './b3_paths';

const bank: Array<{ id: string; fen: string; moves: string[] }> = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'data/puzzles.json'), 'utf8'));
const replay = (fen: string, line: readonly string[]) => {
  const b = new Chess(fen);
  const sans = line.map(u => b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
  return { sans, end: b };
};
const VAL: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
/** The plain piece count's change for `side` from `fen` to `endFen` (an oracle independent of the narrator). */
function boardNet(fen: string, endFen: string, side: 'w' | 'b'): number {
  const count = (f: string, s: 'w' | 'b') => [...f.split(' ')[0]].reduce((t, ch) => {
    const l = ch.toLowerCase();
    return l in VAL && (s === 'w') === (ch !== l) ? t + VAL[l] : t;
  }, 0);
  const o = side === 'w' ? 'b' : 'w';
  return (count(endFen, side) - count(fen, side)) - (count(endFen, o) - count(fen, o));
}

// ---------------------------------------------------------------- what a closing sentence states
const PV: Record<string, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9 };
const CNT: Record<string, number> = { a: 1, the: 1, two: 2, three: 3, four: 4 };
const pieces = (s: string) => s.split(/, | and /).reduce((t, part) => {
  const x = /^(a|the|two|three|four) (pawn|knight|bishop|rook|queen)s?$/.exec(part.trim());
  return x ? { pts: t.pts + CNT[x[1]] * PV[x[2]], n: t.n + CNT[x[1]] } : { pts: Number.NaN, n: 0 };
}, { pts: 0, n: 0 });
/** "a pawn to a queen", "two pawns to a queen and a rook": the new pieces less the pawns they were. */
const pawnsTo = (s: string) => {
  const x = /^(a|two|three|four) pawns? to (.+)$/.exec(s.trim());
  const p = x ? pieces(x[2]) : { pts: Number.NaN, n: 0 };
  return x && p.n === CNT[x[1]] ? p.pts - p.n : Number.NaN;
};
/** "{Side} is {UP} up …": plain pieces count + before " for " and − after it; "a new X" counts +(X − 1) (and goes
 *  back to +); "Black's new X" counts −(X − 1). */
function upPts(s: string): number {
  let sign = 1, pts = 0;
  for (const tok of s.split(/(, | and | for )/)) {
    if (tok === ' for ') { sign = -1; continue; }
    if (tok === ', ' || tok === ' and ') continue;
    let x = /^(?:White|Black)'s (?:(two|three|four) )?new (knight|bishop|rook|queen)s?$/.exec(tok);
    if (x) { pts -= (x[1] ? CNT[x[1]] : 1) * (PV[x[2]] - 1); continue; }
    x = /^(a|two|three|four) new (knight|bishop|rook|queen)s?$/.exec(tok);
    if (x) { sign = 1; pts += CNT[x[1]] * (PV[x[2]] - 1); continue; }
    x = /^(a|the|two|three|four) (pawn|knight|bishop|rook|queen)s?$/.exec(tok);
    if (x) { pts += sign * CNT[x[1]] * PV[x[2]]; continue; }
    return Number.NaN;
  }
  return pts;
}
/** "wins … for … and promotes a pawn to a queen for …[, though Black also promotes a pawn to a knight]". */
function changePts(text: string): number {
  let t = text, pts = 0;
  const though = /, though (?:White|Black) (?:has )?(?:also )?(?:promotes|promoted) (.+)$/.exec(t);
  if (though) { pts -= pawnsTo(though[1]); t = t.slice(0, though.index); }
  const at = t.search(/ and (?:promotes|promoted) /);
  const wins = /^(?:promotes|promoted) /.test(t) ? '' : at >= 0 ? t.slice(0, at) : t;
  const prom = /^(?:promotes|promoted) /.test(t) ? t : at >= 0 ? t.slice(at + 5) : '';
  if (wins) {
    const w = /^(?:wins|won) (.+?)(?: for (.+))?$/.exec(wins);
    pts += w ? pieces(w[1]).pts - (w[2] ? pieces(w[2]).pts : 0) : Number.NaN;
  }
  if (prom) {
    const p = /^(?:promotes|promoted) (.+?)(?: for (.+))?$/.exec(prom);
    pts += p ? pawnsTo(p[1]) - (p[2] ? pieces(p[2]).pts : 0) : Number.NaN;
  }
  return pts;
}
/** The material a closing sentence states for White (null: it states none, as after a mate or with no sentence). */
function statedForWhite(summary: string): number | null {
  if (!summary || /^The line ends in /.test(summary)) return null;
  if (summary === 'No material changes hands.' || summary === 'The trades are even.') return 0;
  if (/^So far in this line (no material changes hands|the trades are even)\b/.test(summary)) return 0;
  const sign = (w: string) => (w === 'White' ? 1 : -1);
  let x = /^(White|Black) is (.+) up at the end of this line, but .+\.$/.exec(summary);
  if (x) return sign(x[1]) * upPts(x[2]);
  x = /^(White|Black) ((?:wins|promotes) .+)\.$/.exec(summary);
  if (x) return sign(x[1]) * changePts(x[2]);
  x = /^So far in this line (White|Black) has ((?:won|promoted) .+?)(?:, (?:but|and) .+)?\.$/.exec(summary);
  if (x) return sign(x[1]) * changePts(x[2]);
  return Number.NaN;
}
/** Readings the viewers and lessons give a line: no verdict, a figure for White, and a verdict that Black is winning. */
const VERDICTS: Array<LineVerdict | null> = [null, { side: 'w', win: 20 }, { side: 'b', winning: true }];

test('the reader of closing sentences: forms from before this round read as they did', () => {
  assert.equal(statedForWhite('White wins a rook for a knight and a pawn.'), 1);
  assert.equal(statedForWhite('White wins a rook for the queen and promotes a pawn to a queen.'), 4);
  assert.equal(statedForWhite('Black is a rook for a queen and a new queen up at the end of this line, but White is winning.'), -4);
  assert.equal(statedForWhite('So far in this line Black has won a pawn, but the rook on c8 can take the queen on c7.'), -1);
  assert.equal(statedForWhite('The trades are even.'), 0);
  assert.equal(statedForWhite('The line ends in checkmate by White.'), null);
  assert.ok(Number.isNaN(statedForWhite('White wins a rook and promotes a pawn to a queen, though Black also promotes a pawn.')!), 'no kind: no number');
  assert.ok(Number.isNaN(statedForWhite('White promotes two pawns to new pieces.')!), 'no kinds: no number');
});

// ---------------------------------------------------------------- item 1

test('item 1 (V1-1 a): a side that gave a knight and gained nothing else names it with its promotion', () => {
  // Invented: White Kg1 Nb4, pawn a7; Black Kh7 Rd8. Nd5 Rxd5 a8=Q: a queen for a knight, +5.
  const fen = '3r4/P6k/8/8/1N6/8/8/6K1 w - - 0 1', line = ['b4d5', 'd8d5', 'a7a8q'];
  const { sans, end } = replay(fen, line);
  assert.deepEqual(sans, ['Nd5', 'Rxd5', 'a8=Q']);
  const n = narrateLine(fen, line);
  assert.equal(n.material.net, 5);
  assert.equal(boardNet(fen, end.fen(), 'w'), 5);
  // Was "White promotes a pawn to a queen." (+8) and "White is a new queen up …".
  assert.equal(n.summary, 'White promotes a pawn to a queen for a knight.');
  assert.equal(narrateLine(fen, line, { verdict: { side: 'w', win: 30 } }).summary,
    'White is a new queen for a knight up at the end of this line, but the engine gives Black 70% to win.');
});

test('item 1 (V1-1 b): a new queen on each side cancels, so neither is named', () => {
  // Invented: White Kf1, pawns a7 e4; Black Kh6, pawns b2 d5. exd5 b1=Q+ Kf2 Kg7 a8=Q: White is one pawn up.
  const fen = '8/P7/7k/3p4/4P3/8/1p6/5K2 w - - 0 1', line = ['e4d5', 'b2b1q', 'f1f2', 'h6g7', 'a7a8q'];
  const { sans, end } = replay(fen, line);
  assert.deepEqual(sans, ['exd5', 'b1=Q+', 'Kf2', 'Kg7', 'a8=Q']);
  assert.equal(boardNet(fen, end.fen(), 'w'), 1);
  const n = narrateLine(fen, line);
  assert.equal(n.material.net, 1);
  // Was "White wins a pawn and promotes a pawn to a queen, though Black also promotes a pawn." and, with a verdict,
  // "White is a pawn and a new queen up …" (+9).
  assert.equal(n.summary, 'White wins a pawn.');
  assert.equal(narrateLine(fen, line, { verdict: { side: 'w', win: 30 } }).summary, 'White is a pawn up at the end of this line, but the engine gives Black 70% to win.');
});

test('item 1: V1-1\'s two public bank lines read +1 and +5', () => {
  // Public bank 00FND, the try f2+ and the depth-12 line the page got for it; the solver (Black) had 51.1 after the try.
  const fnd = bank.find(p => p.id === '00FND')!;
  const fndLine = ['f3f2', 'e1f2', 'd3d2', 'f2g2', 'e2e1q', 'b7b8q', 'e1e2'];
  const a = replay(fnd.fen, fndLine);
  assert.deepEqual(a.sans, ['f2+', 'Kxf2', 'Kd2', 'Kg2', 'e1=Q', 'b8=Q', 'Qe2+']);
  assert.equal(boardNet(fnd.fen, a.end.fen(), 'w'), 1, 'White is one pawn up');
  assert.equal(narrateLine(fnd.fen, fndLine, { verdict: { side: 'b', win: 51.1 }, noChangeSentence: false }).summary,
    'White is a pawn up at the end of this line, but the engine gives Black 51% to win.');
  // Public bank 01Ni2, the try Nd4+ with its line once the puzzle is complete; the solver (Black) had 12.2 after it.
  const ni = bank.find(p => p.id === '01Ni2')!;
  const niLine = ['f3d4', 'b6d4', 'f8f2', 'e2f2', 'b7c6', 'f2g3', 'h2h1q'];
  const b = replay(ni.fen, niLine);
  assert.deepEqual(b.sans, ['Nd4+', 'Bxd4', 'Rxf2+', 'Kxf2', 'Bc6', 'Kg3', 'h1=Q']);
  assert.equal(boardNet(ni.fen, b.end.fen(), 'b'), 5, 'Black is a queen for a knight up');
  assert.equal(narrateLine(ni.fen, niLine, { verdict: { side: 'b', win: 12.2 }, noChangeSentence: false }).summary,
    'Black is a new queen for a knight up at the end of this line, but the engine gives White 88% to win.');
});

test('item 1: a sentence that already added up keeps its words', () => {
  // Invented: White Kg1 Qd4, pawn a7; Black Kh8 Rd8 Bf6. Qxd8+ Bxd8 a8=Q: a rook for the queen, and a new queen (+4).
  const fen = '3r3k/P7/5b2/8/3Q4/8/8/6K1 w - - 0 1', line = ['d4d8', 'f6d8', 'a7a8q'];
  assert.deepEqual(replay(fen, line).sans, ['Qxd8+', 'Bxd8', 'a8=Q']);
  const n = narrateLine(fen, line);
  assert.equal(n.material.net, 4);
  assert.equal(n.summary, 'White wins a rook for the queen and promotes a pawn to a queen.');
  assert.equal(narrateLine(fen, line, { verdict: { side: 'w', win: 30 } }).summary,
    'White is a rook for a queen and a new queen up at the end of this line, but the engine gives Black 70% to win.');
});

test('item 1: a new piece of the other side\'s that nothing cancels is named with its kind and counted', () => {
  // Invented: White Kh2 Rd1; Black Kh8 Qd8, pawn c2. Rxd8+ Kh7 Kg3 c1=Q: the queen for a new queen, White +1.
  const fen = '3q3k/8/8/8/8/8/2p4K/3R4 w - - 0 1', line = ['d1d8', 'h8h7', 'h2g3', 'c2c1q'];
  const { sans, end } = replay(fen, line);
  assert.deepEqual(sans, ['Rxd8+', 'Kh7', 'Kg3', 'c1=Q']);
  assert.equal(boardNet(fen, end.fen(), 'w'), 1);
  const n = narrateLine(fen, line);
  assert.equal(n.material.net, 1);
  assert.equal(n.summary, 'White wins the queen, though Black promotes a pawn to a queen.', 'was "…, though Black also promotes a pawn."');
  assert.equal(narrateLine(fen, line, { verdict: { side: 'w', win: 30 } }).summary,
    "White is a queen for Black's new queen up at the end of this line, but the engine gives Black 70% to win.", 'was "White is a queen up …" (+9)');
  // New pieces of different kinds do not cancel. Invented: White Ke4, pawn a7; Black Kh6, pawn h2. a8=Q h1=N: +6.
  const mixed = '8/P7/7k/8/4K3/8/7p/8 w - - 0 1', mixedLine = ['a7a8q', 'h2h1n'];
  const m = replay(mixed, mixedLine);
  assert.deepEqual(m.sans, ['a8=Q', 'h1=N']);
  assert.equal(boardNet(mixed, m.end.fen(), 'w'), 6);
  assert.equal(narrateLine(mixed, mixedLine).summary, 'White promotes a pawn to a queen, though Black also promotes a pawn to a knight.');
  assert.equal(narrateLine(mixed, mixedLine, { verdict: { side: 'w', win: 30 } }).summary,
    "White is a new queen for Black's new knight up at the end of this line, but the engine gives Black 70% to win.");
});

test('item 1: two new pieces are each named (was "two pawns to new pieces")', () => {
  // Invented: White Kc1, pawns a7 b7; Black Kh5, pawn h4. a8=Q h3 b8=Q (or b8=R).
  const fen = '8/PP6/8/7k/7p/8/8/2K5 w - - 0 1';
  for (const [last, settled, up, net] of [
    ['b7b8q', 'White promotes two pawns to two queens.', 'two new queens', 16],
    ['b7b8r', 'White promotes two pawns to a queen and a rook.', 'a new queen and a new rook', 12],
  ] as const) {
    const line = ['a7a8q', 'h4h3', last];
    assert.equal(boardNet(fen, replay(fen, line).end.fen(), 'w'), net);
    assert.equal(narrateLine(fen, line).material.net, net);
    assert.equal(narrateLine(fen, line).summary, settled);
    assert.equal(narrateLine(fen, line, { verdict: { side: 'w', winning: true } }).summary, settled, 'a verdict for the side ahead changes nothing');
    assert.equal(narrateLine(fen, line, { verdict: { side: 'b', winning: true } }).summary, `White is ${up} up at the end of this line, but Black is winning.`);
  }
});

test('item 1: the "so far" sentence names what was given too', () => {
  // Invented: White Kg1 Bb3, pawn a7; Black Kh8 Rb8 Nd4. Kg2 Nxb3 a8=Q, and the rook can take the new queen.
  const fen = '1r5k/P7/8/8/3n4/1B6/8/6K1 w - - 0 1', line = ['g1g2', 'd4b3', 'a7a8q'];
  assert.deepEqual(replay(fen, line).sans, ['Kg2', 'Nxb3', 'a8=Q']);
  const n = narrateLine(fen, line);
  assert.equal(n.material.net, 5);
  assert.equal(n.material.settled, false);
  assert.equal(n.summary, 'So far in this line White has promoted a pawn to a queen for a bishop, but the new queen can be taken.');
});

test('item 1 sweep: every public bank line with a promotion, and seeded promotion races, state the board count', () => {
  let lines = 0, statements = 0;
  const check = (fen: string, line: string[], where: string) => {
    const end = replay(fen, line).end.fen();
    for (const verdict of VERDICTS) {
      const n = narrateLine(fen, line, { verdict, maxPlies: 64 });
      const said = statedForWhite(n.summary);
      if (said === null) continue;
      statements++;
      const net = (n.material.pov === 'w' ? n.material.net : -n.material.net) + 0; // + 0: no -0
      assert.equal(net, boardNet(fen, end, 'w') + 0, `${where}: material.net is the board count`);
      assert.equal(said + 0, net, `${where} (${JSON.stringify(verdict)}): "${n.summary}"`);
    }
  };
  // The bundled bank's answer lines with a promotion, and every shorter line that ends on a promotion.
  for (const p of bank) {
    if (!p.moves.some(u => u.length === 5)) continue;
    for (let k = 1; k <= p.moves.length; k++) if (p.moves[k - 1].length === 5 || k === p.moves.length) { lines++; check(p.fen, p.moves.slice(0, k), `bank ${p.id} ${k}`); }
  }
  // Seeded random play from invented pawn races (captures and promotions preferred, underpromotions included).
  let seed = 20261113;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const starts = ['8/PP4k1/8/3n4/4b3/8/5pp1/1K6 w - - 0 1', '2r5/1P3pk1/8/8/8/8/1p3PK1/2R5 w - - 0 1', '4k3/1P5P/8/8/8/8/p5p1/4K3 b - - 0 1', '1n2k3/P1P5/8/8/8/8/5p1p/4K1N1 w - - 0 1'];
  for (const start of starts) {
    for (let g = 0; g < 20; g++) {
      const b = new Chess(start);
      const line: string[] = [];
      for (let i = 0; i < 14 && !b.isGameOver(); i++) {
        const moves = b.moves({ verbose: true });
        const sharp = moves.filter(m => m.promotion || m.captured);
        const m = sharp.length && rand() < 0.7 ? sharp[Math.floor(rand() * sharp.length)] : moves[Math.floor(rand() * moves.length)];
        b.move(m);
        line.push(`${m.from}${m.to}${m.promotion ?? ''}`);
        if (m.promotion || m.captured) { lines++; check(start, [...line], `race ${start} game ${g} ply ${i}`); }
      }
    }
  }
  assert.ok(lines >= 150 && statements >= 300, `lines ${lines}, statements ${statements}`);
});

// ---------------------------------------------------------------- item 2

test('item 2 (V1-6 part 3): a promoting pawn the side to move can take at once is not named; the line stays open', () => {
  // Invented: White Kg1, pawn c6; Black Kh8 Be5. After c7 the bishop can take the pawn.
  const fen = '7k/8/2P5/4b3/8/8/8/6K1 w - - 0 1';
  const { end } = replay(fen, ['c6c7']);
  assert.ok(end.moves({ verbose: true }).some(m => m.to === 'c7' && m.captured), 'fixture: Bxc7 is legal');
  const n = narrateLine(fen, ['c6c7']);
  assert.equal(n.material.settled, false, 'a pawn one step from promoting still leaves the line open');
  // Was "So far in this line no material changes hands, but White's pawn on c7 can promote."
  assert.equal(n.summary, 'So far in this line no material changes hands.');
  assert.doesNotMatch(narrateLine(fen, ['c6c7'], { noChangeSentence: false }).summary, /can promote/);
});

test('item 2: with two promoting pawns, the one the side to move cannot take is named', () => {
  // Invented: White Kb1, pawns c6 h7; Black Ka5 Be5. After c7 the bishop can take c7 but not h7.
  const fen = '8/7P/2P5/k3b3/8/8/8/1K6 w - - 0 1';
  const { end } = replay(fen, ['c6c7']);
  assert.ok(end.moves({ verbose: true }).some(m => m.to === 'c7' && m.captured), 'fixture: Bxc7 is legal');
  assert.ok(!end.moves({ verbose: true }).some(m => m.to === 'h7' && m.captured), 'fixture: nothing takes h7');
  const n = narrateLine(fen, ['c6c7']);
  assert.equal(n.material.settled, false);
  assert.equal(n.summary, "So far in this line no material changes hands, but White's pawn on h7 can promote.", 'was "… pawn on c7 can promote"');
});

test('item 2: a piece that attacks the pawn but cannot legally take it leaves the clause in', () => {
  // Invented: White Kg1 Re1, pawn c6; Black Ke8 Ne6. The knight on e6 attacks c7 but is pinned to its king.
  const fen = '4k3/8/2P1n3/8/8/8/8/4R1K1 w - - 0 1';
  const { end } = replay(fen, ['c6c7']);
  assert.ok(!end.moves({ verbose: true }).some(m => m.to === 'c7'), 'fixture: the pinned knight cannot take');
  assert.equal(narrateLine(fen, ['c6c7']).summary, "So far in this line no material changes hands, but White's pawn on c7 can promote.");
  // The skeptic's pawn race (fix round 2) is unchanged: nothing of White's can reach b2.
  assert.equal(narrateLine('8/2k4b/8/6N1/8/1p6/6PP/7K w - - 0 1', ['g5h7', 'b3b2']).summary, "So far in this line White has won a bishop, but Black's pawn on b2 can promote.");
});

test('item 2 sweep: no "can promote" clause names a pawn the side to move can take, over the bank and seeded races', () => {
  let clauses = 0, ends = 0;
  const check = (fen: string, line: string[], where: string) => {
    const n = narrateLine(fen, line, { maxPlies: 64 });
    const m = /(White|Black)'s pawn on ([a-h][1-8]) can promote/.exec(n.summary);
    ends++;
    if (!m) return;
    clauses++;
    const end = new Chess(n.plies[n.plies.length - 1].fenAfter);
    assert.ok(!end.moves({ verbose: true }).some(mv => mv.captured && mv.to === m[2]), `${where}: "${n.summary}"`);
  };
  // Every bank line that ends on a move to a seventh rank (where a pawn steps up), whole or cut there.
  for (const p of bank) for (let k = 1; k <= p.moves.length; k++) if (/[27]$/.test(p.moves[k - 1].slice(0, 4))) check(p.fen, p.moves.slice(0, k), `bank ${p.id} ${k}`);
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (const start of ['8/1P2k3/8/2b5/8/8/1p2K3/8 w - - 0 1', '4k3/P1P5/1n6/8/8/1N6/p1p5/4K3 w - - 0 1', '8/6P1/4k3/8/8/4K3/6p1/8 b - - 0 1']) {
    for (let g = 0; g < 25; g++) {
      const b = new Chess(start);
      const line: string[] = [];
      for (let i = 0; i < 10 && !b.isGameOver(); i++) {
        const moves = b.moves({ verbose: true });
        const m = moves[Math.floor(rand() * moves.length)];
        b.move(m);
        line.push(`${m.from}${m.to}${m.promotion ?? ''}`);
        check(start, [...line], `race ${start} game ${g} ply ${i}`);
      }
    }
  }
  assert.ok(ends > 1000 && clauses >= 10, `ends ${ends}, clauses ${clauses}`);
});
