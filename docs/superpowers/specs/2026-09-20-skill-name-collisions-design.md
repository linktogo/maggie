# Skill naming convention: doc fix + collision detection — Design

**Date:** 2026-09-20
**Status:** Approved

## Purpose

This is P3 of [`docs/proposals/README.md`](../../proposals/README.md#p3--enforce-the-skill-naming-convention-nothing-enforces).

Every skill in the library names itself `<techno>-<directory>`
(`nestjs-module-structure`, `postgres-query-performance`, …). That prefix is
the only thing preventing two technologies from silently overwriting each
other's skill in [`resolveSkills`](../../../libs/skill-sync/src/skills.js:25),
which de-duplicates by `name` in a `Map` with last-write-wins and no warning.

The convention is documented nowhere, and the two pages that teach a
contributor how to write a skill —
[`docs/skills-library.md`](../../skills-library.md) and
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#adding-a-skill) — show the
*unprefixed* form of a skill that is actually prefixed. A contributor
following either example literally writes a skill that breaks the convention
on their first try.

This design fixes both: the documentation, and the silent overwrite.

## Decisions

- **Doc examples become verbatim, verifiable excerpts** of two real skills
  already in the library (`nestjs-module-structure`, `postgres-query-performance`)
  rather than invented illustrative names. An example that can drift from the
  real file is the same class of bug being fixed.
- **The convention gets one sentence** in the frontmatter field table of both
  pages: `name` must be unique across the whole library, not just within a
  technology, by convention `<techno>-<directory>`.
- **A collision is only between two different technologies.** The same
  technology listed twice in a repo's `technologies` (already covered by an
  existing test) re-reads the identical file and is not a collision — only a
  `name` claimed by two distinct technology directories is.
- **Non-strict: warn immediately and continue**, exactly like the existing
  "no skills directory" warning — the run's shape does not change.
- **Strict: accumulate and fail once, not on first collision.** This is
  deliberately different from the existing strict behavior for a missing
  skills directory (which throws immediately). A missing directory stops
  everything else from being resolved and is worth surfacing right away; a
  naming collision does not prevent the rest of resolution from completing,
  and a caller fixing config across several repos or several colliding names
  benefits from seeing every collision at once rather than fixing them one
  `--strict` run at a time.
- **The resolved skill set is unaffected.** Last technology wins, same as
  today — this only adds visibility, it does not change what gets rendered.

## Doc changes

### `docs/skills-library.md`

The frontmatter example (currently `name: module-structure`, invented
`description` and `globs`) is replaced with the real frontmatter of
`skills/nestjs/module-structure/SKILL.md`:

```markdown
---
name: nestjs-module-structure
description: Organize NestJS code into cohesive feature modules with clear public surfaces
globs: ["**/*.module.ts", "**/*.service.ts", "**/*.controller.ts"]
---

Keep one module per bounded context…
```

The `name` row of the frontmatter table gains: "Must be unique across the
whole library, not just within a technology — by convention
`<techno>-<directory>`, since it becomes the output path in every renderer."

### `CONTRIBUTING.md`

Same treatment with `skills/postgres/query-performance/SKILL.md`:

```markdown
---
name: postgres-query-performance
description: Diagnose and fix slow PostgreSQL queries with indexes and EXPLAIN
globs: ["**/*.sql", "**/*.repository.ts"]
---

Guidance body in Markdown…
```

The bullet list under "Adding a skill" gains the same one-line convention
note next to "`name` and `description` are required".

## Code change: `libs/skill-sync/src/skills.js`

`byName` currently maps `name -> skill`. It becomes `name -> { skill, techno }`
so a later insert can tell whether the earlier claimant of that `name` came
from a different technology.

```js
export async function resolveSkills(skillsDir, technologies, { warn = console.warn, strict = false } = {}) {
  const byName = new Map();
  const collisions = [];
  for (const techno of technologies) {
    const technoDir = path.join(skillsDir, techno);
    let entries;
    try {
      entries = await readdir(technoDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        const message = `No skills directory for technology "${techno}" (${technoDir})`;
        if (strict) throw new Error(message, { cause: err });
        warn(message);
        continue;
      }
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(technoDir, entry.name, 'SKILL.md');
      const skill = parseSkill(await readFile(skillFile, 'utf8'), skillFile);
      const existing = byName.get(skill.name);
      if (existing && existing.techno !== techno) {
        const message = `Skill "${skill.name}" is defined by both "${existing.techno}" and "${techno}"; using ${skillFile} (last technology wins)`;
        if (strict) collisions.push(message);
        else warn(message);
      }
      byName.set(skill.name, { skill, techno });
    }
  }
  if (collisions.length > 0) {
    throw new Error(collisions.join('\n'));
  }
  return [...byName.values()].map((entry) => entry.skill);
}
```

The return type is unchanged — an array of skill objects. The `{ skill, techno }`
wrapper is internal to resolution.

## Testing

New fixtures under `libs/skill-sync/test/fixtures/skills/`, kept deliberately
separate from the real `nestjs-*` / `postgres-*` naming so a test failure
can't be confused with a real-library drift:

```
skills/a/shared/SKILL.md   → name: shared-skill
skills/b/shared/SKILL.md   → name: shared-skill
```

Cases, added to `libs/skill-sync/test/skills.test.js`:

1. `resolveSkills warns on a name collision between two technologies, naming both and which file wins` — `resolveSkills(fixtures, ['a', 'b'])` warns once, message names `"a"`, `"b"`, and the winning path; result still has one skill.
2. `resolveSkills throws once under strict with every collision, not on the first` — a config with more than one colliding pair (add a third fixture technology, `c`, also defining `shared-skill`, so `['a', 'b', 'c']` produces two collisions: `a`↔`b` and `b`↔`c`) rejects with an error whose message contains both collision lines.
3. Existing test `resolveSkills dedupes by skill name (last technology wins)` (`['nestjs', 'nestjs']`) continues to pass with no warning — asserted explicitly by passing a `warn` spy and checking it was never called, since this test is the one place the "same technology twice" exclusion is exercised.

## Out of scope

- A `name` that doesn't match `<techno>-<directory>` is not validated here —
  that is [P7's](../../proposals/README.md#p7--maggie-lint-for-the-skills-library)
  library-wide lint, ordered after this fix specifically so an undocumented
  convention isn't enforced against contributors who were shown the wrong
  example.
- A collision between two skills *within* the same technology (two
  directories both naming themselves the same `name`) is not detected here —
  the `existing.techno !== techno` guard explicitly excludes it, and it is a
  narrower problem that P7's `name` == `<techno>-<directory>` rule prevents by
  construction once it lands.
