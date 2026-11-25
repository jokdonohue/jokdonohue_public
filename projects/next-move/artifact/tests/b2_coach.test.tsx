import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import CoachPanel, { coachLabel } from '../components/CoachPanel';
import { explainInput, sanLine, staticExplanation } from '../components/coachInput';
import type { CoachClient } from '../src/contract/coach';

// White: Ra1, Kg1, pawns f2 g2 h2; Black: Kg8, pawns f7 g7 h7. Ra8 is mate; Kf1 is the "game move".
const FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const fakeCoach: CoachClient = { availability: async () => 'granted', ask: async () => { throw new Error('not called'); }, limits: () => ({ remainingToday: 20, cooldownUntil: 0 }) };

test('coach input: lines in SAN; stored refutation and numbers only for the game move itself', () => {
  assert.deepEqual(sanLine(FEN, ['a1a8', 'zz']), ['Ra8#']);
  const card = { id: 'pack-0000000000000001', fen: FEN, moves: ['a1a8'], themes: ['backRankMate'], pack: { playedUci: 'g1f1', refutationPvUci: ['g8f8'], winBefore: 99, winAfter: 60, cpBefore: 900, cpAfter: 300 } };
  const same = explainInput(card, { fen: FEN, uci: 'g1f1', index: 0 }, 'pack');
  assert.ok(same);
  assert.equal(same.playedSan, 'Kf1'); assert.equal(same.bestSan, 'Ra8#'); assert.deepEqual(same.bestLineSan, ['Ra8#']);
  assert.deepEqual(same.refutationSan, ['Kf8']); assert.equal(same.winBefore, 99); assert.equal(same.winAfter, 60); assert.equal(same.cpAfter, 300);
  assert.equal(same.side, 'w');
  const other = explainInput(card, { fen: FEN, uci: 'a1a7', index: 0 }, 'pack');
  assert.ok(other);
  assert.deepEqual(other.refutationSan, []); assert.equal(other.winBefore, undefined); assert.equal(other.cpBefore, undefined);
  const bank = explainInput({ id: '00abc', fen: FEN, moves: ['a1a8'], themes: ['mateIn1'] }, { fen: FEN, uci: 'h2h3', index: 0 }, 'bank');
  assert.equal(bank?.winBefore, undefined);
  assert.equal(staticExplanation(bank!).numbers, null);
  assert.match(staticExplanation(same).numbers ?? '', /99% before, 60% after/);
  assert.equal(explainInput(card, { fen: FEN, uci: 'a1h8', index: 0 }, 'pack'), null, 'an illegal move gives no input');
});

test('coach button: a null coach hides the button and keeps the static panel', () => {
  const input = explainInput({ id: '00abc', fen: FEN, moves: ['a1a8'], themes: ['mateIn1'] }, { fen: FEN, uci: 'h2h3', index: 0 }, 'bank')!;
  const html = renderToStaticMarkup(<CoachPanel coach={null} input={input} initialAvailability="granted"/>);
  assert.match(html, /You played h3\./);
  assert.match(html, /Ra8#/);
  assert.doesNotMatch(html, /<button/);
  assert.equal(coachLabel(null, 'granted'), null);
});

test('coach button: label follows the permission state; denied and unavailable hide it', () => {
  assert.equal(coachLabel(fakeCoach, 'granted'), 'Why does my move fail?');
  assert.equal(coachLabel(fakeCoach, 'prompt'), 'Ask Claude (asks permission once)');
  assert.equal(coachLabel(fakeCoach, 'denied'), null);
  assert.equal(coachLabel(fakeCoach, 'unavailable'), null);
  assert.equal(coachLabel(fakeCoach, 'unknown'), null, 'hidden until the state is known; never prompts on load');
  const input = explainInput({ id: '00abc', fen: FEN, moves: ['a1a8'], themes: ['mateIn1'] }, { fen: FEN, uci: 'h2h3', index: 0 }, 'bank')!;
  const html = renderToStaticMarkup(<CoachPanel coach={fakeCoach} input={input} initialAvailability="prompt" revealsAnswer/>);
  assert.match(html, /Ask Claude \(asks permission once\)/);
  assert.match(html, /This shows the answer for this position\./);
  assert.doesNotMatch(html, /Ra8/, 'mid-attempt: no best move or line on screen');
  assert.doesNotMatch(renderToStaticMarkup(<CoachPanel coach={null} input={input} revealsAnswer/>), /Ra8/);
});
