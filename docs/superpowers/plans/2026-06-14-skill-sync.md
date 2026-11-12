# Skill Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Node.js scripts that read a JSON list of repositories, clone each, generate AI-agent skill files for the repo's assigned technologies in each target platform's format, then branch/commit/push (PR opt-in).

**Architecture:** A renderer registry (one pure module per platform) feeds a pipeline that isolates four concerns — config loading, skill resolution, per-platform rendering, git operations. Pure modules (`frontmatter`, `skill`, `renderers`) hold the deterministic logic; I/O modules (`git`, `pipeline`, `index`) accept injected dependencies so every branch is testable offline.

**Tech Stack:** Node.js ≥ 22 (ESM), `gray-matter` (parse source frontmatter), native `node:test`/`node:assert`, native `child_process` for `git`/`gh`. Coverage enforced at a strict 100% over `src/` via Node's built-in coverage thresholds.

---

## File Structure

```
ai-sync/
  bin/
    sync.js                # executable bootstrap (outside coverage gate)
  src/
    index.js               # main(argv, deps) — CLI parsing + orchestration entry
    config.js              # load + validate repos.json
    skill.js               # parseSkill(content) — parse one SKILL.md (pure)
    skills.js              # resolveSkills(dir, technos) — filesystem resolution
    frontmatter.js         # serializeFrontmatter + buildDocument (pure)
    git.js                 # clone + repo command wrapper (injectable exec)
    pipeline.js            # run(config, deps) — orchestration
    renderers/
      index.js             # registry: getRenderer, knownTargets
      claude.js
      copilot.js
      cursor.js
      windsurf.js
  test/
    fixtures/skills/       # minimal skills tree for skills/pipeline tests
    *.test.js
  repos.json               # sample config
  package.json
```

**Coverage gate:** `bin/sync.js` is the only untestable wiring (it reads `process.argv` and sets `process.exitCode`); it lives outside `src/` so the 100% gate applies only to fully testable code.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ai-sync",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "bin": {
    "ai-sync": "bin/sync.js"
  },
  "scripts": {
    "start": "node bin/sync.js",
    "test": "node --test --experimental-test-coverage --test-coverage-include=\"src/**/*.js\" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100"
  },
  "dependencies": {
    "gray-matter": "^4.0.3"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` written, no errors.

- [ ] **Step 4: Verify the test script runs (no tests yet)**

Run: `npm test`
Expected: exits 0 with "tests 0" (no test files found yet). If Node reports unknown coverage flags, the Node version is < 22 — stop and upgrade.

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore package-lock.json
git commit -m "chore: scaffold Node project with strict coverage test script"
```

---

## Task 2: Frontmatter serializer (`src/frontmatter.js`)

Deterministic YAML output (always double-quoted strings) so renderer tests can assert exact bytes. Pure, no dependencies.

**Files:**
- Create: `src/frontmatter.js`
- Test: `test/frontmatter.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeFrontmatter, buildDocument } from '../src/frontmatter.js';

test('serializeFrontmatter quotes strings and renders booleans bare', () => {
  const out = serializeFrontmatter({ name: 'a', alwaysApply: true });
  assert.equal(out, '---\nname: "a"\nalwaysApply: true\n---\n');
});

test('serializeFrontmatter escapes quotes and backslashes', () => {
  const out = serializeFrontmatter({ description: 'say "hi"\\done' });
  assert.equal(out, '---\ndescription: "say \\"hi\\"\\\\done"\n---\n');
});

test('serializeFrontmatter rejects unsupported value types', () => {
  assert.throws(() => serializeFrontmatter({ n: 5 }), /Unsupported frontmatter value/);
});

test('buildDocument joins frontmatter and trimmed body with one blank line', () => {
  const out = buildDocument({ name: 'a' }, '\n# Title\nBody\n\n');
  assert.equal(out, '---\nname: "a"\n---\n\n# Title\nBody\n');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/frontmatter.test.js`
Expected: FAIL — cannot find module `../src/frontmatter.js`.

- [ ] **Step 3: Write the implementation**

```javascript
function serializeValue(value) {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  throw new Error(`Unsupported frontmatter value type: ${typeof value}`);
}

export function serializeFrontmatter(frontmatter) {
  const lines = Object.entries(frontmatter).map(
    ([key, value]) => `${key}: ${serializeValue(value)}`,
  );
  return `---\n${lines.join('\n')}\n---\n`;
}

export function buildDocument(frontmatter, body) {
  return `${serializeFrontmatter(frontmatter)}\n${body.trim()}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/frontmatter.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/frontmatter.js test/frontmatter.test.js
git commit -m "feat: deterministic frontmatter serializer"
```

---

## Task 3: Source skill parser (`src/skill.js`)

Parses one `SKILL.md` string into a canonical skill object. Validates required fields.

**Files:**
- Create: `src/skill.js`
- Test: `test/skill.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkill } from '../src/skill.js';

const valid = `---
name: nestjs-module-structure
description: How to structure NestJS modules
globs: ["**/*.ts"]
---

# Module structure
Body here.
`;

test('parseSkill extracts name, description, globs and trimmed body', () => {
  const skill = parseSkill(valid, 'a/SKILL.md');
  assert.deepEqual(skill, {
    name: 'nestjs-module-structure',
    description: 'How to structure NestJS modules',
    globs: ['**/*.ts'],
    body: '# Module structure\nBody here.',
  });
});

test('parseSkill leaves globs undefined when absent', () => {
  const skill = parseSkill('---\nname: a\ndescription: b\n---\nBody', 'x');
  assert.equal(skill.globs, undefined);
});

test('parseSkill requires name', () => {
  assert.throws(() => parseSkill('---\ndescription: b\n---\nx', 'f'), /missing "name"/);
});

test('parseSkill requires description', () => {
  assert.throws(() => parseSkill('---\nname: a\n---\nx', 'f'), /missing "description"/);
});

test('parseSkill rejects non-array globs', () => {
  assert.throws(
    () => parseSkill('---\nname: a\ndescription: b\nglobs: "x"\n---\ny', 'f'),
    /"globs" must be an array/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/skill.test.js`
Expected: FAIL — cannot find module `../src/skill.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import matter from 'gray-matter';

export function parseSkill(content, source) {
  const { data, content: body } = matter(content);
  if (!data.name) throw new Error(`${source}: skill frontmatter missing "name"`);
  if (!data.description) throw new Error(`${source}: skill frontmatter missing "description"`);
  let globs;
  if (data.globs !== undefined) {
    if (!Array.isArray(data.globs)) {
      throw new Error(`${source}: "globs" must be an array`);
    }
    globs = data.globs;
  }
  return { name: data.name, description: data.description, globs, body: body.trim() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/skill.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/skill.js test/skill.test.js
git commit -m "feat: parse and validate source SKILL.md files"
```

---

## Task 4: Claude renderer (`src/renderers/claude.js`)

**Files:**
- Create: `src/renderers/claude.js`
- Test: `test/renderers/claude.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import claude from '../../src/renderers/claude.js';

const skill = {
  name: 'nestjs-module-structure',
  description: 'How to structure NestJS modules',
  globs: ['**/*.ts'],
  body: '# Module structure',
};

test('claude renders SKILL.md path and name/description frontmatter', () => {
  const { path, content } = claude.render(skill);
  assert.equal(path, '.claude/skills/nestjs-module-structure/SKILL.md');
  assert.equal(
    content,
    '---\nname: "nestjs-module-structure"\ndescription: "How to structure NestJS modules"\n---\n\n# Module structure\n',
  );
});

test('claude id is "claude"', () => {
  assert.equal(claude.id, 'claude');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/renderers/claude.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```javascript
import { buildDocument } from '../frontmatter.js';

export default {
  id: 'claude',
  render(skill) {
    const content = buildDocument(
      { name: skill.name, description: skill.description },
      skill.body,
    );
    return { path: `.claude/skills/${skill.name}/SKILL.md`, content };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/renderers/claude.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderers/claude.js test/renderers/claude.test.js
git commit -m "feat: Claude Code skill renderer"
```

---

## Task 5: Copilot renderer (`src/renderers/copilot.js`)

`applyTo` is derived from `globs` (comma-joined), defaulting to `**`.

**Files:**
- Create: `src/renderers/copilot.js`
- Test: `test/renderers/copilot.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import copilot from '../../src/renderers/copilot.js';

const base = { name: 'x', description: 'D', body: '# B' };

test('copilot derives applyTo from globs and uses instructions path', () => {
  const { path, content } = copilot.render({ ...base, globs: ['**/*.ts', '**/*.tsx'] });
  assert.equal(path, '.github/instructions/x.instructions.md');
  assert.equal(
    content,
    '---\ndescription: "D"\napplyTo: "**/*.ts,**/*.tsx"\n---\n\n# B\n',
  );
});

test('copilot defaults applyTo to ** when globs absent', () => {
  const { content } = copilot.render(base);
  assert.match(content, /applyTo: "\*\*"/);
});

test('copilot id is "copilot"', () => {
  assert.equal(copilot.id, 'copilot');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/renderers/copilot.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```javascript
import { buildDocument } from '../frontmatter.js';

function applyTo(globs) {
  if (!Array.isArray(globs) || globs.length === 0) return '**';
  return globs.join(',');
}

export default {
  id: 'copilot',
  render(skill) {
    const content = buildDocument(
      { description: skill.description, applyTo: applyTo(skill.globs) },
      skill.body,
    );
    return { path: `.github/instructions/${skill.name}.instructions.md`, content };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/renderers/copilot.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderers/copilot.js test/renderers/copilot.test.js
git commit -m "feat: GitHub Copilot skill renderer"
```

---

## Task 6: Cursor renderer (`src/renderers/cursor.js`)

`.mdc` with `description`, `globs` (comma-joined string, empty when none), `alwaysApply` (`true` when no globs).

**Files:**
- Create: `src/renderers/cursor.js`
- Test: `test/renderers/cursor.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import cursor from '../../src/renderers/cursor.js';

const base = { name: 'x', description: 'D', body: '# B' };

test('cursor with globs sets globs and alwaysApply false', () => {
  const { path, content } = cursor.render({ ...base, globs: ['**/*.ts'] });
  assert.equal(path, '.cursor/rules/x.mdc');
  assert.equal(
    content,
    '---\ndescription: "D"\nglobs: "**/*.ts"\nalwaysApply: false\n---\n\n# B\n',
  );
});

test('cursor without globs sets empty globs and alwaysApply true', () => {
  const { content } = cursor.render(base);
  assert.equal(
    content,
    '---\ndescription: "D"\nglobs: ""\nalwaysApply: true\n---\n\n# B\n',
  );
});

test('cursor id is "cursor"', () => {
  assert.equal(cursor.id, 'cursor');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/renderers/cursor.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```javascript
import { buildDocument } from '../frontmatter.js';

export default {
  id: 'cursor',
  render(skill) {
    const hasGlobs = Array.isArray(skill.globs) && skill.globs.length > 0;
    const content = buildDocument(
      {
        description: skill.description,
        globs: hasGlobs ? skill.globs.join(',') : '',
        alwaysApply: !hasGlobs,
      },
      skill.body,
    );
    return { path: `.cursor/rules/${skill.name}.mdc`, content };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/renderers/cursor.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderers/cursor.js test/renderers/cursor.test.js
git commit -m "feat: Cursor skill renderer"
```

---

## Task 7: Windsurf renderer (`src/renderers/windsurf.js`)

`.windsurf/rules/<name>.md` with `description`, plus `globs` only when present.

**Files:**
- Create: `src/renderers/windsurf.js`
- Test: `test/renderers/windsurf.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import windsurf from '../../src/renderers/windsurf.js';

const base = { name: 'x', description: 'D', body: '# B' };

test('windsurf with globs includes globs key', () => {
  const { path, content } = windsurf.render({ ...base, globs: ['**/*.ts'] });
  assert.equal(path, '.windsurf/rules/x.md');
  assert.equal(content, '---\ndescription: "D"\nglobs: "**/*.ts"\n---\n\n# B\n');
});

test('windsurf without globs omits globs key', () => {
  const { content } = windsurf.render(base);
  assert.equal(content, '---\ndescription: "D"\n---\n\n# B\n');
});

test('windsurf id is "windsurf"', () => {
  assert.equal(windsurf.id, 'windsurf');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/renderers/windsurf.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```javascript
import { buildDocument } from '../frontmatter.js';

export default {
  id: 'windsurf',
  render(skill) {
    const hasGlobs = Array.isArray(skill.globs) && skill.globs.length > 0;
    const frontmatter = hasGlobs
      ? { description: skill.description, globs: skill.globs.join(',') }
      : { description: skill.description };
    const content = buildDocument(frontmatter, skill.body);
    return { path: `.windsurf/rules/${skill.name}.md`, content };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/renderers/windsurf.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderers/windsurf.js test/renderers/windsurf.test.js
git commit -m "feat: Windsurf skill renderer"
```

---

## Task 8: Renderer registry (`src/renderers/index.js`)

**Files:**
- Create: `src/renderers/index.js`
- Test: `test/renderers/index.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRenderer, knownTargets } from '../../src/renderers/index.js';

test('knownTargets lists all four platforms', () => {
  assert.deepEqual(knownTargets().sort(), ['claude', 'copilot', 'cursor', 'windsurf']);
});

test('getRenderer returns the matching renderer', () => {
  assert.equal(getRenderer('claude').id, 'claude');
});

test('getRenderer throws on unknown target', () => {
  assert.throws(() => getRenderer('nope'), /Unknown target: nope/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/renderers/index.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```javascript
import claude from './claude.js';
import copilot from './copilot.js';
import cursor from './cursor.js';
import windsurf from './windsurf.js';

const renderers = { claude, copilot, cursor, windsurf };

export function getRenderer(id) {
  const renderer = renderers[id];
  if (!renderer) throw new Error(`Unknown target: ${id}`);
  return renderer;
}

export function knownTargets() {
  return Object.keys(renderers);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/renderers/index.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderers/index.js test/renderers/index.test.js
git commit -m "feat: renderer registry"
```

---

## Task 9: Config loader (`src/config.js`)

Parses and validates `repos.json`; resolves per-repo targets against `defaultTargets`.

**Files:**
- Create: `src/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig, loadConfig } from '../src/config.js';

test('parseConfig resolves repo targets, falling back to defaultTargets', () => {
  const cfg = parseConfig(JSON.stringify({
    defaultTargets: ['claude', 'copilot'],
    repos: [
      { name: 'a', url: 'u1', technologies: ['nestjs'] },
      { name: 'b', url: 'u2', technologies: ['react'], targets: ['cursor'] },
    ],
  }));
  assert.deepEqual(cfg.repos[0].targets, ['claude', 'copilot']);
  assert.deepEqual(cfg.repos[1].targets, ['cursor']);
});

test('parseConfig rejects invalid JSON', () => {
  assert.throws(() => parseConfig('{not json'), /Invalid JSON in config/);
});

test('parseConfig requires a non-empty repos array', () => {
  assert.throws(() => parseConfig('{"repos": []}'), /non-empty "repos" array/);
});

test('parseConfig rejects unknown default targets', () => {
  assert.throws(
    () => parseConfig('{"defaultTargets":["bad"],"repos":[{"name":"a","url":"u","technologies":["t"]}]}'),
    /unknown target "bad"/,
  );
});

test('parseConfig rejects unknown per-repo targets', () => {
  assert.throws(
    () => parseConfig('{"repos":[{"name":"a","url":"u","technologies":["t"],"targets":["bad"]}]}'),
    /unknown target "bad"/,
  );
});

test('parseConfig requires name', () => {
  assert.throws(() => parseConfig('{"repos":[{"url":"u","technologies":["t"]}]}'), /missing "name"/);
});

test('parseConfig requires url', () => {
  assert.throws(() => parseConfig('{"repos":[{"name":"a","technologies":["t"]}]}'), /missing "url"/);
});

test('parseConfig requires non-empty technologies', () => {
  assert.throws(
    () => parseConfig('{"repos":[{"name":"a","url":"u","technologies":[]}]}'),
    /"technologies" must be a non-empty array/,
  );
});

test('parseConfig rejects a repo that ends up with no targets', () => {
  assert.throws(
    () => parseConfig('{"repos":[{"name":"a","url":"u","technologies":["t"]}]}'),
    /no targets/,
  );
});

test('parseConfig rejects non-array defaultTargets', () => {
  assert.throws(
    () => parseConfig('{"defaultTargets":"claude","repos":[{"name":"a","url":"u","technologies":["t"]}]}'),
    /must be an array/,
  );
});

test('loadConfig reads and parses a file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cfg-'));
  const file = path.join(dir, 'repos.json');
  await writeFile(file, '{"defaultTargets":["claude"],"repos":[{"name":"a","url":"u","technologies":["t"]}]}');
  const cfg = await loadConfig(file);
  assert.equal(cfg.repos[0].name, 'a');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — cannot find module `../src/config.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import { readFile } from 'node:fs/promises';
import { knownTargets } from './renderers/index.js';

export async function loadConfig(filePath) {
  return parseConfig(await readFile(filePath, 'utf8'));
}

export function parseConfig(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in config: ${err.message}`);
  }
  const valid = knownTargets();
  const defaultTargets = parsed.defaultTargets ?? [];
  validateTargets(defaultTargets, valid, 'defaultTargets');
  if (!Array.isArray(parsed.repos) || parsed.repos.length === 0) {
    throw new Error('Config must define a non-empty "repos" array');
  }
  const repos = parsed.repos.map((repo, i) => normalizeRepo(repo, i, defaultTargets, valid));
  return { defaultTargets, repos };
}

function normalizeRepo(repo, index, defaultTargets, valid) {
  const label = repo.name ? `repos[${index}] (${repo.name})` : `repos[${index}]`;
  if (!repo.name) throw new Error(`repos[${index}]: missing "name"`);
  if (!repo.url) throw new Error(`${label}: missing "url"`);
  if (!Array.isArray(repo.technologies) || repo.technologies.length === 0) {
    throw new Error(`${label}: "technologies" must be a non-empty array`);
  }
  const targets = repo.targets ?? defaultTargets;
  validateTargets(targets, valid, `${label}.targets`);
  if (targets.length === 0) {
    throw new Error(`${label}: no targets (set repo.targets or defaultTargets)`);
  }
  return { name: repo.name, url: repo.url, technologies: repo.technologies, targets };
}

function validateTargets(targets, valid, label) {
  if (!Array.isArray(targets)) throw new Error(`${label} must be an array`);
  for (const target of targets) {
    if (!valid.includes(target)) {
      throw new Error(`${label}: unknown target "${target}" (known: ${valid.join(', ')})`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: config loader with validation"
```

---

## Task 10: Skill fixtures + resolver (`src/skills.js`)

Resolves the union of skills across a repo's technologies from the filesystem, deduped by name.

**Files:**
- Create: `test/fixtures/skills/nestjs/module-structure/SKILL.md`
- Create: `test/fixtures/skills/nestjs/_notdir.txt` (proves non-directories are skipped)
- Create: `test/fixtures/skills/react/component/SKILL.md`
- Create: `src/skills.js`
- Test: `test/skills.test.js`

- [ ] **Step 1: Create the fixtures**

`test/fixtures/skills/nestjs/module-structure/SKILL.md`:
```markdown
---
name: nestjs-module-structure
description: How to structure NestJS modules
globs: ["**/*.ts"]
---

# Module structure
Body.
```

`test/fixtures/skills/nestjs/_notdir.txt`:
```
not a skill directory
```

`test/fixtures/skills/react/component/SKILL.md`:
```markdown
---
name: react-component
description: How to write React components
---

# Component
Body.
```

- [ ] **Step 2: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSkills } from '../src/skills.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/skills');

test('resolveSkills returns the union across technologies, skipping non-directories', async () => {
  const skills = await resolveSkills(fixtures, ['nestjs', 'react']);
  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ['nestjs-module-structure', 'react-component']);
});

test('resolveSkills warns and continues when a technology has no directory', async () => {
  const warnings = [];
  const skills = await resolveSkills(fixtures, ['nestjs', 'missing'], {
    warn: (m) => warnings.push(m),
  });
  assert.equal(skills.length, 1);
  assert.match(warnings[0], /No skills directory for technology "missing"/);
});

test('resolveSkills dedupes by skill name (last technology wins)', async () => {
  const skills = await resolveSkills(fixtures, ['nestjs', 'nestjs']);
  assert.equal(skills.length, 1);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/skills.test.js`
Expected: FAIL — cannot find module `../src/skills.js`.

- [ ] **Step 4: Write the implementation**

```javascript
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSkill } from './skill.js';

export async function resolveSkills(skillsDir, technologies, { warn = console.warn } = {}) {
  const byName = new Map();
  for (const techno of technologies) {
    const technoDir = path.join(skillsDir, techno);
    let entries;
    try {
      entries = await readdir(technoDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        warn(`No skills directory for technology "${techno}" (${technoDir})`);
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

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/skills.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/skills.js test/skills.test.js test/fixtures
git commit -m "feat: filesystem skill resolver with dedup and missing-techno warning"
```

---

## Task 11: Git wrapper (`src/git.js`)

A thin wrapper over `git`/`gh`. `defaultExec` runs the real binary; an injected `exec` lets tests assert `gh` calls without a real `gh`. Real `git` calls in tests run against a local bare repo (no network).

**Files:**
- Create: `src/git.js`
- Test: `test/git.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clone, createRepo } from '../src/git.js';

async function makeBareRemote() {
  const root = await mkdtemp(path.join(tmpdir(), 'git-'));
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '--bare', bare]);
  execFileSync('git', ['clone', bare, seed]);
  execFileSync('git', ['-C', seed, 'config', 'user.email', 't@t.dev']);
  execFileSync('git', ['-C', seed, 'config', 'user.name', 'T']);
  await writeFile(path.join(seed, 'README.md'), '# seed\n');
  execFileSync('git', ['-C', seed, 'add', '.']);
  execFileSync('git', ['-C', seed, 'commit', '-m', 'init']);
  execFileSync('git', ['-C', seed, 'push', 'origin', 'HEAD:main']);
  return { root, bare };
}

function configure(dir) {
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t.dev']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
}

test('clone + checkoutBranch + commitAll + push round-trips through a bare remote', async () => {
  const { root, bare } = await makeBareRemote();
  const dest = path.join(root, 'work');
  const repo = await clone(bare, dest);
  configure(dest);
  await repo.checkoutBranch('ai-sync/update-skills');
  await writeFile(path.join(dest, 'new.txt'), 'hello\n');
  assert.equal(await repo.hasChanges(), true);
  await repo.commitAll('chore: sync');
  await repo.push('ai-sync/update-skills');

  const verify = path.join(root, 'verify');
  execFileSync('git', ['clone', '--branch', 'ai-sync/update-skills', bare, verify]);
  assert.equal(await readFile(path.join(verify, 'new.txt'), 'utf8'), 'hello\n');
});

test('hasChanges is false on a clean clone', async () => {
  const { root, bare } = await makeBareRemote();
  const dest = path.join(root, 'work');
  const repo = await clone(bare, dest);
  configure(dest);
  assert.equal(await repo.hasChanges(), false);
});

test('createPR invokes gh with title and body', async () => {
  const calls = [];
  const repo = createRepo('/somewhere', {
    exec: async (file, args) => {
      calls.push({ file, args });
      return '';
    },
  });
  await repo.createPR('My title', 'My body');
  assert.deepEqual(calls[0], {
    file: 'gh',
    args: ['pr', 'create', '--title', 'My title', '--body', 'My body'],
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/git.test.js`
Expected: FAIL — cannot find module `../src/git.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function defaultExec(file, args, options) {
  const { stdout } = await execFileAsync(file, args, options);
  return stdout;
}

export function createRepo(dir, { exec = defaultExec } = {}) {
  const git = (...args) => exec('git', args, { cwd: dir });
  return {
    dir,
    async checkoutBranch(branch) {
      await git('checkout', '-B', branch);
    },
    async hasChanges() {
      const out = await exec('git', ['status', '--porcelain'], { cwd: dir });
      return out.trim().length > 0;
    },
    async commitAll(message) {
      await git('add', '-A');
      await git('commit', '-m', message);
    },
    async push(branch) {
      await git('push', '-f', '-u', 'origin', branch);
    },
    async createPR(title, body) {
      await exec('gh', ['pr', 'create', '--title', title, '--body', body], { cwd: dir });
    },
  };
}

export async function clone(url, dir, { exec = defaultExec } = {}) {
  await exec('git', ['clone', url, dir], {});
  return createRepo(dir, { exec });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/git.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/git.js test/git.test.js
git commit -m "feat: git/gh wrapper with injectable exec"
```

---

## Task 12: Pipeline (`src/pipeline.js`)

Orchestrates per repo: resolve skills → render files → (dry-run prints) → clone → write → no-op skip → commit/push/PR. Errors are isolated per repo; a summary is logged. All collaborators are injectable.

**Files:**
- Create: `src/pipeline.js`
- Test: `test/pipeline.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/pipeline.js';

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

// A fake git repo that records writes via the real filesystem the pipeline writes to.
function fakeCloneFactory(state) {
  return async function fakeClone(url, dir) {
    await mkdir(dir, { recursive: true });
    state.cloned.push({ url, dir });
    return {
      dir,
      async checkoutBranch(branch) { state.branch = branch; },
      async hasChanges() { return state.hasChanges; },
      async commitAll(message) { state.commit = message; },
      async push(branch) { state.pushed = branch; },
      async createPR(title, body) { state.pr = { title, body }; },
    };
  };
}

const config = {
  defaultTargets: ['claude'],
  repos: [{ name: 'a', url: 'u', technologies: ['nestjs'], targets: ['claude'] }],
};

const skill = { name: 's', description: 'D', body: '# B' };
const resolveSkills = async () => [skill];

test('dry-run renders files without cloning', async () => {
  const logs = [];
  const results = await run(config, {
    skillsDir: 'irrelevant',
    workDir: 'irrelevant',
    dryRun: true,
    resolveSkills,
    clone: () => { throw new Error('should not clone'); },
    logger: { log: (m) => logs.push(m), warn() {}, error() {} },
  });
  assert.equal(results[0].status, 'dry-run');
  assert.ok(logs.some((l) => l.includes('.claude/skills/s/SKILL.md')));
});

test('full run writes files, commits, pushes, and skips PR when --pr absent', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: true };
  const results = await run(config, {
    skillsDir: 'irrelevant',
    workDir,
    pr: false,
    resolveSkills,
    clone: fakeCloneFactory(state),
    logger: silentLogger(),
  });
  assert.equal(results[0].status, 'pushed');
  assert.equal(state.branch, 'ai-sync/update-skills');
  assert.equal(state.pushed, 'ai-sync/update-skills');
  assert.equal(state.pr, undefined);
  const written = await readFile(path.join(workDir, 'a', '.claude/skills/s/SKILL.md'), 'utf8');
  assert.match(written, /name: "s"/);
});

test('--pr opens a PR after push', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: true };
  const results = await run(config, {
    skillsDir: 'x', workDir, pr: true, resolveSkills,
    clone: fakeCloneFactory(state), logger: silentLogger(),
  });
  assert.equal(results[0].status, 'pr');
  assert.deepEqual(state.pr, { title: 'Sync AI agent skills', body: 'Automated skill sync from ai-sync.' });
});

test('no-op when nothing changed: no commit/push', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: false };
  const results = await run(config, {
    skillsDir: 'x', workDir, resolveSkills,
    clone: fakeCloneFactory(state), logger: silentLogger(),
  });
  assert.equal(results[0].status, 'skipped');
  assert.equal(state.commit, undefined);
  assert.equal(state.pushed, undefined);
});

test('errors are isolated per repo and recorded', async () => {
  const twoRepos = {
    defaultTargets: ['claude'],
    repos: [
      { name: 'bad', url: 'u', technologies: ['t'], targets: ['claude'] },
      { name: 'good', url: 'u', technologies: ['t'], targets: ['claude'] },
    ],
  };
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: true };
  const results = await run(twoRepos, {
    skillsDir: 'x', workDir, resolveSkills,
    clone: async (url, dir) => {
      if (dir.endsWith('bad')) throw new Error('clone failed');
      return fakeCloneFactory(state)(url, dir);
    },
    logger: silentLogger(),
  });
  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /clone failed/);
  assert.equal(results[1].status, 'pushed');
});

test('repoFilter restricts processing to one repo', async () => {
  const twoRepos = {
    defaultTargets: ['claude'],
    repos: [
      { name: 'a', url: 'u', technologies: ['t'], targets: ['claude'] },
      { name: 'b', url: 'u', technologies: ['t'], targets: ['claude'] },
    ],
  };
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const results = await run(twoRepos, {
    skillsDir: 'x', workDir, repoFilter: 'b', resolveSkills,
    clone: fakeCloneFactory({ cloned: [], hasChanges: true }),
    logger: silentLogger(),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].repo, 'b');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pipeline.test.js`
Expected: FAIL — cannot find module `../src/pipeline.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { clone as defaultClone } from './git.js';
import { resolveSkills as defaultResolveSkills } from './skills.js';
import { getRenderer as defaultGetRenderer } from './renderers/index.js';

const BRANCH = 'ai-sync/update-skills';
const COMMIT_MESSAGE = 'chore: sync AI agent skills';
const PR_TITLE = 'Sync AI agent skills';
const PR_BODY = 'Automated skill sync from ai-sync.';

export async function run(config, options = {}) {
  const {
    skillsDir,
    workDir,
    pr = false,
    dryRun = false,
    repoFilter,
    clone = defaultClone,
    resolveSkills = defaultResolveSkills,
    getRenderer = defaultGetRenderer,
    logger = console,
  } = options;

  const repos = repoFilter
    ? config.repos.filter((repo) => repo.name === repoFilter)
    : config.repos;

  const results = [];
  for (const repo of repos) {
    try {
      results.push(await syncRepo(repo, {
        skillsDir, workDir, pr, dryRun, clone, resolveSkills, getRenderer, logger,
      }));
    } catch (err) {
      logger.error(`✗ ${repo.name}: ${err.message}`);
      results.push({ repo: repo.name, status: 'error', error: err.message });
    }
  }

  report(results, logger);
  return results;
}

async function syncRepo(repo, ctx) {
  const { skillsDir, workDir, pr, dryRun, clone, resolveSkills, getRenderer, logger } = ctx;
  const skills = await resolveSkills(skillsDir, repo.technologies, {
    warn: (m) => logger.warn(m),
  });

  const files = [];
  for (const skill of skills) {
    for (const target of repo.targets) {
      files.push(getRenderer(target).render(skill));
    }
  }

  if (dryRun) {
    for (const file of files) logger.log(`[dry-run] ${repo.name}: ${file.path}`);
    return { repo: repo.name, status: 'dry-run', files: files.length };
  }

  const dest = path.join(workDir, repo.name);
  await rm(dest, { recursive: true, force: true });
  const gitRepo = await clone(repo.url, dest);
  await gitRepo.checkoutBranch(BRANCH);

  for (const file of files) {
    const full = path.join(dest, file.path);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, file.content);
  }

  if (!(await gitRepo.hasChanges())) {
    logger.log(`= ${repo.name}: no changes`);
    return { repo: repo.name, status: 'skipped', files: files.length };
  }

  await gitRepo.commitAll(COMMIT_MESSAGE);
  await gitRepo.push(BRANCH);
  if (pr) await gitRepo.createPR(PR_TITLE, PR_BODY);

  logger.log(`✓ ${repo.name}: ${files.length} files pushed${pr ? ' + PR' : ''}`);
  return { repo: repo.name, status: pr ? 'pr' : 'pushed', files: files.length };
}

function report(results, logger) {
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  logger.log(`\nSummary: ${JSON.stringify(counts)}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pipeline.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.js test/pipeline.test.js
git commit -m "feat: sync pipeline with per-repo isolation and no-op skip"
```

---

## Task 13: CLI entry (`src/index.js`)

`main(argv, deps)` parses flags, loads config, runs the pipeline, and returns an exit code. Dependencies injected for testing.

**Files:**
- Create: `src/index.js`
- Test: `test/index.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/index.js';

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

const fakeConfig = { defaultTargets: ['claude'], repos: [] };

test('main requires --config', async () => {
  await assert.rejects(
    () => main([], { loadConfig: async () => fakeConfig, runPipeline: async () => [], logger: silentLogger() }),
    /Missing required --config/,
  );
});

test('main passes parsed flags to the pipeline and returns 0 on success', async () => {
  let received;
  const code = await main(
    ['--config', 'repos.json', '--pr', '--repo', 'a', '--work-dir', '/tmp/x'],
    {
      loadConfig: async (p) => { assert.equal(p, 'repos.json'); return fakeConfig; },
      runPipeline: async (config, opts) => { received = opts; return [{ status: 'pushed' }]; },
      logger: silentLogger(),
    },
  );
  assert.equal(code, 0);
  assert.equal(received.pr, true);
  assert.equal(received.repoFilter, 'a');
  assert.equal(received.workDir, '/tmp/x');
  assert.equal(received.dryRun, false);
});

test('main defaults pr/dryRun to false and derives a workDir', async () => {
  let received;
  await main(['--config', 'repos.json'], {
    loadConfig: async () => fakeConfig,
    runPipeline: async (config, opts) => { received = opts; return []; },
    logger: silentLogger(),
  });
  assert.equal(received.pr, false);
  assert.equal(received.dryRun, false);
  assert.match(received.workDir, /ai-sync$/);
  assert.match(received.skillsDir, /skills$/);
});

test('main returns 1 when any repo errored', async () => {
  const code = await main(['--config', 'repos.json'], {
    loadConfig: async () => fakeConfig,
    runPipeline: async () => [{ status: 'pushed' }, { status: 'error', error: 'x' }],
    logger: silentLogger(),
  });
  assert.equal(code, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/index.test.js`
Expected: FAIL — cannot find module `../src/index.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { loadConfig as defaultLoadConfig } from './config.js';
import { run as defaultRun } from './pipeline.js';

export async function main(argv, deps = {}) {
  const {
    loadConfig = defaultLoadConfig,
    runPipeline = defaultRun,
    logger = console,
  } = deps;

  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      pr: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'work-dir': { type: 'string' },
      repo: { type: 'string' },
    },
  });

  if (!values.config) throw new Error('Missing required --config <path>');

  const config = await loadConfig(values.config);
  const results = await runPipeline(config, {
    skillsDir: path.resolve('skills'),
    workDir: values['work-dir'] ?? path.join(os.tmpdir(), 'ai-sync'),
    pr: values.pr,
    dryRun: values['dry-run'],
    repoFilter: values.repo,
    logger,
  });

  return results.some((r) => r.status === 'error') ? 1 : 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/index.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/index.js test/index.test.js
git commit -m "feat: CLI main with injectable deps"
```

---

## Task 14: Executable bootstrap, sample config, README

Wires `main` to the process. This file is outside `src/` so it is not under the coverage gate (it only reads `process.argv` and sets `process.exitCode`).

**Files:**
- Create: `bin/sync.js`
- Create: `repos.json`
- Create: `skills/.gitkeep`
- Modify: `README.md`

- [ ] **Step 1: Create `bin/sync.js`**

```javascript
#!/usr/bin/env node
import { main } from '../src/index.js';

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(err.message);
    process.exitCode = 1;
  },
);
```

- [ ] **Step 2: Create a sample `repos.json`**

```json
{
  "defaultTargets": ["claude", "copilot"],
  "repos": [
    {
      "name": "example-api",
      "url": "git@github.com:example-org/example-api.git",
      "technologies": ["nestjs", "postgres"],
      "targets": ["claude", "cursor"]
    }
  ]
}
```

- [ ] **Step 3: Create `skills/.gitkeep`** (empty file, keeps the authored-skills directory tracked)

- [ ] **Step 4: Update `README.md`**

```markdown
# ai-sync

Tools to sync AI agent skills, practices, and workflows across repositories.

Skills are authored once under `skills/<techno>/<name>/SKILL.md` and translated
into each target platform's format (Claude Code, GitHub Copilot, Cursor, Windsurf).

## Usage

```bash
node bin/sync.js --config repos.json          # clone, generate, branch, commit, push
node bin/sync.js --config repos.json --pr      # also open a PR via gh
node bin/sync.js --config repos.json --dry-run # preview generated files, no git
node bin/sync.js --config repos.json --repo example-api   # one repo only
```

## Tests

```bash
npm test   # runs all tests with a strict 100% coverage gate on src/
```
```

- [ ] **Step 5: Verify the CLI runs against the fixtures in dry-run**

Run: `node bin/sync.js --config repos.json --dry-run`
Expected: prints `[dry-run] example-api: ...` lines for the rendered files (or a warning that `skills/nestjs` is missing, since `skills/` is empty in this repo). No git operations, exit 0.

- [ ] **Step 6: Commit**

```bash
git add bin/sync.js repos.json skills/.gitkeep README.md
git commit -m "feat: executable bootstrap, sample config, and README"
```

---

## Task 15: Full coverage gate verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full suite with the coverage gate**

Run: `npm test`
Expected: all tests pass AND coverage is 100% lines/functions/branches over `src/`. Node exits non-zero if any threshold is below 1.0.

- [ ] **Step 2: If any line/branch is uncovered**

Read the coverage table's "uncovered lines" column. For each gap, either add a focused test that exercises that branch, or remove the dead code. Do not add coverage-ignore comments — the spec forbids default exclusions. Re-run `npm test` until green.

- [ ] **Step 3: Commit any added tests**

```bash
git add test
git commit -m "test: close remaining coverage gaps to 100%"
```

---

## Self-Review Notes

**Spec coverage:**
- Source-of-truth skills tree by techno → Task 10 fixtures + `skills/` dir (Task 14).
- Four target renderers (Claude/Copilot/Cursor/Windsurf) → Tasks 4–7.
- Global default targets with per-repo override → Task 9 (`targets ?? defaultTargets`).
- Deterministic format adaptation (same body) → Tasks 2, 4–7 (body passed through `buildDocument`).
- `repos.json` schema → Task 9 + sample in Task 14.
- Clone → generate → branch → commit → push, PR opt-in via `--pr` → Tasks 11–13.
- No-op skip when unchanged → Task 12 (`hasChanges`).
- Per-repo error isolation + final report + non-zero exit → Tasks 12–13.
- CLI flags `--pr`/`--dry-run`/`--work-dir`/`--repo` → Task 13.
- Strict 100% coverage gate → Task 1 (script) + Task 15 (verification).

**Type consistency:** Skill shape `{ name, description, globs?, body }` is produced by `parseSkill` (Task 3) and consumed identically by every renderer (Tasks 4–7) and the pipeline (Task 12). Repo shape `{ name, url, technologies, targets }` is produced by `parseConfig` (Task 9) and consumed by the pipeline (Task 12). Git repo object methods `checkoutBranch`/`hasChanges`/`commitAll`/`push`/`createPR` are defined in Task 11 and called with matching names in Task 12. Pipeline result `status` values (`dry-run`/`pushed`/`pr`/`skipped`/`error`) are produced in Task 12 and read by `main` (Task 13) and tests.

**No placeholders:** every code step contains full implementations and exact assertions.
