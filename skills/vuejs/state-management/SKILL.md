---
name: vuejs-state-management
description: Manage Vue application state with Pinia and the right state locality
globs: ["**/*.vue", "**/*.ts", "**/stores/**/*.ts"]
---

# Vue state management

Keep state as local as possible. Reach for a global store only when state is
genuinely shared across unrelated parts of the app.

## Rules

- Local UI state lives in the component (`ref`/`reactive`). Do not push
  everything into a global store.
- For shared/global state use Pinia (the current standard) — not Vuex, not a
  hand-rolled reactive singleton. Define stores with `defineStore` and the setup
  syntax so they read like composables.
- A store owns `state`, `getters` (derived, cached), and `actions` (the only
  place that mutates state, including async work). Components read state and call
  actions; they don't mutate store state directly from outside.
- Keep server cache separate from client state. Data fetched from an API is best
  handled by a query layer (e.g. TanStack Query) or a dedicated store action with
  loading/error flags — don't scatter `fetch` calls across components.
- Pass props / provide-inject for parent-to-child sharing before promoting state
  to a global store.

## Anti-patterns

- One giant store holding unrelated slices of the whole app.
- Mutating `store.someValue` from a component instead of calling an action.
- Duplicating server data into a store and letting it drift from the source.
