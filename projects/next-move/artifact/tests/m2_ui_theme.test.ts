import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_DIR } from './b3_paths';

// D12: system dark mode through tokens (artifact theming contract).
const raw = readFileSync(join(ARTIFACT_DIR, 'styles/app.css'), 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
const tokensIn = (body: string) => new Map([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)].map(m => [m[1], m[2].trim()]));

function blocks() {
  const bare = new Map<string, string>();
  for (const m of css.matchAll(/(?:^|\})\s*:root\s*\{([^{}]*)\}/g)) for (const [k, v] of tokensIn(m[1])) if (!bare.has(k)) bare.set(k, v);
  const media = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^{}]*)\}\s*\}/.exec(css);
  const attr = /:root\[data-theme="dark"\]\s*\{([^{}]*)\}/.exec(css);
  return { bare, media: media?.[1] ?? null, attr: attr?.[1] ?? null };
}

test('D12: every token used is defined on bare :root; both dark blocks redefine the same values with color-scheme dark', () => {
  const { bare, media, attr } = blocks();
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]));
  for (const t of used) assert.ok(bare.has(t), `${t} has no light value on bare :root`);
  assert.ok(media && attr, 'both dark blocks exist');
  assert.match(media!, /color-scheme:\s*dark/);
  assert.match(attr!, /color-scheme:\s*dark/);
  assert.deepEqual(tokensIn(media!), tokensIn(attr!), 'the toggle and the system setting give the same dark values');
  for (const t of tokensIn(media!).keys()) assert.ok(bare.has(t), `${t} is only defined in a dark block`);
  assert.doesNotMatch(css, /:root,:root:not\(\[data-theme="light"\]\),:root\[data-theme="dark"\]\{color-scheme:light/, 'the M1 light pin is gone');
  assert.match(css, /body\{background:var\(--paper\);color:var\(--ink\)\}/);
});

test('D12: no literal colour outside the board and pieces, which keep one look in both themes', () => {
  // Version 7.2: a board look is a block of board tokens on the app wrapper (`.app-shell[data-board="..."]`); the default
  // board's tokens are on bare :root. A board keeps one look on the light and the dark page.
  const allowed = /^(\.turn-dot\.[wb]|\.chessboard|\.square[\w.:-]*|\.dark \.rank,\.dark \.file|\.light \.rank,\.light \.file|\.piece[\w. -]*|\.move-target|\.capture-target|\.promotion-dialog|\.drag-ghost|\.board-arrow[\w ]*|\.trend-point|\.app-shell\[data-board="[a-z]+"\])$/;
  const offenders: string[] = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const s = sel.trim();
    if (s.startsWith(':root') || s.startsWith('@')) continue;
    for (const d of body.split(';')) {
      if (/white-space/.test(d)) continue;
      if (/#[0-9a-fA-F]{3,8}\b|\bwhite\b|\bblack\b|rgba?\(/.test(d) && !/shadow|filter/.test(d.split(':')[0]) && !allowed.test(s)) offenders.push(`${s} { ${d.trim()} }`);
    }
  }
  assert.deepEqual(offenders, []);
});

/**
 * Version 7.2: the board tokens of every board look. Green is the default and lives on bare :root; each other look is
 * a block on the app wrapper that must redefine every board token (so no value of the default shows through).
 */
function boardTokens(): Map<string, Map<string, string>> {
  const { bare } = blocks();
  const green = new Map([...bare].filter(([k]) => k.startsWith('--board-')));
  const out = new Map<string, Map<string, string>>([['green', green]]);
  for (const m of css.matchAll(/\.app-shell\[data-board="([a-z]+)"\]\s*\{([^{}]*)\}/g)) {
    const t = tokensIn(m[2]);
    assert.deepEqual([...t.keys()].sort(), [...green.keys()].sort(), `${m[1]} redefines every board token and no other token`);
    // 7.3 (review of 7.2, P2-9 d): and it holds nothing but tokens, so a board block cannot restyle anything by itself.
    for (const d of m[2].split(';').map(x => x.trim()).filter(Boolean)) assert.match(d, /^--board-[a-z-]+:/, `${m[1]} holds a declaration that is not a board token: ${d}`);
    out.set(m[1], t);
  }
  return out;
}

// WCAG relative luminance contrast.
function lum(hex: string) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h.slice(0, 6);
  const ch = (i: number) => { const x = parseInt(full.slice(i, i + 2), 16) / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('D12: text pairs reach 4.5:1 in both themes; the save dot and board marks reach 3:1', () => {
  const { bare, media } = blocks();
  const dark = tokensIn(media!);
  const v = (theme: Map<string, string>, t: string) => theme.get(t) ?? bare.get(t)!;
  const text: Array<[string, string]> = [['--ink', '--paper'], ['--ink', '--surface'], ['--muted', '--surface'], ['--muted', '--paper'], ['--ink-small', '--surface'], ['--ink-nav', '--paper'],
    ['--blue', '--surface'], ['--blue', '--paper'], ['--on-accent', '--accent-fill'], ['--ok-fg', '--ok-bg'], ['--err-fg', '--err-bg'], ['--hint-fg', '--hint-bg'], ['--warn-fg', '--warn-bg'], ['--chip-fg', '--chip-bg']];
  for (const theme of [bare, dark]) {
    for (const [f, b] of text) assert.ok(ratio(v(theme, f), v(theme, b)) >= 4.5, `${f} on ${b}: ${ratio(v(theme, f), v(theme, b)).toFixed(2)}`);
    assert.ok(ratio(v(theme, '--teal'), v(theme, '--paper')) >= 3, 'save indicator dot');
  }
  // Board (version 7.2): one look per board on the light and the dark page. Every piece is drawn in black and white:
  // a white piece is white inside a black outline and a black piece is black all through, so the black of the drawing
  // must reach 3:1 on every square colour, the last-move and selected tints included. (7.3, review P2-9 d: a separate
  // "white piece" line took the better of white and black, which no colour can fail; it is gone.) The arrow and the
  // coordinates are checked on the squares they sit on, and since 7.3 the hint ring's edge on every square state.
  const boards = boardTokens();
  assert.deepEqual([...boards.keys()].sort(), ['blue', 'brown', 'green']);
  for (const [name, t] of boards) {
    const v = (k: string) => { const x = t.get(k); assert.ok(x && /^#[0-9a-f]{6}$/.test(x), `${name} ${k}: ${x}`); return x!; };
    const squares = ['--board-light', '--board-dark', '--board-last-light', '--board-last-dark', '--board-selected-light', '--board-selected-dark'].map(v);
    for (const sq of squares) {
      assert.ok(ratio('#000000', sq) >= 3, `${name}: the black of the pieces on ${sq}: ${ratio('#000000', sq).toFixed(2)}`);
      // Blue is the board of versions 4 to 7.1 value for value, so its ring keeps the old single colour.
      if (name !== 'blue') assert.ok(ratio(v('--board-hint-edge'), sq) >= 3, `${name}: hint ring edge on ${sq}: ${ratio(v('--board-hint-edge'), sq).toFixed(2)}`);
    }
    for (const sq of [v('--board-light'), v('--board-dark')]) assert.ok(ratio(v('--board-arrow'), sq) >= 3, `${name}: arrow on ${sq}: ${ratio(v('--board-arrow'), sq).toFixed(2)}`);
    assert.ok(ratio(v('--board-coord-on-light'), v('--board-light')) >= 3, `${name}: coordinates on light squares`);
    assert.ok(ratio(v('--board-coord-on-dark'), v('--board-dark')) >= 3, `${name}: coordinates on dark squares`);
    assert.notEqual(v('--board-light'), v('--board-dark'));
    assert.notEqual(v('--board-last-light'), v('--board-light'), `${name}: the last move shows on a light square`);
    assert.notEqual(v('--board-last-dark'), v('--board-dark'), `${name}: the last move shows on a dark square`);
  }
});

test('D12: every rule with on-accent text sits on an accent fill that reaches 4.5:1 in both themes (and its hover)', () => {
  const { bare, media } = blocks();
  const dark = tokensIn(media!);
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*color:var\(--on-accent\)[^{}]*)\}/g)];
  assert.ok(rules.length >= 3);
  for (const [, sel, body] of rules) {
    const fill = /background:var\((--[a-z0-9-]+)\)/.exec(body)?.[1];
    assert.ok(fill, `${sel.trim()} sets its own fill`);
    for (const theme of [bare, dark]) assert.ok(ratio(theme.get('--on-accent') ?? bare.get('--on-accent')!, theme.get(fill!) ?? bare.get(fill!)!) >= 4.5, `${sel.trim()} on ${fill}`);
  }
  for (const theme of [bare, dark]) assert.ok(ratio('#ffffff', theme.get('--accent-strong') ?? bare.get('--accent-strong')!) >= 4.5, 'primary hover');
});
