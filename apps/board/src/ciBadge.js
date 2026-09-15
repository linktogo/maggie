import { rankState } from '@linktogo/maggie-ci-status';

const MAX_BADGES = 4;

const PILL = {
  failure: 'bg-ci-failure-soft text-ci-failure-on-soft border-ci-failure-line',
  running: 'bg-ci-running-soft text-ci-running-on-soft border-ci-running-line animate-pulse',
  neutral: 'bg-ci-neutral-soft text-ci-neutral-on-soft border-ci-neutral-line',
  success: 'bg-ci-success-soft text-ci-success-on-soft border-ci-success-line',
};

export function initials(login) {
  const parts = login.split(/[-_.\s]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function pillClass(state) {
  return PILL[state] ?? PILL.neutral;
}

export function visibleBadges(users, max = MAX_BADGES) {
  const all = Object.entries(users ?? {})
    .map(([login, u]) => ({ login, state: u.state, initials: initials(login) }))
    .sort((a, b) => rankState(a.state) - rankState(b.state) || a.login.localeCompare(b.login));
  return { shown: all.slice(0, max), overflow: all.slice(max) };
}

const AGGREGATE_BY_MIN_RANK = { [rankState('failure')]: 'failure', [rankState('running')]: 'running' };

export function ciAggregate(users) {
  const states = Object.values(users ?? {}).map((u) => u.state);
  if (states.length === 0) return 'unknown';
  const minRank = Math.min(...states.map(rankState));
  return AGGREGATE_BY_MIN_RANK[minRank] ?? 'ok';
}

export function matchesCiFilter(users, filter) {
  if (!filter) return true;
  return ciAggregate(users) === filter;
}
