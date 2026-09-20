# maggie documentation

Reference documentation for every feature. The [root README](../README.md) is
the overview and quickstart; these pages are the detail.

## Features

| Page | What it covers |
|---|---|
| [Configuration](configuration.md) | The `repos.json` schema, and the two ways both CLIs resolve it |
| [Skills library](skills-library.md) | Authoring skills, how they map to each target platform |
| [`maggie` CLI](sync-cli.md) | Rendering skills into repos and pushing them |
| [`maggie-workspace` CLI](workspace-cli.md) | Bootstrapping a workspace, worktrees, status tracking |
| [Board dashboard](board-dashboard.md) | The kanban dashboard, its server and endpoints |
| [CI status](ci-status.md) | Per-contributor CI badges on the board, and how to enable them |
| [Retro-documentation](retro-doc.md) | Folding a repository's specs and plans into one document an agent can read |

## Working on maggie

| Page | What it covers |
|---|---|
| [Architecture](architecture.md) | Nx layout, module boundaries, testing and coverage gates |
| [Feature proposals](proposals/README.md) | Candidate work, with the gap in today's code each one closes |

## Design history

`superpowers/specs/` and `superpowers/plans/` hold the design record: one spec
per feature capturing the decisions and their rationale, and the implementation
plan that followed. They are written as of a point in time and are **not**
maintained as the feature evolves — read them for *why* a thing is the way it
is, and these pages for *what it does today*.

[`proposals/`](proposals/README.md) is the other end of the same pipeline:
candidate work that has not been decided on. A proposal that gets picked up
becomes a spec and a plan, and stops being governed by that page.
