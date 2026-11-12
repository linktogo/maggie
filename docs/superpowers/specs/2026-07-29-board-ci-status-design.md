# Board CI Status — Design

**Date:** 2026-07-29
**Status:** Approved (pending written-spec review)

## Purpose

The workspace board answers "what is Claude doing in each repo?" but says
nothing about whether the work actually passes CI. A repo can sit in `done`
with a red pipeline and the board looks identical to one that is green.

This feature puts each managed repo's latest CI outcome on its board card,
**per contributor**, using a push model: every managed repo reports its CI
result through a GitHub Action that commits a status file into a single
orphan branch of this repository. Every board server reads that branch and
renders one badge per user per repo.

Push was chosen over the board polling the GitHub REST API. Polling N private
repos every few seconds burns the 5000 req/hr limit and requires the dashboard
to hold a token with read access to every managed repo. In the push model the
dashboard reads exactly one repository.

## Decisions (locked during brainstorming)

- **Push, not poll.** No `api.github.com` calls from the board server.
- **One branch: the orphan branch `ci-status` of `linktogo/ai-sync`.** Not one
  branch per user, not a separate repository. An orphan branch keeps
  CI-status commits out of the code history, and `ci.yml` only listens on
  `main`, so deposits never trigger this repo's CI.
- **The drop zone is partitioned by user, and holds state rather than
  events:** `updates/<login>/<repo>.json`, exactly one file per (user, repo).
  The path is fixed, so a new run *overwrites* the contributor's previous file
  for that repo. The branch size is therefore bounded by
  `contributors × repos` and needs no garbage collection.
- **The dashboard is a pure reader.** It never writes to `ci-status`. This is
  a direct consequence of every board reading every user's folder: if boards
  also deleted, two dashboards running at once would erase each other's
  unread updates, and a board stopped for a week would miss everything
  consumed meanwhile. Server-side deletion was the original intent and was
  dropped for this reason — bounding the branch is achieved by overwriting at
  deposit time instead. Removing it also removes all push, retry and locking
  code from the server, and every write credential from the dashboard side.
- **Transport is git clone/commit/push**, not the GitHub Contents API. The
  retry cost this implies is paid once, in a shared composite action, rather
  than duplicated across N repo workflows.
- **Both trigger styles are supported**, chosen per repo: a standalone
  `workflow_run: completed` workflow (non-intrusive, sees the whole
  workflow's real conclusion including `cancelled`), or a final
  `if: always()` step inside an existing CI job (no second run, but only sees
  that one job and reports nothing when the run is cancelled).
- **The action sends raw `status`/`conclusion`; the server normalizes.** The
  mapping to display states can then be corrected without redeploying every
  managed repo.
- **Explicit per-repo state, never silent.** Unknown is a rendered state with
  a reason, so a misconfigured setup is distinguishable from a repo that has
  no CI.
- **Not built:** a CI count tile in `SummaryHeader` (the badges and the filter
  already surface failures); any history or timeline of past runs (only the
  latest run per user per repo is kept).

## Architecture overview

```text
managed repo, CI finishes
  │
  └─ .github/actions/ci-status-report (composite, hosted here)
        │  node report.js → buildUpdate(env, event)
        │  clone ci-status, write updates/<login>/<repo>.json
        └─ on rejection: fetch + reset --hard + rewrite + push, 5 attempts
                    │
                    ▼
        linktogo/ai-sync @ ci-status
            updates/fabien/lk-myasso.json
            updates/fabien/lk-mind.json
            updates/alice/lk-myasso.json
                    │
  board server tick (default 60s, in-flight lock) — READ ONLY
        │
        ├─ git fetch origin ci-status && git reset --hard origin/ci-status
        ├─ read updates/*/*.json → parseUpdate → buildState
        └─ write wk/.ai-sync/ci.json (atomic: temp + rename)  ← cache
                    │
        GET /api/ci ─┴─ reads ci.json only, never the network
                    │
        useCi.js (poll 30s) → App.vue → Column → Card (badges per user)
                                     → RepoDetail (breakdown per user)
                                     → FilterBar (CI filter)
```

## Components

### `libs/ci-status` (new lib, `@ai-sync/ci-status`)

Same shape as `libs/git`: `package.json`, `project.json` with the
`node --test` 100% line/function/branch command, `src/ci-status.js`,
`test/ci-status.test.js`. Pure functions only — no I/O, no git, no network.

| Export | Signature | Behaviour |
|---|---|---|
| `buildUpdate` | `(env, event) → update` | Resolves the payload from **either** context. `env.GITHUB_EVENT_NAME === 'workflow_run'` → reads `event.workflow_run` (`conclusion`, `head_branch`, `html_url`, `run_started_at`, `id`, `name`, `event`, `actor.login`). Otherwise → reads the `github.*` context vars plus `JOB_STATUS`. Both branches emit the identical shape. |
| `normalizeState` | `(status, conclusion) → state` | `status !== 'completed'` → `running`. Else `success` → `success`; `failure`/`timed_out`/`startup_failure`/`action_required` → `failure`; `cancelled`/`skipped`/`neutral`/`stale` → `neutral`; anything unrecognised → `neutral`. |
| `rankState` | `(state) → number` | Total order used for both badge sorting and aggregation: `failure` < `running` < `neutral` < `success` < `none`. One definition, so the card ordering and the filter can never disagree. |
| `parseUpdate` | `(raw, {login, repo}) → {ok, update} \| {ok:false, reason}` | Parses and validates one status file. Rejects bad JSON, missing `repo`/`runId`/`status`/`actor`, wrong types, and a payload whose `actor`/`repo` disagree with the path it was found at. Never throws. |
| `buildState` | `(entries, now) → state` | Folds `{login, repo, update}` triples into `{repos: {<repo>: {users: {<login>: entry}}}}`. When the same (user, repo) appears twice — only possible from a malformed branch — the higher `runId` wins. |

`initials(login)` lives in `apps/board/src/ciBadge.js`, not here: it is
presentation, and belongs with the component it serves.

### `.github/actions/ci-status-report/` (new composite action)

`action.yml` inputs: `token` (required), `status-repo` (default
`linktogo/ai-sync`), `branch` (default `ci-status`).

`report.js` calls `buildUpdate`, then drives git through `libs/ci-status` and
`libs/git` by relative import — both have zero dependencies, so the runner
needs no `npm install`, and the import is version-locked to the ref the action
was referenced at.

**Deposit algorithm** (up to 5 attempts, backoff between them):

1. `git fetch origin ci-status && git reset --hard origin/ci-status`
2. Read `updates/<login>/<repo>.json` if present. If its `runId` is **greater
   than** ours, exit successfully — a newer run already reported, and ours is
   stale.
3. Write our payload, commit, `git push` (non-force).
4. On rejection, go back to step 1.

Resetting rather than rebasing is what keeps this deterministic: there is
never a merge conflict to resolve, because each attempt rewrites our single
file on top of whatever the remote currently holds. The `runId` comparison in
step 2 is what stops two out-of-order runs from flip-flopping the file.

Consumer usage, standalone workflow form:

```yaml
name: ai-sync status
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: linktogo/ai-sync/.github/actions/ci-status-report@main
        with:
          token: ${{ secrets.AI_SYNC_STATUS_TOKEN }}
```

In-job form: the same `uses:` block as a final step with `if: always()`.

### `apps/board` — server side

- `ciReader.js`: `createCiReader({ statusRepo, token, stateFile, cacheDir, exec, intervalMs, now })`
  exposing `tick()` (one fetch-and-rebuild cycle) and `read()` (the current
  state for `/api/ci`, no git). `exec` is injected exactly as `libs/git` does,
  so every path is testable without git or network. It holds no write path at
  all.
- `server.js`: builds the reader in `createBoardServer`, adds
  `if (url.pathname === '/api/ci') return await serveCi(...)`, and starts the
  interval.
- `libs/git`: `push()` currently runs `git push -f`. Force-pushing `ci-status`
  from the action would drop the files other users pushed between our fetch
  and our push. Add a `{ force = false }` option to `push(branch, opts)`; the
  existing caller in the sync pipeline passes `force: true` explicitly so its
  behaviour is unchanged.

### `apps/board` — client side

- `useCi.js`: polls `/api/ci` every 30s. Self-starting, `onUnmounted`
  cleanup, injectable `fetchImpl` — same contract as `useBoard.js`.
- `ciBadge.js`: `initials(login)` and `visibleBadges(users, max = 4)`, which
  sorts by `rankState` and returns `{shown, overflow}`. Pure, unit-tested.
- `Card.vue`: a row of pills right of the repo name, one per contributor,
  each showing that user's initials coloured by their CI state — `failure`
  red, `running` blue `animate-pulse`, `neutral` slate, `success` emerald.
  Sorted worst-first, so a failure is always among the first four. Beyond
  four, a grey `+N` pill carries the full list in its `title`. Card height
  stays bounded whatever the number of contributors.
- `Column.vue`: relays a `ci` prop down to `Card`. Its only change.
- `RepoDetail.vue`: an `Intégration continue` block before `Historique`, one
  line per contributor — login, workflow name, branch, conclusion, relative
  time, and a link to the run. The relative time is what guards against a
  stale green: a three-day-old success stays green but is visibly dated.
- `FilterBar.vue`: a third `<select>` — `CI : tous / en échec / OK / inconnu`.
  Semantics, defined once and computed with `rankState`: **en échec** = at
  least one contributor in `failure`; **OK** = at least one contributor and
  none in `failure` or `running`; **inconnu** = no contributor has reported.
  Labels are French, matching the rest of the UI.

## Data contracts

Status file at `updates/<login>/<repo>.json`:

```json
{
  "repo": "lk-myasso",
  "actor": "fabien",
  "runId": 42,
  "status": "completed",
  "conclusion": "failure",
  "workflow": "CI",
  "branch": "feat/x",
  "event": "push",
  "url": "https://github.com/linktogo/lk-myasso/actions/runs/42",
  "startedAt": "2026-07-29T18:40:00.000Z",
  "sentAt": "2026-07-29T18:41:12.000Z"
}
```

`actor` is duplicated inside the payload even though it is already the folder
name, so a file remains self-describing if it is ever moved or copied, and so
`parseUpdate` can reject a file that landed in the wrong folder.

Local cache, `wk/.ai-sync/ci.json` (beside `board.json`; overridable with
`--ci-state`). Rewritten wholesale each tick — the branch is the source of
truth, this is only what lets `/api/ci` answer without touching git and keeps
the board readable while offline:

```json
{
  "version": 1,
  "lastSyncAt": "2026-07-29T18:41:30.000Z",
  "lastSyncError": null,
  "repos": {
    "lk-myasso": {
      "users": {
        "fabien": { "runId": 42, "status": "completed", "conclusion": "failure",
                    "workflow": "CI", "branch": "feat/x", "event": "push",
                    "url": "https://github.com/…", "startedAt": "…",
                    "receivedAt": "…" },
        "alice":  { "runId": 41, "status": "completed", "conclusion": "success",
                    "…": "…" }
      }
    }
  }
}
```

`GET /api/ci` — `state` is computed at read time by `normalizeState`:

```json
{
  "generatedAt": "2026-07-29T18:41:35.000Z",
  "lastSyncError": null,
  "repos": {
    "lk-myasso": { "users": {
      "fabien": { "state": "failure", "run": { "…": "as stored above" } },
      "alice":  { "state": "success", "run": { "…": "…" } } } },
    "lk-mind":   { "users": {} }
  }
}
```

State resolution, in order:

1. **Reader not configured** (no status repo) — every entry is
   `{ users: {}, unavailable: "status repo not configured" }`. This is a
   global condition, never per-repo.
2. **Configured, no contributor has reported for that repo** — `users: {}`,
   rendered as `none`.
3. **Configured, contributors present** — one `state` per contributor.

A repo present in `ci.json` but absent from the board is not returned. A
transient sync failure changes no state; it only sets `lastSyncError`.

## Configuration

| Setting | Source (first wins) | Default |
|---|---|---|
| Status repo URL | `--status-repo`, `AI_SYNC_STATUS_REPO` | none — reader disabled |
| Read token (optional) | `AI_SYNC_STATUS_TOKEN` | none — falls back to the machine's ambient git credentials, which already clone this repo |
| Reader interval | `--ci-interval <seconds>` | 60 |
| Cache file | `--ci-state <path>` | `<dirname(boardPath)>/ci.json` |
| Clone cache dir | `--ci-cache <path>` | `<dirname(boardPath)>/ci-status` |

When a token is supplied it is injected into the clone URL as
`https://x-access-token:$TOKEN@github.com/…` and must never reach a log line —
including the existing `board on http://… (data: …)` startup message.

## Prerequisite

The orphan branch must exist before the first deposit:

```sh
git checkout --orphan ci-status
git rm -rf .
mkdir updates && touch updates/.gitkeep
git add -A && git commit -m "chore: seed ci-status drop branch"
git push -u origin ci-status
git checkout main
```

Until it exists the clone fails; that is treated as "no statuses", logged
once, and does not crash the server. This goes in the README, alongside the
per-repo setup (the `AI_SYNC_STATUS_TOKEN` secret and one of the two workflow
forms).

## Error handling

| Failure | Behaviour |
|---|---|
| Network or git unavailable | State unchanged. `/api/ci` keeps serving the last `ci.json` and sets `lastSyncError`; the UI shows a "désynchronisé" banner. |
| `ci-status` branch missing | Same, with an explicit reason. No crash, no retry storm. |
| Malformed status file | `parseUpdate` rejects it, the reader skips it and logs the reason once per file per tick. The reader cannot delete it — it has no write path — but the next run by that contributor overwrites it, so a bad file is self-healing rather than poison. |
| File in the wrong folder (`actor` ≠ folder name) | Rejected by `parseUpdate` and skipped, same as malformed. |
| Deposit rejected after 5 attempts | The action fails loudly in the managed repo's own workflow, where the person who triggered it will see it. Nothing is corrupted: the next run overwrites. |
| Slow tick | An in-flight lock prevents overlapping reads. |
| Status repo unset | No git command is run at all; every entry is `unavailable` with a reason. |

**Accepted limitation:** nothing expires. A contributor who leaves the team,
or a repo dropped from `repos.json`, leaves a file on the branch that keeps
being read. Repos absent from the board are simply not rendered; stale
contributors stay visible on the cards until their file is deleted by hand.
Automatic expiry was considered and rejected as premature — the branch is
bounded by `contributors × repos`, and a wrong retention window would silently
blank a badge that is actually current.

## Testing

- **`libs/ci-status`** — `node --test`, 100% line/function/branch gate.
  Table-driven cases for `normalizeState` covering every `conclusion` GitHub
  emits plus an unrecognised one; `rankState` total-order assertions;
  `buildUpdate` exercised on **both** contexts; `parseUpdate` against bad
  JSON, missing fields, wrong types and folder/actor mismatch; `buildState`
  for grouping by repo and user, higher-`runId`-wins and non-mutation.
- **`ciReader`** — injected `exec` and `fs`, so no real git and no network,
  covering the missing-branch path, the malformed-file path, the
  network-failure path that must preserve the previous cache, and the
  in-flight lock.
- **`server.js`** — `/api/ci` route added to `server.test.js` (`node --test`).
- **Vue** — Vitest for `ciBadge` (initials, sort order, overflow at 5+ users),
  the card badges per state, the detail breakdown, the three filter
  semantics, `useCi` polling, and `App.vue` filtering.
- **`libs/git`** — a test pinning that `push()` defaults to non-force and that
  `force: true` still emits `-f`.

Known blind spot: the composite action does not run under test. That is why
`report.js` is kept to a call of `buildUpdate` plus git plumbing — the logic
that can be wrong lives in the covered lib. The deposit retry loop is the one
piece of real logic there; it is written once here rather than N times across
managed repos, which is the whole reason for the composite action.

## Out of scope

- History or timeline of past runs — only the latest run per user per repo.
- Re-running or cancelling workflows from the board. Read-only.
- Any drift-detection or `--check` work (tracked separately in the
  high-value-features research note).
