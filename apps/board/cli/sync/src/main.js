import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveConfigSource } from '@linktogo/maggie-config';
import { run as defaultRun, lintLibrary } from '@linktogo/maggie-skill-sync';

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

// What `--check --out` writes, and the board reads: the last drift check of each repository.
export function syncStatus(results, now = new Date()) {
  const checkedAt = now.toISOString();
  const repos = {};
  for (const r of results) {
    repos[r.repo] = {
      status: r.status,
      checkedAt,
      files: r.files ?? 0,
      drift: r.drift ?? [],
      ...(r.error ? { error: r.error } : {}),
    };
  }
  return { generatedAt: checkedAt, repos };
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await fsWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv, deps = {}) {
  const {
    loadConfig,
    loadConfigFromRepo,
    runPipeline = defaultRun,
    lint = lintLibrary,
    write = writeJson,
    now = () => new Date(),
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
      check: { type: 'boolean', default: false },
      out: { type: 'string' },
      'skip-lint': { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      'work-dir': { type: 'string' },
      repo: { type: 'string' },
      skills: { type: 'string' },
    },
  });

  if (values.out && !values.check) throw new Error('--out writes the result of --check; pass --check too');
  if (values.check && (values.pr || values['dry-run'])) throw new Error('--check pushes nothing: it cannot be combined with --pr or --dry-run');

  const config = await resolveConfigSource(
    { config: values.config, configRepo: values['config-repo'], configFile: values['config-file'] },
    { loadConfig, loadConfigFromRepo },
  );
  const results = await runPipeline(config, {
    skillsDir: resolveSkillsDir(values.skills, { cwd, exists }),
    workDir: values['work-dir'] ?? path.join(os.tmpdir(), 'maggie'),
    pr: values.pr,
    dryRun: values['dry-run'],
    check: values.check,
    strict: values.strict,
    repoFilter: values.repo,
    lint: values['skip-lint'] ? null : lint,
    logger,
  });

  if (values.out) {
    const out = path.resolve(cwd ?? process.cwd(), values.out);
    await write(out, syncStatus(results, now()));
    logger.log(`sync status written to ${out}`);
  }

  return results.some((r) => r.status === 'error' || r.status === 'drift') ? 1 : 0;
}
