import { HOOK_EVENTS, hookSettings, installHooks } from './hooks.js';
import {
  COPILOT_SETTINGS_FILE,
  copilotHookSettings, flattenCopilotHooks, installCopilotHooks,
} from './copilotHooks.js';

// The local coding agents the workspace can wire to the board. They differ only
// in where their settings file lives and how a hook entry is shaped, so the
// board, the CLI and hook reconciliation all work off this one registry.
export const AGENTS = ['claude', 'copilot'];

export const DEFAULT_AGENT = 'claude';

function flattenClaudeHooks(hooks) {
  const flat = {};
  for (const { event } of HOOK_EVENTS) {
    flat[event] = hooks?.[event]?.[0]?.hooks?.[0]?.command;
  }
  return flat;
}

const REGISTRY = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    settingsFile: ['.claude', 'settings.local.json'],
    hookSettings,
    installHooks,
    flattenHooks: flattenClaudeHooks,
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    settingsFile: COPILOT_SETTINGS_FILE,
    hookSettings: copilotHookSettings,
    installHooks: installCopilotHooks,
    flattenHooks: flattenCopilotHooks,
  },
};

export function agentSpec(agent = DEFAULT_AGENT) {
  const spec = REGISTRY[agent];
  if (!spec) throw new Error(`Unknown agent "${agent}" (known: ${AGENTS.join(', ')})`);
  return spec;
}
