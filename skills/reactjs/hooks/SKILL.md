---
name: reactjs-hooks
description: Use React hooks correctly — dependencies, effects, and custom hooks
globs: ["**/*.jsx", "**/*.tsx"]
---

# React hooks

Hooks have rules the compiler can't fully enforce. Follow them or you get stale
closures and infinite loops.

## Rules

- Call hooks only at the top level of a component or another hook — never inside
  conditionals, loops, or callbacks.
- `useEffect` is for synchronizing with something outside React (subscriptions,
  the DOM, network). It is not a place to transform data for rendering — do that
  during render.
- List every reactive value an effect reads in its dependency array. Do not
  silence the lint rule; if the array is "too big", the effect is doing too much
  or a value should be memoized/moved.
- Always clean up: return a teardown from effects that subscribe, open timers, or
  add listeners.
- Reach for `useMemo`/`useCallback` to fix a measured problem (referential
  stability for a dependency, an expensive computation) — not by default.

## Custom hooks

- Extract shared stateful logic into a `useX` hook. It composes other hooks and
  returns values/handlers; it does not render.
- Name it `use…` so the rules-of-hooks lint applies.

## Anti-patterns

- Fetching in `useEffect` and setting state, then re-fetching because the
  dependency array includes an object recreated every render.
- An effect with an empty `[]` that reads props/state — a classic stale closure.
