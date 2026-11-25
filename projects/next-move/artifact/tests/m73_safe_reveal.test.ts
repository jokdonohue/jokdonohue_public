import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { safeQuestion } from '../components/safe';
import { lineNarration } from '../components/LineViewer';
import {
  AHEAD_LEAD, EVEN_TRADES_LEAD, NO_LOSS_LEAD, SAFE_FACT, SOUND_MAX_DROP, legalStart, safeReveal, sanLineToUci, storedFigures,
} from '../components/safeReveal';
import { SOUND_MAX_DROP as PRODUCER_SOUND_MAX_DROP } from '../src/importers/safeDocs';
import type { SafeCardDoc } from '../src/contract/docs';

// Version 7.3: what the "Safe or not?" answer panel says, from a card's stored facts. Every position and line here is
// invented for the test (ordinary opening moves); none comes from his games.
const fenAfter = (...sans: string[]) => { const b = new Chess(); for (const s of sans) b.move(s); return b.fen(); };
function card(over: { fen: string; played: string; kind: 'safe' | 'unsafe'; reveal?: Record<string, unknown> }): SafeCardDoc {
  return { id: 'judge-test:1', fen: over.fen, moves: [over.played], kind: over.kind, themes: ['safety'], reveal: over.reveal ?? {} } as SafeCardDoc;
}
const ask = (c: SafeCardDoc) => { const q = safeQuestion(c); assert.ok(q, 'the card has a readable question'); return q!; };

// 1.Nf3 e5 2.Ng5: the knight can simply be taken.
const HANGS = card({
  fen: fenAfter('Nf3', 'e5'), played: 'f3g5', kind: 'unsafe',
  reveal: { replyLineUci: ['d8g5', 'e2e3', 'g5g6', 'd2d3', 'b8c6', 'b1c3'], winBefore: 48.2, winAfter: 12.4, bestSan: 'd4', bestLineSan: ['d4', 'exd4', 'Nxd4'], explanation: 'producer sentence' },
});

test('a move that loses a piece: the lead is the count, the title says what the move allowed, the figures are the stored pair', () => {
  const q = ask(HANGS), r = safeReveal(q, HANGS);
  assert.equal(r.playedSan, 'Ng5');
  assert.equal(r.fact, SAFE_FACT.unsafe);
  assert.equal(r.lead, 'Black wins a knight.');
  assert.ok(r.reply);
  assert.deepEqual(r.reply!.line, ['f3g5', 'd8g5', 'e2e3', 'g5g6', 'd2d3', 'b8c6', 'b1c3']);
  assert.equal(r.reply!.shown, 'material');
  assert.equal(r.reply!.allowed, true);
  assert.equal(r.reply!.title, 'What your move Ng5 allowed');
  assert.deepEqual(r.reply!.verdict, { side: 'w', win: 12.4 });
  assert.equal(r.figures, 'Engine’s figures: 48% to win before your move, 12% after.');
  // The lead is exactly what the viewer closes this line on.
  assert.equal(lineNarration(q.fen, r.reply!.line, undefined, { verdict: r.reply!.verdict, noChangeSentence: false }).summary, r.lead);
});

test('the engine\'s choice: its stored SAN line as moves from the card position, with the figure before his move', () => {
  const r = safeReveal(ask(HANGS), HANGS);
  assert.deepEqual(r.best, { san: 'd4', line: ['d2d4', 'e5d4', 'f3d4'], verdict: { side: 'w', win: 48.2 }, title: 'The engine’s choice: d4', toggle: 'Show the line after d4' });
  // One stored move is still a choice to name; the same move as his own is not shown as another choice.
  const one = card({ fen: HANGS.fen, played: 'f3g5', kind: 'unsafe', reveal: { ...HANGS.reveal, bestLineSan: undefined, bestSan: 'd4' } });
  assert.deepEqual(safeReveal(ask(one), one).best?.line, ['d2d4']);
  const same = card({ fen: HANGS.fen, played: 'f3g5', kind: 'unsafe', reveal: { ...HANGS.reveal, bestLineSan: ['Ng5'], bestSan: 'Ng5' } });
  assert.equal(safeReveal(ask(same), same).best, null);
  const unreadable = card({ fen: HANGS.fen, played: 'f3g5', kind: 'unsafe', reveal: { ...HANGS.reveal, bestLineSan: ['Qh5'], bestSan: 'Qh5' } });
  assert.equal(safeReveal(ask(unreadable), unreadable).best, null);
});

test('a line with nothing taken: the lead says no piece or pawn is lost, never that he lost material', () => {
  // 1.e4 e5 2.f3 and six quiet developing moves.
  const c = card({ fen: fenAfter('e4', 'e5'), played: 'f2f3', kind: 'unsafe', reveal: { replyLineUci: ['b8c6', 'b1c3', 'g8f6', 'd2d3', 'f8c5', 'f1e2'], winBefore: 52, winAfter: 30 } });
  const r = safeReveal(ask(c), c);
  assert.equal(r.reply!.shown, 'nothing');
  assert.equal(r.lead, NO_LOSS_LEAD);
  assert.equal(r.reply!.allowed, true, 'his opponent stands at 70%: the title may say "allowed"');
  assert.equal(r.reply!.title, 'What your move f3 allowed');
  assert.doesNotMatch(r.lead, /wins|won|loses/);
  // The same card with his opponent under 65% after the move: the title only names the line.
  const mild = card({ fen: c.fen, played: 'f2f3', kind: 'unsafe', reveal: { ...c.reveal, winAfter: 40 } });
  assert.equal(safeReveal(ask(mild), mild).reply!.title, 'The engine’s line after your move f3');
});

test('even trades: the panel\'s own sentence, so "The trades are even." does not stand alone under "This move lost something."', () => {
  // 1.e4 d5 2.exd5 Qxd5 and quiet moves: a pawn each.
  const c = card({ fen: fenAfter('e4', 'd5'), played: 'e4d5', kind: 'unsafe', reveal: { replyLineUci: ['d8d5', 'b1c3', 'd5a5', 'd2d4', 'g8f6', 'g1f3'], winBefore: 55, winAfter: 33 } });
  const q = ask(c), r = safeReveal(q, c);
  assert.equal(lineNarration(q.fen, r.reply!.line, undefined, { verdict: r.reply!.verdict, noChangeSentence: false }).summary, 'The trades are even.');
  assert.equal(r.lead, EVEN_TRADES_LEAD);
  assert.equal(r.reply!.shown, 'nothing');
});

test('he is ahead in the count: the stored figure speaks against it, and without a figure the panel says so itself', () => {
  // 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nd4 4.Nxe5 Qg5: a pawn up, with the knight and g2 attacked.
  const fen = fenAfter('e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4');
  const c = card({ fen, played: 'f3e5', kind: 'unsafe', reveal: { replyLineUci: ['d8g5'], winBefore: 50, winAfter: 20 } });
  const r = safeReveal(ask(c), c);
  assert.equal(r.reply!.shown, 'nothing');
  assert.equal(r.lead, 'White is a pawn up at the end of this line, but the engine gives Black 80% to win.');
  assert.equal(r.reply!.allowed, false, 'ahead in material: the title never says "allowed"');
  assert.equal(r.reply!.title, 'The engine’s line after your move Nxe5');
  // Without a stored figure the narrator's sentence already says what is hanging: the panel keeps it (review of 7.3,
  // P2-11: the panel used to replace it with its own sentence and so dropped the point of the line).
  const bare = card({ fen, played: 'f3e5', kind: 'unsafe', reveal: { replyLineUci: ['d8g5'] } });
  const b = safeReveal(ask(bare), bare);
  assert.equal(b.lead, 'So far in this line White has won a pawn, but the queen on g5 attacks the knight on e5 and the pawn on g2.');
  assert.equal(b.figures, null);
  assert.equal(b.reply!.verdict, null);
  // The same with a figure that does not speak against the count (the top of what a blunder card can hold).
  const level = card({ fen, played: 'f3e5', kind: 'unsafe', reveal: { replyLineUci: ['d8g5'], winBefore: 70, winAfter: 55 } });
  assert.equal(safeReveal(ask(level), level).lead, b.lead);
  // A settled sentence that only names him as the winner would contradict "This move lost something.": the panel
  // says so itself. 1.e4 e5 2.Nf3 f6 3.Nxe5 d6 4.Nf3: a clean pawn up.
  const clean = card({ fen: fenAfter('e4', 'e5', 'Nf3', 'f6'), played: 'f3e5', kind: 'unsafe', reveal: { replyLineUci: ['d7d6', 'e5f3'] } });
  const cl = safeReveal(ask(clean), clean);
  assert.equal(lineNarration(clean.fen, cl.reply!.line, undefined, { verdict: null, noChangeSentence: false }).summary, 'White wins a pawn.');
  assert.equal(cl.lead, AHEAD_LEAD);
  assert.equal(cl.reply!.shown, 'nothing');
});

test('odd data, a line that ends in mate by him on a card judged a blunder: the lead is the viewer\'s sentence, not "ahead in material"', () => {
  // 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6 4.Qxf7#. No real card should hold this; the panel must still not invent a material story.
  const c = card({ fen: fenAfter('e4', 'e5', 'Bc4', 'Nc6'), played: 'd1h5', kind: 'unsafe', reveal: { replyLineUci: ['g8f6', 'h5f7'], winBefore: 50, winAfter: 20 } });
  const r = safeReveal(ask(c), c);
  assert.equal(r.lead, 'The line ends in checkmate by White.');
  assert.equal(r.reply!.shown, 'nothing');
});

test('a line that ends in mate against him', () => {
  // The same opening carried to its mate: 4.Nxe5 Qg5 5.Nxf7 Qxg2 6.Rf1 Qxe4+ 7.Be2 Nf3#.
  const c = card({
    fen: fenAfter('e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4'), played: 'f3e5', kind: 'unsafe',
    reveal: { replyLineUci: ['d8g5', 'e5f7', 'g5g2', 'h1f1', 'g2e4', 'c4e2', 'd4f3'], winBefore: 50, winAfter: 3 },
  });
  const r = safeReveal(ask(c), c);
  assert.equal(r.reply!.shown, 'mate');
  assert.equal(r.lead, 'The line ends in checkmate by Black.');
  assert.equal(r.reply!.title, 'What your move Nxe5 allowed');
});

test('a stored reply that is not legal is cut there; with no legal reply the producer\'s sentence is all the panel has', () => {
  const cut = card({ fen: HANGS.fen, played: 'f3g5', kind: 'unsafe', reveal: { ...HANGS.reveal, replyLineUci: ['d8g5', 'e2e5', 'g5g6'] } });
  assert.deepEqual(safeReveal(ask(cut), cut).reply!.line, ['f3g5', 'd8g5']);
  const none = card({ fen: HANGS.fen, played: 'f3g5', kind: 'unsafe', reveal: { ...HANGS.reveal, replyLineUci: ['a1a8'] } });
  const r = safeReveal(ask(none), none);
  assert.equal(r.reply, null);
  assert.equal(r.lead, 'producer sentence');
  assert.equal(r.figures, null, 'the producer\'s sentence carries its own figures');
  const empty = card({ fen: HANGS.fen, played: 'f3g5', kind: 'unsafe' });
  assert.deepEqual(safeReveal(ask(empty), empty), { playedSan: 'Ng5', fact: SAFE_FACT.unsafe, lead: '', reply: null, best: null, figures: null });
});

test('a sound move: no reply line, plain words, the stored pair', () => {
  const fen = fenAfter('e4', 'e5');
  const first = card({ fen, played: 'g1f3', kind: 'safe', reveal: { winBefore: 53.6, winAfter: 53.1, engineBest: true, explanation: 'producer sentence' } });
  assert.deepEqual(safeReveal(ask(first), first), {
    playedSan: 'Nf3', fact: SAFE_FACT.safe, lead: 'Nf3 gave nothing away. It was also the engine’s first choice.', reply: null, best: null,
    figures: 'Engine’s figures: 54% to win before your move, 53% after.',
  });
  const other = card({ fen, played: 'b1c3', kind: 'safe', reveal: { winBefore: 53.6, winAfter: 52.2, engineBest: false, bestSan: 'Nf3' } });
  assert.equal(safeReveal(ask(other), other).lead, 'Nc3 gave nothing away. The engine’s first choice was Nf3, which it rates about the same.');
  // The words speak of the change, not of the level: a sound move in a worse (or better) position did not keep a
  // "balance", and the card's own figures would say so on the next line. The producer takes sound moves from positions
  // anywhere between 30% and 70% to win.
  for (const [before, after] of [[30.5, 30], [69.5, 68], [50, 51.5]] as const) {
    const far = card({ fen, played: 'b1c3', kind: 'safe', reveal: { winBefore: before, winAfter: after, engineBest: false, bestSan: 'Nf3' } });
    const r = safeReveal(ask(far), far);
    assert.equal(r.lead, 'Nc3 gave nothing away. The engine’s first choice was Nf3, which it rates about the same.', `${before} to ${after}`);
    assert.doesNotMatch(r.lead, /balance|level|equal/i);
    assert.equal(r.figures, `Engine’s figures: ${Math.round(before)}% to win before your move, ${Math.round(after)}% after.`);
  }
  // Said only when the stored pair bears it out (the producer's rule: a fall of less than two points). A card marked
  // sound whose figure fell further gets the producer's sentence alone, with no second set of figures.
  assert.equal(SOUND_MAX_DROP, PRODUCER_SOUND_MAX_DROP);
  const fell = card({ fen, played: 'b1c3', kind: 'safe', reveal: { winBefore: 55, winAfter: 53, engineBest: false, bestSan: 'Nf3', explanation: 'producer sentence' } });
  assert.deepEqual(safeReveal(ask(fell), fell), { playedSan: 'Nc3', fact: SAFE_FACT.safe, lead: 'producer sentence', reply: null, best: null, figures: null });
  // A stored figure that ROSE (the producer's rule passes any fall under two points, so also a rise): the move gave
  // nothing away, but the engine does not rate the two moves "about the same", and the line does not say so.
  const rose = card({ fen, played: 'b1c3', kind: 'safe', reveal: { winBefore: 40, winAfter: 52, engineBest: false, bestSan: 'Nf3' } });
  assert.equal(safeReveal(ask(rose), rose).lead, 'Nc3 gave nothing away. The engine’s first choice was Nf3.');
  const justUnder = card({ fen, played: 'b1c3', kind: 'safe', reveal: { winBefore: 55, winAfter: 53.05, engineBest: true } });
  assert.equal(safeReveal(ask(justUnder), justUnder).lead, 'Nc3 gave nothing away. It was also the engine’s first choice.');
  const bare = card({ fen, played: 'b1c3', kind: 'safe', reveal: { explanation: 'producer sentence' } });
  assert.equal(safeReveal(ask(bare), bare).lead, 'producer sentence');
});

test('helpers never throw on bad input', () => {
  assert.deepEqual(legalStart('not a fen', ['e2e4']), []);
  assert.deepEqual(legalStart(new Chess().fen(), ['e2e4', 7, 'e7e5']), ['e2e4']);
  assert.deepEqual(sanLineToUci(new Chess().fen(), ['e4', 'e5', 'Ke3', 'Nf6']), ['e2e4', 'e7e5']);
  assert.deepEqual(sanLineToUci('not a fen', ['e4']), []);
  assert.equal(storedFigures(50, null), null);
  assert.equal(storedFigures('50', 20), null);
});
