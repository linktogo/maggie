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
