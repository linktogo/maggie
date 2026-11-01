import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { providerCommand } from '@linktogo/maggie-retro-doc';
import { AgentError } from './errors.js';

export const AGENT_PROVIDERS = ['claude-cli', 'copilot'];

export const DEFAULT_AGENT_PROVIDER = AGENT_PROVIDERS[0];

// The model ends up as a CLI argument (`--model <model>`): only an identifier is
// accepted, never something that could read as another option.
const MODEL_PATTERN = /^[A-Za-z0-9][\w.:/-]*$/;

/** How a provider is invoked; the prompt goes in on stdin. */
export function commandFor(provider, model = null) {
  return providerCommand(provider, { model });
}

/** The first PATH entry holding `command` (with PATHEXT on Windows), or null. */
export function findOnPath(command, { env = process.env, platform = process.platform, access = accessSync } = {}) {
  const windows = platform === 'win32';
  const extensions = windows ? ['', ...(env.PATHEXT ?? '.EXE;.CMD').split(';').filter(Boolean)] : [''];
  for (const dir of (env.PATH ?? '').split(windows ? ';' : ':').filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension);
      try {
        access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here, keep looking
      }
    }
  }
  return null;
}

/** The providers whose CLI is installed on this machine. */
export function detectProviders(options = {}) {
  return AGENT_PROVIDERS.filter((provider) => findOnPath(commandFor(provider).command, options) !== null);
}

export function resolveProvider({ requested, fallback }) {
  const provider = requested ?? fallback;
  if (!AGENT_PROVIDERS.includes(provider)) {
    throw new AgentError('invalid', `unknown provider: ${String(provider)}`);
  }
  return provider;
}

export function validateModel(model) {
  if (model === undefined || model === null) return null;
  if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
    throw new AgentError('invalid', `invalid model: ${String(model)}`);
  }
  return model;
}
