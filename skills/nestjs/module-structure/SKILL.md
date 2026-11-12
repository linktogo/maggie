---
name: nestjs-module-structure
description: Organize NestJS code into cohesive feature modules with clear public surfaces
globs: ["**/*.module.ts", "**/*.service.ts", "**/*.controller.ts"]
---

# NestJS module structure

Group code by feature, not by technical layer. Each feature owns its module,
controllers, services, and DTOs under a single directory (`src/<feature>/`).

## Rules

- One `@Module()` per feature. Register its controllers and providers there and
  export only what other modules legitimately consume.
- Keep controllers thin: validate input (DTO + `ValidationPipe`), delegate to a
  service, shape the response. No business logic in controllers.
- Put reusable, cross-cutting providers (config, logging, database) in a
  `SharedModule` marked `@Global()` only when truly global; otherwise import
  explicitly.
- Depend on abstractions across module boundaries. Export a service (or an
  interface token), never a repository, so callers can't reach into internals.
- Avoid circular imports. If two modules need each other, extract the shared
  contract into a third module or use `forwardRef()` as a last resort.

## Anti-patterns

- A single "core" module that re-exports everything — it defeats encapsulation.
- Business logic in `main.ts` or in a controller.
- Importing a provider directly from another module's file instead of through
  that module's exports.
