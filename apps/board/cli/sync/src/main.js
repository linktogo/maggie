import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveConfigSource } from '@linktogo/maggie-config';
import { run as defaultRun } from '@linktogo/maggie-skill-sync';

// The skills library shipped inside the installed package (copied there by `prepack`), used
// when the current directory has none of its own; from a clone it is the repository's own.
export function packagedSkillsDir(exists = existsSync, base = import.meta.url) {
  const bundled = fileURLToPath(new URL('../../../skills', base));
  return exists(bundled) ? bundled : fileURLToPath(new URL('../../../../../skills', base));
}

// `--skills` wins; otherwise prefer a `skills/` folder in the current directory
// so a clone keeps working, and fall back to the packaged library.
export function resolveSkillsDir(value, { cwd = process.cwd(), exists = existsSync } = {}) {
  if (value) return path.resolve(cwd, value);
  const local = path.join(cwd, 'skills');
  return exists(local) ? local : packagedSkillsDir();
}

export async function main(argv, deps = {}) {
  const {
    loadConfig,
    loadConfigFromRepo,
    runPipeline = defaultRun,
    logger = console,
    cwd,
    exists,
  } = deps;

  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      'config-repo': { type: 'string' },
      'config-file': { type: 'string' },
      pr: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      'work-dir': { type: 'string' },
      repo: { type: 'string' },
      skills: { type: 'string' },
    },
  });

  const config = await resolveConfigSource(
    { config: values.config, configRepo: values['config-repo'], configFile: values['config-file'] },
    { loadConfig, loadConfigFromRepo },
  );
  const results = await runPipeline(config, {
    skillsDir: resolveSkillsDir(values.skills, { cwd, exists }),
    workDir: values['work-dir'] ?? path.join(os.tmpdir(), 'maggie'),
    pr: values.pr,
    dryRun: values['dry-run'],
    strict: values.strict,
    repoFilter: values.repo,
    logger,
  });

  return results.some((r) => r.status === 'error') ? 1 : 0;
}
