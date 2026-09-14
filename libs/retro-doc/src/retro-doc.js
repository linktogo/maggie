// Public surface of @linktogo/maggie-retro-doc.
//
// Four concerns, isolated the way the rest of the monorepo isolates them: what
// a repository's design record *is* (sources), how it is *asked about*
// (prompts), *who* answers (providers), and the *order* the two phases run in
// (pipeline). The CLI and the board both enter through `runRetroDoc`.
export {
  DEFAULT_LANG,
  DEFAULT_MAX_CHARS,
  DEFAULT_OUT,
  DEFAULT_OUT_DIR,
  DEFAULT_ROOTS,
  DEFAULT_WORKSPACE,
  classifyKind,
  collectRepoContext,
  collectSourceFiles,
  listRepoCandidates,
  orderSources,
  parseFrontmatter,
  planBatches,
  readSource,
  resolveRepoArg,
} from './sources.js';

export {
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

export { OVERVIEW_SLUG, extractJsonArray, parseDomains, slugify, wholeRepository } from './domains.js';

export {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_SECONDS,
  PRICING,
  PROVIDERS,
  createAnthropicComplete,
  createCliComplete,
  createComplete,
  describeProvider,
  estimateCost,
  estimateTokens,
  providerCommand,
  runCommand,
} from './providers.js';

export { formatDuration, generateDomainRetroDoc, generateRetroDoc, runRetroDoc } from './pipeline.js';
