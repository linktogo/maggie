# npm Release Automation — Design

**Date:** 2026-08-10
**Status:** Approved (pending written-spec review)

## Purpose

Today, releasing the six lockstep npm packages (`@linktogo/ai-sync` at the repo
root plus five `libs/*` packages) is entirely manual: hand-edit six
`package.json` files, hand-edit `CHANGELOG.md`, then create a GitHub Release by
hand (typing the notes yourself) to trigger the existing
`.github/workflows/publish.yml`. Nothing has ever actually been released this
way — there are no git tags and no GitHub Releases yet.

This feature automates that process: a shared script handles version bumps
(manually for majors, automatically-triggered for patch/minor), release notes
are generated from `CHANGELOG.md` onto the GitHub Release automatically instead
of being hand-typed, and the path from "version bumped on `main`" to "published
to npm" can only be activated by members of the `lk-publish` GitHub team,
enforced at two independent points.

## Decisions (locked during brainstorming)

- **One shared bump script** (`scripts/bump-version.mjs`), invoked two ways:
  manually by a maintainer for `major`, automatically by a new
  `prepare-release.yml` workflow for `patch`/`minor`. There is no separate
  code path per bump type.
- **Major bumps are never automatic.** `prepare-release.yml` only ever computes
  `patch` or `minor` from commit history; a `BREAKING CHANGE:`/`!` commit gets
  flagged as a warning recommending a manual major bump, but does not trigger
  one.
- **`bump-version.mjs` does not regenerate changelog prose from commits.** It
  takes whatever is already hand-maintained under `## [Unreleased]` (today's
  practice, unchanged) and moves it under a new `## [X.Y.Z] - date` heading.
  This preserves the quality of hand-written entries instead of replacing them
  with terse auto-generated bullets from commit subjects.
- **A separate, smaller piece of logic decides bump *type*** (not changelog
  content): `scripts/detect-bump-type.mjs` scans Conventional Commit subjects
  since the last tag for `feat:`/`fix:`/breaking-change markers. This is the
  only place commit parsing happens.
- **Two independent gates**, per your explicit choice:
  1. A **tag protection ruleset** on `v*` restricted to the `lk-publish` team —
     only they can push (or otherwise create) a release tag.
  2. A **GitHub Environment** (`npm-publish`) on the existing `publish.yml`
     job, with `lk-publish` as required reviewers — the actual `npm publish`
     step pauses for an explicit approval even though the tag was already
     gated. Two separate checkpoints, intentionally redundant.
- **Release notes come from `CHANGELOG.md`**, not from GitHub's own
  auto-generated PR-list notes. A new `release.yml` extracts the section
  matching the tag's version and uses it as the GitHub Release body.
- **No new runtime dependency.** Version parsing/incrementing is plain
  `X.Y.Z` string math (no `semver` package) since the repo has never used
  prereleases. `peter-evans/create-pull-request` is used for the automatic
  release-prep PR instead of hand-rolling branch/PR update logic.
- **Prerequisites outside this repo's code** (tracked, not automated by this
  design): the `lk-publish` GitHub team must exist (it 404s today), the
  `NPM_TOKEN` secret must be set, and the ruleset/environment must be
  configured — see [Section 6](#section-6--one-time-repo-setup-manual).

## Architecture overview

```
Contributor PRs (feat:/fix:/...)
        │  merge to main
        ▼
prepare-release.yml (push: main)
  detect-bump-type.mjs  → "patch" | "minor" | "none"
        │ (none → no-op)
        ▼
  bump-version.mjs <type>  → 6× package.json + cross-dep ranges + CHANGELOG
        │
        ▼
  PR via peter-evans/create-pull-request  →  reviewed & merged like any PR
        │  (merged to main)
        ▼
lk-publish member: git tag vX.Y.Z && git push origin vX.Y.Z
        │
        ▼  ── GATE 1: tag ruleset (only lk-publish can create this tag) ──
        ▼
release.yml (push: tags v*)
  verify tag == package.json version
  extract CHANGELOG.md section for X.Y.Z
  gh release create vX.Y.Z --notes <extracted section>
        │
        ▼  (release: published event)
publish.yml (existing, + environment: npm-publish)
        ▼  ── GATE 2: environment required reviewer (lk-publish) ──
  npm test
  npm publish --workspaces   (libraries)
  npm publish                (CLI, depends on libraries)

Manual major path (parallel entry point):
maintainer runs `node scripts/bump-version.mjs major` locally → same PR/merge/
tag/release/publish flow as above, starting from "PR via ... → reviewed & merged".
```

## Section 1 — `scripts/bump-version.mjs`

New file, plain Node (no deps), run as `node scripts/bump-version.mjs
<major|minor|patch> [--dry-run]`.

1. Read `version` from root `package.json`; compute the new version by
   splitting on `.` and incrementing the relevant segment, zeroing the ones
   below it (`major` → `X+1.0.0`, `minor` → `X.Y+1.0`, `patch` →
   `X.Y.Z+1`).
2. Write the new `version` into root `package.json` and every
   `libs/*/package.json`.
3. Update every internal `@linktogo/ai-*` dependency range wherever it
   appears — root `dependencies`, and the cross-references found in
   `libs/config`, `libs/skill-sync`, `libs/workspace-bootstrap`
   (`@linktogo/ai-git`, `@linktogo/ai-renderers`) — to `^<newVersion>`. Also
   update `apps/*/package.json` references for consistency with
   `CONTRIBUTING.md`'s documented step, even though `apps/*` are never
   published themselves.
4. In `CHANGELOG.md`: rename the existing `## [Unreleased]` heading to
   `## [<newVersion>] - <today, YYYY-MM-DD>`, and insert a fresh empty
   `## [Unreleased]` heading above it. Update the comparison links at the
   bottom: `[Unreleased]` now points `v<newVersion>...HEAD`, and a new
   `[<newVersion>]: .../compare/v<lastTag>...v<newVersion>` line is added
   (or `.../releases/tag/v<newVersion>` if there is no previous tag, matching
   the existing `[0.1.0]` entry's style).
5. Run `npm install` so `package-lock.json` reflects the new versions.
6. `--dry-run` prints the computed diff (new version, files that would
   change) without writing anything — mirrors the existing
   `publish:verdaccio` "rehearse before you commit" pattern.
7. Does **not** touch git (no add/commit/tag) — prints a short "next steps"
   message (`git add -A && git commit -m "chore(release): vX.Y.Z" && git
   push`, then open a PR) and leaves that to the caller, matching the
   project's convention that release commits go through normal PR review.

## Section 2 — `scripts/detect-bump-type.mjs`

New file, used only by `prepare-release.yml`, but written and tested as a
standalone script so its logic isn't buried in YAML.

- Finds the last release tag (`git describe --tags --abbrev=0 --match "v*"`);
  if none exists, treats every commit on `main` as in-scope (first release).
- Reads full commit messages since that tag (`git log <tag>..HEAD --pretty=%B%x00`,
  null-separated so multi-line bodies/footers are captured intact).
- Classifies each by its Conventional Commit header: any `feat` → candidate
  `minor`; any `fix` (and no `feat`) → candidate `patch`; anything else is
  ignored for bump-type purposes. No qualifying commits → `none`.
- Independently flags `breaking: true` if any commit header contains `!`
  before the `:`, or any commit body contains a `BREAKING CHANGE:` footer.
- Prints a single line the workflow parses: `type=<major|minor|patch|none>
  breaking=<true|false>` (`type` here is never `major` — see decisions above).

## Section 3 — `.github/workflows/prepare-release.yml` (new)

- Trigger: `push` to `main`.
- Steps: checkout with full history (`fetch-depth: 0`, tags included) →
  `node scripts/detect-bump-type.mjs` → if `type=none`, exit successfully with
  no further action → else `node scripts/bump-version.mjs <type>` → commit the
  result on a fixed branch (`chore/release-next`) → open/update a PR via
  `peter-evans/create-pull-request` titled `chore(release): vX.Y.Z`. If
  `breaking=true`, the PR body includes a warning: "A breaking-change commit
  was detected; consider running `node scripts/bump-version.mjs major`
  instead of merging this patch/minor bump."
- This PR is unprivileged — it goes through the same required CI
  (`ci.yml`) as any other PR and needs normal review to merge. It does not
  publish anything by itself, so it is intentionally **not** gated to
  `lk-publish`.

## Section 4 — `.github/workflows/release.yml` (new)

- Trigger: `push` on tags matching `v*`.
- Steps: checkout → read `version` from root `package.json`, assert it equals
  `${GITHUB_REF_NAME#v}` (fail fast on a mismatched/stale tag) → extract the
  `## [<version>] - ...` section from `CHANGELOG.md` up to the next `## `
  heading → `gh release create "$GITHUB_REF_NAME" --title "$GITHUB_REF_NAME"
  --notes-file <extracted-section>`.
- No `lk-publish` check needed inside this workflow: Gate 1 (the tag
  ruleset, [Section 6](#section-6--one-time-repo-setup-manual)) already
  restricted who could push the tag that triggers it.

## Section 5 — `.github/workflows/publish.yml` (modified)

- Add `environment: npm-publish` to the `publish` job. Everything else is
  unchanged: the version-match guard, `npm test`, `npm publish --workspaces`,
  then `npm publish` for the CLI package.
- Effect: once the `release: published` event fires this workflow, it stays
  queued until a required reviewer from `lk-publish` approves the
  `npm-publish` environment deployment — Gate 2.

## Section 6 — One-time repo setup (manual / operator-run)

Not automatable from inside this PR (needs org-admin action and a real npm
token), but documented as a checklist plus an optional helper script the
operator runs once by hand after the team exists:

1. Create the `lk-publish` GitHub team in the `linktogo` org and add members.
2. `gh secret set NPM_TOKEN` with an npm automation token.
3. `scripts/setup-release-protections.sh` (new, run manually, not from CI):
   given `lk-publish` now resolves, uses `gh api` to (a) `PUT
   /repos/linktogo/ai-sync/environments/npm-publish` with the team as a
   required reviewer, and (b) `POST /repos/linktogo/ai-sync/rulesets` with
   `target: tag`, a `creation` rule on `refs/tags/v*`, and `lk-publish` in
   `bypass_actors`. Idempotent (safe to re-run); prints what it did before
   trying, and warns rather than fails if the team still doesn't resolve.

## Section 7 — Docs (`CONTRIBUTING.md`)

Replace the current 5-step manual "Releasing" section with the new flow:
patch/minor happen via the auto-opened release PR; major happens via
`node scripts/bump-version.mjs major` run locally; either way, merging that PR
is followed by an `lk-publish` member pushing the release tag, and the rest is
automatic. Keep the `npm run publish:verdaccio` local-rehearsal note as-is —
unaffected by this change.

## Section 8 — Testing

- **`scripts/bump-version.test.mjs`** (`node:test`, run against a temp
  directory fixture cloned from a minimal package layout, not the real repo
  files): version math for each bump type; cross-dependency ranges updated in
  every file that references them; `CHANGELOG.md` heading rename + new
  `Unreleased` scaffold + comparison-link update; `--dry-run` writes nothing.
- **`scripts/detect-bump-type.test.mjs`**: commit fixtures covering
  feat-only → `minor`, fix-only → `patch`, mixed feat+fix → `minor`,
  chore/docs-only → `none`, a `feat!:` header → `breaking=true` with
  `type=minor`, a `BREAKING CHANGE:` footer on an otherwise plain `fix:` →
  `breaking=true` with `type=patch`, no prior tag → scans full history.
- Both wired into the root `npm test` (or a new `npm run test:scripts`) so
  they run in `ci.yml` like everything else — not held to the 100% coverage
  gate (they're operator tooling, not a published package), but should still
  be meaningfully covered.
- **`release.yml`'s CHANGELOG-section extraction** gets a small unit test
  too (pure string function, easy to isolate from the workflow YAML).
- No automated test for the tag ruleset / environment reviewer gates
  themselves (GitHub-side config, not code) — verified manually once during
  Section 6 setup by confirming a non-`lk-publish` push/approval is rejected.

## Out of scope (YAGNI)

- Auto-generating changelog prose from commit messages — explicitly rejected
  above in favor of preserving hand-maintained `Unreleased` content.
- Automatic major-version bumps under any circumstance, including detected
  breaking changes — always a manual, explicit action.
- Migrating to `release-please`, `changesets`, or any other off-the-shelf
  release-automation tool — rejected during brainstorming as heavier than
  needed and less aligned with keeping major bumps manual.
- Pre-release/tag channels (`-beta`, `-rc`, etc.) — the repo has never used
  them; version math stays plain `X.Y.Z`.
- Automating team creation itself (`lk-publish`) — org-admin action, left to
  the operator.
