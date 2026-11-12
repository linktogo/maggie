# @linktogo/maggie-ci-status

CI status payloads for [maggie](https://github.com/linktogo/maggie): build one
from a GitHub Actions run, validate one read back from disk, and fold a set of
them into per-repo, per-contributor state.

Pure functions only — no I/O, no git, no network. The composite action uses it
to produce a status file; the board server uses it to consume one.

```js
import { buildUpdate, parseUpdate, buildState, normalizeState } from '@linktogo/maggie-ci-status';

// In a GitHub Actions runner: build the payload from either trigger context
const update = buildUpdate(process.env, event, new Date().toISOString());

// Reading it back: validate against the path it was found at
const parsed = parseUpdate(raw, { login: 'fabien', repo: 'example-api' });
if (!parsed.ok) console.warn(parsed.reason);

// Fold many into { repos: { <repo>: { users: { <login>: entry } } } }
const state = buildState(entries, new Date().toISOString());

normalizeState('completed', 'timed_out'); // → 'failure'
```

| Export | Purpose |
|---|---|
| `buildUpdate(env, event, now)` | Build a payload from a `workflow_run` event or from an in-job step context. |
| `parseUpdate(raw, { login, repo })` | Validate one status file, including that it matches the path it sits at. Never throws. |
| `buildState(entries, now)` | Fold `{ login, repo, update }` triples into per-repo, per-contributor state. |
| `normalizeState(status, conclusion)` | Map a run to `success`, `failure`, `running` or `neutral`. |
| `rankState(state)` | Total order used to sort worst-first and to aggregate. |
| `redactToken(message, token)` | Replace a token with `***` in an error message. |
| `statusRepoUrl(statusRepo, token)` | Build the clone URL for `owner/name`, passing a full URL through unchanged. |

See [CI status](https://github.com/linktogo/maggie/blob/main/docs/ci-status.md)
for how the pieces fit together.
