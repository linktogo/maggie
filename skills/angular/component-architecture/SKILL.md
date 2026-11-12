---
name: angular-component-architecture
description: Structure Angular apps with standalone components, smart/dumb split, and OnPush
globs: ["**/*.component.ts", "**/*.module.ts"]
---

# Angular component architecture

Favor standalone components and a clear container/presentational split. Keep
templates declarative and logic in the class.

## Rules

- Use standalone components (`standalone: true`) and import what each component
  needs directly. Reserve NgModules for legacy or genuinely shared bundles.
- Separate concerns: container ("smart") components fetch data and hold state;
  presentational ("dumb") components take `@Input()`s and emit `@Output()`s and
  own no service dependencies.
- Set `changeDetection: ChangeDetectionStrategy.OnPush` on presentational
  components and pass immutable inputs so Angular can skip unchanged subtrees.
- Keep templates thin: no heavy expressions or method calls in the template that
  run every change-detection cycle — precompute in the class or use a pipe.
- Unsubscribe from observables (`takeUntilDestroyed`, the `async` pipe, or a
  teardown) to avoid leaks. Prefer the `async` pipe over manual subscribe.

## Anti-patterns

- Business logic in the template or in constructors (use `ngOnInit`/effects).
- A presentational component injecting `HttpClient` — that couples it to data.
- Calling a function in an interpolation (`{{ compute() }}`) under default change
  detection — it runs constantly.
