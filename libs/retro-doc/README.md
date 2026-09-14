# @linktogo/maggie-retro-doc

Retro-documentation for [maggie](https://github.com/linktogo/maggie): read a
repository's design record — specs, plans, decision records — and ask an LLM to
fold it into one reference document, written for the AI agent about to change
that repository.

A design record grows one spec and one plan per feature, written at a point in
time and never revisited. It is the best explanation of a codebase that exists,
and the worst thing to hand an agent: thirty documents, hundreds of kilobytes,
half of them describing decisions that were later reversed. This library turns
it into a single document with a fixed shape — orientation, glossary,
architecture, decision log, invariants, workflows, drift, open questions.

```js
import { createComplete, describeProvider, runRetroDoc } from '@linktogo/maggie-retro-doc';

const provider = 'copilot'; // or 'claude' (Anthropic API), or 'claude-cli'
const { outPath, written, domains } = await runRetroDoc({
  repoRoot: '/home/me/wk/api',
  complete: await createComplete({ provider }),
  generator: describeProvider({ provider }),
  log: console.error,
  // split: false, // one document instead of a front page plus one per domain
});
```

## Three phases

A large design record does not fit in one useful prompt, and one document
covering a whole repository is a document an agent reads none of, so
`runRetroDoc`:

1. groups the sources into batches of `maxChars` (200 000 by default) and asks
   for a structured **digest** of each — decisions with their stated rationale,
   constraints, vocabulary, components, status signals. A document is never
   split across batches and never truncated: one larger than the limit gets a
   batch of its own;
2. asks, from the digests, for the **domains** of this repository as JSON — the
   2 to 8 areas a contributor would name. `parseDomains` is what refuses to
   trust that answer blindly: unique slugs, known source paths only, every
   document assigned somewhere, and a fall back to documenting the repository in
   one piece when the answer cannot be read at all;
3. writes one **document per domain**, then a **front page** carrying what
   belongs to no single domain — orientation, glossary, cross-cutting
   invariants, workflows — and the table of domains.

`split: false` collapses phases 2 and 3 into the single synthesis call that
produces one document.

Sources are read chronologically, so the model can tell a decision that still
holds from one that was later reversed. The source index at the bottom of the
document is appended by this library, not by the model, so every claim stays
traceable to the file it came from.

## Providers

`createComplete({ provider })` returns the `complete` function the pipeline
calls. Three are supported, and they differ only in what they bill and what they
need to be logged in:

| `provider` | Runs | Authentication |
|---|---|---|
| `claude` | The Anthropic API, streamed, with adaptive thinking | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile |
| `claude-cli` | The local `claude` CLI (`claude -p`) | whatever Claude Code is logged in as |
| `copilot` | The local `copilot` CLI (`copilot --allow-all-tools`) | whatever GitHub Copilot CLI is logged in as |

The CLI providers receive the prompt on **stdin** — the channel both CLIs
document for programmatic use, and the only one that fits a 200 000-character
batch. The Anthropic SDK is imported lazily, so a caller that only ever uses a
CLI provider never loads it.

## Public surface

- **Sources** — `collectSourceFiles`, `readSource`, `orderSources`,
  `planBatches`, `collectRepoContext`, `listRepoCandidates`, `resolveRepoArg`,
  `classifyKind`, `parseFrontmatter`.
- **Prompts** — `DIGEST_SYSTEM`, `PLAN_SYSTEM`, `DOMAIN_SYSTEM`,
  `OVERVIEW_SYSTEM`, `SYNTHESIS_SYSTEM`, their `build*Prompt` counterparts, and
  the renderers `renderIndex`, `renderDomain`, `renderOutput`.
- **Providers** — `PROVIDERS`, `createComplete`, `createCliComplete`,
  `createAnthropicComplete`, `providerCommand`, `runCommand`,
  `describeProvider`, `estimateTokens`, `estimateCost`.
- **Domains** — `parseDomains`, `slugify`, `extractJsonArray`, `wholeRepository`.
- **Pipeline** — `generateRetroDoc` (one document), `generateDomainRetroDoc`
  (a front page plus one per domain), `runRetroDoc` (the whole job, from a
  repository path to files on disk).

Every I/O boundary is injectable — `complete`, `write`, `spawn`, `loadSdk`,
`now` — so a caller can exercise the whole pipeline without an API key, a
process or a disk.

The `maggie` CLI exposes this as `node scripts/retro-doc.js`, and the board
dashboard as a button on each repository — see
[Retro-documentation](https://github.com/linktogo/maggie/blob/main/docs/retro-doc.md).
