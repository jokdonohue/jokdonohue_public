# Snapshot of the Next Move database (backup runbook, plan section 10 item i)

Run after every refresh and after each coaching session. Deleting the artifact erases its database (plan risk 8); until the M3 git snapshot exists, this folder is the only copy.

Target: `<project root>/private_snapshots/<YYYY-MM-DD>/` (add `-2`, `-3` for a second run the same day). It lives outside every repository; before the first run confirm each repo ignores it (`git -C <repo> check-ignore -v private_snapshots` prints a rule, or the folder is not under the repo at all). Snapshots hold the owner's positions, game links and history: never commit, upload or publish them.

Steps (reads only):
1. Load the tool: ToolSearch `select:ArtifactData`.
2. For each collection in this order: `meta`, `settings`, `plan`, `notes`, `drills`, `feedback`, `ingest`, `transfer`, `openings`, `derived`, `summaries`, `sessions`, `games`, `personal`, `explanations`, `safe`, `pack`:
   `ArtifactData` `action:"list"`, `url:<ARTIFACT_URL>`, `collection:<name>`, `query:{limit:1000}`, `out_dir:"<project root>/private_snapshots/<YYYY-MM-DD>"`.
   Each document lands at `<out_dir>/<collection>/<doc_id>.json`. The files are the bare document bodies, pretty-printed (observed at the first seed, 2026-11-10), so a snapshot works as `--prev` and as restore input. Large collections come back in pages (about 18 pack chunks per page even with limit 1000): always follow `next_cursor`. If the result carries `next_cursor`, repeat with `query:{limit:1000, cursor:<next_cursor>}` until it does not.
3. Write `<out_dir>/MANIFEST.txt`: date, artifact URL, `pack/meta.packVersion`, and per collection the number of files. Compare the `pack` count with `pack/meta.chunks` (+1 for `meta`), and, once M2 data is seeded, the `safe` count with `safe/meta.chunks` (+1).
4. Report the counts to the owner in one line.

Restore (only on the owner's explicit request): for each document file, `ArtifactData` `batch` entries `{op:"set", collection, doc_id, file_path}` (at most 50 writes and 1 MiB per batch), `pack/meta` and `safe/meta` last; documents that still exist need their current `version` as `if_version`.

The `pack/*.json` files of a snapshot are also the `--prev` input of `scripts/pack-to-docs.mjs` (see `ingest.md` step B4), so a refresh keeps every card id the live pack has issued.
