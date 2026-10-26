// Public surface of @linktogo/maggie-agent-runner.
export { AgentError } from './errors.js';
export {
  AGENT_PROVIDERS, DEFAULT_AGENT_PROVIDER, commandFor, detectProviders, findOnPath, resolveProvider, validateModel,
} from './providers.js';
export { createRepoResolver } from './repos.js';
export { listSkills, loadSkill } from './skills.js';
export { MAX_PROMPT_CHARS, buildPrompt } from './prompt.js';
export {
  DEFAULT_MAX_EVENTS, DEFAULT_MAX_RUNS, DEFAULT_TIMEOUT_MS, TERMINAL, createRunManager,
} from './run.js';
