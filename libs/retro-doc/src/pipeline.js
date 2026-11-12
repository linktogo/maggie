import { mkdir, writeFile as writeFileNode } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_LANG,
  DEFAULT_MAX_CHARS,
  DEFAULT_OUT,
  DEFAULT_OUT_DIR,
  collectRepoContext,
  collectSourceFiles,
  orderSources,
  planBatches,
  readSource,
} from './sources.js';
import {
  DIGEST_SYSTEM,
  DOMAIN_SYSTEM,
  OVERVIEW_SYSTEM,
  PLAN_SYSTEM,
  SYNTHESIS_SYSTEM,
  buildDigestPrompt,
  buildDomainPrompt,
  buildOverviewPrompt,
  buildPlanPrompt,
  buildSynthesisPrompt,
  renderDomain,
  renderIndex,
  renderOutput,
} from './prompts.js';
import { parseDomains } from './domains.js';

/** "1m 42s" — a run that takes minutes should read as minutes, not as 102341 ms. */
export function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * An LLM call over a 200 000-character batch takes minutes and says nothing
 * while it runs, so every call is announced *and* reported: without the second
 * line a long call is indistinguishable from a frozen one.
 */
function caller({ complete, log, now }) {
  return async (request, announcement) => {
    log(announcement);
    const startedAt = now().getTime();
    const answer = await complete(request);
    log(`  ↳ ${request.label} answered in ${formatDuration(now().getTime() - startedAt)} — ${answer.length} chars`);
    return answer;
  };
}

/** Phase one, shared by both shapes of output: one digest per batch of sources. */
async function digestAll({ sources, maxChars, call }) {
  const batches = planBatches(sources, maxChars);
  const digests = [];
  for (const [index, batch] of batches.entries()) {
    const label = `digest ${index + 1}/${batches.length}`;
    const chars = batch.reduce((sum, source) => sum + source.chars, 0);
    digests.push(await call(
      { system: DIGEST_SYSTEM, prompt: buildDigestPrompt(batch), maxTokens: 16000, label },
      `${label}: ${batch.length} document(s), ${chars} chars — ${batch.map((source) => source.path).join(', ')}`,
    ));
  }
  return digests;
}

export async function generateRetroDoc({ sources, context, complete, generator, lang = DEFAULT_LANG, maxChars = DEFAULT_MAX_CHARS, log = () => {}, now = () => new Date() }) {
  const call = caller({ complete, log, now });
  const digests = await digestAll({ sources, maxChars, call });

  const prompt = buildSynthesisPrompt({ context, digests, lang, sources });
  const body = await call(
    { system: SYNTHESIS_SYSTEM, prompt, maxTokens: 64000, label: 'synthesis' },
    `synthesis: ${digests.length} digest(s), ${prompt.length} chars — writing the document`,
  );
  log(`done — ${sources.length} source document(s) folded into ${body.length} chars`);
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
 * The same record, written as one document per domain instead of one document
 * full stop: the digests are used once to decide what the domains *are*, then
 * once per domain to write its page, with a front page tying them together.
 */
export async function generateDomainRetroDoc({ sources, context, complete, generator, lang = DEFAULT_LANG, maxChars = DEFAULT_MAX_CHARS, log = () => {}, now = () => new Date() }) {
  const call = caller({ complete, log, now });
  const digests = await digestAll({ sources, maxChars, call });
  const generatedAt = now().toISOString().slice(0, 10);

  const plan = await call(
    { system: PLAN_SYSTEM, prompt: buildPlanPrompt({ context, digests, sources }), maxTokens: 8000, label: 'plan' },
    `plan: splitting ${sources.length} document(s) into domains`,
  );
  const domains = parseDomains(plan, sources);
  log(`plan: ${domains.length} domain(s) — ${domains.map((domain) => `${domain.slug} (${domain.sources.length})`).join(', ')}`);

  const pages = [];
  for (const [index, domain] of domains.entries()) {
    const label = `domain ${index + 1}/${domains.length} (${domain.slug})`;
    const body = await call(
      {
        system: DOMAIN_SYSTEM,
        prompt: buildDomainPrompt({ context, domain, domains, digests, sources, lang }),
        maxTokens: 32000,
        label,
      },
      `${label}: ${domain.sources.length} source document(s) — ${domain.title}`,
    );
    pages.push({
      file: `${domain.slug}.md`,
      markdown: renderDomain({ body, context, domain, sources, generator, generatedAt }),
    });
  }

  const overview = await call(
    {
      system: OVERVIEW_SYSTEM,
      prompt: buildOverviewPrompt({ context, digests, domains, lang }),
      maxTokens: 32000,
      label: 'front page',
    },
    `front page: orientation, glossary and the ${domains.length} domain links`,
  );
  const index = {
    file: 'README.md',
    markdown: renderIndex({ body: overview, context, domains, sources, generator, generatedAt }),
  };

  log(`done — ${sources.length} source document(s) folded into ${pages.length + 1} files`);
  return { index, pages, domains, digests };
}

/** Create the output directory on the way, the way a generated file is expected to behave. */
async function writeFile(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileNode(file, contents);
}

/**
 * The whole job, from a repository path to files on disk: collect the design
 * record, digest it, write it. By default it writes a directory — a front page
 * plus one document per domain — because a single file long enough to cover a
 * whole repository is a file an agent reads none of; `split: false` keeps the
 * one-document shape. `write` and `complete` are injected so neither the CLI nor
 * the board has to be mocked deeper.
 */
export async function runRetroDoc({
  repoRoot,
  include = [],
  out = null,
  split = true,
  complete,
  generator,
  lang = DEFAULT_LANG,
  maxChars = DEFAULT_MAX_CHARS,
  log = () => {},
  now = () => new Date(),
  write = writeFile,
}) {
  const files = collectSourceFiles(repoRoot, { include });
  if (files.length === 0) {
    throw new Error(`Found no spec or plan under ${repoRoot}. Point the include list at the directory that holds them.`);
  }
  const sources = orderSources(files.map((file) => readSource(repoRoot, file)));
  const context = collectRepoContext(repoRoot);
  const target = path.resolve(repoRoot, out ?? (split ? DEFAULT_OUT_DIR : DEFAULT_OUT));
  const shared = { sources, context, complete, generator, lang, maxChars, log, now };

  if (!split) {
    const { markdown } = await generateRetroDoc(shared);
    await write(target, markdown);
    return { outPath: target, markdown, sources, written: [target], domains: [] };
  }

  const { index, pages, domains } = await generateDomainRetroDoc(shared);
  const written = [];
  for (const page of [index, ...pages]) {
    const file = path.join(target, page.file);
    await write(file, page.markdown);
    written.push(file);
  }
  return { outPath: path.join(target, index.file), markdown: index.markdown, sources, written, domains };
}
