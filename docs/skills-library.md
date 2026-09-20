# Skills library

A skill is written once and translated into each target platform's format. The
source of truth is `skills/<techno>/<name>/SKILL.md`; everything under a repo's
`.claude/`, `.github/`, `.cursor/` or `.windsurf/` is generated output.

## What ships today

| Technology | Skills |
|---|---|
| `nestjs` | module structure, dependency injection |
| `postgres` | safe migrations, query performance |
| `nextjs` | App Router server/client boundaries |
| `reactjs` | component design, hooks |
| `angular` | component architecture, RxJS |
| `vuejs` | Composition API, state management |
| `nx` | monorepo structure, task running (affected + caching) |
| `firebase` | Firestore data modeling, Security Rules |
| `cloudflare` | Worker deployment (Wrangler, environments, secrets) |

## Authoring a skill

Create `skills/<techno>/<name>/SKILL.md` with YAML frontmatter followed by the
guidance body:

```markdown
---
name: nestjs-module-structure
description: Organize NestJS code into cohesive feature modules with clear public surfaces
globs: ["**/*.module.ts", "**/*.service.ts", "**/*.controller.ts"]
---

Keep one module per bounded context…
```

| Frontmatter | Required | Meaning |
|---|---|---|
| `name` | yes | Skill identifier; becomes the generated file name. Must be unique across the whole library, not just within a technology — by convention `<techno>-<directory>`, since it becomes the output path in every renderer. |
| `description` | yes | One line describing when the skill applies. |
| `globs` | no | File patterns the skill is scoped to. Rendered differently per target — see below. |

Any repo whose `technologies` include `<techno>` picks the skill up on the next
sync. No registration step.

## How each target renders it

| Target | Output path | Frontmatter handling |
|---|---|---|
| `claude` | `.claude/skills/<name>/SKILL.md` | Keeps `name` and `description`; drops `globs`. |
| `copilot` | `.github/instructions/<name>.instructions.md` | Collapses `globs` into a single `applyTo` string, substituting `**` when absent. |
| `cursor` | `.cursor/rules/<name>.mdc` | Synthesises `alwaysApply` from whether globs exist; writes `globs: ''` for the empty case. |
| `windsurf` | `.windsurf/rules/<name>.md` | Plain markdown. |

The body survives verbatim across every target; frontmatter does not. That
asymmetry is why the canonical `SKILL.md` is the only file worth hand-editing —
a change made in a rendered file is lost on the next sync, and cannot be
reliably read back.

## Technologies with no skills

A repo listing a technology with no `skills/<techno>/` directory — or that
otherwise resolves to zero skills — logs a warning and is left untouched.

Pass `--strict` to turn that into a hard error with a non-zero exit and the repo
recorded as `error`. Use it in CI to catch a typo'd technology or a skill folder
that was never created. See the [`maggie` CLI](sync-cli.md).
