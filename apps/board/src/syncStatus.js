// The skills sync status of a repo, as `maggie sync --check --out` recorded it.

/** 'drift' | 'in-sync' | 'error' | 'unknown' (never checked). */
export function syncState(entry) {
  if (!entry) return 'unknown';
  if (entry.status === 'in-sync' || entry.status === 'drift') return entry.status;
  return 'error';
}

/** The filter bar's choice: '' keeps everything. */
export function matchesSyncFilter(entry, filter) {
  return !filter || syncState(entry) === filter;
}

/** How many of `names` drifted, and how many checks failed. */
export function countSync(sync, names) {
  const counts = { drift: 0, error: 0 };
  for (const name of names) {
    const state = syncState(sync[name]);
    if (state in counts) counts[state] += 1;
  }
  return counts;
}
