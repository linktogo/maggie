#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';

export const DEFAULT_MODEL = 'claude-opus-5';
export const DEFAULT_PROVIDER = 'claude';
export const PROVIDERS = ['claude', 'claude-cli', 'copilot'];
export const DEFAULT_WORKSPACE = 'wk';
export const DEFAULT_TIMEOUT_SECONDS = 600;
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

Reads every spec and plan of a target repository and asks an LLM to write a
single retro-documentation file, structured for an AI agent about to work in
that repository.

With no --repo and no --provider on a terminal, it asks which repository of the
workspace to document and which LLM to use.

Options:
  --repo <path|name>  Target repository: a path, or the name of a checkout in
                      the workspace (default: ask, or the current directory)
  --workspace <dir>   Where the repository checkouts live (default: ${DEFAULT_WORKSPACE})
  --provider <name>   ${PROVIDERS.join(' | ')} (default: ask, or ${DEFAULT_PROVIDER})
                        claude      Anthropic API, needs ANTHROPIC_API_KEY
                        claude-cli  the local \`claude\` CLI, uses its own login
                        copilot     the local \`copilot\` CLI, uses its own login
  --provider-command  Override the command a CLI provider runs, e.g.
                      "copilot --allow-all-tools --model claude-sonnet-4.5"
  --model <id>        Model id (default: ${DEFAULT_MODEL} for the API provider,
                      the CLI's own default otherwise)
  --out <path>        Output file, relative to the repo (default: ${DEFAULT_OUT})
  --include <path>    Extra file or directory to read; repeatable. Replaces the
                      default spec/plan locations when given.
  --lang <language>   Language of the generated document (default: ${DEFAULT_LANG})
  --max-chars <n>     Characters of source per digest call (default: ${DEFAULT_MAX_CHARS})
  --timeout <n>       Seconds a CLI provider may take per call (default: ${DEFAULT_TIMEOUT_SECONDS})
  --stdout            Print the document instead of writing it
  --dry-run           List what would be sent and what it would cost; no LLM call
  -h, --help          Show this help

Authentication: the API provider reads ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
or the profile left by \`ant auth login\`. The CLI providers use whatever login
\`claude\` and \`copilot\` already have.`;

export function parseArgs(argv) {
  const options = {
    repo: null,
    workspace: DEFAULT_WORKSPACE,
    provider: null,
    providerCommand: null,
    out: DEFAULT_OUT,
    include: [],
    model: null,
    lang: DEFAULT_LANG,
    maxChars: DEFAULT_MAX_CHARS,
    timeout: DEFAULT_TIMEOUT_SECONDS,
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
      case '--workspace':
        options.workspace = value(i, flag);
        i += 1;
        break;
      case '--provider': {
        const provider = value(i, flag);
        if (!PROVIDERS.includes(provider)) throw new Error(`--provider expects one of ${PROVIDERS.join(', ')}, got "${provider}"`);
        options.provider = provider;
        i += 1;
        break;
      }
      case '--provider-command':
        options.providerCommand = value(i, flag);
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
      case '--timeout': {
        const raw = value(i, flag);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--timeout expects a positive integer, got "${raw}"`);
        options.timeout = parsed;
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

/**
 * The repositories this run could document: the current directory first, then
 * every checkout of the workspace `maggie-workspace` bootstraps into.
 */
export function listRepoCandidates({ cwd = process.cwd(), workspace = DEFAULT_WORKSPACE } = {}) {
  const candidates = [{ name: `${path.basename(path.resolve(cwd))} (current directory)`, path: path.resolve(cwd) }];
  const workspaceDir = path.resolve(cwd, workspace);
  if (existsSync(workspaceDir) && statSync(workspaceDir).isDirectory()) {
    for (const entry of readdirSync(workspaceDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const abs = path.join(workspaceDir, entry.name);
      if (existsSync(path.join(abs, '.git'))) candidates.push({ name: `${entry.name} (${workspace}/)`, path: abs });
    }
  }
  return candidates;
}

/** `--repo` takes a path, or the name of a checkout in the workspace. */
export function resolveRepoArg(value, { cwd = process.cwd(), workspace = DEFAULT_WORKSPACE } = {}) {
  const asPath = path.resolve(cwd, value);
  if (existsSync(asPath)) return asPath;
  const inWorkspace = path.resolve(cwd, workspace, value);
  if (existsSync(inWorkspace)) return inWorkspace;
  return asPath;
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

/** How the generator is named in the document header and in --dry-run. */
export function describeProvider({ provider, model = null, providerCommand: override = null }) {
  if (provider === 'claude') return model ?? DEFAULT_MODEL;
  const { command } = providerCommand(provider, { override });
  const name = command === 'copilot' ? 'GitHub Copilot CLI' : `${command} CLI`;
  return model ? `${name} (${model})` : name;
}

export function renderOutput({ body, context, sources, generator, generatedAt }) {
  const index = sources
    .map((source) => `| ${source.date ?? '—'} | ${source.kind} | ${source.title.replace(/\|/g, '\\|')} | \`${source.path}\` |`)
    .join('\n');
  return `<!-- Generated by scripts/retro-doc.js. Do not edit by hand: regenerate it. -->

# Retro-documentation — ${context.name}

> Reconstructed from ${sources.length} design document(s) by \`${generator}\` on ${generatedAt}.
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

export async function generateRetroDoc({ sources, context, complete, generator, lang = DEFAULT_LANG, maxChars = DEFAULT_MAX_CHARS, log = () => {}, now = () => new Date() }) {
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
      generator,
      generatedAt: now().toISOString().slice(0, 10),
    }),
    digests,
  };
}

/**
 * How each CLI provider is invoked. The prompt goes in on stdin — both CLIs
 * accept it that way — so a 200 000-character batch never has to fit in argv.
 */
export function providerCommand(provider, { model = null, override = null } = {}) {
  if (override) {
    const [command, ...args] = override.split(/\s+/).filter(Boolean);
    return { command, args };
  }
  const modelArgs = model ? ['--model', model] : [];
  if (provider === 'claude-cli') return { command: 'claude', args: ['-p', ...modelArgs] };
  // `--allow-all-tools` is what GitHub documents for non-interactive runs: without
  // it the CLI can stop on an approval prompt no one is there to answer.
  return { command: 'copilot', args: ['--allow-all-tools', ...modelArgs] };
}

export function runCommand({ command, args, input, timeoutMs = 0, spawn = nodeSpawn }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`\`${command}\` produced nothing after ${Math.round(timeoutMs / 1000)}s — raise --timeout or check that it is logged in.`));
        }, timeoutMs)
      : null;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => settle(reject, new Error(`Could not run \`${command}\`: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) settle(resolve, stdout);
      else settle(reject, new Error(`\`${command}\` exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ''}`));
    });
    child.stdin.end(input);
  });
}

/**
 * A `complete` backed by a local agent CLI. Neither CLI takes a system prompt,
 * so it is folded into the message — they are the same instructions either way.
 */
export function createCliComplete({ provider, model = null, override = null, timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000, spawn = nodeSpawn }) {
  const { command, args } = providerCommand(provider, { model, override });
  return async ({ system, prompt }) => {
    const stdout = await runCommand({ command, args, input: `${system}\n\n---\n\n${prompt}`, timeoutMs, spawn });
    const text = stdout.trim();
    if (!text) throw new Error(`\`${command}\` returned nothing. Run it once by hand to check it is logged in.`);
    return text;
  };
}

/** Resolve the provider the run was asked for into a `complete` function. */
export async function createComplete({ provider, model, providerCommand: override = null, timeoutMs, spawn } = {}) {
  if (provider === 'claude') return createAnthropicComplete({ model });
  return createCliComplete({ provider, model, override, timeoutMs, spawn });
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

export function formatDryRun({ sources, batches, provider, model, generator, out }) {
  const chars = sources.reduce((sum, source) => sum + source.chars, 0);
  const inputTokens = estimateTokens(chars) + batches.length * 700;
  const outputTokens = batches.length * 2500 + 12000;
  const cost = provider === 'claude' ? estimateCost(model ?? DEFAULT_MODEL, inputTokens, outputTokens) : null;
  const lines = [
    `Sources: ${sources.length} document(s), ${chars} characters`,
    ...sources.map((source) => `  ${source.date ?? '        —'}  ${source.kind.padEnd(15)} ${source.path}`),
    `Calls: ${batches.length} digest + 1 synthesis, through ${generator}`,
    `Estimated tokens: ~${inputTokens} in, ~${outputTokens} out`,
    provider === 'claude'
      ? (cost === null ? 'Estimated cost: unknown for this model' : `Estimated cost: ~$${cost.toFixed(2)} (list price, indicative)`)
      : 'Estimated cost: billed by your CLI subscription, not by the Anthropic API',
    `Would write: ${out}`,
  ];
  return lines.join('\n');
}

/** Default pickers: inquirer is loaded only when a terminal is actually going to be asked. */
export async function promptRepo(candidates) {
  const { select } = await import('@inquirer/prompts');
  return select({
    message: 'Quel dépôt documenter ?',
    choices: candidates.map((candidate) => ({ name: candidate.name, value: candidate.path })),
  });
}

export async function promptProvider() {
  const { select } = await import('@inquirer/prompts');
  return select({
    message: 'Quel LLM utiliser ?',
    choices: [
      { name: 'Claude (API Anthropic — ANTHROPIC_API_KEY)', value: 'claude' },
      { name: 'Claude Code (CLI local `claude`)', value: 'claude-cli' },
      { name: 'GitHub Copilot (CLI local `copilot`)', value: 'copilot' },
    ],
  });
}

export async function main(argv, {
  log = console.log,
  error = console.error,
  write = writeFileSync,
  completeFactory = createComplete,
  selectRepo = promptRepo,
  selectProvider = promptProvider,
  cwd = process.cwd(),
  interactive = Boolean(process.stdin.isTTY),
} = {}) {
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

  // Asked for only when the run left the choice open and someone is there to answer.
  const askRepo = options.repo === null && interactive;
  const repoRoot = askRepo
    ? path.resolve(await selectRepo(listRepoCandidates({ cwd, workspace: options.workspace })))
    : resolveRepoArg(options.repo ?? '.', { cwd, workspace: options.workspace });
  if (!existsSync(repoRoot)) {
    error(`No such repository: ${repoRoot}`);
    return 1;
  }

  const askProvider = options.provider === null && interactive && !options.dryRun;
  const provider = askProvider ? await selectProvider() : options.provider ?? DEFAULT_PROVIDER;
  const generator = describeProvider({ provider, model: options.model, providerCommand: options.providerCommand });

  const files = collectSourceFiles(repoRoot, { include: options.include });
  if (files.length === 0) {
    error(`Found no spec or plan under ${repoRoot}. Point --include at the directory that holds them.`);
    return 1;
  }
  const sources = orderSources(files.map((file) => readSource(repoRoot, file)));
  const batches = planBatches(sources, options.maxChars);
  const outPath = path.resolve(repoRoot, options.out);

  if (options.dryRun) {
    log(formatDryRun({ sources, batches, provider, model: options.model, generator, out: outPath }));
    return 0;
  }

  const complete = await completeFactory({
    provider,
    model: options.model,
    providerCommand: options.providerCommand,
    timeoutMs: options.timeout * 1000,
  });
  const { markdown } = await generateRetroDoc({
    sources,
    context: collectRepoContext(repoRoot),
    complete,
    generator,
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
