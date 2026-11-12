---
name: angular-rxjs
description: Use RxJS in Angular without leaks or nested subscriptions
globs: ["**/*.ts"]
---

# Angular RxJS

RxJS is powerful and easy to misuse. The two recurring failures are leaked
subscriptions and manually nesting subscribes.

## Rules

- Prefer the `async` pipe in templates — it subscribes and unsubscribes for you.
  When you must subscribe in the class, tear down with `takeUntilDestroyed()` or
  a `Subject` completed in `ngOnDestroy`.
- Never nest `subscribe` inside `subscribe`. Compose with flattening operators:
  `switchMap` (cancel the previous — search/typeahead), `concatMap` (queue in
  order), `mergeMap` (parallel), `exhaustMap` (ignore while busy — submit
  buttons).
- Keep side effects in `tap`, transformations in `map`. A `subscribe` callback
  should be the end of the line, not where logic lives.
- Handle errors inside the stream with `catchError` and return a safe fallback so
  one failure doesn't kill the observable.
- Share expensive/multicast sources with `shareReplay({ bufferSize: 1,
  refCount: true })` instead of subscribing multiple times.

## Anti-patterns

- `this.a$.subscribe(a => this.b$.subscribe(...))` — use `switchMap`.
- Subscribing in a component and never unsubscribing.
- Doing HTTP in a `map` (it must be an inner observable via `switchMap`, not a
  synchronous transform).
