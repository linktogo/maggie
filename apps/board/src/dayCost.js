import { costOf } from './pricing.js';

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Euros spent today: history entries that ended on the browser's local calendar
// day, plus every session still running. A session moves from the live set into
// history when it closes, but the board and history are polled separately, so
// for a moment it can sit in both: a history entry whose session is still live
// is skipped rather than counted twice.
export function dayTotal(repos, entries, now) {
  const today = new Date(now);
  const live = new Set();
  for (const [name, repoEntry] of Object.entries(repos)) {
    for (const sessionId of Object.keys(repoEntry.sessions ?? {})) live.add(`${name}/${sessionId}`);
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.endedAt || live.has(`${entry.repo}/${entry.sessionId}`)) continue;
    const ended = new Date(entry.endedAt);
    if (Number.isNaN(ended.getTime()) || !sameLocalDay(ended, today)) continue;
    total += costOf(entry.usage);
  }
  for (const repoEntry of Object.values(repos)) {
    for (const session of Object.values(repoEntry.sessions ?? {})) total += costOf(session.usage);
  }
  return total;
}
