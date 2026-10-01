# Skill Naming Convention Doc Fix + Collision Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two doc examples that show a skill's `name` in the unprefixed
form (when every real skill in the library is prefixed `<techno>-<directory>`),
document the convention, and make `resolveSkills` warn — or fail once under
`--strict` — when two technologies define a skill with the same `name` instead
of silently letting the second one win.

**Architecture:** Two independent changes. (1) Doc-only edits to
`docs/skills-library.md` and `CONTRIBUTING.md`, swapping the invented
frontmatter examples for verbatim excerpts of two real skills already in the
library, plus one sentence stating the naming convention. (2) A change to
`resolveSkills` in `libs/skill-sync/src/skills.js`: track which technology
first claimed each resolved `name`, and when a later technology claims a
`name` already claimed by a *different* technology, treat it as a collision —
warned immediately in normal mode, accumulated and thrown as a single error at
the end of resolution under `--strict`. The resolved skill set itself is
unchanged (last technology still wins); this only adds visibility.

**Tech Stack:** Node.js (`node:test`, `node --experimental-test-coverage`),
Markdown docs. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-09-20-skill-name-collisions-design.md`](../specs/2026-09-20-skill-name-collisions-design.md)

---

### Task 1: Fix the frontmatter example in `docs/skills-library.md`

**Files:**
- Modify: `docs/skills-library.md:26-41`

This is a documentation-only change — no test to write. `skills/nestjs/module-structure/SKILL.md` already exists in the repo with this exact frontmatter; verify it hasn't drifted before copying it in.

- [ ] **Step 1: Confirm the source skill's current frontmatter**

Run: `sed -n '1,4p' skills/nestjs/module-structure/SKILL.md`

Expected output:
```
---
name: nestjs-module-structure
description: Organize NestJS code into cohesive feature modules with clear public surfaces
globs: ["**/*.module.ts", "**/*.service.ts", "**/*.controller.ts"]
```

If this differs from what's shown above, use the actual current content in Step 2 instead.

- [ ] **Step 2: Replace the example and add the naming-convention sentence**

Replace this block in `docs/skills-library.md` (currently lines 26-41):

`````markdown
```markdown
---
name: module-structure
description: How to lay out a NestJS module and what belongs in it
globs:
  - "src/**/*.module.ts"
---

Keep one module per bounded context…
```

| Frontmatter | Required | Meaning |
|---|---|---|
| `name` | yes | Skill identifier; becomes the generated file name. |
| `description` | yes | One line describing when the skill applies. |
| `globs` | no | File patterns the skill is scoped to. Rendered differently per target — see below. |
`````

with:

`````markdown
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
`````

- [ ] **Step 3: Verify the rendered doc reads correctly**

Run: `sed -n '20,45p' docs/skills-library.md`

Expected: the frontmatter block shows `name: nestjs-module-structure`, and the `name` table row now ends with the "Must be unique…" sentence.

- [ ] **Step 4: Commit**

```bash
git add docs/skills-library.md
git commit -m "docs(skills): use a real, prefixed skill name in the authoring example"
```

---

### Task 2: Fix the frontmatter example in `CONTRIBUTING.md`

**Files:**
- Modify: `CONTRIBUTING.md:83-94`

Same treatment, using `skills/postgres/query-performance/SKILL.md`.

- [ ] **Step 1: Confirm the source skill's current frontmatter**

Run: `sed -n '1,4p' skills/postgres/query-performance/SKILL.md`

Expected output:
```
---
name: postgres-query-performance
description: Diagnose and fix slow PostgreSQL queries with indexes and EXPLAIN
globs: ["**/*.sql", "**/*.repository.ts"]
```

If this differs, use the actual current content in Step 2 instead.

- [ ] **Step 2: Replace the example and add the naming-convention bullet**

Replace this block in `CONTRIBUTING.md` (currently lines 83-94):

`````markdown
```markdown
---
name: query-performance
description: Diagnose and fix slow Postgres queries.
globs: ["**/*.sql"]
---

Guidance body in Markdown…
```

- `<techno>` is matched against each repo's `technologies` list in the config.
- `name` and `description` are required; `globs` is optional.
`````

with:

`````markdown
```markdown
---
name: postgres-query-performance
description: Diagnose and fix slow PostgreSQL queries with indexes and EXPLAIN
globs: ["**/*.sql", "**/*.repository.ts"]
---

Guidance body in Markdown…
```

- `<techno>` is matched against each repo's `technologies` list in the config.
- `name` and `description` are required; `globs` is optional. `name` must be
  unique across the whole library, not just within a technology — by
  convention `<techno>-<directory>`.
`````

- [ ] **Step 3: Verify the rendered doc reads correctly**

Run: `sed -n '77,97p' CONTRIBUTING.md`

Expected: the frontmatter block shows `name: postgres-query-performance`, and the bullet list includes the new sentence about uniqueness.

- [ ] **Step 4: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs(contributing): use a real, prefixed skill name in the authoring example"
```

---

### Task 3: Add collision test fixtures

**Files:**
- Create: `libs/skill-sync/test/fixtures/skills/a/shared/SKILL.md`
- Create: `libs/skill-sync/test/fixtures/skills/b/shared/SKILL.md`
- Create: `libs/skill-sync/test/fixtures/skills/c/shared/SKILL.md`

Three single-skill fixture "technologies" — `a`, `b`, `c` — each defining a
skill named `shared-skill`. Kept deliberately separate from the real
`nestjs-*` / `postgres-*` fixtures already in this directory (`nestjs`,
`react`) so a collision test can never be confused with a real naming-drift
bug in the library itself. Three technologies (not two) are needed so Task 4
can test that `--strict` reports *every* collision, not just the first one.

- [ ] **Step 1: Create the `a` fixture**

Create `libs/skill-sync/test/fixtures/skills/a/shared/SKILL.md`:

```markdown
---
name: shared-skill
description: Fixture skill A for collision testing
---

# Fixture A
Body.
```

- [ ] **Step 2: Create the `b` fixture**

Create `libs/skill-sync/test/fixtures/skills/b/shared/SKILL.md`:

```markdown
---
name: shared-skill
description: Fixture skill B for collision testing
---

# Fixture B
Body.
```

- [ ] **Step 3: Create the `c` fixture**

Create `libs/skill-sync/test/fixtures/skills/c/shared/SKILL.md`:

```markdown
---
name: shared-skill
description: Fixture skill C for collision testing
---

# Fixture C
Body.
```

- [ ] **Step 4: Commit**

```bash
git add libs/skill-sync/test/fixtures/skills/a libs/skill-sync/test/fixtures/skills/b libs/skill-sync/test/fixtures/skills/c
git commit -m "test(skill-sync): add fixture technologies for skill-name collisions"
```

---

### Task 4: Write the failing collision tests

**Files:**
- Modify: `libs/skill-sync/test/skills.test.js`

Add three tests to the existing file — a normal-mode warning test, a strict-mode test asserting every collision is reported (not just the first), and an explicit assertion that the existing same-technology-twice case still warns nothing. Written before the implementation change in Task 5, so they fail first for the right reason.

- [ ] **Step 1: Add the three tests**

Append to `libs/skill-sync/test/skills.test.js` (after the existing last test, `resolveSkills throws instead of warning on a missing technology in strict mode`):

```js
test('resolveSkills warns on a name collision between two technologies, naming both and which file wins', async () => {
  const warnings = [];
  const skills = await resolveSkills(fixtures, ['a', 'b'], {
    warn: (m) => warnings.push(m),
  });
  assert.equal(skills.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skill "shared-skill" is defined by both "a" and "b"/);
  assert.match(warnings[0], /using .*b[/\\]shared[/\\]SKILL\.md/);
  assert.match(warnings[0], /last technology wins/);
});

test('resolveSkills under strict throws once, listing every collision found, not just the first', async () => {
  await assert.rejects(
    () => resolveSkills(fixtures, ['a', 'b', 'c'], { strict: true }),
    (err) => {
      assert.match(err.message, /"a" and "b"/);
      assert.match(err.message, /"b" and "c"/);
      return true;
    },
  );
});

test('resolveSkills does not warn when the same technology is listed twice', async () => {
  const warnings = [];
  await resolveSkills(fixtures, ['nestjs', 'nestjs'], {
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(warnings, []);
});
```

- [ ] **Step 2: Run the tests and confirm the new three fail**

Run: `cd libs/skill-sync && node --test test/skills.test.js`

Expected: 20 existing tests pass (or whatever the current count is), and the 3 new tests fail. The collision tests should fail with an assertion error (warnings array empty / length 0, or the rejects call not rejecting) — confirming today's silent last-write-wins behavior. The third test should currently *pass* already (no code change needed for it), which confirms the existing exclusion of the "same technology twice" case; that's fine — it exists to guard against a future regression, not to prove new behavior.

---

### Task 5: Implement collision detection in `resolveSkills`

**Files:**
- Modify: `libs/skill-sync/src/skills.js`

- [ ] **Step 1: Read the current file to confirm nothing has drifted**

Run: `cat libs/skill-sync/src/skills.js`

Expected current content:

```js
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSkill } from './skill.js';

export async function resolveSkills(skillsDir, technologies, { warn = console.warn, strict = false } = {}) {
  const byName = new Map();
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
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}
```

If this differs, stop and reconcile before proceeding — the replacement in Step 2 assumes this exact shape.

- [ ] **Step 2: Replace the file with the collision-aware version**

Write `libs/skill-sync/src/skills.js`:

```js
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSkill } from './skill.js';

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
        if (strict) {
          collisions.push(message);
        } else {
          warn(message);
        }
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

Note the return-value change: `byName` now stores `{ skill, techno }` instead of the bare `skill`, so the final `return` maps back to plain skill objects — every existing caller of `resolveSkills` keeps receiving an array of skill objects, unchanged.

- [ ] **Step 3: Run the full skill-sync test suite with coverage**

Run:
```bash
cd libs/skill-sync
node --test --experimental-test-coverage --test-coverage-include="src/**/*.js" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 "test/**/*.test.js"
```

Expected: all tests pass (23 total: the 20 from before this plan, plus the 3 added in Task 4), and the coverage report shows `100.00` for lines, branches and functions on all three files (`pipeline.js`, `skill.js`, `skills.js`). If `skills.js` shows less than 100% branch coverage, the most likely gap is the `strict` collision-accumulation `if`/`else` — confirm Task 4's tests exercise both the `warn()` branch (test 1) and the `collisions.push` branch (test 2).

- [ ] **Step 4: Commit**

```bash
git add libs/skill-sync/src/skills.js libs/skill-sync/test/skills.test.js
git commit -m "feat(skill-sync): warn on a skill-name collision between technologies, fail once under --strict"
```

---

### Task 6: Full-repo verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite via Nx**

Run: `npm test`

Expected: every project passes, including `skill-sync` with 100% coverage. This also re-confirms no other project imports `resolveSkills` in a way that assumed the old `byName.values()` held bare skill objects internally (the public return type is unchanged, but this is the cheap way to be sure).

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: no errors.

- [ ] **Step 3: Confirm the doc examples match the real files one more time**

Run:
```bash
diff <(sed -n '1,4p' skills/nestjs/module-structure/SKILL.md) <(sed -n '27,30p' docs/skills-library.md)
diff <(sed -n '1,4p' skills/postgres/query-performance/SKILL.md) <(sed -n '84,87p' CONTRIBUTING.md)
```

Expected: both `diff` commands print nothing (no difference). If either prints a diff, the source skill changed since Task 1/2 were written — update the doc to match the current file rather than forcing the fixture to match a stale doc.

- [ ] **Step 4: Push**

```bash
git push -u origin claude/project-feature-proposals-nsegpl
```

---

## Self-Review Notes

- **Spec coverage:** doc fix (Tasks 1-2) ✓, collision warning in normal mode (Task 4 test 1, Task 5) ✓, strict accumulate-then-fail-once (Task 4 test 2, Task 5) ✓, same-technology-twice stays silent (Task 4 test 3) ✓, resolved skill set unchanged (Task 5 Step 2 return-type note) ✓, out-of-scope items (P7's `name` format lint, within-technology collisions) intentionally not implemented here, matching the spec.
- **Type consistency:** `resolveSkills`'s public signature and return type (`Promise<Array<{name, description, globs, body}>>`) are unchanged across all tasks; only the internal `byName` value shape changes, and Task 5 Step 2 maps it back before returning.
- **No placeholders:** every step shows the exact file content or exact command and its expected output.
