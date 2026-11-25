import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { endgameDrills } from '../lib/endgames';
import { drillTeach, positionKey, teachDrillIds, teachStep, teachTry, type TeachResult } from '../lib/endgameTeach';
import { ARTIFACT_DIR } from './b3_paths';

// M3 L9: teaching data for the 26 technique drills (data/technical_endgames_teach.json, built by
// reviews/claude/tools/m3/endgame_teach/ from the Lichess Syzygy tablebase). Every line must replay legally,
// every listed result must match the tablebase, and every note must be about its own line.
// The tablebase cache (reviews/claude/data/verification/tbcache.json, or NEXT_MOVE_TB_CACHE) is not part of
// the public copy: without it the comparison test skips and the file is checked for internal consistency only.

const DATA = join(ARTIFACT_DIR, 'data/technical_endgames_teach.json');
const CACHE = process.env.NEXT_MOVE_TB_CACHE || join(ARTIFACT_DIR, '../reviews/claude/data/verification/tbcache.json');
interface RawTry { uci: string; san: string; result: string; lineUci: string[]; note: string }
interface RawStep { step: number; fen: string; win: string[]; draw: string[]; loss: string[]; tries: RawTry[] }
interface RawDrill { id: string; idea: string; keySquares?: string[]; steps: RawStep[] }
const file = JSON.parse(readFileSync(DATA, 'utf8')) as { version: number; drills: RawDrill[] };

const RANK: Record<TeachResult, number> = { win: 2, draw: 1, loss: 0 };
const target = (themes: readonly string[]): TeachResult => (themes.includes('planb') ? 'draw' : 'win');
const play = (b: Chess, uci: string) => b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
const uciOf = (m: { from: string; to: string; promotion?: string }) => m.from + m.to + (m.promotion ?? '');
const strip = (san: string) => san.replace(/[+#]/g, '');
const drillById = new Map(endgameDrills.map(d => [d.id, d]));

/** Position after replaying the drill's first `ply` moves. */
function positionAt(id: string, ply: number): Chess {
  const d = drillById.get(id)!;
  const b = new Chess(d.fen);
  for (const u of d.moves.slice(0, ply)) play(b, u);
  return b;
}
/** SAN of the try and of each line ply, plus the board after the whole line. */
function replayTry(fen: string, t: RawTry) {
  const b = new Chess(fen);
  const trySan = play(b, t.uci).san;
  const afterTry = new Chess(b.fen());
  const sans = t.lineUci.map(u => play(b, u).san);
  return { trySan, afterTry, sans, end: b };
}
const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
/** No pawns and equal material on both sides (rook against rook, queen against queen). */
function deadDraw(b: Chess): boolean {
  const pieces = b.board().flat().filter(p => p !== null);
  if (pieces.some(p => p!.type === 'p')) return false;
  const side = (c: 'w' | 'b') => pieces.filter(p => p!.color === c).reduce((n, p) => n + VALUE[p!.type], 0);
  return side('w') === side('b');
}
function directOpposition(b: Chess): boolean {
  const kings = b.board().flat().filter(p => p?.type === 'k').map(p => p!.square);
  const [a, c] = kings;
  const df = Math.abs(a.charCodeAt(0) - c.charCodeAt(0)), dr = Math.abs(Number(a[1]) - Number(c[1]));
  return (df === 0 && dr === 2) || (dr === 0 && df === 2);
}
// Piece moves and pawn captures named in prose (a bare pawn push looks like a square name, so it is not checked).
const MOVE_TOKEN = /\b(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=[QRBN])?)[+#]?/g;

test('the file covers exactly the 26 drills, stays under 120 KB, and its version is 1', () => {
  assert.equal(file.version, 1);
  assert.ok(statSync(DATA).size < 120 * 1024, `technical_endgames_teach.json is ${statSync(DATA).size} bytes`);
  // the provenance beside it (not imported by the page) describes this exact file
  const provenance = JSON.parse(readFileSync(DATA.replace(/\.json$/, '.provenance.json'), 'utf8')) as { output_sha256: string; counts: { drills: number; tries: number } };
  assert.equal(createHash('sha256').update(readFileSync(DATA)).digest('hex'), provenance.output_sha256);
  assert.equal(provenance.counts.drills, file.drills.length);
  assert.equal(provenance.counts.tries, file.drills.reduce((n, d) => n + d.steps.reduce((m, s) => m + s.tries.length, 0), 0));
  const ids = file.drills.map(d => d.id);
  assert.equal(new Set(ids).size, ids.length, 'drill ids are unique');
  for (const id of ids) assert.ok(drillById.has(id), `${id} exists in data/technical_endgames.json`);
  assert.deepEqual(new Set(ids), new Set(drillById.keys()), 'every drill has teaching data');
  assert.deepEqual(new Set(teachDrillIds()), new Set(ids));
});

test('ideas are plain, at most 280 characters, and do not give away a solver move', () => {
  for (const d of file.drills) {
    assert.ok(d.idea.trim().length > 40 && d.idea.length <= 280, `${d.id} idea length ${d.idea.length}`);
    assert.ok(!/[!—]/.test(d.idea), `${d.id} idea has no exclamation mark or em dash`);
    const drill = drillById.get(d.id)!;
    const b = new Chess(drill.fen);
    const solverSans: string[] = [];
    drill.moves.forEach((u, i) => { const san = play(b, u).san; if (i % 2 === 0) solverSans.push(strip(san)); });
    for (const token of d.idea.match(MOVE_TOKEN) ?? []) assert.ok(!solverSans.includes(strip(token)), `${d.id} idea names the solver move ${token}`);
    for (const sq of d.keySquares ?? []) assert.match(sq, /^[a-h][1-8]$/, `${d.id} key square ${sq}`);
  }
});

test('every solver step is listed at its position, with the result of every legal move', () => {
  for (const d of file.drills) {
    const drill = drillById.get(d.id)!;
    const want = target(drill.themes);
    assert.deepEqual(d.steps.map(s => s.step), drill.moves.map((_, i) => i).filter(i => i % 2 === 0), `${d.id} steps`);
    for (const s of d.steps) {
      const b = positionAt(d.id, s.step);
      assert.equal(positionKey(s.fen), positionKey(b.fen()), `${d.id} step ${s.step} fen`);
      const legal = b.moves({ verbose: true }).map(uciOf).sort();
      const listed = [...s.win, ...s.draw, ...s.loss].sort();
      assert.deepEqual(listed, legal, `${d.id} step ${s.step}: results cover exactly the legal moves`);
      const answer = drill.moves[s.step];
      const result = s.win.includes(answer) ? 'win' : s.draw.includes(answer) ? 'draw' : 'loss';
      assert.equal(result, want, `${d.id} step ${s.step}: the drill move keeps the ${want}`);
    }
  }
});

test('tries: at most four per step, legal, with the step result, a legal line of at most 10 plies and a true note', () => {
  let tries = 0;
  for (const d of file.drills) {
    const drill = drillById.get(d.id)!;
    const want = target(drill.themes);
    const mateDrill = drill.themes.includes('mate');
    for (const s of d.steps) {
      assert.ok(s.tries.length <= 4, `${d.id} step ${s.step} has ${s.tries.length} tries`);
      const answer = drill.moves[s.step];
      const answerSan = strip(new Chess(s.fen).move({ from: answer.slice(0, 2), to: answer.slice(2, 4), promotion: answer[4] }).san);
      assert.equal(new Set(s.tries.map(t => t.uci)).size, s.tries.length, `${d.id} step ${s.step}: tries are distinct`);
      for (const t of s.tries) {
        tries++;
        const where = `${d.id} step ${s.step} try ${t.san}`;
        assert.notEqual(t.uci, answer, `${where} is not the drill move`);
        const listed: TeachResult = s.win.includes(t.uci) ? 'win' : s.draw.includes(t.uci) ? 'draw' : 'loss';
        assert.equal(t.result, listed, `${where}: result matches the step's list`);
        // A try either changes the result, or (mate drills) is a slower win that the note explains.
        assert.ok(RANK[t.result as TeachResult] < RANK[want] || (mateDrill && t.result === 'win'), `${where} is a real alternative`);
        assert.ok(t.lineUci.length <= 10, `${where} line has ${t.lineUci.length} plies`);
        let replay: ReturnType<typeof replayTry>;
        try { replay = replayTry(s.fen, t); } catch (e) { assert.fail(`${where}: line is not legal (${(e as Error).message})`); }
        assert.equal(replay.trySan, t.san, `${where} SAN`);
        assert.ok(t.lineUci.length > 0 || replay.afterTry.isGameOver(), `${where}: an empty line only when the try ends the game`);
        // A line stops early only when the game is over, or (drawn lines) when no pawns are left and material is level.
        if (t.lineUci.length < 10) assert.ok(replay.end.isGameOver() || (t.result === 'draw' && deadDraw(replay.end)), `${where}: a short line ends the game`);
        // Note: one plain sentence about this line.
        const n = t.note;
        assert.ok(n.length >= 20 && n.length <= 200, `${where} note length ${n.length}`);
        assert.ok(n.endsWith('.') && !/[.?]\s+[A-Z]/.test(n.slice(0, -1)) && !/[!—]/.test(n), `${where}: one plain sentence: ${n}`);
        const named = [strip(replay.trySan), ...replay.sans.map(strip), answerSan];
        for (const token of n.match(MOVE_TOKEN) ?? []) assert.ok(named.includes(strip(token)), `${where}: note names ${token}, which is not in its line`);
        assert.ok(n.includes(strip(t.san)), `${where}: note names the try`);
        if (/stalemate/i.test(n)) assert.ok(replay.afterTry.isStalemate() || replay.end.isStalemate(), `${where}: stalemate claimed`);
        if (/checkmate|is mate\b/i.test(n)) assert.ok(replay.end.isCheckmate(), `${where}: mate claimed`);
        if (/promot|queens\b/i.test(n)) assert.ok(replay.sans.some(x => x.includes('=')), `${where}: promotion claimed`);
        // a promotion the note names ("b1=Q", "promotes on a8", "queens on h1 with check") is in the line
        const allSans = [replay.trySan, ...replay.sans];
        for (const tok of n.match(/\b[a-h][18]=[QRBN][+#]?/g) ?? [])
          assert.ok(allSans.some(x => x === tok || (!/[+#]$/.test(tok) && strip(x) === tok)), `${where}: note names ${tok}, which is not in its line`);
        for (const m of n.matchAll(/(?:promotes|queens)(?: at once)? on ([a-h][1-8])( with check)?/g)) {
          const promo = replay.sans.find(x => x.includes('=') && x.replace(/^[a-h]x/, '').startsWith(m[1]));
          assert.ok(promo, `${where}: a promotion on ${m[1]} is claimed`);
          if (m[2]) assert.ok(promo!.includes('+'), `${where}: the promotion on ${m[1]} gives check`);
        }
        // "takes the opposition with Kd6", "with Kb7 it takes the opposition", "Kd5 Black has the opposition":
        // after that move (its first appearance) the kings face each other with one square between, made by the named side.
        if (/opposition/i.test(n)) {
          const binds: Array<{ san: string; side?: string }> = [
            ...[...n.matchAll(/(?:(Black|White)(?:'s king)? )?(?:takes|take|taking) the opposition with (Kx?[a-h][1-8])/g)].map(m => ({ side: m[1], san: m[2] })),
            ...[...n.matchAll(/with (Kx?[a-h][1-8]) it takes the opposition/g)].map(m => ({ san: m[1] })),
            ...[...n.matchAll(/(Kx?[a-h][1-8]),? (?:(Black|White) )?(?:and )?has the opposition/g)].map(m => ({ san: m[1], side: m[2] })),
          ];
          assert.ok(binds.length > 0, `${where}: an opposition claim names the move that takes it`);
          for (const bind of binds) {
            const k = allSans.findIndex(x => strip(x) === bind.san);
            assert.ok(k >= 0, `${where}: ${bind.san} is in the line`);
            const b = new Chess(s.fen);
            [t.uci, ...t.lineUci].slice(0, k + 1).forEach(u => play(b, u));
            assert.ok(directOpposition(b), `${where}: the kings face each other after ${bind.san}`);
            if (bind.side) assert.equal(b.turn() === 'w' ? 'Black' : 'White', bind.side, `${where}: ${bind.san} is ${bind.side}'s move`);
          }
        }
        for (const [word, piece] of [['pawn', 'p'], ['rook', 'r'], ['queen', 'q'], ['bishop', 'b']] as const) {
          if (new RegExp(`(takes|wins|captures|loses|hangs|gives up) (the|your|its|a|White's|Black's) ${word}`, 'i').test(n)) {
            const b = new Chess(s.fen);
            const caps = [play(b, t.uci), ...t.lineUci.map(u => play(b, u))].filter(m => m.captured === piece);
            assert.ok(caps.length > 0, `${where}: a ${word} capture is claimed`);
          }
        }
        if (t.result === 'draw') assert.match(n, /draw|hold|stalemate/i, `${where}: a drawing try says so`);
        if (t.result === 'loss') assert.match(n, /\bwins?\b|\blos(e|es|ing)\b/i, `${where}: a losing try says so`);
        if (t.result === 'win') assert.match(n, /\bwins?\b|\bmate\b/i, `${where}: a slower win says so`);
      }
    }
  }
  assert.ok(tries >= 80, `${tries} tries in all`);
});

test('every result and every line matches the tablebase cache', { skip: existsSync(CACHE) ? false : `tablebase cache not found at ${CACHE}: compared against the file's own consistency only` }, () => {
  const cache = JSON.parse(readFileSync(CACHE, 'utf8')) as Record<string, { category: string; dtm: number | null; moves: Array<{ uci: string; category: string; dtm: number | null; checkmate: boolean }> }>;
  const mover = (c: string): TeachResult => {
    const v = ({ loss: 'win', win: 'loss', draw: 'draw', 'cursed-win': 'draw', 'blessed-loss': 'draw' } as Record<string, TeachResult>)[c];
    assert.ok(v, `category ${c}`);
    return v;
  };
  const sideToMove = (c: string): TeachResult => ({ win: 'win', loss: 'loss', draw: 'draw', 'cursed-win': 'draw', 'blessed-loss': 'draw' } as Record<string, TeachResult>)[c];
  let positions = 0;
  for (const d of file.drills) {
    for (const s of d.steps) {
      const entry = cache[positionKey(s.fen)];
      assert.ok(entry, `${d.id} step ${s.step}: position is in the cache`);
      positions++;
      const listed = new Map<string, TeachResult>([...s.win.map(u => [u, 'win'] as const), ...s.draw.map(u => [u, 'draw'] as const), ...s.loss.map(u => [u, 'loss'] as const)]);
      assert.equal(entry.moves.length, listed.size, `${d.id} step ${s.step}: move count`);
      for (const m of entry.moves) assert.equal(listed.get(m.uci), mover(m.category), `${d.id} step ${s.step} ${m.uci}`);
      const answer = drillById.get(d.id)!.moves[s.step];
      const answerDtm = (m => (m.checkmate ? 0 : Math.abs(m.dtm ?? NaN)))(entry.moves.find(m => m.uci === answer)!);
      for (const t of s.tries) {
        const where = `${d.id} step ${s.step} try ${t.san}`;
        const tryInfo = entry.moves.find(m => m.uci === t.uci)!;
        if (t.result === 'win') {
          // A slower win: the note says how many moves longer the mate takes (DTM is in plies).
          const tryDtm = Math.abs(tryInfo.dtm ?? NaN);
          assert.ok(tryDtm > answerDtm, `${where}: mate takes longer (dtm ${tryInfo.dtm} vs ${answerDtm})`);
          const said = t.note.match(/\b(\w+) moves? longer\b/);
          assert.ok(said, `${where}: the note says how much longer the mate takes`);
          const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
          assert.equal(words[said![1]] ?? Number(said![1]), (tryDtm - answerDtm) / 2, `${where}: "${said![0]}"`);
        }
        // Along the line, each move keeps the result of the side that plays it (the tablebase's best category).
        const b = new Chess(s.fen); play(b, t.uci);
        if (/only move that holds|only drawing move|only move that wins/i.test(t.note)) {
          const pos = cache[positionKey(b.fen())];
          const keep = pos.moves.filter(m => mover(m.category) === sideToMove(pos.category));
          assert.deepEqual(keep.map(m => m.uci), [t.lineUci[0]], `${where}: "only move" claim`);
          // and the move named just before "the only move" is that reply
          const named = t.note.match(/([KQRBN]x?[a-h][1-8]|[a-h]x?[a-h]?[1-8](?:=[QRBN])?)[+#]?,? the only (?:move that holds|drawing move|move that wins)/);
          const reply = new Chess(b.fen()).move({ from: t.lineUci[0].slice(0, 2), to: t.lineUci[0].slice(2, 4), promotion: t.lineUci[0][4] }).san;
          assert.equal(named?.[1], strip(reply), `${where}: "only move" names the reply`);
        }
        for (const [i, u] of t.lineUci.entries()) {
          const pos = cache[positionKey(b.fen())];
          assert.ok(pos, `${where} ply ${i}: position is in the cache`);
          positions++;
          const mv = pos.moves.find(m => m.uci === u);
          assert.ok(mv, `${where} ply ${i}: ${u} listed`);
          assert.equal(mover(mv.category), sideToMove(pos.category), `${where} ply ${i}: ${u} keeps the result`);
          if (i === 0) assert.equal(RANK[sideToMove(pos.category)], 2 - RANK[t.result as TeachResult], `${where}: the opponent's view after the try`);
          play(b, u);
        }
      }
    }
  }
  console.log(`checked ${positions} positions against the tablebase cache`);
});

test("take-the-opposition drill: after 1.e4 Black takes the opposition with Kd6 and holds; 1.Ke4 wins", () => {
  const id = 'tech-kpk-take-the-opposition';
  const fen = '8/8/4k3/8/3K4/4P3/8/8 w - - 0 1';
  const step = teachStep(id, fen)!;
  assert.ok(step, 'step 0 found by its position');
  assert.equal(step.results.d4e4, 'win');
  assert.equal(step.results.e3e4, 'draw');
  const { result, tryLine } = teachTry(id, fen, 'e3e4');
  assert.equal(result, 'draw');
  assert.ok(tryLine, 'e4 has a stored line');
  assert.equal(tryLine!.lineUci[0], 'e6d6', 'Black answers Kd6');
  const b = new Chess(fen); play(b, 'e3e4'); play(b, 'e6d6');
  assert.ok(directOpposition(b) && b.turn() === 'w', 'after Kd6 the kings face each other with White to move');
  assert.match(tryLine!.note, /Kd6/);
  assert.match(tryLine!.note, /opposition/);
  const cacheOk = existsSync(CACHE);
  if (cacheOk) {
    const cache = JSON.parse(readFileSync(CACHE, 'utf8')) as Record<string, { category: string }>;
    assert.equal(cache['8/8/4k3/8/3KP3/8/8/8 b - -']?.category, 'draw', 'tablebase: after e4, Black to move draws');
    assert.equal(cache['8/8/4k3/8/4K3/4P3/8/8 b - -']?.category, 'loss', 'tablebase: after Ke4, Black to move loses');
  }
});

test('loader: drillTeach and teachTry', () => {
  assert.equal(drillTeach('no-such-drill'), null);
  const id = 'tech-kpk-take-the-opposition';
  const d = drillTeach(id)!;
  assert.equal(d.id, id);
  assert.ok(d.idea.length > 0 && d.steps.length === 1);
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.steps[0].results));
  // clocks are ignored when matching the position; an unknown position or move gives a null result
  assert.equal(teachTry(id, '8/8/4k3/8/3K4/4P3/8/8 w - - 7 30', 'd4e4').result, 'win');
  assert.deepEqual(teachTry(id, '8/8/4k3/8/3K4/4P3/8/8 w - - 0 1', 'd4e4'), { result: 'win' });
  assert.deepEqual(teachTry(id, '8/8/8/8/8/8/8/K6k w - - 0 1', 'a1a2'), { result: null });
  assert.deepEqual(teachTry('no-such-drill', '8/8/4k3/8/3K4/4P3/8/8 w - - 0 1', 'd4e4'), { result: null });
  assert.equal(teachTry(id, '8/8/4k3/8/3K4/4P3/8/8 w - - 0 1', 'a1a2').result, null);
  // every listed try is returned with its line
  for (const drill of file.drills) for (const s of drill.steps) for (const t of s.tries) {
    const got = teachTry(drill.id, s.fen, t.uci);
    assert.equal(got.result, t.result);
    assert.deepEqual(got.tryLine?.lineUci, t.lineUci);
  }
});
