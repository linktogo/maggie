import { mkdir, writeFile as writeFileNode } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_LANG,
  DEFAULT_MAX_CHARS,
  DEFAULT_OUT,
  collectRepoContext,
  collectSourceFiles,
  orderSources,
  planBatches,
  readSource,
} from './sources.js';
import { DIGEST_SYSTEM, SYNTHESIS_SYSTEM, buildDigestPrompt, buildSynthesisPrompt, renderOutput } from './prompts.js';

/** "1m 42s" — a run that takes minutes should read as minutes, not as 102341 ms. */
export function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export async function generateRetroDoc({ sources, context, complete, generator, lang = DEFAULT_LANG, maxChars = DEFAULT_MAX_CHARS, log = () => {}, now = () => new Date() }) {
  const batches = planBatches(sources, maxChars);
  const digests = [];

  // An LLM call over a 200 000-character batch takes minutes and says nothing
  // while it runs, so every call is announced *and* reported: without the
  // second line a long call is indistinguishable from a frozen one.
  const call = async (request, announcement) => {
    log(announcement);
    const startedAt = now().getTime();
    const answer = await complete(request);
    log(`  ↳ ${request.label} answered in ${formatDuration(now().getTime() - startedAt)} — ${answer.length} chars`);
    return answer;
  };

  for (const [index, batch] of batches.entries()) {
    const label = `digest ${index + 1}/${batches.length}`;
    const chars = batch.reduce((sum, source) => sum + source.chars, 0);
    digests.push(await call(
      { system: DIGEST_SYSTEM, prompt: buildDigestPrompt(batch), maxTokens: 16000, label },
      `${label}: ${batch.length} document(s), ${chars} chars — ${batch.map((source) => source.path).join(', ')}`,
    ));
  }

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

/** Create the output directory on the way, the way a generated file is expected to behave. */
async function writeFile(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileNode(file, contents);
}

/**
 * The whole job, from a repository path to a written file: collect the design
 * record, digest it, synthesise it, write it. What the CLI and the board both
 * call — `write` and `complete` are injected so neither has to be mocked deeper.
 */
export async function runRetroDoc({
  repoRoot,
  include = [],
  out = DEFAULT_OUT,
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
  const { markdown } = await generateRetroDoc({
    sources,
    context: collectRepoContext(repoRoot),
    complete,
    generator,
    lang,
    maxChars,
    log,
    now,
  });
  const outPath = path.resolve(repoRoot, out);
  await write(outPath, markdown);
  return { outPath, markdown, sources };
}
