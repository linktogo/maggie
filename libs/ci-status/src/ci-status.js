const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

const RANK = { failure: 0, running: 1, neutral: 2, success: 3, none: 4 };

export function normalizeState(status, conclusion) {
  if (status !== 'completed') return 'running';
  if (conclusion === 'success') return 'success';
  if (FAILURE_CONCLUSIONS.has(conclusion)) return 'failure';
  return 'neutral';
}

export function rankState(state) {
  return RANK[state] ?? RANK.none;
}

const REQUIRED_STRINGS = ['repo', 'actor', 'status'];

export function parseUpdate(raw, at) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not an object' };
  }
  for (const field of REQUIRED_STRINGS) {
    if (typeof parsed[field] !== 'string' || parsed[field] === '') {
      return { ok: false, reason: `missing or invalid "${field}"` };
    }
  }
  if (!Number.isInteger(parsed.runId)) {
    return { ok: false, reason: 'missing or invalid "runId"' };
  }
  if (parsed.actor !== at.login) {
    return { ok: false, reason: `actor "${parsed.actor}" does not match folder "${at.login}"` };
  }
  if (parsed.repo !== at.repo) {
    return { ok: false, reason: `repo "${parsed.repo}" does not match file "${at.repo}"` };
  }
  return { ok: true, update: parsed };
}

function repoName(env) {
  return env.GITHUB_REPOSITORY.split('/')[1];
}

function fromWorkflowRun(env, run, now) {
  return {
    repo: repoName(env),
    actor: run.actor.login,
    runId: run.id,
    status: run.status,
    conclusion: run.conclusion,
    workflow: run.name,
    branch: run.head_branch,
    event: run.event,
    url: run.html_url,
    startedAt: run.run_started_at,
    sentAt: now,
  };
}

function fromJob(env, now) {
  return {
    repo: repoName(env),
    actor: env.GITHUB_ACTOR,
    runId: Number(env.GITHUB_RUN_ID),
    status: 'completed',
    conclusion: env.JOB_STATUS,
    workflow: env.GITHUB_WORKFLOW,
    branch: env.GITHUB_REF_NAME,
    event: env.GITHUB_EVENT_NAME,
    url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    startedAt: now,
    sentAt: now,
  };
}

export function buildUpdate(env, event, now) {
  return env.GITHUB_EVENT_NAME === 'workflow_run'
    ? fromWorkflowRun(env, event.workflow_run, now)
    : fromJob(env, now);
}

export function redactToken(message, token) {
  if (!token) return message;
  return message.split(token).join('***');
}

export function statusRepoUrl(statusRepo, token) {
  if (statusRepo.includes('://') || statusRepo.startsWith('/')) return statusRepo;
  return token
    ? `https://x-access-token:${token}@github.com/${statusRepo}.git`
    : `https://github.com/${statusRepo}.git`;
}

export function buildState(entries, now) {
  const repos = {};
  for (const { login, repo, update } of entries) {
    const bucket = (repos[repo] ??= { users: {} });
    const existing = bucket.users[login];
    if (existing && existing.runId >= update.runId) continue;
    bucket.users[login] = { ...update, receivedAt: now };
  }
  return { repos };
}
