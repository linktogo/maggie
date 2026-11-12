---
name: vuejs-composition-api
description: Write Vue 3 components with the Composition API, script setup, and composables
globs: ["**/*.vue", "**/*.ts"]
---

# Vue Composition API

Use `<script setup>` with the Composition API for new components. It gives better
type inference and makes logic reuse explicit.

## Rules

- Reach for `ref` for primitives and `reactive` for objects; be consistent within
  a component. Remember `ref` values need `.value` in script (but not in the
  template).
- Derive from state with `computed`, not by writing back into another ref inside
  a watcher. Computeds are cached and declarative.
- Use `watch`/`watchEffect` for side effects (fetching on an id change, syncing to
  storage) — not to compute values that `computed` should own.
- Extract reusable stateful logic into composables named `useX` that return refs
  and functions. They compose other composables and hold no template.
- Define props and emits with `defineProps`/`defineEmits` (typed). Treat props as
  read-only — emit an event to request a change rather than mutating a prop.

## Anti-patterns

- Mutating a prop directly.
- A `watch` that sets a ref which another `watch` reacts to — collapse it into a
  `computed`.
- Destructuring a `reactive` object, which loses reactivity — use `toRefs` if you
  must destructure.
