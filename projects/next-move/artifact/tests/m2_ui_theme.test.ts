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
  const allowed = /^(\.turn-dot\.[wb]|\.chessboard|\.square[\w.:-]*|\.dark \.rank,\.dark \.file|\.light \.rank,\.light \.file|\.piece[\w. -]*|\.move-target|\.capture-target|\.promotion-dialog|\.drag-ghost|\.board-arrow[\w ]*|\.trend-point)$/;
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
  // Board: the same in both themes. Pieces carry a contrasting outline, so each piece is checked by its better edge.
  const squares = ['#e4edf2', '#6087a6', '#c2d9ad', '#8bb1a1', '#d7bb55'];
  for (const sq of squares) {
    assert.ok(Math.max(ratio('#fffefa', sq), ratio('#24374e', sq)) >= 3, `white piece on ${sq}`);
    assert.ok(Math.max(ratio('#20334c', sq), ratio('#f4f8ff', sq)) >= 3, `black piece on ${sq}`);
  }
  for (const sq of ['#e4edf2', '#6087a6']) assert.ok(ratio(bare.get('--arrow')!, sq) >= 3, `arrow on ${sq}`);
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
