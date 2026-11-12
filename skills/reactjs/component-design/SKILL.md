---
name: reactjs-component-design
description: Write small, composable React components with clean props and no needless state
globs: ["**/*.jsx", "**/*.tsx"]
---

# React component design

Keep components small and focused. A component that renders more than one screen
of JSX or juggles several unrelated concerns should be split.

## Rules

- Prefer function components and hooks. No class components in new code.
- Derive, don't duplicate: compute values from props/state during render instead
  of copying props into state. State that mirrors a prop is a bug waiting to
  desync.
- Lift state only as high as the nearest common ancestor that needs it. Pass data
  down via props; pass changes up via callbacks.
- Make props explicit and typed. Avoid a single `props` bag of unrelated flags;
  a component with many boolean props usually wants to be several components.
- Keep components pure: no side effects during render. Side effects belong in
  event handlers or `useEffect`.

## Anti-patterns

- Copying `props.value` into `useState(props.value)` and never syncing it.
- One giant component with deeply nested conditionals — extract the branches.
- Prop drilling through many layers — reach for composition (`children`) or
  context before threading a prop through five components.
