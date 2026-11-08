// Public surface of @linktogo/maggie-agent-runner.
export { AgentError } from './errors.js';
export {
  AGENT_PROVIDERS, DEFAULT_AGENT_PROVIDER, commandFor, detectProviders, findOnPath, resolveProvider, validateModel, validateSessionId,
} from './providers.js';
export { createRepoResolver } from './repos.js';
export { TERMINAL_LIMITS, createTerminalManager } from './terminals.js';
export { createStreamParser, summarizeTool } from './stream.js';
export { createThreadStore } from './store.js';
export { MAX_MESSAGE_CHARS, createThreadService } from './threads.js';
export { claudeStateFile, trustDirectories } from './trust.js';
export { listSkills, loadSkill } from './skills.js';
export { MAX_PROMPT_CHARS, buildPrompt } from './prompt.js';
export {
  DEFAULT_KILL_GRACE_MS, DEFAULT_MAX_EVENTS, DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_MAX_RUNS, DEFAULT_TIMEOUT_MS, TERMINAL, createRunManager,
} from './run.js';
