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
  if (!values.repos) throw new Error('Missing required --repos <repos.json>');
  const defaultProvider = resolveProvider({
    requested: values.provider ?? env.MAGGIE_AGENT_PROVIDER,
    fallback: DEFAULT_AGENT_PROVIDER,
  });
  const skillsDir = path.resolve(values.skills ?? DEFAULT_SKILLS_DIR);
  if (!existsSync(skillsDir)) throw new Error(`Skills directory not found: ${skillsDir}`);

  const config = await loadConfig(path.resolve(values.repos));
  const repos = createRepoResolver({ repos: config.repos, workspace: path.resolve(values.workspace) });
  const manager = createRunManager({ timeoutMs: Number(values.timeout) * 1000 });

  // The token never reaches a log or a command line: it lives in a 0600 file the
  // board reads, and goes away with the server.
  const token = randomBytes(32).toString('hex');
  const tokenFile = path.resolve(values['token-file'] ?? defaultTokenFile(home));
  await mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);

  const server = createAgentsServer({
    token,
    manager,
    repos,
    skillsDir,
    providers: { detect, defaultProvider },
    allowedOrigins: values['allow-origin'],
  });
  server.on('close', () => { void rm(tokenFile, { force: true }); });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(values.port), LOOPBACK, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    await rm(tokenFile, { force: true });
    throw err;
  }

  const installed = detect();
  log(`agents server on http://localhost:${server.address().port} (token: ${tokenFile})`);
  log(`  default provider ${defaultProvider}; installed: ${installed.length ? installed.join(', ') : 'none (claude / copilot not found on PATH)'}`);
  onSignal(['SIGINT', 'SIGTERM'], () => {
    server.close();
    server.closeAllConnections();
  });
  return server;
}
