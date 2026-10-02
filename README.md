# jokdonohue_public

Public workspace for non-confidential projects, built with AI coding agents (Claude Code, OpenAI Codex, GitHub Copilot) that share one set of instructions.

## What goes where

| Tier | Where | What belongs |
|---|---|---|
| Public | this repository | Non-confidential code and documentation that can be world-readable permanently. |
| Private | the owner's private repository | Unpublished or work-in-progress material. Access-controlled, but never patient data, credentials or personal identifiers. |
| Local only | never on GitHub | Anything clinical or patient-related (de-identified included), private correspondence, credentials, agent memory. |

## Layout

    projects/   one self-contained project per directory
    scripts/    check.sh (the one check command) and guard.sh (content guard)
    .githooks/  pre-commit guard, opt-in per clone
    .github/    CI, CodeQL, Dependabot, issue form, Copilot instructions

## Check

    scripts/check.sh                        # what CI runs
    git config core.hooksPath .githooks     # once per clone: guard each commit

## Agents

`AGENTS.md` holds the instructions for every agent. Codex reads it directly; `CLAUDE.md` (Claude Code) and `.github/copilot-instructions.md` (GitHub Copilot) are short adapters that point to it. To hand work to an agent, open an issue with the **Agent task** form: objective, scope and acceptance check.
