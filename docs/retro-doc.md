# Retro-documentation

`scripts/retro-doc.js` reads every spec and plan of a repository and asks Claude
to reconstruct one reference document from them — the *why* behind a codebase,
written for the AI agent about to change it.

A design record grows the way this repository's did: one spec and one plan per
feature, written at a point in time and never revisited. That history is the
best explanation of the codebase that exists, and the worst possible thing to
hand an agent — thirty documents, 800 KB, half of them describing decisions that
were later reversed. This script folds them into a single document an agent can
read before it starts.

```bash
node scripts/retro-doc.js --repo ../some-repo --dry-run   # what it would read and cost
node scripts/retro-doc.js --repo ../some-repo             # write docs/ai/retro-documentation.md
```

The output is meant to be **committed** to the target repository: it is how the
next agent session finds it.

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

Both calls run on `claude-opus-5` with adaptive thinking, streamed. `--model`
takes any other model id.

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
| `--repo <path>` | `.` | Repository to read |
| `--out <path>` | `docs/ai/retro-documentation.md` | Output, relative to the repo |
| `--include <path>` | the list above | Extra source location; repeatable, replaces the defaults |
| `--model <id>` | `claude-opus-5` | Any Claude model id |
| `--lang <language>` | `English` | Language of the generated document |
| `--max-chars <n>` | `200000` | Source characters per digest call |
| `--stdout` | — | Print instead of writing |
| `--dry-run` | — | List the sources, the calls and an indicative cost; no API call |
| `-h`, `--help` | — | Usage |

`--dry-run` is the way to see what a run would cost before paying for it:

```
Sources: 30 document(s), 809943 characters
  2026-06-14  spec            docs/superpowers/specs/2026-06-14-skill-sync-design.md
  …
Calls: 5 digest + 1 synthesis, model claude-opus-5
Estimated tokens: ~205986 in, ~24500 out
Estimated cost: ~$1.64 (list price, indicative)
Would write: /home/user/maggie/docs/ai/retro-documentation.md
```

## Authentication

The script uses the [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript),
a dev dependency of this repository, which resolves credentials in this order:
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, then the profile left by
`ant auth login`. Nothing else is needed:

```bash
export ANTHROPIC_API_KEY=sk-ant-…
npm run retro-doc -- --repo ../some-repo
```

`--dry-run` needs no credentials at all.

## Regenerating

The document is a build product of the design record: regenerate it when specs
or plans are added, rather than editing it. It is cheap to re-run and the diff
shows what the new design document changed about the repository's story.
