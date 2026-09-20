# Feature proposals

Candidate work for maggie, written against the code as it stands at **v1.2.0**.
Nothing here is approved. A proposal that gets picked up graduates into a spec
under [`docs/superpowers/specs/`](../superpowers/specs/) and a plan next to it —
that is where decisions get locked, and this page stops being the authority for
it.

Each entry states the problem in terms of what the code does today, with the
file it does it in, so that a proposal can be argued with rather than taken on
faith.

## The shortlist

| # | Proposal | Why | Depends on |
|---|---|---|---|
| [P1](#p1--prune-what-a-skill-no-longer-renders) | Prune what a skill no longer renders | A renamed or dropped skill leaves a ghost behind in every repo, forever | — |
| [P2](#p2--maggie---check-drift-detection-without-a-push) | `--check`: drift detection without a push | No way to ask "is my org in sync?" without pushing to every repo | — |
| [P3](#p3--enforce-the-skill-naming-convention-nothing-enforces) | Enforce the skill naming convention nothing enforces | An undocumented convention is the only thing preventing silent skill loss | — |
| [P4](#p4--say-in-the-file-that-the-file-is-generated) | Say, in the file, that the file is generated | The docs say hand edits are lost; the files themselves say nothing | — |
| [P5](#p5--per-repo-skill-selection) | Per-repo skill selection | A technology is all-or-nothing; repos get guidance that does not apply | — |
| [P6](#p6--a-pull-request-body-worth-reading) | A pull request body worth reading | Every sync PR says the same eleven words, on a force-pushed branch | P1, P2 |
| [P7](#p7--maggie-lint-for-the-skills-library) | `maggie lint` for the skills library | A malformed skill is caught in the target repos, not here | P3 |
| [P8](#p8--sync-status-on-the-board) | Sync status on the board | The board tracks sessions; it cannot tell you which repos drifted | P1, P2 |
| [P9](#p9--survive-a-board-restart-with-the-retro-doc-jobs) | Survive a board restart with the retro-doc jobs | A restart forgets a run you waited minutes and real money for | — |
| [P10](#p10--spike-do-cursor-and-windsurf-have-hooks-to-wire) | Spike: do Cursor and Windsurf have hooks to wire? | maggie renders for four targets and tracks sessions for two | — |

P1 through P4 are the ones that make the existing promise true; the rest are
additions. **P3 carries a live documentation bug** — two contributor-facing
pages teach a naming rule the library itself does not follow — which is worth
fixing on its own schedule, ahead of the feature attached to it.

---

## P1 — Prune what a skill no longer renders

**Problem.** [`pipeline.js`](../../libs/skill-sync/src/pipeline.js) clones the
target repo (`:73`), checks out `maggie/update-skills` off whatever the default
branch points at (`:74`), and writes the rendered files (`:76-80`). It only ever
writes. Nothing deletes.

So once a sync has been merged, its output lives in the default branch, and the
next sync branches from it. Rename `nestjs-module-structure` to `nestjs-modules`
and the target repo now has both `.claude/skills/nestjs-module-structure/` and
`.claude/skills/nestjs-modules/`. Drop `postgres` from a repo's `technologies`
and its Postgres skills stay. The tool reports `no changes` (`:82-85`) and is, on
its own terms, right: the files it renders are all present.

The failure is silent and it is the expensive kind — an agent about to edit
production code reads the stale skill exactly as attentively as the current one.
For a tool whose entire pitch is "one reviewed source of truth", leaving
un-reviewed copies behind is the bug that matters most.

**Proposal.** Write a manifest into each target repo — `.maggie/manifest.json`,
listing every path this tool generated, with the maggie version that generated
it. On the next run, read the manifest from the checkout and delete the paths
that are in it but not in the new render, before committing. No manifest means a
repo that predates this feature: prune nothing, write the manifest, and say so
in the log, so the first run after the upgrade is a no-op on deletions and the
second one is correct.

The manifest also has to be the thing that decides what is maggie's to delete.
Removing "every file under `.claude/skills/`" would eat a skill a team wrote by
hand, which is a worse bug than the one being fixed.

**Cost.** Small, and it is the one proposal the project cannot claim its own
docs are true without. One new file format, one read, one set difference, a
deletion loop. The existing `hasChanges()` check (`:82`) already covers
deletions, since `git status --porcelain` reports them.

**Open questions.** Does the manifest belong in the target repo at all, or
should the prune set be derived by re-rendering the *previous* config? (It
should not — the previous config is not knowable from the target repo, which is
the whole reason for the manifest.) Should the manifest be scoped per target, so
a repo that drops `cursor` from its `targets` also loses `.cursor/rules/`? Yes,
and that falls out of the design for free.

---

## P2 — `maggie --check`: drift detection without a push

**Problem.** There are two modes today, and neither answers the question an
organization actually asks.

`--dry-run` returns before the clone (`pipeline.js:66-69`): it prints the paths
that *would* be written. It never looks at the repo, so it cannot tell you
whether those paths are already there with that content. A clean `--dry-run`
says nothing about drift.

A real run pushes to `maggie/update-skills` in every repo and, with `--pr`,
opens pull requests. That is not something you put on a schedule to find out
whether anything changed.

**Proposal.** `--check`: clone shallow, render, compare against the checkout's
default branch, report per repo, exit non-zero if any repo would change. No
branch, no commit, no push. Composes with `--repo` and `--strict`.

```
$ maggie --config repos.json --check
= example-api: in sync (7 files)
≠ example-web: 2 changed, 1 to add, 1 stale
    ~ .claude/skills/reactjs-hooks/SKILL.md
    ~ .cursor/rules/reactjs-hooks.mdc
    + .claude/skills/nextjs-app-router/SKILL.md
    - .claude/skills/nextjs-pages-router/SKILL.md
✗ 1 of 2 repos out of sync
```

That is a CI job an organization can run nightly, and it is the input P6 and P8
both need. The `- stale` line is P1's manifest doing the work; without P1,
`--check` can report additions and changes but not removals — worth shipping on
its own, and worth saying out loud in the output rather than letting a clean run
imply more than it knows.

**Cost.** Medium. The rendering half already exists. The comparison needs a
read-and-diff against the checkout and a result shape richer than today's
`{ repo, status, files }`, which `report()` (`:95-101`) then has to summarise —
the counts-by-status line it prints now is too coarse for this.

**Open questions.** Shallow-clone depth 1 is enough for a content comparison and
much cheaper across fifty repos — and `clone()` already takes `depth`
([`git.js`](../../libs/git/src/git.js)) while the pipeline passes it for no mode
at all. Worth fixing for real runs too, but probably as its own change rather
than smuggled in here.

---

## P3 — Enforce the skill naming convention nothing enforces

**Problem.** [`skills.js:25`](../../libs/skill-sync/src/skills.js) collects
skills into a `Map` keyed by `skill.name`, filled by iterating `technologies` in
config order, and the last write wins. Two technologies shipping the same
`name` means one of them silently disappears, chosen by the order of an array in
a JSON file.

Nothing collides today, and the reason is a convention: every one of the 16
skills in the library names itself `<techno>-<directory>`.

| Directory | `name:` |
|---|---|
| `skills/nestjs/module-structure/` | `nestjs-module-structure` |
| `skills/postgres/query-performance/` | `postgres-query-performance` |
| `skills/vuejs/state-management/` | `vuejs-state-management` |

That prefix is load-bearing — it is the only thing keeping `reactjs/hooks` and a
future `vuejs/hooks` from colliding — and it is **documented nowhere**. Worse,
both pages that teach a contributor how to write a skill show the *unprefixed*
form, of skills that are actually prefixed:

- [`docs/skills-library.md:28`](../skills-library.md) — `name: module-structure`,
  where the real file says `nestjs-module-structure`
- [`CONTRIBUTING.md:85`](../../CONTRIBUTING.md#adding-a-skill) —
  `name: query-performance`, where the real file says `postgres-query-performance`

A contributor following either example literally produces a skill that renders
to a path the library does not use, and takes the first step toward the
collision the convention exists to prevent. `name` is also the output path in
all four renderers, so the consequence lands in every downstream repo.

**Proposal.** Two parts, and the first is a bug fix rather than a feature.

1. **Fix the docs.** Correct both examples to the prefixed form and state the
   convention in one sentence next to the frontmatter table: the `name` is
   `<techno>-<directory>`, because it is the output path in every target and has
   to be unique across the whole library, not just within a technology.
2. **Enforce it.** Warn on a collision, naming both sources and which one won;
   make it an error under `--strict`, which is already the flag for "a
   resolution problem should fail the build". The stronger check — that `name`
   equals `<techno>-<directory>` — belongs in P7, where it can run over the
   library as a whole rather than over one repo's resolved subset.

```
! example-web: skill "hooks" defined by both reactjs and vuejs
    using skills/vuejs/hooks/SKILL.md (last technology wins)
```

**Cost.** The doc fix is minutes. The collision check is small — track the
technology alongside each skill in the map and compare on insert.

**Open questions.** Is last-wins the right resolution at all, or should a
collision be an unconditional error? Last-wins is at least a rule a repo could
exploit deliberately — list the technology whose variant you want last — but
that is an accident being read as a feature. Per-repo selection (P5) is the
honest way to express that intent, which argues for making collisions hard
errors once P5 exists.

---

## P4 — Say, in the file, that the file is generated

**Problem.** [`docs/skills-library.md`](../skills-library.md) states that a
change made in a rendered file "is lost on the next sync, and cannot be reliably
read back". Nothing in the rendered file says so. The four renderers
([`libs/renderers/src/renderers/`](../../libs/renderers/src/renderers/)) each
emit frontmatter plus the body verbatim, with no provenance of any kind.

Someone in a downstream repo opens `.cursor/rules/reactjs-hooks.mdc`, sees a
normal rules file, improves it, and has their work deleted on the next sync — by
a tool they have possibly never heard of, since only whoever runs `maggie` ever
sees its name.

**Proposal.** One line above the body: that the file is generated, by what, from
which source path, and where to send the change instead. A comment, so no target
platform has to parse it.

```markdown
<!-- Generated by maggie v1.2.0 from skills/reactjs/hooks/SKILL.md — edit there, not here. -->
```

**The thing to get right.** All four targets feed the body to an agent verbatim,
so this line becomes part of the context window of every session in every
downstream repo. It has to be one line, and the spec should say plainly whether
a note addressed to a human is worth the tokens it costs an agent — the honest
answer is probably yes at this size, but that is an argument to make, not to
skip. The alternative worth costing is putting the provenance in frontmatter,
which Claude and Copilot strip and Cursor and Windsurf largely do not.

**Cost.** Small, and it touches all four renderers plus their tests. Note that
it makes every rendered file change on the sync after the upgrade, in every
repo — a one-time large diff that should be announced in the release notes
rather than discovered in a review.

---

## P5 — Per-repo skill selection

**Problem.** A repo's `technologies`
([`config.js`](../../libs/config/src/config.js), `normalizeRepo`) is the only
lever, and it is all-or-nothing: list `postgres` and you get everything under
`skills/postgres/`. A service that reaches Postgres through a managed ORM and
owns no migrations still receives `postgres-migrations`, which is guidance it
cannot act on — and unusable guidance is not neutral, it is context spent
teaching an agent about a situation that will not arise.

The workaround available today is to drop the technology, which also drops the
skills that *do* apply.

**Proposal.** Optional `skills` on a repo, with `exclude` and `include`:

```json
{
  "name": "example-api",
  "url": "https://github.com/example-org/example-api.git",
  "technologies": ["nestjs", "postgres"],
  "skills": { "exclude": ["postgres-migrations"] }
}
```

`exclude` removes from the resolved set. `include` — mutually exclusive with
`exclude` — replaces it, for a repo that wants two named skills and nothing
else. Both are validated against what the technologies actually resolved to, so
a typo, or a skill renamed upstream, is a config error rather than a line that
quietly stops doing anything. That validation is the feature; a
silently-ineffective exclusion is worse than no exclusion.

**Cost.** Medium. The config schema grows, `resolveSkills` grows a filter, and
the validation has to happen after resolution rather than at parse time — a real
change in shape, since `parseConfig` validates everything it knows how to
validate today without touching the filesystem.

**Open questions.** Should a repo be able to pin a skill to a revision, so an
org can roll a guidance change out gradually? That is a much larger feature and
wants its own proposal — it turns the skills library into something with
versions.

---

## P6 — A pull request body worth reading

**Problem.** `PR_BODY` is the constant `'Automated skill sync from maggie.'`
(`pipeline.js:10`), the branch is force-pushed on every run (`:88`), and
`createPR` is called unconditionally under `--pr` (`:89`).

Three consequences. A reviewer cannot tell from the PR what changed, so the
review is "read the whole diff, or approve on trust". A second sync rewrites the
branch under an open PR with the same description, so the description is not
merely thin — it is not even about the current commit. And `gh pr create` fails
when a PR already exists for the branch, which the `catch` in `run()` (`:36-39`)
records as `status: 'error'` for the whole repo and turns into a non-zero exit,
even though the push — the part that mattered — succeeded.

**Proposal.** Two changes, one small and one worth doing properly.

The small one: when a PR already exists for the branch, update it instead of
failing. A repo whose skills pushed cleanly is not an error.

The larger one: build the body from the render. Added, changed and removed
paths, grouped by technology and target; the maggie version; the config source
and, when it came from `--config-repo`, its revision. The diff information is
all in hand by then — and once P2 exists, so is the comparison that turns
"7 files" into "2 changed, 1 added, 1 removed".

**Cost.** Small once P1 and P2 have landed, and awkward before, which is why it
is ordered after them. The `gh pr create` fix is independent and small enough to
land on its own.

---

## P7 — `maggie lint` for the skills library

**Problem.** [`skill.js`](../../libs/skill-sync/src/skill.js) checks three
things: `name` present, `description` present, `globs` an array if given. That
is all the validation a skill ever gets, and it happens during a sync — in the
run that is about to push to every repo in the organization.

`name` is not checked against anything. It becomes a path segment in all four
renderers (`.claude/skills/<name>/SKILL.md`, `.cursor/rules/<name>.mdc`, …), so
a `name` with a slash or a space in it writes somewhere nobody intended, in
every downstream repo, and one that breaks the `<techno>-<directory>` convention
makes the library unnavigable and invites P3's collision. An empty body renders
an empty skill. `globs` is checked for being an array, never for containing
strings.

Contributed skills are the contribution this project most wants, and the current
answer to "did I write it correctly?" is "push it to everyone and find out".

**Proposal.** A `lint` target over `skills/`, run in this repo's CI alongside
`lint test build`:

- `name` matches `^[a-z0-9][a-z0-9-]*$` and equals `<techno>-<directory>`
- `description` is one non-empty line
- `globs`, when present, is a non-empty array of non-empty strings
- the body is non-empty after the frontmatter
- every `SKILL.md` sits at `skills/<techno>/<name>/SKILL.md` — nothing orphaned
  one level up, nothing nested one level too deep
- no two technologies define the same `name` — P3's check, run over the whole
  library instead of one repo's resolved set

The `<techno>-<directory>` rule is the one that has to land with P3's doc fix,
not before it: enforcing an undocumented convention against contributors who
were told otherwise is the wrong order.

**Cost.** Small — mostly a new test target plus a thin CLI over checks that want
to exist anyway. Worth pairing with a line in
[CONTRIBUTING.md](../../CONTRIBUTING.md#adding-a-skill) so a contributor knows
the command before they open the PR.

---

## P8 — Sync status on the board

**Problem.** The board answers "what are my agents doing?" — four columns of
session status, CI per contributor, token usage, history. It has nothing to say
about what the rest of the toolkit does. Whether a repo's skills are current is
invisible until someone runs the CLI and reads a terminal.

**Proposal.** With `--check` (P2) available, teach the board to run it and show
the result: a per-repo badge — in sync, drifted (with a count), never synced,
unknown — on the card and in the detail panel, with the drifted paths listed in
the panel. A filter chip next to the CI one. Most naturally a `GET /api/sync`
alongside `/api/ci`, following the polling shape the CI reader already
established.

**Cost.** Medium, and this is the proposal most likely to be deferred, because
it buys visibility rather than correctness. Real design questions sit behind it:
`--check` clones every repo, far too slow to serve from a request handler, so
this needs either a cached background refresh with an explicit "as of" (the CI
reader's model) or a deliberate on-demand job (the retro-doc model). Choosing
between those is most of the spec.

**Depends on** P2 for the check itself, and P1 for the stale half of its answer.

---

## P9 — Survive a board restart with the retro-doc jobs

**Problem.** [`docs/retro-doc.md`](../retro-doc.md) is explicit: "Jobs live in
the board process: restarting it forgets them, the generated file stays."

A retro-doc run takes minutes and, on the `claude` provider, costs real money —
the `--dry-run` output quotes around $1.64 for a 30-document record. What the
restart loses is the job's console: the per-call timings, the batch counts, what
the provider said when it failed. On a failed run that console is the entire
diagnosis, and it is the most likely thing to be lost, since a failed run is
exactly when someone restarts the board.

**Proposal.** Persist the job list next to the board state, at
`<workspace>/.maggie/retro-doc-jobs.json`, with the same atomic-write discipline
`board.json` already uses. Load on start; keep a bounded number of jobs — the
board already bounds events and pending messages at 20 apiece
([`board.js`](../../libs/workspace-bootstrap/src/board.js)), so the convention
exists. A job that was `running` when the process died is not running now: it
should load as `interrupted`, not as a run that will never finish updating.

**Cost.** Small. Persistence of an in-memory structure
([`retroDocJobs.js`](../../apps/board/retroDocJobs.js)) plus the interrupted
state and its rendering.

**Open questions.** Should the console be capped by line count or by bytes? A
verbose failure can be large, and this file is read on every board start.

---

## P10 — Spike: do Cursor and Windsurf have hooks to wire?

**Problem.** maggie renders skills for four targets. `maggie-workspace` wires
status hooks for two agents — Claude Code and GitHub Copilot CLI — and those two
are what the board can display.

A repo whose `targets` are `["cursor"]` gets its skills synced and then never
appears as a session on the board. From the board's point of view, an
organization standardising on Cursor is using half of maggie and can see none of
it. The asymmetry is not documented anywhere as a limitation; it reads as an
oversight.

It may well be the correct state. Both existing integrations rest on a
documented local hook mechanism with a settings file to merge into
([`docs/workspace-cli.md`](../workspace-cli.md#status-tracking)), and whether the
editor-based tools expose anything comparable — an event with a process to shell
out to, not an extension API — is a question of fact, not of design.

**Proposal.** Spend a day finding out, and write the answer down either way. If
a hook mechanism exists for either tool, the result is a spec for a third and
fourth `--agent` value on the same board contract. If it does not, the result is
a paragraph in `docs/workspace-cli.md` naming which agents can be tracked and
why the others cannot — worth as much, because it converts a silent gap into a
known boundary.

**Cost.** A day, and the deliverable is a document regardless of the outcome.
This is deliberately not scoped as a feature; scoping it as one would be
assuming the answer.

---

## Deliberately not proposed

Things that look like obvious next features and are being left alone on purpose.

**Authentication on the board server.** [SECURITY.md](../../SECURITY.md) and the
README both scope it as a local development tool that should not be exposed to a
network. Adding auth invites exactly the deployment the security model rules
out. If the board should be shareable, that is a change to the security model
first and a feature second.

**More target platforms.** Four renderers already cover the market this project
set out to serve, and each one added is a permanent maintenance obligation
against someone else's evolving format. Worth doing when a user asks for a
specific one, not on the reasoning that five is more than four.

**A fifth theme.** [The themes spec](../superpowers/specs/2026-09-14-board-material-themes-design.md)
shipped three Material directions plus a frozen legacy look, chosen from three
mockups reviewed together. The token contract makes adding another cheap, which
is not the same as it being worth doing.

**Moving board state behind a server.** `board.json` being a plain file is why
writers work whether or not the server is running — a property the docs call out
and the hook design depends on. A service in the middle would trade that for
multi-machine support nobody has asked for.
