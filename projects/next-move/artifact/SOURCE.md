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

The build of a given tree is reproducible, but its exact bytes depend on one file outside this folder: a `package.json` with `"type": "module"` in the folder above. The working copy these versions were built in has one. Where the folder above has a `package.json` without that field, as `projects/next-move/` has in the public repository, esbuild writes its module-interop calls slightly differently and `dist/index.html` comes out 62 bytes shorter; the page behaves the same. The hashes quoted in this file are of builds made in the first layout (review of 7.3, D-5 and D-6).

## M2 changes to copied files (chess-m2-ui, 2026-11-10)
Checked with `cmp` against `../app/` after the M2 UI work: every copied file under `lib/` and `data/`, `components/PersonalPackSummary.tsx` and the `tests/b2_app_*` copies still match their `app/` source byte for byte. One copied file now differs on purpose:
- `components/Chessboard.tsx`: M2 adds an `arrow` prop (an SVG arrow over the board, for "Safe or not?" and "Study these"), the exported `squareCentre` helper, and drag to move with pointer events (D11; rules in the new `components/dragMove.ts`). Tap-tap, the promotion dialog and the markup of the 64 squares are unchanged. M2 SHA-256: `6efcbafc43c2dd4338bc7ceb1d1339f948eb33eec114c2773b504e15cb49b66a` (the `app/` hash above, `3a42d…`, is the version-4 source).
- `styles/app.css` (already adapted) now has every page colour as a token and a system dark theme (Part 4).

## M3 changes to copied files (2026-11-12/13)
Checked with `cmp` against `../app/` on 2026-11-13 after the M3 fix pass: every other copied file under `lib/` and `data/`, `components/PersonalPackSummary.tsx` and the `tests/b2_app_*` copies still match their `app/` source byte for byte. The hash list above stays the B2 copy record (the `app/` sources); the hashes below are the artifact's copies now. Five copied files differ on purpose:
- `components/Chessboard.tsx` (M3 F3, brief 9.4): the arrowhead marker id comes from `useId` (new export `arrowHeadId`), so each board on a page has its own marker. SHA-256 `1f591e6c600003540f465eaa17d2509ae2783aafea971e9b448c625015d371ab`.
- `data/technical_endgames.json`: three explanation sentences corrected, each checked against the cached Lichess tablebase. Ids, positions, lines, ratings, themes and titles are unchanged.
  - `tech-krk-mate-in-two-king-step` (F3): a rook move first misses the mate in two; on g7 the rook stalemates Black, on h7 Black's king can take it, and anywhere else the mate takes longer.
  - `tech-rook-v-pawn-king-first` (F3): "Your rook on h1 already guards e1, where the pawn would promote." The old sentence said the rook stood behind the pawn.
  - `tech-rook-v-pawn-king-first` (fix pass, brief 9.9.2 c): the last sentence is now "Any rook move or slower king route only draws." The tablebase gives a draw for all 21 moves other than Kc6. The old sentence said Black's king and pawn reach the first rank together, which not every drawing line shows (in the stored Kb6 line the rook takes the pawn on e2).
  - SHA-256 `3153e3a4f02d0e016c2794c40059d1a849b971ec8df16966aa1d49a138bc9830`. The `reviews/claude/data` copy is identical.
- `data/technical_endgames.provenance.json`: `source_sha256` refreshed after each change (now the hash above), and `revised` added by F3 (it records F3's two sentences; the third is recorded here). SHA-256 `a091c8930f3dfd6f3af69c7c35cb8b82dfab9aafe70bd200b425d3ee0b2fd66c`.
- `lib/scheduler.js` and `lib/scheduler.d.ts` (M3 bank level, brief 8.18 and 9.5): `selectPuzzle(..., { targetOf })` measures each puzzle against `targetOf(p)` when it gives a finite number, otherwise against `settings.rating`. Without the option the pick is unchanged. The `.d.ts` makes `SelectOptions<P>` generic with `targetOf?`. SHA-256 `c8c703a7c20e941ea75f583e80b84b326d953c1926a88f91692894452c78a34e` (`.js`) and `1f2cd77641319a0ea8c8f5bfd2b3cf7e90957962e4915eb8c11c1c31eb9b0a91` (`.d.ts`).

`diff -rq ../app/lib lib` now also lists `lib/endgameTeach.ts` (new in M3, not a copy) and the two scheduler files. `styles/app.css` (adapted, so no `app/` hash applies) gains the M3 rules, appended.

## Version 7.2 changes (2026-11-24): board looks and drawn pieces
Checked on 2026-11-24 by hash list (`reviews/claude/logs/pre72_tree.sha256`, the version 7.1 tree, against `logs/m72_s1.sha256`): no file under `lib/` or `data/` changed, nor `components/PersonalPackSummary.tsx` or any `tests/b2_app_*` copy, so those copies stand as the M3 section above left them. `src/contract/docs.ts`, `store.ts` and `coach.ts` are unchanged (still the version 6 contract; `tests/m31_frozen.test.ts`). Changed in all: 11 files, and 4 new ones (`components/boardTheme.ts`, `components/pieceSet.ts`, `src/store/boardCache.ts`, `tests/m72_board.test.tsx`).

New, not copies:
- `components/pieceSet.ts` (GENERATED; do not edit by hand): the twelve pieces as drawn shapes. Source: the Wikimedia Commons files `Chess_{k,q,r,b,n,p}{l,d}t45.svg`, author Cburnett (Colin M.L. Burnett), 2006. Each file's page carries `{{self|GFDL|migration=relicense|BSD|GPL}}` (read on 2026-11-24): the author's own work, offered under GFDL (and so CC BY-SA 3.0), BSD or GPL, at the user's choice. Next Move takes them under the BSD option; the notice is `PIECE_ART_LICENCE` in that file and is shown on the page's Sources panel (binary-form clause). The files as downloaded, their SHA-1 (equal to the Commons API's), the saved licence pages and the converter are in `reviews/claude/tools/pieces/` (`build_piece_set.py`; `--check` compares the generated file with the one on disk). The converter copies path data, circles and transforms and writes each shape's inherited style out as plain attributes; a render of each converted piece equals a render of its source file pixel for pixel (360 px, 12 of 12). SHA-256 `e8fe6ef085600eaa5c9d106d98626d1ba344bb02ad15801b0af4346050b4036f`.
  - This matters for the public repository's licence decision: the piece data carries the BSD notice above, whatever licence the repository takes.
  - Nothing of Chess.com's piece artwork is used. The Green board's two square colours (`#eeeed2`, `#769656`) were read from the palette of its green board image on 2026-11-24 (the image and a record are in `reviews/claude/tools/pieces/evidence_2026-11-24c/`); a pair of colours is not artwork. Brown's light square (`#f0d9b5`) is the colour of the Lichess brown board (its board stylesheet, saved in the same folder); the dark brown (`#b58863`) is not in that file, so the page credits Lichess for the light square only.
- `components/boardTheme.ts`, `src/store/boardCache.ts`: the board look (Green, the default; Blue, the board of versions 4 to 7.1; Brown) and where the choice is kept (`prefs/ui`, a collection of its own that no earlier page reads, plus this browser's storage for the first paint).

Copied or frozen files that differ on purpose:
- `components/Chessboard.tsx`: every piece is drawn from `pieceSet.ts` (the five font characters and the single pawn path are gone); `pieceArt` and `PIECE_VIEWBOX` are exported for the logo. Squares, drag, tap-tap, the promotion dialog and the arrow are unchanged. SHA-256 `bb0ca9fd0c65fcc90300d6342d3dae4070759b57eb85ca4d51ccd89bf6941270`.
- `components/Learn.tsx` (was "ported unchanged"): the Sources panel gains the piece credit and the licence notice. SHA-256 `b9822f572ba9fb33ee594e627753946e4bbc99a4e0c278341556df9a9dcc1202`.
- `styles/app.css`: the board's colours are tokens (part 4b, one block per board look); part 14 holds the switch's layout rules; the four rules that painted font pieces are gone.

## Version 7.3 changes (2026-11-24): the answer panel of "Safe or not?", endgame key squares, review fixes
Checked on 2026-11-24 by hash list (`reviews/claude/logs/m72_s1.sha256`, the version 7.2 tree, against `logs/m73_s2j.sha256`): no file under `lib/` changed, nor `components/PersonalPackSummary.tsx` or any `tests/b2_app_*` copy. `src/contract/docs.ts`, `store.ts` and `coach.ts`, `components/LineViewer.tsx`, `components/CoachPanel.tsx` and `src/teach/narrate.ts` are unchanged (`tests/m31_frozen.test.ts`). Changed in all: 28 files (this one among them), and 4 new ones (`components/safeReveal.ts`, `tests/m73_board.test.tsx`, `tests/m73_endgame.test.tsx`, `tests/m73_safe_reveal.test.ts`).

New, not a copy:
- `components/safeReveal.ts`: what the answer panel of a "Safe or not?" card says, as pure functions over the card's stored facts. The lead sentence is the line narrator's own closing sentence for his move and the stored reply (`lineNarration`, unchanged), so the panel and the viewer under it cannot disagree. Where that sentence would contradict "This move lost something." the panel uses its own: no piece or pawn lost, even trades, or he is ahead in the count and the sentence names him as the winner with nothing against it. A sentence that carries its own "but" (the engine's figure, or what is still hanging) stays as the narrator wrote it, and so does a line that ends in mate (review of 7.3, P2-11). The viewer's title says "allowed" only under the gate `gameMoveViewer` already uses (his opponent at 65% or more and he is not ahead in material). The figures shown are the stored pair, never a live one. On a sound-move card the lead speaks of the change, not of the level ("gave nothing away"), and only when the stored pair bears it out (a fall of less than two points, the producer's rule): the producer takes sound moves from positions anywhere between 30% and 70% to win.

Copied or frozen files that differ on purpose:
- `components/Chessboard.tsx`: one more prop, `hintSquares`, so a hint that names several squares rings every one of them. Nothing else changed. SHA-256 `cb6e5f72d630256e51d4387afd1ea9500b41978a2ae91adbb5a41b5e793a4892` (was `bb0ca9fd…` in 7.2).
- `components/Learn.tsx`: the licence notice is one line per paragraph, and the credit names Lichess for the brown board's light square only (the saved evidence supports no more: review of 7.3, P2-9). SHA-256 `10dd34ae4e0290a4fa27c7c879e77410b314d6af5518e082e541cac4832809ac` (was `b9822f57…` in 7.2).
- `components/pieceSet.ts` (GENERATED): the drawings are byte for byte those of 7.2; the credit and the copyright line changed. Evidence gathered on 2026-11-24 and kept in `reviews/claude/tools/pieces/evidence_2026-11-24b/`: the wikitext of all twelve Commons file pages (each `{{self|GFDL|migration=relicense|BSD|GPL}}`, author Cburnett), every file's upload history (first upload 28 Dec 2006 by Cburnett; the current revisions carry small later adjustments by other Commons contributors, and their SHA-1 values equal the files used), and the author's user pages (the name Colin M.L. Burnett is on the English Wikipedia user page his Commons page points to). The credit therefore reads "with later adjustments by Commons contributors" and the copyright line ends "and contributors". SHA-256 `5e59e83ef8751e07dfb8e204474392168ac93499d3f5c1df4bb8c7df60da9da8`.
- `data/technical_endgames.json` (and the byte-identical `reviews/claude/data/technical_endgames.json`): the explanation of one drill, `tech-kpkp-give-up-pawn-keep-opposition`, rewritten to name the key squares and the step the old text skipped; no position, move or other drill changed. SHA-256 `bd36825eae3f39287a211b34fb1946e09d5841cee76bc0bb168a005ad96cac91`; `source_sha256` and `revised` updated in the provenance file.
- `data/technical_endgames_teach.json`: regenerated by `reviews/claude/tools/m3/endgame_teach/assemble.mjs` from the authored files, with the tablebase cache only (`TB_READONLY=1`, no network). Only the same drill changed: its idea, `keySquares` (b6, c6, d6) and the notes on eight losing king moves. Every result in the file is still the cached tablebase result. The four notes at his second move name neither c7 nor b7, the squares of the moves still to find there, so the page does not withhold them. Five notes in three other drills (`tech-kpkp-triangulation` Kb5; `tech-reti-double-threat` c7, twice; `tech-kpkp-go-around` Kc6, twice) lost their timing words: each is on a wrong move that is the right move at a later step, and said it "comes too early" or "one move too soon"; each now says only what the move allows (review of 7.3, P1-1; `tests/m73_endgame.test.tsx` holds every such note to that). SHA-256 `92eb910589bd8eeefec2f98280ba8712adad73e988b61dd508f40e259e47dff8`.

Behaviour that differs from 7.2 on purpose:
- The board choice (`components/model.ts`): one write at a time, the newest choice last; the three fields are merged into `prefs/ui` (`update`) unless the document is known to be absent, so a field another version keeps there survives, also for a change made before the first delivery; no clock is compared. A merge refused because the document is missing (deleted while the page was open; `invalid_argument` in the store contract) is followed by a write that creates it again; no other refusal is turned into a whole-document write. After its own write is acknowledged the page reads the document once and follows a later write by another device; a read that still returns the document as last delivered before the write went out is ignored (`prefsStamp`; review of 7.3, D-4). A refused choice stays on show and is flagged in the view (`boardUnsaved`, with `boardSaving` while a write is out), so both switches say so and the line survives a change of tab; it ends when a retry saves it or when the database shows a later write. This browser remembers a board only once the database has taken it. The line says only what the page keeps, sits on a row of its own, and carries a retry; when a retry saves, focus returns to the switch unless he has moved to another control meanwhile. Not done: the line is a `role="status"` paragraph that is inserted with its text and holds the retry button, so a screen reader may not announce it (review of 7.3, P2-5; the 7.2 switch and the Chess.com name form are built the same way, and one change for all three belongs in a later version). Also left for a later version (review of 7.3, D-1 to D-3 and A5b; each needs a refused write or two quick choices and a particular order of events, and none writes a board he did not choose or loses a field): after a refused write the page makes no read, so a write by another device that landed during it, or this page's own write whose acknowledgement was lost, goes unnoticed until a retry or a later change; a delivery counts as "written since" when its text differs from the one before, which would also be true of the same document with its fields in another order, and of the page's own first write when that was made before the first delivery; after a refusal a different choice keeps the line up while it is being written; and between two quick choices a read that lags by exactly one write can bring the first of them back on this page until the next delivery or load.
- The hint ring has a dark edge on Green and Brown (`--board-hint-edge`), 3.5 to 1 or better against every square state; on Blue the edge equals the ring, so Blue is drawn as before.
- Kept on purpose: on Green a selected square has the same tint as the last-move squares; the selected piece is also marked by its move dots.
- Endgame hints (`src/teach/hints.ts`): a hint may carry several squares (`squares`). A list of key squares stays whole when the moving piece stands on one of them; a single such square is still left out, as before.
- A drill's own note on a wrong move stands above that try's line, in plain sight (`TrySlot`, tablebase tries only). Until 7.3 it was the viewer's caption one step back from where the viewer opens. Tries the engine grades are shown as before. Of the 177 authored notes, 142 are shown while he is solving; 35 are withheld because they name a move, or the square of a move, that was still to find when the try was made (`drillTryText`, unchanged); 16 of those are the whole of one drill, `tech-rule-of-the-square`.
- A finished endgame drill rings its key squares on the board (`drillKeySquares`).
- `styles/app.css`: part 14 gains layout rules only; the three unused `--arrow` definitions are gone.
- `scripts/ingest.md` and `scripts/snapshot-db.md` name the `prefs` collection: page-owned (an agent never writes it), and included in every database snapshot.

Not built in 7.3, by decision: new opposition drills and a live "try your own reply" check on the answer panel (it needs its own review, and whether the page should play an opponent's moves at all is still an open product question).
