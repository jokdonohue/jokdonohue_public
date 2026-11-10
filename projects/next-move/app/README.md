# Next Move

A chess practice room for a club-level player. This is the canonical app checkout; the parent folder holds the brief, multi-agent coordination and independent reviews.

Status: working local build; private hosting prepared, not published.
Last touched: 2026-11-08.

## Run locally

Node 22.13 or newer is required. Dependencies are pinned by package-lock.json.

```sh
npm ci
npm run dev -- --port 5173
```

Open http://127.0.0.1:5173/. Another agent may already own that preview; reuse it instead of starting a second process. The portable Sites starter's sign-in is a local test fixture; it is not production authentication.

```sh
npm run typecheck
npm test
npm run build
```

Local D1 was initialized with `drizzle/0000_narrow_gorilla_man.sql`. Do not replay an applied migration. On a new checkout, build first and apply the SQL to local D1 using the command in the Sites starter documentation or `scripts/sites-env.mjs` / Wrangler with `--local --persist-to .wrangler/state`. Production publication applies the migration through Sites.

## Working features

- 2,000 source-checked Lichess CC0 puzzles, normalized so the learner moves first; full legal lines, forced replies, promotions, and alternative immediate mates.
- Mixed practice, theme filters, due reviews, drawing resources, and personal positions. Wrong moves, hints and reveals remain supported practice even if the line is subsequently completed.
- A disclosed adaptive heuristic prioritizes weak themes and review, while retaining new material and personal positions. Source metadata such as “short” and “crushing” is not treated as a chess skill.
- Eight short opening branches and 32 original, cited teaching principles. Legal alternatives in opening rehearsal are distinguished from chess mistakes.
- Completed-game PGN paste/file import and optional public Chess.com archive fetch. Standard chess only; invalid/incomplete games are rejected without partially saving an import.
- Stockfish 19 lite in a dedicated browser worker. Bounded analysis creates up to eight personal exercises per game; depth and partial coverage are visible. Analysis continues only while the browser is running.
- Browser backup plus user-scoped D1 storage for signed-in use. Optimistic revision checks merge attempt histories, preserve newer settings, and reject over-limit unions before overwriting a valid copy. Export/import supports manual recovery and browser changes.

## Evidence and limits

The app's Learn section contains source links and qualified teaching prose. `../outputs/codex/CHESS_EVIDENCE.md` records source coverage; independent reviews live in `../docs/` and `../reviews/claude/`.

The exact scheduling weights, intervals, mistake threshold and phase classifications are product heuristics. Practice accuracy is not a playing-rating estimate. Lichess puzzle difficulty does not map directly to Chess.com Elo. Opening branches are illustrative, not a full repertoire; endgame coverage includes principles and tactical positions, not a resisting technical-ending opponent. Short engine searches do not prove a unique best move. Imported-game practice prompts say when they are saved engine candidates.

No paid generative-AI API is configured. Correctness uses legal move validation, source puzzle lines and Stockfish. The app does not play an opponent or provide assistance during an active game.

## Data and licenses

- Puzzles: https://database.lichess.org/#puzzles, CC0 1.0. Provenance is in `data/puzzles.provenance.json` and `../outputs/codex/ENGINE_NOTES.md`.
- chess.js 1.4.0: BSD-2-Clause.
- Stockfish 19.0.1: GPL-3.0. Preserve **all** files under `public/engine/`, including license, exact source archive, NNUE network and build instructions. The in-app Engine license link exposes these to recipients.
- Teaching text is original; book exercises and annotations were not copied. The site is independent of and not affiliated with Chess.com or Lichess.

## Hosting and privacy

Private ChatGPT Sites is the prepared target: the Worker serves the app and D1 holds user-owned training profiles. The source manifest enables only DB; there is no external LLM API, R2 upload bucket or connector integration. Hosted authentication and access policy are supplied by Sites. Keep the Site owner-private.

After approved deployment the site remains available when the Mac is off. Chess analysis runs on the active phone/computer, not as an unattended background job. Saved game notation and training records sync to the private site's cloud database when the user imports/plays while signed in. Browser analysis does not send positions to an external chess-analysis or LLM API.

A GitHub repository can store source later, but static GitHub Pages alone does not supply this app's account storage. No GitHub push, Site registration, source upload, cloud database activation, or deployment has occurred. Follow the exact publication manifest in `../outputs/codex/` before external actions. Never upload `.wrangler/`, `.sites-runtime/`, local backups, test profiles or credentials.

## Verification

Main app tests cover every puzzle line, PGN edge cases, engine score orientation/mates/cancellation, scheduling, backup validation and conflict merges. Independent browser checks exercised desktop/mobile board play, real WASM analysis, personal exercises, underpromotion alternatives, corruption recovery, export and local signed-in D1 persistence. The production Worker API was separately checked for authentication, origin validation, account isolation and stale-write conflicts. A physical iPhone and hosted deployment remain separate checks.
