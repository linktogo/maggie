# AI Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the maggie board launch local AI coding agents (Claude Code or GitHub Copilot CLI) on the repositories of the config, through an independent Node.js server that picks the provider, with live output in a new "AI Factory" tab.

**Architecture:** `libs/agent-runner` holds the logic (providers, repo allowlist, skills, run lifecycle) with an injectable `spawn`. `apps/agents` is a dependency-free `node:http` server on top of it (bearer token, loopback, SSE). `apps/board` gains a `/factory` tab and a server-side proxy `/api/factory/*` that adds the token, so the browser never sees it. Spec: `docs/superpowers/specs/2026-10-26-ai-factory-design.md`.

**Tech Stack:** Node >= 22 (ESM, `node:test`, `node:http`), Nx + npm workspaces, Vue 3 + vue-router + vitest (board), the existing `@linktogo/maggie-retro-doc` (`providerCommand`, `parseFrontmatter`) and `@linktogo/maggie-config` (`loadConfig`).

---

## Conventions (read once)

- **Test first.** Every task: write the failing test, run it and see it fail, implement, run it and see it pass, commit.
- **Coverage gate.** `libs/agent-runner` and `apps/agents` enforce 100% lines/functions/branches on `src/**` (same gate as the other libs). The board is exempt, but still gets tests.
- **Commit format.** Conventional commits (`feat(agent-runner): ...`). Every commit message ends with the attribution trailers given in the session system-reminder (`Co-Authored-By: ...` and `Claude-Session: ...`), after a blank line.
- **Branch.** Work on `ccr-2b06c5bb-7ofepa`. Push at the end of each task group; do not open a PR unless asked.
- **Error codes.** `AgentError.code` is one of `invalid` (400), `not-found` (404), `busy` (409), `too-large` (413). Anything else is a 500.
- **Run statuses.** `running` -> `succeeded` | `failed` | `cancelled` | `timed-out`. The set `TERMINAL` holds the four final ones.
- **Run view** (what the API returns for a run): `{ id, repo, provider, model, skill, status, startedAt, finishedAt, exitCode, error }`.
- **Event shape** (manager and SSE): `{ seq, type: 'stdout'|'stderr'|'status', data, at }`. `stdout`/`stderr` data is `{ text }`; `status` data is `{ status, exitCode, error }`.
- **Windows.** `.cmd` shims are the known trap for spawned CLIs (see `.claude/skills/platform-aware-cli-commands`). Detection of providers therefore goes through the injectable `findOnPath`, and a CLI that cannot be spawned fails the run with an explicit message instead of silently falling back.

## File map

| File | Responsibility |
|---|---|
| `libs/agent-runner/package.json`, `project.json`, `README.md`, `LICENSE` | package + Nx project (coverage-gated) |
| `libs/agent-runner/src/errors.js` | `AgentError` with a `code` |
| `libs/agent-runner/src/providers.js` | provider list, `commandFor`, `findOnPath`, `detectProviders`, `resolveProvider`, `validateModel` |
| `libs/agent-runner/src/repos.js` | `createRepoResolver` (allowlist -> checkout path) |
| `libs/agent-runner/src/skills.js` | `listSkills`, `loadSkill` (validated ids) |
| `libs/agent-runner/src/prompt.js` | `buildPrompt` (prompt and/or skill -> stdin text) |
| `libs/agent-runner/src/run.js` | `createRunManager` (start/get/list/cancel/subscribe) |
| `libs/agent-runner/src/index.js` | public surface |
| `apps/agents/package.json`, `project.json`, `bin/agents.js` | package, Nx project, entry |
| `apps/agents/src/server.js` | `createAgentsServer`: guards, routes, SSE |
| `apps/agents/src/main.js` | argv, token file, wiring, shutdown |
| `apps/board/agentsProxy.js` | `/api/factory/*` -> agents server, adds the token |
| `apps/board/server.js` | route the proxy, `--agents-url`, `--agents-token-file` |
| `apps/board/src/useFactory.js`, `FactoryPage.vue` | composable + page |
| `apps/board/src/router.js`, `App.vue`, `locales/{en,fr,de,es}.js` | tab, route, strings |
| `docs/ai-factory.md`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, root `package.json`, `eslint.config.js` | wiring and docs |

---

### Task 0: Baseline

**Files:** none

- [ ] **Step 1: Install and confirm the tree is green before touching anything**

Run: `npm ci && npm test && npm run lint`
Expected: all Nx targets pass. If something is already red, stop and report it; do not fix unrelated failures inside this feature.

---

### Task 1: Scaffold `libs/agent-runner`

**Files:**
- Create: `libs/agent-runner/package.json`, `libs/agent-runner/project.json`, `libs/agent-runner/README.md`, `libs/agent-runner/LICENSE`
- Modify: `eslint.config.js` (new `scope:agents` constraint), `package-lock.json` (via npm)

- [ ] **Step 1: Create the package files**

`libs/agent-runner/package.json`:

```json
{
  "name": "@linktogo/maggie-agent-runner",
  "version": "1.3.1",
  "description": "Run local AI agent CLIs (Claude Code, GitHub Copilot) on a repository checkout, with streamed output, timeouts and cancellation.",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./src/index.js",
  "files": [
    "src",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=22"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/linktogo/maggie.git",
    "directory": "libs/agent-runner"
  },
  "homepage": "https://github.com/linktogo/maggie/tree/main/libs/agent-runner#readme",
  "bugs": {
    "url": "https://github.com/linktogo/maggie/issues"
  },
  "keywords": [
    "maggie",
    "ai-agents",
    "claude-code",
    "github-copilot",
    "developer-tools"
  ],
  "dependencies": {
    "@linktogo/maggie-retro-doc": "^1.3.1"
  },
  "publishConfig": {
    "access": "public",
    "provenance": true
  }
}
```

`libs/agent-runner/project.json`:

```json
{
  "name": "agent-runner",
  "sourceRoot": "libs/agent-runner/src",
  "projectType": "library",
  "tags": ["scope:shared", "type:lib"],
  "targets": {
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node --test --experimental-test-coverage --test-coverage-include=\"libs/agent-runner/src/**/*.js\" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 \"libs/agent-runner/test/**/*.test.js\""
      }
    }
  }
}
```

`libs/agent-runner/README.md`:

````markdown
# @linktogo/maggie-agent-runner

Run local AI agent CLIs on a repository checkout for [maggie](https://github.com/linktogo/maggie)'s
AI Factory. No HTTP in here: this is the logic the `maggie-agents` server wraps.

```js
import { buildPrompt, createRunManager, listSkills } from '@linktogo/maggie-agent-runner';

const manager = createRunManager({ timeoutMs: 10 * 60_000 });
const run = manager.start({ repo: 'api', cwd: '/home/me/wk/api', provider: 'claude-cli', prompt: 'fix the failing test' });
manager.subscribe(run.id, (event) => console.log(event.type, event.data));
```

Providers: `claude-cli` (`claude -p`) and `copilot` (`copilot --allow-all-tools`). The prompt goes
in on stdin. `spawn` is injectable, so tests never launch a real CLI.
````

Copy the license: `cp libs/retro-doc/LICENSE libs/agent-runner/LICENSE`

- [ ] **Step 2: Add the `scope:agents` constraint**

In `eslint.config.js`, inside `depConstraints`, after the `scope:workspace` line add:

```js
            { sourceTag: 'scope:agents', onlyDependOnLibsWithTags: ['scope:shared', 'scope:agents'] },
```

- [ ] **Step 3: Link the workspace**

Run: `npm install`
Expected: `package-lock.json` gains an entry for `libs/agent-runner` and `node_modules/@linktogo/maggie-agent-runner` links to it. `git diff --stat package-lock.json` shows only additions for the new package.

- [ ] **Step 4: Commit**

```bash
git add libs/agent-runner eslint.config.js package-lock.json
git commit -m "chore(agent-runner): scaffold the library"
```

---

### Task 2: Errors and providers

**Files:**
- Create: `libs/agent-runner/src/errors.js`, `libs/agent-runner/src/providers.js`
- Test: `libs/agent-runner/test/errors.test.js`, `libs/agent-runner/test/providers.test.js`

- [ ] **Step 1: Write the failing tests**

`libs/agent-runner/test/errors.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentError } from '../src/errors.js';

test('AgentError carries a machine-readable code next to its message', () => {
  const err = new AgentError('busy', 'a run is already active on api');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'AgentError');
  assert.equal(err.code, 'busy');
  assert.equal(err.message, 'a run is already active on api');
});
```

`libs/agent-runner/test/providers.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AgentError } from '../src/errors.js';
import {
  AGENT_PROVIDERS, DEFAULT_AGENT_PROVIDER, commandFor, detectProviders, findOnPath, resolveProvider, validateModel,
} from '../src/providers.js';

test('two CLI providers are offered, Claude Code first', () => {
  assert.deepEqual(AGENT_PROVIDERS, ['claude-cli', 'copilot']);
  assert.equal(DEFAULT_AGENT_PROVIDER, 'claude-cli');
});

test('commandFor builds the CLI invocation, the prompt travelling on stdin', () => {
  assert.deepEqual(commandFor('claude-cli'), { command: 'claude', args: ['-p'] });
  assert.deepEqual(commandFor('claude-cli', 'sonnet'), { command: 'claude', args: ['-p', '--model', 'sonnet'] });
  assert.deepEqual(commandFor('copilot'), { command: 'copilot', args: ['--allow-all-tools'] });
});

test('findOnPath returns the first PATH entry holding an executable', () => {
  const access = (file) => { if (file !== path.join('/b', 'claude')) throw new Error('ENOENT'); };
  assert.equal(findOnPath('claude', { env: { PATH: '/a:/b' }, platform: 'linux', access }), path.join('/b', 'claude'));
});

test('findOnPath returns null when nothing matches or PATH is unset', () => {
  const access = () => { throw new Error('ENOENT'); };
  assert.equal(findOnPath('claude', { env: { PATH: '/a:/b' }, platform: 'linux', access }), null);
  assert.equal(findOnPath('claude', { env: {}, platform: 'linux', access }), null);
});

test('findOnPath tries the PATHEXT extensions on Windows', () => {
  const access = (file) => { if (!file.endsWith('claude.CMD')) throw new Error('ENOENT'); };
  const found = findOnPath('claude', { env: { PATH: 'C:\\a;C:\\b', PATHEXT: '.EXE;.CMD' }, platform: 'win32', access });
  assert.ok(found.endsWith('claude.CMD'));
});

test('findOnPath falls back to .EXE and .CMD when PATHEXT is unset on Windows', () => {
  const access = (file) => { if (!file.endsWith('claude.EXE')) throw new Error('ENOENT'); };
  const found = findOnPath('claude', { env: { PATH: 'C:\\a' }, platform: 'win32', access });
  assert.ok(found.endsWith('claude.EXE'));
});

test('findOnPath checks the real file system by default', () => {
  const found = findOnPath(path.parse(process.execPath).name, {
    env: { PATH: path.dirname(process.execPath), PATHEXT: path.extname(process.execPath) },
  });
  assert.notEqual(found, null);
});

test('detectProviders lists the providers whose CLI is installed', () => {
  const access = (file) => { if (!file.endsWith(`${path.sep}copilot`)) throw new Error('ENOENT'); };
  assert.deepEqual(detectProviders({ env: { PATH: '/bin' }, platform: 'linux', access }), ['copilot']);
});

test('detectProviders reads the real environment by default', () => {
  assert.ok(Array.isArray(detectProviders()));
});

test('resolveProvider prefers the requested provider, then the fallback', () => {
  assert.equal(resolveProvider({ requested: 'copilot', fallback: 'claude-cli' }), 'copilot');
  assert.equal(resolveProvider({ requested: undefined, fallback: 'claude-cli' }), 'claude-cli');
  assert.equal(resolveProvider({ requested: null, fallback: 'copilot' }), 'copilot');
});

test('resolveProvider refuses anything that is not a CLI provider', () => {
  assert.throws(() => resolveProvider({ requested: 'claude', fallback: 'claude-cli' }), (err) => {
    assert.ok(err instanceof AgentError);
    assert.equal(err.code, 'invalid');
    assert.match(err.message, /unknown provider: claude/);
    return true;
  });
});

test('validateModel accepts an identifier and nothing that could read as an option', () => {
  assert.equal(validateModel(undefined), null);
  assert.equal(validateModel(null), null);
  assert.equal(validateModel('claude-opus-5'), 'claude-opus-5');
  for (const bad of ['--allow-all-tools', '', 42, 'a b']) {
    assert.throws(() => validateModel(bad), (err) => err instanceof AgentError && err.code === 'invalid');
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test libs/agent-runner/test/errors.test.js libs/agent-runner/test/providers.test.js`
Expected: FAIL with `Cannot find module '../src/errors.js'`.

- [ ] **Step 3: Implement**

`libs/agent-runner/src/errors.js`:

```js
/** A refusal the caller can act on; `code` maps to an HTTP status in the server. */
export class AgentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}
```

`libs/agent-runner/src/providers.js`:

```js
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { providerCommand } from '@linktogo/maggie-retro-doc';
import { AgentError } from './errors.js';

export const AGENT_PROVIDERS = ['claude-cli', 'copilot'];

export const DEFAULT_AGENT_PROVIDER = AGENT_PROVIDERS[0];

// The model ends up as a CLI argument (`--model <model>`): only an identifier is
// accepted, never something that could read as another option.
const MODEL_PATTERN = /^[A-Za-z0-9][\w.:/-]*$/;

/** How a provider is invoked; the prompt goes in on stdin. */
export function commandFor(provider, model = null) {
  return providerCommand(provider, { model });
}

/** The first PATH entry holding `command` (with PATHEXT on Windows), or null. */
export function findOnPath(command, { env = process.env, platform = process.platform, access = accessSync } = {}) {
  const windows = platform === 'win32';
  const extensions = windows ? ['', ...(env.PATHEXT ?? '.EXE;.CMD').split(';').filter(Boolean)] : [''];
  for (const dir of (env.PATH ?? '').split(windows ? ';' : ':').filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension);
      try {
        access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here, keep looking
      }
    }
  }
  return null;
}

/** The providers whose CLI is installed on this machine. */
export function detectProviders(options = {}) {
  return AGENT_PROVIDERS.filter((provider) => findOnPath(commandFor(provider).command, options) !== null);
}

export function resolveProvider({ requested, fallback }) {
  const provider = requested ?? fallback;
  if (!AGENT_PROVIDERS.includes(provider)) {
    throw new AgentError('invalid', `unknown provider: ${String(provider)}`);
  }
  return provider;
}

export function validateModel(model) {
  if (model === undefined || model === null) return null;
  if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
    throw new AgentError('invalid', `invalid model: ${String(model)}`);
  }
  return model;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test libs/agent-runner/test/errors.test.js libs/agent-runner/test/providers.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add libs/agent-runner/src/errors.js libs/agent-runner/src/providers.js libs/agent-runner/test
git commit -m "feat(agent-runner): providers, detection and model validation"
```

---

### Task 3: Repo allowlist, skills, prompt

**Files:**
- Create: `libs/agent-runner/src/repos.js`, `libs/agent-runner/src/skills.js`, `libs/agent-runner/src/prompt.js`
- Test: `libs/agent-runner/test/repos.test.js`, `skills.test.js`, `prompt.test.js`

- [ ] **Step 1: Write the failing tests**

`libs/agent-runner/test/repos.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRepoResolver } from '../src/repos.js';

const repos = [{ name: 'api' }, { name: 'pinned', path: '/abs/pinned' }, { name: 'ghost' }];
const exists = (dir) => dir !== path.join('/ws', 'ghost');

test('names lists the allowlisted repositories', () => {
  assert.deepEqual(createRepoResolver({ repos, workspace: '/ws', exists }).names(), ['api', 'pinned', 'ghost']);
});

test('a repository resolves to its pinned path, else to <workspace>/<name>', () => {
  const resolver = createRepoResolver({ repos, workspace: '/ws', exists });
  assert.equal(resolver.resolve('api'), path.join('/ws', 'api'));
  assert.equal(resolver.resolve('pinned'), path.resolve('/abs/pinned'));
});

test('a repository outside the allowlist is refused, however it is spelled', () => {
  const resolver = createRepoResolver({ repos, workspace: '/ws', exists });
  for (const name of ['nope', '../etc', '/etc/passwd']) {
    assert.throws(() => resolver.resolve(name), (err) => err.code === 'not-found' && /unknown repository/.test(err.message));
  }
});

test('an allowlisted repository that is not checked out is reported as such', () => {
  const resolver = createRepoResolver({ repos, workspace: '/ws', exists });
  assert.throws(() => resolver.resolve('ghost'), (err) => err.code === 'not-found' && /not checked out/.test(err.message));
});

test('the checkout is looked up on disk by default', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agent-repos-'));
  await mkdir(path.join(workspace, 'api'));
  const resolver = createRepoResolver({ repos: [{ name: 'api' }, { name: 'web' }], workspace });
  assert.equal(resolver.resolve('api'), path.join(workspace, 'api'));
  assert.throws(() => resolver.resolve('web'), /not checked out/);
  await rm(workspace, { recursive: true, force: true });
});
```

`libs/agent-runner/test/skills.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listSkills, loadSkill } from '../src/skills.js';

let skillsDir;
let brokenDir;

before(async () => {
  skillsDir = await mkdtemp(path.join(tmpdir(), 'agent-skills-'));
  await mkdir(path.join(skillsDir, 'nx', 'monorepo'), { recursive: true });
  await writeFile(
    path.join(skillsDir, 'nx', 'monorepo', 'SKILL.md'),
    '---\nname: nx-monorepo\ndescription: Keep an Nx workspace tidy\n---\n\n# Nx\n\nUse affected.\n',
  );
  await mkdir(path.join(skillsDir, 'vuejs', 'composition'), { recursive: true });
  await writeFile(path.join(skillsDir, 'vuejs', 'composition', 'SKILL.md'), 'No frontmatter here.\n');
  await mkdir(path.join(skillsDir, 'vuejs', 'draft'), { recursive: true });
  await writeFile(path.join(skillsDir, 'vuejs', 'notes.txt'), 'not a skill');
  await writeFile(path.join(skillsDir, 'README.md'), 'not a techno');
  await mkdir(path.join(skillsDir, 'vuejs', 'unterminated'), { recursive: true });
  await writeFile(path.join(skillsDir, 'vuejs', 'unterminated', 'SKILL.md'), '---\nname: x\nnever closed\n');

  brokenDir = await mkdtemp(path.join(tmpdir(), 'agent-skills-broken-'));
  await mkdir(path.join(brokenDir, 'vuejs', 'broken', 'SKILL.md'), { recursive: true }); // a directory, so reading it fails with EISDIR
});

after(async () => {
  await rm(skillsDir, { recursive: true, force: true });
  await rm(brokenDir, { recursive: true, force: true });
});

test('listSkills walks <techno>/<name>/SKILL.md, sorted, skipping what is not a skill', () => {
  assert.deepEqual(listSkills(skillsDir), [
    { id: 'nx/monorepo', techno: 'nx', name: 'monorepo', description: 'Keep an Nx workspace tidy' },
    { id: 'vuejs/composition', techno: 'vuejs', name: 'composition', description: '' },
    { id: 'vuejs/unterminated', techno: 'vuejs', name: 'unterminated', description: '' },
  ]);
});

test('listSkills does not swallow a real read error', () => {
  assert.throws(() => listSkills(brokenDir), (err) => err.code === 'EISDIR');
});

test('loadSkill returns the body without its frontmatter', () => {
  assert.deepEqual(loadSkill(skillsDir, 'nx/monorepo'), { id: 'nx/monorepo', body: '# Nx\n\nUse affected.' });
});

test('loadSkill keeps a file with no (or unterminated) frontmatter whole', () => {
  assert.equal(loadSkill(skillsDir, 'vuejs/composition').body, 'No frontmatter here.');
  assert.match(loadSkill(skillsDir, 'vuejs/unterminated').body, /never closed/);
});

test('loadSkill refuses ids that are not <techno>/<name>', () => {
  for (const bad of ['../etc/passwd', 'nx', 'nx/monorepo/extra', '/abs/path', 'nx/..', '', 42, undefined]) {
    assert.throws(() => loadSkill(skillsDir, bad), (err) => err.code === 'invalid');
  }
});

test('loadSkill reports an unknown skill, and rethrows a real read error', () => {
  assert.throws(() => loadSkill(skillsDir, 'nx/absent'), (err) => err.code === 'not-found' && /unknown skill: nx\/absent/.test(err.message));
  assert.throws(() => loadSkill(brokenDir, 'vuejs/broken'), (err) => err.code === 'EISDIR');
});
```

`libs/agent-runner/test/prompt.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PROMPT_CHARS, buildPrompt } from '../src/prompt.js';

const skill = { id: 'nx/monorepo', body: 'Use affected.' };

test('a free prompt goes in as written, trimmed', () => {
  assert.equal(buildPrompt({ prompt: '  fix the bug \n' }), 'fix the bug');
});

test('a skill alone becomes an instruction to apply it', () => {
  assert.equal(
    buildPrompt({ skill }),
    'Apply the following skill to this repository.\n\nUse affected.',
  );
});

test('a skill plus a prompt keeps both, the prompt as the task', () => {
  assert.equal(
    buildPrompt({ prompt: 'only in libs/', skill }),
    'Apply the following skill to this repository.\n\nUse affected.\n\n---\n\nTask:\nonly in libs/',
  );
});

test('a run needs a prompt or a skill', () => {
  for (const input of [{}, { prompt: '   ' }, { prompt: null }]) {
    assert.throws(() => buildPrompt(input), (err) => err.code === 'invalid' && /prompt or a skill/.test(err.message));
  }
});

test('the prompt must be a string of reasonable size', () => {
  assert.throws(() => buildPrompt({ prompt: 42 }), (err) => err.code === 'invalid' && /must be a string/.test(err.message));
  assert.throws(() => buildPrompt({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }), (err) => err.code === 'invalid' && /too long/.test(err.message));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test libs/agent-runner/test/repos.test.js libs/agent-runner/test/skills.test.js libs/agent-runner/test/prompt.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement**

`libs/agent-runner/src/repos.js`:

```js
import { existsSync } from 'node:fs';
import path from 'node:path';
import { AgentError } from './errors.js';

/**
 * The repositories an agent may run in. Clients send a name, never a path: a
 * name maps to `repo.path` when the config pins one, otherwise to
 * `<workspace>/<name>` (the same rule as the workspace CLI).
 */
export function createRepoResolver({ repos, workspace, exists = existsSync }) {
  const byName = new Map(repos.map((repo) => [repo.name, repo]));
  return {
    names: () => [...byName.keys()],
    resolve(name) {
      const repo = byName.get(name);
      if (!repo) throw new AgentError('not-found', `unknown repository: ${String(name)}`);
      const dir = repo.path ? path.resolve(repo.path) : path.join(workspace, repo.name);
      if (!exists(dir)) throw new AgentError('not-found', `${repo.name} is not checked out at ${dir}`);
      return dir;
    },
  };
}
```

`libs/agent-runner/src/skills.js`:

```js
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '@linktogo/maggie-retro-doc';
import { AgentError } from './errors.js';

// <techno>/<name>: two plain segments, so an id can never climb out of the skills directory.
const SKILL_ID = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

function readSkillFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function stripFrontmatter(text) {
  if (!text.startsWith('---\n')) return text.trim();
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text.trim();
  return text.slice(end + 4).trim();
}

export function listSkills(skillsDir) {
  const skills = [];
  for (const techno of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!techno.isDirectory()) continue;
    for (const entry of readdirSync(path.join(skillsDir, techno.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const text = readSkillFile(path.join(skillsDir, techno.name, entry.name, 'SKILL.md'));
      if (text === null) continue;
      skills.push({
        id: `${techno.name}/${entry.name}`,
        techno: techno.name,
        name: entry.name,
        description: parseFrontmatter(text).description ?? '',
      });
    }
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

export function loadSkill(skillsDir, id) {
  if (typeof id !== 'string' || !SKILL_ID.test(id)) {
    throw new AgentError('invalid', `invalid skill: ${String(id)}`);
  }
  const text = readSkillFile(path.join(skillsDir, ...id.split('/'), 'SKILL.md'));
  if (text === null) throw new AgentError('not-found', `unknown skill: ${id}`);
  return { id, body: stripFrontmatter(text) };
}
```

`libs/agent-runner/src/prompt.js`:

```js
import { AgentError } from './errors.js';

export const MAX_PROMPT_CHARS = 100_000;

/** The text written to the agent's stdin: a free prompt, a skill, or a skill applied to a task. */
export function buildPrompt({ prompt, skill = null }) {
  if (prompt !== undefined && prompt !== null && typeof prompt !== 'string') {
    throw new AgentError('invalid', 'prompt must be a string');
  }
  const task = (prompt ?? '').trim();
  if (task.length > MAX_PROMPT_CHARS) {
    throw new AgentError('invalid', `prompt is too long (max ${MAX_PROMPT_CHARS} characters)`);
  }
  if (!skill && !task) throw new AgentError('invalid', 'a prompt or a skill is required');
  if (!skill) return task;
  const head = `Apply the following skill to this repository.\n\n${skill.body}`;
  return task ? `${head}\n\n---\n\nTask:\n${task}` : head;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test libs/agent-runner/test/repos.test.js libs/agent-runner/test/skills.test.js libs/agent-runner/test/prompt.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/agent-runner/src libs/agent-runner/test
git commit -m "feat(agent-runner): repo allowlist, skills and prompt building"
```

---

### Task 4: Run manager

**Files:**
- Create: `libs/agent-runner/src/run.js`
- Test: `libs/agent-runner/test/run.test.js`

- [ ] **Step 1: Write the failing tests**

`libs/agent-runner/test/run.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRunManager } from '../src/run.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on() {}, end(data) { child.input = data; } };
  child.kill = (signal) => { child.killed = signal; };
  return child;
}

function harness(options = {}) {
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = fakeChild();
    calls.push({ command, args, opts, child });
    return child;
  };
  const manager = createRunManager({ spawn, now: () => new Date('2026-10-26T10:00:00.000Z'), ...options });
  return { manager, calls };
}

const START = { repo: 'api', cwd: '/ws/api', provider: 'claude-cli', prompt: 'fix the bug' };

test('start spawns the provider CLI in the checkout and writes the prompt to its stdin', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  assert.equal(calls[0].command, 'claude');
  assert.deepEqual(calls[0].args, ['-p']);
  assert.equal(calls[0].opts.cwd, '/ws/api');
  assert.equal(calls[0].child.input, 'fix the bug');
  assert.deepEqual(run, {
    id: 'run-1', repo: 'api', provider: 'claude-cli', model: null, skill: null, status: 'running',
    startedAt: '2026-10-26T10:00:00.000Z', finishedAt: null, exitCode: null, error: null,
  });
});

test('start passes the model and uses the Copilot CLI for the copilot provider', () => {
  const { manager, calls } = harness();
  manager.start({ ...START, repo: 'a', model: 'sonnet' });
  manager.start({ ...START, repo: 'b', provider: 'copilot' });
  assert.deepEqual(calls[0].args, ['-p', '--model', 'sonnet']);
  assert.equal(calls[1].command, 'copilot');
  assert.deepEqual(calls[1].args, ['--allow-all-tools']);
});

test('start with a skill records it and sends the skill as the instruction', () => {
  const { manager, calls } = harness();
  const run = manager.start({ ...START, prompt: undefined, skill: { id: 'nx/monorepo', body: 'Use affected.' } });
  assert.equal(run.skill, 'nx/monorepo');
  assert.match(calls[0].child.input, /^Apply the following skill/);
  assert.match(calls[0].child.input, /Use affected\./);
});

test('start refuses a bad model or an empty request before spawning anything', () => {
  const { manager, calls } = harness();
  assert.throws(() => manager.start({ ...START, model: '--evil' }), (err) => err.code === 'invalid');
  assert.throws(() => manager.start({ ...START, prompt: '' }), (err) => err.code === 'invalid');
  assert.equal(calls.length, 0);
});

test('one active run per repository; a finished one frees it', () => {
  const { manager, calls } = harness();
  manager.start(START);
  assert.throws(() => manager.start(START), (err) => err.code === 'busy' && /already active on api/.test(err.message));
  assert.doesNotThrow(() => manager.start({ ...START, repo: 'web' }));
  calls[0].child.emit('close', 0);
  assert.doesNotThrow(() => manager.start(START));
});

test('output is published as events, and the run ends succeeded on exit code 0', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  const seen = [];
  manager.subscribe(run.id, (event) => seen.push(event));
  const { child } = calls[0];
  child.stdout.emit('data', Buffer.from('hello'));
  child.stderr.emit('data', 'warn');
  child.emit('close', 0);

  assert.deepEqual(seen.map((e) => [e.seq, e.type]), [[1, 'status'], [2, 'stdout'], [3, 'stderr'], [4, 'status']]);
  assert.deepEqual(seen[1].data, { text: 'hello' });
  assert.deepEqual(seen[3].data, { status: 'succeeded', exitCode: 0, error: null });
  assert.equal(seen[3].at, '2026-10-26T10:00:00.000Z');
  assert.deepEqual(
    [manager.get(run.id).status, manager.get(run.id).exitCode, manager.get(run.id).finishedAt],
    ['succeeded', 0, '2026-10-26T10:00:00.000Z'],
  );
});

test('a late subscriber gets the history replayed, then live events until it unsubscribes', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  calls[0].child.stdout.emit('data', 'early');
  const seen = [];
  const unsubscribe = manager.subscribe(run.id, (event) => seen.push(event.type));
  assert.deepEqual(seen, ['status', 'stdout']);
  calls[0].child.stdout.emit('data', 'live');
  unsubscribe();
  calls[0].child.stdout.emit('data', 'ignored');
  assert.deepEqual(seen, ['status', 'stdout', 'stdout']);
});

test('subscribe to an unknown run returns null', () => {
  assert.equal(harness().manager.subscribe('run-99', () => {}), null);
});

test('a non-zero exit fails the run, with the exit code in the message', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  calls[0].child.emit('close', 2);
  assert.deepEqual(
    [manager.get(run.id).status, manager.get(run.id).exitCode, manager.get(run.id).error],
    ['failed', 2, '`claude` exited with code 2'],
  );
});

test('a CLI killed by a signal fails the run with an unknown exit code', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  calls[0].child.emit('close', null);
  assert.equal(manager.get(run.id).error, '`claude` exited with code unknown');
});

test('a CLI that cannot be started fails the run with an explicit message, once', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  calls[0].child.emit('error', new Error('spawn claude ENOENT'));
  calls[0].child.emit('close', -2);
  assert.equal(manager.get(run.id).status, 'failed');
  assert.equal(manager.get(run.id).error, 'Could not run `claude`: spawn claude ENOENT');
  assert.equal(manager.get(run.id).exitCode, null);
});

test('a spawn that throws fails the run instead of leaving the repository locked', () => {
  const manager = createRunManager({ spawn: () => { throw new Error('bad cwd'); } });
  const run = manager.start(START);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'Could not run `claude`: bad cwd');
  assert.doesNotThrow(() => manager.start(START));
});

test('cancel asks the CLI to stop; the run is cancelled once it has exited', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  assert.equal(manager.cancel(run.id).status, 'running');
  assert.equal(calls[0].child.killed, 'SIGTERM');
  calls[0].child.emit('close', null);
  assert.equal(manager.get(run.id).status, 'cancelled');
});

test('cancel of an unknown run is refused; of a finished one it is a no-op', () => {
  const { manager, calls } = harness();
  assert.throws(() => manager.cancel('run-99'), (err) => err.code === 'not-found');
  const run = manager.start(START);
  calls[0].child.emit('close', 0);
  assert.equal(manager.cancel(run.id).status, 'succeeded');
  assert.equal(calls[0].child.killed, undefined);
});

test('a run that exceeds the timeout is killed and ends timed-out', async () => {
  const { manager, calls } = harness({ timeoutMs: 20 });
  const run = manager.start(START);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls[0].child.killed, 'SIGTERM');
  calls[0].child.emit('close', null);
  assert.equal(manager.get(run.id).status, 'timed-out');
  assert.match(manager.get(run.id).error, /timed out after/);
});

test('only the most recent events are kept, sequence numbers keep counting', () => {
  const { manager, calls } = harness({ maxEvents: 3 });
  const run = manager.start(START);
  for (const text of ['a', 'b', 'c', 'd', 'e']) calls[0].child.stdout.emit('data', text);
  const seqs = [];
  manager.subscribe(run.id, (event) => seqs.push(event.seq));
  assert.deepEqual(seqs, [4, 5, 6]);
});

test('finished runs are pruned oldest first once maxRuns is exceeded', () => {
  const { manager, calls } = harness({ maxRuns: 2 });
  manager.start({ ...START, repo: 'a' });
  calls[0].child.emit('close', 0);
  manager.start({ ...START, repo: 'b' });
  calls[1].child.emit('close', 0);
  manager.start({ ...START, repo: 'c' });
  assert.deepEqual(manager.list().map((r) => r.id), ['run-3', 'run-2']);
});

test('active runs are never pruned', () => {
  const { manager } = harness({ maxRuns: 1 });
  manager.start({ ...START, repo: 'a' });
  manager.start({ ...START, repo: 'b' });
  assert.equal(manager.list().length, 2);
});

test('list is newest first and get returns null for an unknown run', () => {
  const { manager } = harness();
  manager.start({ ...START, repo: 'a' });
  manager.start({ ...START, repo: 'b' });
  assert.deepEqual(manager.list().map((r) => r.id), ['run-2', 'run-1']);
  assert.equal(manager.get('run-99'), null);
});

test('the real child_process.spawn is used by default', async () => {
  // An empty PATH makes `claude` unspawnable: hermetic, and it proves the ENOENT message end to end.
  const savedPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const manager = createRunManager({ timeoutMs: 5000 });
    const run = manager.start({ repo: 'x', cwd: process.cwd(), provider: 'claude-cli', prompt: 'hi' });
    await new Promise((resolve) => {
      const check = () => (manager.get(run.id).status === 'running' ? setTimeout(check, 20) : resolve());
      check();
    });
    assert.equal(manager.get(run.id).status, 'failed');
    assert.match(manager.get(run.id).error, /Could not run `claude`/);
  } finally {
    process.env.PATH = savedPath;
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test libs/agent-runner/test/run.test.js`
Expected: FAIL with `Cannot find module '../src/run.js'`.

- [ ] **Step 3: Implement**

`libs/agent-runner/src/run.js`:

```js
import { spawn as nodeSpawn } from 'node:child_process';
import { AgentError } from './errors.js';
import { buildPrompt } from './prompt.js';
import { commandFor, validateModel } from './providers.js';

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed-out']);
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_EVENTS = 2000;
export const DEFAULT_MAX_RUNS = 100;

const view = (record) => ({
  id: record.id,
  repo: record.repo,
  provider: record.provider,
  model: record.model,
  skill: record.skill,
  status: record.status,
  startedAt: record.startedAt,
  finishedAt: record.finishedAt,
  exitCode: record.exitCode,
  error: record.error,
});

/**
 * Runs agent CLIs one at a time per repository and publishes what they print.
 * Runs live in memory only: `maxEvents` bounds the output kept per run and
 * `maxRuns` the number of runs, finished ones going first.
 */
export function createRunManager({
  spawn = nodeSpawn,
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxEvents = DEFAULT_MAX_EVENTS,
  maxRuns = DEFAULT_MAX_RUNS,
} = {}) {
  const runs = new Map();
  let counter = 0;

  function emit(record, type, data) {
    record.seq += 1;
    const event = { seq: record.seq, type, data, at: now().toISOString() };
    record.events.push(event);
    if (record.events.length > maxEvents) record.events.shift();
    for (const listener of [...record.listeners]) listener(event);
  }

  // Idempotent: a spawn failure fires both `error` and `close`, only the first counts.
  function finish(record, status, { exitCode = null, error = null } = {}) {
    if (TERMINAL.has(record.status)) return;
    clearTimeout(record.timer);
    record.status = status;
    record.exitCode = exitCode;
    record.error = error;
    record.finishedAt = now().toISOString();
    emit(record, 'status', { status, exitCode, error });
  }

  function prune() {
    for (const [id, record] of runs) {
      if (runs.size <= maxRuns) return;
      if (TERMINAL.has(record.status)) runs.delete(id);
    }
  }

  function start({ repo, cwd, provider, model = null, prompt, skill = null }) {
    const input = buildPrompt({ prompt, skill });
    const checkedModel = validateModel(model);
    if ([...runs.values()].some((record) => record.repo === repo && !TERMINAL.has(record.status))) {
      throw new AgentError('busy', `a run is already active on ${repo}`);
    }
    const { command, args } = commandFor(provider, checkedModel);

    counter += 1;
    const record = {
      id: `run-${counter}`,
      repo,
      provider,
      model: checkedModel,
      skill: skill ? skill.id : null,
      status: 'running',
      startedAt: now().toISOString(),
      finishedAt: null,
      exitCode: null,
      error: null,
      events: [],
      listeners: new Set(),
      seq: 0,
      child: null,
      timer: null,
      cancelRequested: false,
      timedOut: false,
    };
    runs.set(record.id, record);
    prune();
    emit(record, 'status', { status: 'running', exitCode: null, error: null });

    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      finish(record, 'failed', { error: `Could not run \`${command}\`: ${err.message}` });
      return view(record);
    }
    record.child = child;
    record.timer = setTimeout(() => {
      record.timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    record.timer.unref();

    child.stdout.on('data', (chunk) => emit(record, 'stdout', { text: String(chunk) }));
    child.stderr.on('data', (chunk) => emit(record, 'stderr', { text: String(chunk) }));
    child.on('error', (err) => finish(record, 'failed', { error: `Could not run \`${command}\`: ${err.message}` }));
    child.on('close', (code) => {
      if (record.cancelRequested) return finish(record, 'cancelled', { exitCode: code });
      if (record.timedOut) {
        return finish(record, 'timed-out', { exitCode: code, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
      }
      if (code === 0) return finish(record, 'succeeded', { exitCode: 0 });
      return finish(record, 'failed', { exitCode: code, error: `\`${command}\` exited with code ${code ?? 'unknown'}` });
    });
    // The CLI may exit before reading its prompt; the resulting EPIPE is the exit code's business.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    return view(record);
  }

  function cancel(id) {
    const record = runs.get(id);
    if (!record) throw new AgentError('not-found', `unknown run: ${id}`);
    if (TERMINAL.has(record.status)) return view(record);
    record.cancelRequested = true;
    record.child.kill('SIGTERM');
    return view(record);
  }

  function get(id) {
    const record = runs.get(id);
    return record ? view(record) : null;
  }

  const list = () => [...runs.values()].map(view).reverse();

  /** Replays the kept history, then delivers live events. Returns an unsubscribe, or null for an unknown run. */
  function subscribe(id, listener) {
    const record = runs.get(id);
    if (!record) return null;
    for (const event of [...record.events]) listener(event);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  return { start, cancel, get, list, subscribe };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test libs/agent-runner/test/run.test.js`
Expected: PASS (20 tests).

- [ ] **Step 5: Public surface, full gate, commit**

`libs/agent-runner/src/index.js`:

```js
// Public surface of @linktogo/maggie-agent-runner.
export { AgentError } from './errors.js';
export {
  AGENT_PROVIDERS, DEFAULT_AGENT_PROVIDER, commandFor, detectProviders, findOnPath, resolveProvider, validateModel,
} from './providers.js';
export { createRepoResolver } from './repos.js';
export { listSkills, loadSkill } from './skills.js';
export { MAX_PROMPT_CHARS, buildPrompt } from './prompt.js';
export {
  DEFAULT_MAX_EVENTS, DEFAULT_MAX_RUNS, DEFAULT_TIMEOUT_MS, TERMINAL, createRunManager,
} from './run.js';
```

`libs/agent-runner/test/index.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/index.js';

test('the public surface is exactly what the server and the board rely on', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'AGENT_PROVIDERS', 'AgentError', 'DEFAULT_AGENT_PROVIDER', 'DEFAULT_MAX_EVENTS', 'DEFAULT_MAX_RUNS',
    'DEFAULT_TIMEOUT_MS', 'MAX_PROMPT_CHARS', 'TERMINAL', 'buildPrompt', 'commandFor', 'createRepoResolver',
    'createRunManager', 'detectProviders', 'findOnPath', 'listSkills', 'loadSkill', 'resolveProvider', 'validateModel',
  ]);
});
```

Run: `npx nx run agent-runner:test`
Expected: PASS and the coverage table shows 100% for lines, branches and functions on every `src/` file. If a line is uncovered, add the missing test; do not lower the thresholds.

```bash
git add libs/agent-runner
git commit -m "feat(agent-runner): run manager with streaming, cancel and timeout"
git push -u origin ccr-2b06c5bb-7ofepa
```

---

### Task 5: `apps/agents` server (guards and routes)

**Files:**
- Create: `apps/agents/package.json`, `apps/agents/project.json`, `apps/agents/src/server.js`
- Test: `apps/agents/test/server.test.js`

- [ ] **Step 1: Scaffold the app**

`apps/agents/package.json`:

```json
{
  "name": "@maggie/agents",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "maggie-agents": "./bin/agents.js"
  },
  "dependencies": {
    "@linktogo/maggie-agent-runner": "^1.3.1",
    "@linktogo/maggie-config": "^1.3.1"
  }
}
```

`apps/agents/project.json`:

```json
{
  "name": "agents",
  "sourceRoot": "apps/agents/src",
  "projectType": "application",
  "tags": ["scope:agents", "type:app"],
  "targets": {
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node --test --experimental-test-coverage --test-coverage-include=\"apps/agents/src/**/*.js\" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 \"apps/agents/test/**/*.test.js\""
      }
    }
  }
}
```

Run: `npm install` (links `@maggie/agents`; `package-lock.json` gains the workspace).

- [ ] **Step 2: Write the failing tests**

`apps/agents/test/server.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRepoResolver, createRunManager } from '@linktogo/maggie-agent-runner';
import { createAgentsServer, isAuthorized, isLoopbackHost } from '../src/server.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on() {}, end(data) { child.input = data; } };
  child.kill = (signal) => { child.killed = signal; };
  return child;
}

const post = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function boot(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agents-server-'));
  const skillsDir = path.join(dir, 'skills');
  await mkdir(path.join(skillsDir, 'nx', 'monorepo'), { recursive: true });
  await writeFile(path.join(skillsDir, 'nx', 'monorepo', 'SKILL.md'), '---\nname: nx-monorepo\ndescription: Keep Nx tidy\n---\n\nUse affected.\n');
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = fakeChild();
    calls.push({ command, args, opts, child });
    return child;
  };
  const manager = options.manager ?? createRunManager({ spawn });
  const repos = createRepoResolver({ repos: [{ name: 'api' }, { name: 'web' }], workspace: dir, exists: () => true });
  const server = createAgentsServer({
    token: 'secret-token',
    manager,
    repos,
    skillsDir,
    providers: { detect: () => ['claude-cli'], defaultProvider: 'claude-cli' },
    ...options.server,
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (route, init = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
    ...init,
    headers: { authorization: 'Bearer secret-token', ...(init.headers ?? {}) },
  });
  return { call, calls, dir, port, manager };
}

test('isLoopbackHost only accepts loopback names', () => {
  for (const ok of ['localhost:4318', '127.0.0.1:4318', '[::1]:4318', 'localhost']) assert.equal(isLoopbackHost(ok), true, ok);
  for (const bad of ['evil.example', 'evil.example:4318', '127.0.0.1.evil.example', undefined, '', 'a b']) assert.equal(isLoopbackHost(bad), false, String(bad));
});

test('isAuthorized wants the exact bearer token', () => {
  assert.equal(isAuthorized('Bearer secret-token', 'secret-token'), true);
  assert.equal(isAuthorized(undefined, 'secret-token'), false);
  assert.equal(isAuthorized('Basic secret-token', 'secret-token'), false);
  assert.equal(isAuthorized('Bearer secret-tokeX', 'secret-token'), false);
  assert.equal(isAuthorized('Bearer short', 'secret-token'), false);
});

test('a request without the token is refused with 401', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('/health', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const bare = await fetch(`http://127.0.0.1:${(await boot(t)).port}/health`);
  assert.equal(bare.status, 401);
});

test('a request addressed to a non-loopback Host is refused with 403 (DNS rebinding)', async (t) => {
  const { port } = await boot(t);
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/health', headers: { host: 'evil.example:4318', authorization: 'Bearer secret-token' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('a request carrying an Origin is refused unless that origin is allowed', async (t) => {
  const { call } = await boot(t);
  const refused = await call('/health', { headers: { origin: 'http://evil.example' } });
  assert.equal(refused.status, 403);

  const allowed = await boot(t, { server: { allowedOrigins: ['http://localhost:4180'] } });
  assert.equal((await allowed.call('/health', { headers: { origin: 'http://localhost:4180' } })).status, 200);
  assert.equal((await allowed.call('/health', { headers: { origin: 'http://localhost:9' } })).status, 403);
});

test('GET /health reports the providers found, the default one and the allowed repositories', async (t) => {
  const { call } = await boot(t);
  const res = await call('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    providers: { available: ['claude-cli'], default: 'claude-cli' },
    repos: ['api', 'web'],
  });
});

test('GET /skills lists the skills of the library', async (t) => {
  const { call } = await boot(t);
  assert.deepEqual(await (await call('/skills')).json(), {
    skills: [{ id: 'nx/monorepo', techno: 'nx', name: 'monorepo', description: 'Keep Nx tidy' }],
  });
});

test('POST /runs starts the default provider in the checkout and answers 202 with the run', async (t) => {
  const { call, calls, dir } = await boot(t);
  const res = await call('/runs', post({ repo: 'api', prompt: 'fix the bug' }));
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.id, 'run-1');
  assert.equal(body.run.status, 'running');
  assert.equal(body.run.provider, 'claude-cli');
  assert.equal(calls[0].command, 'claude');
  assert.equal(calls[0].opts.cwd, path.join(dir, 'api'));
  assert.equal(calls[0].child.input, 'fix the bug');
});

test('POST /runs honours a per-request provider, model and skill', async (t) => {
  const { call, calls } = await boot(t);
  const res = await call('/runs', post({ repo: 'web', provider: 'copilot', model: 'gpt-5', skill: 'nx/monorepo', prompt: 'only libs' }));
  assert.equal(res.status, 202);
  assert.equal(calls[0].command, 'copilot');
  assert.deepEqual(calls[0].args, ['--allow-all-tools', '--model', 'gpt-5']);
  assert.match(calls[0].child.input, /Use affected\./);
  assert.match(calls[0].child.input, /Task:\nonly libs/);
});

test('POST /runs refuses what it cannot run', async (t) => {
  const { call } = await boot(t, { server: { bodyLimit: 200 } });
  const cases = [
    [post({ prompt: 'x' }), 400, /repo is required/],
    [post({ repo: 'api' }), 400, /prompt or a skill/],
    [post({ repo: 'api', prompt: 'x', provider: 'claude' }), 400, /unknown provider/],
    [post({ repo: 'api', prompt: 'x', model: '--evil' }), 400, /invalid model/],
    [post({ repo: 'api', skill: '../etc/passwd' }), 400, /invalid skill/],
    [post({ repo: 'nope', prompt: 'x' }), 404, /unknown repository/],
    [post({ repo: 'api', skill: 'nx/absent' }), 404, /unknown skill/],
    [{ method: 'POST', body: '{not json' }, 400, /invalid JSON/],
    [post({ repo: 'api', prompt: 'x'.repeat(500) }), 413, /too large/],
  ];
  for (const [init, status, message] of cases) {
    const res = await call('/runs', init);
    assert.equal(res.status, status, JSON.stringify(init.body).slice(0, 60));
    assert.match((await res.json()).error, message);
  }
});

test('POST /runs answers 409 while the repository already has an active run', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('/runs', post({ repo: 'api', prompt: 'one' }))).status, 202);
  const second = await call('/runs', post({ repo: 'api', prompt: 'two' }));
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /already active/);
});

test('GET /runs lists the runs, GET /runs/:id returns one, an unknown id is a 404', async (t) => {
  const { call } = await boot(t);
  await call('/runs', post({ repo: 'api', prompt: 'one' }));
  await call('/runs', post({ repo: 'web', prompt: 'two' }));
  assert.deepEqual((await (await call('/runs')).json()).runs.map((r) => r.id), ['run-2', 'run-1']);
  assert.equal((await (await call('/runs/run-1')).json()).run.repo, 'api');
  assert.equal((await call('/runs/run-99')).status, 404);
});

test('DELETE /runs/:id asks the CLI to stop and answers 202', async (t) => {
  const { call, calls } = await boot(t);
  await call('/runs', post({ repo: 'api', prompt: 'one' }));
  const res = await call('/runs/run-1', { method: 'DELETE' });
  assert.equal(res.status, 202);
  assert.equal(calls[0].child.killed, 'SIGTERM');
  assert.equal((await call('/runs/run-99', { method: 'DELETE' })).status, 404);
});

test('GET /runs/:id/events streams the output as SSE and ends with the final status', async (t) => {
  const { call, calls } = await boot(t);
  await call('/runs', post({ repo: 'api', prompt: 'go' }));
  const res = await call('/runs/run-1/events');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const { child } = calls[0];
  child.stdout.emit('data', Buffer.from('hello'));
  child.stderr.emit('data', Buffer.from('warn'));
  child.emit('close', 0);

  const text = await res.text();
  assert.match(text, /event: status\ndata: \{"status":"running"/);
  assert.match(text, /id: 2\nevent: stdout\ndata: \{"text":"hello","at":"/);
  assert.match(text, /event: stderr\ndata: \{"text":"warn"/);
  assert.match(text, /event: status\ndata: \{"status":"succeeded","exitCode":0/);
});

test('a client that connects after the run ended gets the whole history, then the stream closes', async (t) => {
  const { call, calls } = await boot(t);
  await call('/runs', post({ repo: 'api', prompt: 'go' }));
  calls[0].child.stdout.emit('data', 'all done');
  calls[0].child.emit('close', 0);
  const text = await (await call('/runs/run-1/events')).text();
  assert.match(text, /"text":"all done"/);
  assert.match(text, /"status":"succeeded"/);
});

test('events of an unknown run are a 404, and a dropped client does not break the run', async (t) => {
  const { call, calls } = await boot(t);
  assert.equal((await call('/runs/run-99/events')).status, 404);

  await call('/runs', post({ repo: 'api', prompt: 'go' }));
  const controller = new AbortController();
  await call('/runs/run-1/events', { signal: controller.signal });
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.doesNotThrow(() => calls[0].child.stdout.emit('data', 'nobody is listening'));
  assert.equal((await call('/runs/run-1')).status, 200);
});

test('unknown routes and methods are a 404', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('/nope')).status, 404);
  assert.equal((await call('/runs', { method: 'PUT' })).status, 404);
  assert.equal((await call('/runs/run-1', { method: 'POST' })).status, 404);
});

test('an unexpected failure is a 500 carrying its message', async (t) => {
  const manager = { start() { throw new Error('boom'); }, get: () => null, list: () => [], cancel: () => null, subscribe: () => null };
  const { call } = await boot(t, { manager });
  const res = await call('/runs', post({ repo: 'api', prompt: 'x' }));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'boom' });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test apps/agents/test/server.test.js`
Expected: FAIL with `Cannot find module '../src/server.js'`.

- [ ] **Step 4: Implement**

`apps/agents/src/server.js`:

```js
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import {
  AgentError, TERMINAL, listSkills, loadSkill, resolveProvider,
} from '@linktogo/maggie-agent-runner';

// This server runs commands on the machine, so it answers loopback only, wants a
// bearer token on every request, and refuses any request carrying an Origin that
// was not explicitly allowed (a page in the browser can never reach it; the board
// talks to it from its own server, which sends no Origin).
export const LOOPBACK = '127.0.0.1';
export const DEFAULT_BODY_LIMIT = 1_000_000;

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const STATUS_BY_CODE = { invalid: 400, 'not-found': 404, busy: 409, 'too-large': 413 };
const RUN_PATH = /^\/runs\/([\w-]+)(\/events)?$/;

export function isLoopbackHost(host) {
  if (!host) return false;
  try {
    return LOCAL_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export function isAuthorized(header, token) {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AgentError('too-large', 'request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AgentError('invalid', 'invalid JSON body');
  }
}

const sse = (event) => `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event.data, at: event.at })}\n\n`;

export function createAgentsServer({
  token, manager, repos, skillsDir, providers, allowedOrigins = [], bodyLimit = DEFAULT_BODY_LIMIT,
}) {
  function startRun(body) {
    if (typeof body?.repo !== 'string') throw new AgentError('invalid', 'repo is required');
    const provider = resolveProvider({ requested: body.provider, fallback: providers.defaultProvider });
    const cwd = repos.resolve(body.repo);
    const skill = body.skill === undefined || body.skill === null ? null : loadSkill(skillsDir, body.skill);
    const run = manager.start({ repo: body.repo, cwd, provider, model: body.model, prompt: body.prompt, skill });
    return { id: run.id, run };
  }

  function follow(res, id) {
    if (!manager.get(id)) throw new AgentError('not-found', `unknown run: ${id}`);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const unsubscribe = manager.subscribe(id, (event) => {
      res.write(sse(event));
      if (event.type === 'status' && TERMINAL.has(event.data.status)) res.end();
    });
    res.on('close', unsubscribe);
  }

  return createServer(async (req, res) => {
    try {
      if (!isLoopbackHost(req.headers.host)) return send(res, 403, { error: 'forbidden: only loopback hosts are served' });
      if (req.headers.origin !== undefined && !allowedOrigins.includes(req.headers.origin)) {
        return send(res, 403, { error: 'forbidden: cross-site requests are not accepted' });
      }
      if (!isAuthorized(req.headers.authorization, token)) return send(res, 401, { error: 'unauthorized' });

      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && pathname === '/health') {
        return send(res, 200, {
          providers: { available: providers.detect(), default: providers.defaultProvider },
          repos: repos.names(),
        });
      }
      if (req.method === 'GET' && pathname === '/skills') return send(res, 200, { skills: listSkills(skillsDir) });
      if (pathname === '/runs' && req.method === 'GET') return send(res, 200, { runs: manager.list() });
      if (pathname === '/runs' && req.method === 'POST') return send(res, 202, startRun(await readJson(req, bodyLimit)));

      const match = RUN_PATH.exec(pathname);
      if (match) {
        const [, id, events] = match;
        if (req.method === 'GET' && events) return follow(res, id);
        if (req.method === 'GET') {
          const run = manager.get(id);
          if (!run) throw new AgentError('not-found', `unknown run: ${id}`);
          return send(res, 200, { run });
        }
        if (req.method === 'DELETE' && !events) return send(res, 202, { run: manager.cancel(id) });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof AgentError) return send(res, STATUS_BY_CODE[err.code], { error: err.message });
      return send(res, 500, { error: err.message });
    }
  });
}
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test apps/agents/test/server.test.js`
Expected: PASS. If the 413 case fails with a connection reset, lower the test's `bodyLimit` or raise the oversized prompt; the server logic is unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/agents package-lock.json
git commit -m "feat(agents): independent HTTP/SSE server for agent runs"
```

---

### Task 6: `apps/agents` entry point

**Files:**
- Create: `apps/agents/src/main.js`, `apps/agents/bin/agents.js`
- Test: `apps/agents/test/main.test.js`

- [ ] **Step 1: Write the failing tests**

`apps/agents/test/main.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultTokenFile, main, onProcessSignal } from '../src/main.js';

async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agents-main-'));
  const reposFile = path.join(dir, 'repos.json');
  await writeFile(reposFile, JSON.stringify({ repos: [{ name: 'api', url: 'https://github.com/o/api.git', technologies: ['nestjs'] }] }));
  const skillsDir = path.join(dir, 'skills');
  await mkdir(path.join(skillsDir, 'nx', 'monorepo'), { recursive: true });
  await writeFile(path.join(skillsDir, 'nx', 'monorepo', 'SKILL.md'), '---\nname: x\ndescription: d\n---\nbody');
  const tokenFile = path.join(dir, 'state', 'agents.token');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const args = ['--repos', reposFile, '--workspace', dir, '--skills', skillsDir, '--port', '0', '--token-file', tokenFile];
  return { dir, args, tokenFile, skillsDir, reposFile };
}

const quiet = () => {};
const noSignals = () => {};

async function waitFor(condition) {
  for (let i = 0; i < 50 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(condition(), 'condition not met in time');
}

test('main starts the server, writes a private token and serves /health with it', async (t) => {
  const { args, tokenFile } = await workspace(t);
  const lines = [];
  const server = await main(args, { log: (line) => lines.push(line), detect: () => ['copilot'], onSignal: noSignals, env: {} });
  t.after(() => { server.closeAllConnections(); server.close(); });

  const token = (await readFile(tokenFile, 'utf8')).trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);

  const port = server.address().port;
  assert.match(lines[0], new RegExp(`agents server on http://localhost:${port} \\(token: .*agents.token\\)`));
  assert.match(lines[1], /default provider claude-cli; installed: copilot/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 401);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(health, { providers: { available: ['copilot'], default: 'claude-cli' }, repos: ['api'] });
});

test('main says so when no agent CLI is installed', async (t) => {
  const { args } = await workspace(t);
  const lines = [];
  const server = await main(args, { log: (line) => lines.push(line), detect: () => [], onSignal: noSignals, env: {} });
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.match(lines[1], /installed: none/);
});

test('the default provider comes from --provider, else MAGGIE_AGENT_PROVIDER, else claude-cli', async (t) => {
  const { args } = await workspace(t);
  const boot = async (extra, env) => {
    const server = await main([...args, ...extra], { log: quiet, detect: () => [], onSignal: noSignals, env });
    t.after(() => { server.closeAllConnections(); server.close(); });
    const token = (await readFile(args[args.indexOf('--token-file') + 1], 'utf8')).trim();
    const health = await (await fetch(`http://127.0.0.1:${server.address().port}/health`, { headers: { authorization: `Bearer ${token}` } })).json();
    return health.providers.default;
  };
  assert.equal(await boot([], { MAGGIE_AGENT_PROVIDER: 'copilot' }), 'copilot');
  assert.equal(await boot(['--provider', 'claude-cli'], { MAGGIE_AGENT_PROVIDER: 'copilot' }), 'claude-cli');
  assert.equal(await boot([], {}), 'claude-cli');
});

test('the token and the skills default to ~/.maggie/agents.token and the repository skills', async (t) => {
  const { dir, reposFile } = await workspace(t);
  const home = path.join(dir, 'home');
  const server = await main(['--repos', reposFile, '--workspace', dir, '--port', '0'], { log: quiet, detect: () => [], onSignal: noSignals, env: {}, home });
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal(defaultTokenFile(home), path.join(home, '.maggie', 'agents.token'));
  assert.ok(existsSync(defaultTokenFile(home)));
  const token = (await readFile(defaultTokenFile(home), 'utf8')).trim();
  const skills = await (await fetch(`http://127.0.0.1:${server.address().port}/skills`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.ok(skills.skills.some((skill) => skill.id.includes('/')));
});

test('main needs --repos, a known provider and an existing skills directory', async (t) => {
  const { args, tokenFile } = await workspace(t);
  const without = (flag) => { const i = args.indexOf(flag); return [...args.slice(0, i), ...args.slice(i + 2)]; };
  await assert.rejects(main(without('--repos'), { log: quiet, onSignal: noSignals, env: {} }), /Missing required --repos/);
  await assert.rejects(main([...args, '--provider', 'claude'], { log: quiet, onSignal: noSignals, env: {} }), /unknown provider: claude/);
  await assert.rejects(main([...without('--skills'), '--skills', '/nonexistent/skills'], { log: quiet, onSignal: noSignals, env: {} }), /Skills directory not found/);
  assert.equal(existsSync(tokenFile), false, 'a refused start must not leave a token behind');
});

test('SIGINT/SIGTERM close the server and remove the token', async (t) => {
  const { args, tokenFile } = await workspace(t);
  let handler;
  const server = await main(args, { log: quiet, detect: () => [], env: {}, onSignal: (signals, fn) => { assert.deepEqual(signals, ['SIGINT', 'SIGTERM']); handler = fn; } });
  assert.ok(existsSync(tokenFile));
  handler();
  await once(server, 'close');
  await waitFor(() => !existsSync(tokenFile));
});

test('a port that is already taken fails the start and leaves no token behind', async (t) => {
  const { args, tokenFile } = await workspace(t);
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const port = String(blocker.address().port);
  const taken = [...args.slice(0, args.indexOf('--port') + 1), port, ...args.slice(args.indexOf('--port') + 2)];
  await assert.rejects(main(taken, { log: quiet, detect: () => [], onSignal: noSignals, env: {} }), (err) => err.code === 'EADDRINUSE');
  assert.equal(existsSync(tokenFile), false);
});

test('onProcessSignal registers the handler once per signal', () => {
  const proc = new EventEmitter();
  let calls = 0;
  onProcessSignal(['SIGINT', 'SIGTERM'], () => { calls += 1; }, proc);
  proc.emit('SIGINT');
  proc.emit('SIGINT');
  proc.emit('SIGTERM');
  assert.equal(calls, 2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test apps/agents/test/main.test.js`
Expected: FAIL with `Cannot find module '../src/main.js'`.

- [ ] **Step 3: Implement**

`apps/agents/src/main.js`:

```js
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig as defaultLoadConfig } from '@linktogo/maggie-config';
import {
  DEFAULT_AGENT_PROVIDER, createRepoResolver, createRunManager, detectProviders, resolveProvider,
} from '@linktogo/maggie-agent-runner';
import { LOOPBACK, createAgentsServer } from './server.js';

export const DEFAULT_PORT = 4318;

const DEFAULT_SKILLS_DIR = fileURLToPath(new URL('../../../skills', import.meta.url));

/** Where the board finds the token to talk to this server. */
export const defaultTokenFile = (home = os.homedir()) => path.join(home, '.maggie', 'agents.token');

export function onProcessSignal(signals, handler, proc = process) {
  for (const signal of signals) proc.once(signal, handler);
}

export async function main(argv, {
  log = console.log,
  loadConfig = defaultLoadConfig,
  detect = detectProviders,
  env = process.env,
  home = os.homedir(),
  onSignal = onProcessSignal,
} = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: String(DEFAULT_PORT) },
      provider: { type: 'string' },
      repos: { type: 'string' },
      workspace: { type: 'string', default: 'wk' },
      skills: { type: 'string' },
      'allow-origin': { type: 'string', multiple: true, default: [] },
      'token-file': { type: 'string' },
      timeout: { type: 'string', default: '600' },
    },
  });
  if (!values.repos) throw new Error('Missing required --repos <repos.json>');
  const defaultProvider = resolveProvider({
    requested: values.provider ?? env.MAGGIE_AGENT_PROVIDER,
    fallback: DEFAULT_AGENT_PROVIDER,
  });
  const skillsDir = path.resolve(values.skills ?? DEFAULT_SKILLS_DIR);
  if (!existsSync(skillsDir)) throw new Error(`Skills directory not found: ${skillsDir}`);

  const config = await loadConfig(path.resolve(values.repos));
  const repos = createRepoResolver({ repos: config.repos, workspace: path.resolve(values.workspace) });
  const manager = createRunManager({ timeoutMs: Number(values.timeout) * 1000 });

  // The token never reaches a log or a command line: it lives in a 0600 file the
  // board reads, and goes away with the server.
  const token = randomBytes(32).toString('hex');
  const tokenFile = path.resolve(values['token-file'] ?? defaultTokenFile(home));
  await mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);

  const server = createAgentsServer({
    token,
    manager,
    repos,
    skillsDir,
    providers: { detect, defaultProvider },
    allowedOrigins: values['allow-origin'],
  });
  server.on('close', () => { void rm(tokenFile, { force: true }); });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(values.port), LOOPBACK, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    await rm(tokenFile, { force: true });
    throw err;
  }

  const installed = detect();
  log(`agents server on http://localhost:${server.address().port} (token: ${tokenFile})`);
  log(`  default provider ${defaultProvider}; installed: ${installed.length ? installed.join(', ') : 'none (claude / copilot not found on PATH)'}`);
  onSignal(['SIGINT', 'SIGTERM'], () => {
    server.close();
    server.closeAllConnections();
  });
  return server;
}
```

`apps/agents/bin/agents.js`:

```js
#!/usr/bin/env node
import { main } from '../src/main.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
```

Run: `chmod +x apps/agents/bin/agents.js`

- [ ] **Step 4: Run to verify pass, then the coverage gate**

Run: `node --test apps/agents/test/main.test.js` -> PASS.
Run: `npx nx run agents:test`
Expected: PASS with 100% lines/functions/branches on `apps/agents/src/**`. Fix any gap with a test.

- [ ] **Step 5: Commit and push**

```bash
git add apps/agents
git commit -m "feat(agents): CLI entry with token file, provider default and graceful shutdown"
git push -u origin ccr-2b06c5bb-7ofepa
```

---

### Task 7: Board proxy `/api/factory/*`

**Files:**
- Create: `apps/board/agentsProxy.js`
- Modify: `apps/board/server.js`, `apps/board/package.json`
- Test: `apps/board/agentsProxy.test.js`, `apps/board/server.test.js`

- [ ] **Step 1: Write the failing proxy tests**

`apps/board/agentsProxy.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentsProxy, defaultTokenFile } from './agentsProxy.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// A stand-in for apps/agents that records what reached it.
async function upstream(t, handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    handler(req, res);
  });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${port}`, seen };
}

// The board side: a server that does nothing but hand /api/factory/* to the proxy.
async function board(t, options) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agents-proxy-'));
  const tokenFile = path.join(dir, 'agents.token');
  await writeFile(tokenFile, 'tok-123\n');
  const proxy = createAgentsProxy({ tokenFile, ...options });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    proxy(req, res, url.pathname, url.search);
  });
  const port = await listen(server);
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${port}`, tokenFile, dir };
}

test('GET is forwarded with the token added server-side', async (t) => {
  const agents = await upstream(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"repos":["api"]}'); });
  const { base } = await board(t, { url: agents.url });
  const res = await fetch(`${base}/api/factory/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { repos: ['api'] });
  assert.deepEqual(agents.seen.map(({ method, url, authorization }) => ({ method, url, authorization })), [
    { method: 'GET', url: '/health', authorization: 'Bearer tok-123' },
  ]);
});

test('POST carries its body, and the agents server refusal is passed straight through', async (t) => {
  const agents = await upstream(t, (req, res) => { res.writeHead(409, { 'content-type': 'application/json' }); res.end('{"error":"a run is already active on api"}'); });
  const { base } = await board(t, { url: agents.url });
  const res = await fetch(`${base}/api/factory/runs?x=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"repo":"api","prompt":"go"}' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'a run is already active on api' });
  assert.equal(agents.seen[0].url, '/runs?x=1');
  assert.equal(agents.seen[0].body, '{"repo":"api","prompt":"go"}');
});

test('DELETE reaches /runs/:id', async (t) => {
  const agents = await upstream(t, (req, res) => { res.writeHead(202, { 'content-type': 'application/json' }); res.end('{}'); });
  const { base } = await board(t, { url: agents.url });
  assert.equal((await fetch(`${base}/api/factory/runs/run-1`, { method: 'DELETE' })).status, 202);
  assert.equal(agents.seen[0].method, 'DELETE');
});

test('the SSE stream is relayed as it arrives', async (t) => {
  const agents = await upstream(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: stdout\ndata: {"text":"one"}\n\n');
    setTimeout(() => res.end('event: status\ndata: {"status":"succeeded"}\n\n'), 30);
  });
  const { base } = await board(t, { url: agents.url });
  const res = await fetch(`${base}/api/factory/runs/run-1/events`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await res.text();
  assert.match(text, /"text":"one"/);
  assert.match(text, /"status":"succeeded"/);
});

test('only the agents routes are relayed, with their usual methods', async (t) => {
  const agents = await upstream(t, (req, res) => res.end('{}'));
  const { base } = await board(t, { url: agents.url });
  for (const route of ['/api/factory/../etc', '/api/factory/other', '/api/factory/runs/a/b/c', '/api/factory/runs/%2e%2e']) {
    assert.equal((await fetch(`${base}${route}`)).status, 404, route);
  }
  assert.equal((await fetch(`${base}/api/factory/health`, { method: 'PUT' })).status, 405);
  assert.equal(agents.seen.length, 0);
});

test('a missing token file or an unreachable agents server is a 503 with a reason', async (t) => {
  const missing = await board(t, { url: 'http://127.0.0.1:9' });
  await rm(missing.tokenFile);
  const noToken = await fetch(`${missing.base}/api/factory/health`);
  assert.equal(noToken.status, 503);
  assert.match((await noToken.json()).detail, /no token at/);

  const down = await board(t, { url: 'http://127.0.0.1:9' });
  const unreachable = await fetch(`${down.base}/api/factory/health`);
  assert.equal(unreachable.status, 503);
  assert.match((await unreachable.json()).detail, /unreachable/);
});

test('the token file defaults to ~/.maggie/agents.token', () => {
  assert.equal(defaultTokenFile('/home/u'), path.join('/home/u', '.maggie', 'agents.token'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test apps/board/agentsProxy.test.js`
Expected: FAIL with `Cannot find module './agentsProxy.js'`.

- [ ] **Step 3: Implement the proxy**

`apps/board/agentsProxy.js`:

```js
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

export const DEFAULT_AGENTS_URL = 'http://127.0.0.1:4318';

/** Where `maggie-agents` writes the token it generated at startup. */
export const defaultTokenFile = (home = os.homedir()) => path.join(home, '.maggie', 'agents.token');

// The routes of apps/agents, nothing else: the proxy is not a way to reach arbitrary paths.
const ROUTE = /^\/(health|skills|runs(\/[\w-]+(\/events)?)?)$/;
const METHODS = new Set(['GET', 'POST', 'DELETE']);

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const unavailable = (res, detail) => reply(res, 503, { error: 'agents-unavailable', detail });

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Relays `/api/factory/*` to the agents server. The browser never holds the
 * token: it is read from its file here and added to the upstream request. SSE
 * responses are piped through unbuffered.
 */
export function createAgentsProxy({
  url = DEFAULT_AGENTS_URL, tokenFile = defaultTokenFile(), fetchImpl = fetch,
} = {}) {
  return async function proxy(req, res, pathname, search = '') {
    const route = pathname.replace(/^\/api\/factory/, '');
    if (!ROUTE.test(route)) return reply(res, 404, { error: 'unknown factory route' });
    if (!METHODS.has(req.method)) return reply(res, 405, { error: 'method not allowed' });

    let token;
    try {
      token = (await readFile(tokenFile, 'utf8')).trim();
    } catch {
      return unavailable(res, `no token at ${tokenFile}: is the agents server running?`);
    }

    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    let upstream;
    try {
      upstream = await fetchImpl(`${url}${route}${search}`, {
        method: req.method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body,
        signal: controller.signal,
      });
    } catch {
      return unavailable(res, `agents server unreachable at ${url}`);
    }

    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-cache',
    });
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
  };
}
```

Note: `'/api/factory/../etc'` is normalised by `fetch`/`URL` before it reaches the server; the assertion above still holds because the resulting path is not a factory route (404 from the stub board server's proxy or no match). Keep the `%2e%2e` case: `[\w-]+` rejects it.

- [ ] **Step 4: Run to verify pass**

Run: `node --test apps/board/agentsProxy.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the proxy into the board server (test first)**

Append to `apps/board/server.test.js`:

```js
test('/api/factory/* is handed to the agents proxy, behind the same Host and Origin guards', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const seen = [];
  const agentsProxy = async (req, res, pathname, search) => {
    seen.push(`${req.method} ${pathname}${search}`);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('relayed');
  };
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir, agentsProxy });
  const port = await listen(server);

  const ok = await fetch(`http://127.0.0.1:${port}/api/factory/runs?x=1`, { method: 'DELETE' });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'relayed');
  assert.deepEqual(seen, ['DELETE /api/factory/runs?x=1']);

  const crossSite = await fetch(`http://127.0.0.1:${port}/api/factory/runs`, {
    method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(crossSite.status, 403);
  assert.equal(seen.length, 1);
  server.close();
  await rm(dir, { recursive: true, force: true });
});
```

Run: `node --test apps/board/server.test.js`
Expected: the new test FAILS (the route falls through to the static handler).

Edit `apps/board/server.js`:

1. Import: `import { createAgentsProxy, DEFAULT_AGENTS_URL } from './agentsProxy.js';`
2. Signature: `export function createBoardServer({ boardPath, distDir, config = null, ciReader = null, retroDoc = undefined, agentsProxy = createAgentsProxy() }) {`
3. In the request handler, right after the `/api/retro-doc` line:

```js
      if (url.pathname.startsWith('/api/factory/')) return await agentsProxy(req, res, url.pathname, url.search);
```

4. In `startFromArgv`, add the two options to `parseArgs`:

```js
      'agents-url': { type: 'string', default: DEFAULT_AGENTS_URL },
      'agents-token-file': { type: 'string' },
```

and build the server with the proxy:

```js
  const agentsProxy = createAgentsProxy({
    url: values['agents-url'],
    ...(values['agents-token-file'] ? { tokenFile: path.resolve(values['agents-token-file']) } : {}),
  });
  const server = createBoardServer({ boardPath, distDir, config, ciReader, agentsProxy });
```

(replace the existing `createBoardServer({ boardPath, distDir, config, ciReader })` call).

Edit `apps/board/package.json`: add a target and chain it into `test`:

```json
      "test-agents-proxy": {
        "executor": "nx:run-commands",
        "options": {
          "command": "node --test apps/board/agentsProxy.test.js"
        }
      },
```

and add `"test-agents-proxy"` to the `dependsOn` list of the `test` target.

- [ ] **Step 6: Run to verify pass, commit**

Run: `node --test apps/board/server.test.js apps/board/agentsProxy.test.js` -> PASS.

```bash
git add apps/board/agentsProxy.js apps/board/agentsProxy.test.js apps/board/server.js apps/board/server.test.js apps/board/package.json
git commit -m "feat(board): relay /api/factory/* to the agents server, token kept server-side"
```

---

### Task 8: `useFactory` composable

**Files:**
- Create: `apps/board/src/useFactory.js`
- Test: `apps/board/src/useFactory.test.js`

- [ ] **Step 1: Write the failing tests**

`apps/board/src/useFactory.test.js`:

```js
import { test, expect, vi } from 'vitest';
import { nextTick } from 'vue';
import { useFactory } from './useFactory.js';

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }

  close() { this.closed = true; }

  emit(type, data) { for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) }); }
}

function api(routes) {
  return vi.fn(async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    const { status = 200, body = {} } = handler(init);
    return { ok: status < 400, status, json: async () => body };
  });
}

const HEALTH = { providers: { available: ['claude-cli'], default: 'claude-cli' }, repos: ['api'] };
const base = {
  'GET /api/factory/health': () => ({ body: HEALTH }),
  'GET /api/factory/skills': () => ({ body: { skills: [{ id: 'nx/monorepo' }] } }),
  'GET /api/factory/runs': () => ({ body: { runs: [{ id: 'run-1', status: 'running' }] } }),
};

function factory(routes) {
  FakeEventSource.instances = [];
  const fetchImpl = api({ ...base, ...routes });
  return { fetchImpl, ...useFactory({ fetchImpl, EventSourceImpl: FakeEventSource }) };
}

test('loads the health, the skills and the runs of the agents server', async () => {
  const f = factory({});
  await settle();
  expect(f.available.value).toBe(true);
  expect(f.health.value).toEqual(HEALTH);
  expect(f.skills.value).toEqual([{ id: 'nx/monorepo' }]);
  expect(f.runs.value).toEqual([{ id: 'run-1', status: 'running' }]);
});

test('reports the agents server as unavailable on a 503, with its reason', async () => {
  const f = factory({ 'GET /api/factory/health': () => ({ status: 503, body: { error: 'agents-unavailable', detail: 'agents server unreachable at http://127.0.0.1:4318' } }) });
  await settle();
  expect(f.available.value).toBe(false);
  expect(f.detail.value).toContain('unreachable');
});

test('reports it as unavailable when the board itself cannot be reached', async () => {
  FakeEventSource.instances = [];
  const f = useFactory({ fetchImpl: vi.fn().mockRejectedValue(new Error('network down')), EventSourceImpl: FakeEventSource });
  await settle();
  expect(f.available.value).toBe(false);
  expect(f.detail.value).toBe('network down');
});

test('start posts only the filled fields, refreshes the runs and follows the new one', async () => {
  const posted = [];
  const f = factory({
    'POST /api/factory/runs': (init) => { posted.push(JSON.parse(init.body)); return { status: 202, body: { id: 'run-2', run: { id: 'run-2', status: 'running' } } }; },
  });
  await settle();
  const run = await f.start({ repo: 'api', provider: 'copilot', model: '', prompt: 'fix it', skill: '' });
  expect(posted).toEqual([{ repo: 'api', provider: 'copilot', prompt: 'fix it' }]);
  expect(run.id).toBe('run-2');
  expect(f.followed.value).toBe('run-2');
  expect(FakeEventSource.instances.at(-1).url).toBe('/api/factory/runs/run-2/events');
});

test('start sends the model and the skill when they are set', async () => {
  const posted = [];
  const f = factory({
    'POST /api/factory/runs': (init) => { posted.push(JSON.parse(init.body)); return { status: 202, body: { id: 'run-2', run: {} } }; },
  });
  await settle();
  await f.start({ repo: 'api', provider: 'claude-cli', model: 'sonnet', prompt: '', skill: 'nx/monorepo' });
  expect(posted).toEqual([{ repo: 'api', provider: 'claude-cli', model: 'sonnet', skill: 'nx/monorepo' }]);
});

test('a refused start keeps the reason and opens no stream', async () => {
  const f = factory({ 'POST /api/factory/runs': () => ({ status: 409, body: { error: 'a run is already active on api' } }) });
  await settle();
  expect(await f.start({ repo: 'api', provider: 'claude-cli', prompt: 'x' })).toBeNull();
  expect(f.error.value).toBe('a run is already active on api');
  expect(FakeEventSource.instances).toHaveLength(0);
});

test('a start that cannot reach the board reports the network error', async () => {
  const f = factory({ 'POST /api/factory/runs': () => { throw new Error('offline'); } });
  await settle();
  expect(await f.start({ repo: 'api', provider: 'claude-cli', prompt: 'x' })).toBeNull();
  expect(f.error.value).toBe('offline');
});

test('following a run collects its output and closes the stream on the final status', async () => {
  const f = factory({});
  await settle();
  f.follow('run-1');
  const stream = FakeEventSource.instances[0];
  stream.emit('stdout', { text: 'hello' });
  stream.emit('stderr', { text: 'warn' });
  stream.emit('status', { status: 'running' });
  expect(stream.closed).toBe(false);
  stream.emit('status', { status: 'succeeded' });
  expect(f.output.value).toEqual([
    { type: 'stdout', text: 'hello' },
    { type: 'stderr', text: 'warn' },
    { type: 'status', text: 'running' },
    { type: 'status', text: 'succeeded' },
  ]);
  expect(stream.closed).toBe(true);
});

test('following another run replaces the stream and clears the output', async () => {
  const f = factory({});
  await settle();
  f.follow('run-1');
  FakeEventSource.instances[0].emit('stdout', { text: 'old' });
  f.follow('run-2');
  expect(FakeEventSource.instances[0].closed).toBe(true);
  expect(f.followed.value).toBe('run-2');
  expect(f.output.value).toEqual([]);
});

test('a dropped stream is closed rather than left to reconnect and replay the output', async () => {
  const f = factory({});
  await settle();
  f.follow('run-1');
  FakeEventSource.instances[0].onerror();
  expect(FakeEventSource.instances[0].closed).toBe(true);
});

test('cancel sends DELETE and refreshes; a failure is reported', async () => {
  const deleted = [];
  const f = factory({ 'DELETE /api/factory/runs/run-1': () => { deleted.push('run-1'); return { status: 202, body: {} }; } });
  await settle();
  await f.cancel('run-1');
  expect(deleted).toEqual(['run-1']);

  const g = factory({ 'DELETE /api/factory/runs/run-1': () => ({ status: 404, body: { error: 'unknown run: run-1' } }) });
  await settle();
  await g.cancel('run-1');
  expect(g.error.value).toBe('unknown run: run-1');
});

test('close ends the followed stream', async () => {
  const f = factory({});
  await settle();
  f.follow('run-1');
  f.close();
  expect(FakeEventSource.instances[0].closed).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --root apps/board src/useFactory.test.js`
Expected: FAIL with `Failed to resolve import "./useFactory.js"`.

- [ ] **Step 3: Implement**

`apps/board/src/useFactory.js`:

```js
import { ref, onUnmounted } from 'vue';

const FINAL = ['succeeded', 'failed', 'cancelled', 'timed-out'];
const OUTPUT_TYPES = ['stdout', 'stderr'];

// The browser talks to the board, which relays to the agents server and holds
// the token: nothing in here ever sees a credential.
export function useFactory({ fetchImpl = fetch, EventSourceImpl = globalThis.EventSource } = {}) {
  const health = ref(null);
  const skills = ref([]);
  const runs = ref([]);
  const output = ref([]);
  const followed = ref(null);
  const error = ref(null);
  const detail = ref(null);
  const available = ref(true);
  let source = null;

  async function api(path, init) {
    const res = await fetchImpl(`/api/factory${path}`, init);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok === true, status: res.status, data };
  }

  async function refreshRuns() {
    const { ok, data } = await api('/runs');
    if (ok) runs.value = data.runs ?? [];
  }

  async function load() {
    try {
      const [healthResult, skillsResult] = await Promise.all([api('/health'), api('/skills')]);
      if (!healthResult.ok) {
        available.value = false;
        detail.value = healthResult.data.detail ?? healthResult.data.error ?? `HTTP ${healthResult.status}`;
        return;
      }
      available.value = true;
      detail.value = null;
      health.value = healthResult.data;
      skills.value = skillsResult.data.skills ?? [];
      await refreshRuns();
    } catch (err) {
      available.value = false;
      detail.value = err.message ?? String(err);
    }
  }

  function close() {
    if (source) source.close();
    source = null;
  }

  // The stream is closed on the final status: left open, EventSource would
  // reconnect when the server ends the response and replay the whole output.
  function follow(id) {
    close();
    followed.value = id;
    output.value = [];
    const stream = new EventSourceImpl(`/api/factory/runs/${id}/events`);
    source = stream;
    for (const type of OUTPUT_TYPES) {
      stream.addEventListener(type, (event) => output.value.push({ type, text: JSON.parse(event.data).text }));
    }
    stream.addEventListener('status', (event) => {
      const { status } = JSON.parse(event.data);
      output.value.push({ type: 'status', text: status });
      if (FINAL.includes(status)) {
        close();
        void refreshRuns();
      }
    });
    stream.onerror = close;
  }

  async function start({ repo, provider, model, prompt, skill }) {
    error.value = null;
    const body = { repo, provider };
    if (model) body.model = model;
    if (prompt) body.prompt = prompt;
    if (skill) body.skill = skill;
    try {
      const { ok, status, data } = await api('/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!ok) {
        error.value = data.error ?? `HTTP ${status}`;
        return null;
      }
      await refreshRuns();
      follow(data.id);
      return data.run;
    } catch (err) {
      error.value = err.message ?? String(err);
      return null;
    }
  }

  async function cancel(id) {
    error.value = null;
    try {
      const { ok, status, data } = await api(`/runs/${id}`, { method: 'DELETE' });
      if (!ok) error.value = data.error ?? `HTTP ${status}`;
      await refreshRuns();
    } catch (err) {
      error.value = err.message ?? String(err);
    }
  }

  void load();
  onUnmounted(close);

  return { health, skills, runs, output, followed, error, detail, available, load, refreshRuns, start, cancel, follow, close };
}
```

- [ ] **Step 4: Run to verify pass, commit**

Run: `npx vitest run --root apps/board src/useFactory.test.js` -> PASS.

```bash
git add apps/board/src/useFactory.js apps/board/src/useFactory.test.js
git commit -m "feat(board): useFactory composable for the AI Factory tab"
```

---

### Task 9: Factory page, route, nav tab, strings

**Files:**
- Create: `apps/board/src/FactoryPage.vue`
- Modify: `apps/board/src/router.js`, `apps/board/src/App.vue`, `apps/board/src/locales/{en,fr,de,es}.js`
- Test: `apps/board/src/FactoryPage.test.js`, `apps/board/src/App.test.js`

- [ ] **Step 1: Add the strings (the locale parity test guards the four catalogs)**

In `apps/board/src/locales/en.js`, after `'nav.retroDoc': 'Retro-doc',` add `'nav.factory': 'AI Factory',` and, before the `'notifications.enable'` line, add:

```js
  'factory.title': 'AI Factory',
  'factory.intro': 'Launch a local coding agent (Claude Code or GitHub Copilot CLI) on a repository, through the maggie agents server.',
  'factory.unavailable': 'The agents server is not reachable.',
  'factory.startHint': 'Start it with: npm run agents -- --repos repos.json',
  'factory.repo': 'Repository',
  'factory.provider': 'Provider',
  'factory.model': 'Model',
  'factory.modelPlaceholder': 'provider default',
  'factory.modePrompt': 'Free prompt',
  'factory.modeSkill': 'Skill',
  'factory.skill': 'Skill',
  'factory.skillNone': 'Choose a skill…',
  'factory.prompt': 'Prompt',
  'factory.extraPrompt': 'Extra instructions (optional)',
  'factory.run': 'Run agent',
  'factory.noProvider': 'No agent CLI (claude, copilot) found on the agents server.',
  'factory.noRepos': 'No repository is allowed on the agents server.',
  'factory.runs': 'Runs',
  'factory.noRuns': 'No run yet.',
  'factory.output': 'Output',
  'factory.noOutput': 'Pick a run to follow its output.',
  'factory.follow': 'output',
  'factory.stop': 'stop',
  'factory.status.running': 'running',
  'factory.status.succeeded': 'succeeded',
  'factory.status.failed': 'failed',
  'factory.status.cancelled': 'cancelled',
  'factory.status.timed-out': 'timed out',
```

`fr.js` (`'nav.factory': 'AI Factory',` after `nav.retroDoc`, the rest before `'notifications.enable'`):

```js
  'factory.title': 'AI Factory',
  'factory.intro': 'Lance un agent de code local (Claude Code ou GitHub Copilot CLI) sur un dépôt, via le serveur d’agents de maggie.',
  'factory.unavailable': 'Le serveur d’agents est injoignable.',
  'factory.startHint': 'Démarre-le avec : npm run agents -- --repos repos.json',
  'factory.repo': 'Dépôt',
  'factory.provider': 'Fournisseur',
  'factory.model': 'Modèle',
  'factory.modelPlaceholder': 'défaut du fournisseur',
  'factory.modePrompt': 'Prompt libre',
  'factory.modeSkill': 'Skill',
  'factory.skill': 'Skill',
  'factory.skillNone': 'Choisir un skill…',
  'factory.prompt': 'Prompt',
  'factory.extraPrompt': 'Consignes supplémentaires (facultatif)',
  'factory.run': 'Lancer l’agent',
  'factory.noProvider': 'Aucun CLI d’agent (claude, copilot) trouvé sur le serveur d’agents.',
  'factory.noRepos': 'Aucun dépôt n’est autorisé sur le serveur d’agents.',
  'factory.runs': 'Exécutions',
  'factory.noRuns': 'Aucune exécution pour l’instant.',
  'factory.output': 'Sortie',
  'factory.noOutput': 'Choisis une exécution pour suivre sa sortie.',
  'factory.follow': 'sortie',
  'factory.stop': 'arrêter',
  'factory.status.running': 'en cours',
  'factory.status.succeeded': 'réussie',
  'factory.status.failed': 'échouée',
  'factory.status.cancelled': 'annulée',
  'factory.status.timed-out': 'délai dépassé',
```

`de.js` (`'nav.factory': 'AI Factory',`):

```js
  'factory.title': 'AI Factory',
  'factory.intro': 'Startet einen lokalen Coding-Agenten (Claude Code oder GitHub Copilot CLI) auf einem Repository, über den maggie-Agentenserver.',
  'factory.unavailable': 'Der Agentenserver ist nicht erreichbar.',
  'factory.startHint': 'Starten mit: npm run agents -- --repos repos.json',
  'factory.repo': 'Repository',
  'factory.provider': 'Anbieter',
  'factory.model': 'Modell',
  'factory.modelPlaceholder': 'Standard des Anbieters',
  'factory.modePrompt': 'Freier Prompt',
  'factory.modeSkill': 'Skill',
  'factory.skill': 'Skill',
  'factory.skillNone': 'Skill wählen…',
  'factory.prompt': 'Prompt',
  'factory.extraPrompt': 'Zusätzliche Anweisungen (optional)',
  'factory.run': 'Agent starten',
  'factory.noProvider': 'Kein Agenten-CLI (claude, copilot) auf dem Agentenserver gefunden.',
  'factory.noRepos': 'Auf dem Agentenserver ist kein Repository freigegeben.',
  'factory.runs': 'Läufe',
  'factory.noRuns': 'Noch kein Lauf.',
  'factory.output': 'Ausgabe',
  'factory.noOutput': 'Wähle einen Lauf, um seine Ausgabe zu verfolgen.',
  'factory.follow': 'Ausgabe',
  'factory.stop': 'stoppen',
  'factory.status.running': 'läuft',
  'factory.status.succeeded': 'erfolgreich',
  'factory.status.failed': 'fehlgeschlagen',
  'factory.status.cancelled': 'abgebrochen',
  'factory.status.timed-out': 'Zeitlimit überschritten',
```

`es.js` (`'nav.factory': 'AI Factory',`):

```js
  'factory.title': 'AI Factory',
  'factory.intro': 'Lanza un agente de código local (Claude Code o GitHub Copilot CLI) sobre un repositorio, a través del servidor de agentes de maggie.',
  'factory.unavailable': 'El servidor de agentes no está accesible.',
  'factory.startHint': 'Inícialo con: npm run agents -- --repos repos.json',
  'factory.repo': 'Repositorio',
  'factory.provider': 'Proveedor',
  'factory.model': 'Modelo',
  'factory.modelPlaceholder': 'predeterminado del proveedor',
  'factory.modePrompt': 'Prompt libre',
  'factory.modeSkill': 'Skill',
  'factory.skill': 'Skill',
  'factory.skillNone': 'Elige un skill…',
  'factory.prompt': 'Prompt',
  'factory.extraPrompt': 'Instrucciones adicionales (opcional)',
  'factory.run': 'Lanzar agente',
  'factory.noProvider': 'No se encontró ningún CLI de agente (claude, copilot) en el servidor de agentes.',
  'factory.noRepos': 'No hay ningún repositorio permitido en el servidor de agentes.',
  'factory.runs': 'Ejecuciones',
  'factory.noRuns': 'Aún no hay ejecuciones.',
  'factory.output': 'Salida',
  'factory.noOutput': 'Elige una ejecución para seguir su salida.',
  'factory.follow': 'salida',
  'factory.stop': 'detener',
  'factory.status.running': 'en curso',
  'factory.status.succeeded': 'correcta',
  'factory.status.failed': 'fallida',
  'factory.status.cancelled': 'cancelada',
  'factory.status.timed-out': 'tiempo agotado',
```

- [ ] **Step 2: Write the failing page test**

`apps/board/src/FactoryPage.test.js`:

```js
import { test, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import FactoryPage from './FactoryPage.vue';

class FakeEventSource {
  static instances = [];

  constructor(url) { this.url = url; this.listeners = {}; FakeEventSource.instances.push(this); }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }

  close() { this.closed = true; }

  emit(type, data) { for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) }); }
}

const HEALTH = { providers: { available: ['claude-cli', 'copilot'], default: 'copilot' }, repos: ['api', 'web'] };
const SKILLS = [{ id: 'nx/monorepo', techno: 'nx', name: 'monorepo', description: 'Keep Nx tidy' }];

function fetchWith({ health = { status: 200, body: HEALTH }, runs = [], onPost = () => ({ status: 202, body: { id: 'run-1', run: { id: 'run-1', status: 'running' } } }), onDelete = () => ({ status: 202, body: {} }) } = {}) {
  return vi.fn(async (url, init = {}) => {
    const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (init.method === 'POST') { const r = onPost(JSON.parse(init.body)); return answer(r.status, r.body); }
    if (init.method === 'DELETE') { const r = onDelete(url); return answer(r.status, r.body); }
    if (url === '/api/factory/health') return answer(health.status, health.body);
    if (url === '/api/factory/skills') return answer(200, { skills: SKILLS });
    return answer(200, { runs });
  });
}

async function page(fetchImpl) {
  FakeEventSource.instances = [];
  const w = mount(FactoryPage, { props: { fetchImpl, EventSourceImpl: FakeEventSource } });
  await flushPromises();
  return w;
}

test('the form offers the repos and providers of the agents server, preselecting its default provider', async () => {
  const w = await page(fetchWith());
  expect(w.findAll('[data-test=factory-repo] option').map((o) => o.text())).toEqual(['api', 'web']);
  expect(w.findAll('[data-test=factory-provider] option').map((o) => o.element.value)).toEqual(['claude-cli', 'copilot']);
  expect(w.get('[data-test=factory-provider]').element.value).toBe('copilot');
});

test('the run button waits for a prompt', async () => {
  const w = await page(fetchWith());
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(true);
  await w.get('[data-test=factory-prompt]').setValue('fix the failing test');
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(false);
});

test('running posts the chosen repo, provider, model and prompt, then follows the output', async () => {
  const posted = [];
  const w = await page(fetchWith({ onPost: (body) => { posted.push(body); return { status: 202, body: { id: 'run-1', run: { id: 'run-1', status: 'running' } } }; } }));
  await w.get('[data-test=factory-repo]').setValue('web');
  await w.get('[data-test=factory-provider]').setValue('claude-cli');
  await w.get('[data-test=factory-model]').setValue('sonnet');
  await w.get('[data-test=factory-prompt]').setValue('fix it');
  await w.get('[data-test=factory-run]').trigger('click');
  await flushPromises();

  expect(posted).toEqual([{ repo: 'web', provider: 'claude-cli', model: 'sonnet', prompt: 'fix it' }]);
  FakeEventSource.instances[0].emit('stdout', { text: 'working…' });
  await flushPromises();
  expect(w.get('[data-test=factory-output]').text()).toContain('working…');
});

test('skill mode needs a skill and posts it, the prompt becoming extra instructions', async () => {
  const posted = [];
  const w = await page(fetchWith({ onPost: (body) => { posted.push(body); return { status: 202, body: { id: 'run-1', run: {} } }; } }));
  await w.get('[data-test=factory-mode-skill]').setValue(true);
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(true);
  await w.get('[data-test=factory-skill]').setValue('nx/monorepo');
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(false);
  await w.get('[data-test=factory-run]').trigger('click');
  await flushPromises();
  expect(posted).toEqual([{ repo: 'api', provider: 'copilot', skill: 'nx/monorepo' }]);
});

test('an unreachable agents server explains how to start it and disables the form', async () => {
  const w = await page(fetchWith({ health: { status: 503, body: { error: 'agents-unavailable', detail: 'agents server unreachable at http://127.0.0.1:4318' } } }));
  expect(w.get('[data-test=factory-unavailable]').text()).toContain('not reachable');
  expect(w.get('[data-test=factory-unavailable]').text()).toContain('npm run agents');
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(true);
});

test('a server with no agent CLI says so', async () => {
  const w = await page(fetchWith({ health: { status: 200, body: { ...HEALTH, providers: { available: [], default: 'claude-cli' } } } }));
  expect(w.get('[data-test=factory-no-provider]').exists()).toBe(true);
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(true);
});

test('a refused run shows the reason', async () => {
  const w = await page(fetchWith({ onPost: () => ({ status: 409, body: { error: 'a run is already active on api' } }) }));
  await w.get('[data-test=factory-prompt]').setValue('again');
  await w.get('[data-test=factory-run]').trigger('click');
  await flushPromises();
  expect(w.get('[data-test=factory-error]').text()).toContain('already active');
});

test('runs are listed; a running one can be stopped, any one can be followed', async () => {
  const deleted = [];
  const runs = [
    { id: 'run-2', repo: 'web', provider: 'copilot', skill: 'nx/monorepo', status: 'running' },
    { id: 'run-1', repo: 'api', provider: 'claude-cli', skill: null, status: 'succeeded' },
  ];
  const w = await page(fetchWith({ runs, onDelete: (url) => { deleted.push(url); return { status: 202, body: {} }; } }));
  expect(w.get('[data-test=factory-run-row-run-2]').text()).toContain('running');
  expect(w.get('[data-test=factory-run-row-run-1]').text()).toContain('succeeded');
  expect(w.find('[data-test=factory-stop-run-1]').exists()).toBe(false);

  await w.get('[data-test=factory-stop-run-2]').trigger('click');
  expect(deleted).toEqual(['/api/factory/runs/run-2']);

  await w.get('[data-test=factory-follow-run-1]').trigger('click');
  expect(FakeEventSource.instances.at(-1).url).toBe('/api/factory/runs/run-1/events');
});

test('with nothing to show the page says so', async () => {
  const w = await page(fetchWith());
  expect(w.get('[data-test=factory-no-runs]').exists()).toBe(true);
  expect(w.get('[data-test=factory-no-output]').exists()).toBe(true);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run --root apps/board src/FactoryPage.test.js`
Expected: FAIL with `Failed to resolve import "./FactoryPage.vue"`.

- [ ] **Step 4: Implement the page**

`apps/board/src/FactoryPage.vue`:

```vue
<script setup>
import { computed, reactive } from 'vue';
import { useFactory } from './useFactory.js';
import Icon from './Icon.vue';
import { useI18n } from './i18n.js';

const { t } = useI18n();

const props = defineProps({
  fetchImpl: { type: Function, required: true },
  EventSourceImpl: { type: Function, default: undefined },
});

const factory = useFactory({ fetchImpl: props.fetchImpl, EventSourceImpl: props.EventSourceImpl });
const { health, skills, runs, output, followed, error, available } = factory;

const form = reactive({ repo: '', provider: '', model: '', mode: 'prompt', skill: '', prompt: '' });

const repos = computed(() => health.value?.repos ?? []);
const providers = computed(() => health.value?.providers?.available ?? []);

// Until the user picks, the form shows the first repo and the server's default provider.
const repo = computed(() => form.repo || repos.value[0] || '');
const provider = computed(() => {
  if (form.provider) return form.provider;
  const preferred = health.value?.providers?.default;
  return providers.value.includes(preferred) ? preferred : (providers.value[0] ?? '');
});

const canRun = computed(() => available.value && repo.value && provider.value
  && (form.mode === 'skill' ? form.skill : form.prompt.trim()));

function run() {
  return factory.start({
    repo: repo.value,
    provider: provider.value,
    model: form.model.trim(),
    prompt: form.prompt.trim(),
    skill: form.mode === 'skill' ? form.skill : '',
  });
}

const FIELD = 'rounded-control border border-line bg-surface px-2 py-1 text-sm text-ink-soft focus:border-accent focus:outline-hidden disabled:opacity-40';
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="bg-surface border border-line rounded-card shadow-panel p-4">
      <h2 class="font-bold text-ink-strong">{{ t('factory.title') }}</h2>
      <p class="mt-1 text-sm text-ink-soft">{{ t('factory.intro') }}</p>
    </div>

    <p v-if="!available" data-test="factory-unavailable" class="text-xs text-question-on-soft">
      <Icon name="warning" emoji="⚠" /> {{ t('factory.unavailable') }} {{ t('factory.startHint') }}
    </p>
    <p v-else-if="providers.length === 0" data-test="factory-no-provider" class="text-xs text-question-on-soft">
      <Icon name="warning" emoji="⚠" /> {{ t('factory.noProvider') }}
    </p>
    <p v-else-if="repos.length === 0" data-test="factory-no-repos" class="text-xs text-question-on-soft">
      <Icon name="warning" emoji="⚠" /> {{ t('factory.noRepos') }}
    </p>

    <form class="bg-surface border border-line rounded-card shadow-panel p-4 flex flex-col gap-3" @submit.prevent="run">
      <div class="flex flex-wrap gap-3">
        <label class="flex flex-col gap-1 text-xs text-ink-muted">{{ t('factory.repo') }}
          <select data-test="factory-repo" :class="FIELD" :value="repo" :disabled="!available" @change="form.repo = $event.target.value">
            <option v-for="name in repos" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-muted">{{ t('factory.provider') }}
          <select data-test="factory-provider" :class="FIELD" :value="provider" :disabled="!available" @change="form.provider = $event.target.value">
            <option v-for="name in providers" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-muted">{{ t('factory.model') }}
          <input v-model="form.model" data-test="factory-model" :class="FIELD" :placeholder="t('factory.modelPlaceholder')" :disabled="!available">
        </label>
      </div>

      <div class="flex gap-4 text-sm text-ink-soft">
        <label class="flex items-center gap-1">
          <input v-model="form.mode" data-test="factory-mode-prompt" type="radio" value="prompt"> {{ t('factory.modePrompt') }}
        </label>
        <label class="flex items-center gap-1">
          <input v-model="form.mode" data-test="factory-mode-skill" type="radio" value="skill"> {{ t('factory.modeSkill') }}
        </label>
      </div>

      <label v-if="form.mode === 'skill'" class="flex flex-col gap-1 text-xs text-ink-muted">{{ t('factory.skill') }}
        <select v-model="form.skill" data-test="factory-skill" :class="FIELD" :disabled="!available">
          <option value="">{{ t('factory.skillNone') }}</option>
          <option v-for="skill in skills" :key="skill.id" :value="skill.id">{{ skill.id }}</option>
        </select>
      </label>

      <label class="flex flex-col gap-1 text-xs text-ink-muted">{{ form.mode === 'skill' ? t('factory.extraPrompt') : t('factory.prompt') }}
        <textarea v-model="form.prompt" data-test="factory-prompt" rows="4" :class="FIELD" :disabled="!available" />
      </label>

      <p v-if="error" data-test="factory-error" class="text-xs text-question-on-soft"><Icon name="warning" emoji="⚠" /> {{ error }}</p>

      <div>
        <button
          type="submit"
          data-test="factory-run"
          :disabled="!canRun"
          class="whitespace-nowrap rounded-control bg-accent px-3 py-1 text-sm font-medium text-on-accent hover:bg-accent-strong disabled:opacity-40 disabled:cursor-not-allowed"
        >{{ t('factory.run') }}</button>
      </div>
    </form>

    <div class="bg-surface border border-line rounded-card shadow-panel p-4">
      <h3 class="font-semibold text-ink-strong text-sm">{{ t('factory.runs') }}</h3>
      <p v-if="runs.length === 0" data-test="factory-no-runs" class="mt-2 text-xs text-ink-faint">{{ t('factory.noRuns') }}</p>
      <ul v-else class="mt-2 flex flex-col gap-1 text-sm">
        <li v-for="item in runs" :key="item.id" :data-test="`factory-run-row-${item.id}`" class="flex flex-wrap items-center gap-2">
          <span class="font-medium text-ink">{{ item.repo }}</span>
          <span class="text-xs text-ink-faint">{{ item.skill ?? 'prompt' }} · {{ item.provider }}</span>
          <span :class="['text-xs', item.status === 'failed' || item.status === 'timed-out' ? 'text-question-on-soft' : 'text-ink-soft']">{{ t(`factory.status.${item.status}`) }}</span>
          <button type="button" :data-test="`factory-follow-${item.id}`" class="text-xs text-accent hover:underline" @click="factory.follow(item.id)">{{ t('factory.follow') }}</button>
          <button v-if="item.status === 'running'" type="button" :data-test="`factory-stop-${item.id}`" class="text-xs text-accent hover:underline" @click="factory.cancel(item.id)">{{ t('factory.stop') }}</button>
        </li>
      </ul>
    </div>

    <div class="bg-surface border border-line rounded-card shadow-panel p-4">
      <h3 class="font-semibold text-ink-strong text-sm">{{ t('factory.output') }}<span v-if="followed" class="font-normal text-ink-faint"> · {{ followed }}</span></h3>
      <p v-if="!followed" data-test="factory-no-output" class="mt-2 text-xs text-ink-faint">{{ t('factory.noOutput') }}</p>
      <pre v-else data-test="factory-output" class="mt-2 max-h-96 overflow-auto rounded-control bg-surface-muted p-2 text-xs text-ink-soft whitespace-pre-wrap"><template v-for="(line, index) in output" :key="index"><span :class="line.type === 'stderr' ? 'text-question-on-soft' : ''">{{ line.type === 'status' ? `— ${line.text}\n` : line.text }}</span></template></pre>
    </div>
  </div>
</template>
```

- [ ] **Step 5: Route, nav tab and props (test first)**

Append to `apps/board/src/App.test.js`:

```js
test('the AI Factory tab mounts its page', async () => {
  const router = createBoardRouter(createMemoryHistory());
  const w = mount(App, { props: { fetchImpl: routedFetch(), intervalMs: 100000 }, global: { plugins: [router] } });
  await router.isReady();
  await flushPromises();

  await w.get('[data-test=view-factory]').trigger('click');
  await flushPromises();
  expect(router.currentRoute.value.name).toBe('factory');
  expect(w.get('[data-test=factory-run]').exists()).toBe(true);
});
```

Edit `apps/board/src/router.js`: `import FactoryPage from './FactoryPage.vue';` and add `{ path: '/factory', name: 'factory', component: FactoryPage },` after the retro-doc route.

Edit `apps/board/src/App.vue`:

- In `routeProps`, add before the final `return`: `if (route.name === 'factory') return { fetchImpl };`
- After the retro-doc `<router-link>` add:

```vue
          <router-link
            data-test="view-factory" to="/factory"
            :class="['nav-tab rounded-control px-3 py-1 font-medium whitespace-nowrap transition-colors', route.name === 'factory' ? 'bg-surface shadow-panel text-ink-strong' : 'text-ink-muted hover:text-ink-soft']"
          >{{ t('nav.factory') }}</router-link>
```

- [ ] **Step 6: Run the board front-end tests, lint, commit**

Run: `npx vitest run --root apps/board` -> PASS (including `i18n.test.js` locale parity and the new tests). If `App.test.js` has a test asserting the exact list of nav tabs, update it to include the new one.
Run: `npm run lint` -> PASS.

```bash
git add apps/board/src
git commit -m "feat(board): AI Factory tab to launch agents and follow their output"
git push -u origin ccr-2b06c5bb-7ofepa
```

---

### Task 10: Root wiring, docs, changelog, spec sync

**Files:**
- Modify: `package.json`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-10-26-ai-factory-design.md`
- Create: `docs/ai-factory.md`

- [ ] **Step 1: Root `package.json`**

- `bin`: add `"maggie-agents": "apps/agents/bin/agents.js"`.
- `files`: add `"apps/agents/bin"` and `"apps/agents/src"`.
- `dependencies`: add `"@linktogo/maggie-agent-runner": "^1.3.1"`.
- `scripts`: add `"agents": "node apps/agents/bin/agents.js"`.

Run: `npm install` (refreshes `package-lock.json`), then `npm pack --dry-run 2>&1 | grep -E "apps/agents|skills/" | head` and confirm the server files and the skills library are in the tarball (the server reads `skills/` relative to itself).

- [ ] **Step 2: `docs/ai-factory.md`**

````markdown
# AI Factory

Launch local AI coding agents from the board. Three pieces:

| Piece | What it is |
|---|---|
| [`libs/agent-runner`](../libs/agent-runner) | the logic: providers, repo allowlist, skills, run lifecycle |
| `apps/agents` (`maggie-agents`) | an independent Node.js server: HTTP + SSE, bearer token, loopback only |
| the board's **AI Factory** tab | a form and a live console; it relays to the server through `/api/factory/*` |

## Start it

```bash
npm run agents -- --repos repos.json --workspace wk      # the server (default port 4318)
npm start                                                  # the board; open the "AI Factory" tab
```

| Flag | Default | Meaning |
|---|---|---|
| `--repos <file>` | required | repos the agents may run in (same format as `repos.example.json`) |
| `--workspace <dir>` | `wk` | where checkouts live: `<workspace>/<name>`, unless the repo pins a `path` |
| `--provider` | `$MAGGIE_AGENT_PROVIDER`, else `claude-cli` | provider used when a request names none |
| `--port` | `4318` | loopback port |
| `--skills <dir>` | the repository's `skills/` | skills offered by `GET /skills` |
| `--timeout <s>` | `600` | a run is killed after this long |
| `--allow-origin <origin>` | none | an `Origin` the server accepts (repeatable); none by default |
| `--token-file <file>` | `~/.maggie/agents.token` | where the token is written |

Providers are `claude-cli` (`claude -p`) and `copilot` (`copilot --allow-all-tools`); the CLI must be
installed and logged in. A request may override the provider, but only among those two; if its CLI is
missing the run fails with an explicit message (`Could not run ...`), never with a silent fallback.

## Security model

The server executes commands on your machine, so:

- it binds to `127.0.0.1` and refuses any `Host` that is not loopback (DNS rebinding);
- every request needs `Authorization: Bearer <token>`; the token is generated at startup, written to a
  `0600` file and deleted when the server stops. The board reads that file server-side: the browser never
  sees it;
- a request carrying an `Origin` is refused unless allowed with `--allow-origin`;
- clients send a repository **name**, resolved against the allowlist, never a path; skill ids are
  `<techno>/<name>` and cannot leave the skills directory; the model is validated as an identifier;
- one active run per repository, a timeout per run, output kept in memory only (bounded).

**Agent permissions are the CLI's own.** `claude -p` runs with Claude Code's default non-interactive
permissions (it can read, but file edits and shell commands need a permission mode or allowed tools
configured in the target repository's `.claude/settings.json`); `copilot --allow-all-tools` lets Copilot
use every tool without asking. Review what you point an agent at.

## API

| Route | |
|---|---|
| `GET /health` | `{ providers: { available, default }, repos }` |
| `GET /skills` | `{ skills: [{ id, techno, name, description }] }` |
| `POST /runs` | `{ repo, provider?, model?, prompt? , skill? }` (a prompt or a skill) -> `202 { id, run }` |
| `GET /runs`, `GET /runs/:id` | runs, newest first / one run |
| `GET /runs/:id/events` | SSE: `stdout`, `stderr`, `status` events; history replayed, ends on the final status |
| `DELETE /runs/:id` | SIGTERM the agent -> `202` |

Errors: `400` invalid input, `401` bad token, `403` Host/Origin, `404` unknown repo/skill/run, `409` repo
busy, `413` body too large.

## Not in this version

Persistence across restarts, queues, chained workflows, remote execution.
````

- [ ] **Step 3: README, CONTRIBUTING, CHANGELOG**

- `README.md`: in the docs table (near the Retro-documentation row) add `| [AI Factory](docs/ai-factory.md) | Launching local Claude Code / Copilot agents from the board through an independent server |`; in the projects table (near `maggie-retro-doc`) add `| [`@linktogo/maggie-agent-runner`](libs/agent-runner) | run local agent CLIs on a checkout, with streamed output |` and a row for `apps/agents` (`maggie-agents`).
- `CONTRIBUTING.md`: in "Running things locally" add: "`npm run agents -- --repos repos.example.json` starts the AI Factory agents server (see [AI Factory](docs/ai-factory.md)); it needs the `claude` or `copilot` CLI to actually run an agent, tests never do." Also extend the tests list: `apps/{sync,workspace,agents}/test/*.test.js`.
- `CHANGELOG.md`, under `## [Unreleased]`:

```markdown
### Added

- **AI Factory.** A new `maggie-agents` server (`npm run agents`) runs Claude Code or GitHub Copilot
  CLI agents on the repositories of the config, and a new **AI Factory** tab in the board launches them
  and streams their output. The server is independent of the board (loopback only, bearer token kept in
  a `0600` file, repository allowlist, one run per repository). Logic lives in the new
  `@linktogo/maggie-agent-runner` library. See `docs/ai-factory.md`.
```

- [ ] **Step 4: Sync the spec with what was built**

In `docs/superpowers/specs/2026-10-26-ai-factory-design.md`:
- `GET /health` row: "providers disponibles, provider par défaut **et repos autorisés**".
- `POST /runs` row: "-> `202 {id, run}`".
- Security paragraph: "`Origin` absent ou présent dans `--allow-origin` (vide par défaut : le proxy du board n'envoie pas d'Origin)".
- Status line: "**Statut** : Validé".

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json README.md CONTRIBUTING.md CHANGELOG.md docs
git commit -m "docs: document the AI Factory and wire the agents server into the root package"
```

---

### Task 11: Full verification and smoke test

**Files:** none (fix forward in the relevant task's files if something fails)

- [ ] **Step 1: Whole gate**

Run: `npm test && npm run lint && npm run test:board && npm run build`
Expected: every target passes; `agent-runner` and `agents` report 100% coverage; the board builds.

- [ ] **Step 2: End-to-end smoke test with a stub `claude`**

```bash
SMOKE=$(mktemp -d)
mkdir -p "$SMOKE/bin" "$SMOKE/wk/example-api"
printf '#!/bin/sh\necho "stub claude got:"; cat\n' > "$SMOKE/bin/claude" && chmod +x "$SMOKE/bin/claude"
PATH="$SMOKE/bin:$PATH" node apps/agents/bin/agents.js --repos repos.example.json --workspace "$SMOKE/wk" --port 4399 --token-file "$SMOKE/token" &
sleep 1
TOKEN=$(cat "$SMOKE/token")
curl -s -H "Authorization: Bearer $TOKEN" localhost:4399/health
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"repo":"example-api","prompt":"hello"}' localhost:4399/runs
curl -sN -H "Authorization: Bearer $TOKEN" localhost:4399/runs/run-1/events
curl -s -o /dev/null -w '%{http_code}\n' localhost:4399/health            # expect 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" -H 'Origin: http://evil.example' localhost:4399/health   # expect 403
kill %1
```

Expected: `/health` lists `claude-cli` and the repos of `repos.example.json`; the run starts (202); the SSE stream prints `stub claude got:` then `hello` in `stdout` events and ends with `"status":"succeeded"`; the two last calls print `401` and `403`; after `kill`, `$SMOKE/token` is gone.

- [ ] **Step 3: Board relay smoke test**

Start the agents server again as above on the default port with `--token-file ~/.maggie/agents.token` (or pass `--agents-token-file "$SMOKE/token"` to the board), run `npm start` in another shell and open the **AI Factory** tab: repos and providers appear, a run shows live output, **stop** works. Stop the agents server and reload the tab: the "not reachable" notice with the start command appears.

- [ ] **Step 4: Final push**

```bash
git status --short          # expect clean
git push -u origin ccr-2b06c5bb-7ofepa
```

Report to the user: what was built, the test and coverage output, and the open point on agent permissions (see `docs/ai-factory.md`, "Agent permissions are the CLI's own"). Do not open a pull request unless asked.

---

## Self-review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| Free prompt or skill | 3 (`buildPrompt`, `loadSkill`), 5 (`POST /runs`), 9 (form) |
| Provider default on server + per-request override among `claude-cli`/`copilot`; absent CLI fails explicitly | 2 (`resolveProvider`), 4 (ENOENT -> failed), 5, 6 (`--provider`, env) |
| Loopback + bearer token + Host/Origin + repo allowlist | 5 (guards), 3 (`createRepoResolver`), 6 (token file `0600`) |
| SSE with replayed history | 4 (`subscribe`), 5 (`/runs/:id/events`), 8-9 (client) |
| Memory only | 4 (`maxEvents`, `maxRuns`) |
| `libs/agent-runner` + `apps/agents` + board tab and proxy | Tasks 1-9 |
| Token never in the browser | 7 (proxy), 8 (composable only talks to `/api/factory`) |
| One active run per repo, timeout, model regex, cancel | 4 |
| `GET /skills`, `GET /health`, `GET/POST/DELETE /runs` | 5 |
| 4 locales, unreachable-server state with start command | 9 |
| 100% coverage, Nx projects, `npm run agents`, docs, changelog | 1, 5, 6, 10, 11 |

Spec deltas are recorded in Task 10, step 4 (`/health` also returns the allowed repos; `POST /runs` returns `{id, run}`; `Origin` allowlist defaults to empty).

**Placeholder scan:** no TBD/TODO; every code step carries the code. No duplicated or deferred code remains.

**Type consistency:** `createRunManager` returns `{ start, cancel, get, list, subscribe }` and the server uses exactly those; `TERMINAL` is a `Set` in the lib and used with `.has` in the server and `.includes` on a plain array in the browser (separate list `FINAL`); `AgentError` codes match `STATUS_BY_CODE`; the run view fields match between `run.js`, the tests and the page (`id, repo, provider, skill, status`); `createAgentsServer` takes `providers: { detect, defaultProvider }` in both `main.js` and the tests; the proxy signature `(req, res, pathname, search)` matches its call in `server.js` and in both test files.
