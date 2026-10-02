# Copilot instructions

Follow `AGENTS.md` at the repository root; it is the canonical instruction file for every agent here. The essentials, repeated for Copilot surfaces that don't read it:

- Never add patient or clinical information, credentials, personal identifiers or absolute local paths, whether in code, fixtures, issues or pull requests.
- Run `scripts/check.sh` before proposing changes; CI runs the same command.
- Keep changes small, tested and within the task's scope. Dependencies, workflows, repository settings and instruction files change only when the owner asks.
