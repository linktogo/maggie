# Retro-documentation

Read every spec and plan of a repository, ask an LLM, and get back one reference
document — the *why* behind a codebase, written for the AI agent about to change
it. Three ways in: the `scripts/retro-doc.js` CLI, a button on the board, or
[`@linktogo/maggie-retro-doc`](../libs/retro-doc) directly.

A design record grows the way this repository's did: one spec and one plan per
feature, written at a point in time and never revisited. That history is the
best explanation of the codebase that exists, and the worst possible thing to
hand an agent — thirty documents, 800 KB, half of them describing decisions that
were later reversed. This script folds them into a single document an agent can
read before it starts.

```bash
node scripts/retro-doc.js                                 # ask which repo, which LLM, then write
node scripts/retro-doc.js --repo ../some-repo --dry-run   # what it would read and cost
npm run retro-doc -- --repo api --provider copilot        # a workspace checkout, through Copilot
```

Run with no arguments on a terminal and it asks two questions — which repository
of the workspace to document, and which LLM to use — then runs. Every answer can
be given upfront as a flag instead, which is what makes it usable from a script,
a hook or a CI job.

The output is meant to be **committed** to the target repository: it is how the
next agent session finds it.

## Choosing the repository

`--repo` takes either a path or the **name of a checkout in the workspace**
(`wk/` by default, `--workspace` to move it), so the same name that appears on
the board works here:

```bash
npm run retro-doc -- --repo api          # documents wk/api
npm run retro-doc -- --repo ../other     # documents a path
```

With no `--repo` on a terminal, the script lists the current directory followed
by every git checkout of the workspace and asks. With no `--repo` and no
terminal — a cron job, a hook, a CI step — it documents the current directory
and asks nothing.

## Choosing the LLM

`--provider` picks who writes the document. All three read the same prompts; they
differ in what they bill and what they need to be logged in.

| `--provider` | Runs | Authentication |
|---|---|---|
| `claude` (default) | The Anthropic API, through the official SDK | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile |
| `claude-cli` | The local `claude` CLI (`claude -p`) | Whatever Claude Code is already logged in as |
| `copilot` | The local `copilot` CLI (`copilot --allow-all-tools`) | Whatever GitHub Copilot CLI is already logged in as |

The two CLI providers get the prompt **on stdin**, which is what both CLIs
document for [programmatic use](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)
— a 200 000-character batch would not fit in a command-line argument. They are
the cheap path: nothing is billed to an API key, the work goes through the
subscription the CLI already has.

`--allow-all-tools` is passed to `copilot` because without it the CLI can stop on
an approval prompt that nobody is there to answer in a non-interactive run. The
prompt it receives asks for prose, not for actions, but the flag does grant the
agent the rights of the user running it — `--provider-command` replaces the whole
command when that is not what you want:

```bash
npm run retro-doc -- --provider copilot --provider-command "copilot"
npm run retro-doc -- --provider claude-cli --provider-command "claude -p --model claude-opus-5"
```

`--model` is passed through to whichever provider is in use (`--model
claude-sonnet-5` on the API, `--model` on either CLI); leave it out and each CLI
picks its own default. A CLI that answers nothing, or nothing within `--timeout`
seconds (600 by default), fails the run with what it printed on stderr rather
than hanging.

## What it reads

With no `--include`, the script looks for these locations in the target repo and
takes every Markdown file underneath, recursively:

```
docs/superpowers/specs   docs/specs   specs   docs/adr
docs/superpowers/plans   docs/plans   plans   docs/architecture/decisions
.superpowers/specs       .superpowers/plans
```

If none of them exists it falls back to `docs/`, keeping the files whose name
looks like a design document (`spec`, `plan`, `design`, `adr`, `rfc`).
`--include <path>` replaces the whole list with your own — a directory or a
single file, repeated as many times as needed:

```bash
node scripts/retro-doc.js --repo ../api --include doc/architecture --include RFC.md
```

Each file is classified (`spec`, `plan`, `decision-record`, `design-doc`) and
dated, from a `YYYY-MM-DD` prefix in its name or a `date:` in its frontmatter.
Documents are then read in chronological order, so that the model sees the
record the way it was written and can tell a current decision from one that was
later reversed.

## How it asks

Two phases, because a large design record does not fit in one useful prompt:

1. **Digest** — documents are grouped into batches of `--max-chars` characters
   (200 000 by default, roughly 50 000 tokens) and each batch is summarised into
   a dense, structured digest: subject, decisions with their stated rationale,
   constraints, vocabulary, components, status signals. A document is never
   split across batches and never truncated — one larger than the limit simply
   gets a batch of its own.
2. **Synthesis** — every digest, plus the repository's own README, package name
   and top-level layout, goes into a single call that writes the document.

On the `claude` provider both calls run on `claude-opus-5` with adaptive
thinking, streamed. On a CLI provider they are two invocations of that CLI, each
fed the same prompt on stdin.

## What it writes

One Markdown file, `docs/ai/retro-documentation.md` by default (`--out`), with a
fixed structure — the sections are the reason the output is usable by an agent
rather than merely readable:

| Section | What it holds |
|---|---|
| Orientation | What the repository is and what a change to it looks like |
| Glossary | Domain terms, so the agent names things the way the team does |
| Architecture as designed | Components, responsibilities, real directory names |
| Decision log | Decision, rationale, where it lives, source — newest first |
| Invariants | Numbered rules the codebase must keep holding |
| How work gets done here | Testing, review, release, conventions |
| Drift and superseded decisions | What the record says that the code may no longer do |
| Open questions | What to ask a human about before changing |

A header warns that the file is generated, and a **source index** table is
appended deterministically by the script — not by the model — so every claim
stays traceable to the file it came from.

The document describes the repository **as designed**. The code remains the
authority; this is the intent behind it. That is also why `Drift` is a section
of its own rather than a footnote.

## Options

| Option | Default | Effect |
|---|---|---|
| `--repo <path\|name>` | ask, else `.` | Repository to read: a path, or a workspace checkout name |
| `--workspace <dir>` | `wk` | Where the checkouts live |
| `--provider <name>` | ask, else `claude` | `claude`, `claude-cli` or `copilot` |
| `--provider-command` | — | Replace the command a CLI provider runs |
| `--model <id>` | `claude-opus-5` on the API | Model id, passed to whichever provider runs |
| `--out <path>` | `docs/ai/retro-documentation.md` | Output, relative to the repo |
| `--include <path>` | the list above | Extra source location; repeatable, replaces the defaults |
| `--lang <language>` | `English` | Language of the generated document |
| `--max-chars <n>` | `200000` | Source characters per digest call |
| `--timeout <n>` | `600` | Seconds a CLI provider may take per call |
| `--stdout` | — | Print instead of writing |
| `--dry-run` | — | List the sources, the calls and an indicative cost; no LLM call |
| `-h`, `--help` | — | Usage |

`--dry-run` is the way to see what a run would cost before paying for it:

```
Sources: 30 document(s), 809943 characters
  2026-06-14  spec            docs/superpowers/specs/2026-06-14-skill-sync-design.md
  …
Calls: 5 digest + 1 synthesis, through claude-opus-5
Estimated tokens: ~205986 in, ~24500 out
Estimated cost: ~$1.64 (list price, indicative)
Would write: /home/user/maggie/docs/ai/retro-documentation.md
```

## Authentication

The `claude` provider uses the [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript),
a dev dependency of this repository, which resolves credentials in this order:
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, then the profile left by
`ant auth login`:

```bash
export ANTHROPIC_API_KEY=sk-ant-…
npm run retro-doc -- --repo ../some-repo
```

The `claude-cli` and `copilot` providers need no key at all — they reuse the
login the CLI already has, which is also why they are the easy answer on a
machine that is already running one of those agents.

`--dry-run` needs no credentials at all, whichever provider is selected: it
never reaches an LLM, and never even asks which one to use.

## From the board

The dashboard can run it for you: **click a repository's name** on its card —
which opens the detail panel whether or not a session is running on it — and the
**Retro-documentation** section offers the same three LLMs and a button.

The board runs the generation in its own process and the panel polls it, so the
tab can be closed and reopened while it works: a running job shows the batch it
is on, a finished one the path it wrote, a failed one what the LLM or its CLI
said. One run at a time per repository.

Two things the board needs, and says so when it does not have them:

- **a config** (`npm start -- --config repos.json`, or `AI_SYNC_CONFIG`) — it is
  what tells the board where each repository is checked out. Without it the
  panel says so instead of guessing a directory to write into;
- **a checkout** of that repository in the workspace. The rule is the same one
  hook reconciliation uses: `path` from the config when it pins one, otherwise
  `<workspace>/<name>`.

The API behind the button, should you want to drive it from elsewhere:

| Route | What it does |
|---|---|
| `POST /api/retro-doc` | `{ repo, provider, model }` → `202 { job }`, or `400`/`404`/`409` with `{ error }` |
| `GET /api/retro-doc` | `{ jobs: [...] }`, newest first; `?repo=<name>` narrows it |
| both | `503` when the board was started without a config |

A job is `{ id, repo, provider, generator, status, startedAt, finishedAt, out,
error, log }`, where `status` is `running`, `done` or `error`. Jobs live in the
board process: restarting it forgets them, the generated file stays.

## Regenerating

The document is a build product of the design record: regenerate it when specs
or plans are added, rather than editing it. It is cheap to re-run and the diff
shows what the new design document changed about the repository's story.
