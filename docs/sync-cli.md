# `maggie` CLI

Renders the [skills library](skills-library.md) into every configured repo and
pushes the result on a branch.

Examples call the CLI through its source entry (`node apps/sync/bin/sync.js`).
Once the package is installed the same commands are available as `maggie`.

## What a run does

For each repo in the [config](configuration.md):

1. Clone it into a temporary work dir (`--work-dir` to choose the parent).
2. Resolve the skills matching the repo's `technologies`.
3. Render each skill for each of the repo's `targets`.
4. Check out `maggie/update-skills`, write the files, prune what the current
   render no longer produces, commit, force-push.
5. Optionally open a PR with `gh` (`--pr`).

The branch is rewritten on every sync — it is a throwaway output branch, not a
place to commit by hand.

### Pruning stale files

Renamed a skill, dropped a technology, or dropped a target from a repo's
`targets`, and the file that used to render is now stale — a run deletes it,
rather than leaving it behind forever. This is tracked in a small manifest,
`.maggie/manifest.json`, committed alongside the skill files: every path the
last run wrote, so the next run can tell "no longer rendered" apart from
"never touched." A repo with no manifest yet (from before this existed, or a
first sync) gets one written and nothing pruned — the run after that is
where pruning starts.

If every technology in a repo's config fails to resolve any skill — a typo, a
moved skills library — the render for that repo is empty. Rather than reading
that as "delete everything this repo ever had," a run leaves both the files
and the manifest untouched and warns loudly instead: an empty render is far
more likely to be a config mistake than an instruction to wipe a repo.

## Flags

| Flag | Meaning |
|---|---|
| `--config <path>` | Read the config from a local file. |
| `--config-repo <url>` | Read it from a git repository instead. |
| `--config-file <path>` | Path inside the config repo. Default `repos.json`. |
| `--skills <dir>` | Skills library to render from. See resolution below. |
| `--repo <name>` | Restrict the run to one repo. |
| `--dry-run` | Print the files that would be written; no clone, no git. |
| `--strict` | Fail (non-zero exit) when a technology resolves to zero skills. |
| `--pr` | Open a pull request via the `gh` CLI after pushing. |
| `--work-dir <path>` | Parent directory for the temporary clones. |

`--config` and `--config-repo` are mutually exclusive and one is required — see
[Configuration](configuration.md).

## Skills directory resolution

First match wins:

1. `--skills <dir>`
2. a `skills/` folder in the current directory
3. the library bundled with the installed package

Running from a clone therefore always uses that clone's `skills/`, while a
global install falls back to the skills shipped in the tarball. Point `--skills`
at your own library to render guidance this project does not ship.

## Examples

```bash
# Local config file
node apps/sync/bin/sync.js --config repos.example.json

# Shared config repo
node apps/sync/bin/sync.js --config-repo https://github.com/example-org/ai-config.git

# Preview only — no clone, no git
node apps/sync/bin/sync.js --config-repo <url> --dry-run

# One repo, and open a PR
node apps/sync/bin/sync.js --config-repo <url> --repo example-api --pr

# CI guard: fail if a technology has no skills
node apps/sync/bin/sync.js --config-repo <url> --strict

# Render from a different skills library
node apps/sync/bin/sync.js --config <path> --skills ../my-skills
```

## Exit behaviour

A repo that fails is recorded as `error` and the run continues to the next one;
the process exits non-zero at the end if any repo failed. Without `--strict`, a
technology with no skills is a warning and does not affect the exit code.
