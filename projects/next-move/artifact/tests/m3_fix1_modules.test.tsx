/**
 * M3 fix pass, writer FX1 (brief 9.9.2 a-d and 9.10 j, k, l): the coach button label by verdict, the coach panel
 * that renders nothing, viewer captions that never name a move still ahead, the corrected drill sentence, "at least
 * as highly", "instead of" as a move cue, and "mate in one" in a note grounding "mate in 1".
 * Fix round 2 (FX4a): brief 9.11.2 (p) removed the accept copy, so test (d) now pins its replacement.
 * Positions are textbook (Scholar's mate, the French Defence after 1.e4 e6 2.d4 d5, the drills' own positions) or
 * invented (a back-rank mate); none comes from the owner's games.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chess } from 'chess.js';
import CoachPanel, { coachLabel, panelHasContent, EXPLAIN_FAIL_LABEL, EXPLAIN_NEUTRAL_LABEL, type PanelParts } from '../components/CoachPanel';
import LineViewer, { lineNarration, moveLabel } from '../components/LineViewer';
import { explainInput, movesNamed } from '../components/coachInput';
import { narrateLine } from '../src/teach/narrate';
import { gradeTry, type EngineKind } from '../src/teach/grade';
import type { TryCheck } from '../src/teach/tryMove';
import { buildAskPrompt, buildExplainPrompt, groundCheck } from '../src/coach/index';
import type { CoachAskInput, CoachClient, CoachExplainInput, CoachTryVerdict } from '../src/contract/coach';
import { endgameDrills } from '../lib/endgames';
import { drillTeach } from '../lib/endgameTeach';
import { ARTIFACT_DIR } from './b3_paths';

const START = new Chess().fen();
/** FEN after SAN moves from the start (or `from`), played by chess.js. */
const play = (sans: string[], from?: string) => { const b = new Chess(from); for (const s of sans) b.move(s); return b.fen(); };
/** 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6 4.Qxf7#: 3...Nf6 allows Qxf7#. */
const SCHOLAR = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
/** Black to move after 1.e4 e5 2.Bc4 Nc6 3.Qh5. */
const AFTER_QH5 = play(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5']);
/** Invented back rank: Rd7 leaves the first rank, and Re1 mates. */
const BACK_RANK = '4r1k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
/** French Defence after 1.e4 e6 2.d4 d5, White to move. */
const FRENCH = 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6 0 3';

const coach: CoachClient = { availability: async () => 'granted', ask: async () => { throw new Error('not called'); }, limits: () => ({ remainingToday: 20, cooldownUntil: 0 }) };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

test('fixtures are legal and say what the tests rely on', () => {
  const b = new Chess(); for (const u of SCHOLAR) b.move({ from: u.slice(0, 2), to: u.slice(2, 4) });
  assert.ok(b.isCheckmate(), "Scholar's mate ends in mate");
  const r = new Chess(BACK_RANK); r.move('Rd7'); r.move('Re1#');
  assert.ok(r.isCheckmate(), 'Re1 mates after Rd7');
  assert.deepEqual(new Chess(FRENCH).moves().filter(s => ['Nc3', 'e5', 'exd5'].includes(s)).sort(), ['Nc3', 'e5', 'exd5']);
});

// ---------------------------------------------------------------- (a) the explain button's label follows the verdict

/** A wrong move on a bank card (h3 where Ra8 mates), as the page builds it, with the given verdict. */
function wrongInput(tryVerdict?: CoachTryVerdict): CoachExplainInput {
  const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
  const input = explainInput({ id: '00abc', fen, moves: ['a1a8'], themes: ['mateIn1'] }, { fen, uci: 'h2h3', index: 0 }, 'bank')!;
  const { tryVerdict: _drop, ...rest } = input;
  return tryVerdict === undefined ? rest : { ...rest, tryVerdict };
}

test('(a) coachLabel: worse, losing or no verdict keep "Why does my move fail?"; strong, close, also-good and unchecked ask neutrally', () => {
  assert.equal(EXPLAIN_FAIL_LABEL, 'Why does my move fail?');
  assert.equal(EXPLAIN_NEUTRAL_LABEL, 'Ask Claude about my move');
  assert.equal(coachLabel(coach, 'granted'), EXPLAIN_FAIL_LABEL, 'no verdict: version 6');
  assert.equal(coachLabel(coach, 'granted', undefined), EXPLAIN_FAIL_LABEL);
  for (const v of ['worse', 'losing'] as const) assert.equal(coachLabel(coach, 'granted', v), EXPLAIN_FAIL_LABEL, v);
  for (const v of ['strong', 'close', 'also-good', 'unchecked'] as const) assert.equal(coachLabel(coach, 'granted', v), EXPLAIN_NEUTRAL_LABEL, v);
  // A value outside the contract: the prompt reads it as `unchecked` (no failure claim), so the label does too.
  assert.equal(coachLabel(coach, 'granted', 'great' as CoachTryVerdict), EXPLAIN_NEUTRAL_LABEL);
  // The other states do not depend on the verdict.
  for (const v of [undefined, 'worse', 'also-good', 'unchecked'] as const) {
    assert.equal(coachLabel(coach, 'prompt', v), 'Ask Claude (asks permission once)', `prompt, ${v}`);
    for (const state of ['denied', 'unavailable', 'unknown'] as const) assert.equal(coachLabel(coach, state, v), null, `${state}, ${v}`);
    assert.equal(coachLabel(null, 'granted', v), null);
  }
});

test('(a) the panel shows the label for the input\'s verdict', () => {
  const html = (v?: CoachTryVerdict) => renderToStaticMarkup(<CoachPanel coach={coach} input={wrongInput(v)} initialAvailability="granted"/>);
  for (const v of [undefined, 'worse', 'losing'] as const) {
    assert.match(html(v), />Why does my move fail\?<\/button>/, String(v));
    assert.doesNotMatch(html(v), /Ask Claude about my move/, String(v));
  }
  for (const v of ['strong', 'close', 'also-good', 'unchecked'] as const) {
    assert.match(html(v), />Ask Claude about my move<\/button>/, v);
    assert.doesNotMatch(html(v), /Why does my move fail/, v);
  }
  // Mid-attempt the same label, beside the note that asking shows the answer.
  const mid = renderToStaticMarkup(<CoachPanel coach={coach} input={wrongInput('close')} initialAvailability="granted" revealsAnswer/>);
  assert.match(mid, />Ask Claude about my move<\/button>/);
  assert.match(mid, /This shows the answer for this position\./);
});

// ---------------------------------------------------------------- (j) nothing to show, nothing rendered

test('(j) the panel renders nothing when it has nothing to show: no empty .coach-explain block', () => {
  const ask = () => null;
  const input = wrongInput('worse');
  const empty: Array<[string, string]> = [
    ['denied coach after a clean solve, with the question box asked for', renderToStaticMarkup(<CoachPanel coach={coach} input={null} initialAvailability="denied" askInput={ask} askKey="00abc"/>)],
    ['unavailable coach after a clean solve', renderToStaticMarkup(<CoachPanel coach={coach} input={null} initialAvailability="unavailable" askInput={ask} askKey="00abc"/>)],
    ['permission not known yet (first render)', renderToStaticMarkup(<CoachPanel coach={coach} input={null} askInput={ask} askKey="00abc"/>)],
    ['no coach, no wrong move', renderToStaticMarkup(<CoachPanel coach={null} input={null}/>)],
    ['granted, but no wrong move and no question box', renderToStaticMarkup(<CoachPanel coach={coach} input={null} initialAvailability="granted"/>)],
    ['a wrong move mid-attempt with the coach denied (the stored lines wait for the end)', renderToStaticMarkup(<CoachPanel coach={coach} input={input} initialAvailability="denied" revealsAnswer/>)],
    ['a wrong move mid-attempt without a coach', renderToStaticMarkup(<CoachPanel coach={null} input={input} revealsAnswer/>)],
  ];
  for (const [why, html] of empty) assert.equal(html, '', why);
  // Something to show: the block is there.
  const shown: Array<[string, string]> = [
    ['the stored lines after the attempt, without a coach', renderToStaticMarkup(<CoachPanel coach={null} input={input}/>)],
    ['the question box', renderToStaticMarkup(<CoachPanel coach={coach} input={null} initialAvailability="granted" askInput={ask} askKey="00abc"/>)],
    ['the explain button mid-attempt', renderToStaticMarkup(<CoachPanel coach={coach} input={input} initialAvailability="prompt" revealsAnswer/>)],
  ];
  for (const [why, html] of shown) assert.match(html, /^<div class="coach-explain" aria-live="polite">/, why);
});

test('(j) panelHasContent: any one part is enough, including a message or an answer left after the controls hide', () => {
  const none: PanelParts = { staticShown: false, label: null, text: '', busy: false, message: '', questionLabel: null, askText: '', phase: null, askMessage: '' };
  assert.equal(panelHasContent(none), false);
  const one: Array<Partial<PanelParts>> = [
    { staticShown: true }, { label: 'Ask Claude about my move' }, { text: 'Partial answer.' }, { busy: true }, { message: 'Ask again in 5 s.' },
    { questionLabel: 'Ask Claude' }, { askText: 'Partial answer.' }, { phase: 'checking' }, { phase: 'asking' }, { askMessage: 'Write a question first.' },
  ];
  for (const part of one) assert.equal(panelHasContent({ ...none, ...part }), true, JSON.stringify(part));
});

// ---------------------------------------------------------------- (b) captions never name a move still ahead

const captionOf = (html: string) => /<p class="line-viewer-caption" aria-live="polite">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? null;
const summaryOf = (html: string) => /<p class="line-viewer-summary">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? null;
/** The caption's sentence: the bold move just played removed, tags stripped. */
const sentenceOf = (html: string) => (captionOf(html) ?? '').replace(/<strong>[\s\S]*?<\/strong>\s*/, '').replace(/<[^>]+>/g, '');
const viewer = (startFen: string, line: string[], step: number, extra: Partial<Parameters<typeof LineViewer>[0]> = {}) =>
  renderToStaticMarkup(<LineViewer title="t" startFen={startFen} line={line} orientation="w" initialStep={step} {...extra}/>);
/** SAN of each move of `line` from `fen`. */
const sansOf = (fen: string, line: string[]) => { const b = new Chess(fen); return line.map(u => b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); };
/** True when `text` holds `san` as a whole move token (check and mate signs kept). */
const namesSan = (text: string, san: string) => new RegExp(`(^|[^A-Za-z0-9])${san.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`).test(text);

test('(b) narrator option: nameMate false drops the mating move from both sentence forms; facts and the summary stay', () => {
  for (const [fen, line, k, named, unnamed] of [
    [START, SCHOLAR, 5, 'Nf6 forks the queen on h5 and the pawn on e4, but it allows mate in one: Qxf7#.', 'Nf6 forks the queen on h5 and the pawn on e4, but it allows mate in one.'],
    [BACK_RANK, ['d1d7', 'e8e1'], 0, 'Rd7 allows mate in one: Re1#.', 'Rd7 allows mate in one.'],
    ['8/6R1/8/8/8/8/7p/5k1K w - - 0 1', ['g7g1', 'h2g1q'], 0, 'Rg1+ gives check, but it allows mate in one: hxg1=Q#.', 'Rg1+ gives check, but it allows mate in one.'],
  ] as const) {
    const byDefault = narrateLine(fen, line), kept = narrateLine(fen, line, { nameMate: true }), dropped = narrateLine(fen, line, { nameMate: false });
    assert.equal(byDefault.plies[k].text, named, 'the default names the mate (lessons, hints, coach notes)');
    assert.equal(kept.plies[k].text, named);
    assert.equal(dropped.plies[k].text, unnamed);
    assert.deepEqual(dropped.plies.map(p => p.facts), byDefault.plies.map(p => p.facts), 'the facts keep the SAN');
    assert.equal(dropped.summary, byDefault.summary);
    // Only the mate clause differs.
    assert.deepEqual(dropped.plies.map((p, i) => i === k ? null : p.text), byDefault.plies.map((p, i) => i === k ? null : p.text));
  }
  // A line that stops before the mate: the summary names it either way (the line has ended).
  const cut = SCHOLAR.slice(0, 6);
  assert.equal(narrateLine(START, cut, { nameMate: false }).summary, 'So far in this line no material changes hands, but White can mate in one: Qxf7#.');
  assert.equal(narrateLine(START, cut, { nameMate: false }).summary, narrateLine(START, cut).summary);
});

test('(b) viewer captions: the step that allows mate says so without the move, with or without a narration passed in', () => {
  const byDefault = narrateLine(START, SCHOLAR);
  const counters = START.replace(/ 0 1$/, ' 4 9');
  /** The position before 3...Nf6 from `start` (its move counters give the label's number). */
  const beforeNf6 = (start: string) => { const b = new Chess(start); for (const u of SCHOLAR.slice(0, 5)) b.move({ from: u.slice(0, 2), to: u.slice(2, 4) }); return b.fen(); };
  for (const [why, start, html] of [
    ['no narration passed', START, viewer(START, SCHOLAR, 6)],
    ['the default narration passed (it names Qxf7#)', START, viewer(START, SCHOLAR, 6, { narrated: byDefault })],
    ['the default narration passed, other move counters', counters, viewer(counters, SCHOLAR, 6, { narrated: byDefault })],
  ] as const) {
    assert.equal(captionOf(html), `<strong>${esc(moveLabel(beforeNf6(start), 'Nf6'))}</strong> forks the queen on h5 and the pawn on e4, but it allows mate in one.`, why);
    assert.ok(!sentenceOf(html).includes('Qxf7'), why);
  }
  assert.equal(moveLabel(beforeNf6(START), 'Nf6'), '3... Nf6');
  assert.notEqual(lineNarration(START, SCHOLAR, byDefault), byDefault, 'a narration whose sentence names the mate is not used as given');
  // The short form, on the invented back rank, also with the default narration passed in.
  const back = ['d1d7', 'e8e1'], backDefault = narrateLine(BACK_RANK, back);
  for (const html of [viewer(BACK_RANK, back, 1), viewer(BACK_RANK, back, 1, { narrated: backDefault })]) {
    assert.equal(captionOf(html), '<strong>1. Rd7</strong> allows mate in one.');
  }
  // The mating move itself is still narrated when it is played, and the end of the line keeps its summary.
  assert.equal(captionOf(viewer(BACK_RANK, back, 2)), '<strong>1... Re1#</strong> is checkmate.');
  assert.equal(summaryOf(viewer(BACK_RANK, back, 2)), 'The line ends in checkmate by Black.');
});

test('(b) no caption of a stepped line names a later move; a line cut before the mate keeps the SAN in its summary only', () => {
  for (const [fen, line] of [[START, SCHOLAR], [BACK_RANK, ['d1d7', 'e8e1']], [START, SCHOLAR.slice(0, 6)]] as const) {
    const sans = sansOf(fen, [...line]);
    for (let k = 1; k <= line.length; k++) {
      const text = sentenceOf(viewer(fen, [...line], k));
      // A bare pawn push ("e5") reads like a square in a sentence ("the pawn on e5"), so only piece moves, captures,
      // checks and mates are looked for.
      for (const later of sans.slice(k).filter(s => /[KQRBNx+#=]/.test(s))) assert.ok(!namesSan(text, later), `step ${k} of ${sans.join(' ')}: "${text}" names ${later}`);
    }
  }
  // Scholar's line cut after 3...Nf6: the last caption warns without the move, the summary below it names it.
  const cut = SCHOLAR.slice(0, 6), end = viewer(START, cut, cut.length);
  assert.equal(sentenceOf(end), 'forks the queen on h5 and the pawn on e4, but it allows mate in one.');
  assert.equal(summaryOf(end), esc('So far in this line no material changes hands, but White can mate in one: Qxf7#.'));
});

test('(b) the other path: coach inputs keep the SAN in their notes', () => {
  // A drill from Claude (invented card): 3.Qh5 Nf6?? 4.Qxf7#, tried 3.Qf3 instead.
  const fen = play(['e4', 'e5', 'Bc4', 'Nc6']);
  const input = explainInput({ id: 'agent-test-1', fen, moves: ['d1h5', 'g8f6', 'h5f7'], themes: ['mateIn2'] }, { fen, uci: 'd1f3', index: 0 }, 'agent')!;
  assert.equal(input.bestLineNotes?.[1], 'Nf6 forks the queen on h5 and the pawn on e4, but it allows mate in one: Qxf7#.');
  assert.equal(input.lesson, 'The line ends in checkmate by White.');
});

// ---------------------------------------------------------------- (c) the rook v pawn drill's last sentence

test('(c) tech-rook-v-pawn-king-first: "Any rook move or slower king route only draws.", true for every move but Kc6', () => {
  const id = 'tech-rook-v-pawn-king-first';
  const drill = endgameDrills.find(d => d.id === id)!;
  const text = drill.explanation ?? '';
  assert.ok(text.endsWith(' Any rook move or slower king route only draws.'), text);
  assert.ok(!/first rank|together/.test(text), 'the old mechanism sentence is gone');
  // The tablebase results bundled with the drill (lib/endgameTeach): Kc6 wins; all 21 other moves, the 14 rook moves
  // and the 7 other king moves, draw. None loses, so "only draws" is exact.
  const step = drillTeach(id)!.steps.find(s => s.step === 0)!;
  const legal = new Chess(drill.fen).moves({ verbose: true });
  assert.equal(legal.length, 22);
  for (const m of legal) {
    const uci = `${m.from}${m.to}${m.promotion ?? ''}`;
    assert.equal(step.results[uci], uci === 'b7c6' ? 'win' : 'draw', `${m.san}`);
  }
  assert.equal(legal.filter(m => m.piece === 'r').length, 14);
  // The provenance pins the file's hash; the reviews copy (absent from a public copy) is byte-identical.
  const bytes = readFileSync(join(ARTIFACT_DIR, 'data/technical_endgames.json'));
  const provenance = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'data/technical_endgames.provenance.json'), 'utf8'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.source_sha256);
  const copy = join(ARTIFACT_DIR, '../reviews/claude/data/technical_endgames.json');
  if (existsSync(copy)) assert.ok(readFileSync(copy).equals(bytes), 'reviews/claude/data copy is identical');
});

// ---------------------------------------------------------------- (d) accept copy, superseded by brief 9.11.2 (p)

// FX4a (fix round 2): 9.11.2 (p) replaced 9.1's ACCEPT on pack, punish and agent cards with a soft retry, so the
// "Also good." copy of 9.9.2 (d) ("at least as highly" / "about as highly") is gone. The same pairs now pin the (p)
// copy: no numbers, never the answer, and no "Also good" anywhere.
test('(d) superseded by 9.11.2 (p): the pairs that were "Also good." accepts are soft retries with the (p) copy', () => {
  const check = (tryWin: number, bestWin: number): TryCheck => ({ tryUci: 'g1f3', trySan: 'Nf3', replyLine: ['d7d5'], tryWin, bestWin, verdict: 'losing', depth: 12, ms: 40 });
  const msg = (kind: EngineKind, t: number, b: number) => gradeTry({ kind, trySan: 'Nf3', answerSan: 'Bc4', solver: 'w', check: check(t, b) });
  const quick = 'The quick engine check likes Nf3 too, but the analysis that picked this card found one clearly better move. Try again.';
  const agent = 'The engine likes Nf3 too, but this card is after a different move. Try again.';
  for (const kind of ['pack', 'punish', 'agent'] as const) {
    for (const [t, b] of [
      [70, 70], [71, 70], [69, 70], // equal, one above, one below
      [50, 50], [51, 50], [49, 50], // the same under 65 (class close)
      [69.6, 70.4], [70.5, 70.4], [69.4, 70.4], // rounded first: 70/70, 71/70, 69/70
      [70, 75], [96.4, 99.6], // a gap of 5; 96 against 100 (tests/m3_trainer_c.test.tsx)
    ] as const) {
      const g = msg(kind, t, b);
      assert.deepEqual([g.action, g.tryVerdict, g.showNumbers, g.intro], ['soft', 'strong', false, undefined], `${kind} ${t}/${b}`);
      assert.equal(g.message, kind === 'agent' ? agent : quick, `${kind} ${t}/${b}`);
      assert.doesNotMatch(g.message, /Also good|as highly|Bc4|%/, `${kind} ${t}/${b}`);
    }
  }
  // Unchanged: bank counts the error with its own words; a strong try is a soft retry with numbers.
  assert.equal(msg('bank', 71, 70).message, 'The engine likes Nf3 too, but this puzzle is after a different idea.');
  assert.deepEqual([msg('pack', 70, 76).action, msg('pack', 70, 76).showNumbers], ['soft', true]);
});

// ---------------------------------------------------------------- (k) "instead of" is a move cue

test('(k) movesNamed: "instead of" names a move; "on e5" and the other square words still name a square', () => {
  const sans = (q: string) => movesNamed(FRENCH, q).map(m => m.san);
  assert.deepEqual(movesNamed(FRENCH, 'Why not Nc3 instead of e5?'), [{ uci: 'b1c3', san: 'Nc3' }, { uci: 'e4e5', san: 'e5' }]);
  assert.deepEqual(sans('Is the pawn on e5 strong?'), []);
  assert.deepEqual(sans('Instead of e5, why not Nc3?'), ['e5', 'Nc3'], 'at the start, any case');
  assert.deepEqual(sans('Why not e5 instead of Nc3?'), ['e5', 'Nc3']);
  assert.deepEqual(sans('Why not exd5 or e5?'), ['exd5', 'e5']);
  assert.deepEqual(sans('What about Nc3 instead of the pawn on e5?'), ['Nc3'], '"on e5" is still a square');
  assert.deepEqual(sans('Is it on e5, at e5, from e5 or of e5?'), [], 'on, at, from and of alone still read a square');
  // The existing cases (tests/m3_trainer_b.test.tsx), unchanged.
  assert.deepEqual(movesNamed(FRENCH, 'Why not exd5, or nc3? b1c3 again? What about Qh8, Kf7 and the pawn on h3?'), [{ uci: 'e4d5', san: 'exd5' }, { uci: 'b1c3', san: 'Nc3' }]);
  assert.deepEqual(sans('exd5? Nc3! Push h3. And Bb5+?'), ['exd5', 'Nc3', 'h3']);
  assert.deepEqual(movesNamed('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'Is 0-0 better than O-O-O?').map(m => m.san), ['O-O', 'O-O-O']);
  assert.deepEqual(movesNamed('8/4P3/8/8/8/8/k7/7K w - - 0 1', 'e8=Q, e8q or e7e8n?').map(m => m.san), ['e8=Q', 'e8=N']);
  assert.deepEqual(sans('What is the idea here? Why is the bishop on c1 bad?'), []);
  assert.deepEqual(movesNamed('not a fen', 'e4'), []);
});

// ---------------------------------------------------------------- (l) "mate in one" in a note grounds "mate in 1"

/** Bank card (invented input on the Scholar position): the try 3...Nf6, the engine's reply 4.Qxf7#; the answer 3...g6. */
const tryNotes = narrateLine(AFTER_QH5, ['g8f6', 'h5f7']).plies.map(p => p.text);
const mateExplain: CoachExplainInput = {
  kind: 'explain', itemId: 'bank-test-scholar', source: 'bank', fen: AFTER_QH5, side: 'b', playedUci: 'g8f6', playedSan: 'Nf6',
  bestUci: 'g7g6', bestSan: 'g6', bestLineSan: ['g6'], refutationSan: [], themes: ['defensiveMove'],
  tryLineSan: ['Nf6', 'Qxf7#'], tryLineNotes: tryNotes, trySource: 'engine', tryVerdict: 'losing',
};

test('(l) a digit "mate in 1" is grounded by a computed note that says "mate in one"; nothing else loosens', () => {
  assert.match(tryNotes[0], /allows mate in one: Qxf7#\.$/, 'fixture: the narrator says it in words');
  const built = buildExplainPrompt(mateExplain);
  assert.ok(built.prompt.includes(tryNotes[0]), 'the note is in the prompt');
  assert.ok(!built.numbers.includes(1) && !built.numbers.includes(2), 'fixture: 1 and 2 are not given numbers');
  const g = (text: string) => groundCheck(text, built, 'explain');
  assert.deepEqual(g('Nf6 allows mate in 1: Qxf7#.'), { grounded: true, misses: [] });
  assert.deepEqual(g('After Nf6 White has Mate in 1.'), { grounded: true, misses: [] });
  // Nothing else: another distance, the same digit as a figure, and bare squares and moves keep their rules.
  assert.deepEqual(g('Nf6 allows mate in 2.').misses, ['mate in 2']);
  assert.deepEqual(g('Nf6 allows mate in 10.').misses, ['mate in 10']);
  assert.deepEqual(g('After Nf6 you keep 1% to win.').misses, ['1%']);
  assert.deepEqual(g('Nf6 costs 1 pawn.').misses, ['1 pawn']);
  assert.deepEqual(g('Nf6 allows mate in 1, and then h4 wins.').misses, ['h4']);
  assert.deepEqual(g('Nf6 allows mate in 1 with Qxg7.').misses, ['Qxg7']);
  // Without the note the same answer is flagged, as before.
  const bare = buildExplainPrompt({ ...mateExplain, tryLineNotes: undefined });
  assert.deepEqual(groundCheck('Nf6 allows mate in 1: Qxf7#.', bare, 'explain').misses, ['mate in 1']);
  // Words two to ten, any case, in a computed text that states a fact (here the card's goal). FX4b (brief 9.11.3, R5-2)
  // changed this: it used the card title, but a title or framing now gives moves and squares only (a drill titled "mate
  // in three" is a mate in two at its second step, R5-1b), so the same words in a title ground nothing.
  const goal = buildExplainPrompt({ ...mateExplain, tryLineNotes: undefined, objective: 'find the Mate in Two' });
  assert.deepEqual(groundCheck('This is mate in 2.', goal, 'explain'), { grounded: true, misses: [] });
  assert.deepEqual(groundCheck('This is mate in 1.', goal, 'explain').misses, ['mate in 1']);
  const titled = buildExplainPrompt({ ...mateExplain, tryLineNotes: undefined, title: 'Mate in Two' });
  assert.deepEqual(groundCheck('This is mate in 2.', titled, 'explain').misses, ['mate in 2']);
});

test('(l) the reverse and the learner\'s own words: "mate in one" in an answer is never a figure; his question grounds nothing', () => {
  // The reverse: an answer in words passes with a note in words, a note in digits, or no note.
  const built = buildExplainPrompt(mateExplain);
  assert.equal(groundCheck('Nf6 allows mate in one: Qxf7#.', built, 'explain').grounded, true);
  const digits = buildExplainPrompt({ ...mateExplain, tryLineNotes: ['Nf6 allows mate in 1: Qxf7#.', 'Qxf7# takes the pawn on f7 with checkmate.'] });
  assert.equal(groundCheck('Nf6 allows mate in one: Qxf7#.', digits, 'explain').grounded, true);
  assert.equal(groundCheck('Nf6 allows mate in 1: Qxf7#.', digits, 'explain').grounded, true, 'a digit note grounds the digit, as before');
  assert.equal(groundCheck('Nf6 allows mate in one: Qxf7#.', buildExplainPrompt({ ...mateExplain, tryLineNotes: undefined }), 'explain').grounded, true);
  // Ask: "mate in one" in his question is not a given text; the same words in a checked line's note are.
  const ask: CoachAskInput = {
    kind: 'ask', itemId: 'bank-test-scholar', source: 'bank', fen: AFTER_QH5, side: 'b', question: 'Is it mate in one after Nf6?',
    answerLineSan: ['g6'], askedLines: [{ san: 'Nf6', lineSan: ['Nf6', 'Qxf7#'], notes: ['The knight moves to f6.', 'The queen takes the pawn on f7.'], source: 'engine' }],
  };
  assert.deepEqual(groundCheck('Yes: after Nf6 it is mate in 1 with Qxf7#.', buildAskPrompt(ask), 'ask').misses, ['mate in 1']);
  const noted: CoachAskInput = { ...ask, askedLines: [{ ...ask.askedLines[0], notes: tryNotes }] };
  assert.deepEqual(groundCheck('Yes: after Nf6 it is mate in 1 with Qxf7#.', buildAskPrompt(noted), 'ask'), { grounded: true, misses: [] });
});
