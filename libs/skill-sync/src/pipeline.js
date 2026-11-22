import path from 'node:path';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { clone as defaultClone } from '@linktogo/maggie-git';
import { resolveSkills as defaultResolveSkills } from './skills.js';
import {
  renderRepo as defaultRenderRepo, mergeBlock, readBlock, removeBlock,
} from '@linktogo/maggie-renderers';
import {
  readManifest as defaultReadManifest, writeManifest as defaultWriteManifest, stalePaths, staleBlocks,
} from './manifest.js';

const BRANCH = 'maggie/update-skills';
const COMMIT_MESSAGE = 'chore: sync AI agent skills';
const PR_TITLE = 'Sync AI agent skills';
const PR_BODY = 'Automated skill sync from maggie.';

/**
 * Render the skills into every repository of `config`. By default each repository is
 * cloned, written, committed and pushed (`pr` also opens a pull request); `dryRun` only
 * lists the files, and `check` compares the render with what the default branch holds,
 * without writing anything (`in-sync` / `drift`, with the files that differ).
 *
 * `lint`, when given, runs on the skills library first: an error-level finding stops
 * the whole run before any repository is touched.
 */
export async function run(config, options = {}) {
  const {
    skillsDir,
    workDir,
    pr = false,
    dryRun = false,
    check = false,
    strict = false,
    repoFilter,
    lint = null,
    clone = defaultClone,
    resolveSkills = defaultResolveSkills,
    renderRepo = defaultRenderRepo,
    readManifest = defaultReadManifest,
    writeManifest = defaultWriteManifest,
    logger = console,
  } = options;

  const repos = repoFilter
    ? config.repos.filter((repo) => repo.name === repoFilter)
    : config.repos;

  if (lint) {
    const findings = await lint(skillsDir);
    const errors = findings.filter((finding) => finding.severity === 'error');
    if (errors.length > 0) {
      for (const finding of errors) logger.error(`✗ ${finding.file}:${finding.line} ${finding.rule}: ${finding.message}`);
      const error = `the skills library has ${errors.length} lint error(s); run \`maggie lint\``;
      logger.error(`✗ ${error}`);
      const results = repos.map((repo) => ({ repo: repo.name, status: 'error', error }));
      report(results, logger);
      return results;
    }
  }

  const results = [];
  for (const repo of repos) {
    try {
      results.push(await syncRepo(repo, {
        skillsDir, workDir, pr, dryRun, check, strict, clone, resolveSkills, renderRepo,
        readManifest, writeManifest, logger,
      }));
    } catch (err) {
      logger.error(`✗ ${repo.name}: ${err.message}`);
      results.push({ repo: repo.name, status: 'error', error: err.message });
    }
  }

  report(results, logger);
  return results;
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function readBytes(file) {
  try {
    return await readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** What differs between the render and a checkout: missing, modified, and stale files or blocks. */
export async function diffCheckout(dest, files, manifest) {
  const drift = [];
  for (const file of files) {
    const full = path.join(dest, file.path);
    if (file.block) {
      const current = readBlock(await readText(full), file.block);
      if (current === null) drift.push({ path: file.path, block: file.block, state: 'missing' });
      else if (current !== file.content.trim()) drift.push({ path: file.path, block: file.block, state: 'modified' });
      continue;
    }
    const current = await readBytes(full);
    if (current === null) drift.push({ path: file.path, state: 'missing' });
    else if (!current.equals(Buffer.from(file.content))) drift.push({ path: file.path, state: 'modified' });
  }
  const plain = files.filter((file) => !file.block).map((file) => file.path);
  const blocks = files.filter((file) => file.block).map((file) => ({ path: file.path, id: file.block }));
  for (const stale of stalePaths(manifest.paths, plain)) {
    if ((await readBytes(path.join(dest, stale))) !== null) drift.push({ path: stale, state: 'stale' });
  }
  for (const stale of staleBlocks(manifest.blocks, blocks)) {
    if (readBlock(await readText(path.join(dest, stale.path)), stale.id) !== null) {
      drift.push({ path: stale.path, block: stale.id, state: 'stale' });
    }
  }
  return drift;
}

async function writeFiles(dest, files) {
  for (const file of files) {
    const full = path.join(dest, file.path);
    await mkdir(path.dirname(full), { recursive: true });
    const content = file.block ? mergeBlock(await readText(full), file.block, file.content) : file.content;
    await writeFile(full, content);
  }
}

async function prune(dest, repo, files, oldManifest, writeManifest, logger) {
  const plain = files.filter((file) => !file.block).map((file) => file.path);
  const blocks = files.filter((file) => file.block).map((file) => ({ path: file.path, id: file.block }));
  const tracked = oldManifest.paths.length + oldManifest.blocks.length;
  if (files.length === 0 && tracked > 0) {
    logger.warn(
      `${repo.name}: new render is empty but ${tracked} file(s) were previously tracked` +
      ' — skipping prune and leaving the manifest untouched (check repo.technologies)',
    );
    return;
  }
  for (const staleFile of stalePaths(oldManifest.paths, plain)) {
    await rm(path.join(dest, staleFile), { force: true });
    logger.log(`- ${repo.name}: pruning ${staleFile}`);
  }
  for (const stale of staleBlocks(oldManifest.blocks, blocks)) {
    const full = path.join(dest, stale.path);
    const current = await readText(full);
    if (current === null) continue;
    const rest = removeBlock(current, stale.id);
    if (rest === '') await rm(full, { force: true });
    else await writeFile(full, rest);
    logger.log(`- ${repo.name}: pruning the ${stale.id} block of ${stale.path}`);
  }
  await writeManifest(dest, plain, blocks);
}

async function syncRepo(repo, ctx) {
  const {
    skillsDir, workDir, pr, dryRun, check, strict, clone, resolveSkills, renderRepo,
    readManifest, writeManifest, logger,
  } = ctx;
  const skills = await resolveSkills(skillsDir, repo.technologies, {
    warn: (m) => logger.warn(m),
    strict,
  });

  if (skills.length === 0) {
    const message = `${repo.name}: no skills resolved for technologies [${repo.technologies.join(', ')}]`;
    if (strict) throw new Error(message);
    logger.warn(message);
  }

  const files = renderRepo(repo.targets, skills);

  if (dryRun) {
    for (const file of files) {
      logger.log(`[dry-run] ${repo.name}: ${file.path}${file.block ? ` (${file.block} block)` : ''}`);
    }
    return { repo: repo.name, status: 'dry-run', files: files.length };
  }

  const dest = path.join(workDir, repo.name);
  await rm(dest, { recursive: true, force: true });

  if (check) {
    await clone(repo.url, dest, { depth: 1 });
    const manifest = await readManifest(dest, { warn: (m) => logger.warn(m) });
    const drift = await diffCheckout(dest, files, manifest);
    if (drift.length === 0) {
      logger.log(`= ${repo.name}: in sync (${files.length} files)`);
      return { repo: repo.name, status: 'in-sync', files: files.length, drift };
    }
    logger.log(`≠ ${repo.name}: ${drift.length} file(s) out of sync`);
    for (const entry of drift) {
      logger.log(`    ${entry.state.padEnd(8)} ${entry.path}${entry.block ? ` (${entry.block} block)` : ''}`);
    }
    return { repo: repo.name, status: 'drift', files: files.length, drift };
  }

  const gitRepo = await clone(repo.url, dest);
  const oldManifest = await readManifest(dest, { warn: (m) => logger.warn(m) });
  await gitRepo.checkoutBranch(BRANCH);
  await writeFiles(dest, files);
  await prune(dest, repo, files, oldManifest, writeManifest, logger);

  if (!(await gitRepo.hasChanges())) {
    logger.log(`= ${repo.name}: no changes`);
    return { repo: repo.name, status: 'skipped', files: files.length };
  }

  await gitRepo.commitAll(COMMIT_MESSAGE);
  await gitRepo.push(BRANCH, { force: true });
  if (pr) await gitRepo.createPR(PR_TITLE, PR_BODY);

  logger.log(`✓ ${repo.name}: ${files.length} files pushed${pr ? ' + PR' : ''}`);
  return { repo: repo.name, status: pr ? 'pr' : 'pushed', files: files.length };
}

function report(results, logger) {
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  logger.log(`\nSummary: ${JSON.stringify(counts)}`);
}
