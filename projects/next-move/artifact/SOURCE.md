# Next Move artifact: sources copied from `app/`

Port plan: `reviews/claude/artifact_port_plan_2026-11-10.md`, sections 1 and 9 (risk 6).
Re-check before each publish: `diff -rq ../app/lib lib` and the hashes below.

## Engine (copied by `scripts/build.mjs` into `dist/` at each build)
Source: `../app/public/engine/` (read-only), or `vendor/engine/` if that folder is ever created here.
Recorded 2026-11-10 (SHA-256):

| File | SHA-256 |
|---|---|
| stockfish-19-lite-single.js | ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a |
| stockfish-19-lite-single.wasm | ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de |
| COPYING-GPL-3.0.txt | 0b383d5a63da644f628d99c33976ea6487ed89aaa59f0b3257992deac1171e6b |

Not shipped: the `.nnue` (not a served type; the lite build does not need it) and the source
`.tar.gz` (archives are refused as supporting files). The corresponding source is linked upstream:
- npm package stockfish 19.0.1: https://registry.npmjs.org/stockfish/-/stockfish-19.0.1.tgz
- repository: https://github.com/nmrugg/stockfish.js (commit 0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6)
The page must show a licence link to `COPYING-GPL-3.0.txt` and one of these source links;
`build.mjs` warns when it finds neither.

## lib/, data/, components/, app tests (copied by B2)
Source hashes from `reviews/claude/logs/b2_source_hashes.txt`, paths relative to `app/`.
Checked by B1 on 2026-11-10 at the integration build:
- all 39 still match `app/` (`cd app && shasum -a 256 -c ../reviews/claude/logs/b2_source_hashes.txt`);
- the 22 files copied unchanged (lib/*, data/*, components/Chessboard.tsx) match their copies in `artifact/`.
- `diff -rq app/lib artifact/lib` lists only the excluded `connector-*` files, `connectors.ts` and `.claude`.

Adapted from the source rather than copied unchanged:
- `components/PersonalPackSummary.tsx`;
- `styles/app.css` (from `app/app/globals.css`);
- the app tests, renamed `tests/b2_app_*`.

```
bfe4c16bb455051484a99ae3afeadcde236b22e6932058a38061d7ffe9f69a03  lib/scheduler.js
d76f0aade94323dc166cdd58a67bf4a4dae4c81a00377e1c4f45f76f7bd378b9  lib/scheduler.d.ts
4f078067e1995f638975e4020b3e09de5fdad51e58ca496e048106b9becabcf7  lib/curriculum.ts
f0858b1b9466cc2ff8f2748b9737520d48cec7bf86183315a686c706ec6055c5  lib/endgames.ts
f54c1cdd7e8c5a3e1259cd5a41ac1d600c073f8605da903eec3f65dc09a273e2  lib/puzzles.ts
c4de8a85acf8e11d62c1ea71955a38966920b1a59ac5b0d0a255b48503cdca3a  lib/puzzle-setup.ts
ff926a16441b63e8e157b43dcce5db9cc94e6b9aa635d495986e3de917c94d04  lib/personal-pack.ts
13a4858f83607bf8bce334084aa6fb58eb6bfc349cfe41678c79be19b4d5d7af  lib/practice.ts
ad4bb58ce34f67303f01c0b85b866179bb50742f8575a820fa18a500f6fb903e  lib/session.ts
2b2a4cff9708f2fdf196b304790e8c87adddfb2f0b286b69ff88672a04d6ef5f  lib/training-state.ts
762f21052aa0d3c5a82471e37ac3c6485bd5d998ce2b450eda347f894bb55ef5  lib/pgn.ts
63003239e6fb9f4b21ccb4e37dc69f4b9bd07980428f93a1bfe580f9540f6ad5  lib/player.ts
a73bb95503497c58c5d038e705ade9581f8275095244616dc5a42a8353e42d32  lib/game-phase.ts
8a77706003001bf29d3bbee9ace733f5a89cb50582ac8c4f9324e76d969059cb  lib/chess-engine.ts
53f3d3d070f0a9082934da25b875f9499855c2b0693868dd28be8c23d8730f68  lib/utils.ts
45a61efcdd8155475131bf15c6f2f2ebcfb38c44fcf6184f264d17a9bda45c2c  data/puzzle-setup.json
8c7f0f2453ca10c8e8cf6a2153416eeedf4168d39b055ab7bf5a3b4aeac98de1  data/puzzle-setup.provenance.json
1d52eb05a1e8113d8f74d7819ccc939e43fc457db96ee8ef3543f8946b971843  data/puzzles.json
315dcbfc8b8a21fdac72442b361591132edb29532094a8eeb2789b92016506b2  data/puzzles.provenance.json
95c8bb706b045d7c8da35d2eded89de2a9cd2dc2c9b384b83d651bc4b96a56e7  data/technical_endgames.json
7e41bfc0b057ba312e7770b5d9c15a642b8acc19393cab10a81905f9921ced23  data/technical_endgames.provenance.json
3a42da43101f89f4f711f7daf094d15534907104e854b582e1e2f74356177ca8  components/Chessboard.tsx
bb3b497ed26377085cb07f776b2e69e686a773753661ead6778c27ba89dcb8c1  components/PersonalPackSummary.tsx
d711d273faa5ad4ed39ae47130d39fc21e4747425762532a0ec6c446c50262d8  app/globals.css
ded996cff7bf26e5edb7ccf121aa55df59959e78ddceb1d1ce014688f39e1901  tests/backup.test.ts
73fed75b9d9775feca901c65d7f3166c5d4e35ac609cf96ba9951b345adea8d3  tests/endgames.test.ts
47110b58f73f0b4ba600e3aaa88e650207952c348a971d756c09decfd464cd75  tests/engine.test.ts
231fb8ee41945d5d8379d7d2bc49418fff445e01aaf86f06e9ae25cb82752d45  tests/game-phase.test.ts
176e3cdceb77dcec9a2418e4f379415aaf3cb4ddea36692ed6c0744a48e69234  tests/personal-pack-summary.test.tsx
acc0b8723cd149ceb85af157174f43760e7530feb9e5a81921c4a22398cbaa76  tests/personal-pack.test.ts
3b701d68e355476dc89156dc04682aed290da381dfb56aa1608bafd97f5347d5  tests/pgn.test.ts
da09791b11977d66f8de5efb4eb4b64a7ede1c11516f8a8356385bbcc2c42c13  tests/player.test.ts
92d29146c4baa43449a11d96b1eaa6962086ef24eca29431652a308cc673df5b  tests/practice-flow.test.ts
eea4418a667564cab3b4b62b9c6403ecba11161adde0b1d3c6125a761ae2f02f  tests/scheduler.test.js
0db19c2fe21c498698b5c8a6114db6cb6945bc6bbb85a8e68b86a262bd78d515  tests/state.test.ts
0f23d41b53328832ef20236016c3a2eadcba01ee305bf52c3f9aba18a90737a2  tests/fixtures/personal-pack/weakness_profile.json
bff7a2791f90f967385a54990679f70573e57ecbce94066ffe640bc7e3d42473  tests/fixtures/personal-pack/mistake_positions.jsonl
de795d2e0e577d54c66a9c9f9f7b2869bca0f78e64617116b1e9e54383a6d2bc  tests/fixtures/personal-pack/README.md
2c37268851d7f0bf40a0a6c06c709bbe9a21b16da101985a60e3045b9f83e326  tests/fixtures/personal-pack/special_sets.jsonl
```

## Tooling
`node_modules` is a symlink to `../app/node_modules` (esbuild 0.28.0, tsx, typescript, React 19.2.6,
chess.js, zod). Nothing is installed here.

## M2 changes to copied files (chess-m2-ui, 2026-11-10)
Checked with `cmp` against `../app/` after the M2 UI work: every copied file under `lib/` and `data/`, `components/PersonalPackSummary.tsx` and the `tests/b2_app_*` copies still match their `app/` source byte for byte. One copied file now differs on purpose:
- `components/Chessboard.tsx`: M2 adds an `arrow` prop (an SVG arrow over the board, for "Safe or not?" and "Study these"), the exported `squareCentre` helper, and drag to move with pointer events (D11; rules in the new `components/dragMove.ts`). Tap-tap, the promotion dialog and the markup of the 64 squares are unchanged. M2 SHA-256: `6efcbafc43c2dd4338bc7ceb1d1339f948eb33eec114c2773b504e15cb49b66a` (the `app/` hash above, `3a42d…`, is the version-4 source).
- `styles/app.css` (already adapted) now has every page colour as a token and a system dark theme (Part 4).
