---
name: nx-task-running
description: Run Nx tasks efficiently with affected, caching, and target dependencies
globs: ["nx.json", "project.json", "**/project.json", ".github/workflows/*.yml"]
---

# Nx task running

Nx caches task outputs and understands the project graph. Lean on that instead of
rebuilding and retesting everything.

## Rules

- In CI and locally, prefer `nx affected -t lint test build` over
  `nx run-many -t …` so only projects touched by the change (and their
  dependents) run. `run-many` is for when you deliberately want the whole
  workspace.
- Declare task ordering with `dependsOn` (e.g. `test` and `build` depend on
  `^build`) so Nx builds upstream libraries before consumers — don't sequence
  targets by hand.
- Let caching work: mark cacheable targets in `targetDefaults` and make targets
  deterministic (same inputs → same outputs). Configure `inputs`/`namedInputs`
  so unrelated file changes don't bust the cache.
- Never write to files outside a target's declared `outputs`; undeclared outputs
  aren't restored from cache and cause "works once, breaks on cache hit" bugs.
- Use `nx graph` to inspect dependencies before moving code between projects.

## CI

- Fetch full git history (or the base ref) so `nx affected` can compute the diff
  against the base branch; a shallow clone breaks affected detection.
- Consider Nx remote caching / distributed execution to share cache across CI
  runs and machines.

## Anti-patterns

- `nx run-many -t test` on every push when `nx affected` would run a fraction.
- A target that reads config from outside its `inputs`, so the cache returns
  stale results after that config changes.
