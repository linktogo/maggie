# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

`maggie` is an open-source toolkit for synchronizing AI agent skills, practices, and workflows across the repositories of an organization. Skills are authored once under `skills/<techno>/<name>/SKILL.md` and rendered into each target platform's format (Claude Code, GitHub Copilot, Cursor, Windsurf).

Contributor-facing conventions — dev setup, the 100% coverage gate, commit format, and how to add a skill — live in [CONTRIBUTING.md](CONTRIBUTING.md). Keep it in sync when workflows change.

## Superpowers Plugin

This project has the [Superpowers](https://github.com/obra/superpowers) plugin installed locally in `.claude/skills/`. These skills are available via the `Skill` tool:

| Skill | When to use |
|---|---|
| `brainstorming` | Before any implementation — refines requirements with the user |
| `writing-plans` | After brainstorming — creates a structured implementation plan |
| `executing-plans` | Runs the plan with review checkpoints |
| `test-driven-development` | Red/green/refactor TDD cycle |
| `systematic-debugging` | Four-phase root cause investigation before any fix |
| `subagent-driven-development` | Delegates engineering tasks to subagents with code review |
| `requesting-code-review` / `receiving-code-review` | Code review workflow |
| `verification-before-completion` | Verifies work before marking done |
| `finishing-a-development-branch` | Branch cleanup and PR preparation |
| `dispatching-parallel-agents` | Parallelizes independent tasks |
| `using-git-worktrees` | Isolates work across branches |
| `writing-skills` | Authors new Superpowers skills |
