import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeState,
  rankState,
  parseUpdate,
  buildUpdate,
  buildState,
  redactToken,
  statusRepoUrl,
} from '../src/ci-status.js';

test('normalizeState maps every GitHub status/conclusion pair', () => {
  const cases = [
    [['queued', null], 'running'],
    [['in_progress', null], 'running'],
    [['waiting', null], 'running'],
    [['completed', 'success'], 'success'],
    [['completed', 'failure'], 'failure'],
    [['completed', 'timed_out'], 'failure'],
    [['completed', 'startup_failure'], 'failure'],
    [['completed', 'action_required'], 'failure'],
    [['completed', 'cancelled'], 'neutral'],
    [['completed', 'skipped'], 'neutral'],
    [['completed', 'neutral'], 'neutral'],
    [['completed', 'stale'], 'neutral'],
    [['completed', 'something_new'], 'neutral'],
    [['completed', null], 'neutral'],
  ];
  for (const [[status, conclusion], expected] of cases) {
    assert.equal(normalizeState(status, conclusion), expected, `${status}/${conclusion}`);
  }
});

test('rankState orders worst first and treats unknown states as none', () => {
  assert.ok(rankState('failure') < rankState('running'));
  assert.ok(rankState('running') < rankState('neutral'));
  assert.ok(rankState('neutral') < rankState('success'));
  assert.ok(rankState('success') < rankState('none'));
  assert.equal(rankState('bogus'), rankState('none'));
});

const VALID = {
  repo: 'lk-myasso', actor: 'fabien', runId: 42, status: 'completed',
  conclusion: 'failure', workflow: 'CI', branch: 'feat/x', event: 'push',
  url: 'https://github.com/linktogo/lk-myasso/actions/runs/42',
  startedAt: '2026-07-29T18:40:00.000Z', sentAt: '2026-07-29T18:41:12.000Z',
};
const AT = { login: 'fabien', repo: 'lk-myasso' };

test('parseUpdate accepts a well-formed payload', () => {
  const result = parseUpdate(JSON.stringify(VALID), AT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.update, VALID);
});

test('parseUpdate accepts a null conclusion for a run still going', () => {
  const raw = JSON.stringify({ ...VALID, status: 'in_progress', conclusion: null });
  assert.equal(parseUpdate(raw, AT).ok, true);
});

test('parseUpdate rejects malformed input without throwing', () => {
  const cases = [
    ['not json at all', /invalid JSON/],
    ['[]', /not an object/],
    ['null', /not an object/],
    [JSON.stringify({ ...VALID, repo: undefined }), /"repo"/],
    [JSON.stringify({ ...VALID, actor: '' }), /"actor"/],
    [JSON.stringify({ ...VALID, status: 7 }), /"status"/],
    [JSON.stringify({ ...VALID, runId: 'forty-two' }), /"runId"/],
  ];
  for (const [raw, pattern] of cases) {
    const result = parseUpdate(raw, AT);
    assert.equal(result.ok, false, raw);
    assert.match(result.reason, pattern);
  }
});

test('parseUpdate rejects a file sitting in the wrong folder or under the wrong name', () => {
  const wrongUser = parseUpdate(JSON.stringify(VALID), { login: 'alice', repo: 'lk-myasso' });
  assert.equal(wrongUser.ok, false);
  assert.match(wrongUser.reason, /actor "fabien" does not match folder "alice"/);

  const wrongRepo = parseUpdate(JSON.stringify(VALID), { login: 'fabien', repo: 'lk-mind' });
  assert.equal(wrongRepo.ok, false);
  assert.match(wrongRepo.reason, /repo "lk-myasso" does not match file "lk-mind"/);
});

const NOW = '2026-07-29T18:41:12.000Z';

test('buildUpdate reads the workflow_run payload when triggered by workflow_run', () => {
  const env = { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: 'linktogo/lk-myasso' };
  const event = {
    workflow_run: {
      id: 42, name: 'CI', status: 'completed', conclusion: 'failure',
      head_branch: 'feat/x', event: 'push', actor: { login: 'fabien' },
      html_url: 'https://github.com/linktogo/lk-myasso/actions/runs/42',
      run_started_at: '2026-07-29T18:40:00.000Z',
    },
  };
  assert.deepEqual(buildUpdate(env, event, NOW), {
    repo: 'lk-myasso', actor: 'fabien', runId: 42, status: 'completed',
    conclusion: 'failure', workflow: 'CI', branch: 'feat/x', event: 'push',
    url: 'https://github.com/linktogo/lk-myasso/actions/runs/42',
    startedAt: '2026-07-29T18:40:00.000Z', sentAt: NOW,
  });
});

test('buildUpdate reads the job context when used as an in-job step', () => {
  const env = {
    GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'linktogo/lk-mind',
    GITHUB_ACTOR: 'alice', GITHUB_RUN_ID: '77', GITHUB_WORKFLOW: 'Build',
    GITHUB_REF_NAME: 'main', GITHUB_SERVER_URL: 'https://github.com',
    JOB_STATUS: 'success',
  };
  assert.deepEqual(buildUpdate(env, {}, NOW), {
    repo: 'lk-mind', actor: 'alice', runId: 77, status: 'completed',
    conclusion: 'success', workflow: 'Build', branch: 'main', event: 'push',
    url: 'https://github.com/linktogo/lk-mind/actions/runs/77',
    startedAt: NOW, sentAt: NOW,
  });
});

test('buildState groups by repo then by contributor and stamps receivedAt', () => {
  const entries = [
    { login: 'fabien', repo: 'lk-myasso', update: { ...VALID, runId: 42 } },
    { login: 'alice', repo: 'lk-myasso', update: { ...VALID, actor: 'alice', runId: 41, conclusion: 'success' } },
    { login: 'fabien', repo: 'lk-mind', update: { ...VALID, repo: 'lk-mind', runId: 9 } },
  ];
  const state = buildState(entries, NOW);
  assert.deepEqual(Object.keys(state.repos).sort(), ['lk-mind', 'lk-myasso']);
  assert.deepEqual(Object.keys(state.repos['lk-myasso'].users).sort(), ['alice', 'fabien']);
  assert.equal(state.repos['lk-myasso'].users.fabien.runId, 42);
  assert.equal(state.repos['lk-myasso'].users.fabien.receivedAt, NOW);
});

test('buildState keeps the highest runId when a pair appears twice', () => {
  const entries = [
    { login: 'fabien', repo: 'lk-myasso', update: { ...VALID, runId: 42 } },
    { login: 'fabien', repo: 'lk-myasso', update: { ...VALID, runId: 7 } },
  ];
  assert.equal(buildState(entries, NOW).repos['lk-myasso'].users.fabien.runId, 42);
});

test('buildState does not mutate the updates it is given', () => {
  const update = { ...VALID };
  buildState([{ login: 'fabien', repo: 'lk-myasso', update }], NOW);
  assert.equal(update.receivedAt, undefined);
});

test('buildState returns an empty map for no entries', () => {
  assert.deepEqual(buildState([], NOW), { repos: {} });
});

test('redactToken replaces every occurrence of the token with ***', () => {
  const message = 'failed to fetch https://x-access-token:secret123@github.com/o/r.git: secret123 rejected';
  assert.equal(
    redactToken(message, 'secret123'),
    'failed to fetch https://x-access-token:***@github.com/o/r.git: *** rejected',
  );
});

test('redactToken returns the message unchanged when the token is empty or absent', () => {
  const message = 'plain error message';
  assert.equal(redactToken(message, ''), message);
  assert.equal(redactToken(message, undefined), message);
});

test('statusRepoUrl builds an authenticated github.com URL from owner/name and a token', () => {
  assert.equal(
    statusRepoUrl('linktogo/maggie', 'secret123'),
    'https://x-access-token:secret123@github.com/linktogo/maggie.git',
  );
});

test('statusRepoUrl builds an unauthenticated github.com URL from owner/name with no token', () => {
  assert.equal(statusRepoUrl('linktogo/maggie', ''), 'https://github.com/linktogo/maggie.git');
  assert.equal(statusRepoUrl('linktogo/maggie', undefined), 'https://github.com/linktogo/maggie.git');
});

test('statusRepoUrl passes through a value that already contains ://', () => {
  assert.equal(statusRepoUrl('https://ghe.example.com/o/r.git', 'secret123'), 'https://ghe.example.com/o/r.git');
});

test('statusRepoUrl passes through an absolute path unchanged', () => {
  assert.equal(statusRepoUrl('/tmp/git-test/origin.git', 'secret123'), '/tmp/git-test/origin.git');
});
