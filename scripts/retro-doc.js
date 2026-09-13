#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MODEL = 'claude-opus-5';
export const DEFAULT_OUT = 'docs/ai/retro-documentation.md';
export const DEFAULT_LANG = 'English';
export const DEFAULT_MAX_CHARS = 200000;

/** Where specs and plans usually live. Scanned recursively for Markdown. */
export const DEFAULT_ROOTS = [
  'docs/superpowers/specs',
  'docs/superpowers/plans',
  '.superpowers/specs',
  '.superpowers/plans',
  'docs/specs',
  'docs/plans',
  'docs/adr',
  'docs/architecture/decisions',
  'specs',
  'plans',
];

/** Used only when none of DEFAULT_ROOTS exists: any doc named like a spec or a plan. */
export const FALLBACK_ROOT = 'docs';
export const FALLBACK_NAME = /(spec|plan|design|adr|rfc)/i;

const SKIP_DIRS = new Set(['node_modules', '.git', '.nx', 'dist', 'build', 'coverage', 'wk', 'vendor']);

/** Approximate, for the --dry-run estimate only. USD per million tokens. */
export const PRICING = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export const USAGE = `Usage: node scripts/retro-doc.js [options]

Reads every spec and plan of a target repository and asks Claude to write a
single retro-documentation file, structured for an AI agent about to work in
that repository.

Options:
  --repo <path>       Target repository (default: the current directory)
  --out <path>        Output file, relative to the repo (default: ${DEFAULT_OUT})
  --include <path>    Extra file or directory to read; repeatable. Replaces the
                      default spec/plan locations when given.
  --model <id>        Claude model (default: ${DEFAULT_MODEL})
  --lang <language>   Language of the generated document (default: ${DEFAULT_LANG})
  --max-chars <n>     Characters of source per digest call (default: ${DEFAULT_MAX_CHARS})
  --stdout            Print the document instead of writing it
  --dry-run           List what would be sent and what it would cost; no API call
  -h, --help          Show this help

Authentication: the Anthropic SDK reads ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
or the profile left by \`ant auth login\`.`;

export function parseArgs(argv) {
  const options = {
    repo: '.',
    out: DEFAULT_OUT,
    include: [],
    model: DEFAULT_MODEL,
    lang: DEFAULT_LANG,
    maxChars: DEFAULT_MAX_CHARS,
    stdout: false,
    dryRun: false,
    help: false,
  };
  const value = (index, flag) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--repo':
        options.repo = value(i, flag);
        i += 1;
        break;
      case '--out':
        options.out = value(i, flag);
        i += 1;
        break;
      case '--include':
        options.include.push(value(i, flag));
        i += 1;
        break;
      case '--model':
        options.model = value(i, flag);
        i += 1;
        break;
      case '--lang':
        options.lang = value(i, flag);
        i += 1;
        break;
      case '--max-chars': {
        const raw = value(i, flag);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--max-chars expects a positive integer, got "${raw}"`);
        options.maxChars = parsed;
        i += 1;
        break;
      }
      case '--stdout':
        options.stdout = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }
  return options;
}

function walkMarkdown(absDir, repoRoot, accept, found) {
  for (const entry of readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkMarkdown(abs, repoRoot, accept, found);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && accept(entry.name)) {
      found.push(path.relative(repoRoot, abs).split(path.sep).join('/'));
    }
  }
}

/**
 * Resolve the spec/plan corpus of a repository, as repo-relative POSIX paths.
 * `include` overrides the default locations; when nothing is configured and no
 * default location exists, fall back to docs/ entries named like a design doc.
 */
export function collectSourceFiles(repoRoot, { include = [] } = {}) {
  const roots = include.length > 0 ? include : DEFAULT_ROOTS;
  const found = [];
  for (const root of roots) {
    const abs = path.resolve(repoRoot, root);
    if (!existsSync(abs)) continue;
    const stats = statSync(abs);
    if (stats.isDirectory()) walkMarkdown(abs, repoRoot, () => true, found);
    else if (abs.toLowerCase().endsWith('.md')) found.push(path.relative(repoRoot, abs).split(path.sep).join('/'));
  }
  if (found.length === 0 && include.length === 0) {
    const abs = path.resolve(repoRoot, FALLBACK_ROOT);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      walkMarkdown(abs, repoRoot, (name) => FALLBACK_NAME.test(name), found);
    }
  }
  return [...new Set(found)].sort();
}

export function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const fields = {};
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (match) fields[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return fields;
}

export function classifyKind(relPath) {
  const lower = relPath.toLowerCase();
  if (lower.includes('/plans/') || lower.startsWith('plans/') || lower.includes('-plan.')) return 'plan';
  if (lower.includes('/adr') || lower.includes('/rfc')) return 'decision-record';
  if (lower.includes('/specs/') || lower.startsWith('specs/') || lower.includes('-design.') || lower.includes('-spec.')) return 'spec';
  return 'design-doc';
}

export function readSource(repoRoot, relPath) {
  const text = readFileSync(path.resolve(repoRoot, relPath), 'utf8');
  const frontmatter = parseFrontmatter(text);
  const heading = /^#\s+(.+)$/m.exec(text);
  const dated = /(\d{4}-\d{2}-\d{2})/.exec(path.basename(relPath));
  return {
    path: relPath,
    kind: classifyKind(relPath),
    title: frontmatter.title || (heading ? heading[1].trim() : path.basename(relPath, '.md')),
    date: dated ? dated[1] : frontmatter.date || null,
    text,
    chars: text.length,
  };
}

/** Read the repository's own front page, so the synthesis knows what it is looking at. */
export function collectRepoContext(repoRoot) {
  const context = { name: path.basename(path.resolve(repoRoot)), description: '', readme: '', entries: [] };
  const manifest = path.resolve(repoRoot, 'package.json');
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.name) context.name = pkg.name;
      if (pkg.description) context.description = pkg.description;
    } catch {
      /* an unreadable manifest is not worth failing the run over */
    }
  }
  for (const name of ['README.md', 'readme.md']) {
    const abs = path.resolve(repoRoot, name);
    if (existsSync(abs)) {
      context.readme = readFileSync(abs, 'utf8').slice(0, 4000);
      break;
    }
  }
  if (existsSync(repoRoot)) {
    context.entries = readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
  }
  return context;
}

/** Group sources into digest calls without ever splitting — or truncating — a document. */
export function planBatches(sources, maxChars = DEFAULT_MAX_CHARS) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const source of sources) {
    if (current.length > 0 && size + source.chars > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(source);
    size += source.chars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Chronological, undated last: the synthesis is told to prefer the recent over the old. */
export function orderSources(sources) {
  return [...sources].sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    return a.path.localeCompare(b.path);
  });
}

export function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

export function estimateCost(model, inputTokens, outputTokens) {
  const price = PRICING[model];
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1e6;
}

export const DIGEST_SYSTEM = `You are a software archaeologist. You read the design record of a
repository — specifications, implementation plans, decision records — and distil each document
into a dense digest that a later pass will merge into one reference document.

Rules:
- Never invent. Every claim must come from the documents you were given.
- Keep the decisions and their stated rationale; drop the prose, the task checklists and the
  step-by-step implementation choreography.
- Note explicitly when a document supersedes, contradicts or revisits an earlier one.
- Cite the source path for every section you emit.
- Answer with Markdown only — no preamble, no closing remarks.

For each document emit:

### <title> (<path>, <kind>, <date or "undated">)
- **Subject**: one sentence.
- **Decisions**: bullet per decision, each as "decision — rationale (as stated)".
- **Constraints and invariants**: rules the codebase must keep holding; omit the heading if none.
- **Vocabulary**: domain terms the document introduces, with their meaning; omit if none.
- **Components**: the files, modules or services it creates or changes; omit if none.
- **Status signals**: anything marking the document as superseded, abandoned, partially shipped
  or still open; omit if none.`;

export const SYNTHESIS_SYSTEM = `You write retro-documentation: a single reference document
reconstructed from a repository's design record, written to be read by an AI coding agent that is
about to change that repository. It is not a tutorial and not a changelog.

Rules:
- Work only from the digests and repository context you are given. Never invent an API, a file or
  a decision. Where the record is silent, say so instead of guessing.
- Prefer the recent over the old: when two documents conflict, state the current answer, then note
  the earlier one under drift.
- Be specific: name real paths, real commands, real module names.
- Write constraints as imperatives an agent can check itself against.
- Keep every section; write "The design record says nothing about this." under a section rather
  than dropping it.
- Start at heading level 2. Do not repeat the document title, do not add a preamble, and do not
  close with a summary.

Structure, in this order:

## Orientation
What the repository is, who it serves, and the shape of a change to it.

## Glossary
Domain terms an agent must use correctly, one per line as "**term** — meaning".

## Architecture as designed
Components, their responsibilities and how they fit together. Name the directories.

## Decision log
A table: Decision | Rationale | Where it lives | Source. Newest first. One row per decision that
still holds.

## Invariants
Numbered rules the codebase must keep holding, each with the source that established it.

## How work gets done here
The workflows the record describes — testing, review, release, conventions.

## Drift and superseded decisions
Decisions later reversed or overtaken, and anything the record describes that may no longer match
the code. Say plainly that this is the risky part of the document.

## Open questions
What the record leaves undecided, and what an agent should ask a human about before changing.`;

export function buildDigestPrompt(batch) {
  const documents = batch
    .map(
      (source) =>
        `<document path="${source.path}" kind="${source.kind}" date="${source.date ?? 'unknown'}" title="${source.title}">\n${source.text}\n</document>`,
    )
    .join('\n\n');
  return `Digest the following ${batch.length} document(s) from the repository's design record.\n\n${documents}`;
}

export function buildSynthesisPrompt({ context, digests, lang = DEFAULT_LANG, sources = [] }) {
  const inventory = sources
    .map((source) => `- ${source.path} — ${source.title} (${source.kind}, ${source.date ?? 'undated'})`)
    .join('\n');
  return `Write the retro-documentation of the repository "${context.name}" in ${lang}.

<repository>
name: ${context.name}
description: ${context.description || 'none declared'}
top-level entries: ${context.entries.join(', ') || 'unknown'}
</repository>

<readme>
${context.readme || 'No README found.'}
</readme>

<design-record-inventory>
${inventory || 'none'}
</design-record-inventory>

<digests>
${digests.join('\n\n')}
</digests>`;
}

export function renderOutput({ body, context, sources, model, generatedAt }) {
  const index = sources
    .map((source) => `| ${source.date ?? '—'} | ${source.kind} | ${source.title.replace(/\|/g, '\\|')} | \`${source.path}\` |`)
    .join('\n');
  return `<!-- Generated by scripts/retro-doc.js. Do not edit by hand: regenerate it. -->

# Retro-documentation — ${context.name}

> Reconstructed from ${sources.length} design document(s) by \`${model}\` on ${generatedAt}.
> It describes the repository **as designed**, not as it stands today: the code is the
> authority, this is the intent behind it. Regenerate after a design change:
> \`node scripts/retro-doc.js --repo <path>\`.

${body.trim()}

## Source index

| Date | Kind | Title | Path |
|---|---|---|---|
${index}
`;
}

export async function generateRetroDoc({ sources, context, complete, model, lang = DEFAULT_LANG, maxChars = DEFAULT_MAX_CHARS, log = () => {}, now = () => new Date() }) {
  const batches = planBatches(sources, maxChars);
  const digests = [];
  for (const [index, batch] of batches.entries()) {
    log(`digesting batch ${index + 1}/${batches.length} (${batch.length} document(s), ${batch.reduce((sum, s) => sum + s.chars, 0)} chars)`);
    digests.push(
      await complete({
        system: DIGEST_SYSTEM,
        prompt: buildDigestPrompt(batch),
        maxTokens: 16000,
        label: `digest ${index + 1}/${batches.length}`,
      }),
    );
  }
  log(`synthesising the document from ${digests.length} digest(s)`);
  const body = await complete({
    system: SYNTHESIS_SYSTEM,
    prompt: buildSynthesisPrompt({ context, digests, lang, sources }),
    maxTokens: 64000,
    label: 'synthesis',
  });
  return {
    markdown: renderOutput({
      body,
      context,
      sources,
      model,
      generatedAt: now().toISOString().slice(0, 10),
    }),
    digests,
  };
}

/** A `complete` backed by the Anthropic SDK, imported lazily so the module loads without it. */
export async function createAnthropicComplete({ model = DEFAULT_MODEL } = {}) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  return async ({ system, prompt, maxTokens }) => {
    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      system,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: prompt }],
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      throw new Error(`The model declined this request (${message.stop_details?.category ?? 'unspecified'}).`);
    }
    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  };
}

export function formatDryRun({ sources, batches, model, out }) {
  const chars = sources.reduce((sum, source) => sum + source.chars, 0);
  const inputTokens = estimateTokens(chars) + batches.length * 700;
  const outputTokens = batches.length * 2500 + 12000;
  const cost = estimateCost(model, inputTokens, outputTokens);
  const lines = [
    `Sources: ${sources.length} document(s), ${chars} characters`,
    ...sources.map((source) => `  ${source.date ?? '        —'}  ${source.kind.padEnd(15)} ${source.path}`),
    `Calls: ${batches.length} digest + 1 synthesis, model ${model}`,
    `Estimated tokens: ~${inputTokens} in, ~${outputTokens} out`,
    cost === null ? 'Estimated cost: unknown for this model' : `Estimated cost: ~$${cost.toFixed(2)} (list price, indicative)`,
    `Would write: ${out}`,
  ];
  return lines.join('\n');
}

export async function main(argv, { log = console.log, error = console.error, write = writeFileSync, completeFactory = createAnthropicComplete } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    error(err.message);
    error(USAGE);
    return 1;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }

  const repoRoot = path.resolve(options.repo);
  if (!existsSync(repoRoot)) {
    error(`No such repository: ${repoRoot}`);
    return 1;
  }

  const files = collectSourceFiles(repoRoot, { include: options.include });
  if (files.length === 0) {
    error(`Found no spec or plan under ${repoRoot}. Point --include at the directory that holds them.`);
    return 1;
  }
  const sources = orderSources(files.map((file) => readSource(repoRoot, file)));
  const batches = planBatches(sources, options.maxChars);
  const outPath = path.resolve(repoRoot, options.out);

  if (options.dryRun) {
    log(formatDryRun({ sources, batches, model: options.model, out: outPath }));
    return 0;
  }

  const complete = await completeFactory({ model: options.model });
  const { markdown } = await generateRetroDoc({
    sources,
    context: collectRepoContext(repoRoot),
    complete,
    model: options.model,
    lang: options.lang,
    maxChars: options.maxChars,
    log: (message) => error(message),
  });

  if (options.stdout) {
    log(markdown);
    return 0;
  }
  mkdirSync(path.dirname(outPath), { recursive: true });
  write(outPath, markdown);
  log(`Wrote ${outPath} (${markdown.length} characters, from ${sources.length} source document(s))`);
  return 0;
}

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const argPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (scriptPath === argPath) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
