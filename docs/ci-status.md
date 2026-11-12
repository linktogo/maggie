# CI status

Each board card carries one badge per contributor, coloured by that person's
latest CI outcome for the repo — red failure, blue in-progress, grey
cancelled/skipped, green success — sorted worst-first and capped at four with a
`+N` overflow. The detail panel breaks the same information down per
contributor with a link to the run, and the filter bar gains a `CI` selector.

## How it works

Managed repos **push** their status; the board only reads.

```
managed repo, CI finishes
  └─ composite action ─ commit + push ─┐
                                       ▼
              maggie @ ci-status : updates/<login>/<repo>.json
                                       │
        board server, every 60s ─ fetch + reset ─┘   (read-only)
                    │
                    ├─ rebuild <board dir>/ci.json
                    └─ GET /api/ci  (serves the cache, never the network)
```

Push rather than polling the GitHub API keeps the dashboard off the rate limit
and means it needs no token with read access to every managed repo. Each repo
instead holds a credential scoped to writing one branch here.

The drop zone holds exactly one file per (contributor, repo), at a fixed path,
overwritten on each run — so it never grows unbounded and needs no cleanup.

## Setup

### 1. Seed the drop branch (once, in this repository)

```sh
git checkout --orphan ci-status
git rm -rf .
mkdir updates && touch updates/.gitkeep
git add -A && git commit -m "chore: seed ci-status drop branch"
git push -u origin ci-status
git checkout main
```

An orphan branch keeps these commits out of the code history, and `ci.yml` only
listens on `main`, so deposits never trigger this repo's own CI.

Until the branch exists the board logs one warning and shows no statuses. It
does not fail.

### 2. Report from each managed repo

Create an `AI_SYNC_STATUS_TOKEN` secret in the repo — a fine-grained token with
**Contents: write** on `linktogo/maggie` — then add
`.github/workflows/maggie-status.yml`:

```yaml
name: maggie status
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: linktogo/maggie/.github/actions/ci-status-report@main
        with:
          token: ${{ secrets.AI_SYNC_STATUS_TOKEN }}
```

Alternatively, drop the same `uses:` block as a final `if: always()` step inside
an existing CI job.

The `workflow_run` form is preferred: it sees the conclusion of the whole
workflow, including `cancelled`, and leaves the existing CI file untouched. The
in-job form avoids a second workflow run, but only sees its own job and reports
nothing when the run is cancelled.

| Action input | Required | Default |
|---|---|---|
| `token` | yes | — |
| `status-repo` | no | `linktogo/maggie` |
| `branch` | no | `ci-status` |

`status-repo` also accepts a full URL, which is how a GitHub Enterprise host is
targeted.

### 3. Point the board at the branch

```sh
AI_SYNC_STATUS_REPO=https://github.com/linktogo/maggie.git npm start
```

| Flag | Env | Default |
|---|---|---|
| `--status-repo` | `AI_SYNC_STATUS_REPO` | none — CI status disabled |
| — | `AI_SYNC_STATUS_TOKEN` | none — uses ambient git credentials |
| `--ci-interval` | — | `60` (seconds) |
| `--ci-state` | — | `<board dir>/ci.json` |
| `--ci-cache` | — | `<board dir>/ci-status` |

## Behaviour

**States.** `success`, `failure` (also `timed_out`, `startup_failure`,
`action_required`), `running` (anything not yet completed), `neutral`
(`cancelled`, `skipped`, `stale`), and `none` when nobody has reported.

The action sends the raw `status`/`conclusion` pair; the board maps it. That
means the mapping can be corrected without redeploying every managed repo.

**Filter semantics.** *en échec* = at least one contributor failing. *OK* = at
least one contributor and none failing or running — so a repo where every latest
run was cancelled counts as OK. *inconnu* = nobody has reported.

**Nothing is silent.** Without `--status-repo` no git command runs at all, every
repo reports as unavailable, and the board shows a banner saying so — a
misconfiguration looks different from a repo that has simply never run CI.

**A failed sync preserves state.** `/api/ci` serves the local cache and never
touches the network. When a sync fails the previously cached statuses stay
exactly as they were and `lastSyncError` is set, which the UI surfaces as a
"désynchronisé" banner. A stale green is never silently replaced by an empty
board.

**Nothing expires.** A contributor who leaves the team keeps a badge until their
file is removed from `updates/<login>/` by hand. Automatic expiry was considered
and rejected: the branch is bounded by contributors × repos anyway, and a
wrongly-tuned retention window would blank a badge that is actually current.

## Payload

`updates/<login>/<repo>.json`:

```json
{
  "repo": "example-api",
  "actor": "fabien",
  "runId": 42,
  "status": "completed",
  "conclusion": "failure",
  "workflow": "CI",
  "branch": "feat/x",
  "event": "push",
  "url": "https://github.com/linktogo/example-api/actions/runs/42",
  "startedAt": "2026-07-29T18:40:00.000Z",
  "sentAt": "2026-07-29T18:41:12.000Z"
}
```

`actor` is duplicated inside the payload even though it is already the folder
name, so a file that lands in the wrong folder is rejected rather than silently
reattributed.

## Concurrency

Two runs finishing at once push to the same branch. The action's deposit loop
fetches, resets hard to the remote, rewrites its own single file, commits and
pushes non-force — retrying up to five times with backoff. Resetting rather than
rebasing means there is never a merge conflict to resolve, and a `runId`
comparison on each attempt stops two runs landing out of order from
flip-flopping the file.
