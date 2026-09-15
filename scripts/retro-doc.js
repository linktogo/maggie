#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LANG,
  DEFAULT_MAX_CHARS,
  DEFAULT_MODEL,
  DEFAULT_OUT,
  DEFAULT_OUT_DIR,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_WORKSPACE,
  PROVIDERS,
  collectSourceFiles,
  createComplete,
  describeProvider,
  estimateCost,
  estimateTokens,
  listRepoCandidates,
  orderSources,
  planBatches,
  readSource,
  resolveRepoArg,
  runRetroDoc,
} from '@linktogo/maggie-retro-doc';

export const USAGE = `Usage: node scripts/retro-doc.js [options]

Reads every spec and plan of a target repository and asks an LLM to write a
set of retro-documentation files — a front page plus one document per domain —
structured for an AI agent about to work in that repository.

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
  --out <path>        Output, relative to the repo: the directory the documents
                      go in (default: ${DEFAULT_OUT_DIR}), or the file to write
                      with --single-file (default: ${DEFAULT_OUT})
  --single-file       One document instead of a front page plus one per domain
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
    out: null,
    singleFile: false,
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
      case '--single-file':
        options.singleFile = true;
        break;
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

export function formatDryRun({ sources, batches, provider, model, generator, singleFile = false, out }) {
  const chars = sources.reduce((sum, source) => sum + source.chars, 0);
  const inputTokens = estimateTokens(chars) + batches.length * 700;
  const outputTokens = batches.length * 2500 + 12000;
  const cost = provider === 'claude' ? estimateCost(model ?? DEFAULT_MODEL, inputTokens, outputTokens) : null;
  const lines = [
    `Sources: ${sources.length} document(s), ${chars} characters`,
    ...sources.map((source) => `  ${source.date ?? '        —'}  ${source.kind.padEnd(15)} ${source.path}`),
    singleFile
      ? `Calls: ${batches.length} digest + 1 synthesis, through ${generator}`
      : `Calls: ${batches.length} digest + 1 plan + 1 per domain (2 to 8) + 1 front page, through ${generator}`,
    `Estimated tokens: ~${inputTokens} in, ~${outputTokens} out`,
    provider === 'claude'
      ? (cost === null ? 'Estimated cost: unknown for this model' : `Estimated cost: ~$${cost.toFixed(2)} (list price, indicative)`)
      : 'Estimated cost: billed by your CLI subscription, not by the Anthropic API',
    singleFile ? `Would write: ${out}` : `Would write: ${out}/ — README.md and one file per domain`,
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
  write,
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

  // A dry run spends nothing, so it never asks which LLM to spend on.
  const askProvider = options.provider === null && interactive && !options.dryRun;
  const provider = askProvider ? await selectProvider() : options.provider ?? DEFAULT_PROVIDER;
  const generator = describeProvider({ provider, model: options.model, providerCommand: options.providerCommand });

  if (options.dryRun) {
    const files = collectSourceFiles(repoRoot, { include: options.include });
    if (files.length === 0) {
      error(`Found no spec or plan under ${repoRoot}. Point --include at the directory that holds them.`);
      return 1;
    }
    const sources = orderSources(files.map((file) => readSource(repoRoot, file)));
    log(formatDryRun({
      sources,
      batches: planBatches(sources, options.maxChars),
      provider,
      model: options.model,
      generator,
      singleFile: options.singleFile,
      out: path.resolve(repoRoot, options.out ?? (options.singleFile ? DEFAULT_OUT : DEFAULT_OUT_DIR)),
    }));
    return 0;
  }

  const complete = await completeFactory({
    provider,
    model: options.model,
    providerCommand: options.providerCommand,
    timeoutMs: options.timeout * 1000,
  });

  const printed = [];
  let result;
  try {
    result = await runRetroDoc({
      repoRoot,
      include: options.include,
      out: options.out,
      split: !options.singleFile,
      complete,
      generator,
      lang: options.lang,
      maxChars: options.maxChars,
      log: (message) => error(message),
      ...(write ? { write } : {}),
      // --stdout must not touch the filesystem, whoever else supplied a writer:
      // it prints every document instead, each under the name it would have had.
      ...(options.stdout ? { write: async (file, markdown) => printed.push({ file, markdown }) } : {}),
    });
  } catch (err) {
    error(err.message);
    return 1;
  }

  if (options.stdout) {
    log(printed.map(({ file, markdown }) => `<!-- ${path.basename(file)} -->\n${markdown}`).join('\n'));
    return 0;
  }
  if (options.singleFile) {
    log(`Wrote ${result.outPath} (${result.markdown.length} characters, from ${result.sources.length} source document(s))`);
    return 0;
  }
  log(`Wrote ${result.written.length} file(s) under ${path.dirname(result.outPath)}, from ${result.sources.length} source document(s):`);
  for (const file of result.written) log(`  ${path.basename(file)}`);
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
