# Board Startup Hook Reconciliation — Design

**Date:** 2026-07-23
**Status:** Approved (pending written-spec review)

## Purpose

This session we found hook configuration can silently drift out of sync in two
ways, with no visible symptom other than a kanban card that never moves:

1. **Stale CLI path** — a repo's installed hook referenced
   `ai-sync/bin/workspace.js`, a path that stopped existing after the Nx
   migration moved the CLI to `apps/workspace/bin/workspace.js`. Every hook
   invocation there had been throwing `MODULE_NOT_FOUND` silently for weeks.
2. **Wrong board target** — multiple repos ended up with hooks pointing at
   *different* `board.json` files than the one the dashboard actually reads,
   so their real activity never appeared on the board at all.

Both were found and fixed by hand this session (auditing each repo's
`.claude/settings.local.json`, re-running `ai-workspace bootstrap --repo
<name> --workspace <dir> --no-install` to repoint one repo's hooks). This
feature automates that check: every time the board server starts, it
re-verifies and repoints hooks for every repo whose checkout already exists,
so this class of drift gets caught and healed without manual intervention.

## Decisions (locked during brainstorming)

- **Auto-fix, not report-only.** On every server start, drift is silently
  repointed (via the same safe JSON-merge `installHooks` already uses), and a
  short summary is logged. No confirmation prompt — this is the same
  operation `ai-workspace bootstrap` already performs safely.
- **Scope: every repo in `repos.json` whose checkout already exists on
  disk** — both `path`-based external repos and repos still living under a
  `wk/`-style workspace folder. A repo with no checkout anywhere yet is
  skipped (no implicit cloning on server start).
- **No dependency installs.** Starting the dashboard must stay fast and
  side-effect-free beyond hook files and the board seed — no `pnpm
  install`/`mvn` runs.
- **Workspace root is derived from the board path**, using the same
  `<workspaceDir>/.ai-sync/board.json` convention `bootstrap()` already
  establishes: `workspaceDir = path.dirname(path.dirname(boardPath))`.
  Confirmed this layout always holds for how boards are actually run.
- **The CLI command baked into each hook is computed relative to the running
  script** (`fileURLToPath(new URL('../workspace/bin/workspace.js',
  import.meta.url))`), mirroring what `apps/workspace/src/main.js` already
  does for `bootstrap()`. This is what makes the fix migration-proof: if the
  CLI moves again in a future refactor, the path is never hardcoded anywhere,
  so it can't go stale a second time.

## Architecture overview

```text
npm start (apps/board/server.js)
  │
  ├─ resolve boardPath, configPath (existing logic, unchanged)
  │
  ├─ if configPath given:
  │     loadConfig(configPath)
  │     hookCommand = fileURLToPath(new URL('../workspace/bin/workspace.js', import.meta.url))
  │     reconcileHooks(config, { boardPath, hookCommand, logger })
  │         │
  │         ├─ per repo: checkout = repo.path ?? <workspaceDir>/<name>
  │         │     ├─ missing checkout      → skip
  │         │     ├─ hooks already correct → up-to-date, no write
  │         │     └─ hooks stale/missing   → installHooks(...) (existing, tested), repointed
  │         └─ initBoard(boardPath, allNames)  (seed any new repo as `todo`)
  │
  └─ createBoardServer(...).listen(port)   (existing logic, unchanged)
```

## Section 1 — `reconcileHooks()` (`libs/workspace-bootstrap/src/reconcile.js`, new file)

```js
export async function reconcileHooks(config, options = {}) {
  const {
    boardPath,
    hookCommand,
    exists = defaultExists,       // fs.access-based, same style as bootstrap.js
    readCurrentHooks = defaultReadCurrentHooks, // reads .claude/settings.local.json's 3 hook commands, or null
    installRepoHooks = installHooks,  // from ./hooks.js, unchanged
    initBoard = initRepos,            // from ./board.js, unchanged
    logger = console,
  } = options;

  const workspaceDir = path.dirname(path.dirname(boardPath));
  const results = [];

  for (const repo of config.repos) {
    const checkout = repo.path ? path.resolve(repo.path) : path.join(workspaceDir, repo.name);
    if (!(await exists(checkout))) {
      results.push({ repo: repo.name, status: 'skipped-missing', checkout });
      continue;
    }
    const before = await readCurrentHooks(checkout);
    const expected = hookSettings(repo.name, boardPath, { command: hookCommand }).hooks;
    if (hooksMatch(before, expected)) {
      results.push({ repo: repo.name, status: 'up-to-date', checkout });
      continue;
    }
    await installRepoHooks(checkout, repo.name, boardPath, { command: hookCommand });
    results.push({ repo: repo.name, status: 'repointed', checkout });
  }

  await initBoard(boardPath, config.repos.map((r) => r.name));
  return results;
}
```

- `hooksMatch(before, expected)` compares the three command strings
  (`UserPromptSubmit`/`Notification`/`Stop`) extracted from each side;
  `before` is `null` when no `.claude/settings.local.json` exists yet at the
  checkout, which never matches → always `repointed` (first-time install).
- Reuses `hookSettings` (already exported, pure, already tested) to compute
  the expected commands — no new command-string-building logic.
- Reuses `installHooks` (already exported, already tested merge-write) to
  perform the actual write — no new file-writing logic.
- A single repo throwing (e.g. permission error reading/writing its
  `.claude/` dir) is caught **inside this function's own loop**: that repo
  gets `{ repo: repo.name, status: 'error', error: err.message }` pushed to
  `results` instead of aborting, and the loop continues to the next repo.
  This keeps the contract simple — `reconcileHooks` always resolves with one
  status entry per repo (never rejects because of a single repo), so the
  caller just reads the array rather than needing its own try/catch per
  repo.

## Section 2 — `apps/board/server.js` integration

`startFromArgv` becomes `async`. Right after resolving `boardPath` and
`configPath` (existing code, unchanged), insert:

```js
if (configPath) {
  try {
    const config = await loadConfig(configPath);
    const hookCommand = fileURLToPath(new URL('../workspace/bin/workspace.js', import.meta.url));
    const results = await reconcileHooks(config, { boardPath, hookCommand });
    for (const r of results) {
      if (r.status === 'repointed') log(`  ✓ ${r.repo}: hooks repointed`);
      else if (r.status === 'error') log(`  ⚠ ${r.repo}: ${r.error}`);
    }
    if (!results.some((r) => r.status === 'repointed' || r.status === 'error')) {
      log(`  hooks verified for ${results.length} repo(s), all up to date`);
    }
  } catch (err) {
    log(`  ⚠ hook reconciliation skipped: ${err.message}`);
  }
}
```

Only one call, `reconcileHooks(config, { boardPath, hookCommand })` — no
separate wrapper. Per-repo failures are already isolated inside
`reconcileHooks` itself (Section 1), surfacing as `status: 'error'` entries
in the returned array; the outer `try`/`catch` here only guards against
`loadConfig` itself failing (e.g. invalid `repos.json`), in which case
reconciliation is skipped entirely for this start but the server still
proceeds to listen.

The existing `--board`/`AI_SYNC_BOARD`/auto-detect resolution and the
`EADDRINUSE` port-retry logic are unchanged. Without `--config`/
`AI_SYNC_CONFIG`, reconciliation is skipped entirely (same as today's
degraded no-config mode) — nothing new happens, server starts exactly as
before.

## Section 3 — Testing

- **`libs/workspace-bootstrap/test/reconcile.test.js`** (new, DI-style like
  `bootstrap.test.js`):
  - Repo with hooks already matching current board/command → `up-to-date`,
    `installRepoHooks` not called.
  - Repo with a stale command (different board path or different CLI path)
    → `repointed`, `installRepoHooks` called with the current values.
  - Repo with no `.claude/settings.local.json` at all yet → `repointed`
    (first install).
  - Repo whose checkout doesn't exist → `skipped-missing`, no read/write
    attempted.
  - A repo whose `installRepoHooks` (or hook-reading step) throws → that
    repo's entry is `{ status: 'error', error: <message> }`, the loop still
    processes and reports every remaining repo, and `initBoard` still runs
    at the end.
  - `initBoard` is called once at the end with every repo's name, regardless
    of individual statuses.
  - `path`-based and `workspaceDir`-derived checkouts both resolve correctly
    (mirrors the two branches already covered in `bootstrap.test.js`).
- **`apps/board/server.test.js`** (existing file, extended):
  - `startFromArgv` with `--config` calls `reconcileHooks` once with the
    resolved `boardPath` and a `hookCommand` pointing at
    `apps/workspace/bin/workspace.js`, and logs a line per `repointed`/`error`
    result (or the "all up to date" summary when there are none of either) —
    inject a fake `reconcileHooks`, matching the file's existing test style.
  - `startFromArgv` without `--config` performs no reconciliation (no new
    calls beyond today's behavior).
  - `loadConfig` itself throwing (invalid `repos.json`) logs a single
    "reconciliation skipped" warning and the server still starts listening.

## Out of scope (YAGNI)

- Periodic re-checks while the server keeps running (only "at start" was
  requested).
- A standalone `ai-workspace verify`/`doctor` CLI subcommand — the logic
  lives in `libs/workspace-bootstrap` so this remains cheap to add later, but
  isn't built now since nothing calls it yet besides the server.
- Dependency installs during reconciliation (explicitly excluded per
  decision above).
- Cloning or otherwise creating a checkout that doesn't exist yet — a
  not-yet-checked-out repo is simply left unreconciled until it exists.
