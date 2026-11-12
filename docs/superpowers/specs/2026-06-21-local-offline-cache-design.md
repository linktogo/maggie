# Local offline-friendly install cache — design

**Date:** 2026-06-21
**Status:** Approved (pending implementation)

## Problem

`bin/workspace.js` bootstraps a workspace by cloning repos and installing their
dependencies. Today the install step is Node-only and always online:

```js
if (install && (await exists(path.join(workDir, 'package.json')))) {
  await exec(pnpmCommand(), ['install'], { cwd: workDir });
}
```

On a slow or intermittent network, this is the bottleneck — every bootstrap (and
every fresh clone produced by the new reinstall/timestamp options) re-fetches
dependencies over the wire. We want installs to come from a **local cache**
instead, and we want the bootstrap to also handle **Maven** projects, not just
Node.

## Goals

- Make `pnpm` installs cache-first so a slow network is not on the critical path.
- Add a **Maven** install step (`dependency:go-offline`) alongside the existing
  pnpm step, also cache-first.
- Offer a strict **`--offline`** mode that fails when something is not cached.
- Keep `bootstrap` readable and each ecosystem independently testable.

## Non-goals

- No shared cache server / mirror (Verdaccio, Nexus, Artifactory). Single machine
  only.
- No new bespoke cache store. We reuse the package managers' existing global
  caches.
- No separate "warm the cache" command — the cache fills naturally on the first
  online bootstrap.
- No per-repo install commands in `repos.json` (rejected as over-engineered for
  two ecosystems).

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Driving scenario | Offline / slow network |
| Cache scope | This machine only — reuse existing global caches |
| Ecosystems | Node (pnpm) **and** Maven, now |
| Maven goal | `dependency:go-offline` (deps only, mirrors `pnpm install`) |
| Offline strictness | Soft by default (`--prefer-offline` / cache-first) + a strict `--offline` flag |
| Code structure | Installer registry (Approach A) |

## Cache model

**No new cache is created.** We rely on the package managers' default global
caches and only force cache-first behaviour:

- **pnpm** → content-addressable store (e.g. `~/Library/pnpm/store`). Installs
  hardlink from the store and are already near-offline once populated.
- **Maven** → local repository `~/.m2/repository`. Maven already resolves from it
  first and only reaches the network for missing/snapshot artifacts.

Behaviour matrix:

| | Soft (default) | Strict (`--offline`) |
|---|---|---|
| pnpm | `pnpm install --prefer-offline` | `pnpm install --offline` |
| maven | `mvn dependency:go-offline` | `mvn -o dependency:go-offline` |

The cache populates on the first online bootstrap. A useful side effect: the
reinstall/timestamp fresh-clone options reinstall quickly because the store and
`~/.m2` are shared across every checkout on the machine.

## Architecture

```
src/installers.js   NEW: installer registry + planInstall()
src/platform.js     + mavenCommand() (resolves ./mvnw or mvn, .cmd on Windows)
src/workspace.js    bootstrap(): pnpm branch → planInstall()+exec(); main: --offline flag
bin/workspace.js    unchanged (no interactivity here)
```

### `src/installers.js`

A declarative registry. Each entry is one ecosystem, testable in isolation.

```js
import path from 'node:path';
import { pnpmCommand, mavenCommand } from './platform.js';

const INSTALLERS = [
  {
    name: 'node',
    marker: 'package.json',
    label: 'pnpm',
    resolve: (workDir, { platform, offline }) => ({
      command: pnpmCommand(platform),
      args: ['install', offline ? '--offline' : '--prefer-offline'],
    }),
  },
  {
    name: 'maven',
    marker: 'pom.xml',
    label: 'mvn',
    resolve: async (workDir, { exists, platform, offline }) => ({
      command: await mavenCommand(workDir, { exists, platform }),
      args: offline ? ['-o', 'dependency:go-offline'] : ['dependency:go-offline'],
    }),
  },
];

// Returns { name, label, command, args } for the first matching installer, or
// null when no marker file is present in workDir.
export async function planInstall(workDir, { exists, platform = process.platform, offline = false } = {}) {
  for (const inst of INSTALLERS) {
    if (await exists(path.join(workDir, inst.marker))) {
      const { command, args } = await inst.resolve(workDir, { exists, platform, offline });
      return { name: inst.name, label: inst.label, command, args };
    }
  }
  return null;
}
```

- **First match wins.** For a repo carrying both markers, `node` precedes
  `maven`. No multi-ecosystem install in one repo for now (YAGNI). Documented.

### `src/platform.js` — `mavenCommand`

Resolves the Maven binary, preferring the repo's wrapper for reproducibility,
following the same OS convention already used by `pnpmCommand` (see the
`platform-aware-cli-commands` skill):

- If the repo has a Maven wrapper (`mvnw` on POSIX, `mvnw.cmd` on Windows), return
  the absolute path to it.
- Otherwise return the system `mvn` (`mvn.cmd` on Windows).

```js
export async function mavenCommand(workDir, { exists, platform = process.platform } = {}) {
  const wrapperName = platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
  const wrapper = path.join(workDir, wrapperName);
  if (await exists(wrapper)) return wrapper;
  return platform === 'win32' ? 'mvn.cmd' : 'mvn';
}
```

### `src/workspace.js`

**`bootstrap`** — replace the Node-only install branch with the generic plan:

```js
let installed = false;
if (install) {
  const plan = await planInstall(workDir, { exists, offline });
  if (plan) {
    if (!dryRun) await exec(plan.command, plan.args, { cwd: workDir });
    logger.log(`  ${tag}${repo.name}: ${dryRun ? 'would' : 'ran'} ${plan.label} install`
             + `${offline ? ' (offline)' : ''}`);
    installed = true;
  }
}
results.push({ repo: repo.name, status, installed });
```

- New option `offline = false`, threaded into `planInstall`.
- `results` shape is unchanged: `{ repo, status, installed }`.
- `dryRun` runs no `exec`; logs `would <label> install (offline)`.
- No marker present → `planInstall` returns `null` → `installed: false`.

**`main`** — add a `--offline` boolean flag (default `false`) to `parseArgs`, and
forward it: `runBootstrap(config, { … offline: values.offline })`. Independent of
interactivity — there is no prompt for it.

## Testing (100% coverage gate on `src/`)

- **`test/installers.test.js`** (new) — `planInstall` with a mocked `exists`:
  - node marker → `pnpm install --prefer-offline`; with `offline` → `--offline`.
  - maven marker → `dependency:go-offline`; with `offline` → `-o dependency:go-offline`.
  - maven wrapper present vs absent → correct command.
  - no marker → `null`.
- **`test/platform.test.js`** — `mavenCommand`: wrapper present/absent, `win32`
  vs posix (`.cmd`).
- **`test/workspace.test.js`** — updates:
  - exec assertions move from `args: ['install']` to `['install', '--prefer-offline']`.
  - dry-run log assertions updated from `'would pnpm install'` to the new wording.
  - new end-to-end test through `main` asserting `received.offline` is forwarded.
  - new Maven-repo test (clone + `dependency:go-offline`).

## Known limitation

`mvn dependency:go-offline` does not always pre-fetch **every** artifact a real
build needs — some plugins resolve dependencies lazily at build time. For a
*guaranteed* offline build of a complex Maven project, a real mirror/repository
manager would be required (the "shared server" option we deliberately rejected).
This is a known Maven behaviour, not a tool defect. The soft default keeps slow
networks off the critical path; strict `--offline` surfaces any gap loudly.
