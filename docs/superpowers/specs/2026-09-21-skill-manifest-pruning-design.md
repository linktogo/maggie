# Prune what a skill no longer renders — Design

**Date:** 2026-09-21
**Status:** Approved

## Purpose

This is P1 of [`docs/proposals/README.md`](../../proposals/README.md#p1--prune-what-a-skill-no-longer-renders).

[`pipeline.js`](../../../libs/skill-sync/src/pipeline.js) clones the target
repo, checks out `maggie/update-skills`, and writes the rendered files. It
only ever writes — nothing deletes. Rename a skill, drop a technology from a
repo's config, or drop a target from a repo's `targets`, and the stale file
stays in the target repo forever: `hasChanges()` reports `false` once the
current render matches what's already on disk, and the sync tool has,
correctly by its own logic, nothing to say. For a tool whose pitch is "one
reviewed source of truth," a silently-accumulating pile of un-reviewed
leftovers is the sharpest gap between promise and behavior.

This design adds a manifest — `.maggie/manifest.json` in the target repo —
recording every path maggie wrote last time, so the next run can tell "no
longer rendered" apart from "never existed" and delete the former.

## Decisions

- **`.maggie/manifest.json`**, matching the existing `.maggie/board.json`
  convention from `maggie-workspace`. Content: `{ "version": 1, "paths": [...] }`
  — a flat, sorted list of every path the last run wrote across every
  target. `version` is the manifest's own schema version (so a future format
  change has somewhere to branch on), not a maggie release version: unlike
  the marker added in [P4](2026-09-20-generated-file-marker-design.md), a
  version tied to the tool's own release would make the manifest — and
  therefore the commit — change on every maggie release even when nothing
  about the repo's skills did. The schema version stays at `1` across
  ordinary runs and produces no diff noise.
- **The manifest is read from the cloned default branch, before
  `checkoutBranch(BRANCH)`.** The `maggie/update-skills` branch is documented
  as throwaway — "rewritten on every sync" — so continuity has to anchor to
  what's actually merged, not to a branch a run is about to force-push over.
  Reading before checkout means: if the last sync's PR merged, the manifest
  reflects it; if it didn't (still open, or was closed unmerged), the
  manifest reflects whatever was true before that attempt, which is the
  conservative, correct baseline to prune against.
- **No manifest found (`ENOENT`) is treated as "this repo predates the
  feature," not an error.** Prune nothing, write the manifest this run so the
  *next* run has a baseline. The first sync after upgrading is therefore a
  no-op on deletions; the second one is correct. This needs no flag, no
  migration step, and no user action.
- **A manifest that exists but fails to parse is treated the same way as
  missing**, with a distinct warning (`<path>: invalid JSON, treating as no
  manifest (<error>)`) so the two cases are diagnosable from the log without
  the sync itself needing to escalate them differently — a hand-edited or
  corrupted manifest shouldn't be able to crash a sync.
- **Safety net: an empty new render against a non-empty old manifest skips
  pruning *and* skips writing the manifest.** If every technology in a
  repo's config fails to resolve — a typo, a moved skills directory — the
  render is empty, and without this guard the next commit would delete every
  file maggie has ever written to that repo in one shot, silently, as a side
  effect of a config mistake having nothing to do with wanting those files
  gone. The guard does two things together: it refuses to delete, and it
  refuses to overwrite the manifest with the now-empty state — so the
  manifest still reflects the real last-good baseline, and once the config
  is fixed, the next sync prunes correctly against it rather than having lost
  its memory after one bad run. Since neither files nor the manifest are
  touched, `hasChanges()` reports `false` and the repo's sync is a clean,
  loud no-op (`logger.warn`), not a silent skip.
- **A deliberate, permanent removal of every skill from a repo remains
  possible** — the guard only stops an *empty* render from being read as
  intentional. Removing files maggie put there because the repo is being
  taken off maggie entirely is a manual step, same as it is today.

## File structure

New module: `libs/skill-sync/src/manifest.js` — pure I/O and a pure diff
function, no git or rendering knowledge:

```js
export async function readManifest(dir, { warn = console.warn } = {}) { ... }
// ENOENT or invalid JSON -> { version: 1, paths: [] }, warning on the latter

export async function writeManifest(dir, paths) { ... }
// writes .maggie/manifest.json as { version: 1, paths: [...paths].sort() }

export function stalePaths(oldPaths, newPaths) { ... }
// pure set difference: oldPaths not present in newPaths
```

`libs/skill-sync/src/pipeline.js`'s `syncRepo` gains `readManifest` and
`writeManifest` in its dependency-injection options, exactly like `clone`,
`resolveSkills`, and `getRenderer` already are — so tests can stub them
without touching a real filesystem.

## Data flow (real run, non-dry-run)

```
clone(repo.url, dest)                          — unchanged
oldManifest = readManifest(dest, { warn })      — new: read from the cloned default branch
gitRepo.checkoutBranch(BRANCH)                  — unchanged

... existing: write every rendered file to dest ...

newPaths = files.map(f => f.path)
if (newPaths.length === 0 && oldManifest.paths.length > 0) {
  logger.warn(`${repo.name}: new render is empty but ${oldManifest.paths.length}
    file(s) were previously tracked — skipping prune and leaving the
    manifest untouched (check repo.technologies)`)
  // no deletion, no manifest write
} else {
  stale = stalePaths(oldManifest.paths, newPaths)
  for (const p of stale) {
    rm(path.join(dest, p), { force: true })
    logger.log(`- ${repo.name}: pruning ${p}`)
  }
  writeManifest(dest, newPaths)
}

gitRepo.hasChanges() / commitAll() / push() / createPR()  — unchanged
```

`--dry-run` is unaffected: it returns before `clone()` and never touches
git, so it never reads or writes a manifest — consistent with today's
"no clone, no git" contract for that flag.

## Testing

`libs/skill-sync/test/manifest.test.js` (new, pure unit tests, no git):

- `readManifest` returns `{ version: 1, paths: [] }` when the file is missing.
- `readManifest` returns the parsed `paths` when the file is valid.
- `readManifest` returns `{ version: 1, paths: [] }` and calls `warn` when
  the file exists but isn't valid JSON.
- `writeManifest` writes `{ version: 1, paths: [...sorted] }`.
- `stalePaths` returns exactly the entries in `oldPaths` absent from
  `newPaths`; returns `[]` when nothing is stale; returns everything when
  `newPaths` is empty.

`libs/skill-sync/test/pipeline.test.js` (extended):

- A repo whose old manifest lists a path no longer in the new render: that
  path is deleted from the checkout, the new manifest is written with only
  the current paths, and the commit includes both.
- A repo with no old manifest: nothing is deleted, a manifest is written for
  the first time, and the log says so.
- The safety-net case: an empty resolved-skills stub against a non-empty old
  manifest results in no deletion, no manifest write, and a warning through
  `logger.warn`.

## Documentation

[`docs/sync-cli.md`](../../sync-cli.md) gains a short section on what a run
does after writing files: it now also prunes paths the current render no
longer produces, using `.maggie/manifest.json` (committed alongside the
skill files) to tell stale files apart from files it has simply never
touched. Notes the safety net in one sentence, since "why didn't it clean up
this repo" is exactly the question that guard is designed to prompt someone
to ask about their config instead.

## Out of scope

- **Per-target-only removal without a `techno`/`name` change** (e.g. a repo
  drops `cursor` from `targets` while keeping the same technologies) is
  handled by this design without any extra logic: the render simply stops
  producing `.cursor/rules/*` paths, so they fall out as stale on the next
  diff. No separate mechanism needed.
- **A dry-run preview of what would be pruned** is not part of this design —
  that capability is
  [P2's `--check`](../../proposals/README.md#p2--maggie---check-drift-detection-without-a-push),
  which this manifest becomes an input to once it exists.
- **Cross-run history or an undo mechanism** for pruned files: out of scope.
  The pruned file's last content is recoverable from the target repo's own
  git history like any other deleted file — nothing new is needed here.
