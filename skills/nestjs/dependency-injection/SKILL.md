---
name: nestjs-dependency-injection
description: Use NestJS providers and injection tokens for testable, decoupled services
globs: ["**/*.service.ts", "**/*.module.ts"]
---

# NestJS dependency injection

Let Nest wire dependencies. Never `new` a service that has its own
dependencies — inject it so it can be swapped in tests.

## Rules

- Constructor injection with `private readonly`:
  ```ts
  constructor(private readonly users: UsersService) {}
  ```
- Depend on an interface via an injection token when you need multiple
  implementations or want to fake I/O in tests:
  ```ts
  export const MAILER = Symbol('MAILER');
  // provider: { provide: MAILER, useClass: SmtpMailer }
  constructor(@Inject(MAILER) private readonly mailer: Mailer) {}
  ```
- Default to the singleton scope. Reach for `Scope.REQUEST` only when a provider
  genuinely needs per-request state — it is slower and taints everything that
  injects it.
- Configuration comes from `ConfigService`, not `process.env` read inline.

## Testing

- In unit tests, build a module with `Test.createTestingModule` and override
  providers (`.overrideProvider(MAILER).useValue(fakeMailer)`).
- If a class is hard to test because of its dependencies, that is a design
  signal — inject a narrower abstraction rather than mocking the world.
