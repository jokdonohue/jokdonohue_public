import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import PersonalPackSummary, { wilson, MIN_OPENING_GAMES } from '../components/PersonalPackSummary';
import { buildPack } from '../lib/personal-pack';

const dir = path.join(process.cwd(), 'tests/fixtures/personal-pack');
const fixture = (name: string) => readFileSync(path.join(dir, name), 'utf8');
const build = (profile = JSON.parse(fixture('weakness_profile.json'))) => buildPack({ profile, positions: fixture('mistake_positions.jsonl'), special: fixture('special_sets.jsonl') }).pack;
const render = (pack: ReturnType<typeof build>) => renderToStaticMarkup(<PersonalPackSummary pack={pack} onPractise={() => {}}/>);

test('the summary shows sample sizes and intervals from the profile, and offers practice', () => {
  const html = render(build());
  assert.match(html, /An engine pass over 40 of your rapid and blitz games, 2026-09-01 to 2026-11-08\. synthetic test fixture, not an engine run, depth 14, practice moves rechecked at depth 18\./);
  assert.match(html, /<td>Middlegame<\/td><td>700<\/td><td>3\.0<\/td><td>2\.0 to 4\.5<\/td>/);
  assert.match(html, /<td>Hanging piece<\/td><td>12<\/td><td>0\.9<\/td><td>0\.5 to 1\.6<\/td>/);
  assert.doesNotMatch(html, /<td>Unknown<\/td>/, 'the unmatched bucket is not a motif');
  assert.match(html, /Practise 4 positions/);
  assert.match(html, /engine had you at \+3 or better \(300 centipawns, or a forced mate\)/);
  assert.match(html, /Not won: 3; ended on time 2, checkmated 1, other 0\./);
});

test('openings: a score interval on every row, a stated minimum of games, and the early-blunder share with its interval (review R6)', () => {
  const html = render(build());
  const [low, high] = wilson(0.333, 24);
  assert.match(html, new RegExp(`<td>Queen&#x27;s Pawn Game \\(D00\\)</td><td>Black</td><td>24</td><td>33% \\(${Math.round(low * 100)} to ${Math.round(high * 100)}%\\)</td><td>42% \\(25 to 61%\\)</td>`));
  assert.match(html, /<td>Center Game \(C20\)<\/td><td>White<\/td><td>16<\/td><td>42% \(\d+ to \d+%\)<\/td><td>33%<\/td>/);
  assert.ok(html.indexOf('Queen&#x27;s Pawn Game') < html.indexOf('Center Game (C20)'), 'lowest score first');
  assert.doesNotMatch(html, /Scotch Game/, `openings with fewer than ${MIN_OPENING_GAMES} games are left out, even with the lowest score`);
  assert.match(html, new RegExp(`fewer than ${MIN_OPENING_GAMES} games are left out`));
  assert.match(html, /Games with a blunder by move 10/);
});

test('wilson interval: contains the share, stays within 0 to 1, and narrows with more games', () => {
  for (const [p, n] of [[0, 5], [1, 5], [0.3, 15], [0.5, 100]] as const) {
    const [lo, hi] = wilson(p, n);
    assert.ok(lo >= 0 && hi <= 1 && lo <= p && p <= hi, `${p} over ${n}`);
  }
  const [a, b] = wilson(0.4, 15), [c, d] = wilson(0.4, 150);
  assert.ok(d - c < b - a);
  assert.deepEqual(wilson(0.5, 0), [0, 1]);
});

test('without optional sections, or with a check at the bulk depth, the summary says only what the data supports (code review P2-2)', () => {
  const profile = JSON.parse(fixture('weakness_profile.json'));
  delete profile.clock; delete profile.openings; delete profile.conversion; delete profile.firstBlunderMove;
  profile.sample.confirmDepth = 14;
  const html = render(build(profile));
  assert.match(html, /depth 14\.<\/p>/);
  assert.doesNotMatch(html, /rechecked/);
  assert.doesNotMatch(html, /Blunders by clock|lowest scores|\+3 or better|Median move number/);
});

test('stalemates appear as unscored study positions, with the move played and the engine move', () => {
  const html = render(build());
  assert.match(html, /Stalemates in won positions: 1 to study/);
  assert.match(html, /not scored/);
  assert.match(html, /Show your move/);
  assert.match(html, /Show the engine&#x27;s move/);
});
