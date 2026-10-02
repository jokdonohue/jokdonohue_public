# AGENTS.md

Instructions for every coding agent in this repository: OpenAI Codex, Claude Code, GitHub Copilot and others. `CLAUDE.md` and `.github/copilot-instructions.md` are thin adapters that point here, so change rules in this file only.

## Repository

Public workspace for non-confidential projects. Everything committed here is world-readable, and history, forks and caches keep it after deletion.

## Data boundary

- Never put patient or clinical information in this repository, its issues or its pull requests. That includes de-identified excerpts and anything derived from real records.
- Never commit credentials, tokens, keys, private correspondence, personal identifiers or absolute paths from the owner's machine.
- Test data is synthetic: generated or written for the test.
- If a task seems to need any of the above, stop and ask the owner in your current channel, without repeating the sensitive details.

`scripts/guard.sh` is a heuristic tripwire for common leaks, not proof that content is safe, so your own review still matters. Don't bypass it with `--no-verify` or by loosening its rules. To commit a binary or data file on purpose, add its exact path to `.guard-allow` in the same change and say why; the owner's approval of that change covers it. Credential files are never allowed.

## Check

    scripts/check.sh

Run it before every commit and before reporting work as done; CI runs the same command on every pull request. It runs the guard, the guard's self-test, the instruction-adapter check, each project's tests, and shellcheck when installed. The pre-commit guard is clone-local: enable it with `git config core.hooksPath .githooks`. A fresh or cloud clone doesn't have it until that runs, so `scripts/check.sh` and CI are what count there.

## Layout

- `projects/<name>/`: one self-contained project per directory, with a README and a `package.json` test script that `scripts/check.sh` runs. A project in another language adds its test entry to `scripts/check.sh` when it lands.
- `scripts/`: repository tooling.
- `.github/`: CI, CodeQL, Dependabot, the agent-task issue form and the Copilot adapter.

## Conventions

- One topic per branch (`<type>/<topic>`, for example `fix/rolloff-bounds`) and per pull request into `main`. Don't push to `main` directly or rewrite its history.
- Keep existing behaviour unless the task says otherwise, and add a test with every behaviour change.
- New dependencies, workflow changes, repository settings, and edits to this file, its adapters, `scripts/guard.sh` or `.github/` happen only when the owner asks for them; a task that requests the change is that request. Instruction files steer every agent, so treat edits to them as security-relevant.
- Pin GitHub Actions to a full commit SHA with a version comment; the repository rejects tag references.
- If `.github/github-app.yml` exists, leave it alone; it holds the owner's GitHub Copilot app settings.

## Reviews

For substantial changes, a review by a different agent than the author helps when one is available. Don't start `@codex review`, Copilot review or any other paid review unless the owner asked for it. A review is a quality signal, not authorization: merging, publishing and settings stay with the owner.

## Code Review Rules

- P0: patient or clinical data, a credential or a personal identifier exposed by the change.
- P0: disabling or bypassing the guard, CI or Action pinning without the owner's request.
- P1: an absolute local path, or a behaviour change without a test.
