---
name: nx-monorepo-structure
description: Organize an Nx workspace with clear project boundaries, tags, and libraries
globs: ["nx.json", "project.json", "**/project.json", "tsconfig.base.json"]
---

# Nx monorepo structure

Split code into many small, focused libraries under `libs/` with thin
applications under `apps/` that mostly wire libraries together. An app should
contain almost no logic of its own.

## Rules

- Every project (app or lib) owns a `project.json` declaring its targets. Keep
  targets consistent across projects so `nx run-many` works uniformly.
- Give each project `tags` (e.g. `scope:*`, `type:lib|app|util`) and enforce
  dependencies with the `@nx/enforce-module-boundaries` ESLint rule. Apps may
  depend on libs; libs must not depend on apps; cross-scope imports go through a
  declared boundary.
- Import across projects only via the TypeScript path aliases in
  `tsconfig.base.json` (`@org/feature`), never with deep relative paths into
  another project's `src`.
- Each library exposes a single public surface through its `index.ts` barrel.
  Anything not exported there is private to the library.
- Prefer many small libraries (feature / ui / data-access / util) over a few
  large ones — it sharpens boundaries and shrinks the affected graph.

## Anti-patterns

- Business logic living in an app instead of a library.
- A `util`/`shared` library that everything depends on and that depends on
  everything back — it becomes a cycle magnet.
- Reaching into `../../other-lib/src/internal` instead of importing the alias.
