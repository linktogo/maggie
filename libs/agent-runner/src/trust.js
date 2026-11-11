import { readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Claude Code keeps the per-project trust decisions in `~/.claude.json`. */
export const claudeStateFile = (home = os.homedir()) => path.join(home, '.claude.json');

/**
 * Marks directories as trusted for Claude Code, as accepting its trust dialog
 * would. A non-interactive run cannot answer that dialog and otherwise ignores the
 * repository's `.claude/settings.json` permissions. Returns the directories that
 * were not yet trusted; the file is left alone when there is nothing to change.
 */
export async function trustDirectories(dirs, { file = claudeStateFile() } = {}) {
  let state = {};
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot trust repositories: ${file} is not readable JSON (${err.message})`, { cause: err });
  }
  const projects = state.projects ?? {};
  const added = [];
  for (const dir of dirs) {
    if (projects[dir]?.hasTrustDialogAccepted === true) continue;
    projects[dir] = { ...projects[dir], hasTrustDialogAccepted: true };
    added.push(dir);
  }
  if (added.length === 0) return added;
  const temp = `${file}.maggie.tmp`;
  await writeFile(temp, `${JSON.stringify({ ...state, projects }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  return added;
}
