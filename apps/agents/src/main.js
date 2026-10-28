import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig as defaultLoadConfig } from '@linktogo/maggie-config';
import {
  DEFAULT_AGENT_PROVIDER, createRepoResolver, createRunManager, detectProviders, resolveProvider,
} from '@linktogo/maggie-agent-runner';
import { LOOPBACK, createAgentsServer } from './server.js';

export const DEFAULT_PORT = 4318;

const DEFAULT_SKILLS_DIR = fileURLToPath(new URL('../../../skills', import.meta.url));

/** Where the board finds the token to talk to this server. */
export const defaultTokenFile = (home = os.homedir()) => path.join(home, '.maggie', 'agents.token');

export function onProcessSignal(signals, handler, proc = process) {
  for (const signal of signals) proc.once(signal, handler);
}

function parseNumber(text, { integer = false, min, max = Infinity }) {
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  if (integer && !Number.isInteger(value)) return null;
  return value;
}

export async function main(argv, {
  log = console.log,
  loadConfig = defaultLoadConfig,
  detect = detectProviders,
  env = process.env,
  home = os.homedir(),
  onSignal = onProcessSignal,
} = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: String(DEFAULT_PORT) },
      provider: { type: 'string' },
      repos: { type: 'string' },
      workspace: { type: 'string', default: 'wk' },
      skills: { type: 'string' },
      'allow-origin': { type: 'string', multiple: true, default: [] },
      'token-file': { type: 'string' },
      timeout: { type: 'string', default: '600' },
    },
  });
  const port = parseNumber(values.port, { integer: true, min: 0, max: 65535 });
  if (port === null) throw new Error(`Invalid --port: ${values.port}`);
  const timeoutSeconds = parseNumber(values.timeout, { min: Number.MIN_VALUE });
  if (timeoutSeconds === null) throw new Error(`Invalid --timeout: ${values.timeout} (seconds, > 0)`);
  if (!values.repos) throw new Error('Missing required --repos <repos.json>');
  const defaultProvider = resolveProvider({
    requested: values.provider ?? env.MAGGIE_AGENT_PROVIDER,
    fallback: DEFAULT_AGENT_PROVIDER,
  });
  const skillsDir = path.resolve(values.skills ?? DEFAULT_SKILLS_DIR);
  if (!existsSync(skillsDir)) throw new Error(`Skills directory not found: ${skillsDir}`);

  const config = await loadConfig(path.resolve(values.repos));
  const repos = createRepoResolver({ repos: config.repos, workspace: path.resolve(values.workspace) });
  const manager = createRunManager({ timeoutMs: timeoutSeconds * 1000 });

  const token = randomBytes(32).toString('hex');
  const tokenFile = path.resolve(values['token-file'] ?? defaultTokenFile(home));

  const server = createAgentsServer({
    token,
    manager,
    repos,
    skillsDir,
    providers: { detect, defaultProvider },
    allowedOrigins: values['allow-origin'],
  });

  // Listen first: a start that fails (port taken) must never touch the token file
  // of the instance that is already running.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => {
      server.off('error', reject);
      resolve();
    });
  });

  // The token never reaches a log or a command line: it lives in a 0600 file the
  // board reads, and goes away with the server.
  try {
    const dir = path.dirname(tokenFile);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o700);
    }
    await rm(tokenFile, { force: true });
    await writeFile(tokenFile, `${token}\n`, { flag: 'wx', mode: 0o600 });
    await chmod(tokenFile, 0o600);
  } catch (err) {
    server.close();
    throw err;
  }

  server.on('close', () => { void rm(tokenFile, { force: true }); });

  const installed = detect();
  log(`agents server on http://localhost:${server.address().port} (token: ${tokenFile})`);
  log(`  default provider ${defaultProvider}; installed: ${installed.length ? installed.join(', ') : 'none (claude / copilot not found on PATH)'}`);
  onSignal(['SIGINT', 'SIGTERM'], () => {
    server.close();
    server.closeAllConnections();
  });
  return server;
}
