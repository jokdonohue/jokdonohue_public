# Next Move

A chess practice web app for adult improvers: tactical puzzles from the Lichess open database, technical-endgame drills, short teaching notes, import of completed games in PGN, and in-browser Stockfish analysis, scheduled by a simple spaced-repetition model.

## Two versions

- `artifact/` is the version in use: a port of the trainer to a single-page hosted artifact. It is a React page bundled with esbuild into one `index.html`, plus the Stockfish files. Training records live in the artifact's small document database rather than a server of its own. `artifact/src/contract/` defines the documents and their checks, and `artifact/src/coach/` holds the coaching layer.
  - Milestone 2 adds:
    - "Safe or not?" cards: positions from the user's own games where they judge whether a move is safe ("Safe", "It loses something", "Not sure"). Two scores are shown: safe moves trusted and unsafe moves caught.
    - A "Study these" list for cards that keep going wrong (wrong on 4 of the last 6 days they were tried), with "Put it back".
    - An "Opening accidents" readout and a transfer card that shows the user's own-game results over time.
    - Piece drag, and a dark theme that follows the system setting.
    - PGN paste or upload with in-page analysis (Stockfish in the browser), which makes new cards from that game (`artifact/src/analysis/`).
  - The database model and the contract for agents that write documents into it (plans, drills, notes) are in `artifact/scripts/ingest.md`. The backup runbook is `artifact/scripts/snapshot-db.md`.
  - `artifact/SOURCE.md` records which files were copied or adapted from `app/`, with their hashes.
- `app/` is the original build and remains the fallback: a Next.js-style app for a private hosted Site (Cloudflare Worker with a D1 database for signed-in training records). It also runs locally. `app/README.md` holds that build's own notes; a few of them point to project files that are not in this repository.

Each tree builds and tests on its own. Some files under `data/` and `tests/fixtures/` therefore appear in both.

## Running the tests

Node 22.13 or newer is required. The dependencies are pinned once, by `app/package-lock.json`.

```sh
cd projects/next-move/app
npm ci
npm test          # node --test over tests/*.test.*; this is what scripts/check.sh runs
npm run typecheck
```

`artifact/` has no package manifest of its own. It reuses the tools installed in `app/node_modules` (esbuild, tsx, TypeScript, React, chess.js, zod). Node resolves packages from a `node_modules` beside the code, so after the `npm ci` above, make the app's copy visible to the artifact with a local link. `artifact/.gitignore` keeps that link out of git.

```sh
cd projects/next-move/artifact
ln -s ../app/node_modules node_modules
node --import tsx --test tests/*.test.*
node scripts/build.mjs --strict      # writes dist/index.html; takes the engine files from ../app/public/engine
```

The repository check (`scripts/check.sh`, also run in CI) covers only the `app/` tests, because the artifact has no test entry of its own. Run the artifact's tests by hand as shown. Without the private seed and profile data, the tests that need them skip themselves. In this repository's copy that is 10 of 280, and the other 270 pass.

## Data deliberately not in this repository

Both versions can build personal training material from a player's own completed games: positions where they went wrong, a weakness profile, and special sets. The artifact version also loads that material as database seed documents. None of this, nor its sources, is on GitHub: no game archive, no weakness profile, no generated pack, and no `artifact/seed/` or `artifact/seed_m2/`. `artifact/.gitignore` lists those seed folders and the build output.

`app/public/personal-pack/pack.json` is the empty placeholder that the import script writes with `--clear`. With it, the app behaves as if no personal pack exists. Each tree's tests use a small synthetic fixture in `tests/fixtures/personal-pack/`, with invented positions, game links and statistics.

## Third-party components and data

- Stockfish 19.0.1 (lite, single-threaded WebAssembly build, from the npm package `stockfish@19.0.1`): GNU GPL version 3. The artifact build serves the same JavaScript, WebAssembly and licence files and links to the source below.
  - Unmodified files are in `app/public/engine/`, together with the full licence text (`COPYING-GPL-3.0.txt`), the exact corresponding source archive (`stockfish-source-19.0.1.tar.gz`), the NNUE network and build instructions (`README.txt`).
  - Upstream source: https://github.com/nmrugg/stockfish.js (tag v19.0.1) and https://github.com/official-stockfish/Stockfish.
  - Keep every file in that directory together.
- Puzzle data (`data/puzzles.json` and `data/puzzle-setup.json` in each tree): a 2,000-puzzle selection from the Lichess open puzzle database, https://database.lichess.org/#puzzles, released under CC0 1.0. Provenance is in the matching `*.provenance.json` files.
- Technical-endgame drills (`data/technical_endgames.json` in each tree): original project content. Standard textbook positions were re-set; no book text or diagrams were copied.
- chess.js 1.4.0: BSD-2-Clause.
- shadcn/ui styles (`app/vendor/shadcn-tailwind-4.13.0.css`): MIT; the licence is beside the file.
- Sites Vite plugin (`app/scripts/vite/sites-vite-plugin.ts`): MIT, © 2026 OpenAI; the licence is beside the file.
- Other npm dependencies are installed from `package-lock.json` under their own licences.

The project is independent of, and not affiliated with, Chess.com or Lichess.

## Licence

No licence has been chosen yet for this project's own code; the third-party licences above still apply to their components.
