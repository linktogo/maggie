import { existsSync } from 'node:fs';
import path from 'node:path';
import { PROVIDERS, createComplete, describeProvider, runRetroDoc } from '@linktogo/maggie-retro-doc';

/**
 * Where a repository of the config is checked out. Same rule as hook
 * reconciliation: `repo.path` when the config pins one, otherwise
 * `<workspaceDir>/<name>`, the workspace being the board file's grandparent.
 */
export function resolveCheckout({ boardPath, config, repo }) {
  const entry = (config?.repos ?? []).find((candidate) => candidate?.name === repo);
  if (!entry) return null;
  if (entry.path) return path.resolve(entry.path);
  return path.join(path.dirname(path.dirname(boardPath)), entry.name);
}

/** What the API hands out: the job without the promise driving it. */
export function publicJob(job) {
  const { repo, id, provider, generator, status, startedAt, finishedAt, out, error, log } = job;
  return { id, repo, provider, generator, status, startedAt, finishedAt, out, error, log };
}

/**
 * Runs retro-documentation jobs for the board, one at a time per repository.
 * Generation takes minutes, so `start` returns as soon as the job is accepted
 * and the browser polls `list()` for what happened.
 */
export function createRetroDocRunner({
  boardPath,
  config,
  run = runRetroDoc,
  completeFactory = createComplete,
  now = () => new Date(),
} = {}) {
  const jobs = new Map();
  const settled = new Map();
  let counter = 0;

  const list = (repo = null) => [...jobs.values()]
    .filter((job) => repo === null || job.repo === repo)
    .map(publicJob)
    .reverse();

  function start({ repo, provider = 'claude', model = null }) {
    if (!repo) return { status: 400, error: 'repo is required' };
    if (!PROVIDERS.includes(provider)) return { status: 400, error: `unknown provider: ${provider}` };
    const repoRoot = resolveCheckout({ boardPath, config, repo });
    if (!repoRoot) return { status: 404, error: `unknown repository: ${repo}` };
    if (!existsSync(repoRoot)) return { status: 404, error: `${repo} is not checked out at ${repoRoot}` };
    if ([...jobs.values()].some((job) => job.repo === repo && job.status === 'running')) {
      return { status: 409, error: `a retro-documentation of ${repo} is already running` };
    }

    counter += 1;
    const job = {
      id: `${repo}-${counter}`,
      repo,
      provider,
      generator: describeProvider({ provider, model }),
      status: 'running',
      startedAt: now().toISOString(),
      finishedAt: null,
      out: null,
      error: null,
      log: [],
    };
    jobs.set(job.id, job);

    const note = (text) => job.log.push({ at: now().toISOString(), text });
    note(`starting on ${repoRoot} through ${job.generator}`);

    settled.set(job.id, (async () => {
      try {
        const complete = await completeFactory({ provider, model });
        const result = await run({
          repoRoot,
          complete,
          generator: job.generator,
          // Timestamped, because the interesting question about a line is when
          // it appeared: a run that looks frozen is one whose last line is old.
          log: note,
        });
        job.status = 'done';
        job.out = path.relative(repoRoot, result.outPath);
        note(`wrote ${job.out}`);
      } catch (err) {
        job.status = 'error';
        job.error = err.message;
        note(`error: ${err.message}`);
      }
      job.finishedAt = now().toISOString();
      return publicJob(job);
    })());

    return { status: 202, job: publicJob(job) };
  }

  return { start, list, settled: (id) => settled.get(id) };
}
